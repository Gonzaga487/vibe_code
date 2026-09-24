import { Link } from 'react-router-dom';
import { MapPinOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export default function NotFoundPage() {
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950"><div className="max-w-md text-center"><span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800"><MapPinOff className="h-8 w-8" /></span><p className="mt-6 text-sm font-black uppercase tracking-[0.2em] text-brand-700 dark:text-brand-300">404</p><h1 className="mt-2 text-3xl font-black text-slate-950 dark:text-white">This station route does not exist</h1><p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">The address may be outdated or mistyped. Return to your dashboard to continue.</p><Link to="/dashboard" className="mt-6 inline-block"><Button>Return to dashboard</Button></Link></div></main>;
}
