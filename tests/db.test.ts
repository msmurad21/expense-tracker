import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/main/db/sqliteAdapter.js';
import { migrate, getSchemaVersion, MIGRATIONS } from '../src/main/db/migrations.js';
import type { Db } from '../src/main/db/Db.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(getSchemaVersion(db)).toBe(latest);
  });

  it('is idempotent — re-running applies nothing', () => {
    expect(migrate(db)).toEqual([]);
  });

  it('creates every table the app depends on', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all<{ name: string }>();
    const names = rows.map((r) => r.name);

    for (const expected of [
      'accounts',
      'emails',
      'transactions',
      'receipts',
      'receipt_transaction_links',
      'merchants',
      'categories',
      'subscriptions',
      'subscription_charges',
      'parse_templates',
      'user_overrides',
      'secrets',
      'settings',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('seeds the system categories', () => {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM categories WHERE is_system = 1')
      .get<{ n: number }>();
    expect(row?.n).toBeGreaterThan(0);
  });
});

describe('money storage', () => {
  it('round-trips minor units as exact integers', () => {
    db.prepare(
      `INSERT INTO emails (message_id, source, from_addr, from_domain, subject,
                           received_at, created_at)
       VALUES (?, 'imap', 'a@hbl.com', 'hbl.com', 's', '2026-01-01T00:00:00Z',
               '2026-01-01T00:00:00Z')`,
    ).run('<m1@x>');

    // PKR 4,320.50 -> 432050. Deliberately a value that a float would mangle.
    db.prepare(
      `INSERT INTO transactions (email_id, amount_minor, currency, occurred_at,
                                 merchant_raw, created_at)
       VALUES (1, ?, 'PKR', '2026-01-01T00:00:00Z', 'NETFLIX', '2026-01-01T00:00:00Z')`,
    ).run(432050);

    const row = db
      .prepare('SELECT amount_minor FROM transactions WHERE id = 1')
      .get<{ amount_minor: number }>();

    expect(row?.amount_minor).toBe(432050);
    expect(Number.isInteger(row?.amount_minor)).toBe(true);
  });
});

describe('idempotent ingestion', () => {
  const insert = (messageId: string) =>
    db
      .prepare(
        `INSERT INTO emails (message_id, source, from_addr, from_domain, subject,
                             received_at, created_at)
         VALUES (?, 'imap', 'a@hbl.com', 'hbl.com', 's', '2026-01-01T00:00:00Z',
                 '2026-01-01T00:00:00Z')`,
      )
      .run(messageId);

  it('rejects a duplicate Message-ID so re-syncing cannot double-count', () => {
    insert('<same@hbl.com>');
    expect(() => insert('<same@hbl.com>')).toThrow();
  });
});

describe('transactions', () => {
  it('rolls back every write when the body throws', () => {
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('a','1','t')").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const row = db.prepare('SELECT COUNT(*) AS n FROM settings').get<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('commits on success', () => {
    db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('a','1','t')").run();
    });
    const row = db.prepare('SELECT COUNT(*) AS n FROM settings').get<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('supports nesting via savepoints, rolling back only the inner scope', () => {
    db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('outer','1','t')").run();

      try {
        db.transaction(() => {
          db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('inner','1','t')").run();
          throw new Error('inner failed');
        });
      } catch {
        /* deliberately swallowed — the outer transaction should survive */
      }
    });

    const keys = db.prepare('SELECT key FROM settings').all<{ key: string }>().map((r) => r.key);
    expect(keys).toEqual(['outer']);
  });
});

describe('referential integrity', () => {
  it('enforces foreign keys', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO transactions (email_id, amount_minor, currency, occurred_at,
                                     merchant_raw, created_at)
           VALUES (9999, 100, 'PKR', '2026-01-01T00:00:00Z', 'X', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });
});
