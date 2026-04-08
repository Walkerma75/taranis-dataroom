import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setTokens, loadTokens, clearTokens, setAuthFailHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(async () => {
    const { refreshToken } = loadTokens();
    try {
      await api.post('/auth/logout', { refreshToken });
    } catch { /* ignore */ }
    clearTokens();
    setUser(null);
  }, []);

  // On mount, try to restore session
  useEffect(() => {
    setAuthFailHandler(() => {
      setUser(null);
      setLoading(false);
    });

    const { accessToken } = loadTokens();
    if (!accessToken) {
      setLoading(false);
      return;
    }

    api.get('/auth/me')
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('Not authenticated');
      })
      .then((data) => setUser(data))
      .catch(() => clearTokens())
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password, totpCode) => {
    const res = await api.post('/auth/login', { email, password, totpCode });
    const data = await res.json();

    if (!res.ok) {
      return { error: data.error, mfaRequired: data.mfaRequired };
    }

    if (data.mfaRequired) {
      return { mfaRequired: true };
    }

    setTokens(data.accessToken, data.refreshToken);
    setUser(data.user);
    return { user: data.user };
  };

  return (
    <AuthContext.Provider value={{ user, setUser, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
