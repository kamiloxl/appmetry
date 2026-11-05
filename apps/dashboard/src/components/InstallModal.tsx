import { friendlyName } from '@appdash/shared';
import { duration, money } from '../lib/format';
import { groupByDay, KIND_META } from '../lib/timeline';
import type { Customer, InstallDetail } from '../lib/types';
import { useApi } from '../lib/useApi';
import { Avatar } from './Icons';
import { Modal } from './Modal';

const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const asText = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Read-only journey of one install. Fetches only while open (`customer` non-null); the parent keys it per install. */
export function InstallModal({ appId, customer, onClose }: { appId: string; customer: Customer | null; onClose: () => void }) {
  const url = customer ? `/api/apps/${appId}/installs/${encodeURIComponent(customer.installId)}` : null;
  const { data, error } = useApi<InstallDetail>(url);
  const p = customer ? friendlyName(customer.installId) : null;
  const groups = data ? groupByDay(data.timeline) : [];
  const facts = data
    ? [
        ['Platform', asText(data.install.platform)],
        ['Country', asText(data.install.country)],
        ['App version', asText(data.install.app_version)],
        ['Device', asText(data.install.device_model)],
      ].filter((f): f is [string, string] => f[1] !== null)
    : [];

  return (
    <Modal open={!!customer} onClose={onClose} width="max-w-3xl" title="Customer journey">
      {customer && p && (
        <div>
          <div className="flex items-center gap-4">
            <Avatar id={customer.installId} size={56} />
            <div className="min-w-0">
              <div className="truncate text-xl font-semibold">{customer.email ?? p.name}</div>
              {customer.email && <div className="text-sm text-stone-500">{p.name}</div>}
              {facts.length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-stone-500">{facts.map(([k, v]) => <span key={k}>{k}: {v}</span>)}</div>}
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total spent" value={money(customer.total)} accent />
            <Stat label="Payments" value={String(customer.payments)} />
            <Stat label="Source" value={customer.source ?? '(none)'} />
            <Stat label="Time to convert" value={duration(Math.max(0, customer.timeToConvertMs))} />
          </div>
          {error && <div className="mt-6 text-sm text-red-600" role="alert">Could not load the timeline: {error}</div>}
          {!data && !error && <div className="mt-6 h-60 animate-pulse rounded-xl bg-stone-50" />}
          {data && (
            <div className="mt-6 space-y-6" data-testid="timeline">
              {groups.map((g) => (
                <section key={g.key}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">{g.label}</h3>
                  <ol className="space-y-1.5 border-l-2 border-stone-100 pl-4">
                    {g.items.map((it, i) => {
                      const m = KIND_META[it.kind];
                      return (
                        <li key={`${it.ts}-${i}`} className="flex items-start gap-3 text-sm" data-kind={it.kind}>
                          <span className="w-20 shrink-0 text-xs leading-6 text-stone-400">{time.format(it.ts)}</span>
                          <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${m.color}`} title={m.name} aria-label={m.name}>
                            {m.icon}
                          </span>
                          <span className="min-w-0 leading-6">
                            <span className={it.kind === 'payment' ? 'font-semibold text-emerald-700' : 'text-stone-800'}>{it.label}</span>
                            {it.detail && <span className="ml-2 text-stone-400">{it.detail}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
              {data.timeline.length >= 500 && <div className="text-xs text-stone-400">Showing the newest 500 items.</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-stone-50 px-4 py-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className={`mt-0.5 truncate font-semibold ${accent ? 'text-emerald-700' : ''}`}>{value}</div>
    </div>
  );
}
