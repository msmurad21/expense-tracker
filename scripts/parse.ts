#!/usr/bin/env tsx
/**
 * `npm run parse` — turn synced emails into transactions.
 *
 *   npm run parse                parse anything not yet parsed
 *   npm run parse -- --all       re-parse everything from scratch
 *
 * The re-parse mode is why raw messages are kept separate from what was
 * extracted: when a template improves, the entire history can be re-derived
 * with no re-download and no gap.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';
import { resolveDatabasePath } from '../src/main/db/index.js';
import { pendingEmails, allEmails, unmatchedSenderSummary } from '../src/main/ingest/store.js';
import { parseEmails, reprocessAll, loadTemplates } from '../src/main/parsing/engine.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const reprocess = args.includes('--all');

const dbPath = args.includes('--demo') ? join(projectRoot, 'demo.db') : resolveDatabasePath();
if (!existsSync(dbPath)) {
  console.error(`\nNo database yet at ${dbPath}\nRun "npm run sync" first.\n`);
  process.exit(1);
}

const db = openDatabase(dbPath);
migrate(db);

const approved = loadTemplates(db);
if (approved.length === 0) {
  console.log('');
  console.log('  No approved templates, so nothing can be parsed yet.');
  console.log('');
  console.log('  Add the shipped ones and review them:');
  console.log('    npm run templates -- --seed');
  console.log('    npm run templates -- --preview <id>');
  console.log('');
  console.log('  For your bank, open this project in Claude Code and say:');
  console.log('    "add a parse template for <domain>"');
  console.log('');
  db.close();
  process.exit(0);
}

const emails = reprocess ? allEmails(db) : pendingEmails(db);

if (emails.length === 0) {
  console.log('\n  Nothing to parse. Run "npm run sync" to fetch new mail.\n');
  db.close();
  process.exit(0);
}

console.log(
  `\n  ${reprocess ? 'Re-parsing' : 'Parsing'} ${emails.length} message(s) against ${approved.length} approved template(s)…\n`,
);

const summary = reprocess ? reprocessAll(db, emails) : parseEmails(db, emails);

console.log(`  Parsed:     ${summary.parsed}`);
console.log(`  Unmatched:  ${summary.unmatched}  (no approved template is bound to that sender)`);
console.log(`  Failed:     ${summary.failed}  (a template matched but could not extract cleanly)`);
console.log('');
console.log(`  Wrote ${summary.transactionsWritten} transaction(s) and ${summary.receiptsWritten} receipt(s).`);
console.log('');

// Failures are worth surfacing individually — a template that nearly works is
// a much smaller fix than one that does not exist, but it looks identical in a
// count. Showing the reason is the difference.
const failures = summary.outcomes.filter((o) => o.status === 'failed');
if (failures.length > 0) {
  console.log('  Templates that matched but could not extract:');
  for (const failure of failures.slice(0, 10)) {
    for (const problem of failure.problems.slice(0, 2)) {
      console.log(`    email ${failure.emailId}: ${problem}`);
    }
  }
  if (failures.length > 10) console.log(`    …and ${failures.length - 10} more`);
  console.log('');
}

const unmatched = unmatchedSenderSummary(db);
if (unmatched.length > 0) {
  console.log('  Senders still without an approved template:');
  for (const row of unmatched.slice(0, 12)) {
    console.log(
      `    ${String(row.count).padStart(5)}  ${row.dkim_domain ?? '(unverified)'}  e.g. "${row.sample_subject}"`,
    );
  }
  console.log('');
  console.log('  Unverified senders are skipped by design — no template runs against mail');
  console.log('  that failed DKIM, because that is how a forged bank alert gets in.');
  console.log('');
}

if (summary.transactionsWritten > 0 || summary.receiptsWritten > 0) {
  console.log('  Next:  npm run analyze\n');
}

db.close();
