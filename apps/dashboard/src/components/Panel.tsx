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

function renderLabel(dim: string, value: string, label?: string): ReactNode {
  // A Search Ads name, with its id muted after it.
  if (label)
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{label}</span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{value}</span>
      </span>
    );
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

const trialTitle = (trials: number, converted: number) =>
  trials || converted ? `${number(trials)} started a trial, ${number(converted)} converted to paid` : undefined;

function Skeleton() {
  return (
    <div className="space-y-1" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** One tab's rows. Mounted per tab (keyed), so each tab fetches on first selection and never shows another tab's rows. */
function PanelBody({ appId, q, tab, reloadKey, onPick }: { appId: string; q: QueryState; tab: TabDef; reloadKey: number; onPick?: (dim: string, value: string, label?: string) => void }) {
  const [retry, setRetry] = useState(0);
  const { data, loading, error } = useApi<BreakdownRow[]>(`/api/apps/${appId}/stats/breakdown?${toSearch(q)}&dim=${encodeURIComponent(tab.dim)}`, reloadKey + retry);
  const max = Math.max(1, ...(data ?? []).map((r) => r.installs));
  const active = q.filters[tab.dim];
  const clickable = Boolean(tab.filterable && onPick);

  if (error)
    return (
      <div className="p-3 text-sm text-red-600" role="alert">
        {error}{' '}
        <button className="btn ml-2" onClick={() => setRetry((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  if (!data) return <Skeleton />;
  if (data.length === 0) return <p className="flex h-full min-h-[300px] items-center justify-center p-6 text-center text-sm text-muted-foreground">No data for this period</p>;

  return (
    <div className={`space-y-1 ${loading ? 'opacity-60' : ''}`}>
      {data.slice(0, 10).map((r) => {
        const inner = (
          <>
            <span className="absolute inset-0 flex">
              <span className="rounded-lg bg-installsSoft transition-all" style={{ width: `${(r.installs / max) * 100}%`, minWidth: r.installs ? 4 : 0 }} />
            </span>
            <span className="relative flex min-w-0 flex-1 items-center gap-2.5 px-3 text-left text-sm">{renderLabel(tab.dim, r.value, r.label)}</span>
            <span className="relative flex shrink-0 items-center gap-3 pr-3 text-sm font-medium">
              <span className="w-16 text-right text-sm font-normal text-revenue">{r.revenue !== 0 ? money(r.revenue) : ''}</span>
              {tab.filterable && (
                <span className="w-12 text-right font-normal" title={trialTitle(r.trials, r.trialsConverted)}>
                  {r.trials ? number(r.trials) : ''}
                </span>
              )}
              <span className="w-10 text-right">{number(r.installs)}</span>
            </span>
          </>
        );
        const cls = 'group relative flex h-10 w-full items-center rounded-lg';
        return clickable ? (
          <button
            key={r.value}
            type="button"
            className={`${cls} transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === r.value ? 'ring-2 ring-primary/30' : ''}`}
            aria-pressed={active === r.value}
            title={active === r.value ? `Remove filter ${r.label ?? r.value}` : `Filter by ${r.label ?? r.value}`}
            onClick={() => onPick?.(tab.dim, r.value, r.label)}
          >
            {inner}
          </button>
        ) : (
          <div key={r.value} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** Tabbed breakdown card (installs bars with revenue and, for install dimensions, trials), fed by /api/apps/:id/stats/breakdown. */
export function Panel({ appId, q, tabs, reloadKey = 0, onPick }: { appId: string; q: QueryState; tabs: TabDef[]; reloadKey?: number; onPick?: (dim: string, value: string, label?: string) => void }) {
  const [active, setActive] = useState(tabs[0]!.dim);
  // Falls back to the first tab when `active` is no longer among `tabs` (the tab set changed).
  const tab = tabs.find((t) => t.dim === active) ?? tabs[0]!;

  return (
    <section className="card flex min-h-[440px] flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="tabs min-w-0 overflow-x-auto" role="tablist">
          {tabs.map((t) => (
            <button key={t.dim} role="tab" aria-selected={t.dim === active} className={`tab whitespace-nowrap ${t.dim === active ? 'tab-active' : ''}`} onClick={() => setActive(t.dim)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex shrink-0 items-center gap-3 pr-2 text-xs font-medium text-muted-foreground">
          {tab.filterable && <span className="w-12 text-right">Trials</span>}
          <span className="w-10 text-right">Installs</span>
        </span>
      </div>
      <div className="flex-1 p-2">
        <PanelBody key={tab.dim} appId={appId} q={q} tab={tab} reloadKey={reloadKey} onPick={onPick} />
      </div>
    </section>
  );
}
