import type { AnalyticsReport } from './report.js';
import { formatMoney } from '../parsing/money.js';
import { monthlyEquivalentMinor, cadenceLabel } from '../subscriptions/detect.js';

/**
 * Renders the report as a single self-contained HTML file.
 *
 * No external requests of any kind — no CDN, no fonts, no images. This file
 * contains someone's financial history, so it must be safe to open offline and
 * incapable of phoning anywhere. All values are HTML-escaped on the way in for
 * the same reason the parser is careful: merchant strings originate in email.
 */

const esc = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Status marks pair an icon with a label — colour never carries meaning alone. */
const STATE_META: Record<string, { label: string; icon: string; tone: string }> = {
  active: { label: 'Active', icon: '●', tone: 'good' },
  provisional: { label: 'Provisional', icon: '◐', tone: 'muted' },
  overdue: { label: 'Overdue', icon: '▲', tone: 'warning' },
  likely_cancelled: { label: 'Likely cancelled', icon: '■', tone: 'critical' },
};

function shortMonth(month: string): string {
  const [y, m] = month.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1] ?? m} ${(y ?? '').slice(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${names[d.getUTCMonth()]}`;
}

// ── Charts ─────────────────────────────────────────────────────────────────
// Hand-built SVG rather than a charting library: it keeps the output
// dependency-free and self-contained, which matters more here than the
// convenience would.

function lineChart(report: AnalyticsReport): string {
  const points = report.monthlySpend;
  if (points.length < 2) {
    return `<p class="empty">Not enough history yet — at least two months of transactions are needed to draw a trend.</p>`;
  }

  const W = 720;
  const H = 240;
  const PAD = { top: 16, right: 16, bottom: 28, left: 64 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const max = Math.max(...points.map((p) => p.totalMinor));
  // Head-room so the peak never touches the frame.
  const yMax = max * 1.15 || 1;

  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.totalMinor).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

  // Four recessive gridlines is enough to read a value against.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const grid = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${W - PAD.right}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="axis" x="${PAD.left - 10}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(
          compact(t, report.homeCurrency),
        )}</text>`,
    )
    .join('');

  // Label first, last and middle only — a label on every point is noise.
  const labelIndices = new Set([0, points.length - 1, Math.floor((points.length - 1) / 2)]);
  const xLabels = points
    .map((p, i) =>
      labelIndices.has(i)
        ? `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(shortMonth(p.month))}</text>`
        : '',
    )
    .join('');

  const dots = points
    .map(
      (p, i) =>
        `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.totalMinor).toFixed(1)}" r="4"
           data-label="${esc(shortMonth(p.month))}"
           data-value="${esc(formatMoney(p.totalMinor, report.homeCurrency))}"
           data-sub="${p.transactionCount} transactions"/>`,
    )
    .join('');

  return `
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spend over time">
    ${grid}
    <path class="area" d="${areaPath}"/>
    <path class="line" d="${linePath}"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

function compact(minor: number, currency: string): string {
  const major = minor / 100;
  if (major >= 1_000_000) return `${(major / 1_000_000).toFixed(1)}M`;
  if (major >= 1000) return `${Math.round(major / 1000)}k`;
  return String(Math.round(major));
}

function barList(
  rows: { label: string; valueMinor: number; note?: string }[],
  currency: string,
): string {
  if (rows.length === 0) return `<p class="empty">Nothing to show yet.</p>`;
  const max = Math.max(...rows.map((r) => r.valueMinor)) || 1;

  return `<div class="bars">${rows
    .map((r) => {
      const pct = (r.valueMinor / max) * 100;
      return `
      <div class="bar-row" tabindex="0" data-label="${esc(r.label)}" data-value="${esc(
        formatMoney(r.valueMinor, currency),
      )}"${r.note ? ` data-sub="${esc(r.note)}"` : ''}>
        <div class="bar-label">${esc(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-value">${esc(formatMoney(r.valueMinor, currency))}</div>
      </div>`;
    })
    .join('')}</div>`;
}

// ── Page ───────────────────────────────────────────────────────────────────

export function renderReportHtml(report: AnalyticsReport): string {
  const heroValue = formatMoney(report.monthlyCommitmentMinor, report.homeCurrency);

  const tiles = [
    { label: 'Recurring per month', value: heroValue, sub: `${formatMoney(report.annualCommitmentMinor, report.homeCurrency)} per year` },
    { label: 'Subscriptions found', value: String(report.subscriptions.length), sub: `${report.activeCount} active · ${report.provisionalCount} provisional` },
    { label: 'Due in next 30 days', value: String(report.upcoming.length), sub: report.upcoming[0] ? `next: ${esc(report.upcoming[0].merchantName)}` : 'nothing scheduled' },
    { label: 'Emails read', value: String(report.totals.emails), sub: `${report.totals.unparsedEmails} not yet parsed` },
  ];

  const subsRows = report.subscriptions
    .map((s) => {
      const meta = STATE_META[s.state] ?? STATE_META['active']!;
      const cadence = cadenceLabel(s.cadence);
      const monthly = monthlyEquivalentMinor(s);
      const lowConfidence = s.confidence < 0.5;

      return `<tr${lowConfidence ? ' class="low-confidence"' : ''}>
        <td class="merchant">
          ${esc(s.merchantName)}
          ${s.category ? `<span class="tag">${esc(s.category)}</span>` : ''}
        </td>
        <td class="num">${esc(formatMoney(s.amountMedianMinor, s.currency))}</td>
        <td>${esc(cadence)}</td>
        <td class="num">${esc(formatMoney(monthly, s.currency))}</td>
        <td>${esc(formatDate(s.nextDueAt))} <span class="ci">±${s.nextDueCiDays}d</span></td>
        <td><span class="state state-${esc(meta.tone)}"><span aria-hidden="true">${meta.icon}</span> ${esc(meta.label)}</span></td>
        <td class="num conf">${Math.round(s.confidence * 100)}%</td>
        <td class="cards">${s.observedLast4.map((c) => `••${esc(c)}`).join(' ') || '—'}</td>
      </tr>`;
    })
    .join('');

  const upcomingRows = report.upcoming
    .map(
      (u) => `<li>
        <span class="when">${u.daysAway === 0 ? 'today' : `in ${u.daysAway}d`}</span>
        <span class="who">${esc(u.merchantName)}</span>
        <span class="how-much">${esc(formatMoney(u.amountMinor, u.currency))}</span>
        <span class="ci">${esc(formatDate(u.dueAt))} ±${u.ciDays}d</span>
      </li>`,
    )
    .join('');

  const priceRows = report.priceChanges
    .map((p) => {
      const up = p.toMinor > p.fromMinor;
      const pct = Math.round(((p.toMinor - p.fromMinor) / p.fromMinor) * 100);
      return `<li>
        <span class="who">${esc(p.merchantName)}</span>
        <span class="delta ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span> ${Math.abs(pct)}%</span>
        <span class="ci">${esc(formatMoney(p.fromMinor, p.currency))} → ${esc(formatMoney(p.toMinor, p.currency))}, ${esc(formatDate(p.effectiveAt))}</span>
      </li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expense Tracker — your subscriptions</title>
<style>
:root {
  color-scheme: light dark;
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --baseline: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6;
  --series-1-soft: rgba(42,120,214,0.12);
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --success-text: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-1-soft: rgba(57,135,229,0.16);
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
    --success-text: #0ca30c;
  }
}
:root[data-theme="dark"] {
  --surface-1: #1a1a19; --page: #0d0d0d; --text-primary: #ffffff;
  --text-secondary: #c3c2b7; --grid: #2c2c2a; --baseline: #383835;
  --border: rgba(255,255,255,0.10); --series-1: #3987e5;
  --series-1-soft: rgba(57,135,229,0.16); --success-text: #0ca30c;
}

* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 24px 64px;
  background: var(--page); color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; line-height: 1.5;
}
.wrap { max-width: 1080px; margin: 0 auto; }
header { margin-bottom: 28px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 13px; }

.hero { margin: 28px 0 8px; }
.hero .figure { font-size: 52px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.05; }
.hero .caption { color: var(--text-secondary); font-size: 14px; margin-top: 2px; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 24px 0 32px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile .label { color: var(--text-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.tile .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
.tile .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
section h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
section .hint { color: var(--muted); font-size: 12px; margin: 0 0 16px; }

.chart { width: 100%; height: auto; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area { fill: var(--series-1-soft); stroke: none; }
.dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; cursor: pointer; }
.dot:hover, .dot:focus { r: 6; }

.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: 150px 1fr 110px; align-items: center; gap: 12px; cursor: default; border-radius: 6px; }
.bar-row:focus { outline: 2px solid var(--series-1); outline-offset: 2px; }
.bar-label { color: var(--text-secondary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { background: var(--grid); border-radius: 4px; height: 14px; }
.bar-fill { background: var(--series-1); border-radius: 4px; height: 100%; min-width: 2px; }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--text-secondary); font-weight: 500; font-size: 12px;
     text-transform: uppercase; letter-spacing: 0.04em; padding: 0 10px 8px 0; border-bottom: 1px solid var(--border); }
td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr.low-confidence td { opacity: 0.62; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.merchant { font-weight: 550; }
.tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
       background: var(--grid); color: var(--text-secondary); font-size: 11px; font-weight: 400; }
.ci { color: var(--muted); font-size: 12px; }
.conf { color: var(--text-secondary); }
.cards { color: var(--muted); font-variant-numeric: tabular-nums; }
.state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; }
.state-good span { color: var(--good); }
.state-warning span { color: var(--warning); }
.state-critical span { color: var(--critical); }
.state-muted span { color: var(--muted); }

ul.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
ul.list li { display: grid; grid-template-columns: 70px 1fr auto auto; gap: 12px; align-items: baseline;
             padding: 8px 0; border-bottom: 1px solid var(--border); }
ul.list li:last-child { border-bottom: none; }
.when { color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.who { font-weight: 550; }
.how-much { font-variant-numeric: tabular-nums; }
.delta.up { color: var(--critical); }
.delta.down { color: var(--success-text); }
.empty { color: var(--muted); font-size: 13px; margin: 0; }
.scroll { overflow-x: auto; }

#tip { position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
       background: var(--text-primary); color: var(--surface-1); padding: 6px 9px;
       border-radius: 6px; font-size: 12px; line-height: 1.35; z-index: 10; max-width: 240px; }
#tip .t-label { font-weight: 600; }
#tip .t-sub { opacity: 0.75; }

footer { color: var(--muted); font-size: 12px; margin-top: 28px; }
footer p { margin: 4px 0; }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Your subscriptions</h1>
  <p class="meta">Generated ${esc(report.generatedAt.slice(0, 16).replace('T', ' '))} UTC ·
     ${report.totals.transactions} transactions (${report.totals.afterDedup} after collapsing authorisation/settlement pairs)</p>
</header>

<div class="hero">
  <div class="figure">${esc(heroValue)}</div>
  <div class="caption">committed every month across ${report.subscriptions.length} recurring charge${
    report.subscriptions.length === 1 ? '' : 's'
  }</div>
</div>

<div class="tiles">
  ${tiles
    .map(
      (t) => `<div class="tile">
    <div class="label">${esc(t.label)}</div>
    <div class="value">${t.value}</div>
    <div class="sub">${t.sub}</div>
  </div>`,
    )
    .join('')}
</div>

<section>
  <h2>Spending over time</h2>
  <p class="hint">${esc(report.homeCurrency)} transactions only — foreign-currency charges are listed per subscription rather than converted, since a made-up exchange rate would make this total confidently wrong.</p>
  ${lineChart(report)}
</section>

<section>
  <h2>Where the money goes</h2>
  <p class="hint">By category, across all ${esc(report.homeCurrency)} transactions.</p>
  ${barList(
    report.byCategory.map((c) => ({
      label: c.category,
      valueMinor: c.totalMinor,
      note: `${Math.round(c.share * 100)}% of tracked spend`,
    })),
    report.homeCurrency,
  )}
</section>

${
  report.byCard.length > 0
    ? `<section>
  <h2>By card</h2>
  <p class="hint">Which card each charge landed on. A card cannot tell you which device or person made a purchase — recurring charges carry no device information at all.</p>
  ${barList(
    report.byCard.map((c) => ({
      label: `•• ${c.last4}`,
      valueMinor: c.totalMinor,
      note: `${c.subscriptionCount} subscription${c.subscriptionCount === 1 ? '' : 's'}`,
    })),
    report.homeCurrency,
  )}
</section>`
    : ''
}

<section>
  <h2>Every recurring charge</h2>
  <p class="hint">Faded rows are below 50% confidence — shown so you can confirm or dismiss them, not asserted as fact.</p>
  <div class="scroll">
  <table>
    <thead><tr>
      <th>Merchant</th><th class="num">Amount</th><th>Cadence</th><th class="num">Per month</th>
      <th>Next due</th><th>State</th><th class="num">Confidence</th><th>Card</th>
    </tr></thead>
    <tbody>${subsRows || '<tr><td colspan="8" class="empty">No recurring charges detected yet.</td></tr>'}</tbody>
  </table>
  </div>
</section>

<section>
  <h2>Coming up in the next 30 days</h2>
  <p class="hint">Predicted from observed billing dates, with the uncertainty shown. Never a bare date.</p>
  <ul class="list">${upcomingRows || '<li class="empty">Nothing predicted in the next 30 days.</li>'}</ul>
</section>

${
  report.priceChanges.length > 0
    ? `<section>
  <h2>Price changes</h2>
  <p class="hint">Confirmed by a following charge, so one-off prorations do not appear. Foreign-currency subscriptions need a 5% move to count, because exchange rates alone shift them a few percent every month.</p>
  <ul class="list">${priceRows}</ul>
</section>`
    : ''
}

<footer>
  <p>All figures come from your own inbox and never left this machine.</p>
  <p>This report shows what you were <em>charged</em>. It cannot tell you what you <em>use</em>, or who signed up for it.</p>
</footer>

</div>
<div id="tip" role="status" aria-live="polite"></div>

<script>
// Hover layer. An HTML chart is interactive by default; a static one is a
// screenshot that happens to be in a browser.
(function () {
  var tip = document.getElementById('tip');
  function show(el, e) {
    var label = el.getAttribute('data-label');
    if (!label) return;
    var value = el.getAttribute('data-value') || '';
    var sub = el.getAttribute('data-sub');
    tip.innerHTML = '<div class="t-label">' + label + '</div><div>' + value + '</div>' +
                    (sub ? '<div class="t-sub">' + sub + '</div>' : '');
    tip.style.opacity = '1';
    move(e);
  }
  function move(e) {
    var pad = 14;
    var x = (e.clientX || 0) + pad;
    var y = (e.clientY || 0) + pad;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = (e.clientX || 0) - r.width - pad;
    if (y + r.height > window.innerHeight) y = (e.clientY || 0) - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hide() { tip.style.opacity = '0'; }

  document.querySelectorAll('[data-label]').forEach(function (el) {
    el.addEventListener('mouseenter', function (e) { show(el, e); });
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', function (e) {
      var r = el.getBoundingClientRect();
      show(el, { clientX: r.left + r.width / 2, clientY: r.top });
    });
    el.addEventListener('blur', hide);
  });
})();
</script>
</body>
</html>`;
}
