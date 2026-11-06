import { ArrowRight, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Field, Section } from '../components/ui';
import { api } from '../lib/api';
import { dateLabel, dateTimeLabel, money } from '../lib/format';
import {
  activationBlockers, errorText, eventLabel, eventsManagerUrl, mappingPayload, mappingProblem, newRow, sameMappings, sourceOptions, toRows,
  type MappingRow,
} from '../lib/integrations';
import type { Delivery, EventCatalog, Integration, IntegrationList, SendScope, TestEventResult } from '../lib/types';
import { useApi } from '../lib/useApi';
import { StatusBadge } from './Integrations';

const CUSTOM = '__custom__';
const message = (e: unknown) => errorText(e instanceof Error ? e.message : 'failed');

/** Busy flag, error and "Saved" note for one form. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run(fn: () => Promise<void>, doneText = 'Saved') {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(doneText);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, run, clear: () => setDone(null) };
}

function Feedback({ a }: { a: ReturnType<typeof useAction> }) {
  if (a.error) return <span role="alert" className="text-sm text-red-600">{a.error}</span>;
  if (a.done) return <span role="status" className="text-sm text-emerald-700">{a.done}</span>;
  return null;
}

// ---------- Conversions API connection

function ConnectionSection({ it, appId, onChange }: { it: Integration; appId: string; onChange: (i: Integration) => void }) {
  const [datasetId, setDatasetId] = useState(it.dataset_id ?? '');
  const [datasetName, setDatasetName] = useState(it.dataset_name ?? '');
  const [token, setToken] = useState('');
  const [testCode, setTestCode] = useState(it.test_event_code ?? '');
  const a = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { dataset_id: datasetId.trim() || null, dataset_name: datasetName.trim() || null, test_event_code: testCode.trim() || null };
    if (token.trim()) body.token = token.trim();
    void a.run(async () => {
      onChange(await api<Integration>(`/api/apps/${appId}/integrations/${it.id}`, { method: 'PATCH', json: body }));
      setToken('');
    });
  }

  return (
    <Section
      title="Conversions API"
      description={
        <>
          The Meta dataset that receives your app events. Link the dataset to your app in{' '}
          <a className="underline" href="https://business.facebook.com/events_manager2" target="_blank" rel="noreferrer">
            Events Manager
          </a>{' '}
          first (Settings → Connected apps).
        </>
      }
    >
      <form onSubmit={submit} onChange={a.clear} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dataset ID" hint="Digits only, e.g. 1601828548167313.">
            <input className="input" inputMode="numeric" value={datasetId} onChange={(e) => setDatasetId(e.target.value)} pattern="\d{5,25}" placeholder="1601828548167313" />
          </Field>
          <Field label="Dataset name (optional)" hint="Only shown here, to tell datasets apart.">
            <input className="input" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} maxLength={100} placeholder="My app – iOS" />
          </Field>
          <Field
            label="Conversions API access token"
            hint={it.has_token ? 'A token is saved. Paste a new one to replace it.' : 'Events Manager → your dataset → Settings → Generate access token.'}
          >
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={it.has_token ? '•••••••••••••••• saved' : 'EAAG…'}
            />
          </Field>
          <Field label="Test event code (optional)" hint="Events Manager → Test events. While set, events show there; remove it for production.">
            <input className="input" value={testCode} onChange={(e) => setTestCode(e.target.value)} pattern="[A-Za-z0-9]{1,40}" placeholder="TEST12345" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-dark" type="submit" disabled={a.busy}>
            {a.busy ? 'Saving…' : 'Save'}
          </button>
          <Feedback a={a} />
        </div>
      </form>
    </Section>
  );
}

// ---------- event postbacks

function TargetSelect({ value, options, onChange, label }: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  const known = value === '' || options.includes(value);
  const [custom, setCustom] = useState(!known);
  if (custom) {
    return (
      <div className="flex gap-2">
        <input className="input" aria-label={label} value={value} maxLength={40} onChange={(e) => onChange(e.target.value)} placeholder="custom_event_name" />
        <button type="button" className="btn shrink-0" onClick={() => { setCustom(false); onChange(''); }}>
          List
        </button>
      </div>
    );
  }
  return (
    <select
      className="input"
      aria-label={label}
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setCustom(true);
          onChange('');
        } else onChange(e.target.value);
      }}
    >
      <option value="">Choose…</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      <option value={CUSTOM}>Custom event…</option>
    </select>
  );
}

function PostbacksSection({ it, appId, onChange }: { it: Integration; appId: string; onChange: (i: Integration) => void }) {
  const catalog = useApi<EventCatalog>(`/api/apps/${appId}/event-catalog`);
  const [scope, setScope] = useState<SendScope>(it.send_scope);
  const [rows, setRows] = useState<MappingRow[]>(() => toRows(it.mappings));
  const a = useAction();
  useEffect(() => setRows(toRows(it.mappings)), [it.mappings]);

  const builtin = catalog.data?.builtin ?? ['install'];
  const custom = catalog.data?.custom.map((c) => c.name) ?? [];
  const problem = mappingProblem(rows);
  const dirty = scope !== it.send_scope || !sameMappings(rows, it.mappings);
  const update = (key: string, patch: Partial<MappingRow>) => {
    a.clear();
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    void a.run(async () => {
      let next = it;
      if (scope !== it.send_scope) next = await api<Integration>(`/api/apps/${appId}/integrations/${it.id}`, { method: 'PATCH', json: { send_scope: scope } });
      if (!sameMappings(rows, it.mappings)) {
        next = await api<Integration>(`/api/apps/${appId}/integrations/${it.id}/mappings`, { method: 'PUT', json: { mappings: mappingPayload(rows) } });
      }
      onChange(next);
    });
  }

  return (
    <Section title="In-app event postbacks" description="Which app events Meta receives, and under which Meta event name. Campaigns can optimise for any of them.">
      <form onSubmit={submit} className="space-y-5">
        <Field
          label="Which events to send"
          hint={
            scope === 'all'
              ? 'All events from users with ad consent. Recommended: Meta does its own attribution, including views, and learns from every conversion.'
              : 'Only events from installs appmetry attributed to Meta (Meta link, fbclid or campaign ids).'
          }
        >
          <select className="input" value={scope} onChange={(e) => { a.clear(); setScope(e.target.value as SendScope); }}>
            <option value="all">All events</option>
            <option value="attributed">Attributed events only</option>
          </select>
        </Field>

        <div>
          <div className="mb-2 hidden grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-3 text-xs font-medium text-stone-500 sm:grid">
            <span>App event</span>
            <span />
            <span>Meta event</span>
            <span>Value</span>
            <span className="w-9" />
          </div>
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.key} className="grid grid-cols-1 items-center gap-2 rounded-lg border border-stone-100 p-2 sm:grid-cols-[1fr_auto_1fr_auto_auto] sm:gap-3 sm:border-0 sm:p-0">
                <select
                  className="input"
                  aria-label="App event"
                  value={r.source_event}
                  disabled={r.locked}
                  onChange={(e) => update(r.key, { source_event: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {sourceOptions(builtin, custom, r.source_event).map((o) => (
                    <option key={o} value={o}>
                      {eventLabel(o)}
                    </option>
                  ))}
                </select>
                <ArrowRight className="hidden size-4 text-stone-400 sm:block" aria-hidden="true" />
                {r.locked ? (
                  <input className="input" aria-label="Meta event" value={r.target_event} disabled />
                ) : (
                  <TargetSelect label="Meta event" value={r.target_event} options={it.target_events} onChange={(v) => update(r.key, { target_event: v })} />
                )}
                <label className="flex items-center gap-2 text-xs text-stone-600" title="Send the purchase amount with the event">
                  <input type="checkbox" checked={r.send_value} disabled={r.locked} onChange={(e) => update(r.key, { send_value: e.target.checked })} />
                  <span className="sm:sr-only">Send value</span>
                </label>
                {r.locked ? (
                  <span className="w-9 text-center text-[11px] text-stone-400" title="Always sent; Meta counts installs with it">
                    fixed
                  </span>
                ) : (
                  <button type="button" className="btn size-9 px-0" aria-label={`Remove ${eventLabel(r.source_event) || 'row'}`} onClick={() => { a.clear(); setRows((rs) => rs.filter((x) => x.key !== r.key)); }}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn mt-3" onClick={() => { a.clear(); setRows((rs) => [...rs, newRow()]); }} disabled={rows.length >= 50}>
            + Add event
          </button>
          {catalog.data && custom.length === 0 && (
            <p className="mt-2 text-xs text-stone-400">Custom events appear here once your app sends them with <code>Appmetry.track()</code>.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-dark" type="submit" disabled={a.busy || !dirty || problem !== null}>
            {a.busy ? 'Saving…' : 'Save'}
          </button>
          {dirty && problem && <span className="text-sm text-amber-700">{problem}</span>}
          <Feedback a={a} />
        </div>
      </form>
    </Section>
  );
}

// ---------- activation

function ActivationSection({ it, appId, onChange }: { it: Integration; appId: string; onChange: (i: Integration) => void }) {
  const [accept, setAccept] = useState(false);
  const a = useAction();
  const blockers = activationBlockers(it);
  const needsTerms = it.terms_accepted_at === null;

  if (it.status === 'active') {
    return (
      <Section title="Sending" description="Events are sent to Meta as they arrive. Failed sends are retried for up to a day.">
        <p className="text-sm text-stone-600">
          Active since {dateLabel(it.updated_at)}. Change or remove a setting above and sending pauses until you activate again.
        </p>
      </Section>
    );
  }

  function activate() {
    void a.run(async () => {
      onChange(await api<Integration>(`/api/apps/${appId}/integrations/${it.id}/activate`, { method: 'POST', json: { accept_terms: accept } }));
    }, 'Activated');
  }

  return (
    <Section
      title={it.status === 'error' ? 'Sending stopped' : 'Activate'}
      description={
        it.status === 'error'
          ? 'Meta rejected the access token or its permissions. Paste a new token above, then activate again.'
          : 'Nothing is sent to Meta until you activate.'
      }
    >
      {blockers.length > 0 && (
        <p className="text-sm text-stone-600">
          Still needed: <span className="font-medium">{blockers.join(', ')}</span>.
        </p>
      )}
      {needsTerms && (
        <label className="flex items-start gap-2 text-sm text-stone-700">
          <input type="checkbox" className="mt-0.5" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>
            I accept the{' '}
            <a className="underline" href="https://www.facebook.com/legal/businesstech" target="_blank" rel="noreferrer">
              Meta Business Tools Terms
            </a>
            , and my app asks users for ad consent before calling <code>setAdConsent(true)</code>. Events leave for Meta's servers, including outside the UK/EEA.
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-dark" type="button" disabled={a.busy || blockers.length > 0 || (needsTerms && !accept)} onClick={activate}>
          {a.busy ? 'Activating…' : 'Activate'}
        </button>
        <Feedback a={a} />
      </div>
    </Section>
  );
}

// ---------- delivery health, test event and log

function DeliverySection({ it, appId, reloadKey }: { it: Integration; appId: string; reloadKey: number }) {
  const [filter, setFilter] = useState<'' | Delivery['status']>('');
  const [testTarget, setTestTarget] = useState('MobileAppInstall');
  const [result, setResult] = useState<TestEventResult | null>(null);
  const [localKey, setLocalKey] = useState(0);
  const log = useApi<Delivery[]>(`/api/apps/${appId}/integrations/${it.id}/deliveries${filter ? `?status=${filter}` : ''}`, reloadKey + localKey);
  const a = useAction();
  const s = it.stats;

  function test() {
    setResult(null);
    void a.run(async () => {
      setResult(await api<TestEventResult>(`/api/apps/${appId}/integrations/${it.id}/test`, { method: 'POST', json: { target_event: testTarget } }));
    }, '');
  }

  return (
    <Section title="Delivery" description="What reached Meta in the last 24 hours. The log keeps 30 days and never shows device data.">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Sent', s.sent_24h],
          ['Failed', s.failed_24h],
          ['Waiting', s.pending],
          ['Last sent', s.last_sent_at ? dateTimeLabel(s.last_sent_at) : '–'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-stone-50 px-3 py-2">
            <dt className="text-xs text-stone-500">{k}</dt>
            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {s.last_error && (
        <p className="break-words text-sm text-red-700">
          Last error: <span className="font-mono text-xs">{s.last_error}</span>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-stone-100 pt-4">
        <Field label="Send a test event">
          <select className="input w-56" value={testTarget} onChange={(e) => setTestTarget(e.target.value)}>
            {it.target_events.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <button className="btn" type="button" onClick={test} disabled={a.busy || !it.test_event_code}>
          {a.busy ? 'Sending…' : 'Send test event'}
        </button>
        {!it.test_event_code && <span className="pb-2 text-xs text-stone-500">Add a test event code above to send test events.</span>}
        {a.error && <span role="alert" className="pb-2 text-sm text-red-600">{a.error}</span>}
        {result && (
          <span role="status" className={`pb-2 text-sm ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>
            {result.ok ? (
              <>
                Meta accepted it. Check{' '}
                <a className="underline" href={eventsManagerUrl(it.dataset_id)} target="_blank" rel="noreferrer">
                  Test events
                </a>
                .
              </>
            ) : (
              <>Meta did not accept it: {result.error}</>
            )}
          </span>
        )}
      </div>

      <div className="border-t border-stone-100 pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="tabs" role="tablist" aria-label="Filter deliveries">
            {(['', 'sent', 'failed', 'pending', 'skipped'] as const).map((f) => (
              <button key={f || 'all'} type="button" role="tab" aria-selected={filter === f} className={`tab ${filter === f ? 'tab-active' : ''}`} onClick={() => setFilter(f)}>
                {f ? f[0].toUpperCase() + f.slice(1) : 'All'}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => setLocalKey((k) => k + 1)}>
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-100 text-xs uppercase tracking-wide text-stone-400">
              <tr>
                <th className="px-3 py-2 font-medium">Event</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Happened</th>
                <th className="px-3 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {log.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-stone-400">
                    Nothing here yet.
                  </td>
                </tr>
              )}
              {log.data?.map((d) => (
                <tr key={d.id} className="border-b border-stone-50 last:border-0">
                  <td className="px-3 py-2 font-medium">{d.target_event}</td>
                  <td className="px-3 py-2">
                    <span className={d.status === 'sent' ? 'text-emerald-700' : d.status === 'failed' ? 'text-red-600' : 'text-stone-500'}>{d.status}</span>
                    {d.attempts > 1 && <span className="text-xs text-stone-400"> · {d.attempts} tries</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{d.value_cents ? money(d.value_cents) : '–'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-stone-500">{dateTimeLabel(d.event_ts)}</td>
                  <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-stone-500" title={d.last_error ?? undefined}>
                    {d.last_error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {log.error && <p className="mt-2 text-sm text-red-600">Could not load deliveries: {log.error}</p>}
        </div>
      </div>
    </Section>
  );
}

// ---------- page

/** Meta Ads integration: connection, event mapping, activation and delivery log. */
export function IntegrationMeta() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const list = useApi<IntegrationList>(`/api/apps/${id}/integrations`, reloadKey);
  const [it, setIt] = useState<Integration | null>(null);
  const [confirm, setConfirm] = useState(false);
  const disconnect = useAction();

  useEffect(() => {
    if (list.data) setIt(list.data.integrations.find((i) => i.provider === 'meta' && i.status !== 'disconnected') ?? null);
  }, [list.data]);

  const onChange = (next: Integration) => {
    setIt(next);
    setReloadKey((k) => k + 1);
  };

  if (list.error) return <div className="card p-6 text-sm text-red-600">Could not load the integration: {list.error}</div>;
  if (!list.data) return null;
  if (!it) {
    return (
      <div className="card p-10 text-center text-sm text-stone-500">
        Meta Ads is not connected. <Link className="underline" to={`/apps/${id}/integrations`}>Back to integrations</Link>
      </div>
    );
  }

  function doDisconnect() {
    void disconnect.run(async () => {
      await api(`/api/apps/${id}/integrations/${it!.id}`, { method: 'DELETE' });
      navigate(`/apps/${id}/integrations`);
    });
  }

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Meta Ads</h2>
          <StatusBadge status={it.status} />
        </div>
        <button type="button" className="btn text-red-700" onClick={() => setConfirm(true)}>
          Disconnect
        </button>
      </div>

      <ConnectionSection key={`c-${it.id}`} it={it} appId={id} onChange={onChange} />
      <PostbacksSection key={`p-${it.id}`} it={it} appId={id} onChange={onChange} />
      <ActivationSection it={it} appId={id} onChange={onChange} />
      <DeliverySection it={it} appId={id} reloadKey={reloadKey} />

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Disconnect Meta Ads?" width="max-w-md">
        <p className="text-sm text-stone-600">
          The access token is deleted and events waiting to be sent are dropped. The delivery log stays for 30 days. You can connect again later.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="btn-dark bg-red-700 hover:bg-red-800" disabled={disconnect.busy} onClick={doDisconnect}>
            {disconnect.busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
        {disconnect.error && <p role="alert" className="mt-3 text-sm text-red-600">{disconnect.error}</p>}
      </Modal>
    </div>
  );
}
