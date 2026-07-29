/**
 * Working out whether a run of charges is a subscription, and when the next
 * one lands.
 *
 * ── Why not just average the gaps ──────────────────────────────────────────
 * The obvious approach — mean gap ≈ 30.44 days means monthly — falls apart on
 * real billing. A subscription anchored on the 31st charges 31 Jan, 28 Feb,
 * 31 Mar: gaps of 28 and 31 days. The variance looks like noise, so a
 * gap-averaging detector reports "irregular" for one of the most regular
 * billing patterns there is.
 *
 * So cadence is inferred against a CALENDAR. We propose candidate schedules,
 * generate the dates each one would produce (clamping day-of-month the way
 * billing systems actually do), and score how well the observations line up.
 *
 * Two refinements that matter on real data:
 *  - Many billers shift a charge off a weekend to the next working day. That
 *    shows up as residuals skewed a day or two positive. Taking the MEDIAN
 *    residual as an explicit phase offset absorbs it, instead of inflating the
 *    jitter and making a perfectly regular subscription look unreliable.
 *  - Amount stability is NOT part of recurrence. A utility bill varies every
 *    month and is unquestionably recurring. Amount is scored separately and
 *    only feeds confidence and price-change detection.
 */

export type CadenceKind = 'weekly' | 'monthly' | 'yearly';

export interface Cadence {
  kind: CadenceKind;
  n: number;
}

export interface CadenceFit {
  cadence: Cadence;
  /** Fraction of expected charges that were actually observed (0..1). */
  coverage: number;
  /** Median signed residual in days — absorbs weekend/business-day shift. */
  phaseOffsetDays: number;
  /** Median absolute deviation of residuals around the phase, in days. */
  jitterDays: number;
  /** Day of month the schedule anchors on (meaningless for weekly). */
  anchorDom: number;
  score: number;
  /** Observations that matched no expected date. */
  unmatched: number;
}

/** Candidate schedules, ordered so that shorter periods win ties. */
const CANDIDATES: Cadence[] = [
  { kind: 'weekly', n: 1 },
  { kind: 'weekly', n: 2 },
  { kind: 'weekly', n: 4 },
  { kind: 'monthly', n: 1 },
  { kind: 'monthly', n: 2 },
  { kind: 'monthly', n: 3 },
  { kind: 'monthly', n: 6 },
  { kind: 'yearly', n: 1 },
];

const DAY_MS = 86_400_000;

/** Matching tolerance in days, by cadence. Longer periods drift more. */
export function toleranceDays(kind: CadenceKind): number {
  switch (kind) {
    case 'weekly':
      return 1;
    case 'monthly':
      return 3;
    case 'yearly':
      return 7;
  }
}

/**
 * Add months, clamping the day the way billing systems do: an anchor of the
 * 31st becomes the 28th in February, then returns to the 31st in March. Note
 * that it returns to the ANCHOR, not to 28 — which is why the anchor is carried
 * separately rather than derived from the previous date.
 */
export function addMonthsClamped(base: Date, months: number, anchorDom: number): Date {
  const targetMonthIndex = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;

  // Day 0 of the following month is the last day of this one.
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchorDom, daysInTargetMonth);

  return new Date(
    Date.UTC(
      year,
      month,
      day,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  );
}

/** The k-th occurrence of `cadence` counting from `anchor` (k = 0 is the anchor). */
export function occurrenceAt(anchor: Date, cadence: Cadence, k: number, anchorDom: number): Date {
  if (cadence.kind === 'weekly') {
    return new Date(anchor.getTime() + k * cadence.n * 7 * DAY_MS);
  }
  const months = cadence.kind === 'monthly' ? cadence.n * k : cadence.n * k * 12;
  return addMonthsClamped(anchor, months, anchorDom);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median absolute deviation — robust to the one late charge that skews a mean. */
function medianAbsoluteDeviation(values: number[], centre: number): number {
  if (values.length === 0) return 0;
  return median(values.map((v) => Math.abs(v - centre)));
}

/**
 * Score one candidate schedule against the observed dates.
 *
 * Matching is greedy nearest-first within tolerance, and each expected slot can
 * absorb at most one observation — otherwise a duplicated charge would inflate
 * coverage rather than being reported as unmatched.
 */
export function scoreCadence(dates: Date[], cadence: Cadence): CadenceFit | null {
  if (dates.length < 2) return null;

  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const anchor = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const anchorDom = anchor.getUTCDate();
  const tol = toleranceDays(cadence.kind);

  // Generate the expected dates that fall within the observed window.
  //
  // The bound is exclusive on purpose: a slot lying beyond the final
  // observation is not a charge we failed to see, it is simply the future.
  // Counting it would cap coverage below 1 for even a perfect run.
  const expected: Date[] = [];
  for (let k = 0; k < 512; k++) {
    const occurrence = occurrenceAt(anchor, cadence, k, anchorDom);
    if (occurrence.getTime() > last.getTime() + tol * DAY_MS) break;
    expected.push(occurrence);
  }
  // A schedule so long that it produces fewer slots than observations cannot
  // explain them (e.g. yearly against six monthly charges).
  if (expected.length < 2) return null;

  const slotTaken = new Array<boolean>(expected.length).fill(false);
  const residuals: number[] = [];
  let matched = 0;
  let unmatched = 0;

  for (const observation of sorted) {
    let bestIndex = -1;
    let bestDelta = Infinity;

    for (let i = 0; i < expected.length; i++) {
      if (slotTaken[i]) continue;
      const deltaDays = (observation.getTime() - expected[i]!.getTime()) / DAY_MS;
      if (Math.abs(deltaDays) <= tol && Math.abs(deltaDays) < Math.abs(bestDelta)) {
        bestDelta = deltaDays;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      unmatched++;
    } else {
      slotTaken[bestIndex] = true;
      residuals.push(bestDelta);
      matched++;
    }
  }

  if (matched < 2) return null;

  const coverage = matched / expected.length;
  const phaseOffsetDays = median(residuals);
  const jitterDays = medianAbsoluteDeviation(residuals, phaseOffsetDays);

  // Coverage dominates; jitter and stray observations are penalties.
  const score = coverage - 0.15 * (jitterDays / tol) - 0.05 * unmatched;

  return {
    cadence,
    coverage,
    phaseOffsetDays,
    jitterDays,
    anchorDom,
    score,
    unmatched,
  };
}

/**
 * Pick the schedule that best explains `dates`, or null if none does.
 *
 * Ties break toward the SHORTER period. Weekly and 4-weekly both fit sparse
 * data, and under-calling the frequency is the safer error: it under-states
 * predicted spend rather than inventing charges that never happen.
 */
export function inferCadence(dates: Date[]): CadenceFit | null {
  if (dates.length < 2) return null;

  let best: CadenceFit | null = null;

  for (const candidate of CANDIDATES) {
    const fit = scoreCadence(dates, candidate);
    if (!fit) continue;

    // Require the schedule to explain most of what we saw. Without this a
    // yearly candidate scores well on any two charges a year apart, even when
    // there are ten monthly ones in between.
    if (fit.unmatched > 0 && fit.coverage < 0.5) continue;

    if (best === null || fit.score > best.score + 1e-9) {
      best = fit;
    }
  }

  return best;
}

export interface NextDuePrediction {
  /** ISO-8601 UTC. */
  at: string;
  /** Half-width of the interval in days: "around 14 Aug (±2 days)". */
  ciDays: number;
}

/**
 * Predict the next charge after `lastObserved`.
 *
 * Always paired with an interval. A bare date implies a precision the data does
 * not support, and users plan around these.
 */
export function predictNextDue(
  lastObserved: Date,
  fit: CadenceFit,
  now: Date = new Date(),
): NextDuePrediction {
  let next = occurrenceAt(lastObserved, fit.cadence, 1, fit.anchorDom);
  next = new Date(next.getTime() + fit.phaseOffsetDays * DAY_MS);

  // If the prediction is already in the past, roll forward — a missed cycle
  // should not leave the next due date stuck behind us.
  let guard = 0;
  while (next.getTime() < now.getTime() && guard < 120) {
    next = occurrenceAt(next, fit.cadence, 1, fit.anchorDom);
    guard++;
  }

  return {
    at: next.toISOString(),
    ciDays: Math.ceil(1.5 * fit.jitterDays) + 1,
  };
}

export type SubscriptionState = 'active' | 'provisional' | 'overdue' | 'likely_cancelled';

/** Grace period before a missed charge counts as missed at all. */
function graceDays(kind: CadenceKind): number {
  switch (kind) {
    case 'weekly':
      return 3;
    case 'monthly':
      return 5;
    case 'yearly':
      return 14;
  }
}

/**
 * Classify current state.
 *
 * One missed cycle is usually a failed payment that retries successfully a few
 * days later, so a single miss is only 'overdue'. Two consecutive misses is a
 * much stronger signal and is what 'likely_cancelled' requires.
 */
export function classifyState(
  observationCount: number,
  nextDueAt: Date,
  fit: CadenceFit,
  now: Date = new Date(),
): SubscriptionState {
  // Two observations can be coincidence — show it, but do not alert on it.
  if (observationCount < 3) return 'provisional';

  const grace = graceDays(fit.cadence.kind) * DAY_MS;
  const periodMs = nextDueAt.getTime() - occurrenceAt(nextDueAt, fit.cadence, -1, fit.anchorDom).getTime();

  if (now.getTime() > nextDueAt.getTime() + periodMs + grace) return 'likely_cancelled';
  if (now.getTime() > nextDueAt.getTime() + grace) return 'overdue';
  return 'active';
}

export type AmountClass = 'fixed' | 'near_fixed' | 'variable';

export interface AmountProfile {
  medianMinor: number;
  madMinor: number;
  amountClass: AmountClass;
}

/** Summarise amounts. Independent of cadence — see the note at the top. */
export function profileAmounts(amountsMinor: number[]): AmountProfile {
  const medianMinor = Math.round(median(amountsMinor));
  const madMinor = Math.round(medianAbsoluteDeviation(amountsMinor, medianMinor));

  const cv = medianMinor === 0 ? 0 : madMinor / Math.abs(medianMinor);
  const amountClass: AmountClass = cv < 0.01 ? 'fixed' : cv < 0.1 ? 'near_fixed' : 'variable';

  return { medianMinor, madMinor, amountClass };
}

export interface ConfidenceInput {
  observationCount: number;
  fit: CadenceFit;
  amountClass: AmountClass;
  /** True when the merchant was resolved by fuzzy matching rather than an alias. */
  merchantFuzzy: boolean;
  /** True when the mailbox has a known gap that could hide charges. */
  hasHistoryGap: boolean;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Confidence that this really is a recurring subscription.
 *
 * Deliberately conservative: anything below ~0.5 belongs in a "possible
 * subscriptions, confirm?" tray rather than being asserted to the user.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  const { observationCount, fit, amountClass, merchantFuzzy, hasHistoryGap } = input;
  const tol = toleranceDays(fit.cadence.kind);

  const raw =
    1.2 * (Math.min(observationCount, 6) / 6) +
    1.0 * fit.coverage -
    0.8 * (fit.jitterDays / tol) -
    0.5 * (amountClass === 'variable' ? 1 : 0) -
    0.6 * (merchantFuzzy ? 1 : 0) -
    0.4 * (hasHistoryGap ? 1 : 0) -
    0.6;

  return Number(sigmoid(raw * 2.5).toFixed(4));
}
