/**
 * Vetting for regex patterns that arrive from outside the codebase.
 *
 * ── Threat model ───────────────────────────────────────────────────────────
 * Anyone on the internet can send mail to the user's inbox while spoofing a
 * bank's From header. When the parser meets an unknown format it may ask an LLM
 * to propose an extraction template — so the content of an attacker-controlled
 * email can influence a pattern we are about to store and run against every
 * future message. Two consequences we have to design out:
 *
 *   1. Catastrophic backtracking. `(a+)+$` against a crafted subject hangs the
 *      process. In this app that process also owns the database and the IPC
 *      channel, so a hang is a full application freeze.
 *   2. Semantic hijacking. An over-broad pattern silently misattributes real
 *      transactions or fabricates ones that never happened.
 *
 * This module addresses (1) structurally, before a pattern is ever stored.
 * Execution timeouts (see runner.ts) are the second layer, and human approval
 * of every non-builtin template is the third. Defence in depth: none of the
 * three is trusted on its own.
 *
 * The checker is deliberately CONSERVATIVE. It rejects anything it cannot prove
 * safe rather than trying to be clever. A rejected template costs a human one
 * click to rewrite; an accepted malicious one costs a frozen app.
 */

export interface RegexVerdict {
  safe: boolean;
  /** Machine-readable reason, e.g. 'NESTED_QUANTIFIER'. */
  code?: string;
  /** Explanation suitable for showing in the approval tray. */
  reason?: string;
}

/** Patterns longer than this are rejected outright — real ones are far shorter. */
const MAX_PATTERN_LENGTH = 300;

/** A bounded repetition larger than this is treated as effectively unbounded. */
const MAX_REPETITION = 100;

/**
 * Walk the pattern and decide whether any quantified group itself contains an
 * unbounded quantifier — the `(x+)+` / `(x*)*` / `(x+)*` shape that produces
 * exponential backtracking.
 *
 * This is a structural scan, not a full regex parser. It tracks group nesting,
 * notes which groups contain an unbounded quantifier, and flags the case where
 * such a group is then quantified itself.
 */
function hasNestedQuantifier(pattern: string): boolean {
  // Stack entry per open group: does it contain an unbounded quantifier?
  const stack: { containsUnbounded: boolean }[] = [];
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    // A backslash escapes the next character; neither can be structural.
    if (ch === '\\') {
      i++;
      continue;
    }

    // Inside [...] the quantifier characters are literals.
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }

    if (ch === '(') {
      stack.push({ containsUnbounded: false });
      continue;
    }

    if (ch === ')') {
      const group = stack.pop();
      if (!group) continue; // unbalanced; the RegExp constructor will reject it

      // Look at what immediately follows the closing paren.
      const next = pattern[i + 1];
      const quantified =
        next === '*' || next === '+' || next === '{' || (next === '?' && pattern[i + 2] === '?');

      if (quantified && group.containsUnbounded) {
        return true;
      }

      // A quantified group's unboundedness propagates to its parent, so that
      // ((a+)+)+ is caught at every level.
      if (quantified && stack.length > 0) {
        stack[stack.length - 1]!.containsUnbounded = true;
      }
      continue;
    }

    if (ch === '*' || ch === '+') {
      if (stack.length > 0) {
        stack[stack.length - 1]!.containsUnbounded = true;
      }
      continue;
    }

    // {n,} and {n,m} with a large or absent upper bound behave like * for
    // backtracking purposes.
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) continue;
      const body = pattern.slice(i + 1, close);
      const match = /^(\d+)(,(\d*))?$/.exec(body);
      if (match) {
        const upper = match[3];
        const openEnded = match[2] !== undefined && (upper === '' || Number(upper) > MAX_REPETITION);
        if (openEnded && stack.length > 0) {
          stack[stack.length - 1]!.containsUnbounded = true;
        }
      }
      i = close;
      continue;
    }
  }

  return false;
}

/** Count capture groups, ignoring `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`. */
export function countCaptureGroups(pattern: string): number {
  let count = 0;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      // `(?<name>` is a named capture and does count; other `(?` forms do not.
      if (pattern[i + 1] === '?') {
        const isNamedCapture = pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!';
        if (isNamedCapture) count++;
      } else {
        count++;
      }
    }
  }
  return count;
}

/**
 * Decide whether `pattern` may be stored and executed.
 *
 * Callers must treat a `safe: false` verdict as fatal for that template — there
 * is no "run it anyway" path.
 */
export function vetPattern(pattern: string): RegexVerdict {
  if (pattern.length === 0) {
    return { safe: false, code: 'EMPTY', reason: 'The pattern is empty.' };
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      safe: false,
      code: 'TOO_LONG',
      reason: `Pattern is ${pattern.length} characters; the limit is ${MAX_PATTERN_LENGTH}. Legitimate extraction patterns are far shorter.`,
    };
  }

  // Backreferences turn matching into a backtracking search and have no
  // legitimate use when pulling a field out of a bank email.
  if (/\\[1-9]/.test(pattern.replace(/\\\\/g, ''))) {
    return {
      safe: false,
      code: 'BACKREFERENCE',
      reason: 'Backreferences (\\1, \\2, …) are not allowed — they enable catastrophic backtracking.',
    };
  }

  if (hasNestedQuantifier(pattern)) {
    return {
      safe: false,
      code: 'NESTED_QUANTIFIER',
      reason:
        'A repeated group contains another unbounded repetition (the (a+)+ shape). This can hang the app on a crafted email.',
    };
  }

  // A single explosive repetition like a{5000} is cheap to reject and has no
  // legitimate use here.
  //
  // The comma is captured separately so that an exact count is not mistaken for
  // an open-ended one: `{2}` bounds at 2, whereas `{2,}` is unbounded. Reading
  // `\d{2}` as unbounded would reject almost every real currency pattern.
  const bigRepetition = /\{\s*(\d+)\s*(,)?\s*(\d*)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = bigRepetition.exec(pattern)) !== null) {
    const lower = Number(m[1]);
    const hasComma = m[2] !== undefined;
    const upperText = m[3] ?? '';
    const upper = !hasComma ? lower : upperText === '' ? Infinity : Number(upperText);

    if (lower > MAX_REPETITION || upper > MAX_REPETITION) {
      return {
        safe: false,
        code: 'REPETITION_TOO_LARGE',
        reason: `Repetition count exceeds ${MAX_REPETITION}.`,
      };
    }
  }

  // Must actually compile. Also rejects unbalanced groups and bad escapes.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    return {
      safe: false,
      code: 'INVALID',
      reason: `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const groups = countCaptureGroups(pattern);
  if (groups !== 1) {
    return {
      safe: false,
      code: 'CAPTURE_GROUP_COUNT',
      reason: `A field pattern must have exactly one capture group; this one has ${groups}.`,
    };
  }

  return { safe: true };
}
