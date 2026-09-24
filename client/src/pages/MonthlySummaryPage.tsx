import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Award, CalendarDays, Fuel, Landmark, TrendingDown, TrendingUp, WalletCards } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/Button';
import { DataTable, PageHeader, SectionCard, StatCard, type Column } from '@/components/ui/DataDisplay';
import { Field, Input } from '@/components/ui/Form';
import { ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { request } from '@/lib/api';
import { formatDateKey, formatKsh, formatLitres, formatNumber, formatPercent } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { DailyTrend, MonthlyReport } from '@/types/api';

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface TooltipEntry { value?: number | string; name?: string; color?: string }
function MonthlyTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lift dark:border-slate-700 dark:bg-slate-900">{label && <p className="mb-1 font-bold">{label}</p>}{payload.map((entry, index) => <p key={`${entry.name}-${index}`} style={{ color: entry.color }}>{entry.name}: {formatKsh(Number(entry.value))}</p>)}</div>;
}

function ChangeCard({ label, value, percent, icon: Icon, inverse = false }: { label: string; value: number; percent: number | null; icon: typeof TrendingUp; inverse?: boolean }) {
  const positive = value > 0;
  const favorable = inverse ? value <= 0 : value >= 0;
  const IconArrow = value === 0 ? ArrowRight : value > 0 ? ArrowUpRight : ArrowDownRight;
  return <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-panel dark:border-slate-800 dark:bg-slate-900"><div className="flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span><Icon className="h-4 w-4 text-slate-400" /></div><p className="mt-2 text-xl font-black text-slate-950 dark:text-white">{formatKsh(value)}</p><p className={`mt-1 flex items-center gap-1 text-xs font-bold ${value === 0 ? 'text-slate-500' : favorable ? 'text-emerald-600' : 'text-red-600'}`}><IconArrow className="h-3.5 w-3.5" />{value === 0 ? 'No change' : `${positive ? '+' : ''}${formatKsh(value)}`} {percent !== null && `(${percent > 0 ? '+' : ''}${formatPercent(percent)})`}</p></div>;
}

export default function MonthlySummaryPage() {
  useDocumentTitle('Monthly Summary');
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const results = useQueries({ queries: Array.from({ length: 12 }, (_, index) => ({ queryKey: ['monthly-report', year, index + 1], queryFn: () => request<{ report: MonthlyReport }>(`/reports/monthly?year=${year}&month=${index + 1}`), staleTime: 60_000 })) });
  const reports = results.map((result) => result.data?.report || null);
  const selected = reports[selectedMonth - 1] || null;
  const selectedLoading = results[selectedMonth - 1]?.isLoading;
  const selectedError = results[selectedMonth - 1]?.error;
  const allLoading = results.every((result) => result.isLoading);
  const allError = results.find((result) => result.error)?.error;

  const matrix = useMemo(() => reports.map((report, index) => ({ month: index + 1, report })), [reports]);
  const chart = selected?.dailyTrend.map((day) => ({ ...day, label: day.date.slice(8) })) || [];
  const grossMargin = selected && selected.totals.salesKsh !== 0 ? selected.totals.grossProfitKsh / selected.totals.salesKsh * 100 : null;

  const columns: Array<Column<{ month: number; report: MonthlyReport | null }>> = [
    { key: 'month', header: 'Month', render: (row) => <button type="button" className="font-bold text-brand-700 hover:underline dark:text-brand-300" onClick={() => setSelectedMonth(row.month)}>{monthNames[row.month - 1]}</button> },
    { key: 'sales', header: 'Revenue', render: (row) => formatKsh(row.report?.totals.salesKsh || 0) },
    { key: 'litres', header: 'Litres', render: (row) => formatLitres(row.report?.totals.litres || 0) },
    { key: 'cogs', header: 'COGS', render: (row) => formatKsh(row.report?.totals.cogsKsh || 0) },
    { key: 'gross', header: 'Gross profit', render: (row) => <span><span className="font-bold">{formatKsh(row.report?.totals.grossProfitKsh || 0)}</span><span className="block text-xs text-slate-500">{row.report && row.report.totals.salesKsh ? `${((row.report.totals.grossProfitKsh / row.report.totals.salesKsh) * 100).toFixed(1)}%` : '0.0%'}</span></span> },
    { key: 'expenses', header: 'Expenses', render: (row) => formatKsh(row.report?.totals.expensesKsh || 0) },
    { key: 'net', header: 'Net', render: (row) => <span className={`font-black ${(row.report?.totals.netKsh || 0) < 0 ? 'text-red-600' : ''}`}>{formatKsh(row.report?.totals.netKsh || 0)}</span> },
    { key: 'gap', header: 'Cumulative gaps', render: (row) => <span><span className="block">Signed: {formatKsh(row.report?.shiftGaps.signedKsh || 0)}</span><span className="text-xs text-slate-500">Absolute: {formatKsh(row.report?.shiftGaps.absoluteKsh || 0)}</span></span> },
  ];

  const dailyColumns: Array<Column<DailyTrend>> = [
    { key: 'date', header: 'Date', render: (item) => formatDateKey(item.date) },
    { key: 'sales', header: 'Sales', render: (item) => formatKsh(item.salesKsh) },
    { key: 'gross', header: 'Gross', render: (item) => formatKsh(item.grossProfitKsh) },
    { key: 'expenses', header: 'Expenses', render: (item) => formatKsh(item.expensesKsh) },
    { key: 'net', header: 'Net', render: (item) => <span className={item.netKsh < 0 ? 'font-bold text-red-600' : 'font-bold'}>{formatKsh(item.netKsh)}</span> },
  ];

  if (allError) return <ErrorState message={allError instanceof Error ? allError.message : 'Monthly reports could not be loaded.'} onRetry={() => results.forEach((result) => void result.refetch())} />;
  if (allLoading) return <PageLoader label={`Loading the ${year} monthly matrix…`} />;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Monthly Summary" description="A complete month-by-month matrix built from actual monthly report responses." actions={<div className="w-36"><Field id="summary-year" label="Year"><Input id="summary-year" type="number" min="2020" max={new Date().getFullYear()} value={year} onChange={(event) => setYear(Math.max(2020, Math.min(new Date().getFullYear(), Number(event.target.value))))} /></Field></div>} />

      <SectionCard className="mb-6" title={`${year} month matrix`} description="Zero values represent server-confirmed no activity, not sample data." padded={false}>
        <DataTable columns={columns} data={matrix} getRowKey={(row) => row.month} caption={`Monthly summary matrix for ${year}`} emptyTitle="No months available" emptyMessage="Choose a supported year." renderMobile={(row) => <button type="button" onClick={() => setSelectedMonth(row.month)} className="w-full p-4 text-left"><div className="flex justify-between"><p className="font-bold">{monthNames[row.month - 1]}</p><p className="font-black">{formatKsh(row.report?.totals.netKsh || 0)}</p></div><p className="mt-2 text-xs text-slate-500">Sales {formatKsh(row.report?.totals.salesKsh || 0)} · {formatLitres(row.report?.totals.litres || 0)}</p></button>} />
      </SectionCard>

      <div className="mb-6 flex flex-wrap gap-2" aria-label="Select report month">
        {monthNames.map((name, index) => <Button key={name} size="sm" variant={selectedMonth === index + 1 ? 'primary' : 'secondary'} onClick={() => setSelectedMonth(index + 1)}>{name.slice(0, 3)}</Button>)}
      </div>

      {selectedLoading ? <PageLoader label={`Loading ${monthNames[selectedMonth - 1]}…`} /> : selectedError ? <ErrorState message={selectedError instanceof Error ? selectedError.message : 'The selected month could not be loaded.'} onRetry={() => void results[selectedMonth - 1]?.refetch()} /> : selected && <>
        <div className="mb-6 flex items-center gap-3"><span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-950"><CalendarDays className="h-5 w-5" /></span><div><h2 className="text-xl font-black text-slate-950 dark:text-white">{monthNames[selectedMonth - 1]} {year}</h2><p className="text-sm text-slate-500">Compared with {monthNames[selected.previousPeriod.month - 1]} {selected.previousPeriod.year}</p></div></div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Revenue" value={formatKsh(selected.totals.salesKsh)} detail={`${formatNumber(selected.totals.saleCount)} sales`} icon={TrendingUp} tone="brand" />
          <StatCard label="Litres sold" value={formatLitres(selected.totals.litres)} detail="Monthly volume" icon={Fuel} tone="blue" />
          <StatCard label="Gross profit" value={formatKsh(selected.totals.grossProfitKsh)} detail={grossMargin === null ? 'No revenue' : `${grossMargin.toFixed(1)}% margin`} icon={WalletCards} tone="green" />
          <StatCard label="Expenses" value={formatKsh(selected.totals.expensesKsh)} detail="Monthly expenses" icon={TrendingDown} tone="amber" />
          <StatCard label="Net" value={formatKsh(selected.totals.netKsh)} detail={`Absolute shift gap ${formatKsh(selected.shiftGaps.absoluteKsh)}`} icon={Landmark} tone={selected.totals.netKsh < 0 ? 'red' : 'violet'} />
        </div>

        {selected.dataStatus !== 'complete' && <div className="mt-5"><InlineAlert tone="warning" title="Meter coverage is incomplete">{selected.dataStatus === 'noSalesMeterReadings' ? 'No sales-meter readings were returned for this month, so formal revenue is zero until meter data is entered.' : `${formatNumber(selected.coverage.coveredGroups)} of ${formatNumber(selected.coverage.recordedGroups)} recorded sale groups have matching sales-meter data.`}</InlineAlert></div>}

        <SectionCard className="mt-6" title="Month-over-month vectors" description="Absolute KSh movement and percentage change from the previous month.">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <ChangeCard label="Revenue" value={selected.monthOverMonth.revenue.absoluteKsh} percent={selected.monthOverMonth.revenue.percent} icon={TrendingUp} />
            <ChangeCard label="COGS" value={selected.monthOverMonth.cogs.absoluteKsh} percent={selected.monthOverMonth.cogs.percent} icon={TrendingDown} inverse />
            <ChangeCard label="Gross profit" value={selected.monthOverMonth.grossProfit.absoluteKsh} percent={selected.monthOverMonth.grossProfit.percent} icon={Award} />
            <ChangeCard label="Expenses" value={selected.monthOverMonth.expenses.absoluteKsh} percent={selected.monthOverMonth.expenses.percent} icon={TrendingDown} inverse />
            <ChangeCard label="Net" value={selected.monthOverMonth.net.absoluteKsh} percent={selected.monthOverMonth.net.percent} icon={Landmark} />
          </div>
          <p className="mt-4 text-xs text-slate-500">Litres movement: <strong>{selected.monthOverMonth.litres.absolute > 0 ? '+' : ''}{formatLitres(selected.monthOverMonth.litres.absolute)}</strong> ({selected.monthOverMonth.litres.percent === null ? 'No comparison' : `${selected.monthOverMonth.litres.percent > 0 ? '+' : ''}${formatPercent(selected.monthOverMonth.litres.percent)}`}).</p>
        </SectionCard>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <SectionCard title="Daily net trend" description="Server-calculated daily revenue and net values for the selected month.">
            <div className="h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" opacity={0.2} /><XAxis dataKey="label" tick={{ fontSize: 10 }} /><YAxis tickFormatter={(value: number) => formatKsh(value)} width={78} tick={{ fontSize: 10 }} /><Tooltip content={<MonthlyTooltip />} /><Legend /><Line type="monotone" dataKey="salesKsh" name="Sales" stroke="#198a62" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="netKsh" name="Net" stroke="#f57618" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>
          </SectionCard>
          <SectionCard title="Best and worst days" description="Only days with sales or expenses qualify.">
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30"><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"><TrendingUp className="h-4 w-4" />Best day</p>{selected.bestDay ? <><p className="mt-2 font-black text-emerald-950 dark:text-emerald-100">{formatDateKey(selected.bestDay.date)}</p><p className="mt-1 text-lg font-black">{formatKsh(selected.bestDay.revenueKsh)}</p></> : <p className="mt-2 text-sm text-slate-500">No qualifying activity.</p>}</div>
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-950 dark:bg-red-950/30"><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-300"><TrendingDown className="h-4 w-4" />Worst day</p>{selected.worstDay ? <><p className="mt-2 font-black text-red-950 dark:text-red-100">{formatDateKey(selected.worstDay.date)}</p><p className="mt-1 text-lg font-black">{formatKsh(selected.worstDay.revenueKsh)}</p></> : <p className="mt-2 text-sm text-slate-500">No qualifying activity.</p>}</div>
            </div>
          </SectionCard>
        </div>

        <SectionCard className="mt-6" title="Daily monthly detail" padded={false}><DataTable columns={dailyColumns} data={selected.dailyTrend} getRowKey={(item) => item.date} caption={`${monthNames[selectedMonth - 1]} daily values`} /></SectionCard>
        <div className="mt-5"><InlineAlert>All monetary values use KSh. Percentage changes are unavailable when the previous month value is zero, matching the server contract.</InlineAlert></div>
      </>}
    </div>
  );
}
