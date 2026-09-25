import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
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

export type FocusTarget = HTMLElement | RefObject<HTMLElement | null> | null | undefined;

function resolveFocusTarget(target: FocusTarget): HTMLElement | null {
  if (!target) return null;
  if ('current' in target) return target.current;
  return target;
}

export function focusField(target: FocusTarget, selectContents = false): void {
  const element = resolveFocusTarget(target);
  if (!element) return;
  element.focus({ preventScroll: true });
  if (selectContents && 'select' in element) (element as HTMLInputElement).select();
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
    window.requestAnimationFrame(() => {
      if (document.activeElement === element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
    });
  }
}

export function handleEnterToNext(
  event: KeyboardEvent<HTMLElement>,
  next?: FocusTarget,
  onDone?: () => void,
): void {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  const target = resolveFocusTarget(next);
  if (target) {
    focusField(target, true);
    return;
  }
  onDone?.();
}

export function errorText(error: unknown): string {
  return getErrorMessage(error);
}
