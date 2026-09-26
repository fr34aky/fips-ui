import { useState } from 'react';
import { fmtNum } from '../lib/format';

/** Flat key/number object rendered as a two-column table, non-zero rows emphasized. */
export function CounterTable({ data, compact = false, filter = '' }: { data: Record<string, unknown>; compact?: boolean; filter?: string }) {
  const [showZero, setShowZero] = useState(false);
  const entries = Object.entries(data ?? {}).filter(([k, v]) => typeof v === 'number' && (!filter || k.toLowerCase().includes(filter.toLowerCase()))) as [string, number][];
  const nonZero = entries.filter(([, v]) => v !== 0);
  const rows = showZero || nonZero.length === 0 ? entries : nonZero;
  const hidden = entries.length - rows.length;
  if (!entries.length) return <div className="px-4 py-3 text-xs text-ink-3">No counters.</div>;
  return (
    <div>
      <table className="data"><tbody>
        {rows.map(([k, v]) => <tr key={k}><td className={`${compact ? 'py-1.5' : ''} text-ink-2`}>{k.replace(/_/g, ' ')}</td><td className={`num font-medium ${compact ? 'py-1.5' : ''} ${v === 0 ? 'text-ink-3' : k.includes('error') || k.includes('drop') || k.includes('fail') || k.includes('invalid') || k.includes('exhaust') ? 'text-crit' : ''}`}>{fmtNum(v)}</td></tr>)}
      </tbody></table>
      {hidden > 0 && <button className="btn ghost sm w-full rounded-none" onClick={() => setShowZero(true)}>Show {hidden} zero counter{hidden === 1 ? '' : 's'}</button>}
      {showZero && nonZero.length > 0 && hidden === 0 && entries.length !== nonZero.length && <button className="btn ghost sm w-full rounded-none" onClick={() => setShowZero(false)}>Hide zero counters</button>}
    </div>
  );
}
