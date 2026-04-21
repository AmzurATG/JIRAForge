import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@forge/bridge';
import ReviewGroupCard from './needs-review/ReviewGroupCard';
import ReassignModal from './needs-review/ReassignModal';
import CreateIssueModal from './needs-review/CreateIssueModal';
import BulkActionBar from './needs-review/BulkActionBar';
import EmptyState from './needs-review/EmptyState';
import { formatTime } from '../utils';
import './NeedsReview.css';

const DATE_FILTERS = [
  { id: 'all', label: 'All dates' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' }
];

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function offsetDateISO(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function rangeForFilter(id) {
  if (id === 'all') return { from: null, to: null };
  if (id === 'today') return { from: todayISO(), to: todayISO() };
  if (id === 'yesterday') return { from: offsetDateISO(1), to: offsetDateISO(1) };
  if (id === 'week') return { from: offsetDateISO(6), to: todayISO() };
  return { from: null, to: null };
}

function humanDayLabel(workDate) {
  if (!workDate) return 'Unknown date';
  if (workDate === todayISO()) return `Today — ${workDate}`;
  if (workDate === offsetDateISO(1)) return `Yesterday — ${workDate}`;
  try {
    const d = new Date(workDate + 'T00:00:00');
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    return `${weekday} — ${workDate}`;
  } catch {
    return workDate;
  }
}

function NeedsReview({ activeIssues = [], onCountChange }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [totalGroups, setTotalGroups] = useState(0);
  const [error, setError] = useState(null);

  const [dateFilter, setDateFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [mutating, setMutating] = useState(false);

  const [reassignTarget, setReassignTarget] = useState(null);
  const [createTarget, setCreateTarget] = useState(null);

  const [toast, setToast] = useState(null);
  const [confirmBulkDate, setConfirmBulkDate] = useState(false);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadGroups = useCallback(async (opts = {}) => {
    const { append = false, offset = 0 } = opts;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const { from, to } = rangeForFilter(dateFilter);
      const result = await invoke('getPendingApprovalGroups', {
        limit: 20,
        offset,
        fromDate: from,
        toDate: to
      });
      if (result?.success) {
        setGroups(prev => append ? [...prev, ...(result.groups || [])] : (result.groups || []));
        setHasMore(!!result.hasMore);
        setNextOffset(result.nextOffset || 0);
        setTotalGroups(result.totalGroups || 0);
      } else {
        setError(result?.error || 'Failed to load pending approvals');
      }
    } catch (err) {
      setError(err?.message || 'Failed to load pending approvals');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    loadGroups();
    setSelectedKeys(new Set());
  }, [loadGroups]);

  const projectOptions = useMemo(() => {
    const keys = new Set();
    groups.forEach(g => { if (g.projectKey) keys.add(g.projectKey); });
    return Array.from(keys).sort();
  }, [groups]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return groups.filter(g => {
      if (projectFilter !== 'all' && g.projectKey !== projectFilter) return false;
      if (!q) return true;
      const haystacks = [
        g.issueKey,
        g.issueSummary,
        ...(g.sampleWindowTitles || [])
      ].map(v => (v || '').toLowerCase());
      return haystacks.some(h => h.includes(q));
    });
  }, [groups, projectFilter, searchQuery]);

  const groupsByDate = useMemo(() => {
    const map = new Map();
    filteredGroups.forEach(g => {
      const key = g.workDate || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(g);
    });
    const ordered = Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    return ordered;
  }, [filteredGroups]);

  const summary = useMemo(() => {
    let totalSeconds = 0;
    let oldest = null;
    filteredGroups.forEach(g => {
      totalSeconds += g.totalSeconds || 0;
      if (!oldest || (g.workDate && g.workDate < oldest)) oldest = g.workDate;
    });
    return {
      sessions: filteredGroups.length,
      totalSeconds,
      oldest
    };
  }, [filteredGroups]);

  const toggleSelectGroup = useCallback((groupKey) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  const selectedGroups = useMemo(
    () => filteredGroups.filter(g => selectedKeys.has(g.groupKey)),
    [filteredGroups, selectedKeys]
  );

  const refreshAll = useCallback(async () => {
    await loadGroups();
    if (onCountChange) onCountChange();
  }, [loadGroups, onCountChange]);

  const doApprove = useCallback(async (sessionIds, label) => {
    setMutating(true);
    try {
      const result = await invoke('approveRecords', { sessionIds });
      if (result?.success) {
        showToast(`${label} approved`, 'success');
        clearSelection();
        await refreshAll();
      } else {
        showToast(result?.error || 'Approval failed', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Approval failed', 'error');
    } finally {
      setMutating(false);
    }
  }, [showToast, clearSelection, refreshAll]);

  const handleApproveGroup = useCallback((group) => {
    return doApprove(group.sessionIds, `${group.recordCount} records on ${group.issueKey}`);
  }, [doApprove]);

  const handleApproveSelected = useCallback(() => {
    const ids = selectedGroups.flatMap(g => g.sessionIds);
    if (ids.length === 0) return;
    const total = selectedGroups.reduce((n, g) => n + (g.recordCount || 0), 0);
    return doApprove(ids, `${total} records across ${selectedGroups.length} sessions`);
  }, [selectedGroups, doApprove]);

  const handleApprovePartial = useCallback(async (group, recordIds) => {
    if (!recordIds?.length) return;
    return doApprove(recordIds, `${recordIds.length} of ${group.recordCount} records on ${group.issueKey}`);
  }, [doApprove]);

  const handleReassign = useCallback((group) => {
    setReassignTarget(group);
  }, []);

  const handleCreateIssue = useCallback((group) => {
    setCreateTarget(group);
  }, []);

  const handleReassignSelected = useCallback(() => {
    if (selectedGroups.length === 0) return;
    const sessionIds = selectedGroups.flatMap(g => g.sessionIds);
    const totalSeconds = selectedGroups.reduce((n, g) => n + (g.totalSeconds || 0), 0);
    const recordCount = selectedGroups.reduce((n, g) => n + (g.recordCount || 0), 0);
    setReassignTarget({
      groupKey: 'bulk',
      issueKey: selectedGroups.length === 1 ? selectedGroups[0].issueKey : 'multiple',
      sessionIds,
      totalSeconds,
      recordCount,
      workDate: selectedGroups[0]?.workDate
    });
  }, [selectedGroups]);

  const handleCreateIssueSelected = useCallback(() => {
    if (selectedGroups.length === 0) return;
    const sessionIds = selectedGroups.flatMap(g => g.sessionIds);
    const totalSeconds = selectedGroups.reduce((n, g) => n + (g.totalSeconds || 0), 0);
    const recordCount = selectedGroups.reduce((n, g) => n + (g.recordCount || 0), 0);
    setCreateTarget({
      groupKey: 'bulk',
      issueKey: selectedGroups.length === 1 ? selectedGroups[0].issueKey : 'multiple',
      sessionIds,
      totalSeconds,
      recordCount,
      workDate: selectedGroups[0]?.workDate,
      sampleWindowTitles: selectedGroups.flatMap(g => g.sampleWindowTitles || []).slice(0, 3)
    });
  }, [selectedGroups]);

  const submitReassign = useCallback(async ({ sessionIds, newIssueKey, reason }) => {
    setMutating(true);
    try {
      const result = await invoke('reassignAndApproveRecords', {
        sessionIds, newIssueKey, reason
      });
      if (result?.success) {
        showToast(`Records reassigned to ${newIssueKey}`, 'success');
        setReassignTarget(null);
        clearSelection();
        await refreshAll();
      } else {
        showToast(result?.error || 'Reassign failed', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Reassign failed', 'error');
    } finally {
      setMutating(false);
    }
  }, [showToast, clearSelection, refreshAll]);

  const submitCreateIssue = useCallback(async (payload) => {
    setMutating(true);
    try {
      const result = await invoke('createIssueAndApproveRecords', payload);
      if (result?.success) {
        showToast(`Issue ${result.issueKey} created and assigned`, 'success');
        setCreateTarget(null);
        clearSelection();
        await refreshAll();
      } else {
        showToast(result?.error || 'Failed to create issue', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Failed to create issue', 'error');
    } finally {
      setMutating(false);
    }
  }, [showToast, clearSelection, refreshAll]);

  const handleBulkApproveByDate = useCallback(async () => {
    const { from, to } = rangeForFilter(dateFilter);
    if (!from || !to) return;
    setMutating(true);
    setConfirmBulkDate(false);
    try {
      const result = await invoke('bulkApproveByDateRange', { fromDate: from, toDate: to });
      if (result?.success) {
        showToast(`${result.updated || 0} records approved`, 'success');
        clearSelection();
        await refreshAll();
      } else {
        showToast(result?.error || 'Bulk approve failed', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Bulk approve failed', 'error');
    } finally {
      setMutating(false);
    }
  }, [dateFilter, showToast, clearSelection, refreshAll]);

  const currentRange = rangeForFilter(dateFilter);
  const canBulkByDate = !!(currentRange.from && currentRange.to);

  if (loading) {
    return (
      <div className="needs-review-container">
        <div className="needs-review-header">
          <h2>Needs Review</h2>
          <p className="needs-review-subtitle">Review AI-assigned time before it syncs to Jira.</p>
        </div>
        <div className="needs-review-skeletons" aria-busy="true" aria-live="polite">
          {[0, 1, 2].map(i => <div key={i} className="review-card-skeleton" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="needs-review-container">
        <div className="needs-review-header">
          <h2>Needs Review</h2>
        </div>
        <div className="needs-review-error" role="alert">
          <div className="needs-review-error-message">{error}</div>
          <button className="needs-review-btn needs-review-btn--primary" onClick={() => loadGroups()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const hasAnyGroups = totalGroups > 0 || groups.length > 0;

  return (
    <div className="needs-review-container">
      <div className="needs-review-header">
        <div className="needs-review-header-top">
          <div>
            <h2>Needs Review</h2>
            <p className="needs-review-subtitle">
              Review AI-assigned time before it syncs to Jira.
            </p>
          </div>
        </div>

        {hasAnyGroups && (
          <div className="needs-review-summary-strip">
            <span><strong>{summary.sessions}</strong> session{summary.sessions === 1 ? '' : 's'} pending</span>
            <span className="needs-review-dot">·</span>
            <span><strong>{formatTime(summary.totalSeconds)}</strong> total</span>
            {summary.oldest && (
              <>
                <span className="needs-review-dot">·</span>
                <span>oldest: <strong>{summary.oldest}</strong></span>
              </>
            )}
          </div>
        )}
      </div>

      {!hasAnyGroups ? (
        <EmptyState />
      ) : (
        <>
          <div className="needs-review-controls">
            <div className="needs-review-filters">
              <div className="needs-review-segmented" role="tablist" aria-label="Date filter">
                {DATE_FILTERS.map(f => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={dateFilter === f.id}
                    className={`needs-review-segment ${dateFilter === f.id ? 'active' : ''}`}
                    onClick={() => setDateFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <label className="needs-review-select-wrap">
                <span className="needs-review-label">Project</span>
                <select
                  className="needs-review-select"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                >
                  <option value="all">All</option>
                  {projectOptions.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>

              <input
                className="needs-review-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search issue, summary, or activity…"
                aria-label="Search pending approvals"
              />
            </div>

            {canBulkByDate && (
              <button
                className="needs-review-btn needs-review-btn--secondary"
                onClick={() => setConfirmBulkDate(true)}
                disabled={mutating || filteredGroups.length === 0}
              >
                Approve all for {dateFilter === 'today' ? 'today' : dateFilter === 'yesterday' ? 'yesterday' : 'this week'}
              </button>
            )}
          </div>

          {filteredGroups.length === 0 ? (
            <div className="needs-review-no-matches">
              No sessions match the current filters.
            </div>
          ) : (
            <div className="needs-review-groups-list">
              {groupsByDate.map(([workDate, dayGroups]) => {
                const dayTotal = dayGroups.reduce((n, g) => n + (g.totalSeconds || 0), 0);
                return (
                  <div key={workDate} className="needs-review-day-section">
                    <div className="needs-review-day-header">
                      <span className="needs-review-day-label">{humanDayLabel(workDate)}</span>
                      <span className="needs-review-day-meta">
                        {dayGroups.length} session{dayGroups.length === 1 ? '' : 's'} · {formatTime(dayTotal)}
                      </span>
                    </div>
                    <div className="needs-review-day-cards">
                      {dayGroups.map(g => (
                        <ReviewGroupCard
                          key={g.groupKey}
                          group={g}
                          selected={selectedKeys.has(g.groupKey)}
                          onToggleSelect={() => toggleSelectGroup(g.groupKey)}
                          onApprove={() => handleApproveGroup(g)}
                          onReassign={() => handleReassign(g)}
                          onCreateIssue={() => handleCreateIssue(g)}
                          onApprovePartial={(recordIds) => handleApprovePartial(g, recordIds)}
                          mutating={mutating}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {hasMore && (
                <div className="needs-review-load-more-wrap">
                  <button
                    className="needs-review-btn needs-review-btn--secondary"
                    onClick={() => loadGroups({ append: true, offset: nextOffset })}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {selectedGroups.length > 0 && (
        <BulkActionBar
          count={selectedGroups.length}
          totalSeconds={selectedGroups.reduce((n, g) => n + (g.totalSeconds || 0), 0)}
          onApprove={handleApproveSelected}
          onReassign={handleReassignSelected}
          onCreateIssue={handleCreateIssueSelected}
          onClear={clearSelection}
          disabled={mutating}
        />
      )}

      {reassignTarget && (
        <ReassignModal
          target={reassignTarget}
          activeIssues={activeIssues}
          onClose={() => setReassignTarget(null)}
          onSubmit={submitReassign}
          submitting={mutating}
        />
      )}

      {createTarget && (
        <CreateIssueModal
          target={createTarget}
          onClose={() => setCreateTarget(null)}
          onSubmit={submitCreateIssue}
          submitting={mutating}
        />
      )}

      {confirmBulkDate && (
        <div className="needs-review-modal-overlay" onClick={() => setConfirmBulkDate(false)}>
          <div className="needs-review-modal" onClick={(e) => e.stopPropagation()}>
            <div className="needs-review-modal-header">
              <h3>Approve all for {dateFilter}?</h3>
              <button className="needs-review-modal-close" onClick={() => setConfirmBulkDate(false)}>×</button>
            </div>
            <div className="needs-review-modal-body">
              <p>
                This approves every pending record between <strong>{currentRange.from}</strong> and
                <strong> {currentRange.to}</strong>, including records not currently visible.
              </p>
              <p>Approved time will sync to Jira on the next hourly sync.</p>
            </div>
            <div className="needs-review-modal-footer">
              <button className="needs-review-btn needs-review-btn--tertiary" onClick={() => setConfirmBulkDate(false)}>
                Cancel
              </button>
              <button
                className="needs-review-btn needs-review-btn--primary"
                onClick={handleBulkApproveByDate}
                disabled={mutating}
              >
                {mutating ? 'Approving…' : 'Approve all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`needs-review-toast needs-review-toast--${toast.type}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default NeedsReview;
