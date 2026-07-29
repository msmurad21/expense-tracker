import { Worker } from 'node:worker_threads';

/**
 * Runs a candidate pattern against text with a hard wall-clock limit.
 *
 * This is the second of three layers. `safeRegex.vetPattern` rejects the known
 * catastrophic SHAPES before storage, and human approval is the third — but
 * static analysis of regular expressions cannot be complete, so a pattern that
 * slips through must still not be able to freeze the app.
 *
 * A regex in JavaScript is uninterruptible: no timer, promise or AbortSignal
 * can stop `RegExp.exec` once it starts backtracking. The only way to bound it
 * is to run it somewhere that can be destroyed, hence a worker thread that gets
 * terminated on expiry.
 *
 * Worth being precise about what is and is not evaluated as code here: the
 * worker's source below is a fixed string authored in this file. The pattern
 * and the text are passed as DATA over `workerData` and only ever reach
 * `new RegExp(...)`. Nothing from a template is ever executed.
 */

/** Long enough for any legitimate pattern, short enough to never look hung. */
const DEFAULT_TIMEOUT_MS = 250;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { pattern, flags, text } = workerData;
try {
  const re = new RegExp(pattern, flags);
  const match = re.exec(text);
  parentPort.postMessage({
    ok: true,
    matched: match !== null,
    capture: match ? (match[1] === undefined ? null : match[1]) : null,
  });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
}
`;

export interface SandboxResult {
  ok: boolean;
  matched?: boolean;
  capture?: string | null;
  /** True when the pattern was killed for exceeding the time limit. */
  timedOut?: boolean;
  error?: string;
  elapsedMs: number;
}

/**
 * Execute `pattern` against `text` in a disposable worker.
 *
 * A `timedOut` result must be treated as a hard rejection of the pattern, not
 * as "no match" — a pattern that cannot complete in a quarter of a second on
 * one message will not become acceptable on the next one.
 */
export function runPatternSandboxed(
  pattern: string,
  text: string,
  options: { flags?: string; timeoutMs?: number } = {},
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const flags = options.flags ?? 'i';
  const started = Date.now();

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags, text },
      // The worker needs no filesystem, network or environment access.
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      env: {},
    });

    const finish = (result: Omit<SandboxResult, 'elapsedMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...result, elapsedMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, error: `pattern exceeded ${timeoutMs}ms` });
    }, timeoutMs);

    worker.on('message', (message: { ok: boolean; matched?: boolean; capture?: string | null; error?: string }) => {
      finish(message);
    });

    worker.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    worker.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `worker exited with code ${code}` });
    });
  });
}

export interface PatternCheck {
  field: string;
  pattern: string;
  matched: boolean;
  capture: string | null;
  timedOut: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * Run every rule of a proposed template against a sample message.
 *
 * This is what the approval tray shows: the actual values a template would
 * extract from a real email, so a person can judge it on its output rather than
 * on whether its regular expressions look plausible.
 */
export async function checkTemplatePatterns(
  rules: { field: string; pattern: string }[],
  text: string,
  timeoutMs?: number,
): Promise<PatternCheck[]> {
  const checks: PatternCheck[] = [];

  for (const rule of rules) {
    const opts = timeoutMs === undefined ? {} : { timeoutMs };
    const result = await runPatternSandboxed(rule.pattern, text, opts);

    checks.push({
      field: rule.field,
      pattern: rule.pattern,
      matched: result.matched ?? false,
      capture: result.capture ?? null,
      timedOut: result.timedOut ?? false,
      elapsedMs: result.elapsedMs,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
  }

  return checks;
}
