import { useState } from 'react';
import type { StatusOverview } from '../App.js';
import type { JSX } from 'react';

/**
 * Connecting a mailbox.
 *
 * The App Password field is write-only in the truest sense: it goes to the main
 * process to be encrypted with the OS keychain, and there is no IPC channel
 * anywhere that can read one back. The UI can only ever learn that a credential
 * exists, plus a masked hint.
 */
export function Settings({
  status,
  onChanged,
}: {
  status: StatusOverview | null;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [user, setUser] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await window.api.credentials.setImap(user.trim(), appPassword);
      setAppPassword(''); // never keep it in component state longer than needed
      setMessage('Saved to your system keychain.');
      await onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const secure = status?.keychain.secure ?? false;

  return (
    <div>
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="panel">
        <h2>Gmail</h2>
        <p className="hint">
          Uses a Gmail App Password — a 16-character credential that lets this one program read your
          mail. It is not your Google password, cannot be used to sign in as you, and you can revoke
          it at any time without affecting anything else.
        </p>

        {status?.imap.hasSecret ? (
          <p>
            Connected · <span className="muted">{status.imap.hint}</span>{' '}
            <button
              type="button"
              className="btn subtle"
              onClick={async () => {
                await window.api.credentials.clear();
                await onChanged();
              }}
            >
              Remove
            </button>
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="gmail-user">Gmail address</label>
          <input
            id="gmail-user"
            type="email"
            autoComplete="off"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="you@gmail.com"
          />
        </div>

        <div className="field">
          <label htmlFor="gmail-pass">App Password</label>
          <input
            id="gmail-pass"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            placeholder="16 characters, spaces removed"
          />
          <p className="hint">
            Create one at myaccount.google.com/apppasswords. It requires 2-Step Verification, and it
            is unavailable on Google Workspace accounts — Google disabled it for those in 2025.
          </p>
        </div>

        <button type="button" className="btn" disabled={busy || !secure || !user || !appPassword} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save to keychain'}
        </button>

        {!secure ? (
          <p className="hint">Disabled: this system has no secure credential store.</p>
        ) : null}

        {message ? <p className="hint">{message}</p> : null}
      </section>

      <section className="panel">
        <h2>Where your data lives</h2>
        <p className="hint">
          Everything is in one local database file. There is no server, no telemetry and no analytics
          — the only outbound connections are to Gmail. Note the database itself is not encrypted at
          rest; it relies on FileVault or BitLocker. Your credentials are encrypted separately.
        </p>
        <dl className="kv">
          <dt>Credential store</dt>
          <dd>{status?.keychain.backend ?? (secure ? 'system keychain' : 'unavailable')}</dd>
          <dt>Emails stored</dt>
          <dd>{status?.emails ?? 0}</dd>
          <dt>Transactions</dt>
          <dd>{status?.transactions ?? 0}</dd>
          <dt>Approved formats</dt>
          <dd>{status?.approvedTemplates ?? 0}</dd>
        </dl>
      </section>
    </div>
  );
}
