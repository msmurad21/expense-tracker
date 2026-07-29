#!/usr/bin/env tsx
/**
 * `npm run doctor` — preflight and diagnosis.
 *
 * Two audiences, one command:
 *  - A human runs it and gets plain-language problems with plain-language fixes.
 *  - Claude Code runs `npm run doctor -- --json` and gets a machine-readable
 *    report it can act on.
 *
 * It deliberately reports NOTHING secret: no passwords, no tokens, no email
 * content, no merchant names. It is safe to paste the output into a chat or a
 * GitHub issue, which is exactly what people will do.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSqliteAvailable } from '../src/main/db/sqliteAdapter.js';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { getSchemaVersion, MIGRATIONS } from '../src/main/db/migrations.js';
import { resolveDatabasePath } from '../src/main/db/index.js';
import type { DoctorReport, DoctorProblem } from '../src/shared/types.js';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function checkNode(): { report: DoctorReport['node']; problem?: DoctorProblem } {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split('.').map(Number);

  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (ok) return { report: { version, ok: true } };

  return {
    report: { version, ok: false, note: `need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}` },
    problem: {
      severity: 'error',
      code: 'NODE_TOO_OLD',
      message: `Your Node.js is version ${version}, which is too old for this app.`,
      fix: `Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org (choose the "LTS" download), then run this again. The app needs it for its built-in database support.`,
    },
  };
}

function checkDependencies(): DoctorProblem | null {
  if (existsSync(join(projectRoot, 'node_modules'))) return null;
  return {
    severity: 'error',
    code: 'DEPS_MISSING',
    message: 'The app’s dependencies have not been installed yet.',
    fix: 'Run: npm install',
  };
}

function checkDatabase(): {
  report: DoctorReport['database'];
  problems: DoctorProblem[];
  stats: { accounts: number; lastSync: string | null; pendingTemplates: number };
} {
  const path = resolveDatabasePath();
  const problems: DoctorProblem[] = [];
  const stats = { accounts: 0, lastSync: null as string | null, pendingTemplates: 0 };

  if (!existsSync(path)) {
    // Not an error: a first run legitimately has no database yet.
    return {
      report: { path, exists: false, schemaVersion: null, ok: true },
      problems,
      stats,
    };
  }

  try {
    const db = openDatabase(path);
    try {
      const schemaVersion = getSchemaVersion(db);
      const latest = Math.max(...MIGRATIONS.map((m) => m.version));

      if (schemaVersion > latest) {
        problems.push({
          severity: 'error',
          code: 'DB_FROM_FUTURE',
          message:
            'Your data file was created by a newer version of this app than the one you have.',
          fix: 'Update the app (git pull && npm install). Do not delete your data file.',
        });
      }

      stats.accounts =
        db.prepare('SELECT COUNT(*) AS n FROM accounts').get<{ n: number }>()?.n ?? 0;
      stats.lastSync =
        db
          .prepare("SELECT value FROM settings WHERE key = 'last_sync_at'")
          .get<{ value: string }>()?.value ?? null;
      stats.pendingTemplates =
        db
          .prepare("SELECT COUNT(*) AS n FROM parse_templates WHERE status = 'pending'")
          .get<{ n: number }>()?.n ?? 0;

      return {
        report: { path, exists: true, schemaVersion, ok: schemaVersion <= latest },
        problems,
        stats,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    problems.push({
      severity: 'error',
      code: 'DB_UNREADABLE',
      message: 'Your data file exists but could not be opened.',
      fix: `It may be corrupted. Rename it and let the app rebuild by re-syncing:\n    mv "${path}" "${path}.broken"\n  Details: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { report: { path, exists: true, schemaVersion: null, ok: false }, problems, stats };
  }
}

/**
 * The keychain check only means something inside Electron, where `safeStorage`
 * exists. Run from plain Node it reports "unknown" rather than guessing — a
 * false reassurance about credential encryption would be worse than no answer.
 */
function checkKeychain(): { report: DoctorReport['keychain']; problem?: DoctorProblem } {
  return {
    report: {
      backend: null,
      secure: false,
      note: 'Not checked — run this from inside the app to verify credential encryption.',
    },
  };
}

function buildReport(): DoctorReport {
  const problems: DoctorProblem[] = [];

  const node = checkNode();
  if (node.problem) problems.push(node.problem);

  const depsProblem = checkDependencies();
  if (depsProblem) problems.push(depsProblem);

  const sqlite = isSqliteAvailable();
  if (!sqlite.available) {
    problems.push({
      severity: 'error',
      code: 'SQLITE_UNAVAILABLE',
      message: 'This Node.js build does not provide the built-in database module.',
      fix: `Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer from https://nodejs.org and run this again.`,
    });
  }

  const database = checkDatabase();
  problems.push(...database.problems);

  const keychain = checkKeychain();
  if (keychain.problem) problems.push(keychain.problem);

  if (database.report.exists && database.stats.accounts === 0) {
    problems.push({
      severity: 'warning',
      code: 'NO_ACCOUNTS',
      message: 'No email account is connected yet, so there is nothing to read.',
      fix: 'Run: npm run setup',
    });
  }

  if (database.stats.pendingTemplates > 0) {
    problems.push({
      severity: 'warning',
      code: 'TEMPLATES_AWAITING_APPROVAL',
      message: `${database.stats.pendingTemplates} email format(s) are waiting for you to approve them.`,
      fix: 'Open the app and check the "Pending formats" tray. Nothing is parsed with a format you have not approved.',
    });
  }

  return {
    ok: problems.every((p) => p.severity !== 'error'),
    node: node.report,
    sqlite,
    database: database.report,
    keychain: keychain.report,
    accounts: database.stats.accounts,
    lastSync: database.stats.lastSync,
    pendingTemplates: database.stats.pendingTemplates,
    problems,
  };
}

function printHuman(report: DoctorReport): void {
  const tick = (ok: boolean) => (ok ? '✓' : '✗');

  console.log('\nExpense Tracker — setup check\n');
  console.log(`  ${tick(report.node.ok)} Node.js ${report.node.version}`);
  console.log(`  ${tick(report.sqlite.available)} Built-in database support`);
  console.log(
    `  ${tick(report.database.ok)} Data file ${
      report.database.exists ? `(schema v${report.database.schemaVersion})` : '(not created yet)'
    }`,
  );
  console.log(`  · Connected accounts: ${report.accounts}`);
  console.log(`  · Last sync: ${report.lastSync ?? 'never'}`);
  console.log(`  · Formats awaiting approval: ${report.pendingTemplates}`);

  if (report.problems.length === 0) {
    console.log('\nEverything looks good.\n');
    return;
  }

  console.log('');
  for (const p of report.problems) {
    const label = p.severity === 'error' ? 'PROBLEM' : 'NOTE';
    console.log(`  [${label}] ${p.message}`);
    console.log(`     How to fix: ${p.fix}\n`);
  }

  if (report.ok) {
    console.log('No blocking problems — the app should start.\n');
  } else {
    console.log('Fix the problems above, then run "npm run doctor" again.\n');
  }
}

const report = buildReport();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

// Non-zero exit lets CI and agents branch on the result without parsing text.
process.exit(report.ok ? 0 : 1);
