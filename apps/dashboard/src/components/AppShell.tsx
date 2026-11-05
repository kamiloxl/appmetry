import { Check, ChevronsUpDown, LayoutDashboard, LayoutGrid, Link2, ListChecks, LogOut, Menu, Minus, Plus, Settings2, Users, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { nextStep, progressCount, SETUP_STEPS, STEP_TITLES } from '../lib/setup';
import type { AppInfo, SetupStatus } from '../lib/types';
import { useApi } from '../lib/useApi';
import { cn } from '../lib/utils';
import { LogoMark } from './Logo';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

/** What the shell knows: every app, the one in the URL (undefined while loading, null when unknown) and its setup status. */
interface ShellState {
  apps: AppInfo[] | null;
  app: AppInfo | null | undefined;
  setup: SetupStatus | null;
}

const ShellContext = createContext<ShellState>({ apps: null, app: undefined, setup: null });
export const useShell = () => useContext(ShellContext);

const SECTIONS: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: 'customers', label: 'Customers', icon: Users },
  { to: 'links', label: 'Links', icon: Link2 },
];
const CONFIGURE: { to: string; label: string; icon: LucideIcon }[] = [
  { to: 'setup', label: 'Setup', icon: ListChecks },
  { to: 'settings', label: 'Settings', icon: Settings2 },
];
const TITLES: Record<string, string> = { '': 'Overview', customers: 'Customers', links: 'Links', settings: 'Settings', setup: 'Setup' };

function AppAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-[13px] font-semibold text-revenue', className)} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

function AppSwitcher({ apps, app, onNavigate }: { apps: AppInfo[] | null; app: AppInfo | null | undefined; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const go = (to: string) => {
    onNavigate?.();
    navigate(to);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
          aria-label="Switch app"
        >
          {app ? <AppAvatar name={app.name} /> : <LogoMark size={28} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-tight">{app ? app.name : 'appmetry'}</span>
            <span className="block truncate text-xs leading-tight text-muted-foreground">{app ? 'Switch app' : 'All apps'}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56">
        <DropdownMenuLabel>Apps</DropdownMenuLabel>
        {apps === null && <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>}
        {apps?.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => go(`/apps/${a.id}`)}>
            <AppAvatar name={a.name} className="size-5 rounded text-[11px]" />
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
            {app?.id === a.id && <Check className="text-muted-foreground" aria-label="Current app" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go('/')}>
          <LayoutGrid className="text-muted-foreground" /> All apps
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('/setup')}>
          <Plus className="text-muted-foreground" /> New app
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const navItem = ({ isActive }: { isActive: boolean }) =>
  cn(
    'group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-stone-600 outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    isActive && 'bg-card font-medium text-foreground shadow-card hover:bg-card',
  );

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function readCollapsed() {
  try {
    return localStorage.getItem('appmetry:setup-card') === 'collapsed';
  } catch {
    return false;
  }
}

/** Sidebar checklist for an app whose setup is not finished. Each step opens the wizard. */
function SetupCard({ app, status, onNavigate }: { app: AppInfo; status: SetupStatus; onNavigate?: () => void }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('appmetry:setup-card', c ? 'open' : 'collapsed');
      } catch {
        /* storage blocked: keep the in-memory state only */
      }
      return !c;
    });
  };
  const count = progressCount(status);
  const next = nextStep(status);
  return (
    <div className="rounded-lg border bg-card p-3 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Finish setup</div>
          <div className="text-xs text-muted-foreground">
            {count} of {SETUP_STEPS.length} done
          </div>
        </div>
        <button type="button" onClick={toggle} className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-expanded={!collapsed} aria-label={collapsed ? 'Show setup steps' : 'Hide setup steps'}>
          {collapsed ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
        </button>
      </div>
      <div className="mt-2.5 flex gap-1" aria-hidden="true">
        {SETUP_STEPS.map((k) => {
          const s = status.steps[k];
          return <span key={k} className={cn('h-1 flex-1 rounded-full', s.done ? 'bg-primary' : s.skipped ? 'bg-stone-400' : 'bg-border')} />;
        })}
      </div>
      {!collapsed && (
        <ul className="-mx-1 mt-2 space-y-px">
          {SETUP_STEPS.map((k) => {
            const s = status.steps[k];
            const finished = s.done || Boolean(s.skipped);
            return (
              <li key={k}>
                <Link
                  to={`/apps/${app.id}/setup`}
                  onClick={onNavigate}
                  className={cn('flex h-7 items-center gap-2 rounded-md px-1 text-[13px] transition-colors hover:bg-accent', finished ? 'text-muted-foreground' : 'text-foreground', k === next && 'font-medium')}
                >
                  <span
                    className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', s.done ? 'border-primary bg-primary text-primary-foreground' : s.skipped ? 'border-stone-400 text-stone-500' : k === next ? 'border-revenue' : 'border-stone-300')}
                    aria-hidden="true"
                  >
                    {s.done && <Check className="size-2.5" strokeWidth={3} />}
                    {!s.done && s.skipped && <Minus className="size-2.5" strokeWidth={3} />}
                  </span>
                  <span className={cn('truncate', finished && 'line-through decoration-stone-300')}>{STEP_TITLES[k]}</span>
                  <span className="sr-only">{s.done ? '(done)' : s.skipped ? '(skipped)' : k === next ? '(next)' : ''}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SidebarBody({ onNavigate, onLogout }: { onNavigate?: () => void; onLogout: () => void }) {
  const { apps, app, setup } = useShell();
  const onSetupPage = useLocation().pathname.endsWith('/setup');
  const base = app ? `/apps/${app.id}` : '';
  const pending = setup && setup.current !== null ? SETUP_STEPS.length - progressCount(setup) : 0;
  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <AppSwitcher apps={apps} app={app} onNavigate={onNavigate} />
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-2 pt-3" aria-label="Main">
        {app ? (
          <>
            <NavGroup label="Analytics">
              {SECTIONS.map((s) => (
                <NavLink key={s.to} to={s.to ? `${base}/${s.to}` : base} end={s.end} className={navItem} onClick={onNavigate}>
                  <s.icon className="size-4 shrink-0 text-muted-foreground group-[.active]:text-foreground" aria-hidden="true" />
                  {s.label}
                </NavLink>
              ))}
            </NavGroup>
            <NavGroup label="Configure">
              {CONFIGURE.map((s) => (
                <NavLink key={s.to} to={`${base}/${s.to}`} className={navItem} onClick={onNavigate}>
                  <s.icon className="size-4 shrink-0 text-muted-foreground group-[.active]:text-foreground" aria-hidden="true" />
                  <span className="flex-1">{s.label}</span>
                  {s.to === 'setup' && pending > 0 && (
                    <span className="rounded-full bg-revenueSoft px-1.5 text-[11px] font-medium leading-[18px] text-[#9a3f26]" aria-label={`${pending} steps left`}>
                      {pending}
                    </span>
                  )}
                </NavLink>
              ))}
            </NavGroup>
          </>
        ) : (
          <NavGroup label="Workspace">
            <NavLink to="/" end className={navItem} onClick={onNavigate}>
              <LayoutGrid className="size-4 shrink-0 text-muted-foreground group-[.active]:text-foreground" aria-hidden="true" />
              All apps
            </NavLink>
          </NavGroup>
        )}
      </nav>
      <div className="space-y-2 p-2">
        {app && setup && setup.current !== null && !onSetupPage && <SetupCard app={app} status={setup} onNavigate={onNavigate} />}
        <div className="flex items-center gap-2 border-t border-sidebar-border px-2 pt-2">
          <LogoMark size={20} />
          <span className="flex-1 text-sm font-semibold tracking-tight">appmetry</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onLogout} aria-label="Log out">
                <LogOut />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Log out</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function Breadcrumb() {
  const { app } = useShell();
  const section = useMatch('/apps/:id/:section')?.params.section ?? '';
  const inApp = useMatch('/apps/:id/*');
  const onNewApp = useMatch('/setup');
  if (inApp) {
    // The setup wizard has its own heading, so the current crumb is only a heading elsewhere.
    const Current = section === 'setup' ? 'span' : 'h1';
    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {app && (
          <>
            <Link to={`/apps/${app.id}`} className="truncate text-muted-foreground transition-colors hover:text-foreground">
              {app.name}
            </Link>
            <span className="text-stone-300" aria-hidden="true">
              /
            </span>
          </>
        )}
        <Current className="truncate font-medium" aria-current="page">
          {TITLES[section] ?? section}
        </Current>
      </nav>
    );
  }
  return <h1 className="text-sm font-medium">{onNewApp ? 'New app' : 'All apps'}</h1>;
}

/** Sidebar + header frame around every signed-in page. */
export function AppShell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const location = useLocation();
  const appId = useMatch('/apps/:id/*')?.params.id;
  const onSetupPage = location.pathname.endsWith('/setup');
  const [mobileOpen, setMobileOpen] = useState(false);

  // Re-read the app list on navigation so new and renamed apps show up in the switcher.
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  useEffect(() => {
    api<AppInfo[]>('/api/apps')
      .then(setApps)
      .catch(() => setApps((a) => a ?? []));
  }, [location.pathname]);
  const app = appId === undefined ? null : apps === null ? undefined : (apps.find((a) => a.id === appId) ?? null);

  // The wizard polls its own status; elsewhere re-read it on every navigation so the checklist is current.
  const [navTick, setNavTick] = useState(0);
  useEffect(() => setNavTick((n) => n + 1), [location.pathname]);
  const setupApi = useApi<SetupStatus>(appId && !onSetupPage ? `/api/apps/${appId}/setup` : null, navTick);
  const setup = appId && setupApi.data ? setupApi.data : null;

  return (
    <ShellContext.Provider value={{ apps, app, setup }}>
      <TooltipProvider delayDuration={300}>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
            <SidebarBody onLogout={onLogout} />
          </aside>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarBody onNavigate={() => setMobileOpen(false)} onLogout={onLogout} />
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-sticky flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur-sm lg:px-6">
              <Button variant="ghost" size="icon-sm" className="-ml-1.5 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
                <Menu />
              </Button>
              <Breadcrumb />
            </header>
            <main className="flex-1 px-4 py-5 lg:px-6 lg:py-6">{children}</main>
          </div>
        </div>
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
