/**
 * Parsing money out of email text into exact integer minor units.
 *
 * Every amount in this app is stored as an integer number of minor units
 * (paisa, cents) alongside an explicit ISO-4217 code. Floating point never
 * touches a monetary value: `0.1 + 0.2 !== 0.3` is not an acceptable property
 * for something that tells you what you paid.
 *
 * The hard part is that separators are ambiguous. `1,234` is one thousand two
 * hundred and thirty-four; `1,23` is one and twenty-three hundredths in much of
 * Europe. Rather than guess from a locale we may not know, the rules below
 * decide from the shape of the string and refuse when genuinely ambiguous.
 */

/**
 * Minor-unit exponents that differ from the usual 2.
 * Getting this wrong silently multiplies or divides an amount by 100.
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  // Zero-decimal
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  RWF: 0,
  UGX: 0,
  PYG: 0,
  // Three-decimal
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

const DEFAULT_EXPONENT = 2;

export function minorUnitExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/**
 * Symbols and local spellings seen in the target markets, mapped to ISO codes.
 * Deliberately small and explicit — a wrong guess here mislabels real money.
 */
const CURRENCY_ALIASES: Record<string, string> = {
  RS: 'PKR',
  'RS.': 'PKR',
  PKR: 'PKR',
  RUPEES: 'PKR',
  '₨': 'PKR',
  PKRS: 'PKR',
  $: 'USD',
  US$: 'USD',
  USD: 'USD',
  'U.S.$': 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
  '₹': 'INR',
  INR: 'INR',
  AED: 'AED',
  'د.إ': 'AED',
  SAR: 'SAR',
  '¥': 'JPY',
  JPY: 'JPY',
};

/**
 * Normalise a currency token to an ISO-4217 code, or null when unrecognised.
 *
 * Note the deliberate ambiguity: `Rs` means PKR here but INR elsewhere, and `$`
 * could be several currencies. Templates should therefore prefer an explicit
 * `fallback` currency bound to the sending bank over sniffing the symbol.
 */
export function normaliseCurrency(token: string): string | null {
  const cleaned = token.trim().toUpperCase();
  if (cleaned.length === 0) return null;
  if (CURRENCY_ALIASES[cleaned]) return CURRENCY_ALIASES[cleaned]!;
  if (/^[A-Z]{3}$/.test(cleaned)) return cleaned; // plausible ISO code
  return null;
}

export interface MoneyParseResult {
  ok: boolean;
  minor?: number;
  reason?: string;
}

/**
 * Parse a monetary string into minor units for `currency`.
 *
 *   parseMoneyMinor('4,320.50', 'PKR') -> 432050
 *   parseMoneyMinor('1.234,56', 'EUR') -> 123456
 *   parseMoneyMinor('1,234',    'PKR') -> 123400
 *   parseMoneyMinor('¥1,200',   'JPY') -> 1200      (zero-decimal currency)
 */
export function parseMoneyMinor(input: string, currency: string): MoneyParseResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not a string' };
  }

  // A leading minus, or accounting-style parentheses around the whole amount.
  const negative = /^\s*-/.test(input) || /^\s*\(.*\)\s*$/.test(input);

  // Keep only the numeric skeleton. Currency symbols, spaces and stray letters
  // are discarded; the caller supplies the currency separately.
  const skeleton = input.replace(/[^\d.,]/g, '');
  if (skeleton.length === 0) {
    return { ok: false, reason: 'no digits found' };
  }

  const exponent = minorUnitExponent(currency);

  const lastDot = skeleton.lastIndexOf('.');
  const lastComma = skeleton.lastIndexOf(',');

  let integerPart: string;
  let fractionPart: string;

  if (lastDot === -1 && lastComma === -1) {
    integerPart = skeleton;
    fractionPart = '';
  } else {
    // The last separator is the candidate decimal point. What it actually means
    // depends on how many digits follow it and on the currency's precision.
    const sepIndex = Math.max(lastDot, lastComma);
    const sep = skeleton[sepIndex]!;
    const tail = skeleton.slice(sepIndex + 1);

    if (!/^\d+$/.test(tail)) {
      return { ok: false, reason: `trailing separator in "${input}"` };
    }

    if (tail.length <= 2) {
      // One or two trailing digits is never a thousands group.
      integerPart = skeleton.slice(0, sepIndex);
      fractionPart = tail;
    } else if (tail.length === 3) {
      // The genuinely ambiguous case: "4,320" and "1.005" have identical shape.
      if (sep === ',') {
        // Comma-grouping is near-universal in this app's target markets, and
        // a comma decimal separator with three digits is not a real format.
        integerPart = skeleton;
        fractionPart = '';
      } else if (exponent === 3) {
        // A three-decimal currency (KWD, BHD): three digits is the fraction.
        integerPart = skeleton.slice(0, sepIndex);
        fractionPart = tail;
      } else {
        // "1.005" in USD is either 1005 (European grouping) or 1.005 (three
        // decimals). Guessing either way risks a 1000x error on someone's
        // money, so refuse and let a human or a better template decide.
        return {
          ok: false,
          reason: `ambiguous separator in "${input}" — three digits after "." could be grouping or a fraction`,
        };
      }
    } else {
      return { ok: false, reason: `unexpected digit grouping in "${input}"` };
    }
  }

  // Strip grouping separators, then verify nothing unexpected survived.
  const digitsOnly = integerPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(digitsOnly)) {
    return { ok: false, reason: `unparseable integer part in "${input}"` };
  }

  // Pad or round the fraction to the currency's precision. Rounding is
  // half-up on the string, avoiding any float intermediate.
  let fractionDigits = fractionPart;
  let roundUp = false;
  if (fractionDigits.length > exponent) {
    const nextDigit = Number(fractionDigits[exponent] ?? '0');
    roundUp = nextDigit >= 5;
    fractionDigits = fractionDigits.slice(0, exponent);
  }
  fractionDigits = fractionDigits.padEnd(exponent, '0');

  const combined = (digitsOnly === '' ? '0' : digitsOnly) + fractionDigits;

  // BigInt keeps the half-up carry exact even when it ripples (e.g. 9.999 -> 10.00).
  const magnitude = BigInt(combined === '' ? '0' : combined) + (roundUp ? 1n : 0n);
  const minor = Number(magnitude);

  if (!Number.isSafeInteger(minor)) {
    return { ok: false, reason: 'amount too large to represent exactly' };
  }

  return { ok: true, minor: negative ? -minor : minor };
}

/** Render minor units for display. Presentation only — never round-tripped. */
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const exponent = minorUnitExponent(currency);
  const value = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(exponent)}`;
  }
}
