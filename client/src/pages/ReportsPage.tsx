import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CalendarRange, Download, Fuel, Landmark, PieChart as PieChartIcon, ReceiptText, TrendingUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/Button';
import { DataTable, PageHeader, SectionCard, StatCard, type Column } from '@/components/ui/DataDisplay';
import { DateRange, Field, Select } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { buildQuery, download, request } from '@/lib/api';
import { endOfMonth, formatDateKey, formatKsh, formatLitres, formatNumber, startOfWeek, toDateKey } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { dateRangeError } from '@/lib/validation';
import type { DailyTrend, Fuel as StationFuel, OperationsReport, User } from '@/types/api';

type Preset = 'week' | 'month' | 'year' | 'custom';

function presetRange(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  if (preset === 'week') return { from: toDateKey(startOfWeek(now)), to: toDateKey(now) };
  if (preset === 'year') return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  return { from: toDateKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: toDateKey(endOfMonth(now)) };
}

interface TooltipEntry { value?: number | string; name?: string; color?: string }
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-xl border border-slate-200 bg-white/95 p-3 text-xs shadow-lift dark:border-slate-700 dark:bg-slate-900/95">{label && <p className="mb-1 font-bold text-slate-900 dark:text-white">{label}</p>}{payload.map((item, index) => <p key={`${item.name}-${index}`} style={{ color: item.color }}>{item.name}: {item.value === undefined ? '—' : formatKsh(Number(item.value))}</p>)}</div>;
}
const chartColors = ['#198a62', '#f57618', '#2563eb', '#7c3aed'];

export default function ReportsPage() {
  useDocumentTitle('Reports');
  const initial = presetRange('month');
  const [preset, setPreset] = useState<Preset>('month');
  const [draft, setDraft] = useState(initial);
  const [range, setRange] = useState(initial);
  const [fuelId, setFuelId] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<DailyTrend | null>(null);
  const [downloading, setDownloading] = useState(false);

  const query = { ...range, fuelId: fuelId || undefined, userId: userId || undefined };
  const report = useQuery({ queryKey: ['reports', query], queryFn: () => request<{ report: OperationsReport }>(`/reports${buildQuery(query)}`), enabled: true });
  const fuels = useQuery({ queryKey: ['fuel'], queryFn: () => request<{ data: StationFuel[] }>('/fuel'), staleTime: 60_000 });
  const users = useQuery({ queryKey: ['users', 'report-filter'], queryFn: () => request<{ data: User[] }>('/users?pageSize=100'), staleTime: 60_000 });

  const choosePreset = (value: Exclude<Preset, 'custom'>) => {
    const next = presetRange(value); setPreset(value); setDraft(next); setRange(next); setError(null);
  };
  const apply = (event: FormEvent) => {
    event.preventDefault(); const validation = dateRangeError(draft.from, draft.to); setError(validation); if (validation) return;
    const days = (new Date(`${draft.to}T00:00:00`).getTime() - new Date(`${draft.from}T00:00:00`).getTime()) / 86_400_000;
    if (days > 366) { setError('The report date range cannot exceed 367 days.'); return; }
    setPreset('custom'); setRange({ from: draft.from, to: draft.to });
  };
  const exportCsv = async () => {
    setDownloading(true);
    try { await download(`/reports/export.csv${buildQuery(range)}`, `zenenergies-operational-${range.from}-to-${range.to}.csv`); toast.success('CSV export downloaded.'); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The CSV export failed.'); }
    finally { setDownloading(false); }
  };

  const data = report.data?.report;
  const paymentData = data ? [{ name: 'Cash', value: data.paymentSplit.cashKsh }, { name: 'M-Pesa', value: data.paymentSplit.mpesaKsh }] : [];
  const fuelData = data?.fuels
    .filter((fuel) => fuel.type === 'PETROL' || fuel.type === 'DIESEL')
    .map((fuel) => ({ ...fuel, name: fuel.type.charAt(0) + fuel.type.slice(1).toLowerCase() })) || [];
  const dailyData = data?.dailyTrend.map((day) => ({ ...day, label: day.date.slice(5) })) || [];
  const grossMargin = data && data.totals.salesKsh !== 0 ? (data.totals.grossProfitKsh / data.totals.salesKsh) * 100 : null;

  const columns: Array<Column<DailyTrend>> = [
    { key: 'date', header: 'Date', render: (item) => <button type="button" className="font-bold text-brand-700 hover:underline dark:text-brand-300" onClick={() => setSelectedDay(item)}>{formatDateKey(item.date, data?.period.timezone ? 'yyyy-MM-dd' : 'yyyy-MM-dd')}</button> },
    { key: 'sales', header: 'Sales', render: (item) => formatKsh(item.salesKsh) },
    { key: 'litres', header: 'Litres', render: (item) => formatLitres(item.litres) },
    { key: 'cogs', header: 'COGS', render: (item) => formatKsh(item.cogsKsh) },
    { key: 'gross', header: 'Gross profit', render: (item) => <span className="font-bold">{formatKsh(item.grossProfitKsh)}</span> },
    { key: 'expenses', header: 'Expenses', render: (item) => formatKsh(item.expensesKsh) },
    { key: 'net', header: 'Net', render: (item) => <span className={`font-black ${item.netKsh < 0 ? 'text-red-600' : 'text-slate-950 dark:text-white'}`}>{formatKsh(item.netKsh)}</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Operations Reports" description="Admin-only analysis from sales, expenses, COGS, and closed-shift gaps. All figures are in KSh." actions={<Button variant="secondary" onClick={() => void exportCsv()} loading={downloading} leftIcon={<Download className="h-4 w-4" />}>Export CSV</Button>} />

      <SectionCard title="Report period" className="mb-6" description="Choose a preset or set an explicit inclusive date range.">
        <div className="mb-5 flex flex-wrap gap-2">
          {([['week', 'This week'], ['month', 'This month'], ['year', 'This year']] as const).map(([value, label]) => <Button key={value} variant={preset === value ? 'primary' : 'secondary'} size="sm" leftIcon={<CalendarRange className="h-4 w-4" />} onClick={() => choosePreset(value)}>{label}</Button>)}
        </div>
        <form onSubmit={apply} className="grid items-end gap-4 lg:grid-cols-[1fr_1fr_0.7fr_0.7fr_auto]">
          <DateRange from={draft.from} to={draft.to} onChange={(from, to) => { setDraft({ from, to }); setPreset('custom'); }} error={error} />
          <Field id="report-fuel" label="Fuel"><Select id="report-fuel" value={fuelId} placeholder="All fuel" options={(fuels.data?.data || []).map((fuel) => ({ value: String(fuel.id), label: fuel.fuelType }))} onChange={(event) => setFuelId(event.target.value)} /></Field>
          <Field id="report-user" label="User"><Select id="report-user" value={userId} placeholder="All users" options={(users.data?.data || []).map((user) => ({ value: String(user.id), label: user.fullName }))} onChange={(event) => setUserId(event.target.value)} /></Field>
          <Button type="submit" loading={report.isFetching}>Update report</Button>
        </form>
        <p className="mt-3 text-xs text-slate-500">Showing {formatDateKey(range.from)} through {formatDateKey(range.to)}. User filters apply to sales, expenses, and shifts; fuel filters apply to sales.</p>
      </SectionCard>

      {report.isLoading ? <PageLoader label="Calculating the report…" /> : report.error ? <ErrorState message={report.error instanceof Error ? report.error.message : 'The report could not be generated.'} onRetry={() => void report.refetch()} /> : data && <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Revenue" value={formatKsh(data.totals.salesKsh)} detail={`${formatNumber(data.totals.saleCount)} sales`} icon={TrendingUp} tone="brand" />
          <StatCard label="Litres" value={formatLitres(data.totals.litres)} detail="Server-aggregated volume" icon={Fuel} tone="blue" />
          <StatCard label="Gross profit" value={formatKsh(data.totals.grossProfitKsh)} detail={grossMargin === null ? 'No revenue in period' : `${grossMargin.toFixed(1)}% margin`} icon={BarChart3} tone="green" />
          <StatCard label="Expenses" value={formatKsh(data.totals.expensesKsh)} detail="Station expenses" icon={ReceiptText} tone="amber" />
          <StatCard label="Net" value={formatKsh(data.totals.netKsh)} detail={`Signed shift gap ${formatKsh(data.shiftGaps.signedKsh)}`} icon={Landmark} tone={data.totals.netKsh < 0 ? 'red' : 'violet'} />
        </div>

        {data.dataStatus !== 'complete' && <div className="mt-5"><InlineAlert tone="warning" title="Formal revenue meter coverage">{data.dataStatus === 'noSalesMeterReadings' ? 'No sales-meter readings exist for this period. Recorded sale revenue is shown separately, while formal revenue remains zero.' : `${data.coverage.coveredGroups} of ${data.coverage.recordedGroups} sale groups have matching sales-meter readings.`}</InlineAlert></div>}

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <SectionCard title="Daily financial trend" description="Revenue and net result for every date in the selected period.">
            <div className="h-80 w-full" aria-label="Daily sales and net chart">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={dailyData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" opacity={0.2} /><XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={18} /><YAxis tickFormatter={(value: number) => formatKsh(value)} width={78} tick={{ fontSize: 11 }} /><Tooltip content={<ChartTooltip />} /><Legend /><Line type="monotone" dataKey="salesKsh" name="Sales" stroke="#198a62" strokeWidth={2.5} dot={false} /><Line type="monotone" dataKey="netKsh" name="Net" stroke="#f57618" strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer>
            </div>
          </SectionCard>
          <SectionCard title="Payment split" description="Actual KSh totals for the period.">
            {data.paymentSplit.cashKsh === 0 && data.paymentSplit.mpesaKsh === 0 ? <div className="flex h-64 flex-col items-center justify-center text-center"><PieChartIcon className="h-8 w-8 text-slate-300" /><p className="mt-2 text-sm text-slate-500">No payment records in this period.</p></div> : <div className="h-64"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={paymentData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>{paymentData.map((item, index) => <Cell key={item.name} fill={chartColors[index]} />)}</Pie><Tooltip content={<ChartTooltip />} /><Legend /></PieChart></ResponsiveContainer></div>}
            <div className="mt-2 grid grid-cols-2 gap-3"><div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/30"><p className="text-xs text-slate-500">Cash</p><p className="mt-1 font-black">{formatKsh(data.paymentSplit.cashKsh)}</p></div><div className="rounded-xl bg-blue-50 p-3 dark:bg-blue-950/30"><p className="text-xs text-slate-500">M-Pesa</p><p className="mt-1 font-black">{formatKsh(data.paymentSplit.mpesaKsh)}</p></div></div>
          </SectionCard>
        </div>

        <SectionCard className="mt-6" title="Fuel performance" description="Revenue and gross profit by fuel type. Empty means no sales in the period.">
          {!fuelData.length ? <div className="py-10 text-center text-sm text-slate-500">No fuel sales were recorded in this period.</div> : <div className="h-72"><ResponsiveContainer width="100%" height="100%"><BarChart data={fuelData}><CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" opacity={0.2} /><XAxis dataKey="name" /><YAxis tickFormatter={(value: number) => formatKsh(value)} width={78} tick={{ fontSize: 11 }} /><Tooltip content={<ChartTooltip />} /><Legend /><Bar dataKey="salesKsh" name="Sales" fill="#198a62" radius={[5, 5, 0, 0]} /><Bar dataKey="grossProfitKsh" name="Gross profit" fill="#f57618" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>}
        </SectionCard>

        <SectionCard className="mt-6" title="Daily detail" description="Select a date to inspect its server-calculated line items." padded={false}>
          <DataTable columns={columns} data={data.dailyTrend} getRowKey={(item) => item.date} emptyTitle="No daily rows" emptyMessage="The server normally returns one row per selected date, including zero-value dates." caption="Daily report detail" />
        </SectionCard>
      </>}

      <Modal open={Boolean(selectedDay)} onClose={() => setSelectedDay(null)} title={selectedDay ? `Daily detail · ${selectedDay.date}` : 'Daily detail'} size="md">
        {selectedDay && <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">{[
            ['Formal revenue', formatKsh(selectedDay.formalRevenueKsh)], ['Recorded sales', formatKsh(selectedDay.recordedSaleRevenueKsh)], ['Revenue variance', formatKsh(selectedDay.revenueVarianceKsh)], ['Cost of goods', formatKsh(selectedDay.cogsKsh)], ['Gross profit', formatKsh(selectedDay.grossProfitKsh)], ['Gross margin', selectedDay.grossMarginPercent === null ? '—' : `${selectedDay.grossMarginPercent.toFixed(1)}%`], ['Expenses', formatKsh(selectedDay.expensesKsh)], ['Net', formatKsh(selectedDay.netKsh)], ['Litres', formatLitres(selectedDay.litres)], ['Sales count', formatNumber(selectedDay.saleCount)], ['Cumulative signed gap', formatKsh(selectedDay.cumulativeSignedShiftGapKsh)], ['Cumulative absolute gap', formatKsh(selectedDay.cumulativeAbsoluteShiftGapKsh)],
          ].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-slate-500 dark:text-slate-400">{label}</p><p className="mt-1 font-black text-slate-900 dark:text-white">{value}</p></div>)}</div>
          <InlineAlert>Amounts are in KSh. This detail is an aggregate; the server report endpoint does not expose individual sale lines in this view.</InlineAlert>
        </div>}
      </Modal>
    </div>
  );
}
