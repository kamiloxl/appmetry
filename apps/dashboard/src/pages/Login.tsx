import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import type { Me } from '../lib/types';

export function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const dest = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';

  // Already signed in (for example the back button): skip the form.
  useEffect(() => {
    api<Me>('/api/auth/me')
      .then((m) => m.loggedIn && navigate(dest, { replace: true }))
      .catch(() => undefined);
  }, [navigate, dest]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', json: { password } });
      navigate(dest, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <Logo />
        <h1 className="mt-6 text-2xl font-semibold">Welcome back</h1>
        <p className="mt-1 text-sm text-stone-500">Revenue-first analytics for your Expo apps.</p>
        <label className="label mt-6" htmlFor="pw">
          Password
        </label>
        <input id="pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <button className="btn-dark mt-6 w-full" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
