import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Banknote, Clock3, Droplet, FileCheck2, Receipt, ShieldCheck, ShoppingCart, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, SectionCard, StatCard } from '@/components/ui/DataDisplay';
import { EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { request } from '@/lib/api';
import { formatDateKey, formatKsh, formatLitres, formatNumber, formatTime, greeting } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import type { Dashboard } from '@/types/api';

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const { user } = useAuth();
  const { settings } = useSettings();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => request<Dashboard>('/dashboard'),
    staleTime: 20_000,
  });
  const firstName = user?.fullName.split(/\s+/)[0] || user?.username || 'there';

  if (query.isLoading) return <PageLoader label="Loading today’s station position…" />;
  if (query.error || !query.data) return <ErrorState message={query.error instanceof Error ? query.error.message : 'Dashboard data is unavailable.'} onRetry={() => void query.refetch()} />;

  const data = query.data;
  const lowStockAlerts = data.role === 'admin'
    ? data.lowStockAlerts.filter((alert) => alert.fuelType === 'PETROL' || alert.fuelType === 'DIESEL')
    : [];
  return (
    <div className="animate-fade-in">
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={data.role === 'admin' ? `Here is the station’s verified position for ${formatDateKey(data.date, settings.dateFormat)}.` : 'Your shift and personal activity only. Station-wide financial results are protected.'}
        actions={<span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{formatDateKey(data.date, settings.dateFormat)}</span>}
      />

      {data.role === 'admin' ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Today’s sales" value={formatKsh(data.today.salesKsh)} detail={`${formatNumber(data.today.salesCount)} recorded sales`} icon={ShoppingCart} tone="brand" />
            <StatCard label="Net position" value={formatKsh(data.today.netKsh)} detail="Sales less COGS and expenses" icon={Banknote} tone={data.today.netKsh < 0 ? 'red' : 'green'} />
            <StatCard label="Open shifts" value={formatNumber(data.openShiftCount)} detail="Across all station users" icon={Clock3} tone="blue" />
            <StatCard label="Low stock alerts" value={formatNumber(lowStockAlerts.length)} detail={lowStockAlerts.length ? 'Fuel types need attention' : 'No active fuel is below threshold'} icon={AlertTriangle} tone={lowStockAlerts.length ? 'amber' : 'green'} />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
            <SectionCard title="Today at a glance" description="Amounts are calculated by the station server.">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ['Cash', data.today.cashKsh],
                  ['M-Pesa', data.today.mpesaKsh],
                  ['Litres sold', data.today.litresSold],
                  ['Cost of goods', data.today.cogsKsh],
                  ['Gross profit', data.today.salesKsh - data.today.cogsKsh],
                  ['Expenses', data.today.expensesKsh],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 dark:bg-slate-800/60">
                    <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>
                    <span className="font-bold tabular-nums text-slate-900 dark:text-white">{typeof value === 'number' && (label === 'Litres sold' ? formatLitres(value) : formatKsh(value))}</span>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard title="Inventory alerts" description="Fuel at or below the configured threshold">
              {!lowStockAlerts.length ? (
                <EmptyState title="Inventory is healthy" message="No active fuel type is currently at or below the low-stock threshold." icon={ShieldCheck} />
              ) : (
                <ul className="space-y-3">
                  {lowStockAlerts.map((alert) => (
                    <li key={alert.fuelId} className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 dark:border-amber-900 dark:bg-amber-950/30">
                      <div className="flex items-center justify-between gap-3"><span className="font-bold capitalize text-amber-950 dark:text-amber-100">{alert.fuelType.toLowerCase()}</span><span className="font-black text-amber-800 dark:text-amber-200">{formatLitres(alert.quantityLitres)}</span></div>
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Threshold: {formatLitres(alert.thresholdLitres)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/restock" className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-brand-700 hover:underline dark:text-brand-300">Review inventory <ArrowRight className="h-4 w-4" /></Link>
            </SectionCard>
          </div>
        </>
      ) : (
        <>
          <div className="mb-6 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
            <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-bold">Your attendant view is privacy protected</p><p className="mt-0.5 leading-6">Station-wide revenue, costs, inventory values, and reconciliation results are not returned to your account.</p></div></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="My shift" value={data.openShift ? 'Open' : 'Closed'} detail={data.openShift ? `Opened ${formatTime(data.openShift.openedAt, settings.timezone)}` : 'Open a shift to record sales'} icon={Clock3} tone={data.openShift ? 'green' : 'slate'} />
            <StatCard label="My sales today" value={formatNumber(data.ownToday.saleCount)} detail="Your submitted sales only" icon={Receipt} tone="blue" />
            <StatCard label="My litres today" value={formatLitres(data.ownToday.litresSold)} detail="Your recorded activity only" icon={Droplet} tone="violet" />
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <SectionCard title="Start your work" description="The server requires an open shift for sales and expenses.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Link to={data.openShift ? '/sales' : '/shift'} className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 p-4 transition hover:border-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-brand-900 dark:bg-brand-950/30">
                  <span className="rounded-lg bg-brand-700 p-2 text-white"><Receipt className="h-5 w-5" /></span><span className="font-bold text-brand-900 dark:text-brand-100">{data.openShift ? 'Record a sale' : 'Open my shift'}</span>
                </Link>
                <Link to="/pump-readings" className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 transition hover:border-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-slate-700"><span className="rounded-lg bg-blue-100 p-2 text-blue-700 dark:bg-blue-950"><FileCheck2 className="h-5 w-5" /></span><span className="font-bold">Meter reading</span></Link>
              </div>
            </SectionCard>
            <SectionCard title="Your current status" description="No global station figures are included.">
              <div className="flex items-center gap-4"><span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl ${data.openShift ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950' : 'bg-slate-100 text-slate-600 dark:bg-slate-800'}`}><UsersRound className="h-6 w-6" /></span><div><p className="font-bold text-slate-900 dark:text-white">{data.openShift ? 'Ready for transactions' : 'No open shift'}</p><p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{data.openShift ? 'Sales and expenses can be recorded.' : 'Open a shift to begin recording activity.'}</p></div></div>
              <Link to="/shift" className="mt-5 inline-flex items-center gap-1 text-sm font-bold text-brand-700 hover:underline dark:text-brand-300">Go to My Shift <ArrowRight className="h-4 w-4" /></Link>
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}
