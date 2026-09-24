import { Link } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PageHeader, SectionCard } from '@/components/ui/DataDisplay';

export default function ForbiddenPage() {
  return <div className="animate-fade-in"><PageHeader title="Administrator access required" description="This route is not available for your account role." /><SectionCard><div className="flex min-h-72 flex-col items-center justify-center text-center"><span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-red-600 dark:bg-red-950"><ShieldX className="h-7 w-7" /></span><h2 className="mt-4 text-xl font-black text-slate-950 dark:text-white">Protected station area</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">The frontend blocked this navigation, and the backend independently enforces administrator authorization.</p><Link to="/dashboard" className="mt-5"><Button>Return to dashboard</Button></Link></div></SectionCard></div>;
}
