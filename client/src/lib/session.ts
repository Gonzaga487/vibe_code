import type { AuthSession } from '@/types/api';
export type { AuthSession as StoredSession } from '@/types/api';

const SESSION_KEY = 'zenenergies.session';
const UNAUTHORIZED_EVENT = 'zenenergies:unauthorized';

function canUseSessionStorage(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.sessionStorage);
  } catch {
    return false;
  }
}

export function getSession(): AuthSession | null {
  if (!canUseSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.token || !parsed.user || parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    clearSession();
    return null;
  }
}

export function setSession(session: AuthSession): void {
  if (!canUseSessionStorage()) return;
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function updateSession(session: AuthSession): void {
  setSession(session);
}

export function clearSession(): void {
  if (canUseSessionStorage()) window.sessionStorage.removeItem(SESSION_KEY);
}

export function onUnauthorized(listener: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}

export function announceUnauthorized(): void {
  clearSession();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
