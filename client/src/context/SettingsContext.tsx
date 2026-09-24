import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { request } from '@/lib/api';
import type { InterfaceOptions, PublicSettings, Settings, Theme } from '@/types/api';

const DEFAULT_SETTINGS: PublicSettings = {
  stationName: 'ZENENERGIES Station',
  currency: 'KSh',
  timezone: 'Africa/Nairobi',
  dateFormat: 'yyyy-MM-dd',
  language: 'en',
  interfaceOptions: { theme: 'system', compactTables: false, showStationClock: true },
};

const PREFERENCES_KEY = 'zenenergies.interface-preferences';

interface SettingsContextValue {
  settings: PublicSettings;
  interfaceOptions: InterfaceOptions;
  setInterfacePreferences: (options: InterfaceOptions) => void;
  applyServerSettings: (settings: Settings) => void;
  refreshPublicSettings: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function readPreferences(): InterfaceOptions {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_SETTINGS.interfaceOptions;
    const parsed = JSON.parse(raw) as Partial<InterfaceOptions>;
    return {
      theme: ['system', 'light', 'dark'].includes(parsed.theme || '') ? parsed.theme as Theme : 'system',
      compactTables: typeof parsed.compactTables === 'boolean' ? parsed.compactTables : false,
      showStationClock: typeof parsed.showStationClock === 'boolean' ? parsed.showStationClock : true,
    };
  } catch {
    return DEFAULT_SETTINGS.interfaceOptions;
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_SETTINGS);
  const [preferences, setPreferences] = useState<InterfaceOptions>(readPreferences);

  const refreshPublicSettings = useCallback(async () => {
    const response = await request<{ settings: PublicSettings }>('/settings/public', { auth: false });
    setSettings((current) => ({ ...current, ...response.settings }));
  }, []);

  useEffect(() => {
    void refreshPublicSettings().catch(() => undefined);
  }, [refreshPublicSettings]);

  const applyServerSettings = useCallback((server: Settings) => {
    setSettings((current) => ({
      ...current,
      stationName: server.stationName,
      currency: 'KSh',
      timezone: server.timezone,
      dateFormat: server.dateFormat,
      language: server.language,
      interfaceOptions: server.interfaceOptions,
    }));
    try { window.localStorage.removeItem(PREFERENCES_KEY); } catch { /* storage can be unavailable */ }
    setPreferences(server.interfaceOptions);
  }, []);

  const setInterfacePreferences = useCallback((options: InterfaceOptions) => {
    setPreferences(options);
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(options)); } catch { /* storage can be unavailable */ }
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences.theme]);

  const value = useMemo<SettingsContextValue>(() => ({
    settings,
    interfaceOptions: preferences,
    setInterfacePreferences,
    applyServerSettings,
    refreshPublicSettings,
  }), [applyServerSettings, preferences, refreshPublicSettings, setInterfacePreferences, settings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used inside SettingsProvider');
  return context;
}
