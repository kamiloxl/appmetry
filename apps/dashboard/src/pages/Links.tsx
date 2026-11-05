import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Toolbar } from '../components/Toolbar';
import { api, ApiError } from '../lib/api';
import { money, number } from '../lib/format';
import { toSearch } from '../lib/query';
import type { AppInfo, LinkStat, TrackedLink } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';

/** Public URL of a tracked link. */
export function linkUrl(origin: string, slug: string): string {
  return `${origin}/l/${slug}`;
}

/** Lowercase, `[a-z0-9-]` only, no leading/trailing/double hyphens, at most 48 characters. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
}

interface FormState {
  name: string;
  slug: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  ref: string;
}

const EMPTY: FormState = { name: '', slug: '', utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', ref: '' };

function CopyButton({ text, onCopied, label = 'Copy' }: { text: string; onCopied: () => void; label?: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      onCopied();
    } catch {
      window.prompt('Copy this link', text);
    }
  }
  return (
    <button type="button" className="btn px-2.5 py-1 text-xs" onClick={copy} aria-label={`${label} link`}>
      {label}
    </button>
  );
}

/** Create / edit form. `link` set means edit; the slug then starts as the saved one and is never auto-filled. */
function LinkForm({ appId, link, onSaved, onCancel }: { appId: string; link?: TrackedLink; onSaved: (l: TrackedLink) => void; onCancel?: () => void }) {
  const [f, setF] = useState<FormState>(
    link
      ? {
          name: link.name ?? '',
          slug: link.slug,
          utm_source: link.utm_source ?? '',
          utm_medium: link.utm_medium ?? '',
          utm_campaign: link.utm_campaign ?? '',
          utm_content: link.utm_content ?? '',
          ref: link.ref ?? '',
        }
      : EMPTY,
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(link));
  const [busy, setBusy] = useState(false);
  const [slugTaken, setSlugTaken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof FormState, v: string) => {
    setF((s) => ({ ...s, [k]: v, ...(k === 'name' && !slugTouched ? { slug: slugify(v) } : {}) }));
    if (k === 'slug') {
      setSlugTouched(true);
      setSlugTaken(false);
    }
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSlugTaken(false);
    const body = { ...f, slug: f.slug.trim() || undefined };
    try {
      const saved = link
        ? await api<TrackedLink>(`/api/apps/${appId}/links/${link.id}`, { method: 'PATCH', json: { ...body, slug: f.slug.trim() } })
        : await api<TrackedLink>(`/api/apps/${appId}/links`, { method: 'POST', json: body });
      if (!link) {
        setF(EMPTY);
        setSlugTouched(false);
      }
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setSlugTaken(true);
      else setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof FormState, label: string, opts: { required?: boolean; placeholder?: string; hint?: string } = {}) => (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-stone-500">
        {label}
        {opts.required && ' *'}
      </span>
      <input
        className="input"
        value={f[k]}
        required={opts.required}
        placeholder={opts.placeholder}
        maxLength={k === 'slug' ? 48 : k === 'name' || k === 'utm_source' ? 100 : 200}
        onChange={(e) => set(k, e.target.value)}
        aria-invalid={k === 'slug' && slugTaken ? true : undefined}
        aria-describedby={k === 'slug' && slugTaken ? 'slug-error' : undefined}
      />
      {k === 'slug' && slugTaken && (
        <span id="slug-error" role="alert" className="mt-1 block text-xs text-red-600">
          That slug is taken
        </span>
      )}
      {opts.hint && <span className="mt-1 block text-xs text-stone-400">{opts.hint}</span>}
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {field('name', 'Name', { required: true, placeholder: 'Launch tweet' })}
        {field('slug', 'Slug', { placeholder: 'auto-generated', hint: 'a-z, 0-9 and hyphens, 2–48 characters. Leave empty for a random one.' })}
        {field('utm_source', 'utm_source', { required: true, placeholder: 'twitter' })}
        {field('utm_medium', 'utm_medium', { placeholder: 'social' })}
        {field('utm_campaign', 'utm_campaign', { placeholder: 'launch' })}
        {field('utm_content', 'utm_content', { placeholder: 'thread-1' })}
        {field('ref', 'ref', { placeholder: 'friend-code' })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          Could not save the link: {error}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn-dark" type="submit" disabled={busy}>
          {busy ? 'Saving…' : link ? 'Save changes' : 'Create link'}
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function Links() {
  const { id = '' } = useParams();
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<TrackedLink | null>(null);
  const [deleting, setDeleting] = useState<LinkStat | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [created, setCreated] = useState<TrackedLink | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const formRef = useRef<HTMLDivElement>(null);
  const origin = window.location.origin;

  const apps = useApi<AppInfo[]>('/api/apps');
  const app = apps.data?.find((a) => a.id === id);
  const links = useApi<TrackedLink[]>(`/api/apps/${id}/links`, reloadKey);
  const stats = useApi<LinkStat[]>(`/api/apps/${id}/stats/links?${toSearch(q)}`, reloadKey);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2000);
  };
  const reload = () => setReloadKey((k) => k + 1);
  const copied = () => flash('Copied');

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await api(`/api/apps/${id}/links/${deleting.linkId}`, { method: 'DELETE' });
      if (created?.id === deleting.linkId) setCreated(null);
      setDeleting(null);
      reload();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'failed');
    }
  }

  const noStoreUrls = app && !app.app_store_url && !app.play_store_url;
  const error = stats.error ?? links.error;
  const rows = stats.data;

  return (
    <div className="space-y-4">
      {noStoreUrls && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          Links redirect to your store pages — add them in{' '}
          <Link className="font-medium underline" to={`/apps/${id}/settings`}>
            Settings
          </Link>
        </div>
      )}
      <Toolbar q={q} update={update} onRefresh={reload} loading={stats.loading || links.loading} />

      <div className="card p-5" ref={formRef}>
        <h2 className="mb-4 text-base font-semibold">Create a tracked link</h2>
        <LinkForm
          appId={id}
          onSaved={(l) => {
            setCreated(l);
            reload();
          }}
        />
        {created && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">
            <span>
              Created <strong>{created.name}</strong>:
            </span>
            <code className="break-all">{linkUrl(origin, created.slug)}</code>
            <CopyButton text={linkUrl(origin, created.slug)} onCopied={copied} />
          </div>
        )}
      </div>

      {error ? (
        <div className="card p-6 text-sm text-red-600" role="alert">
          Could not load links: {error}
          <button className="btn ml-3" onClick={reload}>
            Retry
          </button>
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="card p-10 text-center">
          <h2 className="text-lg font-semibold">No tracked links yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-stone-500">
            A tracked link is a short URL you share (in a post, an ad or an email). It records the click, sends people to the right store, and shows you which links bring installs and revenue.
            Create your first one in the form above.
          </p>
          <button className="btn mt-5" onClick={() => formRef.current?.querySelector('input')?.focus()}>
            Go to the form
          </button>
        </div>
      ) : (
        <div className={`card overflow-x-auto ${stats.loading && rows ? 'opacity-60' : ''}`}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-100 text-xs uppercase tracking-wide text-stone-400">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Link</th>
                <th className="px-4 py-3 text-right font-medium">Clicks (Android / iOS)</th>
                <th className="px-4 py-3 text-right font-medium">Installs</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!rows && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-stone-400">
                    Loading…
                  </td>
                </tr>
              )}
              {rows?.map((s) => {
                const url = linkUrl(origin, s.slug);
                const full = links.data?.find((l) => l.id === s.linkId);
                return (
                  <tr key={s.linkId} className="border-b border-stone-50 last:border-0">
                    <td className="px-4 py-3 font-medium">{s.name ?? s.slug}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <code className="break-all text-xs text-stone-600">{url}</code>
                        <CopyButton text={url} onCopied={copied} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {number(s.clicks)} <span className="text-stone-400">({number(s.androidClicks)} / {number(s.iosClicks)})</span>
                    </td>
                    <td className="px-4 py-3 text-right">{number(s.installs)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${s.revenue < 0 ? 'text-red-600' : ''}`}>{money(s.revenue)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button className="btn px-2.5 py-1 text-xs" disabled={!full} onClick={() => full && setEditing(full)} aria-label={`Edit ${s.name ?? s.slug}`}>
                          Edit
                        </button>
                        <button
                          className="btn px-2.5 py-1 text-xs text-red-600"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleting(s);
                          }}
                          aria-label={`Delete ${s.name ?? s.slug}`}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-stone-500">iOS installs from links are attributed only when the app is opened through the link (deep link) or via Apple Search Ads.</p>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Edit link" width="max-w-xl">
        {editing && (
          <LinkForm
            key={editing.id}
            appId={id}
            link={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
              flash('Saved');
            }}
          />
        )}
      </Modal>

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete this link?" width="max-w-md">
        <p className="text-sm text-stone-600">
          <strong>{deleting?.name ?? deleting?.slug}</strong> will stop redirecting. Clicks are kept.
        </p>
        {deleteError && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            Could not delete: {deleteError}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button className="btn-dark bg-red-600 hover:bg-red-700" onClick={confirmDelete}>
            Delete link
          </button>
          <button className="btn" onClick={() => setDeleting(null)}>
            Cancel
          </button>
        </div>
      </Modal>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-ink px-4 py-2 text-sm text-white shadow-card">
          {toast}
        </div>
      )}
    </div>
  );
}
