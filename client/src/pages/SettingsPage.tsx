import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Database, Gauge, KeyRound, Monitor, Moon, RefreshCw, Server, Settings2, ShieldCheck, Sun } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageHeader, SectionCard, StatCard, Tabs } from '@/components/ui/DataDisplay';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { ErrorState, InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { request } from '@/lib/api';
import { formatKsh, formatNumber } from '@/lib/format';
import { focusField, handleEnterToNext, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { firstError, nonNegativeNumber, passwordError, requiredText } from '@/lib/validation';
import type { DateFormat, PlatformMetrics, Settings, Theme } from '@/types/api';

type Tab = 'account' | 'interface' | 'station' | 'platform';
interface StationForm {
  stationName: string;
  timezone: string;
  dateFormat: DateFormat;
  language: 'en' | 'sw';
  lowStockThresholdLitres: string;
  auditRetentionDays: string;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default function SettingsPage() {
  useDocumentTitle('Settings');
  const { user, isAdmin, updatePassword } = useAuth();
  const { settings, interfaceOptions, setInterfacePreferences, applyServerSettings } = useSettings();
  const [tab, setTab] = useState<Tab>(user?.mustChangePassword ? 'account' : 'interface');
  const applied = useRef(false);
  const settingsQuery = useQuery({ queryKey: ['settings', user?.role || 'user'], queryFn: () => request<{ settings: Settings }>('/settings') });
  const metrics = useQuery({ queryKey: ['admin', 'metrics'], queryFn: () => request<{ metrics: PlatformMetrics }>('/admin/metrics'), enabled: isAdmin });
  const [stationForm, setStationForm] = useState<StationForm>({ stationName: '', timezone: '', dateFormat: 'yyyy-MM-dd', language: 'en', lowStockThresholdLitres: '', auditRetentionDays: '' });
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordErrorText, setPasswordErrorText] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [passwordSubmitting, submitPassword] = useSubmitGuard();
  const [stationSubmitting, submitStation] = useSubmitGuard();
  const [interfaceSaving, setInterfaceSaving] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (applied.current || !settingsQuery.data) return;
    const server = settingsQuery.data.settings;
    applyServerSettings(server);
    setStationForm({ stationName: server.stationName, timezone: server.timezone, dateFormat: server.dateFormat, language: server.language, lowStockThresholdLitres: String(server.lowStockThresholdLitres ?? 0), auditRetentionDays: String(server.auditRetentionDays ?? 365) });
    applied.current = true;
  }, [applyServerSettings, settingsQuery.data]);

  useEffect(() => {
    if (!user?.mustChangePassword) return;
    const timer = window.setTimeout(() => focusField(currentPasswordRef, true), 100);
    return () => window.clearTimeout(timer);
  }, [user?.mustChangePassword]);

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(requiredText(currentPassword, 'Current password', 128), passwordError(newPassword, 'New password'), newPassword !== confirmPassword ? 'New password confirmation does not match.' : null);
    setPasswordErrorText(validation); if (validation) return;
    void submitPassword(async () => {
      try { await updatePassword(currentPassword, newPassword, confirmPassword); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); toast.success('Password changed. Your new session is active.'); }
      catch (error) { const message = error instanceof Error ? error.message : 'The password could not be changed.'; setPasswordErrorText(message); toast.error(message); }
    });
  };

  const saveStation = (event: FormEvent) => {
    event.preventDefault();
    let timezoneValid = true;
    try { new Intl.DateTimeFormat('en', { timeZone: stationForm.timezone }).format(); } catch { timezoneValid = false; }
    const thresholdError = nonNegativeNumber(stationForm.lowStockThresholdLitres, 'Low-stock threshold');
    const retentionNumber = Number(stationForm.auditRetentionDays);
    const validation = firstError(requiredText(stationForm.stationName, 'Station name', 100), timezoneValid ? null : 'Enter a valid IANA timezone, for example Africa/Nairobi.', thresholdError, Number.isInteger(retentionNumber) && retentionNumber >= 30 && retentionNumber <= 3650 ? null : 'Audit retention must be between 30 and 3650 days.');
    setStationError(validation); if (validation) return;
    void submitStation(async () => {
      try {
        const response = await request<{ settings: Settings }>('/settings', { method: 'PATCH', body: { stationName: stationForm.stationName.trim(), timezone: stationForm.timezone.trim(), dateFormat: stationForm.dateFormat, language: stationForm.language, lowStockThresholdLitres: Number(stationForm.lowStockThresholdLitres), auditRetentionDays: retentionNumber } });
        applyServerSettings(response.settings); toast.success('Station settings updated.'); void metrics.refetch();
      } catch (error) { const message = error instanceof Error ? error.message : 'Station settings could not be saved.'; setStationError(message); toast.error(message); }
    });
  };

  const saveInterfaceToStation = async () => {
    setInterfaceSaving(true);
    try { const response = await request<{ settings: Settings }>('/settings', { method: 'PATCH', body: { interfaceOptions } }); applyServerSettings(response.settings); toast.success('Interface defaults saved for station users.'); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Interface defaults could not be saved.'); }
    finally { setInterfaceSaving(false); }
  };

  if (settingsQuery.isLoading) return <PageLoader label="Loading account and station settings…" />;
  if (settingsQuery.error) return <ErrorState message={settingsQuery.error instanceof Error ? settingsQuery.error.message : 'Settings could not be loaded.'} onRetry={() => void settingsQuery.refetch()} />;

  const platform = metrics.data?.metrics;
  const tabs = [{ value: 'account' as const, label: 'My account' }, { value: 'interface' as const, label: 'Appearance' }, ...(isAdmin ? [{ value: 'station' as const, label: 'Station settings' }, { value: 'platform' as const, label: 'Platform metrics' }] : [])];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" description={isAdmin ? 'Manage your account, interface defaults, and station-wide configuration.' : 'Manage your account and local interface preferences.'} />
      {user?.mustChangePassword && <div className="mb-6"><InlineAlert tone="warning" title="Password change required" icon={KeyRound}>Your account is flagged for a password change. Set a new private password in My account before continuing normal station work.</InlineAlert></div>}

      <Tabs label="Settings sections" value={tab} onChange={setTab} tabs={tabs} />

      <div className="mt-6">
        {tab === 'account' && <div className="grid items-start gap-6 xl:grid-cols-[0.8fr_1.2fr]">
          <SectionCard title="Account profile" description="Read-only identity supplied by the server.">
            <div className="flex items-center gap-4"><span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-100 text-lg font-black text-brand-800 dark:bg-brand-950 dark:text-brand-200">{user?.fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span><div><p className="font-black text-slate-950 dark:text-white">{user?.fullName}</p><p className="text-sm text-slate-500">@{user?.username} · <span className="capitalize">{user?.role}</span></p></div></div>
            <dl className="mt-6 divide-y divide-slate-100 text-sm dark:divide-slate-800">{[['Status', user?.isActive ? 'Active' : 'Inactive'], ['Role', user?.role || '—'], ['Password change', user?.mustChangePassword ? 'Required' : 'Up to date'], ['Last login', user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'No previous login']].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-3"><dt className="text-slate-500 dark:text-slate-400">{label}</dt><dd className="text-right font-bold capitalize text-slate-900 dark:text-white">{value}</dd></div>)}</dl>
          </SectionCard>
          <SectionCard title="Change current password" description="The server returns a replacement token after a successful change.">
            <form onSubmit={changePassword} noValidate className="space-y-4">
              <Field id="current-password" label="Current password" required><Input ref={currentPasswordRef} id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} onKeyDown={(event) => handleEnterToNext(event, newPasswordRef)} enterKeyHint="next" autoComplete="current-password" maxLength={128} invalid={Boolean(passwordErrorText)} /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field id="new-password" label="New password" required hint="12+ characters, upper/lower case, number, symbol"><Input ref={newPasswordRef} id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} onKeyDown={(event) => handleEnterToNext(event, confirmPasswordRef)} enterKeyHint="next" autoComplete="new-password" maxLength={128} /></Field><Field id="confirm-password" label="Confirm new password" required><Input ref={confirmPasswordRef} id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" autoComplete="new-password" maxLength={128} /></Field></div>
              {passwordErrorText && <InlineAlert tone="danger">{passwordErrorText}</InlineAlert>}
              <Button type="submit" loading={passwordSubmitting} leftIcon={<KeyRound className="h-4 w-4" />}>Change password</Button>
            </form>
          </SectionCard>
        </div>}

        {tab === 'interface' && <div className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <SectionCard title="Appearance and interface" description="Preferences apply immediately in this browser.">
            <fieldset><legend className="text-sm font-bold text-slate-800 dark:text-slate-100">Color theme</legend><div className="mt-3 grid gap-3 sm:grid-cols-3">
              {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]] as const).map(([value, label, Icon]) => <button key={value} type="button" onClick={() => setInterfacePreferences({ ...interfaceOptions, theme: value as Theme })} aria-pressed={interfaceOptions.theme === value} className={`flex min-h-28 flex-col items-center justify-center rounded-2xl border-2 p-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${interfaceOptions.theme === value ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/40' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}><Icon className="h-6 w-6" /><span className="mt-3 font-bold">{label}</span>{interfaceOptions.theme === value && <CheckCircle2 className="mt-1 h-4 w-4 text-brand-600" />}</button>)}
            </div></fieldset>
            <div className="mt-6 space-y-4 border-t border-slate-200 pt-5 dark:border-slate-800">
              <Checkbox id="compact-tables" label="Compact tables" description="Reduce row height to fit more records on screen." checked={interfaceOptions.compactTables} onChange={(event) => setInterfacePreferences({ ...interfaceOptions, compactTables: event.target.checked })} />
              <Checkbox id="station-clock" label="Show station clock" description="Display the current station time in the application header." checked={interfaceOptions.showStationClock} onChange={(event) => setInterfacePreferences({ ...interfaceOptions, showStationClock: event.target.checked })} />
            </div>
            {isAdmin && <div className="mt-6 rounded-xl bg-slate-50 p-4 dark:bg-slate-800"><p className="text-sm font-bold">Save as station default</p><p className="mt-1 text-xs leading-5 text-slate-500">Administrators can make these interface options the default for all users. Each user can still override them locally.</p><Button className="mt-3" size="sm" loading={interfaceSaving} onClick={() => void saveInterfaceToStation()}>Save station default</Button></div>}
          </SectionCard>
          <SectionCard title="Current interface" description="Effective preferences in this tab.">
            <div className="space-y-4 text-sm">{[['Theme', interfaceOptions.theme], ['Compact tables', interfaceOptions.compactTables ? 'Enabled' : 'Disabled'], ['Station clock', interfaceOptions.showStationClock ? 'Visible' : 'Hidden'], ['Station timezone', settings.timezone], ['Date format', settings.dateFormat]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0 dark:border-slate-800"><span className="text-slate-500 dark:text-slate-400">{label}</span><span className="font-bold capitalize text-slate-900 dark:text-white">{value}</span></div>)}</div>
          </SectionCard>
        </div>}

        {tab === 'station' && isAdmin && <div className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <SectionCard title="Station-wide settings" description="Administrative changes affect all users and reporting date boundaries.">
            <form onSubmit={saveStation} noValidate className="space-y-4">
              <Field id="station-name" label="Station name" required><Input id="station-name" value={stationForm.stationName} onChange={(event) => setStationForm((value) => ({ ...value, stationName: event.target.value }))} maxLength={100} /></Field>
              <div className="grid gap-4 sm:grid-cols-2"><Field id="station-timezone" label="IANA timezone" required hint="Example: Africa/Nairobi"><Input id="station-timezone" value={stationForm.timezone} onChange={(event) => setStationForm((value) => ({ ...value, timezone: event.target.value }))} /></Field><Field id="station-date-format" label="Display date format" required><Select id="station-date-format" value={stationForm.dateFormat} options={[{ value: 'yyyy-MM-dd', label: 'YYYY-MM-DD' }, { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY' }, { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY' }]} onChange={(event) => setStationForm((value) => ({ ...value, dateFormat: event.target.value as DateFormat }))} /></Field></div>
              <div className="grid gap-4 sm:grid-cols-2"><Field id="station-language" label="Language preference"><Select id="station-language" value={stationForm.language} options={[{ value: 'en', label: 'English' }, { value: 'sw', label: 'Kiswahili' }]} onChange={(event) => setStationForm((value) => ({ ...value, language: event.target.value as 'en' | 'sw' }))} /></Field><Field id="low-stock-threshold" label="Low-stock threshold" required hint="Litres"><Input id="low-stock-threshold" type="number" min="0" step="0.001" value={stationForm.lowStockThresholdLitres} onChange={(event) => setStationForm((value) => ({ ...value, lowStockThresholdLitres: event.target.value }))} /></Field></div>
              <Field id="audit-retention" label="Default audit retention" required hint="30–3650 days; the audit page can wipe using a different typed retention"><Input id="audit-retention" type="number" min="30" max="3650" step="1" value={stationForm.auditRetentionDays} onChange={(event) => setStationForm((value) => ({ ...value, auditRetentionDays: event.target.value }))} /></Field>
              {stationError && <InlineAlert tone="danger">{stationError}</InlineAlert>}
              <Button type="submit" loading={stationSubmitting} leftIcon={<Settings2 className="h-4 w-4" />}>Save station settings</Button>
            </form>
          </SectionCard>
          <SectionCard title="Policy summary" description="These settings are enforced by the backend.">
            <div className="space-y-4 text-sm"><div className="flex gap-3 rounded-xl bg-blue-50 p-3 dark:bg-blue-950/30"><ShieldCheck className="h-5 w-5 shrink-0 text-blue-600" /><p className="leading-6 text-blue-900 dark:text-blue-100">The station timezone controls server-side daily and monthly report boundaries.</p></div><div className="flex gap-3 rounded-xl bg-amber-50 p-3 dark:bg-amber-950/30"><Gauge className="h-5 w-5 shrink-0 text-amber-600" /><p className="leading-6 text-amber-900 dark:text-amber-100">The low-stock threshold applies to every active fuel type in dashboard and inventory alerts.</p></div><div className="flex gap-3 rounded-xl bg-violet-50 p-3 dark:bg-violet-950/30"><Activity className="h-5 w-5 shrink-0 text-violet-600" /><p className="leading-6 text-violet-900 dark:text-violet-100">Changing retention does not immediately delete audit entries. Use the explicit Audit Trail wipe control.</p></div></div>
          </SectionCard>
        </div>}

        {tab === 'platform' && isAdmin && (metrics.isLoading ? <PageLoader label="Reading platform metrics…" /> : metrics.error ? <ErrorState message={metrics.error instanceof Error ? metrics.error.message : 'Platform metrics could not be loaded.'} onRetry={() => void metrics.refetch()} /> : platform && <>
          <div className="mb-5 flex justify-end"><Button variant="secondary" size="sm" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={() => void metrics.refetch()}>Refresh metrics</Button></div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Lifetime sales" value={formatKsh(platform.operations.lifetimeSalesKsh)} detail={`${formatNumber(platform.operations.salesCount)} sales`} icon={Activity} tone="brand" />
            <StatCard label="Active users" value={formatNumber(platform.users.active)} detail={`${formatNumber(platform.users.activeAdmins)} administrators`} icon={ShieldCheck} tone="blue" />
            <StatCard label="Open shifts" value={formatNumber(platform.operations.shifts.open)} detail={`${formatNumber(platform.operations.shifts.total)} total`} icon={Server} tone="violet" />
            <StatCard label="Audit records" value={formatNumber(platform.auditLogCount)} detail="Currently retained" icon={Database} tone="amber" />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <SectionCard title="Application"><dl className="divide-y divide-slate-100 dark:divide-slate-800">{[['Environment', platform.application.environment], ['Schema version', String(platform.application.schemaVersion)], ['Process uptime', `${Math.floor(platform.application.uptimeSeconds / 3600)}h ${Math.floor((platform.application.uptimeSeconds % 3600) / 60)}m`], ['Low-stock threshold', `${formatNumber(Number(stationForm.lowStockThresholdLitres))} L`], ['Audit retention', `${formatNumber(Number(stationForm.auditRetentionDays))} days`]].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-3 text-sm"><dt className="text-slate-500">{label}</dt><dd className="font-bold">{value}</dd></div>)}</dl></SectionCard>
            <SectionCard title="Database"><dl className="divide-y divide-slate-100 dark:divide-slate-800">{[['Target', platform.database.path], ['File size', formatBytes(platform.database.bytes)], ['Integrity check', platform.database.integrity], ['Fuel types', formatNumber(platform.operations.fuel.fuelTypes)], ['Live inventory', `${formatNumber(platform.operations.fuel.litres)} L`], ['Inventory value', formatKsh(platform.operations.fuel.inventoryValueKsh)]].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-3 text-sm"><dt className="text-slate-500">{label}</dt><dd className="text-right font-bold">{value}</dd></div>)}</dl></SectionCard>
          </div>
        </>)}
      </div>
    </div>
  );
}
