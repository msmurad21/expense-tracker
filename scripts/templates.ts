#!/usr/bin/env tsx
/**
 * `npm run templates` — see, preview and approve email formats.
 *
 * Nothing parses your mail until you approve the template for it, so this is
 * where that decision gets made. The preview runs each rule against a real
 * message from your own mailbox, in a sandboxed worker, and shows the values it
 * would extract — so the judgement is on the output, not on whether some
 * regular expressions look reasonable.
 *
 *   npm run templates                  list everything
 *   npm run templates -- --seed        add the shipped templates (as pending)
 *   npm run templates -- --preview 3   show what template 3 would extract
 *   npm run templates -- --approve 3   allow it to run
 *   npm run templates -- --reject 3    stop offering it
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';
import { resolveDatabasePath } from '../src/main/db/index.js';
import { seedBuiltinTemplates } from '../src/main/parsing/builtinTemplates.js';
import { checkTemplatePatterns } from '../src/main/parsing/sandbox.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(`--${flag}`);
const valueOf = (flag: string): string | undefined => {
  const i = args.indexOf(`--${flag}`);
  return i === -1 ? undefined : args[i + 1];
};

const dbPath = has('demo') ? join(projectRoot, 'demo.db') : resolveDatabasePath();
if (!existsSync(dbPath)) {
  console.error(`\nNo database yet at ${dbPath}\nRun "npm run sync" first.\n`);
  process.exit(1);
}

const db = openDatabase(dbPath);
migrate(db);

interface Row {
  id: number;
  name: string;
  sender_domain: string;
  kind: string;
  origin: string;
  status: string;
  hit_count: number;
  rules_json: string;
}

function list(): void {
  const rows = db
    .prepare(
      `SELECT id, name, sender_domain, kind, origin, status, hit_count, rules_json
       FROM parse_templates ORDER BY status, sender_domain`,
    )
    .all<Row>();

  if (rows.length === 0) {
    console.log('\nNo templates yet. Add the shipped ones with:  npm run templates -- --seed\n');
    return;
  }

  console.log('');
  console.log(`  ${'ID'.padEnd(4)} ${'STATUS'.padEnd(9)} ${'DOMAIN'.padEnd(22)} ${'KIND'.padEnd(11)} ${'ORIGIN'.padEnd(8)} HITS  NAME`);
  for (const r of rows) {
    console.log(
      `  ${String(r.id).padEnd(4)} ${r.status.padEnd(9)} ${r.sender_domain.padEnd(22)} ${r.kind.padEnd(
        11,
      )} ${r.origin.padEnd(8)} ${String(r.hit_count).padStart(4)}  ${r.name}`,
    );
  }

  const pending = rows.filter((r) => r.status === 'pending').length;
  console.log('');
  if (pending > 0) {
    console.log(`  ${pending} template(s) are pending and will NOT parse anything yet.`);
    console.log('  Check one with:  npm run templates -- --preview <id>');
    console.log('');
  }
}

async function preview(id: number): Promise<void> {
  const row = db
    .prepare('SELECT id, name, sender_domain, kind, origin, status, hit_count, rules_json FROM parse_templates WHERE id = ?')
    .get<Row>(id);

  if (!row) {
    console.error(`\nNo template with id ${id}.\n`);
    process.exit(1);
  }

  // Find a message this template is actually bound to. Matching on the
  // DKIM-verified domain, not the From header — same rule the parser uses.
  const sample = db
    .prepare(
      `SELECT id, subject, body_text FROM emails
       WHERE dkim_domain = ? OR dkim_domain LIKE ?
       ORDER BY received_at DESC LIMIT 1`,
    )
    .get<{ id: number; subject: string; body_text: string }>(
      row.sender_domain,
      `%.${row.sender_domain}`,
    );

  console.log('');
  console.log(`  Template ${row.id}: ${row.name}`);
  console.log(`  Bound to DKIM-verified domain: ${row.sender_domain}`);
  console.log(`  Status: ${row.status}`);
  console.log('');

  if (!sample) {
    console.log(`  No message from ${row.sender_domain} in your mailbox yet, so there is`);
    console.log('  nothing to preview it against. Run "npm run sync" first.');
    console.log('');
    console.log('  Approving a template you have not seen work is not recommended.');
    console.log('');
    return;
  }

  console.log(`  Previewing against: "${sample.subject}"`);
  console.log('');

  const rules = JSON.parse(row.rules_json) as { field: string; pattern: string }[];
  const checks = await checkTemplatePatterns(rules, `${sample.subject}\n${sample.body_text ?? ''}`);

  for (const check of checks) {
    const status = check.timedOut ? 'TIMED OUT' : check.matched ? 'ok' : 'no match';
    const value = check.timedOut
      ? '(pattern too slow — this template must not be approved)'
      : check.matched
        ? check.capture
        : '—';
    console.log(`    ${check.field.padEnd(18)} ${status.padEnd(10)} ${value}`);
  }

  console.log('');
  const anyTimeout = checks.some((c) => c.timedOut);
  if (anyTimeout) {
    console.log('  One or more patterns exceeded the time limit. Reject this template.');
  } else {
    console.log('  If those values look right for that email:');
    console.log(`    npm run templates -- --approve ${row.id}`);
  }
  console.log('');
}

function setStatus(id: number, status: 'approved' | 'rejected'): void {
  const changed = db
    .prepare('UPDATE parse_templates SET status = ? WHERE id = ?')
    .run(status, id).changes;

  if (changed === 0) {
    console.error(`\nNo template with id ${id}.\n`);
    process.exit(1);
  }

  console.log(`\nTemplate ${id} is now ${status}.`);
  if (status === 'approved') {
    console.log('Run "npm run parse" to apply it to the mail you have already synced.\n');
  } else {
    console.log('');
  }
}

if (has('seed')) {
  const result = seedBuiltinTemplates(db);
  console.log(`\nAdded ${result.inserted} template(s); ${result.skipped} already present.`);

  if (result.rejected.length > 0) {
    console.log('\nRejected (these failed validation and were NOT added):');
    for (const r of result.rejected) {
      console.log(`  ${r.name}: ${r.problems.join('; ')}`);
    }
  }

  console.log('\nAll shipped templates start as PENDING and parse nothing until you approve');
  console.log('them — they were written from each provider\'s known format, not verified');
  console.log('against a real message here. Preview one against your own mail:');
  console.log('  npm run templates -- --preview <id>\n');
  list();
} else if (valueOf('preview')) {
  await preview(Number(valueOf('preview')));
} else if (valueOf('approve')) {
  setStatus(Number(valueOf('approve')), 'approved');
} else if (valueOf('reject')) {
  setStatus(Number(valueOf('reject')), 'rejected');
} else {
  list();
}

db.close();
