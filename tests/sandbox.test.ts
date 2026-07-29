import { describe, it, expect } from 'vitest';
import { runPatternSandboxed, checkTemplatePatterns } from '../src/main/parsing/sandbox.js';

describe('runPatternSandboxed', () => {
  it('captures a match', async () => {
    const result = await runPatternSandboxed('Amount:\\s*PKR\\s*([\\d,.]+)', 'Amount: PKR 4,320.50');
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.capture).toBe('4,320.50');
  });

  it('reports a clean miss', async () => {
    const result = await runPatternSandboxed('Amount:\\s*([\\d]+)', 'nothing here');
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('reports an invalid pattern instead of throwing', async () => {
    const result = await runPatternSandboxed('(unclosed', 'text');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('runPatternSandboxed — the reason it exists', () => {
  it('kills a catastrophically backtracking pattern instead of hanging', async () => {
    // A regex is uninterruptible in JavaScript: no timer or AbortSignal can
    // stop exec() once it is backtracking. Terminating the thread is the only
    // way to bound it. Without this the app would freeze — and the process
    // that freezes also owns the database and the IPC channel.
    const evil = '(a+)+$';
    const input = 'a'.repeat(40) + 'b'; // would run for hours inline

    const result = await runPatternSandboxed(evil, input, { timeoutMs: 150 });

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // The whole point: bounded, not "eventually".
    expect(result.elapsedMs).toBeLessThan(2000);
  }, 10_000);

  it('a timeout is a rejection, not a no-match', async () => {
    const result = await runPatternSandboxed('(a+)+$', 'a'.repeat(40) + 'b', { timeoutMs: 120 });
    expect(result.ok).toBe(false);
    expect(result.matched).toBeUndefined();
  }, 10_000);
});

describe('checkTemplatePatterns', () => {
  it('returns what each rule would extract, for a human to judge', async () => {
    const body = 'Amount: PKR 4,320.50\nMerchant: NETFLIX.COM\ncard ending 4821';

    const checks = await checkTemplatePatterns(
      [
        { field: 'amount', pattern: 'Amount:\\s*PKR\\s*([\\d,.]+)' },
        { field: 'merchant', pattern: 'Merchant:\\s*(.+)' },
        { field: 'card_last4', pattern: 'ending\\s+(\\d{4})' },
        { field: 'absent', pattern: 'Reference:\\s*(\\w+)' },
      ],
      body,
    );

    expect(checks.map((c) => c.capture)).toEqual(['4,320.50', 'NETFLIX.COM', '4821', null]);
    expect(checks[3]!.matched).toBe(false);
    expect(checks.every((c) => !c.timedOut)).toBe(true);
  }, 15_000);
});
