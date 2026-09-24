import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, Fuel, LogOut, Menu, MoreHorizontal } from 'lucide-react';
import { navigationItems, visibleNavigation, type NavigationItem } from '@/components/layout/navigation';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { useClock } from '@/lib/hooks';
import { formatTime, initials } from '@/lib/format';

const sectionLabels = { operations: 'Station operations', finance: 'Finance & reports', administration: 'Administration' };

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-sm">
        <Fuel className="h-5 w-5" aria-hidden="true" />
      </span>
      {!compact && (
        <span>
          <span className="block text-base font-black tracking-[0.08em] text-white">ZENENERGIES</span>
          <span className="block text-[10px] font-semibold uppercase tracking-[0.22em] text-brand-200">Station Operations</span>
        </span>
      )}
    </div>
  );
}

interface NavigationListProps {
  items: NavigationItem[];
  onNavigate?: () => void;
  mobile?: boolean;
}

function NavigationList({ items, onNavigate, mobile = false }: NavigationListProps) {
  const sections = useMemo(() => ['operations', 'finance', 'administration'] as const, []);
  return (
    <nav aria-label="Main navigation" className="space-y-6">
      {sections.map((section) => {
        const sectionItems = items.filter((item) => item.section === section);
        if (!sectionItems.length) return null;
        return (
          <div key={section}>
            <p className={`mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] ${mobile ? 'text-slate-400' : 'text-slate-500'}`}>{sectionLabels[section]}</p>
            <ul className="space-y-1">
              {sectionItems.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={onNavigate}
                      className={({ isActive }) => `group flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${isActive ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-300 hover:bg-white/8 hover:text-white'}`}
                    >
                      <Icon className="h-[19px] w-[19px] shrink-0" aria-hidden="true" />
                      <span>{item.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const { user, logout, notice, dismissNotice } = useAuth();
  const { settings, interfaceOptions } = useSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const now = useClock(interfaceOptions.showStationClock, settings.timezone);

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (!user) return null;
  const items = visibleNavigation(user.role);
  const primaryMobile = items.filter((item) => ['/dashboard', '/sales', '/shift', '/pump-readings'].includes(item.to)).slice(0, 4);

  const confirmLogout = () => {
    setLogoutOpen(false);
    logout('You have been signed out safely.');
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
      <a href="#main-content" className="fixed left-3 top-3 z-[120] -translate-y-20 rounded-lg bg-slate-950 px-4 py-2 text-sm font-bold text-white focus:translate-y-0">Skip to content</a>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col overflow-y-auto bg-slate-950 px-4 pb-5 pt-6 lg:flex dark:border-r dark:border-slate-800">
        <div className="px-2"><Brand /></div>
        <div className="mt-8 flex-1"><NavigationList items={items} /></div>
        <div className="mt-6 border-t border-slate-800 pt-4">
          <div className="flex items-center gap-3 px-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-800 text-xs font-black text-white">{initials(user.fullName)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-white">{user.fullName}</p>
              <p className="truncate text-xs capitalize text-slate-400">{user.role}</p>
            </div>
            <Button variant="ghost" size="sm" className="px-2 text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setLogoutOpen(true)} aria-label="Sign out"><LogOut className="h-4 w-4" /></Button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="sm" className="px-2 lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></Button>
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold text-slate-900 dark:text-white">{settings.stationName}</p>
                <p className="text-xs capitalize text-slate-500 dark:text-slate-400">{user.role} workspace</p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              {interfaceOptions.showStationClock && (
                <div className="hidden text-right sm:block">
                  <p className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100">{formatTime(now.toISOString(), settings.timezone)}</p>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{settings.timezone.replace('_', ' ')}</p>
                </div>
              )}
              {notice && (
                <button type="button" onClick={dismissNotice} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-slate-800" aria-label="Dismiss notification"><Bell className="h-5 w-5" /></button>
              )}
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-xs font-black text-brand-800 dark:bg-brand-950 dark:text-brand-200 lg:hidden">{initials(user.fullName)}</span>
            </div>
          </div>
        </header>

        {notice && (
          <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-center text-sm font-medium text-blue-900 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-100">
            <div className="mx-auto flex max-w-7xl items-center justify-center gap-3">{notice}<button className="font-bold underline" onClick={dismissNotice}>Dismiss</button></div>
          </div>
        )}

        <main id="main-content" className="mx-auto min-h-[calc(100vh-4rem)] max-w-[1600px] px-4 pb-28 pt-6 sm:px-6 sm:pt-8 lg:px-8 lg:pb-10">
          <Outlet />
        </main>
      </div>

      <nav aria-label="Mobile quick navigation" className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/95 lg:hidden">
        <div className="grid h-16 grid-cols-5">
          {primaryMobile.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-bold focus:outline-none focus-visible:ring-2 focus-inset focus-visible:ring-brand-500 ${isActive ? 'text-brand-700 dark:text-brand-300' : 'text-slate-500 dark:text-slate-400'}`}>
                <Icon className="h-5 w-5" aria-hidden="true" /><span className="truncate">{item.shortLabel}</span>
              </NavLink>
            );
          })}
          <button type="button" onClick={() => setDrawerOpen(true)} className="flex flex-col items-center justify-center gap-1 text-[10px] font-bold text-slate-500 focus:outline-none focus-visible:ring-2 focus-inset focus-visible:ring-brand-500 dark:text-slate-400">
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" /><span>More</span>
          </button>
        </div>
      </nav>

      <Modal open={drawerOpen} onClose={() => setDrawerOpen(false)} title={settings.stationName} description={`Signed in as ${user.fullName} · ${user.role}`} size="md">
        <div onClick={(event) => event.stopPropagation()}>
          <NavigationList items={items} onNavigate={() => setDrawerOpen(false)} mobile />
          <Button variant="secondary" className="mt-7 w-full" leftIcon={<LogOut className="h-4 w-4" />} onClick={() => setLogoutOpen(true)}>Sign out</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={logoutOpen}
        title="Sign out of this device?"
        message="Any current session token will be removed from this browser tab. Your station records are unaffected."
        confirmLabel="Sign out"
        variant="warning"
        onConfirm={confirmLogout}
        onClose={() => setLogoutOpen(false)}
      />
    </div>
  );
}

export const routeTitles = Object.fromEntries(navigationItems.map((item) => [item.to, item.label]));
