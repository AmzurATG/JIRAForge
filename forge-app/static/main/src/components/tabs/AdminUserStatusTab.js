import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';
import './AdminUserStatusTab.css';

const REFRESH_INTERVAL_MS = 30 * 1000;

const AVATAR_COLORS = [
  '#0052CC', '#00875A', '#FF5630', '#6554C0',
  '#FF991F', '#00B8D9', '#36B37E', '#FFAB00',
];

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function getAvatarColor(name) {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return null;
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return 'Just now';
  if (diff < 60 * 1000) return 'Just now';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' min ago';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' hr ago';
  return Math.floor(diff / 86400000) + ' day ago';
}

function AdminUserStatusTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const loadData = useCallback(async (isInitial) => {
    setError(null);
    try {
      const result = await invoke('getAdminUserStatus');
      if (result.success) {
        setData(result.data);
        setLastRefreshed(new Date());
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to load user status: ' + err.message);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(true);
  }, [loadData]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadData(false);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return (
      <div className="admin-user-status">
        <h2>User Status</h2>
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading user status...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-user-status">
        <h2>User Status</h2>
        <div className="error-state">
          <p>Error: {error}</p>
          <button className="retry-btn" onClick={() => loadData(false)}>Retry</button>
        </div>
      </div>
    );
  }

  const { summary, users } = data;

  return (
    <div className="admin-user-status">
      <div className="admin-user-status-header">
        <div>
          <h2>User Status</h2>
          <p className="subtitle">Desktop app adoption and activity across your organization</p>
        </div>
        <div className="header-meta">
          {lastRefreshed && (
            <span className="last-refreshed">
              Updated {formatRelativeTime(lastRefreshed.toISOString())}
            </span>
          )}
          <button className="refresh-btn" onClick={() => loadData(false)}>Refresh</button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="admin-user-status-kpi-cards">
        <div className="admin-user-status-kpi-card">
          <div className="kpi-icon blue">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
          </div>
          <div className="kpi-content">
            <div className="kpi-value">{summary.totalUsers}</div>
            <div className="kpi-label">Total Users</div>
          </div>
        </div>

        <div className="admin-user-status-kpi-card">
          <div className="kpi-icon green">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <div className="kpi-content">
            <div className="kpi-value">{summary.installedCount}</div>
            <div className="kpi-label">Desktop Installed</div>
          </div>
        </div>

        <div className="admin-user-status-kpi-card">
          <div className="kpi-icon orange">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
          </div>
          <div className="kpi-content">
            <div className="kpi-value">{summary.notInstalledCount}</div>
            <div className="kpi-label">Not Installed</div>
          </div>
        </div>

        <div className="admin-user-status-kpi-card">
          <div className="kpi-icon purple">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
          </div>
          <div className="kpi-content">
            <div className="kpi-value">{summary.activeNowCount}</div>
            <div className="kpi-label">Active Now</div>
          </div>
        </div>
      </div>

      {/* User Details Table */}
      <div className="admin-user-status-table-section">
        <div className="section-header">
          <h3>User Details</h3>
          <span className="section-subtitle">{summary.totalUsers} members in your organization</span>
        </div>
        <div className="admin-user-status-table-container">
          <table className="admin-user-status-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Desktop</th>
                <th>Status</th>
                <th>Last Heartbeat</th>
                <th>App Version</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan="6">No users found in your organization</td>
                </tr>
              ) : (
                users.map(user => (
                  <tr key={user.id}>
                    <td>
                      <div className="user-name-cell">
                        <div
                          className="user-avatar"
                          style={{ backgroundColor: getAvatarColor(user.displayName) }}
                        >
                          {getInitials(user.displayName)}
                        </div>
                        <span>{user.displayName || '\u2014'}</span>
                      </div>
                    </td>
                    <td className="email-cell">{user.email || '\u2014'}</td>
                    <td>
                      {user.desktopInstalled ? (
                        <span className="admin-user-status-pill installed">
                          <span className="status-dot"></span>
                          Installed
                        </span>
                      ) : (
                        <span className="admin-user-status-pill not-installed">
                          <span className="status-dot"></span>
                          Not Installed
                        </span>
                      )}
                    </td>
                    <td>
                      {user.activeNow ? (
                        <span className="admin-user-status-pill active-now">
                          <span className="status-dot"></span>
                          Active Now
                        </span>
                      ) : user.desktopLoggedIn ? (
                        <span className="admin-user-status-pill logged-in">
                          <span className="status-dot"></span>
                          Logged In
                        </span>
                      ) : (
                        <span className="admin-user-status-pill logged-out">
                          <span className="status-dot"></span>
                          Logged Out
                        </span>
                      )}
                    </td>
                    <td className="time-cell">
                      {user.lastHeartbeat ? formatRelativeTime(user.lastHeartbeat) : '\u2014'}
                    </td>
                    <td>{user.appVersion || '\u2014'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default AdminUserStatusTab;
