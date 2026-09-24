import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { request, setSessionFromLogin } from '@/lib/api';
import { clearSession, getSession, onUnauthorized, setSession, updateSession, type StoredSession } from '@/lib/session';
import type { AuthSession, LoginResponse, Role, User } from '@/types/api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: User | null;
  session: AuthSession | null;
  status: AuthStatus;
  notice: string | null;
  isAdmin: boolean;
  login: (username: string, password: string, role: Role) => Promise<User>;
  logout: (message?: string) => void;
  updatePassword: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<void>;
  dismissNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toSession(response: LoginResponse): StoredSession {
  return setSessionFromLogin(response.token, response.expiresIn, response.user);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() => getSession());
  const [status, setStatus] = useState<AuthStatus>(() => getSession() ? 'loading' : 'anonymous');
  const [notice, setNotice] = useState<string | null>(null);

  const logout = useCallback((message?: string) => {
    clearSession();
    setSessionState(null);
    setStatus('anonymous');
    setNotice(message || null);
  }, []);

  useEffect(() => onUnauthorized(() => logout('Your session expired or is no longer valid. Please sign in again.')), [logout]);

  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      logout('Your session expired. Please sign in again.');
      return;
    }
    const timer = window.setTimeout(() => {
      logout('Your session expired. Please sign in again.');
    }, Math.max(1_000, remaining - 5_000));
    return () => window.clearTimeout(timer);
  }, [logout, session]);

  useEffect(() => {
    if (!session?.token) return;
    let active = true;
    request<{ user: User }>('/auth/me')
      .then(({ user }) => {
        if (!active) return;
        const next = { ...session, user };
        setSession(next);
        updateSession(next);
        setSessionState(next);
        setStatus('authenticated');
      })
      .catch(() => {
        if (!active) return;
        clearSession();
        setSessionState(null);
        setStatus('anonymous');
      });
    return () => { active = false; };
    // Validation is intentionally performed only when a new token is restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const login = useCallback(async (username: string, password: string, role: Role) => {
    const response = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { username: username.trim(), password, role },
    });
    const next = toSession(response);
    setSession(next);
    setSessionState(next);
    setStatus('authenticated');
    setNotice(null);
    return response.user;
  }, []);

  const updatePassword = useCallback(async (currentPassword: string, newPassword: string, confirmPassword: string) => {
    const response = await request<LoginResponse>('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword, confirmPassword },
    });
    const next = toSession(response);
    setSession(next);
    updateSession(next);
    setSessionState(next);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user: session?.user || null,
    session,
    status,
    notice,
    isAdmin: session?.user.role === 'admin',
    login,
    logout,
    updatePassword,
    dismissNotice: () => setNotice(null),
  }), [login, logout, notice, session, status, updatePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
