import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Copy to clipboard; falls back to a prompt when the Clipboard API is unavailable (plain http, old browsers). */
export function CopyButton({ text, label = 'Copy', onCopied }: { text: string; label?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy this text', text);
    }
    setDone(true);
    onCopied?.();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1500);
  }
  return (
    <button type="button" className="btn px-2.5 py-1 text-xs" onClick={copy}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-stone-500">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-stone-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-400">{hint}</span>}
    </label>
  );
}
