import { LoaderCircle, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { initial, moneyParts } from '../lib/format';

// ------------------------------------------------------------------- money

export function Money({
  cents,
  size = 'md',
  signed = false,
  tone,
  className = '',
}: {
  cents: number;
  size?: 'xl' | 'lg' | 'md';
  /** Always show a sign (+/−), e.g. for transaction amounts. */
  signed?: boolean;
  /** Color: explicit, or negative balances turn red automatically. */
  tone?: 'pos' | 'neg' | 'plain';
  className?: string;
}) {
  const p = moneyParts(cents);
  const sign = signed ? (cents < 0 ? '−' : '+') : p.sign ? '−' : '';
  const color = tone === 'plain' ? '' : (tone ?? (cents < 0 ? 'neg' : ''));
  return (
    <span className={`money ${size} ${color} ${className}`}>
      {sign}
      {p.int}
      <span className="dec">{p.dec}</span>
      <span className="unit">元</span>
    </span>
  );
}

export function Avatar({ name, size, accent }: { name: string; size?: 'lg'; accent?: boolean }) {
  return <span className={`avatar ${size ?? ''} ${accent ? 'accent' : ''}`}>{initial(name)}</span>;
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-label="加载中" />;
}

export function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      {children}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------- sheet

/** Bottom sheet on phones, centered dialog on larger screens. Closes on Escape and backdrop click. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button[data-autofocus]')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A yes/no sheet for destructive actions. */
export function Confirm({
  title,
  message,
  confirmText,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmText: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 24 }}>
        {message}
      </p>
      <div className="sheet-foot">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'danger' : 'primary'}`}
          onClick={onConfirm}
          disabled={busy}
          data-autofocus
        >
          {busy ? <Spinner size={18} /> : confirmText}
        </button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ toasts

type Toast = { id: number; text: string; error?: boolean };
const ToastContext = createContext<(text: string, opts?: { error?: boolean }) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, opts?: { error?: boolean }) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error: opts?.error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
              {t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
