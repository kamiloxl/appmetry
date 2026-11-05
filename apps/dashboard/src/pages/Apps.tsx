import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { dateLabel } from '../lib/format';
import type { AppInfo } from '../lib/types';

export function Apps() {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api<AppInfo[]>('/api/apps')
      .then(setApps)
      .catch((e: Error) => setError(e.message));
  }, []);

  // First run: nothing to show yet, so start the setup wizard.
  if (apps && apps.length === 0) return <Navigate to="/setup" replace />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your apps</h1>
        {apps && apps.length > 0 && (
          <button className="btn-dark" onClick={() => setAdding(true)}>
            + New app
          </button>
        )}
      </div>

      {error && <p className="mt-5 text-sm text-red-600" role="alert">{error}</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps?.map((a) => (
          <Link key={a.id} to={`/apps/${a.id}`} className="card p-5 transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="truncate text-lg font-semibold">{a.name}</div>
            <div className="mt-1 text-sm text-stone-500">Created {dateLabel(a.created_at)}</div>
            <div className="mt-4">
              {a.has_rc_secret ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> RevenueCat connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-stone-300" /> RevenueCat not connected
                </span>
              )}
            </div>
          </Link>
        ))}
        {apps && apps.length === 0 && (
          <div className="card col-span-full p-12 text-center">
            <p className="text-stone-500">No apps yet. Create your first one to get an app key for the SDK.</p>
            <button className="btn-dark mt-5" onClick={() => setAdding(true)}>
              Create your first app
            </button>
          </div>
        )}
      </div>

      <CreateApp open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function CreateApp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const app = await api<AppInfo>('/api/apps', { method: 'POST', json: { name: name.trim() } });
      navigate(`/apps/${app.id}/setup`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New app" width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="app-name">
            Name
          </label>
          <input id="app-name" className="input" placeholder="My app" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </div>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button className="btn-dark w-full" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create app'}
        </button>
      </form>
    </Modal>
  );
}
