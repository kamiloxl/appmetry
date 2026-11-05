import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { duration, money, number, pct, pctChange } from '../lib/format';
import type { Overview, Totals } from '../lib/types';
import { cn } from '../lib/utils';

function Change({ cur, prev }: { cur: number; prev: number }) {
  const c = pctChange(cur, prev);
  if (c === null) return <span className="text-xs text-muted-foreground">{pct(null)}</span>;
  const up = c >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', up ? 'text-emerald-700' : 'text-red-600')}>
      <Icon className="size-3.5" aria-hidden="true" />
      {pct(c)}
      <span className="font-normal text-muted-foreground">&nbsp;vs prev.</span>
    </span>
  );
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

/** The seven KPIs of the Overview page as one strip, each with its change against the previous period. */
export function OverviewCard({ data, stale = false }: { data: Overview | null; stale?: boolean }) {
  return (
    <section className={cn('card overflow-hidden transition-opacity', stale && 'opacity-60')} aria-busy={stale || !data} aria-label="Key metrics">
      {/* Cells draw their right and bottom borders; the negative margin tucks the outer ones under the card edge. */}
      <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
        {KPIS.map((k) => (
          <div key={k.key} className="min-w-0 border-b border-r px-4 py-3.5" data-testid={data ? `card-${k.key}` : undefined}>
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {k.dot && <span className={cn('size-2 rounded-sm', k.dot)} aria-hidden="true" />}
              <span className="truncate">{k.label}</span>
            </div>
            {data ? (
              <>
                <div className="mt-1.5 truncate text-[22px] font-semibold leading-tight tracking-tight">{k.format(data.current[k.key])}</div>
                <div className="mt-1">
                  <Change cur={data.current[k.key]} prev={data.previous[k.key]} />
                </div>
              </>
            ) : (
              <div className="mt-2 space-y-2" aria-hidden="true">
                <div className="h-6 w-20 animate-pulse rounded bg-muted" />
                <div className="h-3 w-14 animate-pulse rounded bg-muted" />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
