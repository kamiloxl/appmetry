import { useState, type ReactNode } from 'react';
import { number, money } from '../lib/format';
import { toSearch, type QueryState } from '../lib/query';
import type { BreakdownRow } from '../lib/types';
import { useApi } from '../lib/useApi';
import { ChannelIcon, Flag, PlatformIcon } from './Icons';

export interface TabDef {
  label: string;
  /** Breakdown dimension, e.g. channel, source, campaign, platform, country, screen, event. */
  dim: string;
  /** True when a click on a row may filter the page (install-level dimensions only). */
  filterable?: boolean;
}

function renderLabel(dim: string, value: string): ReactNode {
  const text = <span className="truncate">{value}</span>;
  switch (dim) {
    case 'channel':
      return (
        <>
          <ChannelIcon channel={value} />
          {text}
        </>
      );
    case 'platform':
      return (
        <>
          <PlatformIcon platform={value} />
          {text}
        </>
      );
    case 'country':
      return (
        <>
          <Flag cc={value} />
          {text}
        </>
      );
    default:
      return text;
  }
}

/** Tabbed breakdown card (installs bars with revenue), fed by /api/apps/:id/stats/breakdown. */
export function Panel({ appId, q, tabs, reloadKey = 0, onPick }: { appId: string; q: QueryState; tabs: TabDef[]; reloadKey?: number; onPick?: (dim: string, value: string) => void }) {
  const [active, setActive] = useState(tabs[0]!.dim);
  const tab = tabs.find((t) => t.dim === active)!;
  const { data, loading, error } = useApi<BreakdownRow[]>(`/api/apps/${appId}/stats/breakdown?${toSearch(q)}&dim=${encodeURIComponent(active)}`, reloadKey);
  const max = Math.max(1, ...(data ?? []).map((r) => r.installs));
  const hasRevenue = (data ?? []).some((r) => r.revenue !== 0);

  return (
    <div className="card flex min-h-[420px] flex-col p-3">
      <div className="flex items-center justify-between gap-2 pb-3">
        <div className="tabs overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.dim} className={`tab whitespace-nowrap ${t.dim === active ? 'tab-active' : ''}`} onClick={() => setActive(t.dim)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="shrink-0 px-2 text-sm font-medium text-stone-600">Installs</span>
      </div>
      <div className={`flex-1 space-y-1 ${loading && !data ? 'animate-pulse' : ''}`}>
        {error && <p className="p-3 text-sm text-red-600">{error}</p>}
        {data && data.length === 0 && <p className="p-6 text-center text-sm text-stone-400">No data for this period</p>}
        {data?.slice(0, 10).map((r) => (
          <div
            key={r.value}
            className={`group relative flex h-10 items-center rounded-lg ${tab.filterable && onPick ? 'cursor-pointer' : ''}`}
            onClick={() => tab.filterable && onPick?.(tab.dim, r.value)}
          >
            <div className="absolute inset-0 flex">
              <div className="rounded-lg bg-installsSoft transition-all" style={{ width: `${(r.installs / max) * 100}%`, minWidth: r.installs ? 4 : 0 }} />
            </div>
            <div className="relative flex min-w-0 flex-1 items-center gap-2.5 px-3 text-[15px]">{renderLabel(tab.dim, r.value)}</div>
            <div className="relative flex shrink-0 items-center gap-3 pr-3 text-[15px] font-medium">
              {hasRevenue && r.revenue !== 0 && <span className="text-sm font-normal text-revenue">{money(r.revenue)}</span>}
              {number(r.installs)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
