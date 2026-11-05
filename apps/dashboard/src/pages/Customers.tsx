import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FilterBar } from '../components/FilterBar';
import { Avatar } from '../components/Icons';
import { InstallModal } from '../components/InstallModal';
import { Toolbar } from '../components/Toolbar';
import { api } from '../lib/api';
import { duration, money } from '../lib/format';
import { toSearch } from '../lib/query';
import { matchedByBadge, type BadgeTone } from '../lib/timeline';
import type { Customer, RematchResult } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

const TONES: Record<BadgeTone, string> = {
  good: 'bg-emerald-50 text-emerald-700',
  ok: 'bg-sky-50 text-sky-700',
  bad: 'bg-stone-100 text-stone-500',
};

export function Customers() {
  const { id = '' } = useParams();
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState<Customer | null>(null);
  const [rematch, setRematch] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; result?: RematchResult; error?: string }>({ state: 'idle' });
  const { data, error, loading } = useApi<Customer[]>(`/api/apps/${id}/stats/customers?${toSearch(q)}`, reloadKey);

  const remove = (dim: string) => {
    const filters = { ...q.filters };
    delete filters[dim];
    update({ filters });
  };

  async function tryMatching() {
    setRematch({ state: 'busy' });
    try {
      const result = await api<RematchResult>(`/api/apps/${id}/payments/rematch`, { method: 'POST' });
      setRematch({ state: 'done', result });
      if (result.matched > 0) setReloadKey((k) => k + 1);
    } catch (e) {
      setRematch({ state: 'error', error: e instanceof Error ? e.message : 'failed' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Toolbar q={q} update={update} onRefresh={() => setReloadKey((k) => k + 1)} loading={loading} />
        <FilterBar filters={q.filters} onRemove={remove} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" onClick={tryMatching} disabled={rematch.state === 'busy'}>
          {rematch.state === 'busy' ? 'Matching…' : 'Try matching again'}
        </button>
        <span className="text-sm text-stone-500" role="status">
          {rematch.state === 'done' && `Matched ${rematch.result!.matched} · ${rematch.result!.remaining} remaining`}
          {rematch.state === 'error' && <span className="text-red-600">Could not match: {rematch.error}</span>}
        </span>
      </div>
      {error ? (
        <div className="card p-6 text-sm text-red-600" role="alert">
          Could not load customers: {error}
          <button className="btn ml-3" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      ) : data && data.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-lg font-semibold">No paying customers in this range</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-stone-500">
            Customers appear once RevenueCat sends purchases to appmetry. Add the RevenueCat webhook in Settings, then widen the range or clear the filters.
          </p>
          <Link className="btn-dark mt-5" to={`/apps/${id}/settings`}>
            Open Settings
          </Link>
        </div>
      ) : (
        <div className={`card overflow-x-auto ${loading && data ? 'opacity-60' : ''}`}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-100 text-xs uppercase tracking-wide text-stone-400">
              <tr>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Payments</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Matched by</th>
                <th className="px-4 py-3 text-right font-medium">Time to convert</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-stone-400">Loading…</td>
                </tr>
              )}
              {data?.map((c) => {
                const badge = matchedByBadge(c.matchedBy);
                return (
                  <tr
                    key={c.installId}
                    className="cursor-pointer border-b border-stone-50 last:border-0 hover:bg-stone-50 focus:bg-stone-50 focus:outline-none"
                    tabIndex={0}
                    role="button"
                    onClick={() => setOpen(c)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpen(c);
                      }
                    }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar id={c.installId} size={32} />
                        <span className="truncate font-medium">{c.email ?? c.name}</span>
                      </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${c.total < 0 ? 'text-red-600' : ''}`}>{money(c.total)}</td>
                    <td className="px-4 py-3 text-right">{c.payments}</td>
                    <td className="px-4 py-3">
                      {c.source ?? '(none)'}
                      {c.channel && <span className="ml-1.5 text-stone-400">{c.channel}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs ${TONES[badge.tone]}`}>{badge.label}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-stone-600">{duration(Math.max(0, c.timeToConvertMs))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <InstallModal key={open?.installId ?? 'closed'} appId={id} customer={open} onClose={() => setOpen(null)} />
    </div>
  );
}
