import { describe, it, expect } from 'vitest';
import {
  dedupeTransactions,
  detectSubscriptions,
  detectPriceChanges,
  monthlyEquivalentMinor,
  type DetectorTransaction,
} from '../src/main/subscriptions/detect.js';
import { normaliseMerchant, resolveMerchant } from '../src/main/subscriptions/normalize.js';

let nextId = 1;
const tx = (
  occurredAt: string,
  amountMinor: number,
  merchantRaw = 'NETFLIX.COM',
  overrides: Partial<DetectorTransaction> = {},
): DetectorTransaction => ({
  id: nextId++,
  amountMinor,
  currency: 'PKR',
  occurredAt: `${occurredAt}T12:00:00.000Z`,
  merchantRaw,
  cardLast4: '4821',
  kind: 'purchase',
  ...overrides,
});

describe('normaliseMerchant', () => {
  it('collapses the spellings of one merchant to one key', () => {
    const variants = ['NETFLIX.COM', 'SQ *NETFLIX', 'NETFLIX 8663797', 'netflix.com'];
    const keys = new Set(variants.map(normaliseMerchant));
    expect(keys.size).toBe(1);
  });

  it('strips locality tails', () => {
    expect(normaliseMerchant('SPOTIFY USA NEW YORK NY')).toContain('SPOTIFY');
  });

  it('strips processor prefixes', () => {
    expect(normaliseMerchant('PAYPAL *SPOTIFY')).toBe('SPOTIFY');
  });

  it('keeps genuinely different merchants apart', () => {
    expect(normaliseMerchant('APPLE.COM/BILL')).not.toBe(normaliseMerchant('APPLE STORE R123'));
  });
});

describe('resolveMerchant', () => {
  it('maps a known descriptor to a display name and category', () => {
    const resolved = resolveMerchant('NETFLIX.COM 866-579-7172');
    expect(resolved.displayName).toBe('Netflix');
    expect(resolved.category).toBe('Streaming');
    expect(resolved.source).toBe('alias');
  });

  it('falls back to the leading token', () => {
    expect(resolveMerchant('SPOTIFY INTL BV').displayName).toBe('Spotify');
  });

  it('derives something readable for an unknown merchant', () => {
    const resolved = resolveMerchant('SOME LOCAL SHOP');
    expect(resolved.source).toBe('derived');
    expect(resolved.displayName).toBe('Some Local Shop');
  });
});

describe('dedupeTransactions — the authorisation/settlement problem', () => {
  it('collapses an authorisation and its settlement', () => {
    // Without this every subscription looks like it bills twice a month.
    const rows = [tx('2026-01-15', 432050), tx('2026-01-17', 434100)];
    expect(dedupeTransactions(rows)).toHaveLength(1);
  });

  it('keeps the settled amount, not the authorised one', () => {
    const rows = [tx('2026-01-15', 432050), tx('2026-01-17', 434100)];
    expect(dedupeTransactions(rows)[0]!.amountMinor).toBe(434100);
  });

  it('does not collapse two genuine charges a month apart', () => {
    const rows = [tx('2026-01-15', 432050), tx('2026-02-15', 432050)];
    expect(dedupeTransactions(rows)).toHaveLength(2);
  });

  it('does not collapse charges whose amounts differ wildly', () => {
    const rows = [tx('2026-01-15', 100000), tx('2026-01-16', 900000)];
    expect(dedupeTransactions(rows)).toHaveLength(2);
  });

  it('removes refunds and reversals from the charge stream', () => {
    const rows = [
      tx('2026-01-15', 432050),
      tx('2026-02-15', 432050),
      tx('2026-02-16', -432050, 'NETFLIX.COM', { kind: 'refund' }),
    ];
    const kept = dedupeTransactions(rows);
    expect(kept).toHaveLength(2);
    expect(kept.every((t) => t.amountMinor > 0)).toBe(true);
  });

  it('does not merge different merchants that happen to coincide', () => {
    const rows = [tx('2026-01-15', 432050, 'NETFLIX.COM'), tx('2026-01-15', 432050, 'SPOTIFY')];
    expect(dedupeTransactions(rows)).toHaveLength(2);
  });
});

describe('detectSubscriptions', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');

  it('detects a monthly subscription and predicts the next charge', () => {
    const rows = [
      tx('2026-01-15', 432050),
      tx('2026-02-15', 432050),
      tx('2026-03-15', 432050),
      tx('2026-04-15', 432050),
    ];
    const [sub] = detectSubscriptions(rows, now);

    expect(sub!.merchantName).toBe('Netflix');
    expect(sub!.cadence).toEqual({ kind: 'monthly', n: 1 });
    expect(sub!.amountMedianMinor).toBe(432050);
    expect(sub!.nextDueAt).toContain('2026-05-15');
    expect(sub!.state).toBe('active');
    expect(sub!.confidence).toBeGreaterThan(0.6);
  });

  it('ignores a merchant charged only once', () => {
    const rows = [tx('2026-01-15', 432050, 'ONE OFF SHOP')];
    expect(detectSubscriptions(rows, now)).toHaveLength(0);
  });

  it('groups across a card reissue rather than splitting the subscription', () => {
    // A new card changes the last-4 while the subscription carries on.
    const rows = [
      tx('2026-01-15', 432050, 'NETFLIX.COM', { cardLast4: '4821' }),
      tx('2026-02-15', 432050, 'NETFLIX.COM', { cardLast4: '4821' }),
      tx('2026-03-15', 432050, 'NETFLIX.COM', { cardLast4: '9004' }),
      tx('2026-04-15', 432050, 'NETFLIX.COM', { cardLast4: '9004' }),
    ];
    const subs = detectSubscriptions(rows, now);

    expect(subs).toHaveLength(1);
    expect(subs[0]!.observedLast4.sort()).toEqual(['4821', '9004']);
  });

  it('collapses merchant spelling variants into one subscription', () => {
    const rows = [
      tx('2026-01-15', 432050, 'NETFLIX.COM'),
      tx('2026-02-15', 432050, 'SQ *NETFLIX'),
      tx('2026-03-15', 432050, 'NETFLIX 8663797'),
    ];
    expect(detectSubscriptions(rows, now)).toHaveLength(1);
  });

  it('marks a two-charge run as provisional rather than asserting it', () => {
    const rows = [tx('2026-03-15', 432050), tx('2026-04-15', 432050)];
    expect(detectSubscriptions(rows, now)[0]!.state).toBe('provisional');
  });
});

describe('detectPriceChanges', () => {
  it('flags a genuine price rise on a home-currency subscription', () => {
    const rows = [
      tx('2026-01-15', 400000),
      tx('2026-02-15', 400000),
      tx('2026-03-15', 450000),
      tx('2026-04-15', 450000),
    ];
    const [change] = detectPriceChanges(rows, 'PKR');

    expect(change?.fromMinor).toBe(400000);
    expect(change?.toMinor).toBe(450000);
  });

  it('does NOT flag monthly FX drift on a foreign subscription', () => {
    // This is the noisiest false positive available: a USD subscription on a
    // PKR card moves a few percent every month on exchange rate alone.
    const rows = [
      tx('2026-01-15', 1549, 'NETFLIX.COM', { currency: 'USD' }),
      tx('2026-02-15', 1549, 'NETFLIX.COM', { currency: 'USD' }),
      tx('2026-03-15', 1595, 'NETFLIX.COM', { currency: 'USD' }), // +3%
      tx('2026-04-15', 1600, 'NETFLIX.COM', { currency: 'USD' }),
    ];
    expect(detectPriceChanges(rows, 'PKR')).toHaveLength(0);
  });

  it('still flags a large rise on a foreign subscription', () => {
    const rows = [
      tx('2026-01-15', 1549, 'NETFLIX.COM', { currency: 'USD' }),
      tx('2026-02-15', 1549, 'NETFLIX.COM', { currency: 'USD' }),
      tx('2026-03-15', 1899, 'NETFLIX.COM', { currency: 'USD' }), // +22%
      tx('2026-04-15', 1899, 'NETFLIX.COM', { currency: 'USD' }),
    ];
    expect(detectPriceChanges(rows, 'PKR')).toHaveLength(1);
  });

  it('ignores a one-off proration that the next charge contradicts', () => {
    const rows = [
      tx('2026-01-15', 400000),
      tx('2026-02-15', 400000),
      tx('2026-03-15', 520000), // one-off
      tx('2026-04-15', 400000), // back to normal
    ];
    expect(detectPriceChanges(rows, 'PKR')).toHaveLength(0);
  });

  it('ignores variable-amount services entirely', () => {
    const rows = [
      tx('2026-01-05', 120000, 'K ELECTRIC'),
      tx('2026-02-05', 350000, 'K ELECTRIC'),
      tx('2026-03-05', 210000, 'K ELECTRIC'),
      tx('2026-04-05', 480000, 'K ELECTRIC'),
    ];
    expect(detectPriceChanges(rows, 'PKR')).toHaveLength(0);
  });
});

describe('monthlyEquivalentMinor', () => {
  const base = {
    merchantKey: 'X',
    merchantName: 'X',
    category: null,
    currency: 'PKR',
    amountClass: 'fixed' as const,
    firstSeenAt: '',
    lastChargedAt: '',
    nextDueAt: '',
    nextDueCiDays: 1,
    state: 'active' as const,
    confidence: 1,
    observedLast4: [],
    transactionIds: [],
    chargeCount: 3,
  };

  it('normalises an annual subscription to a monthly figure', () => {
    expect(
      monthlyEquivalentMinor({ ...base, cadence: { kind: 'yearly', n: 1 }, amountMedianMinor: 1200 }),
    ).toBe(100);
  });

  it('normalises weekly to monthly', () => {
    expect(
      monthlyEquivalentMinor({ ...base, cadence: { kind: 'weekly', n: 1 }, amountMedianMinor: 1000 }),
    ).toBe(4333);
  });

  it('leaves monthly unchanged', () => {
    expect(
      monthlyEquivalentMinor({ ...base, cadence: { kind: 'monthly', n: 1 }, amountMedianMinor: 5000 }),
    ).toBe(5000);
  });
});

describe('regressions found by the demo data', () => {
  it('keeps single-letter tokens, so "K ELECTRIC" resolves to K-Electric', () => {
    // Dropping short tokens as noise turned this into "ELECTRIC", which missed
    // the alias entry and displayed the utility as "Electric".
    expect(normaliseMerchant('K ELECTRIC')).toBe('K ELECTRIC');
    expect(resolveMerchant('K ELECTRIC').displayName).toBe('K-Electric');
  });

  it('does not report a price change for a noisy utility bill', () => {
    // A four-charge window of a variable bill can look stable by luck, which
    // is how an electricity bill got reported as a 10% price cut.
    const utility = [180000, 500000, 210000, 480000, 195000, 460000, 205000, 495000].map(
      (amount, i) => tx(`2026-0${(i % 9) + 1}-06`.slice(0, 10), amount, 'K ELECTRIC'),
    );
    expect(detectPriceChanges(utility, 'PKR')).toHaveLength(0);
  });
});
