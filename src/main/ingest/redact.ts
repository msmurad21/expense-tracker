/**
 * Reducing a real email to a shareable skeleton.
 *
 * Writing a parse template requires knowing where the amount, date and card
 * digits sit in a message. Getting that normally means looking at a real bank
 * email — which must never be pasted into a chat, an issue or a commit.
 *
 * This keeps the layout and destroys the content. "Amount: PKR 4,320.50"
 * becomes "Amount: PKR #,###.##", which is everything a parser author needs and
 * nothing an attacker could use.
 *
 * Deliberately blunt: every digit goes, regardless of what it meant. A subtler
 * redactor that tried to keep "the harmless numbers" would be one misjudgement
 * away from leaking an account number, and the shape alone is sufficient.
 */

export interface RedactionOptions {
  /** Truncate the result to this many characters. */
  maxLength?: number;
}

const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const URL = /https?:\/\/\S+/g;
/** Reference numbers, tracking ids, session tokens. */
const LONG_TOKEN = /\b[A-Za-z0-9]{16,}\b/g;

export function redactEmailBody(text: string, options: RedactionOptions = {}): string {
  if (typeof text !== 'string') return '';

  let out = text
    // Addresses and links first — before their digits turn into hashes and stop
    // matching the patterns that identify them.
    .replace(EMAIL, 'someone@example.com')
    .replace(URL, 'https://example.com/link')
    .replace(LONG_TOKEN, 'XXXXXXXXXXXXXXXX')
    // Then every digit, everywhere.
    .replace(/\d/g, '#')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (options.maxLength !== undefined && out.length > options.maxLength) {
    out = `${out.slice(0, options.maxLength)}\n…[truncated]`;
  }

  return out;
}

/** Values this module substitutes in. They must not trip the self-check. */
const PLACEHOLDERS = ['someone@example.com', 'https://example.com/link', 'XXXXXXXXXXXXXXXX'];

/**
 * True when `text` still contains something that looks like real data.
 *
 * A self-check run before anything redacted is displayed, so that a future
 * weakening of the redactor fails loudly instead of quietly emitting a card
 * number.
 *
 * Two things this has to get right, both of which it originally got wrong:
 *
 *  - The substituted placeholders are themselves shaped like the data being
 *    looked for. `someone@example.com` matches any address pattern, so it must
 *    be removed before the check rather than counted as a leak.
 *  - The pattern must NOT carry the `g` flag. `RegExp.test` on a global regex
 *    advances `lastIndex` and resumes from there on the next call, so repeated
 *    checks against the same module-level regex alternate between true and
 *    false regardless of input.
 */
export function containsUnredactedData(text: string): boolean {
  if (/\d/.test(text)) return true;

  let stripped = text;
  for (const placeholder of PLACEHOLDERS) stripped = stripped.split(placeholder).join('');

  return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(stripped);
}
