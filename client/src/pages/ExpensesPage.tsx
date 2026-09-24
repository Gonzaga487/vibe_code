import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, LockKeyhole, Plus, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, type Column } from '@/components/ui/DataDisplay';
import { Field, Input, KshInput, Select, Textarea } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { EmptyState, InlineAlert } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { buildQuery, request } from '@/lib/api';
import { addDays, formatDateKey, formatKsh, formatTime, toDateKey, todayKey } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { firstError, isoDate, positiveNumber, requiredText } from '@/lib/validation';
import type { Expense, ExpenseCategory, ExpensePayload, Paginated, Shift } from '@/types/api';

interface ExpenseResponse { expense: Expense }
interface ShiftResponse { shift: Shift | null }
interface ExpenseForm {
  category: ExpenseCategory;
  description: string;
  amountKsh: string;
  paymentMethod: 'cash' | 'mpesa';
  expenseDate: string;
  notes: string;
}

const categories: Array<{ value: ExpenseCategory; label: string }> = [
  { value: 'FUEL', label: 'Fuel' }, { value: 'UTILITIES', label: 'Utilities' }, { value: 'SALARY', label: 'Salary' }, { value: 'MAINTENANCE', label: 'Maintenance' }, { value: 'TRANSPORT', label: 'Transport' }, { value: 'OTHER', label: 'Other' },
];
const blankForm = (date = todayKey()): ExpenseForm => ({ category: 'OTHER', description: '', amountKsh: '', paymentMethod: 'cash', expenseDate: date, notes: '' });

export default function ExpensesPage() {
  useDocumentTitle('Expenses');
  const { isAdmin } = useAuth();
  const { settings } = useSettings();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(toDateKey(addDays(new Date(), -30)));
  const [to, setTo] = useState(todayKey());
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [form, setForm] = useState<ExpenseForm>(blankForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, submit] = useSubmitGuard();

  const openShift = useQuery({ queryKey: ['shift', 'open'], queryFn: () => request<ShiftResponse>('/shifts/open'), staleTime: 15_000 });
  const query = { from: from || undefined, to: to || undefined, category: category || undefined, page, pageSize };
  const expenses = useQuery({ queryKey: ['expenses', query], queryFn: () => request<Paginated<Expense>>(`/expenses${buildQuery(query)}`), placeholderData: (previous) => previous });
  const currentShift = openShift.data?.shift || null;
  const openedDate = currentShift?.openedAt.slice(0, 10);

  const displayed = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase();
    if (!term) return expenses.data?.data || [];
    return (expenses.data?.data || []).filter((expense) => `${expense.description} ${expense.notes || ''} ${expense.user.fullName}`.toLowerCase().includes(term));
  }, [debouncedSearch, expenses.data?.data]);

  const openCreate = () => { setEditing(null); setForm(blankForm(openedDate && openedDate <= todayKey() ? openedDate : todayKey())); setFormError(null); setFormOpen(true); };
  const openEdit = (expense: Expense) => { setEditing(expense); setForm({ category: expense.category, description: expense.description, amountKsh: String(expense.amountKsh), paymentMethod: expense.paymentMethod, expenseDate: expense.expenseDate, notes: expense.notes || '' }); setFormError(null); setFormOpen(true); };
  const save = useMutation({
    mutationFn: (payload: ExpensePayload) => request<ExpenseResponse>(editing ? `/expenses/${editing.id}` : '/expenses', { method: editing ? 'PATCH' : 'POST', body: payload }),
    onSuccess: () => { setFormOpen(false); toast.success(editing ? 'Expense updated.' : 'Expense recorded.'); void Promise.all([queryClient.invalidateQueries({ queryKey: ['expenses'] }), queryClient.invalidateQueries({ queryKey: ['shift', 'open'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]); },
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(requiredText(form.description, 'Description', 500), positiveNumber(form.amountKsh, 'Amount'), isoDate(form.expenseDate, 'Expense date'), currentShift && form.expenseDate < (openedDate || '') ? 'Expense date cannot be before the current shift opened.' : form.expenseDate > todayKey() ? 'Expense date cannot be in the future.' : null);
    if (validation) { setFormError(validation); return; }
    const payload: ExpensePayload = { category: form.category, description: form.description.trim(), amountKsh: Number(form.amountKsh), paymentMethod: form.paymentMethod, expenseDate: form.expenseDate, ...(form.notes.trim() ? { notes: form.notes.trim() } : {}) };
    void submit(async () => { save.reset(); try { await save.mutateAsync(payload); } catch (error) { setFormError(error instanceof Error ? error.message : 'The expense could not be saved.'); } });
  };
  const remove = async () => {
    if (!deleteTarget) return; setDeleteLoading(true);
    try { await request(`/expenses/${deleteTarget.id}`, { method: 'DELETE' }); toast.success('Expense deleted.'); setDeleteTarget(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['expenses'] }), queryClient.invalidateQueries({ queryKey: ['shift', 'open'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The expense could not be deleted.'); } finally { setDeleteLoading(false); }
  };

  const columns: Array<Column<Expense>> = [
    { key: 'date', header: 'Date', render: (item) => <span><span className="font-bold">{formatDateKey(item.expenseDate, settings.dateFormat)}</span><span className="block text-xs text-slate-500">{formatTime(item.createdAt, settings.timezone)}</span></span> },
    { key: 'description', header: 'Description', render: (item) => <span><span className="block font-semibold">{item.description}</span>{item.notes && <span className="mt-1 block max-w-sm text-xs text-slate-500">{item.notes}</span>}</span> },
    { key: 'category', header: 'Category', render: (item) => <Badge tone="slate">{item.category}</Badge> },
    { key: 'owner', header: 'Recorded by', render: (item) => item.user.fullName },
    { key: 'payment', header: 'Payment', render: (item) => <span className="capitalize">{item.paymentMethod}</span> },
    { key: 'amount', header: 'Amount', render: (item) => <span className="font-black">{formatKsh(item.amountKsh)}</span> },
    { key: 'actions', header: 'Actions', render: (item) => <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" className="px-2" onClick={() => openEdit(item)} aria-label={`Edit expense ${item.id}`}><Edit3 className="h-4 w-4" /></Button><Button variant="ghost" size="sm" className="px-2 text-red-600" onClick={() => setDeleteTarget(item)} aria-label={`Delete expense ${item.id}`}><Trash2 className="h-4 w-4" /></Button></div> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Expenses" description={isAdmin ? 'All station expenses, with owner identity and payment details.' : 'Your expenses, linked to your open shift.'} actions={<Button onClick={openCreate} disabled={!isAdmin && !currentShift} leftIcon={<Plus className="h-4 w-4" />}>Record expense</Button>} />

      {!isAdmin && !currentShift && <div className="mb-6"><InlineAlert tone="warning" title="No open shift"><span>Attendant expenses must be linked to an open shift. <Link className="font-bold underline" to="/shift">Open your shift</Link> to record an expense.</span></InlineAlert></div>}

      <SectionCard className="mb-6" title="Filters" description="Date and category filters are executed by the API. Text search filters the currently loaded page.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field id="expense-from" label="From"><Input id="expense-from" type="date" value={from} max={to} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
          <Field id="expense-to" label="To"><Input id="expense-to" type="date" value={to} min={from} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
          <Field id="expense-category" label="Category"><Select id="expense-category" value={category} placeholder="All categories" options={categories} onChange={(event) => { setCategory(event.target.value); setPage(1); }} /></Field>
          <Field id="expense-search" label="Search loaded page" className="lg:col-span-2"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input id="expense-search" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Description, note, or owner" /></div></Field>
        </div>
      </SectionCard>

      <SectionCard title="Expense records" description={debouncedSearch ? `${displayed.length} matches on the current page` : 'Connected records for the selected filters.'} padded={false}>
        {!currentShift && !expenses.data && expenses.isLoading ? <div className="p-6 text-center text-sm text-slate-500">Loading expenses…</div> : <DataTable columns={columns} data={displayed} getRowKey={(item) => item.id} loading={expenses.isLoading} emptyTitle={debouncedSearch ? 'No matching expenses' : 'No expenses found'} emptyMessage={debouncedSearch ? 'Try another term or clear the search.' : 'No records match the selected date and category filters.'} caption="Station expenses" renderMobile={(item) => <div className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{item.description}</p><p className="mt-1 text-xs text-slate-500">{formatDateKey(item.expenseDate, settings.dateFormat)} · {item.category} · {item.paymentMethod}</p></div><p className="font-black">{formatKsh(item.amountKsh)}</p></div><div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" leftIcon={<Edit3 className="h-3.5 w-3.5" />} onClick={() => openEdit(item)}>Edit</Button><Button size="sm" variant="ghost" className="text-red-600" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleteTarget(item)}>Delete</Button></div></div>} />}
        {expenses.data && <Pagination pagination={expenses.data.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
      </SectionCard>

      <Modal open={formOpen} onClose={() => !submitting && setFormOpen(false)} title={editing ? 'Edit expense' : 'Record expense'} description={currentShift ? `Linked automatically to open shift #${currentShift.id}.` : 'Administrative expense without a shift link.'} footer={<><Button variant="secondary" disabled={submitting} onClick={() => setFormOpen(false)}>Cancel</Button><Button disabled={submitting} loading={submitting} onClick={() => document.getElementById('expense-form-submit')?.click()}>{editing ? 'Save changes' : 'Record expense'}</Button></>}>
        <form id="expense-form" onSubmit={onSubmit} noValidate className="space-y-4"><button id="expense-form-submit" type="submit" className="hidden" />
          {!isAdmin && !currentShift && <EmptyState title="Open shift required" message="An open shift is required before an attendant can record an expense." icon={LockKeyhole} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="expense-form-category" label="Category" required><Select id="expense-form-category" value={form.category} options={categories} onChange={(event) => setForm((value) => ({ ...value, category: event.target.value as ExpenseCategory }))} /></Field>
            <Field id="expense-form-date" label="Expense date" required><Input id="expense-form-date" type="date" value={form.expenseDate} min={isAdmin ? undefined : openedDate} max={todayKey()} onChange={(event) => setForm((value) => ({ ...value, expenseDate: event.target.value }))} /></Field>
            <Field id="expense-form-description" label="Description" required className="sm:col-span-2"><Input id="expense-form-description" value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} maxLength={500} placeholder="What was purchased or paid?" /></Field>
            <Field id="expense-form-amount" label="Amount" required><KshInput id="expense-form-amount" value={form.amountKsh} onChange={(event) => setForm((value) => ({ ...value, amountKsh: event.target.value }))} /></Field>
            <Field id="expense-form-payment" label="Payment method" required><Select id="expense-form-payment" value={form.paymentMethod} options={[{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa' }]} onChange={(event) => setForm((value) => ({ ...value, paymentMethod: event.target.value as 'cash' | 'mpesa' }))} /></Field>
            <Field id="expense-form-notes" label="Notes" className="sm:col-span-2"><Textarea id="expense-form-notes" value={form.notes} onChange={(event) => setForm((value) => ({ ...value, notes: event.target.value }))} maxLength={1000} /></Field>
          </div>
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(deleteTarget)} title={`Delete expense #${deleteTarget?.id || ''}?`} message={`${deleteTarget?.description || 'This expense'} will be permanently removed and any related shift totals recalculated. This action is audited.`} confirmLabel="Delete expense" loading={deleteLoading} onConfirm={() => void remove()} onClose={() => !deleteLoading && setDeleteTarget(null)} />
    </div>
  );
}
