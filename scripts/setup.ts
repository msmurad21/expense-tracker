#!/usr/bin/env tsx
/**
 * `npm run setup` — get connected, verified, and ready to sync.
 *
 * This is the command an agent runs on the user's behalf when they say "set
 * this up for me". It checks the environment, verifies the Gmail credentials
 * actually work, and reports exactly what to do next.
 *
 * It NEVER prints a credential, and never asks for one to be typed at it. The
 * App Password goes into `.env.local`, which the user edits themselves — so it
 * cannot end up in a chat transcript, a shell history, or a log.
 *
 *   npm run setup            human-readable
 *   npm run setup -- --json  machine-readable, for an agent to act on
 */
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapSource } from '../src/main/mail/ImapSource.js';
import { MailAuthError, MailConnectionError, MailTimeoutError } from '../src/main/mail/MailSource.js';
import { isSqliteAvailable } from '../src/main/db/sqliteAdapter.js';
import { initDatabase, resolveDatabasePath } from '../src/main/db/index.js';
import { seedBuiltinTemplates } from '../src/main/parsing/builtinTemplates.js';
import { loadTemplates } from '../src/main/parsing/engine.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const MIN_NODE = [22, 13] as const;

interface Step {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  /** Present when the step is not satisfied. Written for a non-technical reader. */
  fix?: string;
}

const steps: Step[] = [];
let blocked = false;

function record(step: Step): void {
  steps.push(step);
  if (!step.ok) blocked = true;
}

// ── 1. Node ────────────────────────────────────────────────────────────────
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  record({
    id: 'node',
    ok,
    title: 'Node.js',
    detail: `found ${process.versions.node}`,
    ...(ok
      ? {}
      : {
          fix: `This project needs Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer. Download the "LTS" build from https://nodejs.org, install it, then run this again.`,
        }),
  });
}

// ── 2. Built-in database support ───────────────────────────────────────────
{
  const sqlite = isSqliteAvailable();
  record({
    id: 'sqlite',
    ok: sqlite.available,
    title: 'Database support',
    detail: sqlite.available ? 'available' : (sqlite.note ?? 'unavailable'),
    ...(sqlite.available ? {} : { fix: 'Install a newer Node.js from https://nodejs.org.' }),
  });
}

// ── 3. Credentials file ────────────────────────────────────────────────────
const envPath = join(projectRoot, '.env.local');
{
  if (!existsSync(envPath)) {
    const examplePath = join(projectRoot, '.env.example');
    if (existsSync(examplePath)) copyFileSync(examplePath, envPath);

    record({
      id: 'env_file',
      ok: false,
      title: 'Credentials file',
      detail: 'created .env.local from the example — it still needs filling in',
      fix: [
        'Open the file .env.local in the project folder and fill in two lines:',
        '',
        '  GMAIL_USER=you@gmail.com',
        '  GMAIL_APP_PASSWORD=abcdefghijklmnop',
        '',
        'To get the App Password:',
        '  1. Turn on 2-Step Verification (App Passwords do not exist without it):',
        '     https://myaccount.google.com/signinoptions/two-step-verification',
        '  2. Create one here: https://myaccount.google.com/apppasswords',
        '  3. Google shows 16 characters in four groups. Remove the spaces.',
        '',
        'Type it straight into that file. Do not paste it into a chat.',
        '.env.local is gitignored and will never be committed.',
      ].join('\n'),
    });
  } else {
    record({ id: 'env_file', ok: true, title: 'Credentials file', detail: '.env.local exists' });
  }
}

// Load it without printing anything from it.
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* malformed; the next check reports it as missing values */
  }
}

const user = process.env['GMAIL_USER']?.trim();
const appPassword = process.env['GMAIL_APP_PASSWORD']?.replace(/\s+/g, '');

{
  const filled = Boolean(user && appPassword && !user.includes('you@gmail.com'));
  record({
    id: 'credentials',
    ok: filled,
    title: 'Gmail credentials',
    // Only ever the address, never any part of the password.
    detail: filled ? `set for ${user}` : 'not filled in yet',
    ...(filled
      ? {}
      : { fix: 'Fill in GMAIL_USER and GMAIL_APP_PASSWORD in .env.local (see the step above).' }),
  });

  // A Workspace address cannot use this route at all, and failing here with a
  // clear message beats an opaque authentication error later.
  if (filled && user && !/@gmail\.com$/i.test(user)) {
    record({
      id: 'account_type',
      ok: false,
      title: 'Account type',
      detail: `${user} is not an @gmail.com address`,
      fix: [
        'This looks like a Google Workspace account on a custom domain.',
        'Google disabled App Passwords for Workspace accounts in 2025, so this route',
        'will not work. The Gmail API route is needed instead, which is not yet built.',
        'See the "Workspace accounts" section of docs/SETUP.md.',
      ].join('\n'),
    });
  }
}

// ── 4. Live connection test ────────────────────────────────────────────────
let mailboxOk = false;
if (!blocked && user && appPassword) {
  // Bounded so a firewalled network reports a clear failure instead of hanging.
  const source = new ImapSource({ user, appPassword, timeoutMs: 20_000 });
  try {
    await source.connect();
    mailboxOk = true;
    record({ id: 'mailbox', ok: true, title: 'Gmail connection', detail: 'signed in successfully' });
  } catch (err) {
    if (
      err instanceof MailAuthError ||
      err instanceof MailConnectionError ||
      err instanceof MailTimeoutError
    ) {
      record({
        id: 'mailbox',
        ok: false,
        title: 'Gmail connection',
        detail: err.message,
        fix: err.fix,
      });
    } else {
      record({
        id: 'mailbox',
        ok: false,
        title: 'Gmail connection',
        detail: err instanceof Error ? err.message : String(err),
        fix: 'Unexpected failure. Check your internet connection and try again.',
      });
    }
  } finally {
    await source.disconnect();
  }
}

// ── 5. Database and shipped formats ────────────────────────────────────────
let approvedTemplates = 0;
let pendingTemplates = 0;
if (mailboxOk) {
  const db = initDatabase();
  try {
    const seeded = seedBuiltinTemplates(db);
    approvedTemplates = loadTemplates(db).length;
    pendingTemplates =
      db
        .prepare("SELECT COUNT(*) AS n FROM parse_templates WHERE status = 'pending'")
        .get<{ n: number }>()?.n ?? 0;

    record({
      id: 'templates',
      ok: true,
      title: 'Email formats',
      detail: `${seeded.inserted} added, ${approvedTemplates} approved, ${pendingTemplates} awaiting your approval`,
    });
  } finally {
    db.close();
  }
}

// ── Output ─────────────────────────────────────────────────────────────────

const nextSteps: string[] = [];
if (blocked) {
  nextSteps.push('Fix the problem(s) above, then run: npm run setup');
} else {
  nextSteps.push('npm run sync -- --discover    see who sends you money mail (writes nothing)');
  nextSteps.push('npm run sync                  read your mail into the local database');
  if (approvedTemplates === 0) {
    nextSteps.push('npm run templates             review the formats — nothing parses until you approve one');
  }
  nextSteps.push('npm run parse                 turn the mail into transactions');
  nextSteps.push('npm run analyze               see what you are paying for');
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: !blocked,
        databasePath: resolveDatabasePath(),
        mailboxVerified: mailboxOk,
        approvedTemplates,
        pendingTemplates,
        steps,
        nextSteps,
      },
      null,
      2,
    ),
  );
} else {
  console.log('\nExpense Tracker — setup\n');
  for (const step of steps) {
    console.log(`  ${step.ok ? '✓' : '✗'} ${step.title}: ${step.detail}`);
  }
  console.log('');

  for (const step of steps.filter((s) => !s.ok)) {
    console.log(`  ── ${step.title} ──`);
    console.log(
      (step.fix ?? '')
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    console.log('');
  }

  if (!blocked) {
    console.log('  Everything checks out. Next:\n');
    for (const line of nextSteps) console.log(`    ${line}`);
    console.log('');
    console.log(`  Your data will live in ${resolveDatabasePath()}`);
    console.log('');
    if (pendingTemplates > 0) {
      console.log(
        `  Note: ${pendingTemplates} shipped format(s) are pending. They parse nothing until you`,
      );
      console.log('  preview one against your own mail and approve it. That is deliberate.');
      console.log('');
    }
  }
}

process.exit(blocked ? 1 : 0);
