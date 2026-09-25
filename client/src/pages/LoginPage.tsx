import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, EyeOff, Fuel, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Form';
import { InlineAlert, PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { handleEnterToNext, useSubmitGuard } from '@/lib/hooks';
import { firstError, requiredText } from '@/lib/validation';
import type { Role } from '@/types/api';

export default function LoginPage() {
  const { login, user, status, notice, dismissNotice } = useAuth();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('attendant');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ username?: string | null; password?: string | null; form?: string | null }>({});
  const [submitting, submit] = useSubmitGuard();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user?.mustChangePassword) navigate('/settings', { replace: true });
  }, [navigate, user?.mustChangePassword]);

  if (status === 'loading') return <div className="min-h-screen bg-slate-50 dark:bg-slate-950"><PageLoader label="Checking your secure session…" /></div>;
  if (user) return <Navigate to={user.mustChangePassword ? '/settings' : '/dashboard'} replace />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = {
      username: requiredText(username, 'Username', 32),
      password: requiredText(password, 'Password', 128),
    };
    setErrors(nextErrors);
    if (firstError(nextErrors.username, nextErrors.password)) return;
    dismissNotice();
    void submit(async () => {
      try {
        const loggedIn = await login(username, password, role);
        toast.success(`Welcome, ${loggedIn.fullName.split(/\s+/)[0] || loggedIn.fullName}.`);
        const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
        navigate(loggedIn.mustChangePassword ? '/settings' : from || '/dashboard', { replace: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sign in failed. Please try again.';
        setErrors({ form: message });
        toast.error(message);
      }
    });
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(39,170,121,0.28),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(245,118,24,0.2),transparent_34%)]" />
      <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px)', backgroundSize: '38px 38px' }} />
      <div className="relative mx-auto grid min-h-screen max-w-7xl lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden flex-col justify-between p-12 lg:flex xl:p-16">
          <div className="flex items-center gap-3 text-white">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600"><Fuel className="h-6 w-6" /></span>
            <div><p className="text-xl font-black tracking-[0.1em]">ZENENERGIES</p><p className="text-[10px] font-bold uppercase tracking-[0.28em] text-brand-200">Station Operations</p></div>
          </div>
          <div className="max-w-xl">
            <p className="mb-5 inline-flex rounded-full border border-brand-400/30 bg-brand-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-brand-200">Secure station control</p>
            <h1 className="text-5xl font-black leading-[1.08] tracking-tight text-white xl:text-6xl">Every litre.<br /><span className="text-brand-300">Every payment.</span><br />Accounted for.</h1>
            <p className="mt-7 max-w-lg text-lg leading-8 text-slate-300">One dependable workspace for fuel inventory, shifts, sales, readings, expenses, and accountable station management.</p>
          </div>
          <p className="text-xs text-slate-500">Protected role-based access · Kenyan shillings · Server-calculated totals</p>
        </section>

        <section className="flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-md">
            <div className="mb-8 flex items-center gap-3 text-white lg:hidden">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600"><Fuel className="h-5 w-5" /></span>
              <div><p className="font-black tracking-[0.1em]">ZENENERGIES</p><p className="text-[9px] uppercase tracking-[0.2em] text-brand-200">Station Operations</p></div>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white p-6 shadow-2xl sm:p-8 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-7">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700 dark:text-brand-300">{settings.stationName}</p>
                <h2 className="mt-2 text-2xl font-extrabold text-slate-950 dark:text-white">Sign in to operations</h2>
                <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">Select the role that matches your station account.</p>
              </div>

              {notice && <div className="mb-5"><InlineAlert tone="info">{notice}</InlineAlert></div>}
              {errors.form && <div className="mb-5"><InlineAlert tone="danger" title="Sign in unsuccessful">{errors.form}</InlineAlert></div>}

              <form onSubmit={onSubmit} className="space-y-5" noValidate>
                <fieldset>
                  <legend className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Your role</legend>
                  <div className="grid grid-cols-2 gap-3">
                    {(['attendant', 'admin'] as const).map((value) => {
                      const selected = role === value;
                      const Icon = value === 'admin' ? ShieldCheck : UserRound;
                      return (
                        <label key={value} className={`relative flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-brand-500 ${selected ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50' : 'border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}>
                          <input type="radio" name="role" value={value} checked={selected} onChange={() => setRole(value)} className="sr-only" />
                          <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${selected ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}><Icon className="h-4 w-4" /></span>
                          <span><span className="block text-sm font-bold capitalize text-slate-900 dark:text-white">{value}</span><span className="text-[11px] text-slate-500 dark:text-slate-400">{value === 'admin' ? 'Full access' : 'Front-line access'}</span></span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <Field id="login-username" label="Username" required error={errors.username}>
                  <Input ref={usernameRef} id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} onKeyDown={(event) => handleEnterToNext(event, passwordRef)} enterKeyHint="next" autoComplete="username" maxLength={32} placeholder="Enter your username" invalid={Boolean(errors.username)} autoFocus />
                </Field>
                <Field id="login-password" label="Password" required error={errors.password}>
                  <div className="relative">
                    <Input ref={passwordRef} id="login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} enterKeyHint="go" autoComplete="current-password" maxLength={128} placeholder="Enter your password" invalid={Boolean(errors.password)} className="pr-11" />
                    <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-inset focus-visible:ring-brand-500 dark:hover:text-white" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </Field>

                <Button type="submit" size="lg" className="w-full" loading={submitting} leftIcon={<LockKeyhole className="h-4 w-4" />}>Sign in securely</Button>
              </form>
              <p className="mt-6 text-center text-xs leading-5 text-slate-500 dark:text-slate-400">Access is logged. Contact your station administrator if your account is unavailable.</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
