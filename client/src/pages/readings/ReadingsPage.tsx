import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, EyeOff, Gauge, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, type Column } from '@/components/ui/DataDisplay';
import { Field, Input, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { EmptyState, ErrorState, InlineAlert, ProtectedState, TableSkeleton } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { buildQuery } from '@/lib/api';
import { addDays, formatDateKey, formatKsh, formatLitres, formatNumber, todayKey, toDateKey } from '@/lib/format';
import { focusField, handleEnterToNext, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { stationApi, type ReadingDraft } from '@/lib/stationApi';
import { firstError, isoDate, nonNegativeNumber } from '@/lib/validation';
import type { Reading } from '@/types/api';

interface ReadingKindProps {
  kind: 'pump' | 'sales';
  title: string;
  description: string;
}

interface ReadingForm {
  fuelId: string;
  readingDate: string;
  opening: string;
  previousClosing: string;
  closingReading: string;
  meterReference: string;
  notes: string;
}

const emptyForm = (fuelId = ''): ReadingForm => ({ fuelId, readingDate: todayKey(), opening: '', previousClosing: '', closingReading: '', meterReference: '', notes: '' });

export default function ReadingsPage({ kind, title, description }: ReadingKindProps) {
  useDocumentTitle(title);
  const { isAdmin } = useAuth();
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(toDateKey(addDays(new Date(), -30)));
  const [to, setTo] = useState(todayKey());
  const [fuelFilter, setFuelFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Reading | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reading | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [form, setForm] = useState<ReadingForm>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, submit] = useSubmitGuard();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const fuelRef = useRef<HTMLSelectElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef<HTMLInputElement>(null);
  const previousRef = useRef<HTMLInputElement>(null);
  const closingRef = useRef<HTMLInputElement>(null);
  const referenceRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const filters = { from: from || undefined, to: to || undefined, fuelId: fuelFilter || undefined, page, pageSize };
  const readings = useQuery({
    queryKey: ['readings', kind, filters],
    queryFn: () => stationApi.readings.list(kind, buildQuery(filters)),
    placeholderData: (previous) => previous,
  });
  const fuels = useQuery({ queryKey: ['fuel'], queryFn: () => stationApi.fuels.list(), staleTime: 60_000 });
  const activeFuels = (fuels.data || []).filter((fuel) => fuel.isActive);
  const fuelName = (id: number) => fuels.data?.find((fuel) => fuel.id === id)?.fuelType || 'Unknown';

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(activeFuels[0] ? String(activeFuels[0].id) : ''));
    setFormError(null);
    setFormOpen(true);
  };
  const openEdit = (reading: Reading) => {
    setEditing(reading);
    setForm({
      fuelId: String(reading.fuel.id),
      readingDate: reading.readingDate,
      opening: String(reading.opening),
      previousClosing: String(reading.previousClosing),
      closingReading: String(reading.closing),
      meterReference: reading.meterReference,
      notes: reading.notes || '',
    });
    setFormError(null);
    setFormOpen(true);
  };

  useEffect(() => {
    if (!formOpen) return;
    const timer = window.setTimeout(() => focusField(editing ? openingRef : fuelRef, true), 80);
    return () => window.clearTimeout(timer);
  }, [editing?.id, formOpen]);

  const save = useMutation({
    mutationFn: ({ id, draft }: { id: number | null; draft: ReadingDraft }) => stationApi.readings.save(kind, id, draft),
    onSuccess: () => {
      setFormOpen(false);
      toast.success(editing ? 'Meter reading updated.' : `${kind === 'pump' ? 'Pump' : 'Sales'} meter reading recorded.`);
      window.setTimeout(() => focusField(addButtonRef), 0);
      void queryClient.invalidateQueries({ queryKey: ['readings', kind] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['fuel'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(
      form.fuelId ? null : 'Choose Petrol or Diesel.',
      isoDate(form.readingDate, 'Reading date'),
      form.opening ? nonNegativeNumber(form.opening, kind === 'pump' ? 'Opening reading (L)' : 'Opening reading (KSh)') : 'Opening reading is required.',
      form.previousClosing ? nonNegativeNumber(form.previousClosing, kind === 'pump' ? 'Previous-day closing (L)' : 'Previous-day closing (KSh)') : 'Previous-day closing is required.',
      form.closingReading ? nonNegativeNumber(form.closingReading, kind === 'pump' ? 'Closing reading (L)' : 'Closing reading (KSh)') : 'Closing reading is required.',
      form.notes.trim().length > 1000 ? 'Notes cannot exceed 1,000 characters.' : null,
    );
    if (validation) { setFormError(validation); return; }
    const draft: ReadingDraft = {
      fuelId: Number(form.fuelId),
      readingDate: form.readingDate,
      opening: Number(form.opening),
      previousClosing: Number(form.previousClosing),
      closingReading: Number(form.closingReading),
      ...(form.meterReference.trim() ? { meterReference: form.meterReference.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
    void submit(async () => {
      save.reset();
      try { await save.mutateAsync({ id: editing?.id || null, draft }); }
      catch (error) { setFormError(error instanceof Error ? error.message : 'The reading could not be saved.'); }
    });
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await stationApi.readings.remove(kind, deleteTarget.id);
      toast.success('Meter reading deleted.');
      setDeleteTarget(null);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['readings', kind] }), queryClient.invalidateQueries({ queryKey: ['fuel'] })]);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'The reading could not be deleted.'); }
    finally { setDeleteLoading(false); }
  };

  if (fuels.isLoading) return <div className="animate-fade-in"><PageHeader title={title} description={description} /><SectionCard><TableSkeleton /></SectionCard></div>;
  const hasFuel = activeFuels.length > 0;

  const columns: Array<Column<Reading>> = [
    { key: 'date', header: 'Date', render: (item) => <span><span className="font-bold">{formatDateKey(item.readingDate, settings.dateFormat)}</span><span className="block text-xs text-slate-500">{item.pumpId || item.meterReference}</span></span> },
    { key: 'fuel', header: 'Fuel', render: (item) => <span className="font-semibold">{fuelName(item.fuel.id)}<span className="block text-xs font-normal text-slate-500">{item.user.fullName}</span></span> },
    { key: 'meters', header: 'Opening / previous / closing', render: (item) => <span className="tabular-nums"><span className="block">{formatNumber(item.opening)} / {formatNumber(item.previousClosing)} → <strong>{formatNumber(item.closing)}</strong></span><span className="text-xs text-slate-500">{item.readingUnit === 'LITRES' ? 'Litres' : 'KSh sales meter'}</span></span> },
    ...(isAdmin ? [
      { key: 'consumption', header: 'Consumption', render: (item: Reading) => <span className="font-bold">{item.readingUnit === 'LITRES' ? formatLitres(item.consumptionLitres) : formatKsh(item.consumptionKsh)}</span> },
      { key: 'reconciliation', header: 'Reconciliation', render: (item: Reading) => <span className="font-black text-slate-950 dark:text-white">{formatKsh(item.reconciliationKsh)}</span> },
    ] : []),
    { key: 'actions', header: 'Actions', render: (item) => <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" className="px-2" onClick={() => openEdit(item)} aria-label={`Edit reading ${item.id}`}><Edit3 className="h-4 w-4" /></Button><Button variant="ghost" size="sm" className="px-2 text-red-600" onClick={() => setDeleteTarget(item)} aria-label={`Delete reading ${item.id}`}><Trash2 className="h-4 w-4" /></Button></div> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title={title} description={description} actions={<Button ref={addButtonRef} onClick={openCreate} disabled={!hasFuel} leftIcon={<Plus className="h-4 w-4" />}>Add reading</Button>} />
      {!hasFuel ? <SectionCard><EmptyState title="Petrol or Diesel configuration required" message="An active supported fuel type is required before meter readings can be recorded." /></SectionCard> : <>
        <SectionCard title="Reading filters" description="Narrow the connected station record by date or fuel." className="mb-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="reading-from" label="From"><Input id="reading-from" type="date" value={from} max={to} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
            <Field id="reading-to" label="To"><Input id="reading-to" type="date" value={to} min={from} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
            <Field id="reading-fuel" label="Fuel"><Select id="reading-fuel" value={fuelFilter} placeholder="All supported fuels" options={(fuels.data || []).map((fuel) => ({ value: String(fuel.id), label: fuel.fuelType }))} onChange={(event) => { setFuelFilter(event.target.value); setPage(1); }} /></Field>
            <div className="flex items-end"><Button variant="secondary" className="w-full" onClick={() => { setPage(1); void readings.refetch(); }}>Apply filters</Button></div>
          </div>
        </SectionCard>

        {!isAdmin && <div className="mb-6"><ProtectedState title="Reconciliation results are protected" message="Your list contains only readings you submitted. The server does not return station-wide consumption, pricing, or KSh reconciliation for attendants." /></div>}

        <SectionCard title="Connected readings" description={isAdmin ? 'All station readings for the selected filters.' : 'Your own readings for the selected filters.'} padded={false}>
          {readings.error ? <ErrorState message={readings.error instanceof Error ? readings.error.message : 'Readings could not be loaded.'} onRetry={() => void readings.refetch()} compact /> : <DataTable columns={columns} data={readings.data?.data || []} getRowKey={(item) => item.id} loading={readings.isLoading} emptyTitle="No meter readings" emptyMessage="No readings match these filters. Add a reading or adjust the date range." caption={`${title} list`} renderMobile={(item) => <div className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{formatDateKey(item.readingDate, settings.dateFormat)} · {fuelName(item.fuel.id)}</p><p className="mt-1 text-xs text-slate-500">{item.pumpId || item.meterReference} · {item.user.fullName}</p></div><Badge tone="blue">{formatNumber(item.closingReading)}</Badge></div>{isAdmin && <div className="mt-3 flex justify-between text-sm"><span>{item.readingUnit === 'LITRES' ? `${formatLitres(item.consumptionLitres)} consumed` : `${formatKsh(item.consumptionKsh)} meter movement`}</span><strong>{formatKsh(item.reconciliationKsh)}</strong></div>}<div className="mt-3 flex gap-2"><Button variant="secondary" size="sm" onClick={() => openEdit(item)} leftIcon={<Edit3 className="h-3.5 w-3.5" />}>Edit</Button><Button variant="ghost" size="sm" className="text-red-600" onClick={() => setDeleteTarget(item)} leftIcon={<Trash2 className="h-3.5 w-3.5" />}>Delete</Button></div></div>} />}
          {readings.data && <Pagination pagination={readings.data.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
        </SectionCard>
      </>}

      <Modal open={formOpen} onClose={() => !submitting && setFormOpen(false)} title={editing ? 'Edit meter reading' : `Record ${kind === 'pump' ? 'pump' : 'sales'} meter reading`} description="Enter all three physical meter values. Historical dates are accepted and reconciled transactionally." size="lg" footer={<><Button variant="secondary" onClick={() => setFormOpen(false)} disabled={submitting}>Cancel</Button><Button onClick={() => document.getElementById('reading-form-submit')?.click()} loading={submitting}>{editing ? 'Save changes' : 'Record reading'}</Button></>}>
        <form id="reading-form" onSubmit={onSubmit} noValidate className="space-y-4">
          <button id="reading-form-submit" type="submit" className="hidden" aria-hidden="true" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="reading-form-fuel" label="Fuel type" required><Select ref={fuelRef} id="reading-form-fuel" value={form.fuelId} placeholder="Choose fuel" options={activeFuels.map((fuel) => ({ value: String(fuel.id), label: fuel.fuelType }))} onChange={(event) => setForm((value) => ({ ...value, fuelId: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, dateRef)} enterKeyHint="next" /></Field>
            <Field id="reading-form-date" label="Reading date" required hint="Historical dates are supported"><Input ref={dateRef} id="reading-form-date" type="date" value={form.readingDate} max={todayKey()} onChange={(event) => setForm((value) => ({ ...value, readingDate: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, openingRef)} enterKeyHint="next" /></Field>
            <Field id="reading-opening" label={kind === 'pump' ? 'Opening reading (L)' : 'Opening reading (KSh)'} required><Input ref={openingRef} id="reading-opening" type="text" inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" selectOnFocus enterKeyHint="next" value={form.opening} onChange={(event) => setForm((value) => ({ ...value, opening: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, previousRef)} placeholder={kind === 'pump' ? '0.000' : '0.00'} /></Field>
            <Field id="reading-previous" label={kind === 'pump' ? 'Previous-day closing (L)' : 'Previous-day closing (KSh)'} required><Input ref={previousRef} id="reading-previous" type="text" inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" selectOnFocus enterKeyHint="next" value={form.previousClosing} onChange={(event) => setForm((value) => ({ ...value, previousClosing: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, closingRef)} placeholder={kind === 'pump' ? '0.000' : '0.00'} /></Field>
            <Field id="reading-closing" label={kind === 'pump' ? 'Closing reading (L)' : 'Closing reading (KSh)'} required><Input ref={closingRef} id="reading-closing" type="text" inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" selectOnFocus enterKeyHint="next" value={form.closingReading} onChange={(event) => setForm((value) => ({ ...value, closingReading: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, referenceRef)} /></Field>
            <Field id="reading-reference" label="Meter reference" hint="Optional"><Input ref={referenceRef} id="reading-reference" value={form.meterReference} onChange={(event) => setForm((value) => ({ ...value, meterReference: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, notesRef)} enterKeyHint="next" maxLength={100} placeholder={kind === 'pump' ? 'e.g. PUMP-A' : 'e.g. SALES-A'} /></Field>
            <Field id="reading-notes" label="Notes" className="sm:col-span-2"><Textarea ref={notesRef} id="reading-notes" value={form.notes} onChange={(event) => setForm((value) => ({ ...value, notes: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" maxLength={1000} /></Field>
          </div>
          <InlineAlert title={kind === 'pump' ? 'Inventory impact' : 'Independent sales reconciliation'} tone="info" icon={kind === 'pump' ? Gauge : EyeOff}>{kind === 'pump' ? 'Positive consumption reduces tank inventory transactionally. The server rejects insufficient stock or capacity.' : 'This reading reconciles the sales meter but does not reduce tank stock a second time.'}</InlineAlert>
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title={`Delete reading #${deleteTarget?.id || ''}?`} message={kind === 'pump' ? 'Deleting a pump reading reverses its exact inventory allocation and recalculates current stock. This cannot be undone.' : 'Deleting this sales meter reading permanently removes the reconciliation record. This cannot be undone.'} confirmLabel="Delete reading" loading={deleteLoading} onConfirm={() => void remove()} onClose={() => !deleteLoading && setDeleteTarget(null)} />
    </div>
  );
}
