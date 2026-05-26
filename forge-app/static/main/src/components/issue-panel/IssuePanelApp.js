import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import { triggerWorklogSyncIfDue } from '../../utils/worklogSync';
import DescriptionQuality from './DescriptionQuality';
import './IssuePanelApp.css';

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatTimeRange(startIso, endIso) {
  const opts = { hour: 'numeric', minute: '2-digit' };
  try {
    const start = new Date(startIso).toLocaleTimeString([], opts);
    const end = new Date(endIso).toLocaleTimeString([], opts);
    return `${start} – ${end}`;
  } catch {
    return '';
  }
}

function dateLabel(isoOrDate) {
  if (!isoOrDate) return '';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ConfidenceDots({ value }) {
  if (value == null) return null;
  const filled = Math.max(0, Math.min(5, Math.round(value * 5)));
  const pct = Math.round(value * 100);
  return (
    <span
      className="ip-confidence"
      title={`AI confidence: ${pct}% — low confidence means the AI was uncertain`}
      aria-label={`AI confidence ${pct} percent`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`ip-dot ${i < filled ? 'ip-dot--on' : ''}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function SessionCard({ session, approving, onApprove }) {
  return (
    <div className={`ip-card ${approving ? 'ip-card--busy' : ''}`}>
      <div className="ip-card-head">
        <span className="ip-time">{formatTimeRange(session.startTime, session.endTime)}</span>
        <span className="ip-meta">
          {formatDuration(session.totalSeconds)} · {session.recordCount}{' '}
          {session.recordCount === 1 ? 'record' : 'records'}
        </span>
      </div>
      {session.windowTitles?.[0] && (
        <div className="ip-context" title={session.windowTitles.join('\n')}>
          {session.applications?.[0] ? `${session.applications[0]} — ` : ''}
          {session.windowTitles[0]}
        </div>
      )}
      <div className="ip-card-foot">
        <ConfidenceDots value={session.confidence} />
        <button
          type="button"
          className="ip-btn ip-btn--approve"
          disabled={approving}
          onClick={onApprove}
          aria-busy={approving}
          title="Approve — time will sync to Jira on the next hourly sync"
        >
          {approving ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

function groupByDate(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.workDate || (s.startTime || '').slice(0, 10) || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

export default function IssuePanelApp({ issueKey }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [approvingKey, setApprovingKey] = useState(null);
  const [bulkApproving, setBulkApproving] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await invoke('getPendingApprovalForIssue', { issueKey });
      if (res?.success) {
        setState({ loading: false, error: null, data: res });
      } else {
        setState({ loading: false, error: res?.error || 'Failed to load', data: null });
      }
    } catch (err) {
      setState({ loading: false, error: err?.message || 'Failed to load', data: null });
    }
  }, [issueKey]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => { triggerWorklogSyncIfDue(); }, []);

  const sessions = useMemo(() => state.data?.sessions || [], [state.data]);
  const pendingCount = state.data?.pendingCount || 0;
  const totalSeconds = state.data?.totalSeconds || 0;
  const grouped = useMemo(() => groupByDate(sessions), [sessions]);

  const handleApprove = async (session) => {
    const key = session.sessionIds.join(',');
    setApprovingKey(key);
    try {
      const res = await invoke('approveRecords', { sessionIds: session.sessionIds });
      if (res?.success) {
        await load();
      } else {
        alert(`Approve failed: ${res?.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Approve failed: ${err?.message || err}`);
    } finally {
      setApprovingKey(null);
    }
  };

  const handleApproveAll = async () => {
    if (!sessions.length) return;
    setBulkApproving(true);
    try {
      const allIds = sessions.flatMap((s) => s.sessionIds);
      const res = await invoke('approveRecords', { sessionIds: allIds });
      if (res?.success) {
        await load();
      } else {
        alert(`Approve all failed: ${res?.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Approve all failed: ${err?.message || err}`);
    } finally {
      setBulkApproving(false);
    }
  };

  if (state.loading) {
    return (
      <div className="ip-root">
        <div className="ip-skeleton" />
        <div className="ip-skeleton" />
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="ip-root">
        <div className="ip-error">
          Couldn’t load approvals — {state.error}
          <button type="button" className="ip-btn ip-btn--link" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  if (pendingCount === 0) {
    return (
      <div className="ip-root">
        <div className="ip-empty">
          <div className="ip-empty-icon" aria-hidden="true">✓</div>
          <div className="ip-empty-title">No time waiting for review</div>
          <div className="ip-empty-sub">
            AI-assigned time on this issue is up to date.
          </div>
        </div>
        <DescriptionQuality issueKey={issueKey} />
      </div>
    );
  }

  return (
    <div className="ip-root">
      <div className="ip-banner">
        <div className="ip-banner-text">
          <div className="ip-banner-title">
            {pendingCount} {pendingCount === 1 ? 'session needs' : 'sessions need'} your review
          </div>
          <div className="ip-banner-sub">
            {formatDuration(totalSeconds)} of AI-assigned time waiting to sync to Jira
          </div>
        </div>
        <button
          type="button"
          className="ip-btn ip-btn--approve-all"
          onClick={handleApproveAll}
          disabled={bulkApproving || approvingKey !== null}
          aria-busy={bulkApproving}
        >
          {bulkApproving ? 'Approving…' : `Approve all (${formatDuration(totalSeconds)})`}
        </button>
      </div>

      {grouped.map(([dateKey, daySessions]) => (
        <section key={dateKey} className="ip-day">
          <h3 className="ip-day-title">{dateLabel(dateKey)}</h3>
          {daySessions.map((session) => {
            const key = session.sessionIds.join(',');
            return (
              <SessionCard
                key={key}
                session={session}
                approving={approvingKey === key || bulkApproving}
                onApprove={() => handleApprove(session)}
              />
            );
          })}
        </section>
      ))}

      <div className="ip-footer">
        Need to reassign or split? Open this issue in My Focus for more options.
      </div>

      <DescriptionQuality issueKey={issueKey} />
    </div>
  );
}
