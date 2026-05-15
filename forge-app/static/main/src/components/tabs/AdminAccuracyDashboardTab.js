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
 * v2 layout (2026-05-14): reframed around three time buckets that sum to total
 * reviewed time, so every panel reconciles by construction.
 *   matched     -> AI's pick was kept            (approved_as_is)
 *   reassigned  -> AI's pick was overridden      (reassigned ∪ manually_assigned-with-suggestion)
 *   unmatched   -> AI didn't classify            (manually_assigned-without-suggestion)
 * Headline metric is time-weighted match rate = matched / (matched + reassigned).
 * See plan/2026-05-14_multi-component_ai-accuracy-dashboard-redesign.md.
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
  if (!seconds || seconds < 1) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `<1m`;
}

function formatPercent(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(digits)}%`;
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
  const [reassignments, setReassignments] = useState([]);
  const [byApp, setByApp] = useState([]);
  const [recentReassignments, setRecentReassignments] = useState([]);
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
      const [s, wp, ba, rm] = await Promise.all([
        invoke('getAccuracySummary', params),
        invoke('getAccuracyWrongPairs', { ...params, limit: 25 }),
        invoke('getAccuracyByApp', { ...params, limit: 25 }),
        invoke('getAccuracyRecentMistakes', { org: orgId || undefined, limit: 50 }),
      ]);
      setSummary(unwrap(s));
      setReassignments(unwrap(wp)?.pairs || []);
      setByApp(unwrap(ba)?.apps || []);
      setRecentReassignments(unwrap(rm)?.mistakes || []);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days, orgId]);

  useEffect(() => { loadOrgs(); }, [loadOrgs]);
  useEffect(() => { loadAll(); }, [loadAll]);

  // Three time buckets sourced from the v2 /summary response.
  const matched    = summary?.matched    || { count: 0, seconds: 0 };
  const reassigned = summary?.reassigned || { count: 0, seconds: 0, new_issue_count: 0, new_issue_seconds: 0 };
  const unmatched  = summary?.unmatched  || { count: 0, seconds: 0 };
  const matchRate  = summary?.match_rate;
  const totalSeconds = summary?.total_seconds || 0;

  // Breakdown bar segment widths (percent of total reviewed time).
  const segPct = (s) => totalSeconds > 0 ? (s / totalSeconds) * 100 : 0;
  const matchedPct    = segPct(matched.seconds);
  const reassignedPct = segPct(reassigned.seconds);
  const unmatchedPct  = segPct(unmatched.seconds);

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

      {/* KPI cards: Match rate · Reassigned · Unmatched */}
      <div className="accuracy-cards">
        <div className="accuracy-card accuracy-card-primary">
          <div className="card-label">Match rate</div>
          <div className="card-value">{formatPercent(matchRate)}</div>
          <div className="card-sub">
            By time, of the activity where the AI made a suggestion
          </div>
        </div>
        <div className="accuracy-card">
          <div className="card-label">Reassigned</div>
          <div className="card-value">{formatDuration(reassigned.seconds)}</div>
          <div className="card-sub">
            AI was overruled
            {reassigned.new_issue_count > 0 && (
              <> · {reassigned.new_issue_count} via new issue</>
            )}
          </div>
        </div>
        <div className="accuracy-card">
          <div className="card-label">Unmatched</div>
          <div className="card-value">{formatDuration(unmatched.seconds)}</div>
          <div className="card-sub">AI didn't classify — user assigned from scratch</div>
        </div>
      </div>

      {/* Visual breakdown bar — Matched / Reassigned / Unmatched proportions */}
      <div className="accuracy-breakdown">
        <div className="breakdown-total">
          Total reviewed time: <strong>{formatDuration(totalSeconds)}</strong>
        </div>
        <div className="breakdown-bar">
          {matchedPct > 0 && (
            <div
              className="breakdown-seg breakdown-seg-matched"
              style={{ width: `${matchedPct}%` }}
              title={`Matched · ${formatDuration(matched.seconds)} (${matchedPct.toFixed(1)}%)`}
            />
          )}
          {reassignedPct > 0 && (
            <div
              className="breakdown-seg breakdown-seg-reassigned"
              style={{ width: `${reassignedPct}%` }}
              title={`Reassigned · ${formatDuration(reassigned.seconds)} (${reassignedPct.toFixed(1)}%)`}
            />
          )}
          {unmatchedPct > 0 && (
            <div
              className="breakdown-seg breakdown-seg-unmatched"
              style={{ width: `${unmatchedPct}%` }}
              title={`Unmatched · ${formatDuration(unmatched.seconds)} (${unmatchedPct.toFixed(1)}%)`}
            />
          )}
        </div>
        <div className="breakdown-legend">
          <span className="legend-item">
            <span className="legend-swatch legend-swatch-matched" />
            Matched {formatDuration(matched.seconds)} ({matchedPct.toFixed(1)}%)
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch-reassigned" />
            Reassigned {formatDuration(reassigned.seconds)} ({reassignedPct.toFixed(1)}%)
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch-unmatched" />
            Unmatched {formatDuration(unmatched.seconds)} ({unmatchedPct.toFixed(1)}%)
          </span>
        </div>
      </div>

      <section className="accuracy-panel">
        <header>
          <h3>Reassignments</h3>
          <p>Where the AI's pick got changed, and by whom. Sorted by total time — the bigger the time, the bigger the prompt-tuning win.</p>
        </header>
        <table className="accuracy-table">
          <thead>
            <tr>
              <th>User</th>
              <th>AI suggested</th>
              <th>User chose</th>
              <th className="num">Total time</th>
              <th className="num">Times</th>
            </tr>
          </thead>
          <tbody>
            {reassignments.length === 0 && (
              <tr><td colSpan={5} className="empty">No reassignments in this window.</td></tr>
            )}
            {reassignments.map((p, i) => (
              <tr key={i}>
                <td title={p.user_email || ''}>
                  {p.user_display_name || p.user_email || '(unknown)'}
                </td>
                <td><code>{p.from || '—'}</code></td>
                <td>
                  <code>{p.to || '—'}</code>
                  {p.is_new_issue && <span className="new-issue-tag" title="Destination issue was created from the AI suggestion">(new)</span>}
                </td>
                <td className="num">{formatDuration(p.seconds)}</td>
                <td className="num">{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="accuracy-panel">
        <header>
          <h3>Accuracy by application</h3>
          <p>Time the AI spent right vs. overruled vs. not even tried, per application. Sorted by total time.</p>
        </header>
        <table className="accuracy-table">
          <thead>
            <tr>
              <th>Application</th>
              <th className="num">Matched</th>
              <th className="num">Reassigned</th>
              <th className="num">Unmatched</th>
              <th className="num">Total</th>
              <th className="num">Match rate</th>
            </tr>
          </thead>
          <tbody>
            {byApp.length === 0 && (
              <tr><td colSpan={6} className="empty">No data in this window.</td></tr>
            )}
            {byApp.map((a, i) => (
              <tr key={i}>
                <td>{a.app || '—'}</td>
                <td className="num">{formatDuration(a.matched_seconds)}</td>
                <td className="num">{formatDuration(a.reassigned_seconds)}</td>
                <td className="num">{formatDuration(a.unmatched_seconds)}</td>
                <td className="num">{formatDuration(a.total_seconds)}</td>
                <td className="num">{formatPercent(a.match_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="accuracy-panel">
        <header>
          <h3>Recent reassignments</h3>
          <p>The last reassignments with context — use these to reverse-engineer why the AI got it wrong.</p>
        </header>
        <table className="accuracy-table">
          <thead>
            <tr>
              <th>When</th>
              <th>AI picked</th>
              <th>User chose</th>
              <th className="num">Conf.</th>
              <th className="num">Duration</th>
              <th>App</th>
              <th>Window title</th>
            </tr>
          </thead>
          <tbody>
            {recentReassignments.length === 0 && (
              <tr><td colSpan={7} className="empty">No reassignments recorded yet.</td></tr>
            )}
            {recentReassignments.map((m) => (
              <tr key={m.id}>
                <td>{formatRelativeTime(m.created_at)}</td>
                <td><code>{m.ai_suggested_issue_key || '—'}</code></td>
                <td><code>{m.final_issue_key || '—'}</code></td>
                <td className="num">{formatPercent(m.ai_confidence_score)}</td>
                <td className="num">{formatDuration(m.duration_seconds)}</td>
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
