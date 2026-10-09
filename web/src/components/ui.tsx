import { useEffect, useState, type ReactNode, createContext, useContext, useCallback, useRef } from 'react';
import { Check, Copy, X, AlertTriangle, Info, CircleCheck, CircleX } from 'lucide-react';

export function Card({ title, actions, children, className = '', pad = true, hint }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; hint?: string }) {
  return (
    <section className={`card flex flex-col min-w-0 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {title && <h2 className="card-title truncate">{title}</h2>}
            {hint && <span className="text-ink-3" title={hint}><Info size={13} /></span>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      <div className={`${pad ? 'px-4 pb-4' : ''} ${title || actions ? '' : pad ? 'pt-4' : ''} min-w-0 flex-1`}>{children}</div>
    </section>
  );
}

export type Tone = 'good' | 'warn' | 'serious' | 'crit' | 'accent' | 'neutral';
export function Chip({ tone = 'neutral', children, dot = true, title, className = '' }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string; className?: string }) {
  return <span className={`chip ${tone === 'neutral' ? '' : tone} ${className}`} title={title}>{dot && <span className="chip-dot" />}{children}</span>;
}

export function toneFor(value: string | boolean | null | undefined): Tone {
  if (typeof value === 'boolean') return value ? 'good' : 'neutral';
  switch ((value ?? '').toLowerCase()) {
    case 'connected': case 'up': case 'running': case 'active': case 'established': case 'ok': case 'present': case 'accept': case 'open': case 'full': return 'good';
    case 'connecting': case 'activating': case 'binding': case 'initiating': case 'awaiting_msg3': case 'pending_accept': case 'degraded': case 'exited': case 'warn': case 'warning': return 'warn';
    case 'draining': case 'reconnecting': case 'absent': case 'filt?': case 'unknown': return 'serious';
    case 'failed': case 'down': case 'disconnected': case 'error': case 'dead': case 'fail': case 'drop': return 'crit';
    default: return 'neutral';
  }
}

export function StatusChip({ value, label }: { value: string | null | undefined; label?: string }) {
  return <Chip tone={toneFor(value)}>{label ?? (value ?? 'unknown').replace(/_/g, ' ')}</Chip>;
}

/**
 * Copy text to the clipboard. The Clipboard API exists only in secure contexts (HTTPS, or localhost), and the
 * dashboard over the mesh is plain http on a fips0 address: there the copy command on a selected, hidden textarea
 * still works from a click. As a last resort the value is shown to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' });
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not supported */ }
  ta.remove();
  active?.focus?.();
  if (!ok) window.prompt('Copy this value:', text);
  return ok;
}

export function Copyable({ text, display, className = '', mono = true }: { text: string; display?: ReactNode; className?: string; mono?: boolean }) {
  const [ok, setOk] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyText(text)) { setOk(true); setTimeout(() => setOk(false), 1200); }
  };
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 group ${className}`} title={text}>
      <span className={`truncate ${mono ? 'mono' : ''}`}>{display ?? text}</span>
      {/* Shown on hover, and always on touch screens, which have no hover. */}
      <button onClick={copy} className="opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 text-ink-3 hover:text-ink transition-opacity shrink-0" aria-label="Copy" title="Copy">
        {ok ? <Check size={13} className="text-good" /> : <Copy size={13} />}
      </button>
    </span>
  );
}

export function KV({ items, className = '' }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return <dl className={`kv ${className}`}>{items.map(([k, v], i) => <div key={i} className="contents"><dt>{k}</dt><dd>{v ?? '–'}</dd></div>)}</dl>;
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-10 text-ink-3 text-sm text-center">{icon}<div>{children}</div></div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--crit-soft)', color: 'var(--crit)' }}><AlertTriangle size={16} className="shrink-0 mt-0.5" /><div className="min-w-0 break-words">{children}</div></div>;
}

export function Skeleton({ className = 'h-4 w-24' }: { className?: string }) { return <div className={`skeleton ${className}`} />; }

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return <div className="seg">{options.map((o) => <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export function Modal({ open, onClose, title, children, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-6" style={{ background: 'rgba(3,8,18,0.6)', backdropFilter: 'blur(4px)' }} onMouseDown={onClose}>
      <div className={`card w-full ${width} fade-in`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <header className="flex items-center justify-between px-5 pt-4 pb-2"><h2 className="text-base font-semibold">{title}</h2><button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger = false, busy = false }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; body: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-md">
      <div className="text-sm text-ink-2 mb-5">{body}</div>
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button></div>
    </Modal>
  );
}

// ------------------------------------------------------------- toasts
type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div key={t.id} className="card px-3.5 py-2.5 text-sm flex items-start gap-2 fade-in" style={{ borderColor: t.kind === 'err' ? 'rgba(208,59,59,0.5)' : t.kind === 'ok' ? 'rgba(12,163,12,0.5)' : undefined }}>
            {t.kind === 'ok' ? <CircleCheck size={16} className="text-good shrink-0 mt-0.5" /> : t.kind === 'err' ? <CircleX size={16} className="text-crit shrink-0 mt-0.5" /> : <Info size={16} className="text-accent shrink-0 mt-0.5" />}
            <div className="break-words">{t.text}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}
