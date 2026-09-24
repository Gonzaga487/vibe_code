import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-lift dark:border-red-950 dark:bg-slate-900">
          <AlertOctagon className="mx-auto h-10 w-10 text-red-600" />
          <h1 className="mt-4 text-xl font-extrabold text-slate-950 dark:text-white">The interface hit an unexpected error</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">Your records are safe. Reload the application; if the problem continues, contact the station administrator.</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-800"><RefreshCw className="h-4 w-4" />Reload</button>
        </div>
      </main>
    );
  }
}
