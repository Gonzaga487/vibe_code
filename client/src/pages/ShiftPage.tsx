import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, Clock3, LockKeyhole, Scale, Smartphone, WalletCards } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { DataTable, PageHeader, SectionCard, StatCard, Badge, type Column } from '@/components/ui/DataDisplay';
import { Field, KshInput, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { useSettings } from '@/context/SettingsContext';
import { buildQuery, request } from '@/lib/api';
import { formatDateKey, formatDateTime, formatKsh, formatLitres, formatNumber, formatTime } from '@/lib/format';
import { useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { firstError, nonNegativeNumber } from '@/lib/validation';
import type { Paginated, Shift } from '@/types/api';

interface ShiftResponse { shift: Shift | null }
interface CloseResponse { shift: Shift; summary: Shift['summary'] }

type DifferenceState = 'balanced' | 'shortage' | 'surplus' | 'pending';

function differenceState(value: number, entered: boolean): DifferenceState {
  if (!entered) return 'pending';
  if (Math.abs(value) < 0.005) return 'balanced';
  return value < 0 ? 'shortage' : 'surplus';
}

const differenceCopy: Record<Exclude<DifferenceState, 'pending'>, { label: string; className: string }> = {
  balanced: { label: 'Balanced', className: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100' },
  shortage: { label: 'Shortage', className: 'border-red-300 bg-red-50 text-red-900 dark:border-red-950 dark:bg-red-950/50 dark:text-red-100' },
  surplus: { label: 'Surplus', className: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-950 dark:bg-amber-950/50 dark:text-amber-100' },
};

export default function ShiftPage() {
  useDocumentTitle('My Shift');
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const [openingCash, setOpeningCash] = useState('0');
  const [openingMpesa, setOpeningMpesa] = useState('0');
  const [countedCash, setCountedCash] = useState('');
  const [countedMpesa, setCountedMpesa] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const [closedShift, setClosedShift] = useState<Shift | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openingSubmitting, openSubmit] = useSubmitGuard();
  const [closingSubmitting, closeSubmit] = useSubmitGuard();

  const openQuery = useQuery({
    queryKey: ['shift', 'open'],
    queryFn: () => request<ShiftResponse>('/shifts/open'),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    queryKey: ['shifts', 'mine'],
    queryFn: () => request<Paginated<Shift>>(`/shifts/mine${buildQuery({ pageSize: 25 })}`),
  });
  const shift = openQuery.data?.shift || null;

  const openShift = useMutation({
    mutationFn: () => request<ShiftResponse>('/shifts/open', { method: 'POST', body: { openingCashKsh: Number(openingCash), openingMpesaKsh: Number(openingMpesa) } }),
    onSuccess: ({ shift: opened }) => {
      toast.success(`Shift #${opened?.id || ''} is open.`);
      void queryClient.invalidateQueries({ queryKey: ['shift'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const closeShift = useMutation({
    mutationFn: () => request<CloseResponse>(`/shifts/${shift?.id}/close`, { method: 'POST', body: { countedCashKsh: Number(countedCash), countedMpesaKsh: Number(countedMpesa), notes: closingNotes.trim() || undefined } }),
    onSuccess: ({ shift: result }) => {
      setCloseOpen(false);
      setClosedShift(result);
      setCountedCash(''); setCountedMpesa(''); setClosingNotes('');
      toast.success('Shift closed and reconciled.');
      void Promise.all([queryClient.invalidateQueries({ queryKey: ['shift'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]);
    },
  });

  if (openQuery.isLoading) return <PageLoader label="Loading your shift position…" />;
  if (openQuery.error) return <ErrorState message={openQuery.error instanceof Error ? openQuery.error.message : 'Your shift could not be loaded.'} onRetry={() => void openQuery.refetch()} />;

  const openShiftSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const error = firstError(nonNegativeNumber(openingCash, 'Opening cash'), nonNegativeNumber(openingMpesa, 'Opening M-Pesa'));
    if (error) { setFormError(error); return; }
    void openSubmit(async () => {
      try { await openShift.mutateAsync(); } catch (error) { const message = error instanceof Error ? error.message : 'The shift could not be opened.'; setFormError(message); toast.error(message); }
    });
  };

  const cashDifference = (Number(countedCash) || 0) - (shift?.expected.cashKsh || 0);
  const mpesaDifference = (Number(countedMpesa) || 0) - (shift?.expected.mpesaKsh || 0);
  const cashState = differenceState(cashDifference, Boolean(countedCash));
  const mpesaState = differenceState(mpesaDifference, Boolean(countedMpesa));
  const cashDisplay = cashState === 'pending' ? null : differenceCopy[cashState];
  const mpesaDisplay = mpesaState === 'pending' ? null : differenceCopy[mpesaState];
  const totalDifference = cashDifference + mpesaDifference;
  const totalState = differenceState(totalDifference, Boolean(countedCash && countedMpesa));
  const banner = totalState === 'pending' ? null : differenceCopy[totalState];

  const columns: Array<Column<Shift>> = [
    { key: 'id', header: 'Shift', render: (item) => <span><span className="font-bold">#{item.id}</span><span className="block text-xs text-slate-500">Opened {formatDateTime(item.openedAt, settings.timezone)}</span></span> },
    { key: 'status', header: 'Status', render: (item) => <Badge tone={item.status === 'open' ? 'green' : 'slate'}>{item.status}</Badge> },
    { key: 'sales', header: 'Sales', render: (item) => <span><span className="block font-bold">{formatKsh(item.summary.sales.totalKsh)}</span><span className="text-xs text-slate-500">{item.summary.saleCount} sales · {formatLitres(item.summary.litres)}</span></span> },
    { key: 'difference', header: 'Difference', render: (item) => item.discrepancy ? <span className={`font-black ${item.discrepancy.totalKsh < 0 ? 'text-red-600' : item.discrepancy.totalKsh > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{formatKsh(item.discrepancy.totalKsh)}</span> : <span className="text-slate-400">Not closed</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="My Shift" description="Live totals are calculated by the server from opening floats, sales, and expenses." />

      {!shift ? (
        <div className="grid items-start gap-6 xl:grid-cols-[0.8fr_1.2fr]">
          <SectionCard title="Open a new shift" description="Record the cash and M-Pesa float before your first transaction.">
            <form onSubmit={openShiftSubmit} noValidate className="space-y-4">
              <Field id="opening-cash" label="Opening cash float" required><KshInput id="opening-cash" value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} /></Field>
              <Field id="opening-mpesa" label="Opening M-Pesa float" required><KshInput id="opening-mpesa" value={openingMpesa} onChange={(event) => setOpeningMpesa(event.target.value)} /></Field>
              {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
              <Button type="submit" size="lg" className="w-full" loading={openingSubmitting} leftIcon={<Clock3 className="h-4 w-4" />}>Open shift</Button>
            </form>
          </SectionCard>
          <SectionCard title="Before you open" description="A complete, accurate opening position keeps close-out accountable.">
            <ul className="space-y-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-brand-600" />Count the physical cash and confirmed M-Pesa opening float.</li>
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-brand-600" />Enter values in KSh. The station API does not accept fractional-cent inputs.</li>
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-brand-600" />Once open, the server tracks all sales and expenses against this shift.</li>
            </ul>
          </SectionCard>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
            <div className="flex items-center gap-3"><span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white"><LockKeyhole className="h-5 w-5" /></span><div><p className="font-black text-emerald-950 dark:text-emerald-100">Shift #{shift.id} is open</p><p className="text-xs text-emerald-700 dark:text-emerald-300">Opened {formatDateTime(shift.openedAt, settings.timezone)} · refreshes every 15 seconds</p></div></div>
            <Button variant="secondary" size="sm" onClick={() => void openQuery.refetch()}>Refresh totals</Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Expected cash" value={formatKsh(shift.expected.cashKsh)} detail={`Opening ${formatKsh(shift.openingFloat.cashKsh)}`} icon={Banknote} tone="green" />
            <StatCard label="Expected M-Pesa" value={formatKsh(shift.expected.mpesaKsh)} detail={`Opening ${formatKsh(shift.openingFloat.mpesaKsh)}`} icon={Smartphone} tone="blue" />
            <StatCard label="Recorded sales" value={formatKsh(shift.summary.sales.totalKsh)} detail={`${formatNumber(shift.summary.saleCount)} sales`} icon={WalletCards} tone="violet" />
            <StatCard label="Shift expenses" value={formatKsh(shift.summary.expenses.totalKsh)} detail={`${formatNumber(shift.summary.expenseCount)} expenses`} icon={Scale} tone="amber" />
          </div>

          <div className="mt-6 grid items-start gap-6 xl:grid-cols-[1fr_0.8fr]">
            <SectionCard title="Count and close" description="Enter both physical counted values. The comparison uses live server totals at the moment you close.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="counted-cash" label="Counted cash" required hint={`Expected ${formatKsh(shift.expected.cashKsh)}`}><KshInput id="counted-cash" value={countedCash} onChange={(event) => setCountedCash(event.target.value)} /></Field>
                <Field id="counted-mpesa" label="Counted M-Pesa" required hint={`Expected ${formatKsh(shift.expected.mpesaKsh)}`}><KshInput id="counted-mpesa" value={countedMpesa} onChange={(event) => setCountedMpesa(event.target.value)} /></Field>
              </div>
              {countedCash || countedMpesa ? (
                <div className="mt-5 space-y-2">
                  {cashDisplay && <div className={`flex items-center justify-between rounded-xl border p-3 text-sm font-semibold ${cashDisplay.className}`}><span>Cash: {cashDisplay.label}</span><span>{formatKsh(cashDifference)}</span></div>}
                  {mpesaDisplay && <div className={`flex items-center justify-between rounded-xl border p-3 text-sm font-semibold ${mpesaDisplay.className}`}><span>M-Pesa: {mpesaDisplay.label}</span><span>{formatKsh(mpesaDifference)}</span></div>}
                </div>
              ) : <div className="mt-5"><InlineAlert>Enter the physical cash and M-Pesa counts to see the balance status.</InlineAlert></div>}
              {banner && <div className={`mt-4 rounded-2xl border-2 p-5 text-center ${banner.className}`}><p className="text-xs font-black uppercase tracking-[0.18em]">Overall shift: {banner.label}</p><p className="mt-1 text-3xl font-black tabular-nums">{formatKsh(totalDifference)}</p></div>}
              <Button className="mt-5 w-full" size="lg" variant="warning" disabled={!countedCash || !countedMpesa} onClick={() => setCloseOpen(true)} leftIcon={<LockKeyhole className="h-4 w-4" />}>Close and reconcile shift</Button>
            </SectionCard>

            <SectionCard title="Live shift activity" description="Values are read directly from the server.">
              <dl className="divide-y divide-slate-100 dark:divide-slate-800">
                {[
                  ['Opening float', formatKsh(shift.openingFloat.cashKsh + shift.openingFloat.mpesaKsh)],
                  ['Sale revenue', formatKsh(shift.summary.sales.totalKsh)],
                  ['Cash expenses', formatKsh(shift.summary.expenses.cashKsh)],
                  ['M-Pesa expenses', formatKsh(shift.summary.expenses.mpesaKsh)],
                  ['Litres sold', formatLitres(shift.summary.litres)],
                ].map(([label, value]) => <div key={label} className="flex items-center justify-between py-3 text-sm"><dt className="text-slate-500 dark:text-slate-400">{label}</dt><dd className="font-bold text-slate-900 dark:text-white">{value}</dd></div>)}
              </dl>
              <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">A sale or expense completed after the page loaded can change expected values before close. The close request performs a fresh server-side calculation.</p>
            </SectionCard>
          </div>
        </>
      )}

      <div className="mt-8">
        <SectionCard title="Shift history" description="Your most recent shift records." padded={false}>
          <DataTable columns={columns} data={history.data?.data || []} getRowKey={(item) => item.id} loading={history.isLoading} emptyTitle="No shift history" emptyMessage="Closed and currently open shifts will appear here." caption="Your shift history" renderMobile={(item) => <div className="p-4"><div className="flex items-center justify-between"><p className="font-bold">Shift #{item.id}</p><Badge tone={item.status === 'open' ? 'green' : 'slate'}>{item.status}</Badge></div><p className="mt-2 text-xs text-slate-500">{formatDateKey(item.openedAt.slice(0, 10), settings.dateFormat)} · {item.summary.saleCount} sales</p><div className="mt-3 flex justify-between text-sm"><span>{formatKsh(item.summary.sales.totalKsh)}</span><span className="font-bold">{item.discrepancy ? formatKsh(item.discrepancy.totalKsh) : 'Open'}</span></div></div>} />
        </SectionCard>
      </div>

      <ConfirmDialog
        open={closeOpen}
        title={`Close shift #${shift?.id || ''}?`}
        message="Closing is final. The server will freeze the current expected totals, save your physical counts, and calculate the final discrepancy. Sales and expenses will no longer be accepted against this shift."
        confirmLabel="Close shift"
        variant="warning"
        loading={closingSubmitting}
        onConfirm={() => {
          const error = firstError(nonNegativeNumber(countedCash, 'Counted cash'), nonNegativeNumber(countedMpesa, 'Counted M-Pesa'));
          if (error) { toast.error(error); return; }
          void closeSubmit(async () => { try { await closeShift.mutateAsync(); } catch (error) { toast.error(error instanceof Error ? error.message : 'The shift could not be closed.'); } });
        }}
        onClose={() => !closingSubmitting && setCloseOpen(false)}
      >
        <Field id="closing-notes" label="Closing notes" hint="Optional explanation for the final reconciliation"><Textarea id="closing-notes" value={closingNotes} onChange={(event) => setClosingNotes(event.target.value)} maxLength={1000} placeholder="Notes recorded with this shift close" /></Field>
      </ConfirmDialog>

      <Modal open={Boolean(closedShift)} onClose={() => setClosedShift(null)} title={`Shift #${closedShift?.id || ''} closed`} description="Final server-calculated summary" footer={<Button onClick={() => setClosedShift(null)}>Done</Button>}>
        {closedShift && <div className="space-y-5">
          <div className={`rounded-2xl border p-5 text-center ${closedShift.discrepancy && closedShift.discrepancy.totalKsh < 0 ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-950 dark:bg-red-950/50 dark:text-red-100' : closedShift.discrepancy && closedShift.discrepancy.totalKsh > 0 ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-950 dark:bg-amber-950/50 dark:text-amber-100' : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-950 dark:bg-emerald-950/50 dark:text-emerald-100'}`}>
            <p className="text-xs font-black uppercase tracking-widest">{closedShift.discrepancy && closedShift.discrepancy.totalKsh === 0 ? 'Balanced' : closedShift.discrepancy && closedShift.discrepancy.totalKsh < 0 ? 'Shortage' : 'Surplus'}</p><p className="mt-1 text-3xl font-black">{formatKsh(closedShift.discrepancy?.totalKsh || 0)}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {[['Sales', formatKsh(closedShift.summary.sales.totalKsh)], ['Expenses', formatKsh(closedShift.summary.expenses.totalKsh)], ['Litres', formatLitres(closedShift.summary.litres)], ['Transactions', formatNumber(closedShift.summary.saleCount + closedShift.summary.expenseCount)]].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 font-black">{value}</p></div>)}
          </div>
          <p className="text-sm text-slate-500">Closed {formatDateTime(closedShift.closedAt, settings.timezone)} at {formatTime(closedShift.closedAt, settings.timezone)}.</p>
        </div>}
      </Modal>
    </div>
  );
}
