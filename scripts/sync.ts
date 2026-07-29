#!/usr/bin/env tsx
/**
 * `npm run sync` — read the inbox from the command line.
 *
 * This exists so the pipeline can be pointed at a real mailbox before the
 * desktop UI is finished, and so that diagnosing a parsing problem never
 * requires launching Electron.
 *
 * Credentials come from environment variables here, NOT from the OS keychain.
 * That is a deliberate difference from the app: the desktop build stores your
 * App Password with Electron safeStorage (macOS Keychain / Windows DPAPI),
 * whereas this script reads `.env.local`, which is gitignored. Convenient for
 * development, and stated plainly so nobody assumes otherwise.
 *
 * Modes:
 *   npm run sync -- --discover      Who sends you money mail? Reads nothing else.
 *   npm run sync -- --limit 200     Fetch a sample.
 *   npm run sync                    Fetch everything new since the last run.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapSource } from '../src/main/mail/ImapSource.js';
import { MailAuthError, MailConnectionError, MailTimeoutError } from '../src/main/mail/MailSource.js';
import { initDatabase, resolveDatabasePath } from '../src/main/db/index.js';
import {
  insertEmail,
  getCursor,
  setCursor,
  setSetting,
  unmatchedSenderSummary,
} from '../src/main/ingest/store.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Node 22 can load a dotenv file natively; no dependency needed.
for (const candidate of ['.env.local', '.env']) {
  const path = join(projectRoot, candidate);
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
      break;
    } catch {
      /* malformed file — fall through to the missing-credentials message */
    }
  }
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const user = process.env['GMAIL_USER'];
const appPassword = process.env['GMAIL_APP_PASSWORD']?.replace(/\s+/g, '');

if (!user || !appPassword) {
  console.error(
    [
      '',
      'Missing Gmail credentials.',
      '',
      'Create a file called .env.local in the project root containing:',
      '',
      '  GMAIL_USER=you@gmail.com',
      '  GMAIL_APP_PASSWORD=abcdefghijklmnop',
      '',
      'To get an App Password:',
      '  1. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification',
      '  2. Create an App Password:      https://myaccount.google.com/apppasswords',
      '  3. Paste the 16 characters with the spaces removed.',
      '',
      '.env.local is gitignored and must never be committed.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const limit = value('limit') ? Number(value('limit')) : undefined;
const sinceDays = value('since-days') ? Number(value('since-days')) : 365;
const since = new Date(Date.now() - sinceDays * 86_400_000);

const db = initDatabase();
console.log(`Database: ${resolveDatabasePath()}`);

const source = new ImapSource({ user, appPassword, timeoutMs: 30_000 });

try {
  console.log(`Connecting to Gmail as ${user} …`);
  await source.connect();
  console.log('Connected.\n');

  const cursor = getCursor(db, 'imap');
  if (cursor.value) {
    console.log(`Resuming from UID ${cursor.value} (last synced ${cursor.updatedAt}).`);
  } else {
    console.log(`First run — reading mail from the last ${sinceDays} days.`);
  }

  let inserted = 0;
  let duplicates = 0;
  let scanned = 0;
  let highestUid = cursor.value ? Number(cursor.value) : 0;
  const dkimDomains = new Map<string, number>();
  // Track WHY anything is unverified. A sender that does not sign is expected;
  // a signature that passed while we failed to read it is a bug, and the two
  // are indistinguishable from the outcome alone.
  const unverifiedReasons = new Map<string, number>();

  const fetchOptions: { limit?: number; since?: Date } = { since };
  if (limit !== undefined) fetchOptions.limit = limit;

  for await (const email of source.fetchSince(cursor, fetchOptions)) {
    scanned++;

    const uidMatch = /imap-uid-(\d+)/.exec(email.messageId);
    if (uidMatch) highestUid = Math.max(highestUid, Number(uidMatch[1]));

    const key = email.dkimDomain ?? `(unverified) ${email.fromDomain}`;
    dkimDomains.set(key, (dkimDomains.get(key) ?? 0) + 1);

    if (!email.dkimDomain) {
      const reason = email.dkimReason ?? 'unknown';
      unverifiedReasons.set(reason, (unverifiedReasons.get(reason) ?? 0) + 1);
    }

    if (!flag('discover')) {
      const id = insertEmail(db, email);
      if (id === null) duplicates++;
      else inserted++;
    }

    if (scanned % 100 === 0) process.stdout.write(`  …${scanned} messages\n`);
  }

  console.log(`\nScanned ${scanned} message(s).`);

  if (flag('discover')) {
    console.log('\nSenders seen (by DKIM-verified domain):\n');
    const rows = [...dkimDomains.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of rows.slice(0, 40)) {
      console.log(`  ${String(count).padStart(5)}  ${domain}`);
    }
    const verified = [...dkimDomains.keys()].filter((k) => !k.startsWith('(unverified)')).length;
    console.log(`\n${verified} verified sender domain(s), ${unverifiedReasons.size ? '' : 'no '}unverified mail.`);

    if (unverifiedReasons.size > 0) {
      console.log('\nWhy the unverified ones were skipped:\n');
      const explain: Record<string, string> = {
        no_auth_header: 'no Authentication-Results header (Gmail did not record a verdict)',
        dkim_none: 'sender did not sign the message',
        dkim_fail: 'signature present but failed verification',
        dkim_other: 'verification error (temperror/permerror)',
        pass_but_no_domain:
          'DKIM PASSED but the signing domain could not be read — this is a bug, please report it',
        unknown: 'not recorded',
      };
      for (const [reason, count] of [...unverifiedReasons.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(5)}  ${explain[reason] ?? reason}`);
      }

      if ((unverifiedReasons.get('pass_but_no_domain') ?? 0) > 0) {
        console.log(
          '\n  ⚠ Messages passed DKIM but their domain could not be extracted. That is a\n' +
            '    parsing bug, not a property of your mail. Please open an issue.',
        );
      }
    }

    console.log(
      [
        '',
        'No parse template ever runs against unverified mail, by design — that is',
        'what stops a forged bank alert from being believed.',
        '',
        'Nothing was written to the database in discover mode.',
        '',
      ].join('\n'),
    );
  } else {
    console.log(`Stored ${inserted} new, skipped ${duplicates} already present.`);

    if (highestUid > 0) setCursor(db, 'imap', String(highestUid));
    setSetting(db, 'last_sync_at', new Date().toISOString());

    const unmatched = unmatchedSenderSummary(db);
    if (unmatched.length > 0) {
      console.log('\nSenders with no approved template yet:\n');
      for (const row of unmatched.slice(0, 20)) {
        const verified = row.dkim_domain ?? '(unverified)';
        console.log(`  ${String(row.count).padStart(5)}  ${verified}  e.g. "${row.sample_subject}"`);
      }
      console.log(
        [
          '',
          'To teach the app one of these formats, open this project in Claude Code and say:',
          '  "add a parse template for <domain>"',
          '',
        ].join('\n'),
      );
    }
  }
} catch (err) {
  if (
    err instanceof MailAuthError ||
    err instanceof MailConnectionError ||
    err instanceof MailTimeoutError
  ) {
    console.error(`\n${err.message}\n\n${err.fix}\n`);
    process.exit(1);
  }
  throw err;
} finally {
  await source.disconnect();
  db.close();
}
