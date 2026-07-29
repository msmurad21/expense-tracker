import { formatMoney } from '../../main/parsing/money.js';
import type { JSX } from 'react';

/**
 * Horizontal bars for magnitude comparison. Length carries the value, so every
 * bar shares one hue — shading by rank would encode the same thing twice and
 * would repaint when a filter changes the ordering.
 */
export function BarList({
  rows,
  currency,
}: {
  rows: { label: string; valueMinor: number; note?: string }[];
  currency: string;
}): JSX.Element {
  if (rows.length === 0) return <p className="muted">Nothing to show yet.</p>;
  const max = Math.max(...rows.map((r) => r.valueMinor)) || 1;

  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <div className="bar-label" title={r.label}>{r.label}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.valueMinor / max) * 100}%` }} />
          </div>
          <div className="bar-value">
            {formatMoney(r.valueMinor, currency)}
            {r.note ? <span className="muted small"> {r.note}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
