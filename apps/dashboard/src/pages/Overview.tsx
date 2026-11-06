import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Chart } from '../components/Chart';
import { FilterBar } from '../components/FilterBar';
import { OverviewCard } from '../components/OverviewCard';
import { Panel, type TabDef } from '../components/Panel';
import { Toolbar } from '../components/Toolbar';
import { toggleFilter } from '../lib/filters';
import { toSearch } from '../lib/query';
import type { Overview as OverviewData } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

export { toggleFilter };

const f = (label: string, dim: string): TabDef => ({ label, dim, filterable: true });
const GROUPS: TabDef[][] = [
  [f('Channel', 'channel'), f('Source', 'source'), f('Campaign', 'campaign')],
  // Apple Search Ads (AdServices) gives ids only, no names.
  [f('Search Ads campaign', 'asa_campaign_id'), f('Ad group', 'asa_adgroup_id'), f('Keyword', 'asa_keyword_id')],
  [f('Platform', 'platform'), f('Country', 'country'), f('App version', 'app_version'), f('OS', 'os_version'), f('Device', 'device_model')],
  // The server ignores screen and event as filters, so these rows are plain.
  [
    { label: 'Screens', dim: 'screen' },
    { label: 'Events', dim: 'event' },
  ],
];

export function Overview() {
  const { id = '' } = useParams();
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const [retry, setRetry] = useState(0);
  // Display names of picked filter values (Search Ads names), by dimension. Lost on reload; the chip then shows the id.
  const [labels, setLabels] = useState<Record<string, string>>({});
  const { data, error, loading } = useApi<OverviewData>(`/api/apps/${id}/stats/overview?${toSearch(q)}`, reloadKey + retry);

  const pick = (dim: string, value: string, label?: string) => {
    setLabels((l) => {
      const { [dim]: _, ...rest } = l;
      return label ? { ...rest, [dim]: label } : rest;
    });
    update({ filters: toggleFilter(q.filters, dim, value) });
  };
  const remove = (dim: string) => {
    const filters = { ...q.filters };
    delete filters[dim];
    update({ filters });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar filters={q.filters} labels={labels} onRemove={remove} hint="Click a row in any breakdown to filter" />
        <Toolbar q={q} update={update} onRefresh={() => setReloadKey((k) => k + 1)} loading={loading} />
      </div>
      {error ? (
        <div className="card flex flex-wrap items-center gap-3 p-6 text-sm text-red-600" role="alert">
          Could not load the overview: {error}
          <button className="btn" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <OverviewCard data={data} stale={loading && data !== null} />
          <Chart series={data?.series ?? null} stale={loading && data !== null} />
        </>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {GROUPS.map((tabs) => (
          <Panel key={tabs[0]!.dim} appId={id} q={q} tabs={tabs} reloadKey={reloadKey} onPick={pick} />
        ))}
      </div>
    </div>
  );
}
