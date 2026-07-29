import type { Db } from '../db/Db.js';
import type { RawEmail, SyncCursor } from '../../shared/types.js';

/** Database writes for ingestion. Kept apart from the mail clients so both sources share it. */

export interface IngestResult {
  inserted: number;
  duplicates: number;
  highestUid: string | null;
}

const now = () => new Date().toISOString();

export function getCursor(db: Db, sourceKind: string): SyncCursor {
  const row = db
    .prepare('SELECT value, updated_at FROM settings WHERE key = ?')
    .get<{ value: string; updated_at: string }>(`cursor:${sourceKind}`);

  return { value: row?.value ?? null, updatedAt: row?.updated_at ?? null };
}

export function setCursor(db: Db, sourceKind: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`cursor:${sourceKind}`, value, now());
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

export function getSetting(db: Db, key: string): string | null {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get<{ value: string }>(key)?.value ?? null;
}

/**
 * Store one message.
 *
 * Returns false when the message was already present. Idempotency rests on the
 * UNIQUE constraint over `message_id` rather than on the sync cursor being
 * correct — so a lost, stale or reset cursor costs re-downloading, never
 * duplicated transactions.
 */
export function insertEmail(db: Db, email: RawEmail): number | null {
  const existing = db
    .prepare('SELECT id FROM emails WHERE message_id = ?')
    .get<{ id: number }>(email.messageId);
  if (existing) return null;

  const result = db
    .prepare(
      `INSERT INTO emails (message_id, source, from_addr, from_domain, dkim_domain,
                           subject, received_at, body_text, kind, parse_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 'pending', ?)`,
    )
    .run(
      email.messageId,
      email.source,
      email.fromAddress,
      email.fromDomain,
      email.dkimDomain,
      email.subject,
      email.receivedAt,
      email.bodyText,
      now(),
    );

  return result.lastInsertRowid;
}

export interface StoredEmail {
  id: number;
  subject: string;
  body_text: string;
  dkim_domain: string | null;
  from_domain: string;
  received_at: string;
  parse_status: string;
}

/** Messages that still need a parsing attempt. */
export function pendingEmails(db: Db, limit = 1000): StoredEmail[] {
  return db
    .prepare(
      `SELECT id, subject, body_text, dkim_domain, from_domain, received_at, parse_status
       FROM emails WHERE parse_status = 'pending' ORDER BY received_at ASC LIMIT ?`,
    )
    .all<StoredEmail>(limit);
}

/** All messages, for reprocessing after a parser improves. */
export function allEmails(db: Db, limit = 100_000): StoredEmail[] {
  return db
    .prepare(
      `SELECT id, subject, body_text, dkim_domain, from_domain, received_at, parse_status
       FROM emails ORDER BY received_at ASC LIMIT ?`,
    )
    .all<StoredEmail>(limit);
}

export function markEmailParsed(
  db: Db,
  emailId: number,
  status: 'parsed' | 'unmatched' | 'failed',
  kind: string,
  templateId: number | null,
): void {
  db.prepare('UPDATE emails SET parse_status = ?, kind = ?, template_id = ? WHERE id = ?').run(
    status,
    kind,
    templateId,
    emailId,
  );
}

/** Senders seen but not parseable — the shortlist for adding new templates. */
export function unmatchedSenderSummary(
  db: Db,
): { from_domain: string; dkim_domain: string | null; count: number; sample_subject: string }[] {
  return db
    .prepare(
      `SELECT from_domain, dkim_domain, COUNT(*) AS count, MIN(subject) AS sample_subject
       FROM emails
       WHERE parse_status IN ('pending', 'unmatched')
       GROUP BY from_domain, dkim_domain
       ORDER BY count DESC`,
    )
    .all<{ from_domain: string; dkim_domain: string | null; count: number; sample_subject: string }>();
}
