import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { errorText, STATUS_LABELS } from '../lib/integrations';
import type { Integration, IntegrationList, IntegrationStatus } from '../lib/types';
import { useApi } from '../lib/useApi';

const BLURBS: Record<string, string> = {
  meta: 'Send installs, trials and purchases to Meta through the Conversions API, so campaigns optimise for the events that matter.',
};

export function StatusBadge({ status }: { status: IntegrationStatus }) {
  const tone: Record<IntegrationStatus, string> = {
    active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    draft: 'border-stone-200 bg-stone-50 text-stone-600',
    error: 'border-red-200 bg-red-50 text-red-700',
    disconnected: 'border-stone-200 bg-stone-50 text-stone-500',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone[status]}`}>
      <span className={`size-1.5 rounded-full ${status === 'active' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-stone-400'}`} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Ad networks the app can send events to. Each card opens that network's page, connecting it first if needed. */
export function Integrations() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error } = useApi<IntegrationList>(`/api/apps/${id}/integrations`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function connect(provider: string) {
    setBusy(provider);
    setActionError(null);
    try {
      await api<Integration>(`/api/apps/${id}/integrations`, { method: 'POST', json: { provider } });
      navigate(`/apps/${id}/integrations/${provider}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) navigate(`/apps/${id}/integrations/${provider}`);
      else setActionError(errorText(e instanceof Error ? e.message : 'failed'));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="card p-6 text-sm text-red-600">Could not load integrations: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-stone-500">
        Send your app's events to the ad networks you buy from. Events go only for users who gave ad consent in your app
        (<code>Appmetry.setAdConsent(true)</code>).
      </p>
      {!data.keys_configured && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Integrations need the server secret <code>INTEGRATIONS_KEY</code> (32 random bytes, base64) to store tokens encrypted. Add it in
          Cloudflare → Workers → appmetry → Settings → Variables, for example from <code>openssl rand -base64 32</code>.
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-red-600">
          {actionError}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {data.providers.map((p) => {
          const it = data.integrations.find((i) => i.provider === p.provider && i.status !== 'disconnected');
          return (
            <div key={p.provider} className="card flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{p.name}</h2>
                {it && <StatusBadge status={it.status} />}
              </div>
              <p className="text-sm text-stone-500">{BLURBS[p.provider]}</p>
              {it && it.status === 'active' && (
                <p className="text-xs text-stone-500">
                  {it.stats.sent_24h} sent and {it.stats.failed_24h} failed in the last 24 h
                  {it.stats.pending ? `, ${it.stats.pending} waiting` : ''}
                </p>
              )}
              <div className="mt-auto">
                {it ? (
                  <Link className="btn" to={`/apps/${id}/integrations/${p.provider}`}>
                    Configure
                  </Link>
                ) : (
                  <button className="btn-dark" type="button" disabled={busy !== null} onClick={() => void connect(p.provider)}>
                    {busy === p.provider ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
