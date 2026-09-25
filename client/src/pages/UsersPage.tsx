import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, KeyRound, LogOut, Search, ShieldCheck, UserCheck, UserPlus, UserX } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Badge, DataTable, PageHeader, Pagination, SectionCard, type Column } from '@/components/ui/DataDisplay';
import { Checkbox, Field, Input, Select } from '@/components/ui/Form';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { InlineAlert } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { buildQuery, request } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { focusField, handleEnterToNext, useDebouncedValue, useDocumentTitle, useSubmitGuard } from '@/lib/hooks';
import { firstError, passwordError, requiredText, usernameError } from '@/lib/validation';
import type { Paginated, Role, User } from '@/types/api';

interface UserResponse { user: User }
interface UserForm { username: string; fullName: string; role: Role; password: string; mustChangePassword: boolean }

const emptyForm: UserForm = { username: '', fullName: '', role: 'attendant', password: '', mustChangePassword: true };

export default function UsersPage() {
  useDocumentTitle('Users');
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [role, setRole] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [terminateTarget, setTerminateTarget] = useState<User | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [submitting, submit] = useSubmitGuard();
  const [resetSubmitting, runReset] = useSubmitGuard();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const fullNameRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const filters = { search: debouncedSearch.trim() || undefined, role: role || undefined, isActive: active || undefined, page, pageSize };
  const users = useQuery({ queryKey: ['users', filters], queryFn: () => request<Paginated<User>>(`/users${buildQuery(filters)}`), placeholderData: (previous) => previous });
  useEffect(() => {
    if (!formOpen) return;
    const timer = window.setTimeout(() => focusField(editing ? fullNameRef : usernameRef, true), 80);
    return () => window.clearTimeout(timer);
  }, [editing?.id, formOpen]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => request<UserResponse>(editing ? `/users/${editing.id}` : '/users', { method: editing ? 'PATCH' : 'POST', body }),
    onSuccess: () => { setFormOpen(false); toast.success(editing ? 'User updated.' : 'User created.'); window.setTimeout(() => focusField(createButtonRef), 0); void queryClient.invalidateQueries({ queryKey: ['users'] }); },
  });
  const resetPassword = useMutation({
    mutationFn: () => request<UserResponse & { sessionsTerminated: boolean }>(`/users/${resetTarget?.id}/reset-password`, { method: 'POST', body: { newPassword } }),
    onSuccess: () => { setResetTarget(null); setNewPassword(''); toast.success('Password reset. Existing sessions were terminated.'); void queryClient.invalidateQueries({ queryKey: ['users'] }); },
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setFormError(null); setFormOpen(true); };
  const openEdit = (user: User) => { setEditing(user); setForm({ username: user.username, fullName: user.fullName, role: user.role, password: '', mustChangePassword: user.mustChangePassword }); setFormError(null); setFormOpen(true); };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const validation = firstError(editing ? null : usernameError(form.username), requiredText(form.fullName, 'Full name', 100), editing ? null : passwordError(form.password, 'Initial password'));
    if (validation) { setFormError(validation); return; }
    const body: Record<string, unknown> = editing ? { fullName: form.fullName.trim(), role: form.role, mustChangePassword: form.mustChangePassword } : { username: form.username.trim(), fullName: form.fullName.trim(), role: form.role, password: form.password, mustChangePassword: form.mustChangePassword };
    void submit(async () => { save.reset(); try { await save.mutateAsync(body); } catch (error) { setFormError(error instanceof Error ? error.message : 'The user could not be saved.'); } });
  };
  const onResetSubmit = (event: FormEvent) => {
    event.preventDefault(); const validation = passwordError(newPassword, 'New password'); if (validation) { toast.error(validation); return; }
    void runReset(async () => { resetPassword.reset(); try { await resetPassword.mutateAsync(); } catch (error) { toast.error(error instanceof Error ? error.message : 'The password could not be reset.'); } });
  };
  const terminate = async () => {
    if (!terminateTarget) return; setActionLoading(true);
    try { await request(`/users/${terminateTarget.id}/terminate`, { method: 'POST' }); toast.success(`Sessions terminated for ${terminateTarget.fullName}.`); setTerminateTarget(null); await queryClient.invalidateQueries({ queryKey: ['users'] }); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Sessions could not be terminated.'); } finally { setActionLoading(false); }
  };
  const deactivate = async () => {
    if (!deactivateTarget) return; setActionLoading(true);
    try { await request(`/users/${deactivateTarget.id}`, { method: 'DELETE' }); toast.success(`${deactivateTarget.fullName} deactivated. History is preserved.`); setDeactivateTarget(null); await queryClient.invalidateQueries({ queryKey: ['users'] }); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The user could not be deactivated.'); } finally { setActionLoading(false); }
  };
  const reactivate = async (user: User) => {
    try { await request(`/users/${user.id}`, { method: 'PATCH', body: { isActive: true } }); toast.success(`${user.fullName} reactivated.`); await queryClient.invalidateQueries({ queryKey: ['users'] }); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'The user could not be reactivated.'); }
  };

  const columns: Array<Column<User>> = [
    { key: 'user', header: 'User', render: (item) => <span><span className="font-bold">{item.fullName}{item.id === currentUser?.id && <span className="ml-2 text-xs text-brand-600">You</span>}</span><span className="block text-xs text-slate-500">@{item.username}</span></span> },
    { key: 'role', header: 'Role', render: (item) => <Badge tone={item.role === 'admin' ? 'violet' : 'blue'}>{item.role}</Badge> },
    { key: 'status', header: 'Status', render: (item) => <div className="flex flex-wrap gap-1"><Badge tone={item.isActive ? 'green' : 'red'}>{item.isActive ? 'Active' : 'Inactive'}</Badge>{item.mustChangePassword && <Badge tone="amber">Password change due</Badge>}</div> },
    { key: 'lastLogin', header: 'Last login', render: (item) => <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(item.lastLoginAt)}</span> },
    { key: 'actions', header: 'Actions', render: (item) => <div className="flex flex-wrap justify-end gap-1"><Button variant="ghost" size="sm" className="px-2" onClick={() => openEdit(item)} aria-label={`Edit ${item.fullName}`}><Edit3 className="h-4 w-4" /></Button><Button variant="ghost" size="sm" className="px-2" onClick={() => setResetTarget(item)} aria-label={`Reset password for ${item.fullName}`}><KeyRound className="h-4 w-4" /></Button><Button variant="ghost" size="sm" className="px-2" onClick={() => setTerminateTarget(item)} aria-label={`Terminate sessions for ${item.fullName}`}><LogOut className="h-4 w-4" /></Button>{item.isActive && item.id !== currentUser?.id ? <Button variant="ghost" size="sm" className="px-2 text-red-600" onClick={() => setDeactivateTarget(item)} aria-label={`Deactivate ${item.fullName}`}><UserX className="h-4 w-4" /></Button> : !item.isActive ? <Button variant="ghost" size="sm" className="px-2 text-emerald-600" onClick={() => void reactivate(item)} aria-label={`Reactivate ${item.fullName}`}><UserCheck className="h-4 w-4" /></Button> : null}</div> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader title="Users" description="Admin-only account, role, activation, password reset, and session controls." actions={<Button ref={createButtonRef} onClick={openCreate} leftIcon={<UserPlus className="h-4 w-4" />}>Create user</Button>} />
      <div className="mb-6"><InlineAlert tone="info" title="Credential safety" icon={ShieldCheck}>The API returns safe user profiles only. Password hashes are never requested or displayed, and password fields are never persisted by this client.</InlineAlert></div>

      <SectionCard className="mb-6" title="Find users" description="Search and filters run on the server.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_0.5fr_0.5fr_auto]">
          <Field id="user-search" label="Search"><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input id="user-search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="pl-9" placeholder="Username or full name" maxLength={100} /></div></Field>
          <Field id="user-role" label="Role"><Select id="user-role" value={role} placeholder="All roles" options={[{ value: 'admin', label: 'Administrator' }, { value: 'attendant', label: 'Attendant' }]} onChange={(event) => { setRole(event.target.value); setPage(1); }} /></Field>
          <Field id="user-active" label="Account status"><Select id="user-active" value={active} placeholder="All statuses" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} onChange={(event) => { setActive(event.target.value); setPage(1); }} /></Field>
          <div className="flex items-end"><Button variant="secondary" onClick={() => { setPage(1); void users.refetch(); }}>Apply</Button></div>
        </div>
      </SectionCard>

      <SectionCard title="Station users" description="Deactivation preserves historical sales, shifts, and expenses." padded={false}>
        <DataTable columns={columns} data={users.data?.data || []} getRowKey={(item) => item.id} loading={users.isLoading} emptyTitle="No users found" emptyMessage="No accounts match the selected filters." caption="Station user accounts" renderMobile={(item) => <div className="p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{item.fullName}</p><p className="text-xs text-slate-500">@{item.username} · {item.role}</p></div><Badge tone={item.isActive ? 'green' : 'red'}>{item.isActive ? 'Active' : 'Inactive'}</Badge></div><p className="mt-2 text-xs text-slate-500">Last login: {formatDateTime(item.lastLoginAt)}</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => openEdit(item)}>Edit</Button><Button size="sm" variant="secondary" onClick={() => setResetTarget(item)}>Reset password</Button><Button size="sm" variant="secondary" onClick={() => setTerminateTarget(item)}>Terminate sessions</Button>{!item.isActive && <Button size="sm" variant="secondary" onClick={() => void reactivate(item)}>Reactivate</Button>}</div></div>} />
        {users.data && <Pagination pagination={users.data.pagination} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
      </SectionCard>

      <Modal open={formOpen} onClose={() => !submitting && setFormOpen(false)} title={editing ? `Edit ${editing.fullName}` : 'Create station user'} description={editing ? 'Role or status changes terminate old sessions on the server.' : 'The new user signs in using the selected role.'} footer={<><Button variant="secondary" disabled={submitting} onClick={() => setFormOpen(false)}>Cancel</Button><Button disabled={submitting} loading={submitting} onClick={() => document.getElementById('user-form-submit')?.click()}>{editing ? 'Save user' : 'Create user'}</Button></>}>
        <form id="user-form" onSubmit={onSubmit} noValidate className="space-y-4"><button id="user-form-submit" type="submit" className="hidden" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="user-form-username" label="Username" required hint={editing ? 'Usernames cannot be changed' : '3–32 letters, numbers, dots, underscores, or hyphens'}><Input ref={usernameRef} id="user-form-username" value={form.username} onChange={(event) => setForm((value) => ({ ...value, username: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, fullNameRef)} enterKeyHint="next" disabled={Boolean(editing)} maxLength={32} autoComplete="off" /></Field>
            <Field id="user-form-fullname" label="Full name" required><Input ref={fullNameRef} id="user-form-fullname" value={form.fullName} onChange={(event) => setForm((value) => ({ ...value, fullName: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, roleRef)} enterKeyHint="next" maxLength={100} autoComplete="name" /></Field>
            <Field id="user-form-role" label="Role" required><Select ref={roleRef} id="user-form-role" value={form.role} options={[{ value: 'admin', label: 'Administrator' }, { value: 'attendant', label: 'Attendant' }]} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as Role }))} onKeyDown={(event) => handleEnterToNext(event, editing ? undefined : passwordRef, () => event.currentTarget.form?.requestSubmit())} enterKeyHint={editing ? 'done' : 'next'} /></Field>
            {!editing && <Field id="user-form-password" label="Initial password" required hint="At least 12 characters with upper/lower case, number, and symbol"><Input ref={passwordRef} id="user-form-password" type="password" value={form.password} onChange={(event) => setForm((value) => ({ ...value, password: event.target.value }))} onKeyDown={(event) => handleEnterToNext(event, undefined, () => event.currentTarget.form?.requestSubmit())} enterKeyHint="done" maxLength={128} autoComplete="new-password" /></Field>}
          </div>
          <Checkbox id="user-must-change" label="Require password change" description="The account receives a must-change flag; the server remains the authority." checked={form.mustChangePassword} onChange={(event) => setForm((value) => ({ ...value, mustChangePassword: event.target.checked }))} />
          {editing?.id === currentUser?.id && <InlineAlert tone="warning">The backend prevents you from removing your own administrator role or deactivating your own account.</InlineAlert>}
          {formError && <InlineAlert tone="danger">{formError}</InlineAlert>}
        </form>
      </Modal>

      <Modal open={Boolean(resetTarget)} onClose={() => !resetSubmitting && setResetTarget(null)} title={`Reset password for ${resetTarget?.fullName || 'user'}`} description="This immediately invalidates every existing session for the account." footer={<><Button variant="secondary" disabled={resetSubmitting} onClick={() => setResetTarget(null)}>Cancel</Button><Button disabled={resetSubmitting} loading={resetSubmitting} onClick={() => document.getElementById('reset-password-submit')?.click()}>Reset password</Button></>}>
        <form id="reset-password-form" onSubmit={onResetSubmit} className="space-y-4"><button id="reset-password-submit" type="submit" className="hidden" /><Field id="reset-password" label="New password" required hint="At least 12 characters with upper/lower case, number, and symbol"><Input id="reset-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} maxLength={128} autoComplete="new-password" autoFocus /></Field><InlineAlert tone="warning" title="Share the password securely">The password is sent directly to the API and is never stored in browser storage.</InlineAlert></form>
      </Modal>

      <ConfirmDialog open={Boolean(terminateTarget)} title={`Terminate ${terminateTarget?.fullName || ''}'s sessions?`} message="All current and future requests using the previous session token will be rejected. The account and history remain unchanged." confirmLabel="Terminate sessions" variant="warning" loading={actionLoading} onConfirm={() => void terminate()} onClose={() => !actionLoading && setTerminateTarget(null)} />
      <ConfirmDialog open={Boolean(deactivateTarget)} title={`Deactivate ${deactivateTarget?.fullName || ''}?`} message="The account will be signed out and unable to log in. Operational history is preserved and an administrator can reactivate it later." confirmLabel="Deactivate user" loading={actionLoading} onConfirm={() => void deactivate()} onClose={() => !actionLoading && setDeactivateTarget(null)} />
    </div>
  );
}
