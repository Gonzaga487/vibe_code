import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Edit3, Fuel as FuelIcon, PackageCheck, Plus, Scale, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, StatCard, Tabs, type Column } from '@/components/ui/DataDisplay';
import { Field, Input, KshInput, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { EmptyState, ErrorState, InlineAlert, StatCardSkeleton } from '@/components/ui/Feedback';
import { useSettings } from '@/context/SettingsContext';
import { buildQuery, request } from '@/lib/api';
import { addDays, formatDateTime, formatKsh, formatLitres, formatNumber, toDateKey } from '@/lib/format';
import { useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { stationApi } from '@/lib/stationApi';
import { firstError, nonNegativeNumber, nonZeroNumber, positiveNumber, requiredText } from '@/lib/validation';
import type { Paginated, Restock, RestockPayload, Settings, StockAdjustment } from '@/types/api';

interface RestockResponse { restock: Restock; lowStockAlerts: unknown[] }
interface AdjustmentResponse { adjustment: StockAdjustment; lowStockAlerts: unknown[] }
type Tab = 'deliveries' | 'adjustments';

interface DeliveryForm {
  fuelId: string;
  quantityLitres: string;
  unitCostKsh: string;
  supplier: string;
  reference: string;
  notes: string;
}
interface AdjustmentForm {
  fuelId: string;
  quantityLitres: string;
  reason: string;
  unitCostKsh: string;
  notes: string;
}

const emptyDelivery = (fuelId = ''): DeliveryForm => ({ fuelId, quantityLitres: '', unitCostKsh: '', supplier: '', reference: '', notes: '' });
const emptyAdjustment = (fuelId = ''): AdjustmentForm => ({ fuelId, quantityLitres: '', reason: '', unitCostKsh: '', notes: '' });

export default function RestockPage() {
  useDocumentTitle('Restock');
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('deliveries');
  const [from, setFrom] = useState(toDateKey(addDays(new Date(), -30)));
  const [to, setTo] = useState(toDateKey(new Date()));
  const [fuelFilter, setFuelFilter] = useState('');
  const [supplier, setSupplier] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [editing, setEditing] = useState<Restock | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Restock | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryForm>(emptyDelivery());
  const [adjustment, setAdjustment] = useState<AdjustmentForm>(emptyAdjustment());
  const [formError, setFormError] = useState<string | null>(null);
  const [deliverySubmitting, submitDelivery] = useSubmitGuard();
  const [adjustmentSubmitting, submitAdjustment] = useSubmitGuard();

  const fuels = useQuery({ queryKey: ['fuel'], queryFn: () => stationApi.fuels.list(), staleTime: 30_000 });
  const settingsQuery = useQuery({ queryKey: ['settings', 'admin'], queryFn: () => request<{ settings: Settings }>('/settings') });
  const restockFilters = { from: from || undefined, to: to || undefined, fuelId: fuelFilter || undefined, supplier: supplier.trim() || undefined, page, pageSize };
  const restocks = useQuery({
    queryKey: ['restocks', restockFilters],
    queryFn: () => request<Paginated<Restock>>(`/restock${buildQuery(restockFilters)}`),
    enabled: tab === 'deliveries',
    placeholderData: (previous) => previous,
  });
  const adjustments = useQuery({
    queryKey: ['stock-adjustments', { from, to, fuelId: fuelFilter || undefined, page, pageSize }],
    queryFn: () => request<Paginated<StockAdjustment>>(`/stock-adjustments${buildQuery({ from: from || undefined, to: to || undefined, fuelId: fuelFilter || undefined, page, pageSize })}`),
    enabled: tab === 'adjustments',
    placeholderData: (previous) => previous,
  });

  const fuelList = fuels.data || [];
  const activeFuels = fuelList.filter((fuel) => fuel.isActive);
  const fuelById = useMemo(() => new Map(fuelList.map((fuel) => [fuel.id, fuel])), [fuelList]);
  const threshold = settingsQuery.data?.settings.lowStockThresholdLitres;
  const lowStock = fuelList.filter((fuel) => fuel.isActive && threshold !== undefined && typeof fuel.quantityLitres === 'number' && fuel.quantityLitres <= threshold);
  const deliveryTotal = Number(delivery.quantityLitres) * Number(delivery.unitCostKsh);

  const invalidateInventory = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['fuel'] }),
    queryClient.invalidateQueries({ queryKey: ['restocks'] }),
    queryClient.invalidateQueries({ queryKey: ['stock-adjustments'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['settings', 'admin'] }),
  ]);

  const saveDelivery = useMutation({
    mutationFn: (payload: RestockPayload) => request<RestockResponse>(editing ? `/restock/${editing.id}` : '/restock', { method: editing ? 'PATCH' : 'POST', body: payload }),
    onSuccess: () => { setDeliveryOpen(false); toast.success(editing ? 'Restock updated.' : 'Fuel delivery recorded.'); void invalidateInventory(); },
  });
  const saveAdjustment = useMutation({
    mutationFn: (payload: { fuelId: number; quantityLitres: number; reason: string; notes?: string; unitCostKsh?: number }) => request<AdjustmentResponse>('/stock-adjustments', { method: 'POST', body: payload }),
    onSuccess: () => { setAdjustmentOpen(false); toast.success('Stock adjustment recorded.'); void invalidateInventory(); },
  });

  const openDelivery = () => { setEditing(null); setDelivery(emptyDelivery(activeFuels[0] ? String(activeFuels[0].id) : '')); setFormError(null); setDeliveryOpen(true); };
  const editDelivery = (record: Restock) => { setEditing(record); setDelivery({ fuelId: String(record.fuel.id), quantityLitres: String(record.quantityLitres), unitCostKsh: String(record.unitCostKsh), supplier: record.supplier, reference: record.reference || '', notes: record.notes || '' }); setFormError(null); setDeliveryOpen(true); };
  const openAdjustment = () => { setAdjustment(emptyAdjustment(activeFuels[0] ? String(activeFuels[0].id) : '')); setFormError(null); setAdjustmentOpen(true); };

  const submitDeliveryForm = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(delivery.fuelId ? null : 'Choose a fuel type.', positiveNumber(delivery.quantityLitres, 'Quantity'), nonNegativeNumber(delivery.unitCostKsh, 'Unit cost'), requiredText(delivery.supplier, 'Supplier', 120));
    if (validation) { setFormError(validation); return; }
    const payload: RestockPayload = { fuelId: Number(delivery.fuelId), quantityLitres: Number(delivery.quantityLitres), unitCostKsh: Number(delivery.unitCostKsh), supplier: delivery.supplier.trim(), ...(delivery.reference.trim() ? { reference: delivery.reference.trim() } : {}), ...(delivery.notes.trim() ? { notes: delivery.notes.trim() } : {}) };
    void submitDelivery(async () => { saveDelivery.reset(); try { await saveDelivery.mutateAsync(payload); } catch (error) { setFormError(error instanceof Error ? error.message : 'The restock could not be saved.'); } });
  };
  const submitAdjustmentForm = (event: FormEvent) => {
    event.preventDefault();
    const chosen = fuelById.get(Number(adjustment.fuelId));
    const validation = firstError(adjustment.fuelId ? null : 'Choose a fuel type.', nonZeroNumber(adjustment.quantityLitres, 'Adjustment quantity'), requiredText(adjustment.reason, 'Reason', 500), adjustment.unitCostKsh && Number(adjustment.unitCostKsh) < 0 ? 'Unit cost cannot be negative.' : null, Number(adjustment.quantityLitres) > 0 && chosen?.weightedAverageCostKsh === 0 && !adjustment.unitCostKsh ? 'A cost per litre is required for a positive adjustment when no cost basis exists.' : null);
    if (validation) { setFormError(validation); return; }
    void submitAdjustment(async () => {
      saveAdjustment.reset();
      try { await saveAdjustment.mutateAsync({ fuelId: Number(adjustment.fuelId), quantityLitres: Number(adjustment.quantityLitres), reason: adjustment.reason.trim(), ...(adjustment.notes.trim() ? { notes: adjustment.notes.trim() } : {}), ...(adjustment.unitCostKsh ? { unitCostKsh: Number(adjustment.unitCostKsh) } : {}) }); } catch (error) { setFormError(error instanceof Error ? error.message : 'The stock adjustment could not be saved.'); }
    });
  };
  const remove = async () => {
    if (!deleteTarget) return; setDeleteLoading(true);
    try { await request(`/restock/${deleteTarget.id}`, { method: 'DELETE' }); toast.success('Restock deleted and remaining inventory reversed.'); setDeleteTarget(null); await invalidateInventory(); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The restock could not be deleted.'); } finally { setDeleteLoading(false); }
  };

  if (fuels.isLoading) return <div className="animate-fade-in"><PageHeader title="Restock" description="Manage fuel deliveries, stock adjustments, and live inventory." /><div className="grid gap-4 sm:grid-cols-3"><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /></div></div>;
  if (fuels.error) return <ErrorState message={fuels.error instanceof Error ? fuels.error.message : 'Fuel inventory could not be loaded.'} onRetry={() => void fuels.refetch()} />;

  const restockColumns: Array<Column<Restock>> = [
    { key: 'id', header: 'Delivery', render: (item) => <span><span className="font-bold">#{item.id}</span><span className="block text-xs text-slate-500">{formatDateTime(item.createdAt, settings.timezone)}</span></span> },
    { key: 'fuel', header: 'Fuel', render: (item) => fuelById.get(item.fuel.id)?.fuelType || `Fuel #${item.fuel.id}` },
    { key: 'quantity', header: 'Quantity / cost', render: (item) => <span><span className="block font-bold">{formatLitres(item.quantityLitres)}</span><span className="text-xs text-slate-500">{formatKsh(item.unitCostKsh)}/L</span></span> },
    { key: 'total', header: 'Total', render: (item) => <span className="font-black">{formatKsh(item.totalCostKsh)}</span> },
    { key: 'supplier', header: 'Supplier / stock', render: (item) => <span><span className="block">{item.supplier}</span><span className="text-xs text-slate-500">{formatLitres(item.stockBeforeLitres)} → {formatLitres(item.stockAfterLitres)}</span></span> },
    { key: 'actions', header: 'Actions', render: (item) => <div className="flex justify-end"><Button variant="ghost" size="sm" className="px-2" onClick={() => editDelivery(item)} aria-label={`Edit restock ${item.id}`}><Edit3 className="h-4 w-4" /></Button><Button variant="ghost" size="sm" className="px-2 text-red-600" onClick={() => setDeleteTarget(item)} aria-label={`Delete restock ${item.id}`}><Trash2 className="h-4 w-4" /></Button></div> },
  ];
  const adjustmentColumns: Array<Column<StockAdjustment>> = [
    { key: 'id', header: 'Adjustment', render: (item) => <span><span className="font-bold">#{item.id}</span><span className="block text-xs text-slate-500">{formatDateTime(item.createdAt, settings.timezone)}</span></span> },
    { key: 'fuel', header: 'Fuel', render: (item) => fuelById.get(item.fuelId)?.fuelType || `Fuel #${item.fuelId}` },
    { key: 'quantity', header: 'Change', render: (item) => <Badge tone={item.quantityLitres > 0 ? 'green' : 'red'}>{item.quantityLitres > 0 ? '+' : ''}{formatLitres(item.quantityLitres)}</Badge> },
    { key: 'stock', header: 'Stock movement', render: (item) => `${formatLitres(item.previousQuantityLitres)} → ${formatLitres(item.newQuantityLitres)}` },
    { key: 'reason', header: 'Reason', render: (item) => <span>{item.reason}{item.notes && <span className="mt-1 block text-xs text-slate-500">{item.notes}</span>}</span> },
  ];
  const activityTabs = [
    { value: 'deliveries' as const, label: 'Restock deliveries', count: tab === 'deliveries' ? restocks.data?.pagination.total : undefined },
    { value: 'adjustments' as const, label: 'Stock adjustments', count: tab === 'adjustments' ? adjustments.data?.pagination.total : undefined },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Restock" description="Admin-only inventory receiving, stock adjustments, and movement history." actions={<><Button variant="secondary" onClick={openAdjustment} disabled={!activeFuels.length} leftIcon={<Scale className="h-4 w-4" />}>Adjust stock</Button><Button onClick={openDelivery} disabled={!activeFuels.length} leftIcon={<Plus className="h-4 w-4" />}>Record delivery</Button></>} />

      {!fuelList.length ? <SectionCard><EmptyState title="Configure fuel before receiving stock" message="No fuel definitions exist. Start with Diesel or Petrol, set a selling price, and optionally configure tank capacity." icon={FuelIcon} action={<Link to="/fuel"><Button>Configure fuel</Button></Link>} /></SectionCard> : <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {fuelList.slice(0, 2).map((fuel) => <StatCard key={fuel.id} label={`${fuel.fuelType.toLowerCase()} stock`} value={formatLitres(fuel.quantityLitres)} detail={`${formatKsh(fuel.sellingPriceKsh)}/L · inventory ${formatKsh(fuel.inventoryValueKsh)}`} icon={FuelIcon} tone={lowStock.some((item) => item.id === fuel.id) ? 'amber' : fuel.isActive ? 'green' : 'slate'} />)}
          <StatCard label="Low-stock fuels" value={formatNumber(lowStock.length)} detail={threshold === undefined ? 'Loading configured threshold' : `At or below ${formatLitres(threshold)}`} icon={AlertTriangle} tone={lowStock.length ? 'amber' : 'green'} />
        </div>

        {lowStock.length > 0 && <div className="mt-5"><InlineAlert tone="warning" title="Low stock requires attention" icon={AlertTriangle}>{lowStock.map((fuel) => `${fuel.fuelType}: ${formatLitres(fuel.quantityLitres)}`).join(' · ')}</InlineAlert></div>}

        <div className="mt-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <Tabs label="Inventory activity" value={tab} onChange={(value) => { setTab(value); setPage(1); }} tabs={activityTabs} />
          <Button variant="secondary" size="sm" onClick={() => { setPage(1); void (tab === 'deliveries' ? restocks.refetch() : adjustments.refetch()); }}>Refresh</Button>
        </div>

        <div className="mt-4 grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-panel sm:grid-cols-2 lg:grid-cols-5 dark:border-slate-800 dark:bg-slate-900">
          <Field id="restock-from" label="From"><Input id="restock-from" type="date" value={from} max={to} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
          <Field id="restock-to" label="To"><Input id="restock-to" type="date" value={to} min={from} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
          <Field id="restock-fuel-filter" label="Fuel"><Select id="restock-fuel-filter" value={fuelFilter} placeholder="All fuels" options={fuelList.map((fuel) => ({ value: String(fuel.id), label: fuel.fuelType }))} onChange={(event) => { setFuelFilter(event.target.value); setPage(1); }} /></Field>
          {tab === 'deliveries' && <Field id="restock-supplier" label="Supplier"><Input id="restock-supplier" value={supplier} onChange={(event) => { setSupplier(event.target.value); setPage(1); }} maxLength={120} placeholder="Search supplier" /></Field>}
          <div className="flex items-end"><Button variant="secondary" className="w-full" leftIcon={<PackageCheck className="h-4 w-4" />} onClick={() => { setPage(1); void (tab === 'deliveries' ? restocks.refetch() : adjustments.refetch()); }}>Apply</Button></div>
        </div>

        <SectionCard className="mt-5" title={tab === 'deliveries' ? 'Restock deliveries' : 'Stock adjustment history'} description="Inventory totals shown in each record come from the server." padded={false}>
          {tab === 'deliveries' ? <DataTable columns={restockColumns} data={restocks.data?.data || []} getRowKey={(item) => item.id} loading={restocks.isLoading} emptyTitle="No restock deliveries" emptyMessage="No deliveries match these filters." caption="Restock delivery history" renderMobile={(item) => <div className="p-4"><div className="flex justify-between gap-3"><div><p className="font-bold">{fuelById.get(item.fuel.id)?.fuelType} · {item.supplier}</p><p className="mt-1 text-xs text-slate-500">{formatDateTime(item.createdAt, settings.timezone)}</p></div><p className="font-black">{formatKsh(item.totalCostKsh)}</p></div><p className="mt-2 text-sm">{formatLitres(item.quantityLitres)} at {formatKsh(item.unitCostKsh)}/L</p><div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={() => editDelivery(item)}>Edit</Button><Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeleteTarget(item)}>Delete</Button></div></div>} /> : <DataTable columns={adjustmentColumns} data={adjustments.data?.data || []} getRowKey={(item) => item.id} loading={adjustments.isLoading} emptyTitle="No stock adjustments" emptyMessage="No manual stock adjustments match these filters." caption="Stock adjustment history" />}
          {(tab === 'deliveries' ? restocks.data : adjustments.data) && <Pagination pagination={(tab === 'deliveries' ? restocks.data : adjustments.data)!.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
        </SectionCard>
      </>}

      <Modal open={deliveryOpen} onClose={() => !deliverySubmitting && setDeliveryOpen(false)} title={editing ? 'Edit restock delivery' : 'Record fuel delivery'} description="Restock creates a FIFO cost lot and updates current stock transactionally." footer={<><Button variant="secondary" onClick={() => setDeliveryOpen(false)} disabled={deliverySubmitting}>Cancel</Button><Button onClick={() => document.getElementById('delivery-submit')?.click()} loading={deliverySubmitting}>{editing ? 'Save changes' : 'Record delivery'}</Button></>}>
        <form id="delivery-form" onSubmit={submitDeliveryForm} noValidate className="space-y-4"><button id="delivery-submit" type="submit" className="hidden" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="delivery-fuel" label="Fuel type" required><Select id="delivery-fuel" value={delivery.fuelId} options={activeFuels.map((fuel) => ({ value: String(fuel.id), label: `${fuel.fuelType} · ${formatLitres(fuel.quantityLitres)} in stock` }))} onChange={(event) => setDelivery((value) => ({ ...value, fuelId: event.target.value }))} /></Field>
            <Field id="delivery-quantity" label="Quantity received" required><Input id="delivery-quantity" type="number" min="0.001" max="1000000" step="0.001" value={delivery.quantityLitres} onChange={(event) => setDelivery((value) => ({ ...value, quantityLitres: event.target.value }))} /></Field>
            <Field id="delivery-cost" label="Cost per litre" required><KshInput id="delivery-cost" value={delivery.unitCostKsh} onChange={(event) => setDelivery((value) => ({ ...value, unitCostKsh: event.target.value }))} /></Field>
            <Field id="delivery-total" label="Calculated total"><div className="flex min-h-[42px] items-center rounded-xl bg-slate-100 px-3.5 font-black text-slate-800 dark:bg-slate-800 dark:text-white">{Number.isFinite(deliveryTotal) && deliveryTotal > 0 ? formatKsh(deliveryTotal) : 'KSh 0.00'}</div></Field>
            <Field id="delivery-supplier" label="Supplier" required className="sm:col-span-2"><Input id="delivery-supplier" value={delivery.supplier} onChange={(event) => setDelivery((value) => ({ ...value, supplier: event.target.value }))} maxLength={120} /></Field>
            <Field id="delivery-reference" label="Delivery reference"><Input id="delivery-reference" value={delivery.reference} onChange={(event) => setDelivery((value) => ({ ...value, reference: event.target.value }))} maxLength={100} /></Field>
            <Field id="delivery-notes" label="Notes"><Input id="delivery-notes" value={delivery.notes} onChange={(event) => setDelivery((value) => ({ ...value, notes: event.target.value }))} maxLength={1000} /></Field>
          </div>
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <Modal open={adjustmentOpen} onClose={() => !adjustmentSubmitting && setAdjustmentOpen(false)} title="Adjust stock" description="Use a signed litre value and a clear reason. Adjustments are permanent and audited." footer={<><Button variant="secondary" onClick={() => setAdjustmentOpen(false)} disabled={adjustmentSubmitting}>Cancel</Button><Button onClick={() => document.getElementById('adjustment-submit')?.click()} loading={adjustmentSubmitting}>Record adjustment</Button></>}>
        <form id="adjustment-form" onSubmit={submitAdjustmentForm} noValidate className="space-y-4"><button id="adjustment-submit" type="submit" className="hidden" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="adjustment-fuel" label="Fuel type" required><Select id="adjustment-fuel" value={adjustment.fuelId} options={activeFuels.map((fuel) => ({ value: String(fuel.id), label: `${fuel.fuelType} · ${formatLitres(fuel.quantityLitres)}` }))} onChange={(event) => setAdjustment((value) => ({ ...value, fuelId: event.target.value }))} /></Field>
            <Field id="adjustment-quantity" label="Signed quantity" required hint="Negative removes stock; positive adds stock"><Input id="adjustment-quantity" type="number" step="0.001" value={adjustment.quantityLitres} onChange={(event) => setAdjustment((value) => ({ ...value, quantityLitres: event.target.value }))} placeholder="e.g. -5.250" /></Field>
            <Field id="adjustment-cost" label="Cost per litre" hint="Required for positive additions without a cost basis"><KshInput id="adjustment-cost" value={adjustment.unitCostKsh} onChange={(event) => setAdjustment((value) => ({ ...value, unitCostKsh: event.target.value }))} /></Field>
            <Field id="adjustment-reason" label="Reason" required className="sm:col-span-2"><Input id="adjustment-reason" value={adjustment.reason} onChange={(event) => setAdjustment((value) => ({ ...value, reason: event.target.value }))} maxLength={500} placeholder="e.g. Meter calibration variance" /></Field>
            <Field id="adjustment-notes" label="Notes" className="sm:col-span-2"><Textarea id="adjustment-notes" value={adjustment.notes} onChange={(event) => setAdjustment((value) => ({ ...value, notes: event.target.value }))} maxLength={1000} /></Field>
          </div>{formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title={`Delete restock #${deleteTarget?.id || ''}?`} message="The server will reverse only the unconsumed litres from this delivery. If the remaining stock is no longer available, deletion is rejected. This action is audited." confirmLabel="Delete restock" loading={deleteLoading} onConfirm={() => void remove()} onClose={() => !deleteLoading && setDeleteTarget(null)} />
    </div>
  );
}
