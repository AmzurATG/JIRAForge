/**
 * AdminAccuracyDashboardTab — REMOVABLE LAYER
 *
 * Internal AI-accuracy measurement surface, embedded inside the Forge app.
 * Replaces the standalone /accuracy-dashboard HTML page that previously lived
 * on the AI server and required pasting an Atlassian bearer token.
 *
 * Visibility is gated by the `accuracy_dashboard_users` email allowlist —
 * the parent (App.js) only renders this component when
 * `checkAccuracyDashboardAccess` returns allowed.
 *
 * Removal: delete this file + its CSS, drop the export in tabs/index.js, and
 * remove the sidebar entry + render block in App.js. See
 * plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import './AdminAccuracyDashboardTab.css';

const TIME_RANGE_OPTIONS = [
  { value: 1,   label: 'Last 24 hours' },
  { value: 7,   label: 'Last 7 days' },
  { value: 30,  label: 'Last 30 days' },
  { value: 90,  label: 'Last 90 days' },
];

function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPercent(value) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function unwrap(result) {
  // Resolver wraps payload as { success, data } where `data` is the AI server's
  // {success:true,data:{...}} response already unwrapped to {...} by remoteRequest.
  if (!result?.success) {
    throw new Error(result?.error || 'Request failed');
  }
  return result.data;
}

function AdminAccuracyDashboardTab() {
  const [days, setDays] = useState(7);
  const [orgId, setOrgId] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [wrongPairs, setWrongPairs] = useState([]);
  const [byApp, setByApp] = useState([]);
  const [calibration, setCalibration] = useState([]);
  const [recentMistakes, setRecentMistakes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const loadOrgs = useCallback(async () => {
    try {
      const data = unwrap(await invoke('getAccuracyOrgs', {}));
      setOrgs(data?.orgs || []);
    } catch (err) {
      console.warn('Failed to load orgs:', err.message);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { days, org: orgId || undefined };
      const [s, wp, ba, cal, rm] = await Promise.all([
        invoke('getAccuracySummary', params),
        invoke('getAccuracyWrongPairs', { ...params, limit: 25 }),
        invoke('getAccuracyByApp', { ...params, limit: 25 }),
        invoke('getAccuracyCalibration', params),
        invoke('getAccuracyRecentMistakes', { org: orgId || undefined, limit: 50 }),
      ]);
      setSummary(unwrap(s));
      setWrongPairs(unwrap(wp)?.pairs || []);
      setByApp(unwrap(ba)?.apps || []);
      setCalibration(unwrap(cal)?.series || []);
      setRecentMistakes(unwrap(rm)?.mistakes || []);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days, orgId]);

  useEffect(() => { loadOrgs(); }, [loadOrgs]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const headlineAccuracy = summary?.accuracy_rate;
  const totals = summary?.counts || {};
  const durations = summary?.duration_seconds || {};

  return (
    <div className="accuracy-dashboard">
      <div className="accuracy-header">
        <div>
          <h2>AI Accuracy Dashboard</h2>
          <p className="accuracy-subtitle">
            Internal measurement tool · removable layer ·
            {lastRefreshed && (
              <span> updated {formatRelativeTime(lastRefreshed.toISOString())}</span>
            )}
          </p>
        </div>
        <div className="accuracy-filters">
          <label>
            <span>Time range</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {TIME_RANGE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Organization</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">All organizations</option>
              {orgs.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <button className="accuracy-refresh" onClick={loadAll} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="accuracy-error">
          {error}
        </div>
      )}

      {/* Headline */}
      <div className="accuracy-cards">
        <div className="accuracy-card accuracy-card-primary">
          <div className="card-label">Overall accuracy</div>
          <div className="card-value">{formatPercent(headlineAccuracy)}</div>
          <div className="card-sub">
            {totals.approved_as_is || 0} accepted · {totals.reassigned || 0} reassigned ·
            {' '}{totals.manually_assigned_with_suggestion || 0} overridden
          </div>
        </div>
        <div className="accuracy-card">
          <div className="card-label">Approved time</div>
          <div className="card-value">{formatDuration(durations.approved)}</div>
        </div>
        <div className="accuracy-card">
          <div className="card-label">Reassigned time</div>
          <div className="card-value">{formatDuration(durations.reassigned)}</div>
        </div>
        <div className="accuracy-card">
          <div className="card-label">Total events</div>
          <div className="card-value">{summary?.total_events ?? 0}</div>
          <div className="card-sub">
            {totals.manually_assigned_no_suggestion || 0} had no AI suggestion
          </div>
        </div>
      </div>

      <div className="accuracy-grid">
        <section className="accuracy-panel">
          <header>
            <h3>Top wrong pairs</h3>
            <p>What the AI guessed vs what the user actually picked. Highest-leverage prompt-tuning targets.</p>
          </header>
          <table className="accuracy-table">
            <thead>
              <tr><th>AI picked</th><th>User picked</th><th className="num">Count</th></tr>
            </thead>
            <tbody>
              {wrongPairs.length === 0 && (
                <tr><td colSpan={3} className="empty">No reassignments in this window.</td></tr>
              )}
              {wrongPairs.map((p, i) => (
                <tr key={i}>
                  <td><code>{p.from || '—'}</code></td>
                  <td><code>{p.to || '—'}</code></td>
                  <td className="num">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="accuracy-panel">
          <header>
            <h3>Accuracy by application</h3>
            <p>Where the AI is most wrong, sorted by wrong count.</p>
          </header>
          <table className="accuracy-table">
            <thead>
              <tr>
                <th>Application</th>
                <th className="num">Right</th>
                <th className="num">Wrong</th>
                <th className="num">Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {byApp.length === 0 && (
                <tr><td colSpan={4} className="empty">No data in this window.</td></tr>
              )}
              {byApp.map((a, i) => (
                <tr key={i}>
                  <td>{a.app || '—'}</td>
                  <td className="num">{a.right}</td>
                  <td className="num">{a.wrong}</td>
                  <td className="num">{formatPercent(a.accuracy_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="accuracy-panel">
        <header>
          <h3>Confidence calibration</h3>
          <p>When the AI says it's 80% sure, is it actually right 80% of the time? A well-calibrated model lines up diagonally.</p>
        </header>
        <table className="accuracy-table">
          <thead>
            <tr>
              <th>Confidence bucket</th>
              <th className="num">Sample size</th>
              <th className="num">Actual accuracy</th>
              <th>Visual</th>
            </tr>
          </thead>
          <tbody>
            {calibration.map((b, i) => (
              <tr key={i}>
                <td>{b.bucket_label}</td>
                <td className="num">{b.sample_count}</td>
                <td className="num">{formatPercent(b.actual_accuracy)}</td>
                <td>
                  <div className="cal-bar">
                    <div
                      className="cal-bar-fill"
                      style={{
                        width: b.actual_accuracy != null
                          ? `${(b.actual_accuracy * 100).toFixed(0)}%`
                          : '0%'
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="accuracy-panel">
        <header>
          <h3>Recent mistakes</h3>
          <p>Last reassignments with context — use these to reverse-engineer why the AI got it wrong.</p>
        </header>
        <table className="accuracy-table">
          <thead>
            <tr>
              <th>When</th>
              <th>AI picked</th>
              <th>User picked</th>
              <th className="num">Conf.</th>
              <th>App</th>
              <th>Window title</th>
            </tr>
          </thead>
          <tbody>
            {recentMistakes.length === 0 && (
              <tr><td colSpan={6} className="empty">No mistakes recorded yet.</td></tr>
            )}
            {recentMistakes.map((m) => (
              <tr key={m.id}>
                <td>{formatRelativeTime(m.created_at)}</td>
                <td><code>{m.ai_suggested_issue_key || '—'}</code></td>
                <td><code>{m.final_issue_key || '—'}</code></td>
                <td className="num">{formatPercent(m.ai_confidence_score)}</td>
                <td>{m.application_name || '—'}</td>
                <td className="window-title">{m.window_title || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default AdminAccuracyDashboardTab;
