import { useCallback, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Chart } from '../components/Chart';
import { FilterBar } from '../components/FilterBar';
import { OverviewCard } from '../components/OverviewCard';
import { Panel, type TabDef } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { toggleFilter } from '../lib/filters';
import { fromSearch, toSearch, type QueryState } from '../lib/query';
import type { Overview as OverviewData } from '../lib/types';
import { useApi } from '../lib/useApi';

export { toggleFilter };

const f = (label: string, dim: string): TabDef => ({ label, dim, filterable: true });
const GROUPS: TabDef[][] = [
  [f('Channel', 'channel'), f('Source', 'source'), f('Campaign', 'campaign'), f('Search Ads', 'asa_campaign_id')],
  [f('Platform', 'platform'), f('Country', 'country'), f('App version', 'app_version'), f('OS', 'os_version'), f('Device', 'device_model')],
  // The server ignores screen and event as filters, so these rows are plain.
  [
    { label: 'Screens', dim: 'screen' },
    { label: 'Events', dim: 'event' },
  ],
];

/** Range, interval and filters live in the URL (toSearch/fromSearch); changes replace the history entry's query. */
function useQueryState(): [QueryState, (p: Partial<QueryState>) => void] {
  const [params, setParams] = useSearchParams();
  const q = useMemo(() => fromSearch(params.toString()), [params]);
  const update = useCallback(
    (p: Partial<QueryState>) => setParams(toSearch({ ...q, ...p }), { replace: true }),
    [q, setParams],
  );
  return [q, update];
}

export function Overview() {
  const { id = '' } = useParams();
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const [retry, setRetry] = useState(0);
  const { data, error, loading } = useApi<OverviewData>(`/api/apps/${id}/stats/overview?${toSearch(q)}`, reloadKey + retry);

  const pick = (dim: string, value: string) => update({ filters: toggleFilter(q.filters, dim, value) });
  const remove = (dim: string) => {
    const filters = { ...q.filters };
    delete filters[dim];
    update({ filters });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Toolbar q={q} update={update} onRefresh={() => setReloadKey((k) => k + 1)} loading={loading} />
        <FilterBar filters={q.filters} onRemove={remove} />
      </div>
      {error ? (
        <div className="card p-6 text-sm text-red-600" role="alert">
          Could not load the overview: {error}
          <button className="btn ml-3" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <OverviewCard data={data} stale={loading && data !== null} />
          <Chart series={data?.series ?? null} stale={loading && data !== null} />
        </>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((tabs) => (
          <Panel key={tabs[0]!.dim} appId={id} q={q} tabs={tabs} reloadKey={reloadKey} onPick={pick} />
        ))}
      </div>
    </div>
  );
}
