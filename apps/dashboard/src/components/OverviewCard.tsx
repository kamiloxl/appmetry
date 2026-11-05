import { duration, money, number, pct, pctChange } from '../lib/format';
import type { Overview, Totals } from '../lib/types';

function Change({ cur, prev }: { cur: number; prev: number }) {
  const c = pctChange(cur, prev);
  if (c === null) return <span className="text-xs text-stone-400">{pct(null)}</span>;
  return <span className={`text-xs ${c >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{pct(c)}</span>;
}

const KPIS: { key: keyof Totals; label: string; format: (v: number) => string; dot?: string }[] = [
  { key: 'installs', label: 'Installs', format: number, dot: 'bg-installs' },
  { key: 'activeUsers', label: 'Active users', format: number },
  { key: 'sessions', label: 'Sessions', format: number },
  { key: 'revenue', label: 'Revenue', format: money, dot: 'bg-revenue' },
  { key: 'conversionRate', label: 'Conversion', format: (v) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%` },
  { key: 'revenuePerInstall', label: 'Revenue/install', format: money },
  { key: 'avgSessionMs', label: 'Avg session', format: duration },
];

/** The seven KPI cards of the Overview page, each with its change against the previous period. */
export function OverviewCard({ data, stale = false }: { data: Overview | null; stale?: boolean }) {
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7 ${stale ? 'opacity-60' : ''}`} aria-busy={stale}>
      {data
        ? KPIS.map((k) => (
            <div key={k.key} className="card px-4 py-3" data-testid={`card-${k.key}`}>
              <div className="flex items-center gap-1.5 text-sm text-stone-500">
                {k.dot && <span className={`h-2.5 w-2.5 rounded-sm ${k.dot}`} />}
                {k.label}
              </div>
              <div className="mt-1 text-2xl font-semibold leading-tight tracking-tight">{k.format(data.current[k.key])}</div>
              <Change cur={data.current[k.key]} prev={data.previous[k.key]} />
            </div>
          ))
        : KPIS.map((k) => <div key={k.key} className="card h-[92px] animate-pulse bg-stone-50" />)}
    </div>
  );
}
