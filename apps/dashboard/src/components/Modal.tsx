import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Index to focus on Tab / Shift+Tab so focus wraps inside a list of `count` focusables; null leaves the browser to move it. */
export function wrapIndex(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return -1;
  if (shift && current <= 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return current < 0 ? (shift ? count - 1 : 0) : null;
}

export function Modal({
  open,
  onClose,
  children,
  width = 'max-w-2xl',
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  title?: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the focus effect (parents pass inline callbacks).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    // Move focus in: the dialog itself, so a screen reader starts at its title.
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onCloseRef.current();
      if (e.key !== 'Tab' || !dialog.current) return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = wrapIndex(list.length, document.activeElement === dialog.current ? -1 : at, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      (next === -1 ? dialog.current : list[next])?.focus();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/30 p-4 backdrop-blur-[2px] sm:p-10" onMouseDown={() => onCloseRef.current()}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`card w-full ${width} p-0 outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
            <div id={titleId} className="text-lg font-semibold">{title}</div>
            <button className="rounded-lg p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
