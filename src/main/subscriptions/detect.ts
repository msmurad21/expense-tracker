import { resolveMerchant } from './normalize.js';
import {
  inferCadence,
  predictNextDue,
  classifyState,
  profileAmounts,
  scoreConfidence,
  type CadenceFit,
  type SubscriptionState,
  type AmountClass,
} from './cadence.js';

/** Input row — the subset of a transaction the detector needs. */
export interface DetectorTransaction {
  id: number;
  amountMinor: number;
  currency: string;
  occurredAt: string; // ISO UTC
  merchantRaw: string;
  cardLast4: string | null;
  kind: 'purchase' | 'auth' | 'refund' | 'reversal';
}

export interface DetectedSubscription {
  merchantKey: string;
  merchantName: string;
  category: string | null;
  currency: string;
  cadence: CadenceFit['cadence'];
  amountMedianMinor: number;
  amountClass: AmountClass;
  firstSeenAt: string;
  lastChargedAt: string;
  nextDueAt: string;
  nextDueCiDays: number;
  state: SubscriptionState;
  confidence: number;
  observedLast4: string[];
  transactionIds: number[];
  chargeCount: number;
}

/** A charge that recurs but whose amount moved. */
export interface PriceChange {
  merchantKey: string;
  merchantName: string;
  fromMinor: number;
  toMinor: number;
  currency: string;
  effectiveAt: string;
  /** True when the currency differs from the account's home currency. */
  crossCurrency: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Collapse authorisation/settlement pairs.
 *
 * Banks routinely send two alerts for one purchase — an authorisation on swipe
 * and a settlement a day or three later, often for slightly different amounts
 * (tips, FX, hotel holds). This is the common case, not an edge case: without
 * collapsing them every subscription appears to bill twice a month and no
 * cadence fits.
 *
 * Refunds and reversals are removed entirely — they are not charges, and
 * feeding a negative amount into a median would corrupt the amount profile.
 */
export function dedupeTransactions(transactions: DetectorTransaction[]): DetectorTransaction[] {
  const charges = transactions.filter((t) => t.kind !== 'refund' && t.kind !== 'reversal');

  const byMerchant = new Map<string, DetectorTransaction[]>();
  for (const t of charges) {
    const key = `${resolveMerchant(t.merchantRaw).key}|${t.currency}`;
    const list = byMerchant.get(key);
    if (list) list.push(t);
    else byMerchant.set(key, [t]);
  }

  const kept: DetectorTransaction[] = [];

  for (const group of byMerchant.values()) {
    const sorted = [...group].sort(
      (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
    const superseded = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
      if (superseded.has(sorted[i]!.id)) continue;

      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (superseded.has(b.id)) continue;

        const hoursApart =
          Math.abs(new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()) / 3_600_000;
        if (hoursApart > 96) break; // sorted, so nothing later can be closer

        const larger = Math.max(Math.abs(a.amountMinor), Math.abs(b.amountMinor));
        const drift = larger === 0 ? 0 : Math.abs(a.amountMinor - b.amountMinor) / larger;

        // Same merchant, within four days, amounts equal or within 25%.
        if (drift <= 0.25) {
          // Keep the later row — the settlement is the authoritative amount.
          superseded.add(a.id);
          break;
        }
      }
    }

    kept.push(...sorted.filter((t) => !superseded.has(t.id)));
  }

  return kept.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
}

/**
 * Group charges into candidate subscriptions and infer each one's schedule.
 *
 * Grouping is on (merchant, currency) and deliberately NOT on card last-4:
 * a reissued card or an Apple Pay device number changes the digits while the
 * subscription continues, and including it would split one subscription into
 * three unrelated fragments. The observed digits are kept as an attribute.
 */
export function detectSubscriptions(
  transactions: DetectorTransaction[],
  now: Date = new Date(),
): DetectedSubscription[] {
  const deduped = dedupeTransactions(transactions);

  const groups = new Map<string, DetectorTransaction[]>();
  for (const t of deduped) {
    const key = `${resolveMerchant(t.merchantRaw).key}|${t.currency}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const detected: DetectedSubscription[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue; // one charge is a purchase, not a subscription

    const dates = group.map((t) => new Date(t.occurredAt));
    const fit = inferCadence(dates);
    if (!fit) continue;

    const first = group[0]!;
    const merchant = resolveMerchant(first.merchantRaw);
    const amounts = group.map((t) => t.amountMinor);
    const profile = profileAmounts(amounts);

    const lastCharged = dates[dates.length - 1]!;
    const prediction = predictNextDue(lastCharged, fit, now);
    const state = classifyState(group.length, new Date(prediction.at), fit, now);

    const confidence = scoreConfidence({
      observationCount: group.length,
      fit,
      amountClass: profile.amountClass,
      merchantFuzzy: merchant.source === 'derived',
      hasHistoryGap: false,
    });

    const last4 = [...new Set(group.map((t) => t.cardLast4).filter((v): v is string => v !== null))];

    detected.push({
      merchantKey: merchant.key,
      merchantName: merchant.displayName,
      category: merchant.category,
      currency: first.currency,
      cadence: fit.cadence,
      amountMedianMinor: profile.medianMinor,
      amountClass: profile.amountClass,
      firstSeenAt: dates[0]!.toISOString(),
      lastChargedAt: lastCharged.toISOString(),
      nextDueAt: prediction.at,
      nextDueCiDays: prediction.ciDays,
      state,
      confidence,
      observedLast4: last4,
      transactionIds: group.map((t) => t.id),
      chargeCount: group.length,
    });
  }

  return detected.sort((a, b) => b.amountMedianMinor - a.amountMedianMinor);
}

/**
 * Find real price changes.
 *
 * The threshold is much wider for a foreign-currency subscription. A USD
 * subscription billed to a PKR card moves 1-3% every single month on exchange
 * rate alone — comparing against a 2% threshold would emit a price-change alert
 * for every foreign subscription, every month, forever. That is the single
 * noisiest false positive available in this app, so cross-currency charges need
 * to move 5% before they count.
 *
 * A change also has to persist: a one-off proration looks identical to a price
 * rise until the following charge disagrees with it.
 */
export function detectPriceChanges(
  transactions: DetectorTransaction[],
  homeCurrency: string,
): PriceChange[] {
  const deduped = dedupeTransactions(transactions);

  const groups = new Map<string, DetectorTransaction[]>();
  for (const t of deduped) {
    const key = `${resolveMerchant(t.merchantRaw).key}|${t.currency}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const changes: PriceChange[] = [];

  for (const group of groups.values()) {
    if (group.length < 3) continue;

    const merchant = resolveMerchant(group[0]!.merchantRaw);
    const crossCurrency = group[0]!.currency !== homeCurrency;
    const threshold = crossCurrency ? 0.05 : 0.02;

    for (let i = 1; i < group.length; i++) {
      const priorWindow = group.slice(Math.max(0, i - 4), i).map((t) => t.amountMinor);
      const priorProfile = profileAmounts(priorWindow);
      const prior = priorProfile.medianMinor;
      if (prior === 0) continue;

      // Variable-amount services (utilities) have no meaningful "price", so
      // they are excluded — but the test has to be on the window BEFORE the
      // candidate change, not on the whole series. Measured across the whole
      // series, a subscription that genuinely doubled looks variable by virtue
      // of having doubled, and the real price rise gets silently discarded.
      if (priorProfile.amountClass === 'variable') continue;

      const current = group[i]!.amountMinor;
      const delta = (current - prior) / prior;
      if (Math.abs(delta) < threshold) continue;

      // Confirmed only if the next charge agrees, or this is the latest one.
      const next = group[i + 1];
      const persisted =
        next === undefined || Math.abs(next.amountMinor - current) / Math.max(current, 1) < 0.01;
      if (!persisted) continue;

      // The new level has to be stable too. A real price change is bimodal —
      // steady at one figure, then steady at another. A utility bill is noisy
      // throughout, and a four-charge window of it can look stable by luck,
      // which is how an electricity bill ends up reported as a price cut.
      const afterWindow = group.slice(i, Math.min(group.length, i + 4)).map((t) => t.amountMinor);
      if (afterWindow.length >= 2 && profileAmounts(afterWindow).amountClass === 'variable') {
        continue;
      }

      changes.push({
        merchantKey: merchant.key,
        merchantName: merchant.displayName,
        fromMinor: prior,
        toMinor: current,
        currency: group[i]!.currency,
        effectiveAt: group[i]!.occurredAt,
        crossCurrency,
      });
      break; // report the most recent change per merchant only
    }
  }

  return changes;
}

const CADENCE_LABELS: Record<string, string> = {
  'weekly:1': 'Weekly',
  'weekly:2': 'Fortnightly',
  'weekly:4': 'Every 4 weeks',
  'monthly:1': 'Monthly',
  'monthly:2': 'Every 2 months',
  'monthly:3': 'Quarterly',
  'monthly:6': 'Every 6 months',
  'yearly:1': 'Yearly',
};

/** Human label for a cadence. Shared so the CLI and the dashboard agree. */
export function cadenceLabel(cadence: CadenceFit['cadence']): string {
  return CADENCE_LABELS[`${cadence.kind}:${cadence.n}`] ?? `${cadence.kind} ×${cadence.n}`;
}

/** Normalise a subscription's cost to a monthly figure for comparison. */
export function monthlyEquivalentMinor(sub: DetectedSubscription): number {
  const { kind, n } = sub.cadence;
  const perYear = kind === 'weekly' ? 52 / n : kind === 'monthly' ? 12 / n : 1 / n;
  return Math.round((sub.amountMedianMinor * perYear) / 12);
}

export { DAY_MS };
