import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Logo } from './components/Logo';
import { api } from './lib/api';
import type { AppInfo, Me } from './lib/types';
import { Apps } from './pages/Apps';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';

/** Waits for /api/auth/me, then renders the shell. Anyone not logged in goes to /login and comes back after. */
function RequireAuth() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const location = useLocation();
  useEffect(() => {
    api<Me>('/api/auth/me')
      .then((m) => setLoggedIn(m.loggedIn))
      .catch(() => setLoggedIn(false));
  }, []);
  if (loggedIn === null) return null;
  if (!loggedIn) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Shell />;
}

function Shell() {
  const navigate = useNavigate();
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/login', { replace: true });
  }
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <header className="flex items-center justify-between">
        <Link to="/" aria-label="All apps">
          <Logo />
        </Link>
        <button className="btn" onClick={logout}>
          Log out
        </button>
      </header>
      <main className="mt-8">
        <Outlet />
      </main>
    </div>
  );
}

const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'customers', label: 'Customers' },
  { to: 'links', label: 'Links' },
  { to: 'settings', label: 'Settings' },
];

/** Frame of every /apps/:id page: the app's name and its sections. The pages themselves arrive in later tasks. */
function AppLayout() {
  const { id } = useParams();
  const [app, setApp] = useState<AppInfo | null | undefined>(undefined);
  useEffect(() => {
    api<AppInfo[]>('/api/apps')
      .then((all) => setApp(all.find((a) => a.id === id) ?? null))
      .catch(() => setApp(null));
  }, [id]);
  if (app === undefined) return null;
  if (app === null) {
    return (
      <div className="card p-10 text-center text-stone-500">
        This app does not exist. <Link className="underline" to="/">Back to all apps</Link>
      </div>
    );
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-stone-400 hover:text-ink" aria-label="All apps">
            ←
          </Link>
          <h1 className="text-2xl font-semibold">{app.name}</h1>
        </div>
        <nav className="tabs" aria-label="App sections">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="mt-6">
        <Outlet />
      </div>
    </div>
  );
}

function ComingSoon({ title, back }: { title: string; back: { to: string; label: string } }) {
  return (
    <div className="card p-10 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Link className="btn mt-5" to={back.to}>
        {back.label}
      </Link>
    </div>
  );
}

function Back({ title }: { title: string }) {
  const { id } = useParams();
  return <ComingSoon title={title} back={{ to: `/apps/${id}`, label: 'Back to overview' }} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Apps />} />
        {/* Instance setup wizard (spec 6a), built in Task 25. */}
        <Route path="/setup" element={<ComingSoon title="Setup wizard coming soon" back={{ to: '/', label: 'Back to your apps' }} />} />
        <Route path="/apps/:id" element={<AppLayout />}>
          <Route index element={<Overview />} />
          <Route path="customers" element={<Back title="Customers coming soon" />} />
          <Route path="links" element={<Back title="Links coming soon" />} />
          <Route path="settings" element={<Back title="Settings coming soon" />} />
          <Route path="setup" element={<Back title="Setup wizard coming soon" />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
