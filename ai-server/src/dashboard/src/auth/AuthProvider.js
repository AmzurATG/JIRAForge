import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

const TOKEN_KEY = 'atl_dashboard_token';
const REFRESH_TOKEN_KEY = 'atl_dashboard_refresh_token';

/**
 * Atlassian OAuth provider for the standalone dashboard.
 * Manages token storage, OAuth redirect flow, and token refresh.
 */
export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [clientId, setClientId] = useState(null);

  // Fetch OAuth client ID from server on mount
  useEffect(() => {
    fetch('/api/auth/config')
      .then(r => r.json())
      .then(data => {
        if (data.success) setClientId(data.clientId);
        else setAuthError('Unable to load OAuth configuration');
      })
      .catch(() => setAuthError('Unable to reach server for OAuth config'));
  }, []);

  // Check for OAuth callback params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      // Exchange code for token
      exchangeCode(code);
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (token) {
      // Verify existing token still works
      verifyToken(token);
    } else {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exchangeCode = async (code) => {
    try {
      const response = await fetch('/api/auth/atlassian/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          redirectUri: window.location.origin + '/dashboard'
        })
      });

      const data = await response.json();
      if (data.success && data.accessToken) {
        sessionStorage.setItem(TOKEN_KEY, data.accessToken);
        if (data.refreshToken) {
          sessionStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
        }
        setToken(data.accessToken);
        setAuthError(null);
      } else {
        setAuthError(data.error || 'Failed to exchange authorization code');
      }
    } catch (err) {
      setAuthError('Failed to complete authentication: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const verifyToken = async (tkn) => {
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tkn}`
        }
      });

      if (response.ok) {
        setAuthError(null);
      } else {
        // Token expired — try refresh
        const refreshToken = sessionStorage.getItem(REFRESH_TOKEN_KEY);
        if (refreshToken) {
          await refreshAccessToken(refreshToken);
        } else {
          logout();
        }
      }
    } catch {
      // Network error — don't force logout, let API calls handle it
    } finally {
      setLoading(false);
    }
  };

  const refreshAccessToken = async (refreshToken) => {
    try {
      const response = await fetch('/api/auth/refresh-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });

      const data = await response.json();
      if (data.success && data.accessToken) {
        sessionStorage.setItem(TOKEN_KEY, data.accessToken);
        if (data.refreshToken) {
          sessionStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
        }
        setToken(data.accessToken);
        setAuthError(null);
      } else {
        logout();
      }
    } catch {
      logout();
    }
  };

  const login = useCallback(() => {
    if (!clientId) {
      setAuthError('OAuth client ID not loaded yet. Please try again.');
      return;
    }
    // Redirect to Atlassian OAuth consent screen
    const redirectUri = encodeURIComponent(window.location.origin + '/dashboard');
    const scope = encodeURIComponent('read:me read:jira-work read:jira-user manage:jira-configuration');
    const authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}&response_type=code&prompt=consent`;
    window.location.href = authUrl;
  }, [clientId]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, loading, authError, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
