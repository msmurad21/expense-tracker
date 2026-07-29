import type { AnalyticsReport } from '../../main/analytics/report.js';
import type { StatusOverview } from '../App.js';
import { formatMoney } from '../../main/parsing/money.js';
import { cadenceLabel, monthlyEquivalentMinor } from '../../main/subscriptions/detect.js';
import { SpendChart } from './SpendChart.js';
import { BarList } from './BarList.js';
import type { JSX } from 'react';

/** Status marks pair an icon with a label — colour never carries meaning alone. */
const STATE_META: Record<string, { label: string; icon: string; tone: string }> = {
  active: { label: 'Active', icon: '●', tone: 'good' },
  provisional: { label: 'Provisional', icon: '◐', tone: 'muted' },
  overdue: { label: 'Overdue', icon: '▲', tone: 'warning' },
  likely_cancelled: { label: 'Likely cancelled', icon: '■', tone: 'critical' },
};

function formatDay(iso: string): string {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

export function Dashboard({
  report,
  status,
  onRefresh,
}: {
  report: AnalyticsReport | null;
  status: StatusOverview | null;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  if (!report) return <p className="muted">Loading…</p>;

  // An empty state that explains the next step beats an empty dashboard that
  // looks broken.
  if (report.subscriptions.length === 0 && report.totals.transactions === 0) {
    return (
      <div className="empty-state">
        <h1>Nothing to show yet</h1>
        {status && status.emails === 0 ? (
          <>
            <p>No email has been read yet. Connect your inbox in Settings, then sync.</p>
          </>
        ) : status && status.approvedTemplates === 0 ? (
          <>
            <p>
              {status.emails} email(s) are stored, but no email format has been approved yet — so
              nothing has been turned into a transaction.
            </p>
            <p className="muted">
              Open <strong>Email formats</strong>, preview one against your own mail, and approve it.
              Nothing parses until you do.
            </p>
          </>
        ) : (
          <p>Emails are stored and formats approved, but no transactions were extracted yet.</p>
        )}
      </div>
    );
  }

  const currency = report.homeCurrency;

  return (
    <div className="dashboard">
      <header className="page-head">
        <h1>Your subscriptions</h1>
        <p className="muted small">
          {report.totals.transactions} transactions ({report.totals.afterDedup} after collapsing
          authorisation/settlement pairs)
        </p>
      </header>

      <div className="hero">
        <div className="hero-figure">{formatMoney(report.monthlyCommitmentMinor, currency)}</div>
        <div className="hero-caption">
          committed every month across {report.subscriptions.length} recurring charge
          {report.subscriptions.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="tiles">
        <Tile
          label="Recurring per month"
          value={formatMoney(report.monthlyCommitmentMinor, currency)}
          sub={`${formatMoney(report.annualCommitmentMinor, currency)} per year`}
        />
        <Tile
          label="Subscriptions found"
          value={String(report.subscriptions.length)}
          sub={`${report.activeCount} active · ${report.provisionalCount} provisional`}
        />
        <Tile
          label="Due in next 30 days"
          value={String(report.upcoming.length)}
          sub={report.upcoming[0] ? `next: ${report.upcoming[0].merchantName}` : 'nothing scheduled'}
        />
        <Tile
          label="Emails read"
          value={String(report.totals.emails)}
          sub={`${report.totals.unparsedEmails} not yet parsed`}
        />
      </div>

      <section className="panel">
        <h2>Spending over time</h2>
        <p className="hint">
          {currency} transactions only — foreign-currency charges are listed per subscription rather
          than converted, since a made-up exchange rate would make this total confidently wrong.
        </p>
        <SpendChart points={report.monthlySpend} currency={currency} />
      </section>

      <section className="panel">
        <h2>Where the money goes</h2>
        <BarList
          currency={currency}
          rows={report.byCategory.map((c) => ({
            label: c.category,
            valueMinor: c.totalMinor,
            note: `${Math.round(c.share * 100)}%`,
          }))}
        />
      </section>

      {report.byCard.length > 0 ? (
        <section className="panel">
          <h2>By card</h2>
          <p className="hint">
            A card cannot tell you which device or person made a purchase — recurring charges carry
            no device information at all.
          </p>
          <BarList
            currency={currency}
            rows={report.byCard.map((c) => ({
              label: `•• ${c.last4}`,
              valueMinor: c.totalMinor,
              note: `${c.subscriptionCount} subscription${c.subscriptionCount === 1 ? '' : 's'}`,
            }))}
          />
        </section>
      ) : null}

      <section className="panel">
        <h2>Every recurring charge</h2>
        <p className="hint">
          Faded rows are below 50% confidence — shown so you can confirm or dismiss them, not
          asserted as fact.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th className="num">Amount</th>
                <th>Cadence</th>
                <th className="num">Per month</th>
                <th>Next due</th>
                <th>State</th>
                <th className="num">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {report.subscriptions.map((s) => {
                const meta = STATE_META[s.state] ?? STATE_META['active']!;
                return (
                  <tr key={`${s.merchantKey}-${s.currency}`} className={s.confidence < 0.5 ? 'faded' : ''}>
                    <td className="merchant">
                      {s.merchantName}
                      {s.category ? <span className="tag">{s.category}</span> : null}
                    </td>
                    <td className="num">{formatMoney(s.amountMedianMinor, s.currency)}</td>
                    <td>{cadenceLabel(s.cadence)}</td>
                    <td className="num">{formatMoney(monthlyEquivalentMinor(s), s.currency)}</td>
                    <td>
                      {formatDay(s.nextDueAt)} <span className="ci">±{s.nextDueCiDays}d</span>
                    </td>
                    <td>
                      <span className={`state state-${meta.tone}`}>
                        <span aria-hidden="true">{meta.icon}</span> {meta.label}
                      </span>
                    </td>
                    <td className="num muted">{Math.round(s.confidence * 100)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {report.priceChanges.length > 0 ? (
        <section className="panel">
          <h2>Price changes</h2>
          <p className="hint">
            Confirmed by a following charge, so one-off prorations do not appear. Foreign-currency
            subscriptions need a 5% move to count, because exchange rates alone shift them a few
            percent every month.
          </p>
          <ul className="list">
            {report.priceChanges.map((p) => {
              const up = p.toMinor > p.fromMinor;
              const pct = Math.round(((p.toMinor - p.fromMinor) / p.fromMinor) * 100);
              return (
                <li key={p.merchantKey}>
                  <span className="who">{p.merchantName}</span>
                  <span className={`delta ${up ? 'up' : 'down'}`}>
                    <span aria-hidden="true">{up ? '▲' : '▼'}</span> {Math.abs(pct)}%
                  </span>
                  <span className="ci">
                    {formatMoney(p.fromMinor, p.currency)} → {formatMoney(p.toMinor, p.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <footer className="page-foot">
        <p>All figures come from your own inbox and never left this machine.</p>
        <p>
          This shows what you were <em>charged</em>. It cannot tell you what you <em>use</em>, or who
          signed up for it.
        </p>
        <button type="button" className="btn subtle" onClick={() => void onRefresh()}>
          Recalculate
        </button>
      </footer>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}
