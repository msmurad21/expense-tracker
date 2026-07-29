import type { Db } from '../db/Db.js';
import {
  detectSubscriptions,
  detectPriceChanges,
  dedupeTransactions,
  monthlyEquivalentMinor,
  type DetectorTransaction,
  type DetectedSubscription,
  type PriceChange,
} from '../subscriptions/detect.js';
import { resolveMerchant } from '../subscriptions/normalize.js';

/**
 * Turns the raw transaction table into everything the dashboard shows.
 *
 * Kept free of any rendering concern so the same numbers feed the CLI summary,
 * the HTML report and (later) the Electron UI — three views that must never
 * disagree about what you are paying.
 */

export interface MonthlyPoint {
  /** "2026-07" */
  month: string;
  totalMinor: number;
  transactionCount: number;
}

export interface CategoryTotal {
  category: string;
  totalMinor: number;
  share: number;
}

export interface CardTotal {
  last4: string;
  totalMinor: number;
  subscriptionCount: number;
}

export interface UpcomingRenewal {
  merchantName: string;
  amountMinor: number;
  currency: string;
  dueAt: string;
  ciDays: number;
  daysAway: number;
  confidence: number;
}

export interface AnalyticsReport {
  homeCurrency: string;
  generatedAt: string;

  /** The headline: what recurring charges cost per month, all cadences normalised. */
  monthlyCommitmentMinor: number;
  annualCommitmentMinor: number;

  subscriptions: DetectedSubscription[];
  activeCount: number;
  provisionalCount: number;

  monthlySpend: MonthlyPoint[];
  byCategory: CategoryTotal[];
  byCard: CardTotal[];
  upcoming: UpcomingRenewal[];
  priceChanges: PriceChange[];

  totals: {
    transactions: number;
    afterDedup: number;
    emails: number;
    unparsedEmails: number;
  };
}

/** Load transactions in the shape the detector wants. */
export function loadTransactions(db: Db): DetectorTransaction[] {
  return db
    .prepare(
      `SELECT id, amount_minor, currency, occurred_at, merchant_raw, card_last4, kind
       FROM transactions
       WHERE superseded_by IS NULL
       ORDER BY occurred_at ASC`,
    )
    .all<{
      id: number;
      amount_minor: number;
      currency: string;
      occurred_at: string;
      merchant_raw: string;
      card_last4: string | null;
      kind: string;
    }>()
    .map((row) => ({
      id: row.id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      occurredAt: row.occurred_at,
      merchantRaw: row.merchant_raw,
      cardLast4: row.card_last4,
      kind: row.kind as DetectorTransaction['kind'],
    }));
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function buildReport(
  db: Db,
  options: { homeCurrency?: string; now?: Date } = {},
): AnalyticsReport {
  const homeCurrency = options.homeCurrency ?? 'PKR';
  const now = options.now ?? new Date();

  const transactions = loadTransactions(db);
  const deduped = dedupeTransactions(transactions);
  const subscriptions = detectSubscriptions(transactions, now);
  const priceChanges = detectPriceChanges(transactions, homeCurrency);

  // ── Monthly spend ────────────────────────────────────────────────────────
  // Only home-currency rows are summed. Mixing currencies without an explicit
  // conversion would produce a confidently wrong number, so foreign charges are
  // shown per-subscription instead of folded into a misleading total.
  const monthMap = new Map<string, { total: number; count: number }>();
  for (const t of deduped) {
    if (t.currency !== homeCurrency) continue;
    const key = monthKey(t.occurredAt);
    const entry = monthMap.get(key) ?? { total: 0, count: 0 };
    entry.total += t.amountMinor;
    entry.count += 1;
    monthMap.set(key, entry);
  }

  const monthlySpend: MonthlyPoint[] = [...monthMap.entries()]
    .map(([month, v]) => ({ month, totalMinor: v.total, transactionCount: v.count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── Category totals ──────────────────────────────────────────────────────
  const categoryMap = new Map<string, number>();
  for (const t of deduped) {
    if (t.currency !== homeCurrency) continue;
    const category = resolveMerchant(t.merchantRaw).category ?? 'Uncategorised';
    categoryMap.set(category, (categoryMap.get(category) ?? 0) + t.amountMinor);
  }
  const categoryGrand = [...categoryMap.values()].reduce((a, b) => a + b, 0);
  const byCategory: CategoryTotal[] = [...categoryMap.entries()]
    .map(([category, totalMinor]) => ({
      category,
      totalMinor,
      share: categoryGrand === 0 ? 0 : totalMinor / categoryGrand,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor);

  // ── Per-card ─────────────────────────────────────────────────────────────
  const cardMap = new Map<string, { total: number; subs: Set<string> }>();
  for (const t of deduped) {
    if (!t.cardLast4 || t.currency !== homeCurrency) continue;
    const entry = cardMap.get(t.cardLast4) ?? { total: 0, subs: new Set<string>() };
    entry.total += t.amountMinor;
    cardMap.set(t.cardLast4, entry);
  }
  for (const sub of subscriptions) {
    for (const last4 of sub.observedLast4) {
      const entry = cardMap.get(last4);
      if (entry) entry.subs.add(sub.merchantKey);
    }
  }
  const byCard: CardTotal[] = [...cardMap.entries()]
    .map(([last4, v]) => ({ last4, totalMinor: v.total, subscriptionCount: v.subs.size }))
    .sort((a, b) => b.totalMinor - a.totalMinor);

  // ── Commitment ───────────────────────────────────────────────────────────
  // Only home-currency subscriptions contribute, for the reason above.
  const live = subscriptions.filter(
    (s) => s.state === 'active' || s.state === 'provisional' || s.state === 'overdue',
  );
  const monthlyCommitmentMinor = live
    .filter((s) => s.currency === homeCurrency)
    .reduce((sum, s) => sum + monthlyEquivalentMinor(s), 0);

  // ── Upcoming ─────────────────────────────────────────────────────────────
  const horizon = new Date(now.getTime() + 30 * 86_400_000);
  const upcoming: UpcomingRenewal[] = live
    .filter((s) => {
      const due = new Date(s.nextDueAt);
      return due >= now && due <= horizon;
    })
    .map((s) => ({
      merchantName: s.merchantName,
      amountMinor: s.amountMedianMinor,
      currency: s.currency,
      dueAt: s.nextDueAt,
      ciDays: s.nextDueCiDays,
      daysAway: Math.round((new Date(s.nextDueAt).getTime() - now.getTime()) / 86_400_000),
      confidence: s.confidence,
    }))
    .sort((a, b) => a.daysAway - b.daysAway);

  const emailCount =
    db.prepare('SELECT COUNT(*) AS n FROM emails').get<{ n: number }>()?.n ?? 0;
  const unparsedCount =
    db
      .prepare("SELECT COUNT(*) AS n FROM emails WHERE parse_status IN ('pending','unmatched')")
      .get<{ n: number }>()?.n ?? 0;

  return {
    homeCurrency,
    generatedAt: now.toISOString(),
    monthlyCommitmentMinor,
    annualCommitmentMinor: monthlyCommitmentMinor * 12,
    subscriptions,
    activeCount: subscriptions.filter((s) => s.state === 'active').length,
    provisionalCount: subscriptions.filter((s) => s.state === 'provisional').length,
    monthlySpend,
    byCategory,
    byCard,
    upcoming,
    priceChanges,
    totals: {
      transactions: transactions.length,
      afterDedup: deduped.length,
      emails: emailCount,
      unparsedEmails: unparsedCount,
    },
  };
}
