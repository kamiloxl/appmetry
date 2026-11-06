import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CopyButton, Field } from '../components/ui';
import { api } from '../lib/api';
import {
  AUTO_STEPS,
  SETUP_STEPS,
  SKIPPABLE,
  STEP_TITLES,
  nextStep,
  privacyParagraph,
  progressLabel,
} from '../lib/setup';
import { aiPrompt, installSnippet } from '../lib/snippets';
import type { AppInfo, IntegrationList, SetupStatus, SetupStep, StepStatus, TrackedLink } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useRcSecret } from '../lib/useRcSecret';
import { useSetupStatus } from '../lib/useSetupStatus';
import { LinkForm, linkUrl } from './Links';

/** Spinner while waiting, green tick with the detail once the server has seen it. */
function Detect({ st, waiting, doneText }: { st: StepStatus | undefined; waiting: string; doneText: string }) {
  if (st?.done) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        <span aria-hidden="true">✓</span>
        <span>
          {doneText}
          {st.detail ? `: ${st.detail}` : ''}
        </span>
      </p>
    );
  }
  return (
    <p role="status" className="flex items-center gap-2 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">
      <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
      <span>{waiting}</span>
    </p>
  );
}

function Progress({ status, step }: { status: SetupStatus | null; step: SetupStep }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Setup steps">
      {SETUP_STEPS.map((k, i) => {
        const st = status?.steps[k];
        const mark = st?.done ? '✓' : st?.skipped ? '–' : String(i + 1);
        return (
          <li key={k} aria-current={k === step ? 'step' : undefined} className={k === step ? 'font-semibold text-ink' : st?.done ? 'text-emerald-700' : 'text-stone-400'}>
            {mark} {STEP_TITLES[k]}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- step 1

const STORE_FIELDS = [
  ['ios_bundle_id', 'iOS bundle id', 'com.example.app', 'text', undefined],
  ['android_package', 'Android package', 'com.example.app', 'text', undefined],
  ['app_store_url', 'App Store URL', 'https://apps.apple.com/app/id…', 'url', 'Before release, a public TestFlight link (testflight.apple.com/join/…) works too.'],
  ['play_store_url', 'Google Play URL', 'https://play.google.com/store/apps/details?id=…', 'url', undefined],
] as const;

type StoreKey = (typeof STORE_FIELDS)[number][0];

function StepApp({ app, onSaved }: { app: AppInfo | null; onSaved: (a: AppInfo) => void }) {
  const [name, setName] = useState(app?.name ?? '');
  const [f, setF] = useState<Record<StoreKey, string>>({
    ios_bundle_id: app?.ios_bundle_id ?? '',
    android_package: app?.android_package ?? '',
    app_store_url: app?.app_store_url ?? '',
    play_store_url: app?.play_store_url ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let saved = app ?? (await api<AppInfo>('/api/apps', { method: 'POST', json: { name: name.trim() } }));
      // Only send what changed or was filled in: the create call has no optional fields.
      const patch: Record<string, string> = {};
      for (const [k] of STORE_FIELDS) if (f[k].trim() !== (saved[k] ?? '')) patch[k] = f[k].trim();
      if (app && name.trim() !== app.name) patch.name = name.trim();
      if (Object.keys(patch).length) saved = await api<AppInfo>(`/api/apps/${saved.id}`, { method: 'PATCH', json: patch });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <form id="step-form" onSubmit={submit} className="space-y-4">
      <p className="text-sm text-stone-600">Name your app. The store details are optional and can be changed later in Settings.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="App name *">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="My app" autoFocus />
        </Field>
        {STORE_FIELDS.map(([k, label, ph, type, hint]) => (
          <Field key={k} label={label} hint={hint}>
            <input className="input" type={type} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} maxLength={type === 'url' ? 500 : 255} placeholder={ph} />
          </Field>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          Could not save: {error}
        </p>
      )}
      <button className="btn-dark" type="submit" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : app ? 'Save and continue' : 'Create app and continue'}
      </button>
    </form>
  );
}

// ---------- step 2

function StepInstall({ app, st }: { app: AppInfo; st: StepStatus | undefined }) {
  const host = window.location.origin;
  const snippet = installSnippet(host, app.app_key);
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        Add the SDK to your Expo app and run it once. Install attribution (Play Install Referrer, Apple Search Ads) needs a development build; Expo Go works without it.
      </p>
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
      <Detect st={st} waiting="Waiting for the first event from your app…" doneText="First install" />
    </div>
  );
}

// ---------- step 3

function StepWebhook({
  app,
  st,
  rc,
}: {
  app: AppInfo;
  st: StepStatus | undefined;
  rc: ReturnType<typeof useRcSecret>;
}) {
  const webhook = `${window.location.origin}/api/webhooks/revenuecat/${app.id}`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        In RevenueCat open Integrations → Webhooks, add this URL, set the Authorization header, then send a test event. Skip this step if the app does not use RevenueCat.
      </p>
      <Field label="Webhook URL">
        <div className="flex items-center gap-2">
          <input className="input font-mono text-xs" readOnly value={webhook} onFocus={(e) => e.target.select()} />
          <CopyButton text={webhook} />
        </div>
      </Field>
      {rc.secret ? (
        <div>
          <p className="text-sm text-stone-600">Paste this as the Authorization header value in RevenueCat, then click Send test event</p>
          <div className="mt-2 flex items-center gap-2">
            <code data-testid="rc-secret" className="min-w-0 flex-1 break-all rounded-xl bg-stone-50 px-3 py-2 text-sm">
              {rc.secret}
            </code>
            <CopyButton text={rc.secret} />
          </div>
          <p className="mt-2 text-sm text-amber-700">It is shown only once. If you lose it, generate a new one in Settings.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {app.has_rc_secret && <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-sm text-emerald-700">Secret set</span>}
          <button type="button" className="btn-dark" onClick={() => void rc.generate()} disabled={rc.busy}>
            {rc.busy ? 'Generating…' : app.has_rc_secret ? 'Generate a new secret' : 'Generate secret'}
          </button>
          {app.has_rc_secret && <span className="text-xs text-stone-500">A new secret replaces the old one immediately.</span>}
        </div>
      )}
      {rc.error && (
        <p role="alert" className="text-sm text-red-600">
          Could not generate a secret: {rc.error}
        </p>
      )}
      <Detect st={st} waiting="Waiting for a RevenueCat event…" doneText="Webhook works" />
    </div>
  );
}

// ---------- step 4

function StepSync({ st }: { st: StepStatus | undefined }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        Call this once after <code>Purchases.configure</code> so RevenueCat knows which install each purchase came from:
      </p>
      <div className="flex items-center gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-stone-50 p-3 text-xs text-stone-700">
          <code>await Appmetry.syncRevenueCat(Purchases);</code>
        </pre>
        <CopyButton text="await Appmetry.syncRevenueCat(Purchases);" />
      </div>
      <Detect st={st} waiting="Waiting for the first purchase that carries appmetry_install_id…" doneText="Install id reaches RevenueCat" />
      {!st?.done && <p className="text-sm text-stone-500">This only turns green after a real or sandbox purchase. You can skip it now: it stays at “waiting for first purchase” in Settings.</p>}
    </div>
  );
}

// ---------- step 5

function StepAttribution({ app }: { app: AppInfo }) {
  const [created, setCreated] = useState<TrackedLink | null>(null);
  return (
    <div className="space-y-4">
      <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
        <li>Apple Search Ads needs no setup: iOS installs from Search Ads are attributed automatically.</li>
        <li>Play Install Referrer needs a development build (not Expo Go) to attribute Android installs from tracked links.</li>
        <li>
          Deep links: set a <code>scheme</code> in app.json (for example <code>myapp</code>). Links that open the app with <code>utm_*</code>, <code>ref</code> or <code>click_id</code> parameters set the session source.
        </li>
      </ul>
      <div>
        <h3 className="text-sm font-medium">Create your first tracked link (optional)</h3>
        <div className="mt-3">
          <LinkForm appId={app.id} onSaved={setCreated} />
        </div>
        {created && (
          <p role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <span aria-hidden="true">✓</span> Created
            <code className="break-all">{linkUrl(window.location.origin, created.slug)}</code>
            <CopyButton text={linkUrl(window.location.origin, created.slug)} />
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- step 6

function StepPrivacy({ app, onSaved }: { app: AppInfo; onSaved: (a: AppInfo) => void }) {
  const [timezone, setTimezone] = useState(app.timezone);
  const [retention, setRetention] = useState(String(app.retention_months));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const months = Number(retention);
  // Active ad networks change what users must be told (advertising id, sharing, transfer).
  const integrations = useApi<IntegrationList>(`/api/apps/${app.id}/integrations`);
  const adNetworks = (integrations.data?.integrations ?? [])
    .filter((i) => i.status === 'active')
    .map((i) => integrations.data!.providers.find((p) => p.provider === i.provider)?.name.replace(/ Ads$/, '') ?? i.provider);
  const paragraph = privacyParagraph(app.name, Number.isInteger(months) && months >= 1 ? months : app.retention_months, adNetworks);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await api<AppInfo>(`/api/apps/${app.id}`, { method: 'PATCH', json: { timezone, retention_months: retention.trim() === '' ? NaN : months } }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone" hint="Where a day starts in charts. IANA name, for example Europe/London">
            <input className="input" value={timezone} onChange={(e) => (setSaved(false), setTimezone(e.target.value))} />
          </Field>
          <Field label="Retention (months)" hint="Older data is deleted every night. 1 to 120, default 25.">
            <input className="input" type="number" min={1} max={120} step={1} value={retention} onChange={(e) => (setSaved(false), setRetention(e.target.value))} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save timezone and retention'}
          </button>
          {saved && (
            <span role="status" className="text-sm text-emerald-700">
              Saved
            </span>
          )}
          {error && (
            <span role="alert" className="text-sm text-red-600">
              Could not save: {error}
            </span>
          )}
        </div>
      </form>
      <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Consent: if your app needs consent before collecting data (for example under PECR in the UK or the ePrivacy rules in the EU), initialise the SDK with <code>requireConsent: true</code>. It then collects and sends nothing until you call <code>Appmetry.optIn()</code>.
      </p>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Privacy policy paragraph</h3>
          <CopyButton text={paragraph} label="Copy paragraph" />
        </div>
        <p data-testid="privacy-paragraph" className="mt-2 rounded-xl bg-stone-50 p-4 text-sm leading-relaxed text-stone-700">
          {paragraph}
        </p>
        <p className="mt-2 text-xs text-stone-500">
          This is a template, not legal advice. Review it, adapt it to your app and have it checked before you publish it.
        </p>
      </div>
    </div>
  );
}

// ---------- wizard

/** One screen per step. Rendered at /setup (no app yet: step 1 creates it) and /apps/:id/setup. */
export function Setup() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<SetupStep | null>(null);
  const [navError, setNavError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AppInfo[]>('/api/apps')
      .then(setApps)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const app = id ? apps?.find((a) => a.id === id) ?? null : null;
  // Poll only on a self-verifying step that is not detected yet; it stops once the status flips to done.
  const [detected, setDetected] = useState(false);
  const poll = step !== null && AUTO_STEPS.includes(step) && !detected;
  const { status, setStatus, error: statusError } = useSetupStatus(app?.id ?? null, poll);
  useEffect(() => setDetected(step !== null && Boolean(status?.steps[step]?.done)), [step, status]);
  const replaceApp = (a: AppInfo) => setApps((all) => (all ? all.map((x) => (x.id === a.id ? a : x)) : all));
  const rc = useRcSecret(app?.id ?? '', () => app && replaceApp({ ...app, has_rc_secret: true }));

  // Start at the first unfinished step once the status is known (step 1 when there is no app yet).
  useEffect(() => {
    if (step !== null) return;
    if (!id) {
      if (apps) setStep('app');
    } else if (status) setStep(nextStep(status) ?? 'app');
  }, [id, apps, status, step]);

  if (loadError) return <div role="alert" className="card p-6 text-sm text-red-600">Could not load setup: {loadError}</div>;
  if (!apps || step === null) {
    return statusError ? <div role="alert" className="card p-6 text-sm text-red-600">Could not load setup: {statusError}</div> : <div className="p-6 text-sm text-stone-400">Loading…</div>;
  }
  if (id && !app) {
    return (
      <div className="card p-10 text-center text-stone-500">
        This app does not exist. <Link className="underline" to="/">Back to all apps</Link>
      </div>
    );
  }

  const idx = SETUP_STEPS.indexOf(step);
  const go = (k: SetupStep | undefined) => k && setStep(k);
  const patch = async (s: SetupStep, state: 'done' | 'skipped') => {
    if (!app) return false;
    setBusy(true);
    setNavError(null);
    try {
      setStatus(await api<SetupStatus>(`/api/apps/${app.id}/setup`, { method: 'PATCH', json: { step: s, state } }));
      return true;
    } catch (e) {
      setNavError(e instanceof Error ? e.message : 'failed');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const st = status?.steps[step];
  const last = step === 'privacy';

  async function onSkip() {
    if (await patch(step as SetupStep, 'skipped')) go(SETUP_STEPS[idx + 1]);
  }
  async function onContinue() {
    if (step === 'attribution') {
      if (!(await patch('attribution', 'done'))) return;
    } else if (step === 'privacy') {
      if (!(await patch('privacy', 'done')) || !app) return;
      navigate(`/apps/${app.id}`);
      return;
    }
    go(SETUP_STEPS[idx + 1]);
  }

  let body: ReactNode;
  switch (step) {
    case 'app':
      body = (
        <StepApp
          app={app}
          onSaved={(a) => {
            if (!app) {
              setApps((all) => [...(all ?? []), a]);
              navigate(`/apps/${a.id}/setup`, { replace: true });
            } else replaceApp(a);
            setStep('firstEvent');
          }}
        />
      );
      break;
    case 'firstEvent':
      body = app && <StepInstall app={app} st={st} />;
      break;
    case 'revenuecatWebhook':
      body = app && <StepWebhook app={app} st={st} rc={rc} />;
      break;
    case 'revenuecatSync':
      body = <StepSync st={st} />;
      break;
    case 'attribution':
      body = app && <StepAttribution app={app} />;
      break;
    case 'privacy':
      body = app && <StepPrivacy app={app} onSaved={replaceApp} />;
      break;
  }

  // Steps 3 and 4 can only move on once detected or skipped; the others are always open.
  const gated = (step === 'revenuecatWebhook' || step === 'revenuecatSync') && !st?.done;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {idx + 1}. {STEP_TITLES[step]}
        </h1>
        <span className="text-sm text-stone-500">{status ? progressLabel(status) : 'Setup'}</span>
      </div>
      <Progress status={status} step={step} />
      <section className="card p-5" aria-label={STEP_TITLES[step]}>
        {body}
      </section>
      {statusError && (
        <p role="alert" className="text-sm text-red-600">
          Could not refresh setup status: {statusError}
        </p>
      )}
      {navError && (
        <p role="alert" className="text-sm text-red-600">
          Could not save: {navError}
        </p>
      )}
      {step !== 'app' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button className="btn" onClick={() => go(SETUP_STEPS[idx - 1])} disabled={busy}>
            Back
          </button>
          <div className="flex gap-2">
            {SKIPPABLE.includes(step) && !st?.done && (
              <button className="btn" onClick={() => void onSkip()} disabled={busy}>
                Skip
              </button>
            )}
            <button className="btn-dark" onClick={() => void onContinue()} disabled={busy || gated}>
              {last ? 'Finish' : 'Continue'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
