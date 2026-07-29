import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';
import type { Db } from '../src/main/db/Db.js';
import { insertEmail, pendingEmails, allEmails } from '../src/main/ingest/store.js';
import { parseEmails, reprocessAll, loadTemplates } from '../src/main/parsing/engine.js';
import { seedBuiltinTemplates } from '../src/main/parsing/builtinTemplates.js';
import { buildReport } from '../src/main/analytics/report.js';
import { hblTemplate, HBL_ALERT_BODY } from './fixtures/synthetic.js';
import type { RawEmail } from '../src/shared/types.js';

/**
 * End-to-end: an email arrives, a template is approved, a transaction appears,
 * and the analytics reflect it. This is the path a real user actually walks.
 */

let db: Db;

const email = (overrides: Partial<RawEmail> = {}): RawEmail => ({
  messageId: `<${Math.random().toString(36).slice(2)}@hbl.com>`,
  source: 'imap',
  fromAddress: 'alerts@hbl.com',
  fromDomain: 'hbl.com',
  dkimDomain: 'hbl.com',
  subject: 'Transaction Alert - HBL Debit Card',
  receivedAt: '2026-07-29T10:00:00.000Z',
  bodyText: HBL_ALERT_BODY,
  ...overrides,
});

function addTemplate(status: 'pending' | 'approved'): number {
  return db
    .prepare(
      `INSERT INTO parse_templates (name, sender_domain, subject_pattern, kind, rules_json,
                                    origin, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'builtin', ?, '2026-07-29T00:00:00Z')`,
    )
    .run(
      hblTemplate.name,
      hblTemplate.senderDomain,
      hblTemplate.subjectPattern,
      hblTemplate.kind,
      JSON.stringify(hblTemplate.rules),
      status,
    ).lastInsertRowid;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

afterEach(() => db.close());

describe('the full pipeline', () => {
  it('turns an email into a transaction once its template is approved', () => {
    insertEmail(db, email());
    addTemplate('approved');

    const summary = parseEmails(db, pendingEmails(db));

    expect(summary.parsed).toBe(1);
    expect(summary.transactionsWritten).toBe(1);

    const tx = db
      .prepare('SELECT amount_minor, currency, merchant_raw, card_last4, occurred_at FROM transactions')
      .get<{
        amount_minor: number;
        currency: string;
        merchant_raw: string;
        card_last4: string;
        occurred_at: string;
      }>();

    expect(tx?.amount_minor).toBe(432050); // exact minor units
    expect(tx?.currency).toBe('PKR');
    expect(tx?.merchant_raw).toBe('NETFLIX.COM');
    expect(tx?.card_last4).toBe('4821');
    expect(tx?.occurred_at).toBe('2026-07-29T09:35:00.000Z'); // 14:35 PKT
  });

  it('writes nothing while the template is still pending', () => {
    insertEmail(db, email());
    addTemplate('pending');

    const summary = parseEmails(db, pendingEmails(db));

    expect(summary.parsed).toBe(0);
    expect(summary.unmatched).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n).toBe(0);
  });

  it('writes nothing for an unsigned message, even with an approved template', () => {
    // The anti-spoofing property, end to end: a forged bank alert produces no
    // transaction, because no template is bound to mail that failed DKIM.
    insertEmail(db, email({ dkimDomain: null, fromDomain: 'hbl.com' }));
    addTemplate('approved');

    const summary = parseEmails(db, pendingEmails(db));

    expect(summary.unmatched).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n).toBe(0);
  });

  it('writes nothing for a lookalike domain', () => {
    insertEmail(db, email({ dkimDomain: 'hbl-alerts.example.net' }));
    addTemplate('approved');

    expect(parseEmails(db, pendingEmails(db)).unmatched).toBe(1);
  });

  it('records why a matching template failed to extract', () => {
    insertEmail(db, email({ bodyText: 'Your card was used somewhere. Amount: PKR 100.00' }));
    addTemplate('approved');

    const summary = parseEmails(db, pendingEmails(db));

    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]!.problems.join(' ')).toContain('missing');
  });

  it('increments hit_count so unused templates are visible', () => {
    insertEmail(db, email());
    const id = addTemplate('approved');

    parseEmails(db, pendingEmails(db));

    const row = db
      .prepare('SELECT hit_count FROM parse_templates WHERE id = ?')
      .get<{ hit_count: number }>(id);
    expect(row?.hit_count).toBe(1);
  });
});

describe('re-parsing', () => {
  it('re-derives the whole history without re-downloading anything', () => {
    // The reason emails are stored separately from what was extracted.
    insertEmail(db, email());
    insertEmail(db, email());

    // Nothing approved yet, so the first pass yields nothing.
    expect(parseEmails(db, pendingEmails(db)).parsed).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n).toBe(0);

    // The user approves a template later.
    addTemplate('approved');
    const summary = reprocessAll(db, allEmails(db));

    expect(summary.parsed).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n).toBe(2);
  });

  it('does not duplicate transactions when run twice', () => {
    insertEmail(db, email());
    addTemplate('approved');

    reprocessAll(db, allEmails(db));
    reprocessAll(db, allEmails(db));

    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n).toBe(1);
  });
});

describe('shipped templates', () => {
  it('all pass validation and are inserted as pending', () => {
    const result = seedBuiltinTemplates(db);

    expect(result.rejected).toEqual([]);
    expect(result.inserted).toBeGreaterThan(0);

    // None of them may run before a human approves it.
    expect(loadTemplates(db)).toHaveLength(0);

    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM parse_templates WHERE status = 'pending'")
      .get<{ n: number }>();
    expect(pending?.n).toBe(result.inserted);
  });

  it('is idempotent', () => {
    const first = seedBuiltinTemplates(db).inserted;
    const second = seedBuiltinTemplates(db);

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first);
  });
});

describe('analytics see what the parser wrote', () => {
  it('reports a subscription built from parsed emails', () => {
    addTemplate('approved');

    // Four monthly charges, each from its own email.
    for (const day of ['15/04/2026', '15/05/2026', '15/06/2026', '15/07/2026']) {
      insertEmail(
        db,
        email({
          messageId: `<${day}@hbl.com>`,
          bodyText: HBL_ALERT_BODY.replace('29/07/2026 14:35', `${day} 14:35`),
        }),
      );
    }

    parseEmails(db, pendingEmails(db));

    const report = buildReport(db, { homeCurrency: 'PKR', now: new Date('2026-07-20T00:00:00Z') });

    expect(report.subscriptions).toHaveLength(1);
    expect(report.subscriptions[0]!.merchantName).toBe('Netflix');
    expect(report.subscriptions[0]!.cadence).toEqual({ kind: 'monthly', n: 1 });
    expect(report.monthlyCommitmentMinor).toBe(432050);
  });
});
