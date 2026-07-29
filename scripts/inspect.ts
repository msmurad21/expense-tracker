#!/usr/bin/env tsx
/**
 * `npm run inspect` — why is my dashboard empty?
 *
 * Walks the pipeline in order and reports where it stops, with counts. There
 * are several distinct reasons nothing appears and they look identical from the
 * dashboard, so guessing between them wastes time.
 *
 *   npm run inspect                    diagnose
 *   npm run inspect -- --domain sc.com show a REDACTED skeleton of one email,
 *                                      so a parse template can be written for it
 *
 * The redacted mode exists because writing a template requires knowing where
 * the amount, date and card digits sit in the message — but a real bank email
 * must never be pasted into a chat, a ticket or a commit. It replaces every
 * digit and address with a placeholder while keeping the structure, so what
 * comes out is shareable and still enough to build a parser from.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';
import { resolveDatabasePath } from '../src/main/db/index.js';
import { loadTemplates } from '../src/main/parsing/engine.js';
import { redactEmailBody, containsUnredactedData } from '../src/main/ingest/redact.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(`--${flag}`);
  return i === -1 ? undefined : args[i + 1];
};

const dbPath = args.includes('--demo') ? join(projectRoot, 'demo.db') : resolveDatabasePath();
if (!existsSync(dbPath)) {
  console.error(`\nNo database yet at ${dbPath}\nRun "npm run sync" first.\n`);
  process.exit(1);
}

const db = openDatabase(dbPath);
migrate(db);

const count = (sql: string, ...params: (string | number)[]): number =>
  db.prepare(sql).get<{ n: number }>(...params)?.n ?? 0;

// ── Redacted sample mode ───────────────────────────────────────────────────

const domain = valueOf('domain');
if (domain) {
  const rows = db
    .prepare(
      `SELECT id, subject, body_text, dkim_domain, from_domain, received_at, parse_status
       FROM emails
       WHERE dkim_domain = ? OR dkim_domain LIKE ? OR from_domain = ? OR from_domain LIKE ?
       ORDER BY received_at DESC
       LIMIT 3`,
    )
    .all<{
      id: number;
      subject: string;
      body_text: string;
      dkim_domain: string | null;
      from_domain: string;
      received_at: string;
      parse_status: string;
    }>(domain, `%.${domain}`, domain, `%.${domain}`);

  if (rows.length === 0) {
    console.error(`\nNo stored email from ${domain}.\n\nRun "npm run sync" first, or check the domain spelling.\n`);
    db.close();
    process.exit(1);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log(`REDACTED SAMPLE — ${domain}`);
  console.log('═'.repeat(72));
  console.log('');
  console.log('Every digit below has been replaced with #, and every address and link');
  console.log('with a placeholder. Amounts, card numbers and account numbers are GONE;');
  console.log('only the layout remains. Read it before sharing it anyway.');
  console.log('');

  // Group by subject shape: the distinct message types matter more than volume,
  // and a bank sends several unrelated ones from the same address.
  for (const row of rows) {
    console.log('─'.repeat(72));
    console.log(`Verified domain : ${row.dkim_domain ?? '(unverified — nothing can parse this)'}`);
    console.log(`From domain     : ${row.from_domain}`);
    console.log(`Parse status    : ${row.parse_status}`);
    console.log(`Subject         : ${redactEmailBody(row.subject ?? '')}`);
    console.log('─'.repeat(72));
    const body = redactEmailBody(row.body_text ?? '', { maxLength: 2500 });
    // Fail loudly rather than print something that slipped through.
    if (containsUnredactedData(body)) {
      console.error('  [refusing to display: redaction failed — please report this]');
    } else {
      console.log(body);
    }
    console.log('');
  }

  console.log('═'.repeat(72));
  console.log('Paste the block above and a parse template can be written from it.');
  console.log('═'.repeat(72));
  console.log('');
  db.close();
  process.exit(0);
}

// ── Diagnosis mode ─────────────────────────────────────────────────────────

const emails = count('SELECT COUNT(*) AS n FROM emails');
const verified = count('SELECT COUNT(*) AS n FROM emails WHERE dkim_domain IS NOT NULL');
const transactions = count('SELECT COUNT(*) AS n FROM transactions');
const receipts = count('SELECT COUNT(*) AS n FROM receipts');
const approved = loadTemplates(db).length;
const pending = count("SELECT COUNT(*) AS n FROM parse_templates WHERE status = 'pending'");

console.log('\nWhy the dashboard looks the way it does\n');
console.log(`  Emails stored            ${emails}`);
console.log(`  …with a verified sender  ${verified}`);
console.log(`  Approved email formats   ${approved}`);
console.log(`  Formats awaiting review  ${pending}`);
console.log(`  Transactions extracted   ${transactions}`);
console.log(`  Receipts extracted       ${receipts}`);
console.log('');

// Report the FIRST blocking cause only. Listing every downstream symptom of one
// upstream problem reads like six faults instead of one.
if (emails === 0) {
  console.log('  → Nothing has been synced yet.\n     Run: npm run sync\n');
} else if (verified === 0) {
  console.log('  → No message has a DKIM-verified sender, so nothing is allowed to parse.');
  console.log('     That is almost certainly a bug rather than a property of your mail.');
  console.log('     Run: npm run sync -- --discover   and report the breakdown it prints.\n');
} else if (approved === 0) {
  console.log('  → No email format is approved, so nothing is parsed. This is the gate');
  console.log('     working as intended, not a failure.\n');
  console.log('     Review what is available:  npm run templates');
  console.log('     Preview one against your own mail:  npm run templates -- --preview <id>\n');
} else if (transactions === 0 && receipts === 0) {
  console.log('  → Formats are approved but none of them matched your mail.\n');
} else {
  console.log('  → The pipeline is working. If the dashboard is still empty, the');
  console.log('     transactions found may not form any recurring pattern yet.\n');
}

// The most useful thing: which senders are stored, verified, and have no
// template. Those are precisely the ones worth writing a template for.
const gaps = db
  .prepare(
    `SELECT e.dkim_domain AS domain, COUNT(*) AS n
     FROM emails e
     WHERE e.dkim_domain IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM parse_templates t
         WHERE t.status = 'approved'
           AND (e.dkim_domain = t.sender_domain OR e.dkim_domain LIKE '%.' || t.sender_domain)
       )
     GROUP BY e.dkim_domain
     ORDER BY n DESC
     LIMIT 15`,
  )
  .all<{ domain: string; n: number }>();

if (gaps.length > 0) {
  console.log('  Verified senders with no approved format — the gap to close:\n');
  for (const gap of gaps) {
    console.log(`    ${String(gap.n).padStart(5)}  ${gap.domain}`);
  }
  console.log('');
  console.log('  To get a template written for one, run:');
  console.log(`    npm run inspect -- --domain ${gaps[0]!.domain}`);
  console.log('');
  console.log('  That prints a redacted skeleton of the email — every digit replaced,');
  console.log('  so it carries no amounts or account numbers — which is enough to build');
  console.log('  a parser from and safe to share.');
  console.log('');
}

db.close();
