import type { Db } from './Db.js';

/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 *
 * Rules for adding one:
 *  - Never edit a shipped migration. Append a new entry.
 *  - Money is always `INTEGER` minor units plus an explicit `currency` column.
 *  - Timestamps are always ISO-8601 UTC strings.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M001_INITIAL = `
-- Cards / accounts the user owns. Labelled by the user, e.g. "my card — also
-- on Dad's iPhone", which is how per-card spend gets a human meaning.
CREATE TABLE accounts (
  id          INTEGER PRIMARY KEY,
  label       TEXT    NOT NULL,
  bank_name   TEXT,
  card_last4  TEXT,
  currency    TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_accounts_last4 ON accounts(card_last4);

-- Every message we have ingested. Kept separate from transactions on purpose:
-- when a parser improves we reprocess this table with no re-download.
CREATE TABLE emails (
  id           INTEGER PRIMARY KEY,
  message_id   TEXT    NOT NULL UNIQUE,   -- RFC-822 Message-ID => idempotent sync
  source       TEXT    NOT NULL,          -- imap | gmail_api
  from_addr    TEXT    NOT NULL,
  from_domain  TEXT    NOT NULL,          -- spoofable; never bind templates to this
  dkim_domain  TEXT,                      -- verified; NULL when unsigned/failed
  subject      TEXT,
  received_at  TEXT    NOT NULL,
  body_text    TEXT,                      -- sanitised text; raw HTML is discarded
  kind         TEXT    NOT NULL DEFAULT 'unknown',
  parse_status TEXT    NOT NULL DEFAULT 'pending',
  template_id  INTEGER,
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_emails_status   ON emails(parse_status);
CREATE INDEX idx_emails_received ON emails(received_at);
CREATE INDEX idx_emails_dkim     ON emails(dkim_domain);

CREATE TABLE categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  icon      TEXT,
  color     TEXT,
  is_system INTEGER NOT NULL DEFAULT 0
);

-- Normalised merchants. canonical_id lets several observed spellings collapse
-- onto one logical merchant without losing the original rows.
CREATE TABLE merchants (
  id             INTEGER PRIMARY KEY,
  normalized_key TEXT    NOT NULL UNIQUE,
  display_name   TEXT    NOT NULL,
  canonical_id   INTEGER REFERENCES merchants(id),
  category_id    INTEGER REFERENCES categories(id),
  source         TEXT    NOT NULL DEFAULT 'fuzzy',  -- alias | fuzzy | user | llm
  created_at     TEXT    NOT NULL
);

CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY,
  email_id      INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  account_id    INTEGER REFERENCES accounts(id),
  amount_minor  INTEGER NOT NULL,          -- integer minor units, never a float
  currency      TEXT    NOT NULL,
  direction     TEXT    NOT NULL DEFAULT 'debit',
  kind          TEXT    NOT NULL DEFAULT 'purchase', -- purchase|auth|refund|reversal
  occurred_at   TEXT    NOT NULL,          -- UTC
  tz_source     TEXT,                      -- how we resolved the local time
  merchant_raw  TEXT    NOT NULL,
  merchant_id   INTEGER REFERENCES merchants(id),
  card_last4    TEXT,
  -- Set when an authorisation row was superseded by its settlement. Rows with a
  -- non-NULL value here are excluded from spend totals and cadence input.
  superseded_by INTEGER REFERENCES transactions(id),
  confidence    REAL    NOT NULL DEFAULT 1.0,
  created_at    TEXT    NOT NULL
);
CREATE INDEX idx_tx_occurred   ON transactions(occurred_at);
CREATE INDEX idx_tx_merchant   ON transactions(merchant_id);
CREATE INDEX idx_tx_superseded ON transactions(superseded_by);
CREATE INDEX idx_tx_last4      ON transactions(card_last4);

-- Receipts sent by the subscription company itself. The only place we can learn
-- WHICH ACCOUNT a subscription is billed under — a bank alert never says.
CREATE TABLE receipts (
  id              INTEGER PRIMARY KEY,
  email_id        INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  merchant_id     INTEGER REFERENCES merchants(id),
  plan_name       TEXT,
  owning_account  TEXT,
  amount_minor    INTEGER,
  currency        TEXT,
  period_start    TEXT,
  period_end      TEXT,
  next_renewal_at TEXT,
  event_kind      TEXT NOT NULL DEFAULT 'charge',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_receipts_merchant ON receipts(merchant_id);

-- Correlation between a receipt (USD 15.49) and the bank alert that paid it
-- (PKR 4,320). Amounts differ because of FX, so the implied rate is recorded —
-- which incidentally exposes the card's FX markup.
CREATE TABLE receipt_transaction_links (
  receipt_id      INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  confidence      REAL    NOT NULL,
  implied_fx_rate REAL,
  PRIMARY KEY (receipt_id, transaction_id)
);

CREATE TABLE subscriptions (
  id                  INTEGER PRIMARY KEY,
  merchant_id         INTEGER NOT NULL REFERENCES merchants(id),
  owning_account      TEXT,
  currency            TEXT    NOT NULL,
  cadence_kind        TEXT,                 -- weekly | monthly | yearly
  cadence_n           INTEGER,
  anchor_dom          INTEGER,              -- day-of-month the billing anchors on
  phase_offset_days   REAL    NOT NULL DEFAULT 0, -- absorbs weekend/business-day shift
  jitter_days         REAL    NOT NULL DEFAULT 0,
  amount_median_minor INTEGER NOT NULL,
  amount_mad_minor    INTEGER NOT NULL DEFAULT 0,
  amount_class        TEXT    NOT NULL DEFAULT 'fixed',
  first_seen_at       TEXT    NOT NULL,
  last_charged_at     TEXT    NOT NULL,
  next_due_at         TEXT,
  next_due_ci_days    INTEGER NOT NULL DEFAULT 0,
  state               TEXT    NOT NULL DEFAULT 'active',
  confidence          REAL    NOT NULL DEFAULT 0,
  observed_last4      TEXT    NOT NULL DEFAULT '[]', -- JSON array; cards get reissued
  user_marked_unused  INTEGER NOT NULL DEFAULT 0,    -- we see charged, never used
  updated_at          TEXT    NOT NULL
);
CREATE INDEX idx_subs_state ON subscriptions(state);
CREATE INDEX idx_subs_due   ON subscriptions(next_due_at);

-- Many-to-many on purpose: one Apple charge can settle several app
-- subscriptions at once, so this is not a 1:1 relationship.
CREATE TABLE subscription_charges (
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, transaction_id)
);

-- Declarative extraction rules. rules_json is DATA interpreted by a fixed
-- evaluator — never code, never eval'd. See parsing/ for the threat model.
CREATE TABLE parse_templates (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,
  sender_domain   TEXT    NOT NULL,      -- DKIM-verified domain this is bound to
  subject_pattern TEXT,
  kind            TEXT    NOT NULL,      -- bank_alert | receipt
  rules_json      TEXT    NOT NULL,
  origin          TEXT    NOT NULL,      -- builtin | llm | user
  status          TEXT    NOT NULL DEFAULT 'pending',
  sample_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  created_at      TEXT    NOT NULL
);
CREATE INDEX idx_templates_lookup ON parse_templates(sender_domain, status);

-- User corrections, keyed so they survive a full reprocess of the inbox and are
-- re-applied afterwards. Also doubles as the evaluation set for the detector.
CREATE TABLE user_overrides (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,   -- transaction | subscription | merchant
  entity_key  TEXT NOT NULL,   -- stable natural key, not a rowid
  field       TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(entity_type, entity_key, field)
);

-- Ciphertext produced by Electron safeStorage. The OS keychain holds the master
-- key; this holds only the encrypted blob. hint is a display-safe suffix so
-- the UI can show "sk-...4f2a" without ever decrypting.
CREATE TABLE secrets (
  key        TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  hint       TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const M001_SEED_CATEGORIES = `
INSERT INTO categories (name, icon, color, is_system) VALUES
  ('Streaming',       'play',      '#e11d48', 1),
  ('Software & SaaS', 'code',      '#6366f1', 1),
  ('AI Tools',        'sparkles',  '#8b5cf6', 1),
  ('Utilities',       'bolt',      '#f59e0b', 1),
  ('Telecom',         'phone',     '#0ea5e9', 1),
  ('Groceries',       'cart',      '#22c55e', 1),
  ('Dining',          'utensils',  '#f97316', 1),
  ('Transport',       'car',       '#14b8a6', 1),
  ('Health',          'heart',     '#ec4899', 1),
  ('Shopping',        'bag',       '#a855f7', 1),
  ('Education',       'book',      '#3b82f6', 1),
  ('Uncategorised',   'question',  '#64748b', 1);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: M001_INITIAL + M001_SEED_CATEGORIES,
  },
];

/** Current schema version recorded in the database file. */
export function getSchemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>();
  return row?.user_version ?? 0;
}

/**
 * Apply any migrations newer than the database's recorded version.
 * Returns the versions that were actually applied.
 */
export function migrate(db: Db): number[] {
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  const applied: number[] = [];
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters, and `version` is an integer
      // from our own const array — never user input.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }
  return applied;
}
