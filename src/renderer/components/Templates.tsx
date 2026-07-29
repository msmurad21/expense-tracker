import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

/**
 * The approval tray.
 *
 * This is a security boundary rendered as a screen: no email format parses
 * anything until someone looks at what it extracted and approves it. Built-in
 * formats are held to the same rule, because a mistake in one of ours produces
 * wrong numbers just as easily as a hostile one — and in a finance app, wrong
 * numbers are worse than none.
 */

interface TemplateRow {
  id: number;
  name: string;
  sender_domain: string;
  kind: string;
  origin: string;
  status: string;
  hit_count: number;
}

interface PatternCheck {
  field: string;
  matched: boolean;
  capture: string | null;
  timedOut: boolean;
}

export function Templates({ onChanged }: { onChanged: () => Promise<void> }): JSX.Element {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [preview, setPreview] = useState<{ id: number; subject: string | null; checks: PatternCheck[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRows((await window.api.templates.list()) as TemplateRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showPreview = async (id: number) => {
    setBusy(true);
    try {
      const result = (await window.api.templates.preview(id)) as {
        sample: { subject: string } | null;
        checks: PatternCheck[];
      };
      setPreview({ id, subject: result.sample?.subject ?? null, checks: result.checks });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: number, approve: boolean) => {
    if (approve) await window.api.templates.approve(id);
    else await window.api.templates.reject(id);
    setPreview(null);
    await load();
    await onChanged();
  };

  const pending = rows.filter((r) => r.status === 'pending');

  return (
    <div>
      <header className="page-head">
        <h1>Email formats</h1>
        <p className="muted small">
          Nothing is parsed until you approve the format for it. That includes the formats shipped
          with the app.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="panel">
          <p>No formats yet.</p>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await window.api.templates.seedBuiltins();
              await load();
            }}
          >
            Add the formats shipped with the app
          </button>
          <p className="hint">
            They arrive as pending. They were written from each provider's known format and not
            verified against a real message, so you check one against your own mail first.
          </p>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <p className="hint">{pending.length} format(s) pending — these parse nothing yet.</p>
      ) : null}

      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Verified sender</th>
                <th>Kind</th>
                <th>Origin</th>
                <th>Status</th>
                <th className="num">Used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="merchant">{r.name}</td>
                  <td className="muted">{r.sender_domain}</td>
                  <td>{r.kind === 'bank_alert' ? 'Bank alert' : 'Receipt'}</td>
                  <td className="muted">{r.origin}</td>
                  <td>
                    <span className={`state state-${r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'critical' : 'muted'}`}>
                      <span aria-hidden="true">{r.status === 'approved' ? '●' : r.status === 'rejected' ? '■' : '◐'}</span>{' '}
                      {r.status}
                    </span>
                  </td>
                  <td className="num muted">{r.hit_count}</td>
                  <td>
                    <button type="button" className="btn subtle" disabled={busy} onClick={() => void showPreview(r.id)}>
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {preview ? (
        <div className="panel">
          <h2>What this format would extract</h2>
          {preview.subject === null ? (
            <p className="muted">
              No message from that sender in your mailbox yet, so there is nothing to check it
              against. Approving a format you have not seen work is not recommended.
            </p>
          ) : (
            <>
              <p className="hint">From your own message: "{preview.subject}"</p>
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Result</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.checks.map((c) => (
                    <tr key={c.field}>
                      <td>{c.field}</td>
                      <td>{c.timedOut ? 'TIMED OUT' : c.matched ? 'ok' : 'no match'}</td>
                      <td className="muted">
                        {c.timedOut ? 'pattern too slow — do not approve' : (c.capture ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="row-actions">
            <button
              type="button"
              className="btn"
              disabled={preview.checks.some((c) => c.timedOut)}
              onClick={() => void setStatus(preview.id, true)}
            >
              Those values are right — approve
            </button>
            <button type="button" className="btn subtle" onClick={() => void setStatus(preview.id, false)}>
              Reject
            </button>
            <button type="button" className="btn subtle" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
