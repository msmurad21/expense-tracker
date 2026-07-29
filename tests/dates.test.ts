import { describe, it, expect } from 'vitest';
import {
  parseDateToUtc,
  DEFAULT_DATE_OPTIONS,
  type DateParseOptions,
} from '../src/main/parsing/dates.js';

const PKT = DEFAULT_DATE_OPTIONS; // UTC+05:00, day-first
const US: DateParseOptions = {
  assumedOffsetMinutes: -300, // UTC-05:00
  assumedTzLabel: 'EST',
  dayFirst: false,
};

describe('explicit offsets are trusted', () => {
  it('uses a trailing Z', () => {
    const r = parseDateToUtc('2026-07-29T14:35:00Z');
    expect(r.iso).toBe('2026-07-29T14:35:00.000Z');
    expect(r.tzSource).toBe('explicit:Z');
  });

  it('uses a numeric offset and converts to UTC', () => {
    const r = parseDateToUtc('2026-07-29T14:35:00+05:00');
    expect(r.iso).toBe('2026-07-29T09:35:00.000Z');
    expect(r.tzSource).toContain('explicit:');
  });
});

describe('local times use the assumed zone and say so', () => {
  it('converts a PKT wall clock to UTC', () => {
    // 14:35 in UTC+5 is 09:35 UTC.
    const r = parseDateToUtc('29/07/2026 14:35', PKT);
    expect(r.iso).toBe('2026-07-29T09:35:00.000Z');
    expect(r.tzSource).toBe('assumed:PKT');
  });

  it('records the assumption so a wrong zone is visible in the data', () => {
    expect(parseDateToUtc('29-Jul-2026', PKT).tzSource).toBe('assumed:PKT');
  });

  it('handles a date that crosses midnight into the previous UTC day', () => {
    // 02:00 PKT on the 29th is 21:00 UTC on the 28th.
    const r = parseDateToUtc('29/07/2026 02:00', PKT);
    expect(r.iso).toBe('2026-07-28T21:00:00.000Z');
  });
});

describe('formats seen in real bank alerts', () => {
  const cases: [string, string][] = [
    ['2026-07-29 14:35', '2026-07-29T09:35:00.000Z'],
    ['29-Jul-2026 14:35', '2026-07-29T09:35:00.000Z'],
    ['29 July 2026 14:35', '2026-07-29T09:35:00.000Z'],
    ['Jul 29, 2026 2:35 PM', '2026-07-29T09:35:00.000Z'],
    ['29/07/2026 02:35 PM', '2026-07-29T09:35:00.000Z'],
    ['29/07/26 14:35', '2026-07-29T09:35:00.000Z'],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}"`, () => {
      expect(parseDateToUtc(input, PKT).iso).toBe(expected);
    });
  }

  it('defaults a missing time to midnight local', () => {
    expect(parseDateToUtc('29/07/2026', PKT).iso).toBe('2026-07-28T19:00:00.000Z');
  });

  it('finds a date embedded in a sentence', () => {
    const r = parseDateToUtc('Your card was used on 29/07/2026 14:35 at NETFLIX.', PKT);
    expect(r.iso).toBe('2026-07-29T09:35:00.000Z');
  });
});

describe('12-hour clock handling', () => {
  it('maps 12 AM to midnight', () => {
    expect(parseDateToUtc('29/07/2026 12:00 AM', PKT).iso).toBe('2026-07-28T19:00:00.000Z');
  });

  it('maps 12 PM to noon', () => {
    expect(parseDateToUtc('29/07/2026 12:00 PM', PKT).iso).toBe('2026-07-29T07:00:00.000Z');
  });
});

describe('day-first versus month-first', () => {
  it('follows the configured order when ambiguous', () => {
    // 03/04 is 3 April day-first, 4 March month-first.
    expect(parseDateToUtc('03/04/2026', PKT).iso).toBe('2026-04-02T19:00:00.000Z');
    expect(parseDateToUtc('03/04/2026', US).iso).toBe('2026-03-04T05:00:00.000Z');
  });

  it('ignores the setting when only one reading is possible', () => {
    // 29 cannot be a month, so this is 29 July under either convention.
    const dayFirst = parseDateToUtc('29/07/2026 14:35', PKT).iso;
    const monthFirst = parseDateToUtc('29/07/2026 14:35', { ...PKT, dayFirst: false }).iso;
    expect(dayFirst).toBe(monthFirst);
  });
});

describe('refuses rather than silently rolling over', () => {
  it('rejects an impossible day of the month', () => {
    // new Date(2026, 1, 31) quietly becomes 3 March; we must not.
    expect(parseDateToUtc('31/02/2026', PKT).ok).toBe(false);
  });

  it('rejects an impossible month', () => {
    expect(parseDateToUtc('29/13/2026', PKT).ok).toBe(false);
  });

  it('rejects text with no date in it', () => {
    expect(parseDateToUtc('your subscription renews soon', PKT).ok).toBe(false);
    expect(parseDateToUtc('', PKT).ok).toBe(false);
  });
});
