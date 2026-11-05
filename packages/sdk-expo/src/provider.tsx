import { Fragment, useEffect, useRef, type ReactNode } from 'react';

import { Appmetry } from './client';
import { log } from './log';

// expo-router is an optional peer: without it the provider is a pass-through.
// The literal `require('expo-router')` inside try/catch relies on Metro's `allowOptionalDependencies`
// (enabled in Expo's default Metro config). It must stay a static string literal: Metro cannot
// treat a computed or aliased require as optional.
let usePathname: (() => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('expo-router') as { usePathname?: () => string };
  if (typeof mod?.usePathname === 'function') usePathname = mod.usePathname;
} catch (err) {
  usePathname = null;
  log('expo-router not available, automatic screen tracking is off', err);
}

function Tracked({ children, usePath }: { children: ReactNode; usePath: () => string }) {
  const pathname = usePath();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || pathname === last.current) return;
    last.current = pathname;
    Appmetry.screen(pathname);
  }, [pathname]);
  return <Fragment>{children}</Fragment>;
}

/** Tracks a screen event whenever the expo-router pathname changes. Renders no wrapper element. */
export function AppmetryProvider({ children }: { children: ReactNode }) {
  if (!usePathname) return <Fragment>{children}</Fragment>;
  return <Tracked usePath={usePathname}>{children}</Tracked>;
}
