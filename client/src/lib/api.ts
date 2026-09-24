import { announceUnauthorized, getSession } from '@/lib/session';
import type { AuthSession } from '@/types/api';

export const API_BASE_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, code: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  auth?: boolean;
}

async function extractError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const normalized = error as { message?: unknown; code?: unknown; details?: unknown; requestId?: unknown };
      return new ApiError(
        typeof normalized.message === 'string' ? normalized.message : `Request failed (${response.status})`,
        response.status,
        typeof normalized.code === 'string' ? normalized.code : 'REQUEST_FAILED',
        normalized.details,
        typeof normalized.requestId === 'string' ? normalized.requestId : undefined,
      );
    }
  }
  return new ApiError(`Request failed (${response.status})`, response.status, 'REQUEST_FAILED');
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, headers, ...init } = options;
  const session = auth ? getSession() : undefined;
  const requestHeaders = new Headers(headers);
  if (session?.token) requestHeaders.set('Authorization', `Bearer ${session.token}`);
  if (body !== undefined && !(body instanceof FormData)) requestHeaders.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: requestHeaders,
      body: body === undefined || body instanceof FormData ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Unable to reach the station server. Check your connection and try again.', 0, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    const error = await extractError(response);
    if (response.status === 401 && auth && getSession()) announceUnauthorized();
    throw error;
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return (await response.text()) as T;
  return response.json() as Promise<T>;
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return fallback; }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || fallback;
}

export async function download(path: string, fallbackFilename: string): Promise<void> {
  const session = getSession();
  const headers = new Headers();
  if (session?.token) headers.set('Authorization', `Bearer ${session.token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { headers });
  } catch {
    throw new ApiError('Unable to reach the station server. Check your connection and try again.', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const error = await extractError(response);
    if (response.status === 401 && session) announceUnauthorized();
    throw error;
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filenameFromDisposition(response.headers.get('content-disposition'), fallbackFilename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

export function setSessionFromLogin(token: string, expiresIn: number, user: AuthSession['user']): AuthSession {
  return { token, expiresAt: Date.now() + expiresIn * 1_000, user };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
