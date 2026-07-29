#!/usr/bin/env tsx
/**
 * `npm run seed-demo` — fill a throwaway database with invented data.
 *
 * Purpose: exercise the analytics and produce screenshots without anyone's real
 * financial history. Every merchant, amount, card number and date below is made
 * up. README screenshots must come from this, never from a real inbox.
 *
 * Writes to a separate file (`demo.db` in the project directory) so it can
 * never overwrite real data.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate } from '../src/main/db/migrations.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DB_PATH = join(projectRoot, 'demo.db');

if (existsSync(DEMO_DB_PATH)) unlinkSync(DEMO_DB_PATH);
for (const suffix of ['-wal', '-shm']) {
  const sidecar = DEMO_DB_PATH + suffix;
  if (existsSync(sidecar)) unlinkSync(sidecar);
}

const db = openDatabase(DEMO_DB_PATH);
migrate(db);

const now = new Date('2026-07-29T00:00:00.000Z');
const iso = (d: Date) => d.toISOString();

/** Month offset back from `now`, on a given day of month. */
function monthsAgo(count: number, dayOfMonth: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1, 12, 0, 0));
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, daysInMonth));
  return d;
}

interface Seed {
  merchant: string;
  currency: string;
  amount: number | ((i: number) => number);
  day: number;
  months: number;
  last4: string;
  /** Add an authorisation row two days before each settlement. */
  withAuthPair?: boolean;
}

const SEEDS: Seed[] = [
  // Steady PKR subscriptions
  { merchant: 'NETFLIX.COM 866-579-7172', currency: 'PKR', amount: 432050, day: 15, months: 14, last4: '4821' },
  { merchant: 'SPOTIFY USA', currency: 'PKR', amount: 119900, day: 3, months: 14, last4: '4821' },
  { merchant: 'YOUTUBEPREMIUM', currency: 'PKR', amount: 179000, day: 22, months: 11, last4: '9004' },

  // Anchored on the 31st — the case that breaks gap-averaging detectors
  { merchant: 'APPLE.COM/BILL', currency: 'PKR', amount: 89000, day: 31, months: 13, last4: '4821' },

  // Foreign currency: moves a few percent monthly on FX alone
  {
    merchant: 'OPENAI *CHATGPT',
    currency: 'USD',
    amount: (i) => 2000 + Math.round(Math.sin(i) * 35),
    day: 8,
    months: 12,
    last4: '9004',
  },

  // A genuine price rise partway through
  {
    merchant: 'ADOBE CREATIVE CLOUD',
    currency: 'PKR',
    amount: (i) => (i < 6 ? 649000 : 559000), // i counts backwards: recent months cost more
    day: 12,
    months: 12,
    last4: '4821',
  },

  // Variable-amount utility: recurring, but with no meaningful "price".
  //
  // These swing the way an electricity bill actually does — air conditioning in
  // summer, very little in winter. An earlier version used a modular arithmetic
  // expression that never wrapped, producing a smooth monotonic ramp; the
  // detector then correctly reported it as a price trend, because that is what
  // a steady decline is. Erratic is the point.
  {
    merchant: 'K ELECTRIC',
    currency: 'PKR',
    amount: (i) =>
      [195000, 512000, 238000, 601000, 205000, 588000, 262000, 634000, 210000, 545000, 249000,
        498000, 231000, 570000][i % 14]!,
    day: 6,
    months: 14,
    last4: '4821',
    withAuthPair: true,
  },

  // Quarterly
  { merchant: 'MICROSOFT 365', currency: 'PKR', amount: 750000, day: 18, months: 12, last4: '9004' },

  // Weekly
  { merchant: 'CAREEM', currency: 'PKR', amount: 45000, day: 2, months: 3, last4: '9004' },
];

const insertEmail = db.prepare(
  `INSERT INTO emails (message_id, source, from_addr, from_domain, dkim_domain, subject,
                       received_at, body_text, kind, parse_status, created_at)
   VALUES (?, 'imap', 'alerts@demobank.example', 'demobank.example', 'demobank.example',
           ?, ?, '(demo data)', 'bank_alert', 'parsed', ?)`,
);

const insertTx = db.prepare(
  `INSERT INTO transactions (email_id, amount_minor, currency, direction, kind, occurred_at,
                             tz_source, merchant_raw, card_last4, confidence, created_at)
   VALUES (?, ?, ?, 'debit', ?, ?, 'assumed:PKT', ?, ?, 1.0, ?)`,
);

let seq = 0;
const createdAt = iso(now);

function addTransaction(seed: Seed, when: Date, amount: number, kind: 'purchase' | 'auth'): void {
  seq++;
  const emailId = insertEmail.run(
    `<demo-${seq}@demobank.example>`,
    `Transaction Alert - ${seed.merchant}`,
    iso(when),
    createdAt,
  ).lastInsertRowid;

  insertTx.run(emailId, amount, seed.currency, kind, iso(when), seed.merchant, seed.last4, createdAt);
}

db.transaction(() => {
  for (const seed of SEEDS) {
    const stepMonths = seed.merchant === 'MICROSOFT 365' ? 3 : 1;
    const isWeekly = seed.merchant === 'CAREEM';

    if (isWeekly) {
      for (let w = 0; w < 13; w++) {
        const when = new Date(now.getTime() - w * 7 * 86_400_000);
        addTransaction(seed, when, typeof seed.amount === 'function' ? seed.amount(w) : seed.amount, 'purchase');
      }
      continue;
    }

    for (let i = 0; i < seed.months; i += stepMonths) {
      const when = monthsAgo(i, seed.day);
      if (when > now) continue;

      const amount = typeof seed.amount === 'function' ? seed.amount(i) : seed.amount;

      // An authorisation two days earlier for a slightly different amount, so
      // the dedup path is exercised by the demo data too.
      if (seed.withAuthPair) {
        const authWhen = new Date(when.getTime() - 2 * 86_400_000);
        addTransaction(seed, authWhen, Math.round(amount * 0.97), 'auth');
      }

      addTransaction(seed, when, amount, 'purchase');
    }
  }

  // A few one-off purchases, which must NOT be reported as subscriptions.
  const oneOffs: [string, number, number][] = [
    ['DARAZ PK', 1250000, 40],
    ['FOODPANDA', 185000, 12],
    ['SHELL PETROL KARACHI PK', 800000, 25],
  ];
  for (const [merchant, amount, daysAgo] of oneOffs) {
    seq++;
    const when = new Date(now.getTime() - daysAgo * 86_400_000);
    const emailId = insertEmail.run(
      `<demo-oneoff-${seq}@demobank.example>`,
      `Transaction Alert - ${merchant}`,
      iso(when),
      createdAt,
    ).lastInsertRowid;
    insertTx.run(emailId, amount, 'PKR', 'purchase', iso(when), merchant, '4821', createdAt);
  }

  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_sync_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(iso(now), createdAt);
});

const count = db.prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n ?? 0;
db.close();

console.log(`Seeded ${count} invented transactions into ${DEMO_DB_PATH}`);
console.log('Every value is fictional. Run: npm run analyze -- --demo');
