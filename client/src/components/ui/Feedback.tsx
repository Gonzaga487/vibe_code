import type { LucideIcon } from 'lucide-react';
import { AlertCircle, Inbox, LoaderCircle, LockKeyhole, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`animate-spin ${className}`} />;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

export function PageLoader({ label = 'Loading station data…' }: { label?: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400" role="status">
      <Spinner className="h-7 w-7 text-brand-700" />
      <p className="text-sm font-medium">{label}</p>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  message: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
}

export function EmptyState({ title, message, icon: Icon = Inbox, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center px-5 py-10 text-center">
      <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><Icon className="h-6 w-6" aria-hidden="true" /></span>
      <h3 className="font-bold text-slate-900 dark:text-white">{title}</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ title = 'Unable to load this data', message, onRetry, compact = false }: ErrorStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'p-5' : 'min-h-56 p-8'}`} role="alert">
      <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-300"><AlertCircle className="h-5 w-5" /></span>
      <h3 className="font-bold text-slate-900 dark:text-white">{title}</h3>
      <p className="mt-1 max-w-lg text-sm leading-6 text-slate-500 dark:text-slate-400">{message}</p>
      {onRetry && <Button className="mt-4" variant="secondary" size="sm" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function ProtectedState({ title = 'Protected station result', message }: { title?: string; message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center dark:border-slate-700 dark:bg-slate-800/50">
      <LockKeyhole className="mx-auto h-5 w-5 text-slate-500" aria-hidden="true" />
      <p className="mt-2 text-sm font-bold text-slate-800 dark:text-slate-100">{title}</p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{message}</p>
    </div>
  );
}

interface InlineAlertProps {
  children: React.ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  icon?: LucideIcon;
  title?: string;
}

const alertTones = {
  info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
  danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100',
};

export function InlineAlert({ children, tone = 'info', icon: Icon = tone === 'danger' ? ShieldAlert : AlertCircle, title }: InlineAlertProps) {
  return (
    <div className={`flex gap-3 rounded-xl border p-3.5 text-sm ${alertTones[tone]}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="leading-6">{title && <p className="font-bold">{title}</p>}{children}</div>
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-label="Loading table">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, column) => <Skeleton key={column} className="h-9" />)}
        </div>
      ))}
    </div>
  );
}

export function StatCardSkeleton() {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><Skeleton className="h-4 w-24" /><Skeleton className="mt-4 h-8 w-32" /><Skeleton className="mt-3 h-3 w-40" /></div>;
}
