import type { Db } from '../db/Db.js';
import { validateTemplate } from './templateSchema.js';

/**
 * Templates that ship with the app.
 *
 * ── Why these are all `pending` ────────────────────────────────────────────
 * They were written from the known structure of each provider's receipt, not
 * verified against a real message in this repository — committing real receipts
 * to check them against is exactly what the project forbids. So they arrive as
 * proposals: you see what one extracts from a message in YOUR mailbox, and it
 * only runs after you approve it.
 *
 * That is the same gate an LLM-proposed template passes through, deliberately.
 * A built-in has no privilege over any other template, because a mistake in one
 * of ours produces wrong numbers just as easily as a hostile one does — and
 * wrong numbers in a finance app are worse than none.
 *
 * Adding to this list is the single most useful contribution to the project.
 * See CONTRIBUTING.md.
 */

export interface BuiltinTemplate {
  name: string;
  senderDomain: string;
  subjectPattern: string | null;
  kind: 'bank_alert' | 'receipt';
  rules: {
    field: string;
    pattern: string;
    type: 'money_minor' | 'currency' | 'date' | 'string' | 'last4';
    required: boolean;
    fallback?: string;
  }[];
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: 'Netflix receipt',
    senderDomain: 'netflix.com',
    subjectPattern: 'receipt|billing|payment',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'Total[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'Total[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'plan_name', pattern: 'plan[:\\s]*([A-Za-z0-9 ]{3,40})', type: 'string', required: false },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
      { field: 'next_renewal_at', pattern: 'Next billing date[:\\s]*([A-Za-z0-9 ,/-]{6,20})', type: 'date', required: false },
    ],
  },
  {
    name: 'Spotify receipt',
    senderDomain: 'spotify.com',
    subjectPattern: 'receipt|payment|invoice',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'Total[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'Total[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'plan_name', pattern: '(Premium[A-Za-z ]{0,20})', type: 'string', required: false },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
    ],
  },
  {
    name: 'Apple receipt',
    senderDomain: 'apple.com',
    subjectPattern: 'receipt|invoice|subscription',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'TOTAL[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'TOTAL[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      // The Apple ID is the whole reason receipts matter: it says WHOSE
      // subscription this is, which a bank alert can never tell you.
      { field: 'owning_account', pattern: 'APPLE ACCOUNT[:\\s]*([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
      { field: 'plan_name', pattern: 'Subscription[:\\s]*([A-Za-z0-9 ]{3,40})', type: 'string', required: false },
    ],
  },
  {
    name: 'Google / YouTube receipt',
    senderDomain: 'google.com',
    subjectPattern: 'receipt|invoice|payment|subscription',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'Total[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'Total[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
      { field: 'plan_name', pattern: '(YouTube Premium|Google One[A-Za-z0-9 ]{0,20})', type: 'string', required: false },
    ],
  },
  {
    name: 'OpenAI receipt',
    senderDomain: 'openai.com',
    subjectPattern: 'receipt|invoice|payment',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: '(US\\$|\\$)', type: 'currency', required: false, fallback: 'USD' },
      { field: 'amount', pattern: '(?:Amount paid|Total)[:\\s]*\\$?([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
      { field: 'plan_name', pattern: '(ChatGPT [A-Za-z]{3,12})', type: 'string', required: false },
    ],
  },
  {
    name: 'Adobe receipt',
    senderDomain: 'adobe.com',
    subjectPattern: 'receipt|invoice|order',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'Total[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'Total[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'plan_name', pattern: '(Creative Cloud[A-Za-z ]{0,30})', type: 'string', required: false },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
    ],
  },
  {
    name: 'Microsoft receipt',
    senderDomain: 'microsoft.com',
    subjectPattern: 'receipt|invoice|subscription|order',
    kind: 'receipt',
    rules: [
      { field: 'currency', pattern: 'Total[:\\s]*(US\\$|\\$|PKR|Rs\\.?|€|£)', type: 'currency', required: true },
      { field: 'amount', pattern: 'Total[:\\s]*(?:US\\$|\\$|PKR|Rs\\.?|€|£)\\s*([\\d.,]+)', type: 'money_minor', required: true },
      { field: 'plan_name', pattern: '(Microsoft 365[A-Za-z ]{0,20})', type: 'string', required: false },
      { field: 'owning_account', pattern: '([\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,})', type: 'string', required: false },
    ],
  },
];

export interface SeedResult {
  inserted: number;
  skipped: number;
  rejected: { name: string; problems: string[] }[];
}

/**
 * Insert the built-ins that are not already present.
 *
 * Every one is validated on the way in by the same rules a proposal faces. A
 * built-in that fails is reported rather than force-inserted — if one of ours
 * carries an unsafe pattern, the right outcome is that it does not ship.
 */
export function seedBuiltinTemplates(db: Db): SeedResult {
  const result: SeedResult = { inserted: 0, skipped: 0, rejected: [] };
  const now = new Date().toISOString();

  for (const builtin of BUILTIN_TEMPLATES) {
    const validation = validateTemplate({
      ...builtin,
      origin: 'builtin',
      status: 'pending',
    });

    if (!validation.ok) {
      result.rejected.push({ name: builtin.name, problems: validation.problems });
      continue;
    }

    const existing = db
      .prepare('SELECT id FROM parse_templates WHERE name = ? AND sender_domain = ?')
      .get<{ id: number }>(builtin.name, builtin.senderDomain);

    if (existing) {
      result.skipped++;
      continue;
    }

    db.prepare(
      `INSERT INTO parse_templates (name, sender_domain, subject_pattern, kind, rules_json,
                                    origin, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'builtin', 'pending', ?)`,
    ).run(
      builtin.name,
      builtin.senderDomain,
      builtin.subjectPattern,
      builtin.kind,
      JSON.stringify(builtin.rules),
      now,
    );

    result.inserted++;
  }

  return result;
}
