#!/usr/bin/env tsx
/**
 * `npm run analyze` — what are you actually paying for?
 *
 * Prints a summary and writes a self-contained HTML dashboard.
 *
 *   npm run analyze              read your real database
 *   npm run analyze -- --demo    read the invented demo data instead
 *   npm run analyze -- --open    print the path to open
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';
import { resolveDatabasePath } from '../src/main/db/index.js';
import { buildReport } from '../src/main/analytics/report.js';
import { renderReportHtml } from '../src/main/analytics/html.js';
import { formatMoney } from '../src/main/parsing/money.js';
import { monthlyEquivalentMinor, cadenceLabel } from '../src/main/subscriptions/detect.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const demo = args.includes('--demo');

const dbPath = demo ? join(projectRoot, 'demo.db') : resolveDatabasePath();

if (!existsSync(dbPath)) {
  console.error(
    demo
      ? '\nNo demo database yet. Run: npm run seed-demo\n'
      : `\nNo database yet at ${dbPath}\n\nRun "npm run sync" first to read your inbox, or "npm run seed-demo" then "npm run analyze -- --demo" to see it working with invented data.\n`,
  );
  process.exit(1);
}

const db = openDatabase(dbPath);
migrate(db);

// The home currency decides which charges can be summed together and how
// tolerant price-change detection has to be. Configurable for a reason.
const homeCurrency =
  db.prepare("SELECT value FROM settings WHERE key = 'home_currency'").get<{ value: string }>()
    ?.value ?? 'PKR';

const report = buildReport(db, { homeCurrency, now: demo ? new Date('2026-07-29T00:00:00Z') : new Date() });
db.close();

// ── Console summary ────────────────────────────────────────────────────────
const money = (minor: number, currency = homeCurrency) => formatMoney(minor, currency);

console.log('');
console.log(`  ${money(report.monthlyCommitmentMinor)} per month`);
console.log(
  `  ${money(report.annualCommitmentMinor)} per year across ${report.subscriptions.length} recurring charge(s)`,
);
console.log('');
console.log(
  `  ${report.totals.transactions} transactions → ${report.totals.afterDedup} after collapsing authorisation/settlement pairs`,
);
console.log('');

if (report.subscriptions.length > 0) {
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const padL = (s: string, n: number) => s.padStart(n).slice(0, n);

  console.log(
    `  ${pad('MERCHANT', 22)} ${padL('AMOUNT', 14)}  ${pad('CADENCE', 14)} ${pad('NEXT DUE', 14)} ${pad('STATE', 17)} CONF`,
  );
  for (const s of report.subscriptions) {
    const cadence = cadenceLabel(s.cadence);
    const due = `${s.nextDueAt.slice(0, 10)} ±${s.nextDueCiDays}d`;
    console.log(
      `  ${pad(s.merchantName, 22)} ${padL(money(s.amountMedianMinor, s.currency), 14)}  ${pad(
        cadence,
        14,
      )} ${pad(due, 14)} ${pad(s.state, 17)} ${Math.round(s.confidence * 100)}%`,
    );
  }
  console.log('');
}

if (report.priceChanges.length > 0) {
  console.log('  Price changes:');
  for (const p of report.priceChanges) {
    const pct = Math.round(((p.toMinor - p.fromMinor) / p.fromMinor) * 100);
    console.log(
      `    ${p.merchantName}: ${money(p.fromMinor, p.currency)} → ${money(p.toMinor, p.currency)} (${
        pct > 0 ? '+' : ''
      }${pct}%) on ${p.effectiveAt.slice(0, 10)}`,
    );
  }
  console.log('');
}

if (report.upcoming.length > 0) {
  console.log('  Due in the next 30 days:');
  for (const u of report.upcoming) {
    console.log(
      `    ${u.dueAt.slice(0, 10)} ±${u.ciDays}d  ${u.merchantName.padEnd(20)} ${money(
        u.amountMinor,
        u.currency,
      )}`,
    );
  }
  console.log('');
}

if (report.totals.unparsedEmails > 0) {
  console.log(
    `  Note: ${report.totals.unparsedEmails} email(s) have no approved template yet, so their transactions are missing from these totals.`,
  );
  console.log('');
}

// ── HTML dashboard ─────────────────────────────────────────────────────────
const outPath = join(projectRoot, demo ? 'demo-report.html' : 'report.html');
writeFileSync(outPath, renderReportHtml(report), 'utf8');

console.log(`  Dashboard written to ${outPath}`);
console.log(`  Open it with:  open "${outPath}"    (macOS)`);
console.log(`                 start "" "${outPath}"  (Windows)`);
console.log('');

const monthlyLeaders = [...report.subscriptions]
  .sort((a, b) => monthlyEquivalentMinor(b) - monthlyEquivalentMinor(a))
  .slice(0, 3);
if (monthlyLeaders.length > 0) {
  console.log(
    `  Biggest monthly commitments: ${monthlyLeaders
      .map((s) => `${s.merchantName} (${money(monthlyEquivalentMinor(s), s.currency)})`)
      .join(', ')}`,
  );
  console.log('');
}
