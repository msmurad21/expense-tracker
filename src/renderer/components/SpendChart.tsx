import { useState } from 'react';
import type { MonthlyPoint } from '../../main/analytics/report.js';
import { formatMoney } from '../../main/parsing/money.js';
import type { JSX } from 'react';

/**
 * Monthly spend. One series, so no legend — the heading names it. Hand-built
 * SVG keeps the app free of a charting dependency for a single line.
 */
export function SpendChart({
  points,
  currency,
}: {
  points: MonthlyPoint[];
  currency: string;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="muted">
        Not enough history yet — at least two months of transactions are needed to draw a trend.
      </p>
    );
  }

  const W = 720;
  const H = 240;
  const pad = { top: 16, right: 16, bottom: 28, left: 64 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const yMax = Math.max(...points.map((p) => p.totalMinor)) * 1.15 || 1;
  const x = (i: number) => pad.left + (i / (points.length - 1)) * plotW;
  const y = (v: number) => pad.top + plotH - (v / yMax) * plotH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.totalMinor).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${pad.top + plotH} L${pad.left},${pad.top + plotH} Z`;

  const compact = (minor: number) => {
    const major = minor / 100;
    if (major >= 1_000_000) return `${(major / 1_000_000).toFixed(1)}M`;
    if (major >= 1000) return `${Math.round(major / 1000)}k`;
    return String(Math.round(major));
  };

  const shortMonth = (month: string) => {
    const [yy, mm] = month.split('-');
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${names[Number(mm) - 1] ?? mm} ${(yy ?? '').slice(2)}`;
  };

  const labelled = new Set([0, points.length - 1, Math.floor((points.length - 1) / 2)]);

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly spend over time">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={pad.left} y1={y(f * yMax)} x2={W - pad.right} y2={y(f * yMax)} />
            <text className="axis" x={pad.left - 10} y={y(f * yMax) + 4} textAnchor="end">
              {compact(f * yMax)}
            </text>
          </g>
        ))}

        <path className="area" d={area} />
        <path className="line" d={line} />

        {points.map((p, i) => (
          <circle
            key={p.month}
            className="dot"
            cx={x(i)}
            cy={y(p.totalMinor)}
            r={hover === i ? 6 : 4}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}

        {points.map((p, i) =>
          labelled.has(i) ? (
            <text key={`l-${p.month}`} className="axis" x={x(i)} y={H - 8} textAnchor="middle">
              {shortMonth(p.month)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="chart-readout" aria-live="polite">
        {hover !== null && points[hover] ? (
          <>
            <strong>{shortMonth(points[hover]!.month)}</strong>{' '}
            {formatMoney(points[hover]!.totalMinor, currency)}{' '}
            <span className="muted">({points[hover]!.transactionCount} transactions)</span>
          </>
        ) : (
          <span className="muted">Hover a point for the month's total.</span>
        )}
      </div>
    </div>
  );
}
