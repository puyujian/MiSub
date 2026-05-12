/**
 * Shared HTTP helpers for API requests.
 * Centralizes JSON handling, credentials, and error normalization.
 */

export class APIError extends Error {
  constructor(message, status = 500, data = null) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

let authFailureHandler = null;

const AUTH_FAILURE_EXEMPT_PATHS = new Set([
  '/api/login',
  '/api/logout',
  '/api/public_config',
  '/api/config',
  '/api/public/profiles',
  '/api/public/preview',
  '/api/auth_debug',
  '/api/auth_check',
  '/api/github/release',
  '/api/system/error_report'
]);

const AUTH_FAILURE_EXEMPT_PREFIXES = [
  '/api/public/'
];

const normalizePathname = (url) => {
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    return new URL(url, base).pathname;
  } catch {
    const [pathname = ''] = String(url || '').split('?');
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  }
};

const shouldHandleAuthFailure = (pathname, response, data, options) => {
  if (options?.skipAuthFailureHandler) return false;
  if (!pathname.startsWith('/api/')) return false;
  if (AUTH_FAILURE_EXEMPT_PATHS.has(pathname)) return false;
  if (AUTH_FAILURE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;

  if (response.status === 401) {
    return true;
  }

  return pathname === '/api/data' && response.ok && data?.authenticated === false;
};

async function notifyAuthFailure(detail) {
  if (typeof authFailureHandler !== 'function') return;

  try {
    await authFailureHandler(detail);
  } catch (error) {
    console.warn('[HTTP] Auth failure handler failed:', error);
  }
}

export function setAuthFailureHandler(handler) {
  authFailureHandler = typeof handler === 'function' ? handler : null;
}

const buildHeaders = (headers, body) => {
  if (headers instanceof Headers) {
    return headers;
  }
  const resolved = new Headers(headers || {});
  if (!resolved.has('Content-Type') && body !== undefined) {
    resolved.set('Content-Type', 'application/json');
  }
  return resolved;
};

const parseJson = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
};

export async function request(url, options = {}) {
  const { headers, body, ...rest } = options;
  const response = await fetch(url, {
    credentials: 'include',
    ...rest,
    body,
    headers: buildHeaders(headers, body)
  });

  const data = await parseJson(response);
  const pathname = normalizePathname(url);

  if (shouldHandleAuthFailure(pathname, response, data, options)) {
    await notifyAuthFailure({
      url,
      pathname,
      status: 401,
      data,
      reason: response.ok ? 'unauthenticated_payload' : 'http_401'
    });
    throw new APIError('认证失败,请重新登录', 401, data);
  }

  if (!response.ok) {
    const message = data?.message || data?.error || `HTTP ${response.status}`;
    throw new APIError(message, response.status, data);
  }

  return data;
}

const stringifyBody = (data) => (data === undefined ? undefined : JSON.stringify(data));

export const api = {
  get: (url, options = {}) => request(url, { ...options, method: 'GET' }),
  post: (url, data, options = {}) => request(url, { ...options, method: 'POST', body: stringifyBody(data) }),
  put: (url, data, options = {}) => request(url, { ...options, method: 'PUT', body: stringifyBody(data) }),
  patch: (url, data, options = {}) => request(url, { ...options, method: 'PATCH', body: stringifyBody(data) }),
  del: (url, options = {}) => request(url, { ...options, method: 'DELETE' })
};
