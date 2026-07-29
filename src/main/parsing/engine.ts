import type { Db } from '../db/Db.js';
import { validateTemplate, type ValidatedTemplate } from './templateSchema.js';
import { evaluateTemplate, templateAppliesTo, type EmailDocument } from './evaluator.js';
import { DEFAULT_DATE_OPTIONS, type DateParseOptions } from './dates.js';
import type { StoredEmail } from '../ingest/store.js';

/**
 * Turns stored emails into transactions and receipts.
 *
 * The pipeline is: match an email against the APPROVED templates bound to its
 * DKIM-verified domain, evaluate, write the result. Anything unmatched is left
 * as `unmatched` rather than guessed at, and shows up in the "senders with no
 * template" list so it can be taught rather than silently dropped.
 */

export interface StoredTemplate extends ValidatedTemplate {
  id: number;
}

interface TemplateRow {
  id: number;
  name: string;
  sender_domain: string;
  subject_pattern: string | null;
  kind: string;
  rules_json: string;
  origin: string;
  status: string;
}

/**
 * Load templates from the database, discarding any that no longer validate.
 *
 * Re-validating on load rather than trusting what is stored matters: the vetting
 * rules can tighten in a later version, and a pattern that was acceptable when
 * it was saved must not keep running just because it is already in the table.
 */
export function loadTemplates(db: Db, includeUnapproved = false): StoredTemplate[] {
  const rows = db
    .prepare(
      `SELECT id, name, sender_domain, subject_pattern, kind, rules_json, origin, status
       FROM parse_templates
       ${includeUnapproved ? '' : "WHERE status = 'approved'"}
       ORDER BY hit_count DESC`,
    )
    .all<TemplateRow>();

  const loaded: StoredTemplate[] = [];

  for (const row of rows) {
    let rules: unknown;
    try {
      rules = JSON.parse(row.rules_json);
    } catch {
      continue; // corrupt row; ignore rather than crash the whole sync
    }

    const result = validateTemplate({
      name: row.name,
      senderDomain: row.sender_domain,
      subjectPattern: row.subject_pattern,
      kind: row.kind,
      rules,
      origin: row.origin,
      status: row.status,
    });

    if (result.ok && result.template) {
      loaded.push({ ...result.template, id: row.id });
    }
  }

  return loaded;
}

export interface ParseOutcome {
  emailId: number;
  status: 'parsed' | 'unmatched' | 'failed';
  templateId: number | null;
  /** Populated on failure so the reason is visible rather than swallowed. */
  problems: string[];
}

export interface ParseRunSummary {
  parsed: number;
  unmatched: number;
  failed: number;
  transactionsWritten: number;
  receiptsWritten: number;
  outcomes: ParseOutcome[];
}

function toDocument(email: StoredEmail): EmailDocument {
  return {
    subject: email.subject ?? '',
    bodyText: email.body_text ?? '',
    dkimDomain: email.dkim_domain,
    fromDomain: email.from_domain,
  };
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Parse one email and write whatever it yields.
 *
 * Returns without writing anything if no approved template applies — a missing
 * template is a gap to fill, never a reason to invent a transaction.
 */
export function parseEmail(
  db: Db,
  email: StoredEmail,
  templates: StoredTemplate[],
  dateOptions: DateParseOptions = DEFAULT_DATE_OPTIONS,
): { outcome: ParseOutcome; wroteTransaction: boolean; wroteReceipt: boolean } {
  const doc = toDocument(email);
  const candidates = templates.filter((t) => templateAppliesTo(t, doc));

  if (candidates.length === 0) {
    return {
      outcome: { emailId: email.id, status: 'unmatched', templateId: null, problems: [] },
      wroteTransaction: false,
      wroteReceipt: false,
    };
  }

  // Try each candidate; the first clean extraction wins. Collect the failures so
  // a near-miss template is diagnosable instead of just "unmatched".
  const problems: string[] = [];

  for (const template of candidates) {
    const result = evaluateTemplate(template, doc, dateOptions);

    if (!result.ok) {
      problems.push(
        `${template.name}: ${[...result.missing.map((f) => `missing ${f}`), ...result.errors].join(', ')}`,
      );
      continue;
    }

    const now = new Date().toISOString();
    let wroteTransaction = false;
    let wroteReceipt = false;

    db.transaction(() => {
      if (template.kind === 'bank_alert') {
        db.prepare(
          `INSERT INTO transactions (email_id, amount_minor, currency, direction, kind,
                                     occurred_at, tz_source, merchant_raw, card_last4,
                                     confidence, created_at)
           VALUES (?, ?, ?, 'debit', ?, ?, ?, ?, ?, 1.0, ?)`,
        ).run(
          email.id,
          asNumber(result.fields['amount']) ?? 0,
          asString(result.fields['currency']) ?? 'PKR',
          asString(result.fields['transaction_kind']) ?? 'purchase',
          asString(result.fields['occurred_at']) ?? email.received_at,
          asString(result.fields['occurred_at_tz_source']),
          asString(result.fields['merchant']) ?? '(unknown)',
          asString(result.fields['card_last4']),
          now,
        );
        wroteTransaction = true;
      } else {
        db.prepare(
          `INSERT INTO receipts (email_id, plan_name, owning_account, amount_minor, currency,
                                 period_start, period_end, next_renewal_at, event_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          email.id,
          asString(result.fields['plan_name']),
          asString(result.fields['owning_account']),
          asNumber(result.fields['amount']),
          asString(result.fields['currency']),
          asString(result.fields['period_start']),
          asString(result.fields['period_end']),
          asString(result.fields['next_renewal_at']),
          asString(result.fields['event_kind']) ?? 'charge',
          now,
        );
        wroteReceipt = true;
      }

      db.prepare(
        "UPDATE emails SET parse_status = 'parsed', kind = ?, template_id = ? WHERE id = ?",
      ).run(template.kind, template.id, email.id);

      db.prepare(
        'UPDATE parse_templates SET hit_count = hit_count + 1, last_used_at = ? WHERE id = ?',
      ).run(now, template.id);
    });

    return {
      outcome: { emailId: email.id, status: 'parsed', templateId: template.id, problems: [] },
      wroteTransaction,
      wroteReceipt,
    };
  }

  db.prepare("UPDATE emails SET parse_status = 'failed' WHERE id = ?").run(email.id);

  return {
    outcome: { emailId: email.id, status: 'failed', templateId: null, problems },
    wroteTransaction: false,
    wroteReceipt: false,
  };
}

/** Parse a batch of emails. */
export function parseEmails(
  db: Db,
  emails: StoredEmail[],
  dateOptions: DateParseOptions = DEFAULT_DATE_OPTIONS,
): ParseRunSummary {
  const templates = loadTemplates(db);

  const summary: ParseRunSummary = {
    parsed: 0,
    unmatched: 0,
    failed: 0,
    transactionsWritten: 0,
    receiptsWritten: 0,
    outcomes: [],
  };

  for (const email of emails) {
    const { outcome, wroteTransaction, wroteReceipt } = parseEmail(db, email, templates, dateOptions);

    summary.outcomes.push(outcome);
    if (outcome.status === 'parsed') summary.parsed++;
    else if (outcome.status === 'unmatched') summary.unmatched++;
    else summary.failed++;

    if (wroteTransaction) summary.transactionsWritten++;
    if (wroteReceipt) summary.receiptsWritten++;
  }

  return summary;
}

/**
 * Discard everything derived from emails and parse again from scratch.
 *
 * This is why the raw messages are kept separate from what was extracted: when
 * a template improves, the whole history can be re-derived with no re-download
 * and no gap. User corrections live in `user_overrides` and are untouched here,
 * so a reprocess never silently discards a manual fix.
 */
export function reprocessAll(db: Db, emails: StoredEmail[]): ParseRunSummary {
  db.transaction(() => {
    db.exec('DELETE FROM transactions');
    db.exec('DELETE FROM receipts');
    db.exec("UPDATE emails SET parse_status = 'pending', template_id = NULL");
  });

  return parseEmails(db, emails);
}
