import { useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, CheckCircle2, DatabaseBackup, Download, FileJson, ShieldAlert, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { PageHeader, SectionCard } from '@/components/ui/DataDisplay';
import { Input } from '@/components/ui/Form';
import { ConfirmDialog } from '@/components/ui/Modal';
import { InlineAlert } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { download, request } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import type { BackupSnapshot, ClearOperationalResponse } from '@/types/api';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function validateSnapshot(value: unknown): BackupSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file must contain a JSON snapshot object.');
  const snapshot = value as Partial<BackupSnapshot>;
  const expectedKeys = ['format', 'formatVersion', 'schemaVersion', 'exportedAt', 'tables', 'checksum'];
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) throw new Error('The snapshot has missing or unknown top-level fields.');
  if (snapshot.format !== 'zenenergies-sqlite-json' || snapshot.formatVersion !== 1) throw new Error('The backup format or format version is unsupported.');
  if (!Number.isInteger(snapshot.schemaVersion) || Number(snapshot.schemaVersion) < 1) throw new Error('The snapshot schema version is invalid.');
  if (typeof snapshot.exportedAt !== 'string' || Number.isNaN(Date.parse(snapshot.exportedAt))) throw new Error('The snapshot export date is invalid.');
  if (!snapshot.tables || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) throw new Error('The snapshot tables section is invalid.');
  if (Object.keys(snapshot.tables).length === 0) throw new Error('The snapshot does not contain any tables.');
  for (const [name, table] of Object.entries(snapshot.tables)) {
    if (!table || typeof table !== 'object' || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error(`Snapshot table ${name} is malformed.`);
  }
  if (typeof snapshot.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(snapshot.checksum)) throw new Error('The snapshot checksum is missing or malformed.');
  return snapshot as BackupSnapshot;
}

export default function BackupRestorePage() {
  useDocumentTitle('Backup & Restore');
  const { logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [snapshot, setSnapshot] = useState<BackupSnapshot | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [clearResult, setClearResult] = useState<ClearOperationalResponse | null>(null);
  const [submitting, submit] = useSubmitGuard();

  const downloadBackup = async () => {
    setDownloading(true);
    try { await download('/admin/backup', `zenenergies-backup-${new Date().toISOString().slice(0, 10)}.json`); toast.success('Authenticated backup download started.'); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The backup could not be downloaded.'); }
    finally { setDownloading(false); }
  };
  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setFileError(null); setSnapshot(null); setFileName(''); setFileSize(0);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setFileError('The selected file exceeds the 25 MB restore request limit.'); return; }
    if (!file.name.toLowerCase().endsWith('.json')) { setFileError('Choose a JSON backup file.'); return; }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const valid = validateSnapshot(parsed);
      const tables: BackupSnapshot['tables'] = valid.tables;
      const rowCount = Object.values(tables).reduce((sum, table) => sum + table.rows.length, 0);
      setSnapshot(valid); setFileName(file.name); setFileSize(file.size);
      toast.success(`Valid ZENENERGIES snapshot loaded with ${formatNumber(rowCount)} rows.`);
    } catch (error) { setFileError(error instanceof Error ? error.message : 'The selected file is not a valid snapshot.'); }
  };
  const restore = () => {
    if (!snapshot) return;
    void submit(async () => {
      try {
        await request<{ restored: true; schemaVersion: number }>('/admin/restore', { method: 'POST', body: { snapshot } });
        setRestoreOpen(false);
        logout('Backup restored successfully. Sign in again to continue with the restored station data.');
        queryClient.clear();
        navigate('/login', { replace: true });
        window.location.reload();
      } catch (error) { toast.error(error instanceof Error ? error.message : 'The backup could not be restored.'); }
    });
  };
  const clearData = () => {
    void submit(async () => {
      try {
        const result = await request<ClearOperationalResponse>('/admin/clear-operational-data', { method: 'POST', body: { confirmation: 'CLEAR OPERATIONAL DATA' } });
        setClearOpen(false); setClearResult(result); queryClient.invalidateQueries(); toast.success('Operational data cleared. Users, settings, and audit history were preserved.');
      } catch (error) { toast.error(error instanceof Error ? error.message : 'Operational data could not be cleared.'); }
    });
  };
  const rowCount = snapshot ? Object.values(snapshot.tables).reduce((sum, table) => sum + table.rows.length, 0) : 0;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Backup & Restore" description="Admin-only snapshot management. Backups contain sensitive user and operational records." />

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <SectionCard title="Download snapshot" description="A complete authenticated JSON snapshot is generated by the server.">
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-brand-300 bg-brand-50/60 p-8 text-center dark:border-brand-800 dark:bg-brand-950/20">
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-700 text-white"><DatabaseBackup className="h-8 w-8" /></span>
            <h3 className="mt-5 text-lg font-black text-slate-950 dark:text-white">ZENENERGIES SQLite JSON</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">Includes all allowlisted tables, schema metadata, row values, and a server checksum. Store the file in a protected location.</p>
            <Button className="mt-5" loading={downloading} onClick={() => void downloadBackup()} leftIcon={<Download className="h-4 w-4" />}>Download authenticated backup</Button>
          </div>
          <div className="mt-4"><InlineAlert tone="warning" title="Sensitive snapshot" icon={ShieldAlert}>Snapshots include password hashes and security history. Never email an unencrypted backup or store it in a public location.</InlineAlert></div>
        </SectionCard>

        <SectionCard title="Restore snapshot" description="The server validates format, schema, checksum, relationships, inventory, and active administrators.">
          <label htmlFor="backup-file" className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-200">Backup JSON file <span className="text-red-600">*</span></label>
          <div className="rounded-2xl border-2 border-dashed border-slate-300 p-5 text-center dark:border-slate-700">
            <FileJson className="mx-auto h-9 w-9 text-slate-400" />
            <p className="mt-3 text-sm font-bold text-slate-800 dark:text-slate-100">{fileName || 'Choose a ZENENERGIES backup'}</p>
            <p className="mt-1 text-xs text-slate-500">{fileName ? `${formatNumber(fileSize)} bytes` : 'Maximum 25 MB · .json only'}</p>
            <Input ref={fileInput} id="backup-file" type="file" accept="application/json,.json" onChange={(event) => void selectFile(event)} className="mx-auto mt-4 max-w-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-700 file:px-3 file:py-2 file:text-sm file:font-bold file:text-white" />
          </div>
          {fileError && <div className="mt-4"><InlineAlert tone="danger" title="File rejected">{fileError}</InlineAlert></div>}
          {snapshot && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
            <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /><div><p className="font-bold text-emerald-900 dark:text-emerald-100">Client structure validation passed</p><p className="mt-1 text-xs leading-5 text-emerald-700 dark:text-emerald-300">Schema {snapshot.schemaVersion} · exported {formatDateTime(snapshot.exportedAt)} · {Object.keys(snapshot.tables).length} tables · {formatNumber(rowCount)} rows. Server checksum validation still applies.</p></div></div>
            <Button className="mt-4 w-full" variant="warning" disabled={!snapshot} onClick={() => setRestoreOpen(true)} leftIcon={<Upload className="h-4 w-4" />}>Review and restore</Button>
          </div>}
        </SectionCard>
      </div>

      <SectionCard className="mt-6 border-red-300 dark:border-red-950" title="Clear operational data" description="An isolated destructive action that does not download or replace a backup.">
        <div className="flex flex-col justify-between gap-5 rounded-2xl border border-red-200 bg-red-50 p-5 sm:flex-row sm:items-center dark:border-red-950 dark:bg-red-950/30">
          <div className="flex gap-3"><AlertOctagon className="mt-0.5 h-6 w-6 shrink-0 text-red-600" /><div><p className="font-black text-red-950 dark:text-red-100">Removes shifts, sales, readings, expenses, restocks, adjustments, and inventory movements</p><p className="mt-1 text-sm leading-6 text-red-700 dark:text-red-300">Users, settings, audit logs, fuel definitions, prices, and pump configuration are preserved. Stock resets to zero.</p></div></div>
          <Button variant="danger" className="shrink-0" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => { setClearResult(null); setClearOpen(true); }}>Clear operational data</Button>
        </div>
        {clearResult && <div className="mt-4"><InlineAlert tone="success" title="Clear operation completed">Excluded: {clearResult.excluded.join(', ')}. Deleted row counts: {Object.entries(clearResult.counts).map(([table, count]) => `${table} ${formatNumber(count)}`).join(' · ')}.</InlineAlert></div>}
      </SectionCard>

      <ConfirmDialog open={restoreOpen} onClose={() => !submitting && setRestoreOpen(false)} title="Restore this entire station database?" confirmationText="RESTORE SNAPSHOT" confirmLabel="Restore snapshot" variant="danger" loading={submitting} message={<div><p>Every current operational table will be replaced inside one server transaction. If any validation or integrity check fails, the restore is rolled back.</p><p className="mt-2 font-bold">You will be signed out and the interface will reload after success.</p></div>} onConfirm={restore}>
        {snapshot && <div className="space-y-3 text-sm"><div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><p className="font-bold">{fileName}</p><p className="mt-1 text-xs text-slate-500">Exported {formatDateTime(snapshot.exportedAt)} · schema {snapshot.schemaVersion}</p></div><p className="text-slate-500">Server schema compatibility, administrator session identity, password records, checksums, and inventory relationships will be validated before replacement.</p></div>}
      </ConfirmDialog>

      <ConfirmDialog open={clearOpen} onClose={() => !submitting && setClearOpen(false)} title="Clear all operational data?" confirmationText="CLEAR OPERATIONAL DATA" confirmLabel="Clear operational data" variant="danger" loading={submitting} message="This permanently removes station operations and resets inventory to zero. Users, settings, audit logs, fuel definitions, prices, and pumps remain. There is no server rollback after a successful response." onConfirm={clearData} />
    </div>
  );
}
