import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { QueryState } from '../lib/query';
import { canShiftForward, shiftRange } from '../lib/shiftRange';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu';

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

const triggerCls =
  'flex h-full items-center gap-2 px-3 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent data-[state=open]:bg-accent';

/** Range, interval and refresh for the stats pages. State lives in the URL (see lib/query.ts). */
export function Toolbar({ q, update, onRefresh, loading, left }: { q: QueryState; update: (p: Partial<QueryState>) => void; onRefresh: () => void; loading: boolean; left?: ReactNode }) {
  const day = (t: number) => new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short' });
  const label =
    q.range === 'custom' && q.from !== undefined && q.to !== undefined
      ? `${day(q.from)} – ${day(q.to - 1)}`
      : (RANGE_OPTIONS.find((p) => p.value === q.range)?.label ?? (q.range === 'custom' ? 'Custom range' : 'Last 30 days'));
  const now = Date.now();
  const back = shiftRange(q, -1, now);
  const forward = canShiftForward(q, now) ? shiftRange(q, 1, now) : null;
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {left}
      <div className="flex h-9 items-stretch overflow-hidden rounded-lg border bg-card shadow-card">
        <button className="px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30" onClick={() => back && update(back)} disabled={!back} aria-label="Previous period">
          <ChevronLeft className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className={`${triggerCls} border-x`}>
            <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
            {label}
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={q.range} onValueChange={(v) => update({ range: v, from: undefined, to: undefined, interval: undefined })}>
              {RANGE_OPTIONS.map((p) => (
                <DropdownMenuRadioItem key={p.value} value={p.value}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button className="px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30" onClick={() => forward && update(forward)} disabled={!forward} aria-label="Next period">
          <ChevronRight className="size-4" />
        </button>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger className={`${triggerCls} h-9 rounded-lg border bg-card shadow-card`}>
          {INTERVAL_OPTIONS.find((g) => g.value === q.interval)?.label ?? 'Auto interval'}
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuRadioGroup value={q.interval ?? ''} onValueChange={(v) => update({ interval: v })}>
            {INTERVAL_OPTIONS.map((g) => (
              <DropdownMenuRadioItem key={g.value} value={g.value}>
                {g.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="icon" onClick={onRefresh} aria-label="Refresh">
        <RefreshCw className={loading ? 'animate-spin' : ''} />
      </Button>
    </div>
  );
}
