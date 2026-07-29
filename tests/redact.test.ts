import { describe, it, expect } from 'vitest';
import { redactEmailBody, containsUnredactedData } from '../src/main/ingest/redact.js';

/**
 * These guard the promise that redacted output is safe to paste into a chat or
 * an issue. A weakening here leaks someone's card number, so the tests assert
 * absence of data rather than presence of formatting.
 */

const SAMPLE = `Dear Customer,

Your Card ending 4821 has been used for a purchase.

Amount: PKR 4,320.50
Merchant: NETFLIX.COM
Date & Time: 29/07/2026 14:35
Account: 01234567890123
Reference: A1B2C3D4E5F6G7H8I9J0

Questions? Email support@bank.example or visit https://bank.example/help?token=abc123

Available balance: PKR 152,900.00`;

describe('redactEmailBody', () => {
  const redacted = redactEmailBody(SAMPLE);

  it('removes every digit', () => {
    expect(redacted).not.toMatch(/\d/);
  });

  it('leaves no fragment of the amount, card or account number', () => {
    for (const secret of ['4821', '4,320.50', '4320', '01234567890123', '152,900', '2026']) {
      expect(redacted).not.toContain(secret);
    }
  });

  it('removes email addresses', () => {
    expect(redacted).not.toContain('support@bank.example');
    expect(redacted).toContain('someone@example.com');
  });

  it('removes URLs, including their query strings', () => {
    expect(redacted).not.toContain('token=abc123');
    expect(redacted).not.toContain('bank.example/help');
  });

  it('removes long opaque reference tokens', () => {
    expect(redacted).not.toContain('A1B2C3D4E5F6G7H8I9J0');
  });

  it('keeps the structure a parser author needs', () => {
    // The labels and their layout are the whole point of the exercise.
    expect(redacted).toContain('Amount: PKR #,###.##');
    expect(redacted).toContain('Merchant: NETFLIX.COM');
    expect(redacted).toContain('ending ####');
    expect(redacted).toContain('Date & Time: ##/##/#### ##:##');
  });

  it('handles an empty or non-string body without throwing', () => {
    expect(redactEmailBody('')).toBe('');
    expect(redactEmailBody(undefined as unknown as string)).toBe('');
  });

  it('truncates when asked', () => {
    const short = redactEmailBody(SAMPLE, { maxLength: 40 });
    expect(short.length).toBeLessThan(80);
    expect(short).toContain('truncated');
  });
});

describe('containsUnredactedData', () => {
  it('flags text that still has digits', () => {
    expect(containsUnredactedData('Amount: 100')).toBe(true);
  });

  it('passes fully redacted output', () => {
    expect(containsUnredactedData(redactEmailBody(SAMPLE))).toBe(false);
  });
});

describe('containsUnredactedData — the traps it has to avoid', () => {
  it('does not mistake its own placeholders for a leak', () => {
    // someone@example.com is shaped exactly like the thing being looked for.
    expect(containsUnredactedData('Contact someone@example.com for help')).toBe(false);
    expect(containsUnredactedData('See https://example.com/link')).toBe(false);
  });

  it('still catches a real address that survived redaction', () => {
    expect(containsUnredactedData('write to alerts@sc.com')).toBe(true);
  });

  it('gives the same answer when called repeatedly', () => {
    // A /g regex advances lastIndex across test() calls, so a stateful
    // implementation alternates between true and false on identical input.
    const redacted = redactEmailBody(SAMPLE);
    const answers = Array.from({ length: 5 }, () => containsUnredactedData(redacted));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(false);
  });
});
