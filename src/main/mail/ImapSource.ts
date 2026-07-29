import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { RawEmail, SyncCursor } from '../../shared/types.js';
import {
  type MailSource,
  type FetchOptions,
  MailAuthError,
  MailConnectionError,
  MailTimeoutError,
  withTimeout,
} from './MailSource.js';

/**
 * Reads Gmail over IMAP using an App Password.
 *
 * Why an App Password rather than OAuth: it takes two minutes instead of ten
 * and needs no Google Cloud project. The costs are real and documented in
 * MailSource.ts — it grants full-mailbox access rather than read-only, it
 * requires 2-Step Verification, it does not work at all for Workspace
 * accounts, and Google is retiring it.
 */
export interface ImapCredentials {
  user: string;
  /** 16-character Gmail App Password. Never logged, never shown, never sent anywhere but Gmail. */
  appPassword: string;
  host?: string;
  port?: number;
  /**
   * Give up connecting after this long.
   *
   * Not optional in practice: on a network that blackholes port 993 — corporate
   * and university Wi-Fi commonly do — the TCP connect neither succeeds nor
   * fails, it simply hangs. Without a bound, `npm run setup` sits there forever
   * and looks broken rather than blocked, which is the worst possible outcome
   * for the one command a non-technical user is told to run first.
   */
  timeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

/**
 * Pull the DKIM-verified sender domain out of Gmail's own verification result.
 *
 * This is the piece that makes template binding trustworthy without us
 * implementing DKIM. Gmail verifies signatures on receipt and records the
 * outcome in an `Authentication-Results` header:
 *
 *   Authentication-Results: mx.google.com; dkim=pass header.d=hbl.com; spf=pass ...
 *
 * The domain is taken only when the corresponding `dkim=` verdict is `pass`. A
 * `fail`, `none` or absent header yields null, and null means no template will
 * ever run against the message.
 *
 * ── Both identifier forms must be read ─────────────────────────────────────
 * RFC 8601 allows the signing domain to be reported two ways, and Gmail uses
 * both:
 *
 *   dkim=pass header.d=netflix.com        the SDID — the signing domain
 *   dkim=pass header.i=@sc.com            the AUID — an identity within it
 *
 * In practice Gmail emits `header.i` far more often. Reading only `header.d`
 * therefore reports essentially every message as unverified, which silently
 * disables all parsing rather than failing loudly — a real inbox of 3768
 * messages produced zero verified senders, including Google's own mail.
 *
 * `header.i` is safe to use: the AUID is defined to be the signing domain or a
 * subdomain of it, so the domain after the `@` is still attributable to the
 * signer. `header.d` is preferred where both appear.
 *
 * Only the topmost Authentication-Results header is trusted: Gmail prepends its
 * own on delivery, while anything below it could have been written by the
 * sender.
 */
export function extractDkimDomain(rawHeaders: string): string | null {
  const lines = rawHeaders.split(/\r?\n(?![ \t])/); // unfold continuation lines

  for (const line of lines) {
    if (!/^authentication-results:/i.test(line)) continue;

    const unfolded = line.replace(/\r?\n[ \t]+/g, ' ');

    // Find each dkim=<verdict> and the identifier belonging to it. A message can
    // carry several signatures, so pair verdict with domain positionally rather
    // than grabbing the first identifier anywhere in the line.
    const dkimClause = /dkim=(\w+)([^;]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = dkimClause.exec(unfolded)) !== null) {
      if ((m[1] ?? '').toLowerCase() !== 'pass') continue;

      const clause = m[2] ?? '';

      const sdid = /header\.d=([A-Za-z0-9.-]+)/i.exec(clause);
      if (sdid?.[1]) return sdid[1].toLowerCase().replace(/\.$/, '');

      // header.i is "@domain" or "local@domain"; the domain follows the @.
      const auid = /header\.i=[^\s;@]*@([A-Za-z0-9.-]+)/i.exec(clause);
      if (auid?.[1]) return auid[1].toLowerCase().replace(/\.$/, '');
    }

    // Only the first (topmost) Authentication-Results header is Gmail's.
    return null;
  }

  return null;
}

/**
 * Why a message ended up unverified.
 *
 * Exists because "unverified" has several very different causes and they need
 * different responses: a genuinely unsigned sender is expected and fine, but a
 * signature that passed while we failed to read the domain is a bug in this
 * file. Without distinguishing them, a parsing bug looks exactly like a mailbox
 * full of unsigned senders — which is how reading only header.d went unnoticed.
 *
 * Reports no message content: only the verdict and, on success, the domain.
 */
export type DkimReason =
  | 'pass'
  | 'no_auth_header'
  | 'dkim_none'
  | 'dkim_fail'
  | 'dkim_other'
  | 'pass_but_no_domain';

export function diagnoseDkim(rawHeaders: string): { domain: string | null; reason: DkimReason } {
  const domain = extractDkimDomain(rawHeaders);
  if (domain) return { domain, reason: 'pass' };

  const lines = rawHeaders.split(/\r?\n(?![ \t])/);
  const header = lines.find((l) => /^authentication-results:/i.test(l));
  if (!header) return { domain: null, reason: 'no_auth_header' };

  const unfolded = header.replace(/\r?\n[ \t]+/g, ' ');
  const verdict = /dkim=(\w+)/i.exec(unfolded)?.[1]?.toLowerCase();

  if (verdict === 'pass') return { domain: null, reason: 'pass_but_no_domain' };
  if (verdict === 'none') return { domain: null, reason: 'dkim_none' };
  if (verdict === 'fail') return { domain: null, reason: 'dkim_fail' };
  return { domain: null, reason: verdict ? 'dkim_other' : 'no_auth_header' };
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase().replace(/[>\s]/g, '');
}

export class ImapSource implements MailSource {
  readonly kind = 'imap' as const;

  #client: ImapFlow | null = null;
  #credentials: ImapCredentials;

  constructor(credentials: ImapCredentials) {
    this.#credentials = credentials;
  }

  async connect(): Promise<void> {
    const client = new ImapFlow({
      host: this.#credentials.host ?? 'imap.gmail.com',
      port: this.#credentials.port ?? 993,
      secure: true,
      auth: {
        user: this.#credentials.user,
        pass: this.#credentials.appPassword,
      },
      // imapflow logs the full IMAP conversation at info level, which would put
      // mail content and credentials into stdout. Off, deliberately.
      logger: false,
    });

    const timeoutMs = this.#credentials.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    try {
      await withTimeout(client.connect(), timeoutMs, () => {
        // Tear the socket down explicitly; an abandoned promise would otherwise
        // keep the process alive after we have given up on it.
        void client.close();
      });
      this.#client = client;
    } catch (err) {
      if (err instanceof MailTimeoutError) throw err;

      const message = err instanceof Error ? err.message : String(err);

      if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
        throw new MailAuthError(
          'Gmail rejected the username or App Password.',
          [
            'Check three things, in this order:',
            '  1. 2-Step Verification must be ON for your Google account — App Passwords do not exist without it.',
            '  2. The App Password is 16 characters with no spaces. Google displays it in groups of 4; remove them.',
            '  3. If this is a Google Workspace account (a custom domain rather than @gmail.com), App Passwords were',
            '     disabled by Google in 2025. Use the Gmail API option instead.',
          ].join('\n'),
        );
      }

      throw new MailConnectionError(
        `Could not reach Gmail: ${message}`,
        'Check your internet connection. If you are on a corporate or university network, port 993 may be blocked.',
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.#client) {
      await this.#client.logout().catch(() => {
        /* already gone; nothing useful to do */
      });
      this.#client = null;
    }
  }

  async *fetchSince(cursor: SyncCursor, options: FetchOptions = {}): AsyncIterable<RawEmail> {
    const client = this.#client;
    if (!client) throw new MailConnectionError('Not connected.', 'Call connect() first.');

    const lock = await client.getMailboxLock('INBOX');
    try {
      // UID-based resume. Gmail UIDs increase monotonically within a mailbox,
      // so "everything above the last one we saw" is an exact, cheap resume
      // point — and combined with the UNIQUE message_id in the database, a
      // re-sync can never double-count even if the cursor is wrong.
      const lastUid = cursor.value ? Number(cursor.value) : 0;

      const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
      const searchCriteria: Record<string, unknown> = {};
      if (options.since) searchCriteria['since'] = options.since;

      let yielded = 0;

      for await (const message of client.fetch(
        lastUid > 0 ? range : searchCriteria,
        { uid: true, source: true, envelope: true },
        { uid: true },
      )) {
        if (options.limit !== undefined && yielded >= options.limit) break;
        if (!message.source) continue;

        // Gmail's UID wildcard range always returns at least one message even
        // when nothing is new; skip anything we have already passed.
        if (lastUid > 0 && message.uid <= lastUid) continue;

        const parsed = await simpleParser(message.source);

        const fromAddress = parsed.from?.value?.[0]?.address ?? '';
        const fromDomain = domainOf(fromAddress);

        if (
          options.senderDomains &&
          options.senderDomains.length > 0 &&
          !options.senderDomains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`))
        ) {
          continue;
        }

        const rawHeaders = message.source.toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
        const dkim = diagnoseDkim(rawHeaders);

        yield {
          // Fall back to the UID only if the message genuinely has no
          // Message-ID, which is rare and non-conforming.
          messageId: parsed.messageId ?? `imap-uid-${message.uid}`,
          source: 'imap',
          fromAddress,
          fromDomain,
          dkimDomain: dkim.domain,
          dkimReason: dkim.reason,
          subject: parsed.subject ?? '',
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          // Prefer the text part. Where only HTML exists, mailparser's derived
          // text is used — raw HTML is never stored or rendered, which avoids
          // both tracking pixels and an XSS vector fed by hostile input.
          bodyText: parsed.text ?? stripHtml(parsed.html || ''),
        };

        yielded++;
      }
    } finally {
      lock.release();
    }
  }
}

/** Last-resort HTML to text. mailparser normally supplies this for us. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
