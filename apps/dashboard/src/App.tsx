import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, useShell } from './components/AppShell';
import { api } from './lib/api';
import type { Me } from './lib/types';
import { Apps } from './pages/Apps';
import { Customers } from './pages/Customers';
import { IntegrationMeta } from './pages/IntegrationMeta';
import { Integrations } from './pages/Integrations';
import { Links } from './pages/Links';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { progressCount, SETUP_STEPS } from './lib/setup';

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
    <AppShell onLogout={logout}>
      <Outlet />
    </AppShell>
  );
}

/** Frame of every /apps/:id page. The shell supplies the app; this adds the not-found state and the small-screen setup banner. */
function AppLayout() {
  const { app, setup } = useShell();
  const onSetupPage = useLocation().pathname.endsWith('/setup');
  if (app === undefined) return null;
  if (app === null) {
    return (
      <div className="card p-10 text-center text-muted-foreground">
        This app does not exist. <Link className="underline" to="/">Back to all apps</Link>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[1400px]">
      {/* On large screens the sidebar checklist takes this role. */}
      {!onSetupPage && setup && setup.current !== null && (
        <Link
          to={`/apps/${app.id}/setup`}
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-revenue/30 bg-revenueSoft/50 px-4 py-2.5 text-sm text-[#7a3320] transition-colors hover:bg-revenueSoft lg:hidden"
        >
          <span>Finish setup ({progressCount(setup)}/{SETUP_STEPS.length})</span>
          <span aria-hidden="true">→</span>
        </Link>
      )}
      <Outlet />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Apps />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/apps/:id" element={<AppLayout />}>
          <Route index element={<Overview />} />
          <Route path="customers" element={<Customers />} />
          <Route path="links" element={<Links />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="integrations/meta" element={<IntegrationMeta />} />
          <Route path="settings" element={<Settings />} />
          <Route path="setup" element={<Setup />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
