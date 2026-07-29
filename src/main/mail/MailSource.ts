import type { RawEmail, SyncCursor } from '../../shared/types.js';

/**
 * How the app reads mail.
 *
 * Two implementations ship, and which one a user can use is not a preference —
 * it is decided by facts about their Google account:
 *
 *  - `ImapSource` (Gmail App Password) is a two-minute setup, but Google
 *    disabled app passwords for Workspace accounts in 2025 and is phasing them
 *    out for personal accounts through 2026.
 *  - `GmailApiSource` (OAuth, bring-your-own Google Cloud project) survives
 *    that, but costs the user a ten-minute setup because gmail.readonly is a
 *    restricted scope — publishing a shared client would require an annual
 *    third-party security assessment.
 *
 * Neither is safe to depend on alone, hence the interface. It also means adding
 * Outlook later touches one file.
 */
export interface MailSource {
  readonly kind: 'imap' | 'gmail_api';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Yield messages newer than `cursor`, oldest first.
   *
   * Implementations must stream rather than buffer: a decade of bank alerts is
   * a lot of mail, and holding it all in memory to insert it once is both
   * slower to first result and a much worse failure mode.
   */
  fetchSince(cursor: SyncCursor, options?: FetchOptions): AsyncIterable<RawEmail>;
}

export interface FetchOptions {
  /** Stop after this many messages. Used by setup to sample cheaply. */
  limit?: number;
  /** Only consider mail newer than this. */
  since?: Date;
  /**
   * Restrict to senders worth reading. Scanning an entire personal inbox to
   * find bank alerts is wasteful and needlessly widens what the app touches.
   */
  senderDomains?: string[];
}

export class MailAuthError extends Error {
  constructor(
    message: string,
    /** Plain-language next step, shown directly to the user. */
    readonly fix: string,
  ) {
    super(message);
    this.name = 'MailAuthError';
  }
}

export class MailConnectionError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = 'MailConnectionError';
  }
}
