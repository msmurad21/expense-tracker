import { ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Db } from '../db/Db.js';
import { buildReport } from '../analytics/report.js';
import { loadTemplates, parseEmails, reprocessAll } from '../parsing/engine.js';
import { seedBuiltinTemplates } from '../parsing/builtinTemplates.js';
import { checkTemplatePatterns } from '../parsing/sandbox.js';
import { pendingEmails, allEmails, unmatchedSenderSummary, getSetting } from '../ingest/store.js';

/**
 * The entire main↔renderer surface.
 *
 * Three rules hold for every handler below:
 *
 *  1. The channel list is CLOSED. There is no generic `invoke(channel, args)`
 *     passthrough — that common shortcut hands an attacker the whole IPC
 *     surface the moment anything in the renderer is compromised.
 *  2. Every call is checked to have come from the app's own top-level frame,
 *     and every argument is parsed with a schema. IPC arguments are untrusted
 *     structured-clone data.
 *  3. No secret is ever returned. Credentials can be SET; there is no getter
 *     for one anywhere. The renderer sees only whether a credential exists and
 *     a display-safe hint.
 */

let database: Db | null = null;

/**
 * Reject calls from anywhere but the app's own top frame. Without this an
 * iframe, or a frame that has been navigated elsewhere, inherits the API.
 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame) throw new Error('IPC call from a destroyed frame');

  const url = frame.url;
  const trusted = url.startsWith('app://') || url.startsWith('http://localhost');
  if (!trusted || frame.parent !== null) {
    throw new Error('IPC call rejected: untrusted frame');
  }
}

function db(): Db {
  if (!database) throw new Error('Database is not open');
  return database;
}

/** Register a handler with sender checking and argument validation applied. */
function handle<S extends z.ZodTypeAny>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => unknown,
): void {
  ipcMain.handle(channel, (event, raw) => {
    assertTrustedSender(event);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid arguments for ${channel}: ${parsed.error.issues[0]?.message}`);
    }
    return fn(parsed.data);
  });
}

const noArgs = z.undefined().or(z.null()).or(z.object({}).passthrough());
const idArg = z.object({ id: z.number().int().positive() });

// ── Credential storage ─────────────────────────────────────────────────────

const SECRET_IMAP_PASSWORD = 'imap_app_password';

interface KeychainStatus {
  available: boolean;
  backend: string | null;
  /** False when the platform silently downgraded to obfuscation. */
  secure: boolean;
  note?: string;
}

/**
 * Report what the OS is actually able to do.
 *
 * On Linux with no secret store, `safeStorage` encrypts using a hardcoded
 * password while still reporting that encryption is available. Storing a bank
 * credential under that and calling it encrypted would be a lie, so the backend
 * is checked and `basic_text` is treated as insecure.
 */
export function keychainStatus(): KeychainStatus {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      available: false,
      backend: null,
      secure: false,
      note: 'No OS credential store is available, so credentials cannot be stored safely.',
    };
  }

  let backend: string | null = null;
  try {
    backend = safeStorage.getSelectedStorageBackend?.() ?? null;
  } catch {
    backend = null;
  }

  if (backend === 'basic_text') {
    return {
      available: true,
      backend,
      secure: false,
      note: 'This system has no real credential store — encryption would use a fixed built-in password. Credentials will not be saved.',
    };
  }

  return { available: true, backend, secure: true };
}

function storeSecret(key: string, value: string, hint: string): void {
  const status = keychainStatus();
  if (!status.secure) {
    throw new Error(status.note ?? 'Credential storage is not secure on this system');
  }
  const ciphertext = safeStorage.encryptString(value);
  db()
    .prepare(
      `INSERT INTO secrets (key, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext,
                                      hint = excluded.hint,
                                      updated_at = excluded.updated_at`,
    )
    .run(key, ciphertext, hint, new Date().toISOString());
}

/**
 * Read a secret back. Exported for use inside the main process ONLY — there is
 * deliberately no IPC channel that reaches this.
 */
export function readSecret(key: string): string | null {
  const row = db()
    .prepare('SELECT ciphertext FROM secrets WHERE key = ?')
    .get<{ ciphertext: Uint8Array }>(key);
  if (!row) return null;

  try {
    return safeStorage.decryptString(Buffer.from(row.ciphertext));
  } catch {
    // A renamed app, or a move from unsigned to signed, changes the keychain
    // ACL and invalidates the blob. That is "re-authenticate", not a crash.
    return null;
  }
}

function secretStatus(key: string): { hasSecret: boolean; hint: string | null } {
  const row = db().prepare('SELECT hint FROM secrets WHERE key = ?').get<{ hint: string }>(key);
  return { hasSecret: row !== undefined, hint: row?.hint ?? null };
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerIpcHandlers(instance: Db): void {
  database = instance;

  handle('analytics:report', noArgs, () => {
    const homeCurrency = getSetting(db(), 'home_currency') ?? 'PKR';
    return buildReport(db(), { homeCurrency });
  });

  handle('templates:list', noArgs, () =>
    db()
      .prepare(
        `SELECT id, name, sender_domain, subject_pattern, kind, origin, status, hit_count
         FROM parse_templates ORDER BY status, sender_domain`,
      )
      .all(),
  );

  handle('templates:seedBuiltins', noArgs, () => seedBuiltinTemplates(db()));

  handle('templates:preview', idArg, async ({ id }) => {
    const row = db()
      .prepare('SELECT sender_domain, rules_json FROM parse_templates WHERE id = ?')
      .get<{ sender_domain: string; rules_json: string }>(id);
    if (!row) throw new Error(`No template ${id}`);

    const sample = db()
      .prepare(
        `SELECT subject, body_text FROM emails
         WHERE dkim_domain = ? OR dkim_domain LIKE ?
         ORDER BY received_at DESC LIMIT 1`,
      )
      .get<{ subject: string; body_text: string }>(row.sender_domain, `%.${row.sender_domain}`);

    if (!sample) return { sample: null, checks: [] };

    const rules = JSON.parse(row.rules_json) as { field: string; pattern: string }[];
    const checks = await checkTemplatePatterns(rules, `${sample.subject}\n${sample.body_text ?? ''}`);
    return { sample: { subject: sample.subject }, checks };
  });

  handle('templates:setStatus', idArg.extend({ status: z.enum(['approved', 'rejected']) }), ({ id, status }) => {
    db().prepare('UPDATE parse_templates SET status = ? WHERE id = ?').run(status, id);
    return { ok: true };
  });

  handle('parse:run', z.object({ all: z.boolean().optional() }).or(noArgs), (input) => {
    const all = typeof input === 'object' && input !== null && 'all' in input ? Boolean(input.all) : false;
    return all ? reprocessAll(db(), allEmails(db())) : parseEmails(db(), pendingEmails(db()));
  });

  handle('parse:unmatchedSenders', noArgs, () => unmatchedSenderSummary(db()));

  handle('status:overview', noArgs, () => ({
    keychain: keychainStatus(),
    imap: secretStatus(SECRET_IMAP_PASSWORD),
    lastSync: getSetting(db(), 'last_sync_at'),
    approvedTemplates: loadTemplates(db()).length,
    emails: db().prepare('SELECT COUNT(*) AS n FROM emails').get<{ n: number }>()?.n ?? 0,
    transactions: db().prepare('SELECT COUNT(*) AS n FROM transactions').get<{ n: number }>()?.n ?? 0,
  }));

  // Setting a credential is allowed. Reading one back is not — there is no
  // 'credentials:get' channel, and there must never be one.
  handle(
    'credentials:setImap',
    z.object({
      user: z.string().email(),
      appPassword: z.string().min(8).max(64),
    }),
    ({ user, appPassword }) => {
      const cleaned = appPassword.replace(/\s+/g, '');
      storeSecret(SECRET_IMAP_PASSWORD, cleaned, `••••${cleaned.slice(-4)}`);
      db()
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('imap_user', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(user, new Date().toISOString());
      return { ok: true };
    },
  );

  handle('credentials:clear', noArgs, () => {
    db().prepare('DELETE FROM secrets WHERE key = ?').run(SECRET_IMAP_PASSWORD);
    return { ok: true };
  });
}

/** Channels the preload bridge is permitted to expose. Nothing else exists. */
export const IPC_CHANNELS = [
  'analytics:report',
  'templates:list',
  'templates:seedBuiltins',
  'templates:preview',
  'templates:setStatus',
  'parse:run',
  'parse:unmatchedSenders',
  'status:overview',
  'credentials:setImap',
  'credentials:clear',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];
