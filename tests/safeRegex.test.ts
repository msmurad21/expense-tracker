import { describe, it, expect } from 'vitest';
import { vetPattern, countCaptureGroups } from '../src/main/parsing/safeRegex.js';

describe('countCaptureGroups', () => {
  it('counts plain groups', () => {
    expect(countCaptureGroups('(\\d+)')).toBe(1);
    expect(countCaptureGroups('(\\d+)-(\\d+)')).toBe(2);
  });

  it('ignores non-capturing groups and lookarounds', () => {
    expect(countCaptureGroups('(?:PKR|USD)\\s*(\\d+)')).toBe(1);
    expect(countCaptureGroups('(?=Total)(\\d+)')).toBe(1);
    expect(countCaptureGroups('(?<=Rs\\.)(\\d+)')).toBe(1);
    expect(countCaptureGroups('(?!x)(\\d+)')).toBe(1);
  });

  it('counts named captures', () => {
    expect(countCaptureGroups('(?<amount>\\d+)')).toBe(1);
  });

  it('ignores parentheses inside character classes and escapes', () => {
    expect(countCaptureGroups('[()]+(\\d+)')).toBe(1);
    expect(countCaptureGroups('\\((\\d+)\\)')).toBe(1);
  });
});

describe('vetPattern — accepts realistic extraction patterns', () => {
  const realistic = [
    'PKR\\s*([\\d,]+\\.\\d{2})',
    'card ending (?:in )?(\\d{4})',
    'Amount:\\s*([0-9,]+(?:\\.[0-9]{2})?)',
    'at\\s+([A-Z0-9 .*\\-]{3,40})\\s+on',
    '(?<merchant>[A-Za-z0-9 ]+) charged your card',
    'Total[:\\s]+US\\$([\\d.]+)',
  ];

  for (const pattern of realistic) {
    it(`accepts ${pattern}`, () => {
      expect(vetPattern(pattern)).toEqual({ safe: true });
    });
  }

  it('allows quantifiers inside a character class', () => {
    // `+` and `*` here are literals, not quantifiers — must not be flagged.
    expect(vetPattern('([a+*]+)').safe).toBe(true);
  });
});

describe('vetPattern — rejects catastrophic backtracking', () => {
  const evil: [string, string][] = [
    ['(a+)+', 'NESTED_QUANTIFIER'],
    ['(a*)*', 'NESTED_QUANTIFIER'],
    ['(a+)*', 'NESTED_QUANTIFIER'],
    ['(\\d+)+', 'NESTED_QUANTIFIER'],
    ['([a-zA-Z]+)*', 'NESTED_QUANTIFIER'],
    ['(x+x+)+y', 'NESTED_QUANTIFIER'],
    ['(a{1,})+', 'NESTED_QUANTIFIER'],
  ];

  for (const [pattern, code] of evil) {
    it(`rejects ${pattern}`, () => {
      const verdict = vetPattern(pattern);
      expect(verdict.safe).toBe(false);
      expect(verdict.code).toBe(code);
    });
  }

  it('catches nesting at any depth', () => {
    expect(vetPattern('((a+)+)+').safe).toBe(false);
  });
});

describe('vetPattern — rejects other hazards', () => {
  it('rejects backreferences', () => {
    expect(vetPattern('(a)\\1').code).toBe('BACKREFERENCE');
  });

  it('rejects oversized finite repetition counts', () => {
    expect(vetPattern('(a{5000})').code).toBe('REPETITION_TOO_LARGE');
    expect(vetPattern('(a{1,5000})').code).toBe('REPETITION_TOO_LARGE');
  });

  it('allows an open-ended {n,}, which costs exactly what + costs', () => {
    // Rejecting these while allowing + was an inconsistency that threw out
    // ordinary patterns like a TLD matcher. Exponential blowup comes from
    // nesting, not from a single unbounded quantifier.
    expect(vetPattern('([A-Za-z]{2,})').safe).toBe(true);
    expect(vetPattern('(\\w{3,})').safe).toBe(true);
    expect(vetPattern('([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})').safe).toBe(true);
  });

  it('still catches an open-ended repetition that is nested', () => {
    expect(vetPattern('([a-z]{2,})+').code).toBe('NESTED_QUANTIFIER');
  });

  it('rejects patterns that are too long', () => {
    expect(vetPattern('(' + 'a'.repeat(400) + ')').code).toBe('TOO_LONG');
  });

  it('rejects invalid regular expressions', () => {
    expect(vetPattern('(unclosed').safe).toBe(false);
  });

  it('rejects the wrong number of capture groups', () => {
    expect(vetPattern('\\d+').code).toBe('CAPTURE_GROUP_COUNT');
    expect(vetPattern('(\\d+)x(\\d+)').code).toBe('CAPTURE_GROUP_COUNT');
  });

  it('rejects an empty pattern', () => {
    expect(vetPattern('').code).toBe('EMPTY');
  });
});

describe('vetPattern — the rejected patterns really are slow', () => {
  // Guards against the checker being loosened later without anyone noticing
  // what it was protecting against.
  it('demonstrates that (a+)+$ backtracks catastrophically', () => {
    const evil = /^(a+)+$/;
    // Deliberately modest: 22 characters already costs ~0.2s, and each extra
    // character doubles it. A real subject line would hang the app outright.
    const input = 'a'.repeat(22) + 'b'; // never matches; forces full backtrack

    const started = Date.now();
    evil.test(input);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(50);
    expect(vetPattern('(a+)+$').safe).toBe(false);
  });
});
