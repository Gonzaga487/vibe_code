import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnOverlay?: boolean;
}

const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export function Modal({ open, onClose, title, description, children, footer, size = 'md', closeOnOverlay = true }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
      const bodyField = panel.querySelector<HTMLElement>('[data-modal-body] input:not([disabled]), [data-modal-body] select:not([disabled]), [data-modal-body] textarea:not([disabled]), [data-modal-body] button:not([disabled])');
      (explicit ?? bodyField ?? panel.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
    }, 0);

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
      previousActive?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-5" role="presentation">
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeOnOverlay ? onClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`relative z-10 max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-slate-200 bg-white shadow-lift animate-fade-in sm:rounded-2xl dark:border-slate-700 dark:bg-slate-900 ${sizes[size]}`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-slate-900 dark:text-white">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {closeOnOverlay && <Button variant="ghost" size="sm" className="-mr-2 -mt-1 px-2" onClick={onClose} aria-label="Close dialog"><X className="h-5 w-5" /></Button>}
        </div>
        <div className="p-5" data-modal-body>{children}</div>
        {footer && <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 dark:border-slate-700 dark:bg-slate-950/70">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  variant?: 'danger' | 'warning' | 'primary';
  loading?: boolean;
  confirmationText?: string;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  onConfirm,
  onClose,
  variant = 'danger',
  loading = false,
  confirmationText,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const valid = !confirmationText || typed === confirmationText;

  useEffect(() => { if (open) setTyped(''); }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && valid && !loading) void onConfirm();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      closeOnOverlay={!loading}
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={variant} onClick={() => void onConfirm()} loading={loading} disabled={!valid}>{confirmLabel}</Button></>}
    >
      <div onKeyDown={onKeyDown}>
        <div className={`mb-4 flex gap-3 rounded-xl p-3 ${variant === 'danger' ? 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'}`}>
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="text-sm leading-6">{message}</div>
        </div>
        {children && <div className="mb-4">{children}</div>}
        {confirmationText && (
          <div>
            <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">Type <span className="font-mono text-red-600 dark:text-red-400">{confirmationText}</span> to continue</label>
            <input id={inputId} data-autofocus value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-mono outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 dark:border-slate-700 dark:bg-slate-950" />
          </div>
        )}
      </div>
    </Modal>
  );
}
