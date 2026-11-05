import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { QueryState } from '../lib/query';

export const RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

const INTERVAL_OPTIONS = [
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

export function Dropdown({ button, children, align = 'left' }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div className="relative flex" ref={ref}>
      <div className="flex" onClick={() => setOpen((o) => !o)}>
        {button}
      </div>
      {open && (
        <div className={`card absolute top-full z-40 mt-2 min-w-[200px] overflow-hidden p-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-stone-400" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const itemCls = (active: boolean) =>
  `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600'}`;

/** Range, interval and refresh for the stats pages. State lives in the URL (see lib/query.ts). */
export function Toolbar({ q, update, onRefresh, loading, left }: { q: QueryState; update: (p: Partial<QueryState>) => void; onRefresh: () => void; loading: boolean; left?: ReactNode }) {
  const label = RANGE_OPTIONS.find((p) => p.value === q.range)?.label ?? (q.range === 'custom' ? 'Custom range' : 'Last 30 days');
  return (
    <div className="flex flex-wrap items-center gap-2">
      {left}
      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base">
            {label} <Chevron />
          </button>
        }
      >
        {(close) =>
          RANGE_OPTIONS.map((p) => (
            <button
              key={p.value}
              className={itemCls(q.range === p.value)}
              onClick={() => {
                close();
                update({ range: p.value, from: undefined, to: undefined, interval: undefined });
              }}
            >
              {p.label}
            </button>
          ))
        }
      </Dropdown>
      <Dropdown
        button={
          <button className="btn h-11 px-4 text-base">
            {INTERVAL_OPTIONS.find((g) => g.value === q.interval)?.label ?? 'Auto interval'} <Chevron />
          </button>
        }
      >
        {(close) =>
          INTERVAL_OPTIONS.map((g) => (
            <button
              key={g.value}
              className={itemCls(q.interval === g.value)}
              onClick={() => {
                close();
                update({ interval: g.value });
              }}
            >
              {g.label}
            </button>
          ))
        }
      </Dropdown>
      <button className="btn h-11 w-11 px-0" onClick={onRefresh} aria-label="Refresh">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''} aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
    </div>
  );
}
