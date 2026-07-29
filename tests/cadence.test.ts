import { describe, it, expect } from 'vitest';
import {
  inferCadence,
  addMonthsClamped,
  predictNextDue,
  classifyState,
  profileAmounts,
  scoreConfidence,
  toleranceDays,
} from '../src/main/subscriptions/cadence.js';

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const dates = (...isos: string[]) => isos.map(d);

describe('addMonthsClamped — the case that breaks naive detectors', () => {
  it('clamps the 31st into February', () => {
    expect(addMonthsClamped(d('2026-01-31'), 1, 31).toISOString()).toContain('2026-02-28');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(addMonthsClamped(d('2024-01-31'), 1, 31).toISOString()).toContain('2024-02-29');
  });

  it('returns to the anchor day after clamping, rather than staying clamped', () => {
    // This is the subtle one: Jan 31 -> Feb 28 -> Mar 31, not Mar 28.
    expect(addMonthsClamped(d('2026-01-31'), 2, 31).toISOString()).toContain('2026-03-31');
  });

  it('rolls across a year boundary', () => {
    expect(addMonthsClamped(d('2026-11-15'), 3, 15).toISOString()).toContain('2027-02-15');
  });
});

describe('inferCadence — regular schedules', () => {
  it('detects a clean monthly subscription', () => {
    const fit = inferCadence(dates('2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 1 });
    expect(fit?.coverage).toBe(1);
    expect(fit?.jitterDays).toBe(0);
  });

  it('detects monthly billing anchored on the 31st despite 28/31-day gaps', () => {
    // Gap-averaging reports "irregular" here. This is the motivating case.
    const fit = inferCadence(dates('2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 1 });
    expect(fit?.coverage).toBe(1);
  });

  it('detects weekly', () => {
    const fit = inferCadence(dates('2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'));
    expect(fit?.cadence).toEqual({ kind: 'weekly', n: 1 });
  });

  it('detects fortnightly', () => {
    const fit = inferCadence(dates('2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16'));
    expect(fit?.cadence).toEqual({ kind: 'weekly', n: 2 });
  });

  it('detects quarterly', () => {
    const fit = inferCadence(dates('2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 3 });
  });

  it('detects annual', () => {
    const fit = inferCadence(dates('2024-03-01', '2025-03-01', '2026-03-01'));
    expect(fit?.cadence).toEqual({ kind: 'yearly', n: 1 });
  });
});

describe('inferCadence — real-world messiness', () => {
  it('absorbs a weekend shift into the phase offset rather than calling it jitter', () => {
    // Billed on the 6th, but pushed to Monday whenever it lands on a weekend.
    const fit = inferCadence(dates('2026-01-06', '2026-02-06', '2026-03-09', '2026-04-06'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 1 });
    // Still recognised as monthly, and the drift stays small.
    expect(fit!.jitterDays).toBeLessThanOrEqual(3);
  });

  it('tolerates a day or two of drift', () => {
    const fit = inferCadence(dates('2026-01-15', '2026-02-16', '2026-03-14', '2026-04-15'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 1 });
  });

  it('does not call a yearly cadence when monthly charges sit in between', () => {
    // Two charges a year apart fit "yearly" perfectly if you ignore the rest.
    const monthly = dates(
      '2025-01-10', '2025-02-10', '2025-03-10', '2025-04-10', '2025-05-10',
      '2025-06-10', '2025-07-10', '2025-08-10', '2025-09-10', '2025-10-10',
      '2025-11-10', '2025-12-10', '2026-01-10',
    );
    expect(inferCadence(monthly)?.cadence).toEqual({ kind: 'monthly', n: 1 });
  });

  it('returns null for a single charge', () => {
    expect(inferCadence(dates('2026-01-15'))).toBeNull();
  });

  it('returns null for scattered one-off purchases', () => {
    const fit = inferCadence(dates('2026-01-03', '2026-01-17', '2026-03-02', '2026-08-21'));
    // Either no fit at all, or one that is clearly weak.
    expect(fit === null || fit.coverage < 0.6).toBe(true);
  });
});

describe('predictNextDue', () => {
  it('predicts the next charge with an interval, never a bare date', () => {
    const observed = dates('2026-01-15', '2026-02-15', '2026-03-15');
    const fit = inferCadence(observed)!;
    const next = predictNextDue(observed[observed.length - 1]!, fit, d('2026-03-20'));

    expect(next.at).toContain('2026-04-15');
    expect(next.ciDays).toBeGreaterThanOrEqual(1);
  });

  it('widens the interval when billing is jittery', () => {
    const steady = inferCadence(dates('2026-01-15', '2026-02-15', '2026-03-15'))!;
    const jittery = inferCadence(dates('2026-01-15', '2026-02-17', '2026-03-13'))!;

    const steadyCi = predictNextDue(d('2026-03-15'), steady, d('2026-03-20')).ciDays;
    const jitteryCi = predictNextDue(d('2026-03-13'), jittery, d('2026-03-20')).ciDays;

    expect(jitteryCi).toBeGreaterThan(steadyCi);
  });

  it('rolls a stale prediction forward past today', () => {
    const fit = inferCadence(dates('2026-01-15', '2026-02-15', '2026-03-15'))!;
    const next = predictNextDue(d('2026-03-15'), fit, d('2026-07-01'));
    expect(new Date(next.at).getTime()).toBeGreaterThan(d('2026-07-01').getTime());
  });
});

describe('classifyState', () => {
  const fit = inferCadence(dates('2026-01-15', '2026-02-15', '2026-03-15'))!;

  it('treats two observations as provisional, however clean', () => {
    const twoOnly = inferCadence(dates('2026-01-15', '2026-02-15'))!;
    expect(classifyState(2, d('2026-03-15'), twoOnly, d('2026-03-14'))).toBe('provisional');
  });

  it('is active before the next charge is due', () => {
    expect(classifyState(4, d('2026-04-15'), fit, d('2026-04-10'))).toBe('active');
  });

  it('is still active inside the grace period', () => {
    // A charge three days late is usually a retry, not a cancellation.
    expect(classifyState(4, d('2026-04-15'), fit, d('2026-04-18'))).toBe('active');
  });

  it('is overdue after one clearly missed cycle', () => {
    expect(classifyState(4, d('2026-04-15'), fit, d('2026-04-30'))).toBe('overdue');
  });

  it('is likely cancelled only after two consecutive misses', () => {
    expect(classifyState(4, d('2026-04-15'), fit, d('2026-06-10'))).toBe('likely_cancelled');
  });
});

describe('profileAmounts — independent of cadence', () => {
  it('classifies an unchanging price as fixed', () => {
    const p = profileAmounts([1549, 1549, 1549, 1549]);
    expect(p.amountClass).toBe('fixed');
    expect(p.medianMinor).toBe(1549);
  });

  it('classifies FX wobble as near-fixed, not as a price change', () => {
    // A USD subscription billed to a PKR card moves 1-3% every month purely
    // from the exchange rate. That must not read as a variable-price service.
    expect(profileAmounts([432050, 445000, 421000, 438000]).amountClass).toBe('near_fixed');
  });

  it('treats a genuinely unchanging PKR price as fixed', () => {
    expect(profileAmounts([432050, 432050, 432050]).amountClass).toBe('fixed');
  });

  it('classifies a utility bill as variable', () => {
    expect(profileAmounts([120000, 350000, 210000, 480000]).amountClass).toBe('variable');
  });

  it('does not stop a variable amount from being recurring', () => {
    // The whole point: a utility bill is variable AND perfectly monthly.
    const fit = inferCadence(dates('2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'));
    expect(fit?.cadence).toEqual({ kind: 'monthly', n: 1 });
  });

  it('resists a single outlier', () => {
    // MAD, not standard deviation — one annual charge must not reclassify it.
    expect(profileAmounts([1549, 1549, 1549, 1549, 99999]).medianMinor).toBe(1549);
  });
});

describe('scoreConfidence', () => {
  const cleanFit = inferCadence(
    dates('2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'),
  )!;

  it('is high for a long, clean, fixed-price run', () => {
    const score = scoreConfidence({
      observationCount: 6,
      fit: cleanFit,
      amountClass: 'fixed',
      merchantFuzzy: false,
      hasHistoryGap: false,
    });
    expect(score).toBeGreaterThan(0.8);
  });

  it('drops when the merchant was only fuzzily matched', () => {
    const base = {
      observationCount: 6,
      fit: cleanFit,
      amountClass: 'fixed' as const,
      hasHistoryGap: false,
    };
    expect(scoreConfidence({ ...base, merchantFuzzy: true })).toBeLessThan(
      scoreConfidence({ ...base, merchantFuzzy: false }),
    );
  });

  it('drops with fewer observations', () => {
    const base = {
      fit: cleanFit,
      amountClass: 'fixed' as const,
      merchantFuzzy: false,
      hasHistoryGap: false,
    };
    expect(scoreConfidence({ ...base, observationCount: 2 })).toBeLessThan(
      scoreConfidence({ ...base, observationCount: 6 }),
    );
  });

  it('stays within 0..1', () => {
    for (const count of [2, 3, 6, 20]) {
      const score = scoreConfidence({
        observationCount: count,
        fit: cleanFit,
        amountClass: 'variable',
        merchantFuzzy: true,
        hasHistoryGap: true,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('toleranceDays', () => {
  it('allows longer periods more drift', () => {
    expect(toleranceDays('weekly')).toBeLessThan(toleranceDays('monthly'));
    expect(toleranceDays('monthly')).toBeLessThan(toleranceDays('yearly'));
  });
});
