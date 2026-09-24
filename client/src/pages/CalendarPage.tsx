import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Fuel, PackagePlus, ReceiptText, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PageHeader, SectionCard, StatCard } from '@/components/ui/DataDisplay';
import { EmptyState, ErrorState, ProtectedState } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { formatDateKey, formatKsh, formatLitres, formatNumber, toDateKey } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { stationApi } from '@/lib/stationApi';
import type { CalendarActivityKind, CalendarDay } from '@/types/api';

const activityStyle: Record<CalendarActivityKind, { color: string; bg: string; label: string }> = {
  sale: { color: 'bg-orange-500', bg: 'bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-200', label: 'Sales' },
  restock: { color: 'bg-brand-600', bg: 'bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200', label: 'Restock' },
  expense: { color: 'bg-red-500', bg: 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200', label: 'Expense' },
  shift: { color: 'bg-violet-500', bg: 'bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200', label: 'Shift' },
};

const monthLabel = (date: Date) => new Intl.DateTimeFormat('en-KE', { month: 'long', year: 'numeric' }).format(date);
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function CalendarPage() {
  useDocumentTitle('Calendar');
  const { isAdmin } = useAuth();
  const { settings } = useSettings();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState<CalendarDay | null>(null);
  const from = toDateKey(month);
  const to = toDateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const query = useQuery({ queryKey: ['calendar', from, to], queryFn: () => stationApi.calendar.list(from, to), staleTime: 30_000 });
  const days = query.data?.days || [];
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const cells = useMemo(() => {
    const firstWeekday = (new Date(`${from}T00:00:00`).getDay() + 6) % 7;
    const result: Array<{ key: string; item?: CalendarDay; day?: number }> = [];
    for (let index = 0; index < firstWeekday; index += 1) result.push({ key: `blank-${index}` });
    for (let day = 1; day <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); day += 1) {
      const key = `${from.slice(0, 8)}${String(day).padStart(2, '0')}`;
      result.push({ key, day, item: byDate.get(key) });
    }
    return result;
  }, [byDate, from, month]);
  const saleCount = days.reduce((sum, item) => sum + item.saleCount, 0);
  const expenseCount = days.reduce((sum, item) => sum + item.expenseCount, 0);
  const shiftCount = days.reduce((sum, item) => sum + item.shiftCount, 0);
  const activityDays = days.filter((item) => item.activities.length > 0).length;
  const restockAvailable = query.data?.availableKinds.includes('restock') || false;
  const moveMonth = (offset: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));

  return (
    <div className="animate-fade-in">
      <PageHeader title="Station Calendar" description="Daily activity adapted from either daily aggregates or the calendar event collection. Unavailable event types are not invented." actions={<div className="flex gap-2"><Button variant="secondary" onClick={() => moveMonth(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button><Button variant="secondary" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</Button><Button variant="secondary" onClick={() => moveMonth(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button></div>} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3"><span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-950"><CalendarDays className="h-5 w-5" /></span><div><h2 className="text-xl font-black text-slate-950 dark:text-white">{monthLabel(month)}</h2><p className="text-xs text-slate-500">{formatDateKey(from, settings.dateFormat)} – {formatDateKey(to, settings.dateFormat)}</p></div></div>
        <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-600 dark:text-slate-300" aria-label="Calendar legend">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-orange-500" />Sales</span>
          <span className={`flex items-center gap-1.5 ${restockAvailable ? '' : 'opacity-55'}`}><span className="h-2.5 w-2.5 rounded-full bg-brand-600" />Restock {!restockAvailable && <span className="font-normal">(not returned)</span>}</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" />Expense</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-violet-500" />Shift</span>
        </div>
      </div>

      {!isAdmin && <div className="mb-6"><ProtectedState title="Calendar financial results are protected" message="Your calendar shows only your own returned activity. Station-wide financial values are not sent to attendants." /></div>}

      {query.isLoading ? <SectionCard><div className="grid grid-cols-7 gap-px bg-slate-200 dark:bg-slate-800">{Array.from({ length: 35 }, (_, index) => <div key={index} className="h-28 animate-pulse bg-white dark:bg-slate-900" />)}</div></SectionCard> : query.error ? <ErrorState message={query.error instanceof Error ? query.error.message : 'Calendar data could not be loaded.'} onRetry={() => void query.refetch()} /> : <>
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Activity days" value={formatNumber(activityDays)} detail="Days with returned activity" icon={CalendarDays} tone="violet" />
          <StatCard label="Sales recorded" value={formatNumber(saleCount)} detail={isAdmin ? 'Across the station' : 'Your own sales'} icon={ReceiptText} tone="amber" />
          <StatCard label="Expenses" value={isAdmin ? formatNumber(expenseCount) : 'Protected'} detail={isAdmin ? 'Expense event count' : 'Not returned to attendants'} icon={CircleDollarSign} tone="red" />
          <StatCard label="Shift openings" value={formatNumber(shiftCount)} detail="Returned shift events" icon={Clock3} tone="brand" />
        </div>

        <SectionCard padded={false} className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/60">{weekdays.map((day) => <div key={day} className="px-1 py-3 text-center text-[10px] font-black uppercase tracking-wide text-slate-500 sm:text-xs">{day}</div>)}</div>
          <div className="grid grid-cols-7 bg-slate-200 dark:bg-slate-800">
            {cells.map((cell) => cell.item ? <button key={cell.key} type="button" onClick={() => setSelected(cell.item || null)} className="min-h-24 bg-white p-1.5 text-left align-top transition hover:bg-brand-50/50 focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:min-h-32 sm:p-2 dark:bg-slate-900 dark:hover:bg-brand-950/20"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-slate-700 dark:text-slate-200">{cell.day}</span><div className="mt-2 space-y-1">{cell.item.activities.slice(0, 4).map((activity) => <span key={activity.id} className={`flex items-center gap-1 truncate rounded px-1.5 py-1 text-[9px] font-bold sm:text-[10px] ${activityStyle[activity.kind].bg}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityStyle[activity.kind].color}`} />{activity.label}</span>)}</div></button> : cell.day ? <div key={cell.key} className="min-h-24 bg-white p-1.5 sm:min-h-32 sm:p-2 dark:bg-slate-900"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-slate-400">{cell.day}</span></div> : <div key={cell.key} aria-hidden="true" className="min-h-24 bg-slate-50 dark:bg-slate-950/50 sm:min-h-32" />)}
          </div>
        </SectionCard>

        <SectionCard className="mt-6" title="Timeline of returned activity" description="Only days with actual calendar events are listed." padded={false}>
          {!days.some((item) => item.activities.length) ? <EmptyState title="No activity this month" message="The calendar API returned no recognized sales, restock, expense, or shift events for this month." icon={CalendarDays} /> : <ul className="divide-y divide-slate-100 dark:divide-slate-800">{days.filter((item) => item.activities.length).map((item) => <li key={item.date}><button type="button" onClick={() => setSelected(item)} className="grid w-full gap-3 p-4 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-inset focus-visible:ring-brand-500 sm:grid-cols-[150px_1fr_auto] sm:items-center dark:hover:bg-slate-800/50"><span className="text-sm font-bold text-slate-900 dark:text-white">{formatDateKey(item.date, settings.dateFormat)}</span><span className="flex flex-wrap gap-2">{item.activities.map((activity) => <span key={activity.id} className={`rounded-full px-2.5 py-1 text-xs font-bold ${activityStyle[activity.kind].bg}`}>{activity.label}</span>)}</span><span className="text-xs font-semibold text-slate-500">{isAdmin && !item.financialHidden && item.salesKsh !== null ? `${formatKsh(item.salesKsh)} sales` : formatLitres(item.litres)}</span></button></li>)}</ul>}
        </SectionCard>
      </>}

      {selected && <div className="mt-6"><SectionCard title={`${formatDateKey(selected.date, settings.dateFormat)} activity`} action={<Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close detail</Button>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-orange-50 p-4 dark:bg-orange-950/30"><ReceiptText className="h-5 w-5 text-orange-600" /><p className="mt-2 text-xs text-slate-500">Sales / volume</p><p className="mt-1 font-black">{formatNumber(selected.saleCount)} · {formatLitres(selected.litres)}</p></div>
          <div className="rounded-xl bg-violet-50 p-4 dark:bg-violet-950/30"><WalletCards className="h-5 w-5 text-violet-600" /><p className="mt-2 text-xs text-slate-500">Shift openings</p><p className="mt-1 font-black">{formatNumber(selected.shiftCount)}</p></div>
          <div className="rounded-xl bg-red-50 p-4 dark:bg-red-950/30"><CircleDollarSign className="h-5 w-5 text-red-600" /><p className="mt-2 text-xs text-slate-500">Expenses</p><p className="mt-1 font-black">{isAdmin ? formatNumber(selected.expenseCount) : 'Protected'}</p></div>
          <div className="rounded-xl bg-brand-50 p-4 dark:bg-brand-950/30"><PackagePlus className="h-5 w-5 text-brand-600" /><p className="mt-2 text-xs text-slate-500">Restock events</p><p className="mt-1 font-black">{restockAvailable ? formatNumber(selected.restockCount) : 'Not supplied by API'}</p></div>
        </div>
        {isAdmin && !selected.financialHidden && (selected.salesKsh !== null || selected.expensesKsh !== null) && <div className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-4 dark:bg-slate-800"><div><p className="text-xs text-slate-500">Sales</p><p className="font-black">{formatKsh(selected.salesKsh)}</p></div><div><p className="text-xs text-slate-500">COGS</p><p className="font-black">{formatKsh(selected.cogsKsh)}</p></div><div><p className="text-xs text-slate-500">Expenses</p><p className="font-black">{formatKsh(selected.expensesKsh)}</p></div><div><p className="text-xs text-slate-500">Net</p><p className="font-black">{formatKsh(selected.netKsh)}</p></div></div>}
        {!restockAvailable && <div className="mt-4 flex items-center gap-2 text-xs text-slate-500"><Fuel className="h-4 w-4" /><span>The current calendar contract does not return restock events. This is shown as unavailable rather than fabricated.</span></div>}
      </SectionCard></div>}
    </div>
  );
}
