import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@/lib/api';

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | ZENENERGIES Station`;
    return () => { document.title = previous; };
  }, [title]);
}

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function useClock(enabled: boolean, timezone?: string): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  void timezone;
  return now;
}

export function useDocumentFocus(): boolean {
  const [focused, setFocused] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onVisibility = () => setFocused(document.visibilityState === 'visible');
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return focused;
}

export function useSubmitGuard(): [boolean, (action: () => Promise<void>) => Promise<void>] {
  const active = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setSubmitting(true);
    try {
      await action();
    } finally {
      active.current = false;
      setSubmitting(false);
    }
  }, []);

  return [submitting, run];
}

export function errorText(error: unknown): string {
  return getErrorMessage(error);
}
