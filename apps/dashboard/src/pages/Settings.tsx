import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { aiPrompt, healthLabel, installSnippet } from '../lib/snippets';
import type { AppInfo, EraseResult, RcHealth, RcSecret } from '../lib/types';
import { useApi } from '../lib/useApi';

const COMMON_ZONES = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Warsaw', 'Europe/Athens',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Toronto',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland', 'Africa/Johannesburg', 'Africa/Lagos',
];

/** Copy to clipboard; falls back to a prompt when the Clipboard API is unavailable (plain http, old browsers). */
function CopyButton({ text, label = 'Copy', onCopied }: { text: string; label?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy this text', text);
    }
    setDone(true);
    onCopied?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1500);
  }
  return (
    <button type="button" className="btn px-2.5 py-1 text-xs" onClick={copy}>
      {done ? 'Copied' : label}
    </button>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-stone-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-400">{hint}</span>}
    </label>
  );
}

type Patch = Partial<Pick<AppInfo, 'ios_bundle_id' | 'android_package' | 'app_store_url' | 'play_store_url' | 'web_url' | 'timezone' | 'retention_months'>> & { show_sandbox?: boolean };

/** Save button, inline error and "Saved" note shared by every PATCH section. */
function useSave(appId: string, onSaved: (a: AppInfo) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(patch: Patch) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await api<AppInfo>(`/api/apps/${appId}`, { method: 'PATCH', json: patch }));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, saved, save, reset: () => setSaved(false) };
}

function SaveRow({ s }: { s: ReturnType<typeof useSave> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn-dark" type="submit" disabled={s.busy}>
        {s.busy ? 'Saving…' : 'Save'}
      </button>
      {s.error && (
        <span role="alert" className="text-sm text-red-600">
          Could not save: {s.error}
        </span>
      )}
      {s.saved && (
        <span role="status" className="text-sm text-emerald-700">
          Saved
        </span>
      )}
    </div>
  );
}

function InstallSection({ app }: { app: AppInfo }) {
  const host = window.location.origin;
  const snippet = installSnippet(host, app.app_key);
  return (
    <Section
      title="Install"
      description="Add the SDK to your Expo app. Install attribution (Play Install Referrer, Apple Search Ads) needs a development build; Expo Go works without it."
    >
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={snippet} label="Copy snippet" />
        <CopyButton text={aiPrompt(host, app.app_key)} label="Copy AI prompt" />
        <span className="text-xs text-stone-400">
          App key <code>{app.app_key}</code>
        </span>
      </div>
      <pre className="overflow-x-auto rounded-xl bg-stone-50 p-4 text-xs leading-relaxed text-stone-700" aria-label="Install snippet">
        <code>{snippet}</code>
      </pre>
    </Section>
  );
}

function StoresSection({ app, onSaved }: { app: AppInfo; onSaved: (a: AppInfo) => void }) {
  const [f, setF] = useState({
    ios_bundle_id: app.ios_bundle_id ?? '',
    android_package: app.android_package ?? '',
    app_store_url: app.app_store_url ?? '',
    play_store_url: app.play_store_url ?? '',
    web_url: app.web_url ?? '',
  });
  const s = useSave(app.id, onSaved);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    s.reset();
    setF((x) => ({ ...x, [k]: e.target.value }));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void s.save(f);
  };
  return (
    <Section title="Stores" description="Tracked links redirect here. URLs must start with https://. Leave a field empty to clear it.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="iOS bundle id">
            <input className="input" value={f.ios_bundle_id} onChange={set('ios_bundle_id')} maxLength={255} placeholder="com.example.app" />
          </Field>
          <Field label="Android package">
            <input className="input" value={f.android_package} onChange={set('android_package')} maxLength={255} placeholder="com.example.app" />
          </Field>
          <Field label="App Store URL">
            <input className="input" type="url" value={f.app_store_url} onChange={set('app_store_url')} maxLength={500} placeholder="https://apps.apple.com/app/id…" />
          </Field>
          <Field label="Google Play URL">
            <input className="input" type="url" value={f.play_store_url} onChange={set('play_store_url')} maxLength={500} placeholder="https://play.google.com/store/apps/details?id=…" />
          </Field>
          <Field label="Web URL">
            <input className="input" type="url" value={f.web_url} onChange={set('web_url')} maxLength={500} placeholder="https://example.com" />
          </Field>
        </div>
        <SaveRow s={s} />
      </form>
    </Section>
  );
}

function RevenueCatSection({ app, onSecretSet }: { app: AppInfo; onSecretSet: () => void }) {
  const webhook = `${window.location.origin}/api/webhooks/revenuecat/${app.id}`;
  const [reloadKey, setReloadKey] = useState(0);
  const health = useApi<RcHealth>(`/api/apps/${app.id}/revenuecat/health`, reloadKey);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RcSecret>(`/api/apps/${app.id}/rc-secret`, { method: 'POST' });
      setConfirmRotate(false);
      setSecret(r.secret);
      onSecretSet();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setConfirmRotate(false);
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const label = health.data ? healthLabel(health.data) : null;
  return (
    <Section title="RevenueCat" description="Revenue arrives through a RevenueCat webhook. Add this URL under Integrations → Webhooks in RevenueCat.">
      <Field label="Webhook URL">
        <div className="flex items-center gap-2">
          <input className="input font-mono text-xs" readOnly value={webhook} onFocus={(e) => e.target.select()} />
          <CopyButton text={webhook} />
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        {app.has_rc_secret ? (
          <>
            <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-sm text-emerald-700">Secret set</span>
            <button className="btn" onClick={() => setConfirmRotate(true)} disabled={busy}>
              Rotate secret
            </button>
          </>
        ) : (
          <button className="btn-dark" onClick={generate} disabled={busy}>
            {busy ? 'Generating…' : 'Generate secret'}
          </button>
        )}
        {error && (
          <span role="alert" className="text-sm text-red-600">
            Could not generate a secret: {error}
          </span>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Integration health</h3>
          <button className="btn px-2.5 py-1 text-xs" onClick={() => setReloadKey((k) => k + 1)} disabled={health.loading}>
            Refresh
          </button>
        </div>
        {health.error ? (
          <p role="alert" className="mt-2 text-sm text-red-600">
            Could not load health: {health.error}
          </p>
        ) : label ? (
          <p
            data-testid="rc-health"
            role={label.warning ? 'alert' : 'status'}
            className={`mt-2 rounded-xl px-4 py-3 text-sm ${label.warning ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'bg-stone-50 text-stone-700'}`}
          >
            {label.text}
          </p>
        ) : (
          <p className="mt-2 text-sm text-stone-400">Loading…</p>
        )}
      </div>

      <Modal open={confirmRotate} onClose={() => setConfirmRotate(false)} title="Rotate the webhook secret?" width="max-w-md">
        <p className="text-sm text-stone-600">The old secret stops working immediately. Until you paste the new one into RevenueCat, its webhooks are rejected and no revenue is recorded.</p>
        <div className="mt-5 flex gap-2">
          <button className="btn-dark" onClick={generate} disabled={busy}>
            {busy ? 'Rotating…' : 'Rotate secret'}
          </button>
          <button className="btn" onClick={() => setConfirmRotate(false)}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal open={secret !== null} onClose={() => setSecret(null)} title="Your webhook secret" width="max-w-lg">
        <p className="text-sm text-stone-600">Paste this as the Authorization header value in RevenueCat</p>
        <div className="mt-3 flex items-center gap-2">
          <code data-testid="rc-secret" className="min-w-0 flex-1 break-all rounded-xl bg-stone-50 px-3 py-2 text-sm">
            {secret}
          </code>
          <CopyButton text={secret ?? ''} />
        </div>
        <p className="mt-3 text-sm text-amber-700">It is shown only once. If you lose it, rotate the secret.</p>
        <div className="mt-5">
          <button className="btn-dark" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      </Modal>
    </Section>
  );
}

function DataSection({ app, onSaved }: { app: AppInfo; onSaved: (a: AppInfo) => void }) {
  const [timezone, setTimezone] = useState(app.timezone);
  const [retention, setRetention] = useState(String(app.retention_months));
  const [sandbox, setSandbox] = useState(app.show_sandbox === 1);
  const s = useSave(app.id, onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void s.save({ timezone, retention_months: retention.trim() === '' ? NaN : Number(retention), show_sandbox: sandbox });
  };
  return (
    <Section title="Data" description="The timezone sets where a day starts in charts. Data older than the retention period is deleted every night.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone" hint="IANA name, for example Europe/London">
            <input
              className="input"
              list="timezones"
              value={timezone}
              onChange={(e) => {
                s.reset();
                setTimezone(e.target.value);
              }}
            />
            <datalist id="timezones">
              {COMMON_ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          <Field label="Retention (months)" hint="1 to 120. Default 25.">
            <input
              className="input"
              type="number"
              min={1}
              max={120}
              step={1}
              value={retention}
              onChange={(e) => {
                s.reset();
                setRetention(e.target.value);
              }}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(e) => {
              s.reset();
              setSandbox(e.target.checked);
            }}
          />
          Include sandbox purchases in revenue
        </label>
        <SaveRow s={s} />
      </form>
    </Section>
  );
}

type EraseBy = 'user_id' | 'install_id';

function EraseSection({ app }: { app: AppInfo }) {
  const [by, setBy] = useState<EraseBy>('user_id');
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const id = value.trim();

  async function erase() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<EraseResult>(`/api/apps/${app.id}/users?${by}=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirm(false);
      setResult(`Removed ${r.installs} install(s)`);
      setValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Delete user data" description="Erase one person's data on request (GDPR). Enter their user id or an install id.">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          setError(null);
          if (id) setConfirm(true);
        }}
      >
        <Field label="Identify by">
          <select className="input" value={by} onChange={(e) => setBy(e.target.value as EraseBy)}>
            <option value="user_id">user_id</option>
            <option value="install_id">install_id</option>
          </select>
        </Field>
        <div className="min-w-[14rem] flex-1">
          <Field label={by === 'user_id' ? 'User id' : 'Install id'}>
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </div>
        <button className="btn" type="submit" disabled={!id}>
          Delete data…
        </button>
      </form>
      {result && (
        <p role="status" className="text-sm text-emerald-700">
          {result}
        </p>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete this user's data?" width="max-w-md">
        <p className="text-sm text-stone-600">
          This permanently removes the install (or every install with this user id), its sessions, events and link-click links. Payment amounts are kept, without identity. This cannot be undone.
        </p>
        <p className="mt-2 text-sm">
          <span className="text-stone-500">{by}:</span> <code className="break-all">{id}</code>
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            Could not delete: {error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button className="btn-dark bg-red-600 hover:bg-red-700" onClick={erase} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete data'}
          </button>
          <button className="btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Modal>
    </Section>
  );
}

function DangerSection({ app }: { app: AppInfo }) {
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/apps/${app.id}`, { method: 'DELETE' });
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }
  return (
    <section className="card border-red-200 p-5">
      <h2 className="text-base font-semibold text-red-700">Danger zone</h2>
      <p className="mt-1 text-sm text-stone-500">
        Deleting the app removes all its installs, sessions, events, links and payments. This cannot be undone.
      </p>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === app.name) void remove();
        }}
      >
        <div className="min-w-[14rem] flex-1">
          <Field label={`Type "${app.name}" to confirm`}>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <button className="btn-dark bg-red-600 hover:bg-red-700" type="submit" disabled={typed !== app.name || busy}>
          {busy ? 'Deleting…' : 'Delete app'}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Could not delete the app: {error}
        </p>
      )}
    </section>
  );
}

export function Settings() {
  const { id = '' } = useParams();
  const apps = useApi<AppInfo[]>('/api/apps');
  const app = apps.data?.find((a) => a.id === id);

  if (apps.error) {
    return (
      <div className="card p-6 text-sm text-red-600" role="alert">
        Could not load settings: {apps.error}
      </div>
    );
  }
  if (!app) return <div className="p-6 text-sm text-stone-400">Loading…</div>;

  const replace = (a: AppInfo) => apps.setData((all) => (all ? all.map((x) => (x.id === a.id ? a : x)) : all));
  return (
    <div className="space-y-4">
      <InstallSection app={app} />
      <StoresSection app={app} onSaved={replace} />
      <RevenueCatSection app={app} onSecretSet={() => replace({ ...app, has_rc_secret: true })} />
      <DataSection app={app} onSaved={replace} />
      <EraseSection app={app} />
      <DangerSection app={app} />
    </div>
  );
}
