import { useCallback, useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard.js';
import { Templates } from './components/Templates.js';
import { Settings } from './components/Settings.js';
import type { AnalyticsReport } from '../main/analytics/report.js';
import type { JSX } from 'react';

/**
 * The UI shell.
 *
 * Holds no privileged capability of its own: every number here arrived over the
 * preload bridge from the main process, and no credential ever comes back the
 * other way.
 */

export type Tab = 'dashboard' | 'formats' | 'settings';

export interface StatusOverview {
  keychain: { available: boolean; backend: string | null; secure: boolean; note?: string };
  imap: { hasSecret: boolean; hint: string | null };
  lastSync: string | null;
  approvedTemplates: number;
  emails: number;
  transactions: number;
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [status, setStatus] = useState<StatusOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextReport, nextStatus] = await Promise.all([
        window.api.analytics.report() as Promise<AnalyticsReport>,
        window.api.status.overview() as Promise<StatusOverview>,
      ]);
      setReport(nextReport);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'formats', label: 'Email formats' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">Expense Tracker</div>

        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`nav-item ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}

        <div className="sidebar-foot">
          <button type="button" className="btn subtle" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Working…' : 'Refresh'}
          </button>
          {status?.lastSync ? (
            <p className="muted small">Last sync {status.lastSync.slice(0, 10)}</p>
          ) : (
            <p className="muted small">Never synced</p>
          )}
        </div>
      </nav>

      <main className="content">
        {error ? (
          <div className="alert" role="alert">
            <strong>Something went wrong.</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {/* A credential store that has silently downgraded is worth interrupting
            for — the alternative is telling someone their bank password is
            encrypted when it is not. */}
        {status && status.keychain.available && !status.keychain.secure ? (
          <div className="alert warn" role="alert">
            <strong>Credentials cannot be stored securely on this system.</strong>
            <span>{status.keychain.note}</span>
          </div>
        ) : null}

        {tab === 'dashboard' ? <Dashboard report={report} status={status} onRefresh={refresh} /> : null}
        {tab === 'formats' ? <Templates onChanged={refresh} /> : null}
        {tab === 'settings' ? <Settings status={status} onChanged={refresh} /> : null}
      </main>
    </div>
  );
}
