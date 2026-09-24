import type { LucideIcon } from 'lucide-react';
import {
  BadgeDollarSign,
  CalendarDays,
  ClipboardList,
  DatabaseBackup,
  FileBarChart,
  Fuel,
  Gauge,
  LayoutDashboard,
  PackagePlus,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import type { Role } from '@/types/api';

export interface NavigationItem {
  to: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  section: 'operations' | 'finance' | 'administration';
}

export const navigationItems: NavigationItem[] = [
  { to: '/dashboard', label: 'Dashboard', shortLabel: 'Home', icon: LayoutDashboard, section: 'operations' },
  { to: '/sales', label: 'Record Sale', shortLabel: 'Sale', icon: ReceiptText, section: 'operations' },
  { to: '/shift', label: 'My Shift', shortLabel: 'Shift', icon: WalletCards, section: 'operations' },
  { to: '/pump-readings', label: 'Pump Meter Readings', shortLabel: 'Pump', icon: Gauge, section: 'operations' },
  { to: '/sales-readings', label: 'Sales Meter Readings', shortLabel: 'Meter', icon: ClipboardList, section: 'operations' },
  { to: '/expenses', label: 'Expenses', shortLabel: 'Expenses', icon: BadgeDollarSign, section: 'finance' },
  { to: '/calendar', label: 'Calendar', shortLabel: 'Calendar', icon: CalendarDays, section: 'operations' },
  { to: '/restock', label: 'Restock', shortLabel: 'Restock', icon: PackagePlus, adminOnly: true, section: 'operations' },
  { to: '/reports', label: 'Reports', shortLabel: 'Reports', icon: FileBarChart, adminOnly: true, section: 'finance' },
  { to: '/monthly-summary', label: 'Monthly Summary', shortLabel: 'Monthly', icon: CalendarDays, adminOnly: true, section: 'finance' },
  { to: '/fuel', label: 'Manage Fuel', shortLabel: 'Fuel', icon: Fuel, adminOnly: true, section: 'operations' },
  { to: '/users', label: 'Users', shortLabel: 'Users', icon: ShieldCheck, adminOnly: true, section: 'administration' },
  { to: '/audit', label: 'Audit Trail', shortLabel: 'Audit', icon: ScrollText, adminOnly: true, section: 'administration' },
  { to: '/backup', label: 'Backup & Restore', shortLabel: 'Backup', icon: DatabaseBackup, adminOnly: true, section: 'administration' },
  { to: '/settings', label: 'Settings', shortLabel: 'Settings', icon: Settings, section: 'administration' },
];

export function visibleNavigation(role: Role): NavigationItem[] {
  return navigationItems.filter((item) => !item.adminOnly || role === 'admin');
}
