export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" fill="#1c1917" />
      <path d="M8 22l5-7 4 4 7-10" stroke="#e07b5f" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <LogoMark size={small ? 24 : 28} />
      <span className={`font-semibold tracking-tight ${small ? 'text-base' : 'text-lg'}`}>appmetry</span>
    </div>
  );
}
