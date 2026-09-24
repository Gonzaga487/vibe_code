import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CheckCircle2, ChevronDown, ChevronUp, Fuel, Info, LockKeyhole, Plus, Smartphone, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, StatCard, type Column } from '@/components/ui/DataDisplay';
import { Field, Input, KshInput, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState, ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { buildQuery, request } from '@/lib/api';
import { fuelLabel, formatDateTime, formatKsh, formatLitres, formatNumber, formatTime } from '@/lib/format';
import { useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { API_CONTRACT_VERSION, stationApi, type SaleDraft } from '@/lib/stationApi';
import { firstError, nonNegativeNumber, positiveNumber } from '@/lib/validation';
import type { Sale, Shift } from '@/types/api';

interface ShiftResponse { shift: Shift | null }

function paymentLabel(cashAmount: number, mpesaAmount: number): string {
  if (cashAmount > 0 && mpesaAmount > 0) return 'Mixed';
  if (cashAmount > 0) return 'Cash';
  if (mpesaAmount > 0) return 'M-Pesa';
  return 'No payment entered';
}

export default function SalesPage() {
  useDocumentTitle('Record Sale');
  const { isAdmin } = useAuth();
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const [cashAmount, setCashAmount] = useState('');
  const [mpesaAmount, setMpesaAmount] = useState('');
  const [fuelId, setFuelId] = useState('');
  const [detailed, setDetailed] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [pumpId, setPumpId] = useState('');
  const [notes, setNotes] = useState('');
  const [unitPriceOverride, setUnitPriceOverride] = useState('');
  const [soldAt, setSoldAt] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Sale | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [submitting, submit] = useSubmitGuard();

  const openShift = useQuery({ queryKey: ['shift', 'open'], queryFn: () => request<ShiftResponse>('/shifts/open'), staleTime: 10_000 });
  const fuels = useQuery({ queryKey: ['fuel'], queryFn: () => stationApi.fuels.list(), staleTime: 60_000 });
  const pumps = useQuery({ queryKey: ['pumps'], queryFn: () => stationApi.pumps.list(), staleTime: 60_000 });
  const shift = openShift.data?.shift || null;
  const activeFuels = useMemo(() => (fuels.data || []).filter((fuel) => fuel.isActive), [fuels.data]);
  const activePumps = useMemo(() => (pumps.data || []).filter((pump) => pump.isActive), [pumps.data]);
  const chosenFuelId = Number(fuelId || activeFuels[0]?.id || 0);
  const chosenFuel = activeFuels.find((fuel) => fuel.id === chosenFuelId) || null;
  const availablePumps = activePumps.filter((pump) => pump.fuelId === chosenFuelId);
  const chosenPumpId = Number(pumpId || availablePumps[0]?.id || 0);
  const chosenPump = availablePumps.find((pump) => pump.id === chosenPumpId) || null;
  const cashNumber = Number(cashAmount || 0);
  const mpesaNumber = Number(mpesaAmount || 0);
  const enteredTotalKsh = Math.round((cashNumber + mpesaNumber) * 100) / 100;
  const effectiveUnitPrice = isAdmin && Number(unitPriceOverride) > 0 ? Number(unitPriceOverride) : chosenFuel?.sellingPriceKsh || 0;
  const estimatedLitres = API_CONTRACT_VERSION === 'v1' && effectiveUnitPrice > 0 && enteredTotalKsh > 0
    ? Math.round((enteredTotalKsh / effectiveUnitPrice) * 1000) / 1000
    : null;
  const currentSaleQuery = { shiftId: shift?.id, page, pageSize };
  const sales = useQuery({
    queryKey: ['sales', 'current-shift', currentSaleQuery],
    queryFn: () => stationApi.sales.list(buildQuery(currentSaleQuery)),
    enabled: Boolean(shift?.id),
    placeholderData: (previous) => previous,
  });

  const createSale = useMutation({
    mutationFn: (draft: SaleDraft) => stationApi.sales.create(draft),
    onSuccess: (sale) => {
      setLastSale(sale);
      setCashAmount(''); setMpesaAmount(''); setCustomerName(''); setPumpId(''); setNotes(''); setUnitPriceOverride(''); setSoldAt('');
      setPage(1);
      toast.success(`Sale #${sale.id} recorded: ${formatKsh(sale.totalKsh)}.`);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sales'] }),
        queryClient.invalidateQueries({ queryKey: ['shift', 'open'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : 'The sale could not be recorded.'),
  });

  const deleteSale = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await stationApi.sales.remove(deleteTarget.id);
      toast.success(`Sale #${deleteTarget.id} deleted.`);
      setDeleteTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sales'] }),
        queryClient.invalidateQueries({ queryKey: ['shift', 'open'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The sale could not be deleted.');
    } finally { setDeleteLoading(false); }
  };

  if (openShift.isLoading || fuels.isLoading || pumps.isLoading) return <PageLoader label="Preparing the secure sale counter…" />;
  if (openShift.error) return <ErrorState message={openShift.error instanceof Error ? openShift.error.message : 'Your shift could not be loaded.'} onRetry={() => void openShift.refetch()} />;
  if (fuels.error) return <ErrorState message={fuels.error instanceof Error ? fuels.error.message : 'Fuel configuration could not be loaded.'} onRetry={() => void fuels.refetch()} />;
  if (pumps.error) return <ErrorState message={pumps.error instanceof Error ? pumps.error.message : 'Pump configuration could not be loaded.'} onRetry={() => void pumps.refetch()} />;

  if (!activeFuels.length && detailed) {
    return <div><PageHeader title="Record Sale" description="Amount-based quick capture for the current shift." /><SectionCard><EmptyState title="Detailed sales need fuel configuration" message="Quick Cash and M-Pesa tallies remain available. Configure Petrol or Diesel and at least one pump to use detailed entries." icon={Fuel} action={isAdmin ? <Link to="/fuel"><Button leftIcon={<Plus className="h-4 w-4" />}>Configure fuel</Button></Link> : undefined} /></SectionCard></div>;
  }
  if (!shift) {
    return <div><PageHeader title="Record Sale" description="Amount-based quick capture for the current shift." /><SectionCard><EmptyState title="Open your shift first" message="The server requires your own open shift before any sale can be recorded." icon={LockKeyhole} action={<Link to="/shift"><Button>Open my shift</Button></Link>} /></SectionCard></div>;
  }

  const validate = (): string | null => firstError(
    API_CONTRACT_VERSION === 'v2' && !detailed ? null : chosenFuel ? null : 'Choose Petrol or Diesel.',
    detailed && !chosenPump ? 'Choose a configured pump.' : null,
    cashAmount ? nonNegativeNumber(cashAmount, 'Cash amount') : null,
    mpesaAmount ? nonNegativeNumber(mpesaAmount, 'M-Pesa amount') : null,
    enteredTotalKsh > 0 ? null : 'Enter a Cash or M-Pesa amount greater than zero.',
    isAdmin && unitPriceOverride ? positiveNumber(unitPriceOverride, 'Price override') : null,
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const error = validate();
    if (error) { setFormError(error); return; }
    const draft: SaleDraft = {
      mode: detailed ? 'detailed' : 'quick',
      ...(API_CONTRACT_VERSION === 'v1' || detailed ? { fuelId: chosenFuelId, unitPriceKsh: effectiveUnitPrice } : {}),
      cashAmountKsh: cashNumber,
      mpesaAmountKsh: mpesaNumber,
      ...(detailed ? { pumpId: chosenPumpId, ...(customerName.trim() ? { customerName: customerName.trim() } : {}), notes: notes.trim() || undefined, soldAt: soldAt ? new Date(soldAt).toISOString() : undefined } : {}),
      ...(isAdmin && Number(unitPriceOverride) > 0 ? { unitPriceOverrideKsh: Number(unitPriceOverride) } : {}),
    };
    void submit(async () => {
      createSale.reset();
      try { await createSale.mutateAsync(draft); }
      catch (error) { toast.error(error instanceof Error ? error.message : 'The sale could not be recorded.'); }
    });
  };

  const columns: Array<Column<Sale>> = [
    { key: 'id', header: 'Sale', render: (sale) => <span className="font-bold">#{sale.id}<span className="ml-2 text-xs font-normal text-slate-400">{formatTime(sale.soldAt, settings.timezone)}</span></span> },
    { key: 'fuel', header: 'Mode / fuel', render: (sale) => <span><span className="block font-semibold">{sale.mode === 'quick' ? 'Quick tally' : fuelLabel(sale.fuel?.type || 'Unassigned')}</span><span className="text-xs text-slate-500">{sale.litres === null ? 'Amount-only entry' : formatLitres(sale.litres)}</span></span> },
    { key: 'payment', header: 'Payment', render: (sale) => <Badge tone={sale.payment.method === 'mpesa' ? 'blue' : sale.payment.method === 'mixed' ? 'violet' : 'green'}>{sale.payment.method}</Badge> },
    { key: 'customer', header: 'Customer', render: (sale) => sale.customerName || <span className="text-slate-400">Not supplied</span> },
    { key: 'total', header: 'Amount', render: (sale) => <span className="font-black tabular-nums text-slate-950 dark:text-white">{formatKsh(sale.totalKsh)}</span> },
    ...(isAdmin ? [{ key: 'actions', header: 'Action', render: (sale: Sale) => <Button variant="ghost" size="sm" className="px-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" onClick={() => setDeleteTarget(sale)} aria-label={`Delete sale ${sale.id}`}><Trash2 className="h-4 w-4" /></Button> }] : []),
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Quick Tally" description={`Record Sale · shift #${shift.id} · opened ${formatTime(shift.openedAt, settings.timezone)}`} actions={<Button variant="secondary" onClick={() => setDetailed((value) => !value)} leftIcon={detailed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}>{detailed ? 'Quick details on' : 'Add sale details'}</Button>} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Session cash" value={formatKsh(shift.summary.sales.cashKsh)} detail="Server-calculated sales total" icon={Banknote} tone="green" />
        <StatCard label="Session M-Pesa" value={formatKsh(shift.summary.sales.mpesaKsh)} detail="Server-calculated sales total" icon={Smartphone} tone="blue" />
        <StatCard label="Session sales" value={formatNumber(shift.summary.saleCount)} detail={`${formatLitres(shift.summary.litres)} sold`} icon={CheckCircle2} tone="violet" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <SectionCard title="Cash and M-Pesa tally" description="Enter amounts directly in each block. A sale may use one block or both.">
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900 dark:bg-emerald-950/30 sm:p-5">
                <div className="flex items-center justify-between"><span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-white"><Banknote className="h-5 w-5" /></span><Badge tone="green">Cash</Badge></div>
                <Field id="quick-cash" label="Cash received" className="mt-5"><KshInput id="quick-cash" value={cashAmount} onChange={(event) => setCashAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></Field>
              </div>
              <div className="rounded-2xl border-2 border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900 dark:bg-blue-950/30 sm:p-5">
                <div className="flex items-center justify-between"><span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white"><Smartphone className="h-5 w-5" /></span><Badge tone="blue">M-Pesa</Badge></div>
                <Field id="quick-mpesa" label="M-Pesa received" className="mt-5"><KshInput id="quick-mpesa" value={mpesaAmount} onChange={(event) => setMpesaAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></Field>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {detailed ? <Field id="sale-fuel" label="Fuel type" required hint={chosenFuel?.sellingPriceKsh === null || chosenFuel?.sellingPriceKsh === undefined ? 'Price protected by role' : chosenFuel ? `${formatKsh(chosenFuel.sellingPriceKsh)} per litre` : undefined}><Select id="sale-fuel" value={String(chosenFuelId)} onChange={(event) => { setFuelId(event.target.value); setPumpId(''); }} options={activeFuels.map((fuel) => ({ value: String(fuel.id), label: fuelLabel(fuel.fuelType) }))} /></Field> : <div className="rounded-xl bg-orange-50 p-4 text-sm text-orange-900 dark:bg-orange-950/30 dark:text-orange-100"><strong>Quick mode:</strong> the entered KSh amount is stored exactly; no litres are estimated.</div>}
              <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Entered payment</p>
                <p className="mt-2 text-2xl font-black text-brand-800 dark:text-brand-300">{formatKsh(enteredTotalKsh)}</p>
                <p className="mt-1 text-xs text-slate-500">{paymentLabel(cashNumber, mpesaNumber)}</p>
              </div>
            </div>

            {detailed && <div className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-800">
              <InlineAlert title="Detailed sale">Fuel and pump are required. The payment amount is still preserved exactly as entered.</InlineAlert>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="sale-customer" label="Customer name" hint="Optional"><Input id="sale-customer" value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={120} /></Field>
                <Field id="sale-pump" label="Pump" required hint={availablePumps.length ? undefined : 'No active pump is configured for this fuel'}><Select id="sale-pump" value={String(chosenPumpId)} disabled={!availablePumps.length} placeholder="Choose pump" options={availablePumps.map((pump) => ({ value: String(pump.id), label: pump.pumpCode }))} onChange={(event) => setPumpId(event.target.value)} /></Field>
                {isAdmin && <Field id="sale-unit-price" label="Override price per litre" hint="Administrator only"><KshInput id="sale-unit-price" value={unitPriceOverride} onChange={(event) => setUnitPriceOverride(event.target.value)} placeholder={String(chosenFuel?.sellingPriceKsh || '')} /></Field>}
                <Field id="sale-time" label="Sale date and time" hint="Optional; cannot predate the shift"><Input id="sale-time" type="datetime-local" value={soldAt} onChange={(event) => setSoldAt(event.target.value)} max={new Date().toISOString().slice(0, 16)} /></Field>
              </div>
              <Field id="sale-notes" label="Additional notes"><Textarea id="sale-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={900} /></Field>
            </div>}

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
              <div className="flex items-center justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Amount to submit</span><span className="text-xl font-black">{formatKsh(enteredTotalKsh)}</span></div>
              {API_CONTRACT_VERSION === 'v1' && <p className="mt-1 text-xs text-slate-500">{estimatedLitres ? `Calculated volume: ${formatLitres(estimatedLitres)}` : 'Volume is calculated from the configured selling price when an amount is entered.'}</p>}
              {API_CONTRACT_VERSION === 'v2' && <p className="mt-1 text-xs text-slate-500">This build sends the entered value directly as amountKsh.</p>}
            </div>
            {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
            <Button type="submit" size="lg" className="w-full" loading={submitting} leftIcon={<Plus className="h-5 w-5" />}>Record {formatKsh(enteredTotalKsh)} sale</Button>
          </form>
        </SectionCard>

        <div className="space-y-6">
          {lastSale && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /><div><p className="font-bold text-emerald-900 dark:text-emerald-100">Sale #{lastSale.id} confirmed</p><p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">{formatKsh(lastSale.totalKsh)} · {lastSale.mode === 'quick' ? 'Quick tally' : fuelLabel(lastSale.fuel?.type || 'Unassigned')} · {lastSale.payment.method}</p></div></div></div>}
          <SectionCard title="Current-shift submissions" description={`Actual records returned for shift #${shift.id}.`} padded={false}>
            <DataTable columns={columns} data={sales.data?.data || []} getRowKey={(sale) => sale.id} loading={sales.isLoading} emptyTitle="No sales in this shift" emptyMessage="The first successful submission will appear here." caption="Sales in the current shift" renderMobile={(sale) => <div className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">#{sale.id} · {sale.mode === 'quick' ? 'Quick tally' : fuelLabel(sale.fuel?.type || 'Unassigned')}</p><p className="mt-1 text-xs text-slate-500">{formatDateTime(sale.soldAt, settings.timezone)}</p></div><p className="font-black">{formatKsh(sale.totalKsh)}</p></div>{isAdmin && <Button variant="ghost" size="sm" className="mt-2 px-2 text-red-600" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleteTarget(sale)}>Delete</Button>}</div>} />
            {sales.data && <Pagination pagination={sales.data.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
          </SectionCard>
          <div className="flex gap-2 text-xs leading-5 text-slate-500 dark:text-slate-400"><Info className="mt-0.5 h-4 w-4 shrink-0" /><p>The server confirms ownership, amount, fuel, and shift. No client total is substituted for the returned sale record.</p></div>
        </div>
      </div>

      <ConfirmDialog open={Boolean(deleteTarget)} title={`Delete sale #${deleteTarget?.id || ''}?`} message="This permanently removes the sale and recalculates any closed shift discrepancy. This action is audited and cannot be undone." confirmLabel="Delete sale" loading={deleteLoading} onConfirm={() => void deleteSale()} onClose={() => !deleteLoading && setDeleteTarget(null)} />
    </div>
  );
}
