import { Fragment, useEffect, useRef, type ReactNode } from 'react';

import { Appdash } from './client';

// expo-router is an optional peer: without it the provider is a pass-through.
let usePathname: (() => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('expo-router') as { usePathname?: () => string };
  if (typeof mod?.usePathname === 'function') usePathname = mod.usePathname;
} catch {
  usePathname = null;
}

function Tracked({ children, usePath }: { children: ReactNode; usePath: () => string }) {
  const pathname = usePath();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || pathname === last.current) return;
    last.current = pathname;
    Appdash.screen(pathname);
  }, [pathname]);
  return <Fragment>{children}</Fragment>;
}

/** Tracks a screen event whenever the expo-router pathname changes. Renders no wrapper element. */
export function AppdashProvider({ children }: { children: ReactNode }) {
  if (!usePathname) return <Fragment>{children}</Fragment>;
  return <Tracked usePath={usePathname}>{children}</Tracked>;
}
