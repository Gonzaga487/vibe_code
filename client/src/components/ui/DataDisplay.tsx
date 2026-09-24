import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState, TableSkeleton } from '@/components/ui/Feedback';
import { useSettings } from '@/context/SettingsContext';
import type { Pagination as PaginationType } from '@/types/api';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}

export function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-brand-700 dark:text-brand-300">{eyebrow}</p>}
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

interface SectionCardProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

export function SectionCard({ title, description, action, children, className = '', padded = true }: SectionCardProps) {
  return (
    <section className={`overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            {title && <h2 className="font-bold text-slate-900 dark:text-white">{title}</h2>}
            {description && <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

type StatTone = 'brand' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'slate';

const statTones: Record<StatTone, string> = {
  brand: 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon: LucideIcon;
  tone?: StatTone;
}

export function StatCard({ label, value, detail, icon: Icon, tone = 'brand' }: StatCardProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
          <p className="mt-2 truncate text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">{value}</p>
          {detail && <div className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail}</div>}
        </div>
        <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${statTones[tone]}`}><Icon className="h-5 w-5" aria-hidden="true" /></span>
      </div>
    </div>
  );
}

interface BadgeProps {
  children: ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'violet';
  className?: string;
}

const badgeTones = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
};

export function Badge({ children, tone = 'slate', className = '' }: BadgeProps) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${badgeTones[tone]} ${className}`}>{children}</span>;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (item: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  data: T[];
  getRowKey: (item: T) => string | number;
  loading?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  renderMobile?: (item: T) => ReactNode;
  caption: string;
  onRowClick?: (item: T) => void;
}

export function DataTable<T>({
  columns,
  data,
  getRowKey,
  loading,
  emptyTitle = 'No records yet',
  emptyMessage = 'Records will appear here when they are available.',
  renderMobile,
  caption,
  onRowClick,
}: DataTableProps<T>) {
  const { interfaceOptions } = useSettings();
  if (loading) return <TableSkeleton columns={Math.min(columns.length, 6)} />;
  if (!data.length) return <EmptyState title={emptyTitle} message={emptyMessage} />;

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className={interfaceOptions.compactTables ? '' : 'bg-slate-50 dark:bg-slate-950/50'}>
            <tr>
              {columns.map((column) => <th key={column.key} scope="col" className={`px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${column.headerClassName || ''}`}>{column.header}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.map((item) => (
              <tr
                key={getRowKey(item)}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
                className={`transition hover:bg-slate-50 dark:hover:bg-slate-800/60 ${onRowClick ? 'cursor-pointer' : ''} ${interfaceOptions.compactTables ? '[&>td]:py-2' : '[&>td]:py-3.5'}`}
              >
                {columns.map((column) => <td key={column.key} className={`px-4 align-middle text-slate-700 dark:text-slate-200 ${column.className || ''}`}>{column.render(item)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renderMobile && <div className="divide-y divide-slate-100 dark:divide-slate-800 md:hidden">{data.map((item) => <div key={getRowKey(item)}>{renderMobile(item)}</div>)}</div>}
    </>
  );
}

interface PaginationProps {
  pagination: PaginationType;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

export function Pagination({ pagination, onPageChange, onPageSizeChange }: PaginationProps) {
  if (pagination.total === 0) return null;
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm sm:flex-row dark:border-slate-800">
      <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
        <span>Showing {start}–{end} of {pagination.total}</span>
        {onPageSizeChange && (
          <select aria-label="Rows per page" className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" value={pagination.pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size} / page</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} leftIcon={<ChevronLeft className="h-4 w-4" />}>Previous</Button>
        <span className="px-2 text-xs text-slate-500">Page {pagination.page} of {Math.max(1, pagination.totalPages)}</span>
        <Button variant="secondary" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)} rightIcon={<ChevronRight className="h-4 w-4" />}>Next</Button>
      </div>
    </div>
  );
}

interface TabsProps<T extends string> {
  tabs: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: TabsProps<T>) {
  const move = (index: number) => {
    const normalized = (index + tabs.length) % tabs.length;
    const tab = tabs[normalized];
    if (tab) onChange(tab.value);
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          role="tab"
          type="button"
          aria-selected={value === tab.value}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); move(index + 1); }
            if (event.key === 'ArrowLeft') { event.preventDefault(); move(index - 1); }
          }}
          className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${value === tab.value ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-950 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-300 dark:hover:text-white'}`}
        >
          {tab.label}{typeof tab.count === 'number' && <span className="ml-1.5 text-xs opacity-70">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
