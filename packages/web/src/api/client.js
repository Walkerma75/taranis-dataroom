/**
 * API client with automatic token refresh.
 */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

let accessToken = null;
let refreshToken = null;
let onAuthFail = null; // callback to redirect to login

export function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  if (access) localStorage.setItem('accessToken', access);
  if (refresh) localStorage.setItem('refreshToken', refresh);
}

export function loadTokens() {
  accessToken = localStorage.getItem('accessToken');
  refreshToken = localStorage.getItem('refreshToken');
  return { accessToken, refreshToken };
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

export function setAuthFailHandler(fn) {
  onAuthFail = fn;
}

async function refreshAccessToken() {
  if (!refreshToken) throw new Error('No refresh token');

  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    if (onAuthFail) onAuthFail();
    throw new Error('Token refresh failed');
  }

  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  return data.accessToken;
}

/**
 * Main fetch wrapper with auth headers and auto-refresh.
 */
export async function apiFetch(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = { ...options.headers };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  // Don't set Content-Type for FormData (browser sets boundary automatically)
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res = await fetch(url, { ...options, headers });

  // If 401, try refresh once
  if (res.status === 401 && refreshToken) {
    try {
      const newToken = await refreshAccessToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(url, { ...options, headers });
    } catch {
      // Refresh failed — let the 401 propagate
    }
  }

  return res;
}

/**
 * Convenience methods.
 */
export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) =>
    apiFetch(path, {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),
  patch: (path, body) =>
    apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
};
