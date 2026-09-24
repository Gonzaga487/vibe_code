import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Filter, RefreshCw, ScrollText, ShieldAlert, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, type Column } from '@/components/ui/DataDisplay';
import { Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState, InlineAlert } from '@/components/ui/Feedback';
import { buildQuery, request } from '@/lib/api';
import { addDays, formatDateTime, formatNumber, toDateKey } from '@/lib/format';
import { useDebouncedValue, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import type { AuditEntry, Paginated, Settings, User } from '@/types/api';

const categories = ['auth', 'admin', 'sale', 'shift', 'inventory', 'reading', 'expense', 'settings', 'system'] as const;

function metadataLabel(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export default function AuditPage() {
  useDocumentTitle('Audit Trail');
  const queryClient = useQueryClient();
  const [event, setEvent] = useState('');
  const debouncedEvent = useDebouncedValue(event);
  const [category, setCategory] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState(toDateKey(addDays(new Date(), -30)));
  const [to, setTo] = useState(toDateKey(new Date()));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeAll, setWipeAll] = useState(false);
  const [retentionDays, setRetentionDays] = useState('365');
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [submitting, submit] = useSubmitGuard();

  const settings = useQuery({ queryKey: ['settings', 'admin'], queryFn: () => request<{ settings: Settings }>('/settings') });
  const users = useQuery({ queryKey: ['users', 'audit-filter'], queryFn: () => request<Paginated<User>>('/users?pageSize=100') });
  const query = { from: from || undefined, to: to || undefined, category: category || undefined, event: debouncedEvent.trim() || undefined, actorId: actorId || undefined, page, pageSize };
  const audit = useQuery({ queryKey: ['audit', query], queryFn: () => request<Paginated<AuditEntry>>(`/audit${buildQuery(query)}`), placeholderData: (previous) => previous });
  const wipe = useMutation({
    mutationFn: () => request<{ deleted: number; preservedActionEvent: boolean }>('/audit/wipe', { method: 'POST', body: wipeAll ? { confirmation: 'WIPE AUDIT LOGS', wipeAll: true } : { confirmation: 'WIPE AUDIT LOGS', retentionDays: Number(retentionDays) } }),
    onSuccess: ({ deleted }) => { setWipeOpen(false); toast.success(`${formatNumber(deleted)} audit records deleted. The wipe action was preserved.`); setPage(1); void queryClient.invalidateQueries({ queryKey: ['audit'] }); },
  });

  const openWipe = () => {
    const configured = settings.data?.settings.auditRetentionDays;
    if (configured !== undefined) setRetentionDays(String(configured));
    setWipeAll(false); setWipeError(null); setWipeOpen(true);
  };
  const confirmWipe = () => {
    const days = Number(retentionDays);
    if (!wipeAll && (!Number.isInteger(days) || days < 1 || days > 3650)) { setWipeError('Retention must be a whole number from 1 to 3650 days.'); return; }
    setWipeError(null);
    void submit(async () => { wipe.reset(); try { await wipe.mutateAsync(); } catch (error) { setWipeError(error instanceof Error ? error.message : 'Audit records could not be deleted.'); } });
  };

  const columns: Array<Column<AuditEntry>> = [
    { key: 'timestamp', header: 'Time', render: (item) => <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">{formatDateTime(item.timestamp)}</span> },
    { key: 'actor', header: 'Actor', render: (item) => item.actor ? <span><span className="font-bold">{item.actor.username}</span><span className="block text-xs text-slate-500">#{item.actor.id}</span></span> : <span className="text-slate-400">System / anonymous</span> },
    { key: 'category', header: 'Category', render: (item) => <Badge tone={item.category === 'auth' ? 'blue' : item.category === 'admin' ? 'violet' : item.category === 'sale' ? 'amber' : 'slate'}>{item.category}</Badge> },
    { key: 'event', header: 'Event', render: (item) => <details className="max-w-sm"><summary className="cursor-pointer break-all font-mono text-xs font-bold text-slate-800 hover:text-brand-700 dark:text-slate-100">{item.event}</summary><dl className="mt-3 space-y-2 text-xs"><div><dt className="font-bold text-slate-600 dark:text-slate-300">Metadata</dt><dd><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-2 font-mono text-slate-700 dark:bg-slate-950 dark:text-slate-200">{metadataLabel(item.metadata)}</pre></dd></div>{item.ipAddress && <div><dt className="font-bold text-slate-600 dark:text-slate-300">IP address</dt><dd>{item.ipAddress}</dd></div>}{item.requestId && <div><dt className="font-bold text-slate-600 dark:text-slate-300">Request ID</dt><dd className="break-all font-mono">{item.requestId}</dd></div>}</dl></details> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Audit Trail" description="Admin-only chronological security and operational event log, newest first." actions={<><Button variant="secondary" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => { setPage(1); void audit.refetch(); }}>Refresh</Button><Button variant="danger" leftIcon={<Trash2 className="h-4 w-4" />} onClick={openWipe}>Retention & wipe</Button></>} />

      <div className="mb-6"><InlineAlert tone="warning" title="Destructive log maintenance" icon={ShieldAlert}>Audit records are security history. Wipe actions require explicit typed confirmation. The server always preserves the wipe action event.</InlineAlert></div>

      <SectionCard className="mb-6" title="Filter activity" description="Filters execute against the server audit store.">
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); setPage(1); void audit.refetch(); }} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Field id="audit-from" label="From"><Input id="audit-from" type="date" value={from} max={to} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></Field>
          <Field id="audit-to" label="To"><Input id="audit-to" type="date" value={to} min={from} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></Field>
          <Field id="audit-category" label="Category"><Select id="audit-category" value={category} placeholder="All categories" options={categories.map((value) => ({ value, label: value }))} onChange={(event) => { setCategory(event.target.value); setPage(1); }} /></Field>
          <Field id="audit-event" label="Event contains"><Input id="audit-event" value={event} onChange={(event) => { setEvent(event.target.value); setPage(1); }} maxLength={100} placeholder="e.g. shift.closed" /></Field>
          <Field id="audit-actor" label="Actor"><Select id="audit-actor" value={actorId} placeholder="All actors" options={(users.data?.data || []).map((user) => ({ value: String(user.id), label: user.username }))} onChange={(event) => { setActorId(event.target.value); setPage(1); }} /></Field>
          <div className="flex items-end"><Button type="submit" className="w-full" leftIcon={<Filter className="h-4 w-4" />}>Apply</Button></div>
        </form>
      </SectionCard>

      <SectionCard title="Chronological log" description={`${formatNumber(audit.data?.pagination.total || 0)} matching records`} padded={false}>
        <DataTable columns={columns} data={audit.data?.data || []} getRowKey={(item) => item.id} loading={audit.isLoading} emptyTitle="No audit events found" emptyMessage="No log records match the selected filters." caption="Audit event log" renderMobile={(item) => <details className="p-4"><summary><div className="flex items-center justify-between gap-3"><Badge tone="violet">{item.category}</Badge><span className="text-xs text-slate-500">{formatDateTime(item.timestamp)}</span></div><p className="mt-3 break-all font-mono text-sm font-bold">{item.event}</p><p className="mt-1 text-xs text-slate-500">{item.actor?.username || 'System / anonymous'}</p><span className="mt-2 block text-xs font-semibold text-brand-700 dark:text-brand-300">Show details</span></summary><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 font-mono text-xs dark:bg-slate-950">{metadataLabel(item.metadata)}</pre></details>} />
        {audit.data && <Pagination pagination={audit.data.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
      </SectionCard>

      {!audit.data && !audit.isLoading && <EmptyState title="No log loaded" message="Apply filters to load the audit trail." icon={ScrollText} />}

      <ConfirmDialog open={wipeOpen} title="Wipe audit records?" confirmationText="WIPE AUDIT LOGS" confirmLabel="Wipe audit records" variant="danger" loading={submitting} message={<div><p>This permanently deletes audit history according to the selection below. The action itself is preserved in the log.</p>{wipeError && <p className="mt-2 font-bold">{wipeError}</p>}</div>} onConfirm={confirmWipe} onClose={() => !submitting && setWipeOpen(false)}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3"><button type="button" onClick={() => setWipeAll(false)} className={`rounded-xl border-2 p-3 text-left ${!wipeAll ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/40' : 'border-slate-200 dark:border-slate-700'}`}><span className="block text-sm font-bold">Apply retention</span><span className="mt-1 block text-xs text-slate-500">Delete records older than the cutoff.</span></button><button type="button" onClick={() => setWipeAll(true)} className={`rounded-xl border-2 p-3 text-left ${wipeAll ? 'border-red-600 bg-red-50 dark:bg-red-950/40' : 'border-slate-200 dark:border-slate-700'}`}><span className="block text-sm font-bold">Wipe all</span><span className="mt-1 block text-xs text-slate-500">Delete the entire log, not just old entries.</span></button></div>
          {!wipeAll && <Field id="audit-retention-days" label="Retention days" required hint={`Current station default: ${settings.data?.settings.auditRetentionDays ?? 'loading'} days`}><Input id="audit-retention-days" type="number" min="1" max="3650" step="1" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} /></Field>}
          <div className="flex items-start gap-2 text-xs text-slate-500"><CalendarDays className="mt-0.5 h-4 w-4 shrink-0" /><p>Retention is calculated by the server in UTC. The wipe event remains for accountability.</p></div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
