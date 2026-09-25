import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Edit3, Fuel as FuelIcon, Gauge, PackagePlus, Plus, Save, Scale } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Badge, PageHeader, SectionCard } from '@/components/ui/DataDisplay';
import { Field, Input, KshInput, Select, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { EmptyState, ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { request } from '@/lib/api';
import { formatKsh, formatLitres } from '@/lib/format';
import { focusField, handleEnterToNext, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { stationApi } from '@/lib/stationApi';
import { firstError, nonNegativeNumber, positiveNumber, requiredText } from '@/lib/validation';
import type { Fuel as StationFuel, FuelType, Pump, Settings } from '@/types/api';

interface FuelResponse { data: StationFuel[]; lowStockAlerts?: Array<{ fuelId: number }> }
interface FuelForm { fuelType: FuelType; sellingPriceKsh: string; tankCapacityLitres: string; isActive: boolean }
interface AdjustmentForm { fuelId: string; newStockLitres: string; reason: string; unitCostKsh: string; notes: string }
interface PumpForm { fuelId: string; pumpCode: string }

const allFuelTypes: FuelType[] = ['DIESEL', 'PETROL'];

export default function FuelManagementPage() {
  useDocumentTitle('Manage Fuel');
  const queryClient = useQueryClient();
  const [fuelOpen, setFuelOpen] = useState(false);
  const [editing, setEditing] = useState<StationFuel | null>(null);
  const [adjustmentFuel, setAdjustmentFuel] = useState<StationFuel | null>(null);
  const [form, setForm] = useState<FuelForm>({ fuelType: 'DIESEL', sellingPriceKsh: '', tankCapacityLitres: '', isActive: true });
  const [adjustment, setAdjustment] = useState<AdjustmentForm>({ fuelId: '', newStockLitres: '', reason: '', unitCostKsh: '', notes: '' });
  const [pumpOpen, setPumpOpen] = useState(false);
  const [pumpForm, setPumpForm] = useState<PumpForm>({ fuelId: '', pumpCode: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, submit] = useSubmitGuard();
  const fuelTypeRef = useRef<HTMLSelectElement>(null);
  const fuelPriceRef = useRef<HTMLInputElement>(null);
  const fuelCapacityRef = useRef<HTMLInputElement>(null);
  const adjustmentStockRef = useRef<HTMLInputElement>(null);
  const adjustmentCostRef = useRef<HTMLInputElement>(null);
  const adjustmentReasonRef = useRef<HTMLInputElement>(null);
  const adjustmentNotesRef = useRef<HTMLTextAreaElement>(null);
  const pumpFuelRef = useRef<HTMLSelectElement>(null);
  const pumpCodeRef = useRef<HTMLInputElement>(null);

  const fuels = useQuery({ queryKey: ['fuel'], queryFn: () => stationApi.fuels.list(), staleTime: 20_000 });
  const pumps = useQuery({ queryKey: ['pumps'], queryFn: () => stationApi.pumps.list(), staleTime: 20_000 });
  const stationSettings = useQuery({ queryKey: ['settings', 'admin'], queryFn: () => request<{ settings: Settings }>('/settings') });
  const list = fuels.data || [];
  const threshold = stationSettings.data?.settings.lowStockThresholdLitres;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['fuel'] }),
    queryClient.invalidateQueries({ queryKey: ['pumps'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['settings', 'admin'] }),
  ]);
  useEffect(() => {
    if (!fuelOpen) return;
    const timer = window.setTimeout(() => focusField(editing ? fuelPriceRef : fuelTypeRef, true), 80);
    return () => window.clearTimeout(timer);
  }, [editing?.id, fuelOpen]);

  useEffect(() => {
    if (!adjustmentFuel) return;
    const timer = window.setTimeout(() => focusField(adjustmentStockRef, true), 80);
    return () => window.clearTimeout(timer);
  }, [adjustmentFuel?.id]);

  useEffect(() => {
    if (!pumpOpen) return;
    const timer = window.setTimeout(() => focusField(pumpFuelRef, true), 80);
    return () => window.clearTimeout(timer);
  }, [pumpOpen]);

  const saveFuel = useMutation({
    mutationFn: (body: Record<string, unknown>) => request<FuelResponse>(editing ? `/fuel/${editing.id}` : '/fuel', { method: editing ? 'PATCH' : 'POST', body }),
    onSuccess: () => { setFuelOpen(false); toast.success(editing ? 'Fuel configuration updated.' : 'Fuel configured.'); void refresh(); },
  });
  const adjustStock = useMutation({
    mutationFn: (body: Record<string, unknown>) => request('/stock-adjustments', { method: 'POST', body }),
    onSuccess: () => { setAdjustmentFuel(null); toast.success('Stock adjustment recorded.'); void refresh(); },
  });
  const createPump = useMutation({
    mutationFn: (body: Record<string, unknown>) => request('/pumps', { method: 'POST', body }),
    onSuccess: () => { setPumpOpen(false); toast.success('Pump configured.'); void refresh(); },
  });
  const togglePump = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => request(`/pumps/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: () => { toast.success('Pump status updated.'); void refresh(); },
  });

  const openCreate = () => { setEditing(null); setForm({ fuelType: allFuelTypes.find((type) => !list.some((fuel) => fuel.fuelType === type)) || 'DIESEL', sellingPriceKsh: '', tankCapacityLitres: '', isActive: true }); setFormError(null); setFuelOpen(true); };
  const openEdit = (fuel: StationFuel) => { setEditing(fuel); setForm({ fuelType: fuel.fuelType, sellingPriceKsh: String(fuel.sellingPriceKsh), tankCapacityLitres: fuel.tankCapacityLitres === null || fuel.tankCapacityLitres === undefined ? '' : String(fuel.tankCapacityLitres), isActive: fuel.isActive }); setFormError(null); setFuelOpen(true); };
  const openAdjustment = (fuel: StationFuel) => { setAdjustmentFuel(fuel); setAdjustment({ fuelId: String(fuel.id), newStockLitres: '', reason: '', unitCostKsh: '', notes: '' }); setFormError(null); };
  const openPump = () => { setPumpForm({ fuelId: String(list[0]?.id || ''), pumpCode: '' }); setFormError(null); setPumpOpen(true); };
  const onPumpSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(pumpForm.fuelId ? null : 'Choose a fuel type.', requiredText(pumpForm.pumpCode, 'Pump code', 50));
    if (validation) { setFormError(validation); return; }
    void submit(async () => {
      createPump.reset();
      try { await createPump.mutateAsync({ fuelId: Number(pumpForm.fuelId), pumpCode: pumpForm.pumpCode.trim().toUpperCase() }); }
      catch (error) { setFormError(error instanceof Error ? error.message : 'The pump could not be configured.'); }
    });
  };

  const onFuelSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(editing ? null : allFuelTypes.includes(form.fuelType) ? null : 'Choose an available fuel type.', positiveNumber(form.sellingPriceKsh, 'Selling price'), form.tankCapacityLitres ? positiveNumber(form.tankCapacityLitres, 'Tank capacity') : null);
    if (validation) { setFormError(validation); return; }
    const body: Record<string, unknown> = { sellingPriceKsh: Number(form.sellingPriceKsh), tankCapacityLitres: form.tankCapacityLitres ? Number(form.tankCapacityLitres) : null, ...(!editing ? { fuelType: form.fuelType } : {}), ...(editing ? { isActive: form.isActive } : {}) };
    void submit(async () => { saveFuel.reset(); try { await saveFuel.mutateAsync(body); } catch (error) { setFormError(error instanceof Error ? error.message : 'Fuel could not be saved.'); } });
  };
  const onAdjustmentSubmit = (event: FormEvent) => {
    event.preventDefault();
    const newStock = Number(adjustment.newStockLitres);
    const currentStock = adjustmentFuel?.quantityLitres ?? 0;
    const validation = firstError(
      adjustment.newStockLitres ? nonNegativeNumber(adjustment.newStockLitres, 'Counted stock') : 'Enter the verified physical stock.',
      requiredText(adjustment.reason, 'Reason', 500),
      adjustment.unitCostKsh ? nonNegativeNumber(adjustment.unitCostKsh, 'Unit cost') : null,
      newStock > currentStock && adjustmentFuel?.weightedAverageCostKsh === 0 && !adjustment.unitCostKsh ? 'A cost per litre is required because this fuel has no existing cost basis.' : null,
    );
    if (validation) { setFormError(validation); return; }
    void submit(async () => { adjustStock.reset(); try { await adjustStock.mutateAsync({ fuelId: Number(adjustment.fuelId), newStockLitres: newStock, reason: adjustment.reason.trim(), ...(adjustment.unitCostKsh ? { unitCostKsh: Number(adjustment.unitCostKsh) } : {}), ...(adjustment.notes.trim() ? { notes: adjustment.notes.trim() } : {}) }); } catch (error) { setFormError(error instanceof Error ? error.message : 'Stock adjustment could not be saved.'); } });
  };

  if (fuels.isLoading || pumps.isLoading) return <PageLoader label="Loading fuel configuration…" />;
  if (fuels.error) return <ErrorState message={fuels.error instanceof Error ? fuels.error.message : 'Fuel configuration could not be loaded.'} onRetry={() => void fuels.refetch()} />;
  if (pumps.error) return <ErrorState message={pumps.error instanceof Error ? pumps.error.message : 'Pump configuration could not be loaded.'} onRetry={() => void pumps.refetch()} />;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Manage Fuel" description="Configure selling prices and tank limits, then adjust live inventory with an auditable reason." actions={<Button onClick={openCreate} disabled={list.length >= allFuelTypes.length} leftIcon={<Plus className="h-4 w-4" />}>Configure fuel</Button>} />

      {!list.length ? <SectionCard><EmptyState title="Fuel onboarding required" message="No fuel types are configured. Add Diesel or Petrol with a selling price before the station can receive or sell inventory." icon={FuelIcon} action={<Button onClick={openCreate} leftIcon={<Plus className="h-4 w-4" />}>Configure first fuel</Button>} /></SectionCard> : <>
        {list.some((fuel) => threshold !== undefined && fuel.isActive && (fuel.quantityLitres || 0) <= threshold) && <div className="mb-5"><InlineAlert tone="warning" title="Low-stock condition" icon={AlertTriangle}>{list.filter((fuel) => threshold !== undefined && fuel.isActive && (fuel.quantityLitres || 0) <= threshold).map((fuel) => `${fuel.fuelType} has ${formatLitres(fuel.quantityLitres)}`).join(' · ')}</InlineAlert></div>}
        <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
          {list.map((fuel) => {
            const low = threshold !== undefined && fuel.isActive && (fuel.quantityLitres || 0) <= threshold;
            const capacityPercent = fuel.tankCapacityLitres ? Math.min(100, Math.max(0, ((fuel.quantityLitres || 0) / fuel.tankCapacityLitres) * 100)) : null;
            return (
              <article key={fuel.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel dark:border-slate-800 dark:bg-slate-900">
                <div className={`h-1.5 ${low ? 'bg-amber-500' : fuel.isActive ? 'bg-brand-600' : 'bg-slate-400'}`} />
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><span className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${fuel.isActive ? 'bg-brand-100 text-brand-700 dark:bg-brand-950' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}><FuelIcon className="h-5 w-5" /></span><div><h2 className="text-lg font-black capitalize text-slate-950 dark:text-white">{fuel.fuelType.toLowerCase()}</h2><p className="text-xs text-slate-500">#{fuel.id}</p></div></div><div className="flex gap-2"><Badge tone={fuel.isActive ? 'green' : 'slate'}>{fuel.isActive ? 'Active' : 'Inactive'}</Badge>{low && <Badge tone="amber">Low stock</Badge>}</div></div>
                  <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><dt className="text-xs text-slate-500">Current stock</dt><dd className="mt-1 font-black">{formatLitres(fuel.quantityLitres)}</dd></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><dt className="text-xs text-slate-500">Tank capacity</dt><dd className="mt-1 font-black">{fuel.tankCapacityLitres === null || fuel.tankCapacityLitres === undefined ? 'Not set' : formatLitres(fuel.tankCapacityLitres)}</dd></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><dt className="text-xs text-slate-500">Selling price</dt><dd className="mt-1 font-black">{formatKsh(fuel.sellingPriceKsh)}/L</dd></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><dt className="text-xs text-slate-500">Inventory value</dt><dd className="mt-1 font-black">{formatKsh(fuel.inventoryValueKsh)}</dd></div>
                  </dl>
                  {capacityPercent !== null && <div className="mt-4"><div className="mb-1.5 flex justify-between text-xs text-slate-500"><span>Tank used</span><span>{capacityPercent.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-full rounded-full ${low ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${capacityPercent}%` }} /></div></div>}
                  <div className="mt-5 flex gap-2"><Button variant="secondary" className="flex-1" leftIcon={<Edit3 className="h-4 w-4" />} onClick={() => openEdit(fuel)}>Edit configuration</Button><Button variant="warning" disabled={!fuel.isActive} leftIcon={<Scale className="h-4 w-4" />} onClick={() => openAdjustment(fuel)}>Adjust</Button></div>
                </div>
              </article>
            );
          })}
        </div>

        <SectionCard className="mt-6" title="Configured pumps" description="Detailed sales use these server-validated pump records." action={<Button size="sm" onClick={openPump} leftIcon={<Gauge className="h-4 w-4" />}>Add pump</Button>}>
          {!pumps.data?.length ? <EmptyState title="No pumps configured" message="Add at least one pump before recording detailed sales." icon={Gauge} action={<Button onClick={openPump}>Configure pump</Button>} /> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{pumps.data.map((pump: Pump) => <div key={pump.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div><p className="font-black">{pump.pumpCode}</p><p className="text-xs capitalize text-slate-500">{pump.fuelType.toLowerCase()}</p></div><Button size="sm" variant={pump.isActive ? 'secondary' : 'ghost'} onClick={() => togglePump.mutate({ id: pump.id, isActive: !pump.isActive })}>{pump.isActive ? 'Active' : 'Inactive'}</Button></div>)}</div>}
        </SectionCard>
      </>}

      <Modal open={fuelOpen} onClose={() => !submitting && setFuelOpen(false)} title={editing ? `Edit ${editing.fuelType.toLowerCase()}` : 'Configure fuel'} description={editing ? 'Selling price, capacity, and active status can be updated.' : 'Create a fuel type with its current selling price.'} footer={<><Button variant="secondary" disabled={submitting} onClick={() => setFuelOpen(false)}>Cancel</Button><Button disabled={submitting} loading={submitting} onClick={() => document.getElementById('fuel-form-submit')?.click()} leftIcon={<Save className="h-4 w-4" />}>{editing ? 'Save changes' : 'Create fuel'}</Button></>}>
        <form id="fuel-form" onSubmit={onFuelSubmit} noValidate className="space-y-4"><button id="fuel-form-submit" type="submit" className="hidden" />
          <Field id="fuel-type" label="Fuel type" required><Select ref={fuelTypeRef} id="fuel-type" value={form.fuelType} disabled={Boolean(editing)} options={allFuelTypes.filter((type) => editing ? type === editing.fuelType : !list.some((fuel) => fuel.fuelType === type)).map((type) => ({ value: type, label: type }))} onChange={(event) => setForm((value) => ({ ...value, fuelType: event.target.value as FuelType }))} onKeyDown={(event) => handleEnterToNext(event, fuelPriceRef)} enterKeyHint="next" /></Field>
          <div className="grid gap-4 sm:grid-cols-2"><Field id="fuel-price" label="Selling price per litre" required><KshInput ref={fuelPriceRef} id="fuel-price" value={form.sellingPriceKsh} onChange={(event) => setForm((value) => ({ ...value, sellingPriceKsh: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, fuelCapacityRef)} enterKeyHint="next" /></Field><Field id="fuel-capacity" label="Tank capacity" hint="Leave blank for no server limit"><Input ref={fuelCapacityRef} id="fuel-capacity" type="text" inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" selectOnFocus value={form.tankCapacityLitres} onChange={(event) => setForm((value) => ({ ...value, tankCapacityLitres: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" /></Field></div>
          {editing && <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700"><input type="checkbox" checked={form.isActive} onChange={(event) => setForm((value) => ({ ...value, isActive: event.target.checked }))} className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600" /><span><span className="block text-sm font-bold">Fuel is active</span><span className="text-xs text-slate-500">Inactive fuel cannot be selected for new transactions.</span></span></label>}
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <Modal open={pumpOpen} onClose={() => !submitting && setPumpOpen(false)} title="Configure pump" description="Pump codes are unique and can be selected in detailed sales." footer={<><Button variant="secondary" disabled={submitting} onClick={() => setPumpOpen(false)}>Cancel</Button><Button disabled={submitting} loading={submitting} onClick={() => document.getElementById('pump-form-submit')?.click()}>Save pump</Button></>}>
        <form id="pump-form" onSubmit={onPumpSubmit} noValidate className="space-y-4"><button id="pump-form-submit" type="submit" className="hidden" />
          <Field id="pump-fuel" label="Fuel type" required><Select ref={pumpFuelRef} id="pump-fuel" value={pumpForm.fuelId} options={list.filter((fuel) => fuel.isActive).map((fuel) => ({ value: String(fuel.id), label: fuel.fuelType }))} onChange={(event) => setPumpForm((value) => ({ ...value, fuelId: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, pumpCodeRef)} enterKeyHint="next" /></Field>
          <Field id="pump-code" label="Pump code" required hint="Letters, numbers, dots, dashes, and underscores"><Input ref={pumpCodeRef} id="pump-code" value={pumpForm.pumpCode} onChange={(event) => setPumpForm((value) => ({ ...value, pumpCode: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" maxLength={50} placeholder="PUMP-A" /></Field>
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <Modal open={Boolean(adjustmentFuel)} onClose={() => !submitting && setAdjustmentFuel(null)} title={`Adjust ${adjustmentFuel?.fuelType.toLowerCase() || 'fuel'} stock`} description="Current stock and weighted average cost are server managed." footer={<><Button variant="secondary" disabled={submitting} onClick={() => setAdjustmentFuel(null)}>Cancel</Button><Button variant="warning" disabled={submitting} loading={submitting} onClick={() => document.getElementById('fuel-adjust-submit')?.click()} leftIcon={<PackagePlus className="h-4 w-4" />}>Record adjustment</Button></>}>
        <form id="fuel-adjustment-form" onSubmit={onAdjustmentSubmit} noValidate className="space-y-4"><button id="fuel-adjust-submit" type="submit" className="hidden" />
          <InlineAlert tone="warning" title="Permanent physical count">Server stock before adjustment: {formatLitres(adjustmentFuel?.quantityLitres)}. Enter the verified tank quantity; the old and new values are recorded automatically.</InlineAlert>
          <div className="grid gap-4 sm:grid-cols-2"><Field id="adjust-stock-quantity" label="Verified new stock (L)" required><Input ref={adjustmentStockRef} id="adjust-stock-quantity" type="number" min="0" step="0.001" inputMode="decimal" selectOnFocus value={adjustment.newStockLitres} onChange={(event) => setAdjustment((value) => ({ ...value, newStockLitres: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, adjustmentCostRef)} enterKeyHint="next" /></Field><Field id="adjust-stock-cost" label="Cost per litre" hint={adjustmentFuel?.weightedAverageCostKsh === 0 ? 'Required when the count increases stock' : 'Optional'}><KshInput ref={adjustmentCostRef} id="adjust-stock-cost" value={adjustment.unitCostKsh} onChange={(event) => setAdjustment((value) => ({ ...value, unitCostKsh: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, adjustmentReasonRef)} enterKeyHint="next" /></Field></div>
          <Field id="adjust-stock-reason" label="Reason" required><Input ref={adjustmentReasonRef} id="adjust-stock-reason" value={adjustment.reason} onChange={(event) => setAdjustment((value) => ({ ...value, reason: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, adjustmentNotesRef)} enterKeyHint="next" maxLength={500} placeholder="Describe the verified reason" /></Field>
          <Field id="adjust-stock-notes" label="Notes"><Textarea ref={adjustmentNotesRef} id="adjust-stock-notes" value={adjustment.notes} onChange={(event) => setAdjustment((value) => ({ ...value, notes: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" maxLength={1000} /></Field>
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>
    </div>
  );
}
