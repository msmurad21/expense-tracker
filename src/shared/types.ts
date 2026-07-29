/**
 * Types shared across the main process, the preload bridge and the renderer.
 *
 * Money rule, enforced everywhere: amounts are ALWAYS integer minor units
 * (paisa, cents) paired with an explicit ISO-4217 currency. Never a float, and
 * never summed across currencies without an explicit conversion step.
 */

export type Currency = string; // ISO-4217, e.g. "PKR", "USD"

/** An amount of money. `minor` is an integer: PKR 4,320.50 -> 432050. */
export interface Money {
  minor: number;
  currency: Currency;
}

// ---------------------------------------------------------------------------
// Email ingestion
// ---------------------------------------------------------------------------

export type MailSourceKind = 'imap' | 'gmail_api';

/** How an email was classified once parsed. */
export type EmailKind = 'bank_alert' | 'receipt' | 'unknown';

export type ParseStatus = 'pending' | 'parsed' | 'unmatched' | 'failed';

/** A message as pulled off the wire, before any parsing. */
export interface RawEmail {
  /** RFC-822 Message-ID. Our idempotency key — UNIQUE in the database. */
  messageId: string;
  source: MailSourceKind;
  fromAddress: string;
  fromDomain: string;
  /**
   * Domain that actually passed DKIM verification, or null when the message
   * was unsigned or failed. Parse templates bind to this, NOT to `fromDomain`,
   * because the From header is trivially spoofable.
   */
  dkimDomain: string | null;
  /**
   * Why verification did or did not succeed. Diagnostic only — nothing depends
   * on it, but it separates "this sender does not sign" from "we failed to read
   * a signature that passed", which are indistinguishable from the outcome.
   */
  dkimReason?: string;
  subject: string;
  receivedAt: string; // ISO-8601 UTC
  /** Sanitised plain text. Raw HTML never leaves the main process. */
  bodyText: string;
}

/** Opaque per-source position marker for incremental sync. */
export interface SyncCursor {
  /** IMAP: highest UID seen. Gmail API: historyId. */
  value: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Why `kind` matters: banks routinely send TWO emails for one purchase — an
 * authorisation and then a settlement, often for different amounts. Collapsing
 * these is the single most important correctness step in the pipeline.
 */
export type TransactionKind = 'purchase' | 'auth' | 'refund' | 'reversal';

export type Direction = 'debit' | 'credit';

export interface Transaction {
  id: number;
  emailId: number;
  accountId: number | null;
  amount: Money;
  direction: Direction;
  kind: TransactionKind;
  /** Always UTC. Bank alerts give local-time strings with no offset. */
  occurredAt: string;
  /** How we arrived at the UTC value, e.g. "explicit:+05:00" or "assumed:PKT". */
  tzSource: string | null;
  merchantRaw: string;
  merchantId: number | null;
  cardLast4: string | null;
  /** Set when this row was superseded by a settlement of the same purchase. */
  supersededBy: number | null;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Receipts (from the subscription company, not the bank)
// ---------------------------------------------------------------------------

export type ReceiptEventKind =
  | 'charge'
  | 'renewal_notice'
  | 'price_change'
  | 'cancellation'
  | 'payment_failed';

/**
 * A merchant receipt. This is the ONLY source that can tell us which account a
 * subscription belongs to (which Apple ID, which Netflix login) — a bank alert
 * never can.
 */
export interface Receipt {
  id: number;
  emailId: number;
  merchantId: number | null;
  planName: string | null;
  /** e.g. the Apple ID or account email the subscription is billed under. */
  owningAccount: string | null;
  amount: Money | null;
  periodStart: string | null;
  periodEnd: string | null;
  nextRenewalAt: string | null;
  eventKind: ReceiptEventKind;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type CadenceKind = 'weekly' | 'monthly' | 'yearly';

/** e.g. {kind:'weekly', n:2} = fortnightly; {kind:'monthly', n:3} = quarterly. */
export interface Cadence {
  kind: CadenceKind;
  n: number;
}

export type AmountClass = 'fixed' | 'near_fixed' | 'variable';

export type SubscriptionState =
  | 'active'
  | 'provisional' // only 2 observations — show it, but don't alert on it
  | 'overdue' // one missed cycle; usually a failed-payment retry
  | 'likely_cancelled'; // two consecutive misses

export interface Subscription {
  id: number;
  merchantId: number;
  merchantName: string;
  owningAccount: string | null;
  currency: Currency;
  cadence: Cadence | null;
  amountMedian: Money;
  amountClass: AmountClass;
  firstSeenAt: string;
  lastChargedAt: string;
  /** Predicted next charge, always presented with its interval — never bare. */
  nextDueAt: string | null;
  nextDueCiDays: number;
  state: SubscriptionState;
  confidence: number;
  /** Every card last-4 seen paying this. Reissues and Apple Pay DPANs differ. */
  observedLast4: string[];
  /** User-applied "I don't use this". We can observe charged, never used. */
  userMarkedUnused: boolean;
}

// ---------------------------------------------------------------------------
// Parse templates
// ---------------------------------------------------------------------------

export type TemplateOrigin = 'builtin' | 'llm' | 'user';
export type TemplateStatus = 'pending' | 'approved' | 'rejected';

export type FieldType = 'money_minor' | 'currency' | 'date' | 'string' | 'last4';

/**
 * One extracted field. Deliberately DATA, never code — there is no `eval` and
 * no `new Function` anywhere in the parsing path. An LLM proposing a template
 * is proposing a declarative record that a fixed interpreter executes.
 */
export interface FieldRule {
  field: string;
  /** Regex source with exactly one capture group. Vetted before it is stored. */
  pattern: string;
  type: FieldType;
  required: boolean;
  /** Fixed value used when the pattern is absent, e.g. a known currency. */
  fallback?: string;
}

export interface ParseTemplate {
  id: number;
  name: string;
  /**
   * DKIM-verified sender domain this template is bound to. A template minted
   * from mail signed by hbl.com can never fire on mail from anywhere else,
   * which is what stops a spoofed email from hijacking a trusted parser.
   */
  senderDomain: string;
  subjectPattern: string | null;
  kind: EmailKind;
  rules: FieldRule[];
  origin: TemplateOrigin;
  status: TemplateStatus;
  hitCount: number;
}

/** Shown in the approval tray so a human sees what a template would extract. */
export interface TemplateProposal {
  template: Omit<ParseTemplate, 'id' | 'hitCount'>;
  sampleEmailId: number;
  extractedPreview: Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Emitted by `npm run doctor` as JSON. Claude Code reads this to diagnose a
 * broken setup without needing to see any credential.
 */
export interface DoctorReport {
  ok: boolean;
  node: { version: string; ok: boolean; note?: string };
  sqlite: { available: boolean; note?: string };
  database: { path: string | null; exists: boolean; schemaVersion: number | null; ok: boolean };
  keychain: { backend: string | null; secure: boolean; note?: string };
  accounts: number;
  lastSync: string | null;
  pendingTemplates: number;
  problems: DoctorProblem[];
}

export interface DoctorProblem {
  severity: 'error' | 'warning';
  code: string;
  /** Written for a non-technical reader — this is shown verbatim. */
  message: string;
  fix: string;
}
