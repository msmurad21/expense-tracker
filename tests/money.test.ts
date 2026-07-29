import { describe, it, expect } from 'vitest';
import {
  parseMoneyMinor,
  minorUnitExponent,
  normaliseCurrency,
  formatMoney,
} from '../src/main/parsing/money.js';

const minor = (input: string, currency: string): number | undefined =>
  parseMoneyMinor(input, currency).minor;

describe('minorUnitExponent', () => {
  it('defaults to 2', () => {
    expect(minorUnitExponent('PKR')).toBe(2);
    expect(minorUnitExponent('USD')).toBe(2);
  });

  it('knows the zero-decimal currencies', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KRW')).toBe(0);
  });

  it('knows the three-decimal currencies', () => {
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('BHD')).toBe(3);
  });

  it('is case insensitive', () => {
    expect(minorUnitExponent('jpy')).toBe(0);
  });
});

describe('parseMoneyMinor — the shapes bank emails actually use', () => {
  it('parses a grouped amount with decimals', () => {
    expect(minor('4,320.50', 'PKR')).toBe(432050);
    expect(minor('1,234.56', 'USD')).toBe(123456);
  });

  it('parses an amount with no decimals', () => {
    expect(minor('4,320', 'PKR')).toBe(432000);
    expect(minor('500', 'PKR')).toBe(50000);
  });

  it('parses an amount with no grouping', () => {
    expect(minor('15.49', 'USD')).toBe(1549);
  });

  it('ignores currency symbols and surrounding text', () => {
    expect(minor('PKR 4,320.50', 'PKR')).toBe(432050);
    expect(minor('Rs. 4,320.50', 'PKR')).toBe(432050);
    expect(minor('US$15.49', 'USD')).toBe(1549);
    expect(minor('  ₨ 1,000.00  ', 'PKR')).toBe(100000);
  });

  it('handles multiple grouping separators', () => {
    expect(minor('1,234,567.89', 'PKR')).toBe(123456789);
  });

  it('handles European-style separators', () => {
    // Last separator wins: the comma here is the decimal point.
    expect(minor('1.234,56', 'EUR')).toBe(123456);
  });
});

describe('parseMoneyMinor — currency precision', () => {
  it('uses zero minor digits for JPY', () => {
    expect(minor('1,200', 'JPY')).toBe(1200);
    expect(minor('¥1,200', 'JPY')).toBe(1200);
  });

  it('uses three minor digits for KWD', () => {
    expect(minor('12.345', 'KWD')).toBe(12345);
    expect(minor('12.3', 'KWD')).toBe(12300);
  });

  it('pads a short fraction to the currency precision', () => {
    expect(minor('15.4', 'USD')).toBe(1540);
    expect(minor('15', 'USD')).toBe(1500);
  });
});

describe('parseMoneyMinor — rounding is exact, never floating point', () => {
  it('rounds half up when the input is finer than the currency', () => {
    // JPY has no minor unit, so any fraction has to be rounded away.
    expect(minor('12.5', 'JPY')).toBe(13);
    expect(minor('12.4', 'JPY')).toBe(12);
  });

  it('carries correctly when rounding ripples through', () => {
    expect(minor('9.5', 'JPY')).toBe(10);
    expect(minor('99.5', 'JPY')).toBe(100);
  });

  it('avoids the classic float representation errors', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; these must be exact.
    expect(minor('0.10', 'USD')).toBe(10);
    expect(minor('0.20', 'USD')).toBe(20);
    expect(minor('0.30', 'USD')).toBe(30);
    expect(minor('1234567.89', 'USD')).toBe(123456789);
  });

  it('returns integers, always', () => {
    for (const input of ['4,320.50', '15.49', '0.01', '1,234,567.89']) {
      const result = parseMoneyMinor(input, 'PKR');
      expect(Number.isInteger(result.minor)).toBe(true);
    }
  });
});

describe('parseMoneyMinor — negatives', () => {
  it('reads a leading minus', () => {
    expect(minor('-15.49', 'USD')).toBe(-1549);
  });

  it('reads accounting-style parentheses', () => {
    expect(minor('(15.49)', 'USD')).toBe(-1549);
  });
});

describe('parseMoneyMinor — refuses rather than guesses', () => {
  it('rejects input with no digits', () => {
    expect(parseMoneyMinor('N/A', 'PKR').ok).toBe(false);
    expect(parseMoneyMinor('', 'PKR').ok).toBe(false);
  });

  it('refuses a dot followed by three digits in a two-decimal currency', () => {
    // "1.005" is either 1005 (European grouping) or 1.005 (three decimals).
    // Guessing either way is a 1000x error on someone's money, so refuse.
    // This is the single most dangerous ambiguity in the whole parser.
    const result = parseMoneyMinor('1.005', 'USD');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ambiguous');
  });

  it('still accepts that same shape where the currency settles it', () => {
    // KWD genuinely has three decimal places, so there is no ambiguity.
    expect(minor('12.345', 'KWD')).toBe(12345);
  });

  it('rejects more than three digits after a separator', () => {
    expect(parseMoneyMinor('1.23456', 'PKR').ok).toBe(false);
  });

  it('rejects a trailing separator', () => {
    expect(parseMoneyMinor('1,234.', 'PKR').ok).toBe(false);
  });

  it('rejects amounts too large to hold exactly', () => {
    expect(parseMoneyMinor('99999999999999999999.00', 'PKR').ok).toBe(false);
  });
});

describe('normaliseCurrency', () => {
  it('maps local spellings to ISO codes', () => {
    expect(normaliseCurrency('Rs')).toBe('PKR');
    expect(normaliseCurrency('Rs.')).toBe('PKR');
    expect(normaliseCurrency('₨')).toBe('PKR');
    expect(normaliseCurrency('$')).toBe('USD');
    expect(normaliseCurrency('US$')).toBe('USD');
    expect(normaliseCurrency('  usd ')).toBe('USD');
  });

  it('passes through plausible ISO codes', () => {
    expect(normaliseCurrency('SEK')).toBe('SEK');
  });

  it('returns null when it cannot tell', () => {
    expect(normaliseCurrency('')).toBeNull();
    expect(normaliseCurrency('money')).toBeNull();
  });
});

describe('formatMoney', () => {
  it('renders minor units back to a readable amount', () => {
    expect(formatMoney(432050, 'PKR')).toContain('4,320.50');
    expect(formatMoney(1549, 'USD')).toContain('15.49');
  });

  it('respects zero-decimal currencies', () => {
    expect(formatMoney(1200, 'JPY')).toContain('1,200');
    expect(formatMoney(1200, 'JPY')).not.toContain('.00');
  });
});
