import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@forge/bridge';
import { AssignmentModal, BulkEditModal, GroupAccordion, SelectionBar } from './unassigned';
import { AiDisclaimer } from './common/AiDisclaimer';
import { formatTime } from '../utils';
import './UnassignedWork.css';

function UnassignedWork() {
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupTypeTab, setGroupTypeTab] = useState('all');
  const [quickFilter, setQuickFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userIssues, setUserIssues] = useState([]);
  const [userProjects, setUserProjects] = useState([]);

  // Pagination state for lazy loading
  const [hasMoreGroups, setHasMoreGroups] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalGroups, setTotalGroups] = useState(0);
  const GROUPS_PER_PAGE = 10;

  // Modal states
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);

  // Notification settings state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [savingNotificationSettings, setSavingNotificationSettings] = useState(false);
  const unassignedRequestIdRef = useRef(0);

  // Hoisted group-detail / work-session caches.
  // Lifted out of GroupAccordion so the upcoming multi-select layer can read
  // session_ids and per-interval data without expanding the accordion.
  const [groupDetails, setGroupDetails] = useState({});
  const [loadingDetails, setLoadingDetails] = useState({});
  const [groupWorkSessions, setGroupWorkSessions] = useState({});
  const [loadingWorkSessions, setLoadingWorkSessions] = useState({});

  const loadGroupDetails = async (groupId) => {
    if (groupDetails[groupId]) return groupDetails[groupId];
    setLoadingDetails(prev => ({ ...prev, [groupId]: true }));
    try {
      const result = await invoke('getGroupDetails', { groupId });
      if (result?.success) {
        setGroupDetails(prev => ({ ...prev, [groupId]: result }));
        return result;
      }
      console.error('[UnassignedWork] getGroupDetails failed:', result?.error);
      return null;
    } catch (err) {
      console.error('[UnassignedWork] loadGroupDetails error:', err);
      return null;
    } finally {
      setLoadingDetails(prev => ({ ...prev, [groupId]: false }));
    }
  };

  const loadGroupWorkSessions = async (groupId, sessionIds) => {
    if (groupWorkSessions[groupId]) return groupWorkSessions[groupId];
    if (!sessionIds || sessionIds.length === 0) return [];
    setLoadingWorkSessions(prev => ({ ...prev, [groupId]: true }));
    try {
      const result = await invoke('getGroupWorkSessions', { sessionIds });
      if (result?.success) {
        const dateGroups = result.dateGroups || [];
        setGroupWorkSessions(prev => ({ ...prev, [groupId]: dateGroups }));
        return dateGroups;
      }
      console.error('[UnassignedWork] getGroupWorkSessions failed:', result?.error);
      return null;
    } catch (err) {
      console.error('[UnassignedWork] loadGroupWorkSessions error:', err);
      return null;
    } finally {
      setLoadingWorkSessions(prev => ({ ...prev, [groupId]: false }));
    }
  };

  // Multi-select state.
  // - fullySelectedGroups: groups checked at the header level (all intervals)
  // - selectedIntervalsByGroup: partial selections (subset of intervals checked)
  // A group is in at most one of the two structures at a time.
  const [fullySelectedGroups, setFullySelectedGroups] = useState(new Set());
  const [selectedIntervalsByGroup, setSelectedIntervalsByGroup] = useState(new Map());
  const [pendingFullSelectGroupIds, setPendingFullSelectGroupIds] = useState(new Set());

  const intervalKey = (session) =>
    (session.activityIds || []).slice().sort().join('|');

  const isGroupFullySelected = (groupId) => fullySelectedGroups.has(groupId);
  const isGroupPartiallySelected = (groupId) =>
    !fullySelectedGroups.has(groupId) && (selectedIntervalsByGroup.get(groupId)?.size || 0) > 0;
  const isIntervalSelected = (groupId, session) => {
    if (fullySelectedGroups.has(groupId)) return true;
    return selectedIntervalsByGroup.get(groupId)?.has(intervalKey(session)) || false;
  };

  const toggleGroupSelection = async (group) => {
    const groupId = group.id;
    const isAnySelected = fullySelectedGroups.has(groupId)
      || (selectedIntervalsByGroup.get(groupId)?.size || 0) > 0;

    if (isAnySelected) {
      setFullySelectedGroups(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
      setSelectedIntervalsByGroup(prev => {
        const next = new Map(prev);
        next.delete(groupId);
        return next;
      });
      return;
    }

    // Not selected — ensure details loaded so the assign payload has session_ids
    if (!groupDetails[groupId]) {
      setPendingFullSelectGroupIds(prev => new Set(prev).add(groupId));
      try {
        const details = await loadGroupDetails(groupId);
        if (!details) return; // load failed; leave checkbox unchecked
      } finally {
        setPendingFullSelectGroupIds(prev => {
          const next = new Set(prev);
          next.delete(groupId);
          return next;
        });
      }
    }
    setFullySelectedGroups(prev => new Set(prev).add(groupId));
  };

  const toggleIntervalSelection = (group, session) => {
    const groupId = group.id;
    const key = intervalKey(session);
    const allKeysForGroup = () => {
      const dateGroups = groupWorkSessions[groupId] || [];
      return dateGroups.flatMap(dg => dg.sessions.map(intervalKey));
    };

    // Demote full → partial-minus-this-one
    if (fullySelectedGroups.has(groupId)) {
      const remaining = new Set(allKeysForGroup().filter(k => k !== key));
      setFullySelectedGroups(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
      setSelectedIntervalsByGroup(prev => {
        const next = new Map(prev);
        if (remaining.size === 0) next.delete(groupId);
        else next.set(groupId, remaining);
        return next;
      });
      return;
    }

    const current = selectedIntervalsByGroup.get(groupId) || new Set();
    const updated = new Set(current);
    if (updated.has(key)) updated.delete(key);
    else updated.add(key);

    // Promote partial → full when set covers every interval
    const allKeys = allKeysForGroup();
    if (allKeys.length > 0 && updated.size === allKeys.length) {
      setFullySelectedGroups(prev => new Set(prev).add(groupId));
      setSelectedIntervalsByGroup(prev => {
        const next = new Map(prev);
        next.delete(groupId);
        return next;
      });
      return;
    }

    setSelectedIntervalsByGroup(prev => {
      const next = new Map(prev);
      if (updated.size === 0) next.delete(groupId);
      else next.set(groupId, updated);
      return next;
    });
  };

  const clearSelection = () => {
    setFullySelectedGroups(new Set());
    setSelectedIntervalsByGroup(new Map());
  };

  // Surgically remove a session from both caches and prune any selection state
  // that still references it. Centralising this prevents the "ghost selection"
  // bug where a fully-selected group is left in fullySelectedGroups while its
  // cached session_ids have been wiped out — buildSelectionPayload would then
  // silently contribute zero sessions. Called from any code path that removes
  // a session (currently just dismiss, but new call sites must use this helper
  // rather than touching setGroupDetails / setGroupWorkSessions directly).
  const removeSessionFromGroupCache = (groupId, session) => {
    const removedIds = new Set(session.activityIds || []);
    const removedKey = intervalKey(session);
    const removedSeconds = session.durationSeconds || 0;

    setGroupDetails(prev => {
      const existing = prev[groupId];
      if (!existing) return prev;
      const nextSessionIds = (existing.session_ids || []).filter(id => !removedIds.has(id));
      const nextSeconds = Math.max(0, (existing.total_seconds || 0) - removedSeconds);
      // session_count tracks unassigned_group_members rows. Backend deletes one
      // row per activityId (see dismissGroupMember), so the decrement matches
      // removedIds.size, not just 1 — a session can carry multiple activityIds.
      return {
        ...prev,
        [groupId]: {
          ...existing,
          session_ids: nextSessionIds,
          session_count: Math.max(0, (existing.session_count || 0) - removedIds.size),
          total_seconds: nextSeconds,
          total_time_formatted: formatTime(nextSeconds)
        }
      };
    });

    setGroupWorkSessions(prev => {
      const dateGroups = prev[groupId];
      if (!dateGroups) return prev;
      const updated = dateGroups
        .map(dg => ({
          ...dg,
          sessions: dg.sessions.filter(s => s !== session),
          totalSeconds: Math.max(0, (dg.totalSeconds || 0) - removedSeconds)
        }))
        .filter(dg => dg.sessions.length > 0);
      return { ...prev, [groupId]: updated };
    });

    // If this session was part of a partial selection, drop its key. Full-group
    // selections don't need pruning — they reference the group, not the session,
    // and the updated groupDetails above keeps session_ids in sync.
    setSelectedIntervalsByGroup(prev => {
      const current = prev.get(groupId);
      if (!current || !current.has(removedKey)) return prev;
      const updated = new Set(current);
      updated.delete(removedKey);
      const next = new Map(prev);
      if (updated.size === 0) next.delete(groupId);
      else next.set(groupId, updated);
      return next;
    });
  };

  // Derived summary for the selection bar.
  // sessionCount counts underlying activity_records (matches the page header's "sessions" wording).
  const selectionSummary = (() => {
    let groupCount = 0;
    let sessionCount = 0;
    let totalSeconds = 0;

    for (const groupId of fullySelectedGroups) {
      const g = groups.find(grp => grp.id === groupId);
      if (!g) continue;
      groupCount += 1;
      sessionCount += g.session_count || 0;
      totalSeconds += g.total_seconds || 0;
    }

    for (const [groupId, intervalSet] of selectedIntervalsByGroup) {
      if (intervalSet.size === 0) continue;
      groupCount += 1;
      const dateGroups = groupWorkSessions[groupId] || [];
      for (const dg of dateGroups) {
        for (const session of dg.sessions) {
          if (intervalSet.has(intervalKey(session))) {
            sessionCount += (session.activityIds || []).length;
            totalSeconds += session.durationSeconds || 0;
          }
        }
      }
    }

    return { groupCount, sessionCount, totalSeconds };
  })();

  // Build the payload sent to the assignment resolver from the current selection.
  // sessionIds = combined deduped activity_record UUIDs across full + partial selections.
  const buildSelectionPayload = () => {
    const sessionIds = new Set();
    const groupIds = new Set();

    for (const groupId of fullySelectedGroups) {
      const details = groupDetails[groupId];
      if (details?.session_ids) {
        details.session_ids.forEach(id => sessionIds.add(id));
        groupIds.add(groupId);
      }
    }

    for (const [groupId, intervalSet] of selectedIntervalsByGroup) {
      if (intervalSet.size === 0) continue;
      groupIds.add(groupId);
      const dateGroups = groupWorkSessions[groupId] || [];
      for (const dg of dateGroups) {
        for (const session of dg.sessions) {
          if (intervalSet.has(intervalKey(session))) {
            (session.activityIds || []).forEach(id => sessionIds.add(id));
          }
        }
      }
    }

    return {
      sessionIds: [...sessionIds],
      groupIds: [...groupIds],
      totalSeconds: selectionSummary.totalSeconds,
      sessionCount: selectionSummary.sessionCount
    };
  };

  useEffect(() => {
    loadUnassignedWork();
    loadUserIssues();
    loadUserProjects();
    loadNotificationSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadNotificationSettings = async () => {
    try {
      const result = await invoke('getUnassignedNotificationSettings');
      if (result.success && result.settings) {
        setNotificationsEnabled(result.settings.unassignedWorkNotificationsEnabled ?? true);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error loading notification settings:', err);
    }
  };

  const handleToggleNotifications = async () => {
    const newValue = !notificationsEnabled;
    setSavingNotificationSettings(true);

    try {
      const result = await invoke('saveUnassignedNotificationSettings', {
        settings: {
          unassignedWorkNotificationsEnabled: newValue
        }
      });

      if (result.success) {
        setNotificationsEnabled(newValue);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error saving notification settings:', err);
    } finally {
      setSavingNotificationSettings(false);
    }
  };

  const loadUnassignedWork = async (append = false, retryCount = 0) => {
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 3000;
    const requestId = unassignedRequestIdRef.current + 1;
    unassignedRequestIdRef.current = requestId;

    if (!append) {
      setLoading(true);
      setError(null);
    }

    try {
      const offset = append ? nextOffset : 0;

      // Fetch groups and sessions independently so a failure in one
      // request doesn't prevent the other result from being processed
      const [groupsOutcome, sessionsOutcome] = await Promise.allSettled([
        invoke('getUnassignedGroups', { limit: GROUPS_PER_PAGE, offset }),
        !append ? invoke('getUnassignedWork', { limit: 100 }) : Promise.resolve(null)
      ]);

      const groupsResult = groupsOutcome.status === 'fulfilled'
        ? groupsOutcome.value
        : { success: false, error: groupsOutcome.reason?.message || 'Failed to load unassigned groups' };

      const sessionsResult = sessionsOutcome.status === 'fulfilled'
        ? sessionsOutcome.value
        : { success: false, error: sessionsOutcome.reason?.message || 'Failed to load unassigned work' };

      if (requestId !== unassignedRequestIdRef.current) {
        return;
      }

      // Process sessions (independent of groups success)
      if (!append && sessionsResult?.success) {
        setSessions(sessionsResult.sessions || []);
      }

      // Process groups
      if (groupsResult.success) {
        const newGroups = groupsResult.groups || [];

        if (append) {
          setGroups(prev => [...prev, ...newGroups]);
        } else {
          setGroups(newGroups);
        }

        setHasMoreGroups(groupsResult.has_more || false);
        setNextOffset(groupsResult.next_offset || 0);
        setTotalGroups(groupsResult.total_groups || 0);

        setLoading(false);
        setLoadingMore(false);
      } else if (!append && sessionsResult?.success && (sessionsResult.sessions || []).length > 0) {
        // Groups failed but sessions loaded — show what we have
        console.warn('[UnassignedWork] Groups query failed but sessions loaded:', groupsResult.error);
        setLoading(false);
        setLoadingMore(false);
      } else if (!append && retryCount < MAX_RETRIES) {
        console.warn(`[UnassignedWork] Attempt ${retryCount + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`, groupsResult.error);
        setTimeout(() => loadUnassignedWork(false, retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[UnassignedWork] Load failed:', groupsResult.error);
        setError(groupsResult.error || 'Failed to load unassigned work');
        setLoading(false);
        setLoadingMore(false);
      }
    } catch (err) {
      if (requestId !== unassignedRequestIdRef.current) {
        return;
      }
      if (!append && retryCount < MAX_RETRIES) {
        console.warn(`[UnassignedWork] Attempt ${retryCount + 1} threw, retrying in ${RETRY_DELAY_MS}ms...`, err);
        setTimeout(() => loadUnassignedWork(false, retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[UnassignedWork] Load error:', err);
        setError(err.message || 'Failed to load unassigned work');
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const loadMoreGroups = async () => {
    if (loadingMore || !hasMoreGroups) return;
    setLoadingMore(true);
    await loadUnassignedWork(true);
  };

  const loadUserIssues = async () => {
    try {
      const result = await invoke('getAllUserAssignedIssues');
      if (result.success) {
        setUserIssues(result.issues || []);
      }
    } catch (err) {
      console.error('Error loading user issues:', err);
    }
  };

  const loadUserProjects = async () => {
    try {
      const result = await invoke('getUserProjects');
      if (result.success) {
        setUserProjects(result.projects || []);
      }
    } catch (err) {
      console.error('Error loading user projects:', err);
    }
  };

  // Assignment handlers
  const handleAssignClick = (groupWithDetails) => {
    setSelectedGroup(groupWithDetails);
    setShowAssignModal(true);
  };

  const handleAssignmentComplete = () => {
    setSelectedGroup(null);
    clearSelection();
    loadUnassignedWork();
  };

  const handleAssignSelection = () => {
    const payload = buildSelectionPayload();
    if (payload.sessionIds.length === 0) return;

    // Synthesize a group-like object so AssignmentModal can render.
    // Always set id=null — both resolver paths (Assign-to-Existing and Create-New)
    // have multi-group-aware variants that correctly handle full vs partial coverage
    // via member-set comparison, so we don't need a special "full single group" route.
    const singleGroup = payload.groupIds.length === 1
      ? groups.find(g => g.id === payload.groupIds[0])
      : null;

    setSelectedGroup({
      id: null,
      groupIds: payload.groupIds,
      session_ids: payload.sessionIds,
      session_count: payload.sessionCount,
      total_seconds: payload.totalSeconds,
      total_time_formatted: formatTime(payload.totalSeconds),
      label: singleGroup?.label || `${payload.groupIds.length} groups selected`,
      description: singleGroup?.description || null,
      recommendation: singleGroup?.recommendation || null
    });
    setShowAssignModal(true);
  };

  const handleDeleteSelection = async () => {
    const payload = buildSelectionPayload();
    if (payload.sessionIds.length === 0) return;

    // Confirmation dialog
    const groupLabel = payload.groupIds.length === 1 ? 'group' : 'groups';
    const sessionLabel = payload.sessionCount === 1 ? 'session' : 'sessions';
    const confirmMsg = `Delete ${payload.groupIds.length} ${groupLabel} (${payload.sessionCount} ${sessionLabel}, ${formatTime(payload.totalSeconds)})?

This will permanently dismiss these sessions from clustering. They won't appear in unassigned work again.`;

    if (!window.confirm(confirmMsg)) {
      return;
    }

    try {
      // Call new backend resolver
      const result = await invoke('deleteSelectedSessions', {
        sessionIds: payload.sessionIds,
        groupIds: payload.groupIds
      });

      if (result.success) {
        // Remove fully dismissed groups from UI
        setGroups(prev => prev.filter(g => !result.fullyDismissedGroupIds.includes(g.id)));
        setTotalGroups(prev => Math.max(0, prev - result.fullyDismissedGroupIds.length));

        // Clear caches for affected groups
        result.groupIds.forEach(gid => {
          setGroupDetails(prev => {
            const next = { ...prev };
            delete next[gid];
            return next;
          });
          setGroupWorkSessions(prev => {
            const next = { ...prev };
            delete next[gid];
            return next;
          });
        });

        // Clear selection state
        clearSelection();

        console.log(`[UnassignedWork] ✓ Deleted ${result.dismissedSessionCount} sessions across ${result.groupIds.length} groups`);
      } else {
        const errorMsg = result.error || 'Unknown error';
        console.error('[UnassignedWork] Delete selected failed:', errorMsg);
        alert(`Failed to delete sessions: ${errorMsg}`);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error deleting selection:', err);
      alert(`Error deleting sessions: ${err.message || String(err)}`);
    }
  };

  // Dismiss handlers
  const handleDismissGroup = async (groupId) => {
    try {
      const result = await invoke('dismissUnassignedGroup', { groupId });
      if (result.success) {
        setGroups(prev => prev.filter(g => g.id !== groupId));
        setTotalGroups(prev => Math.max(0, prev - 1));
        console.log(`[UnassignedWork] ✓ Group ${groupId} dismissed successfully`);
      } else {
        const errorMsg = result.error || 'Unknown error';
        console.error('[UnassignedWork] Dismiss group failed:', errorMsg);
        alert(`Failed to delete group: ${errorMsg}`);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error dismissing group:', err);
      alert(`Error deleting group: ${err.message || String(err)}`);
    }
  };

  const handleDismissMember = async (groupId, session) => {
    try {
      const sessionIds = session.activityIds || [];
      if (sessionIds.length === 0) {
        console.warn('[UnassignedWork] No activity IDs to dismiss for session');
        return;
      }
      
      // Sequential — each call reads then writes session_count; parallel would cause a race condition
      for (const sessionId of sessionIds) {
        const result = await invoke('dismissGroupMember', { groupId, sessionId });
        if (!result.success) {
          const errorMsg = result.error || 'Unknown error';
          console.error(`[UnassignedWork] Failed to dismiss member ${sessionId}: ${errorMsg}`);
          alert(`Failed to remove session: ${errorMsg}`);
          return;
        }
      }
      
      setGroups(prev => prev.map(g =>
        g.id === groupId
          ? { ...g, session_count: Math.max(0, (g.session_count || 0) - sessionIds.length) }
          : g
      ));
      removeSessionFromGroupCache(groupId, session);
      console.log(`[UnassignedWork] ✓ Removed ${sessionIds.length} session(s) from group ${groupId}`);
    } catch (err) {
      console.error('[UnassignedWork] Error dismissing member:', err);
      alert(`Error removing session: ${err.message || String(err)}`);
    }
  };

  // Bulk edit handlers
  const handleBulkEditSuccess = () => {
    loadUnassignedWork();
  };

  useEffect(() => {
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupTypeTab, quickFilter]);

  const groupTypeCounts = useMemo(() => {
    const counts = { all: groups.length, work: 0, idle: 0 };
    groups.forEach(group => {
      if (group.group_type === 'idle') counts.idle += 1;
      else counts.work += 1;
    });
    return counts;
  }, [groups]);

  const displayedGroups = useMemo(() => {
    const byType = groups.filter(group => {
      if (groupTypeTab === 'all') return true;
      const type = group.group_type || 'work';
      return type === groupTypeTab;
    });

    return byType.filter(group => {
      if (quickFilter === 'all') return true;
      if (quickFilter === 'recommended') return Boolean(group.recommendation);
      if (quickFilter === 'review') return !group.recommendation;
      return true;
    });
  }, [groups, groupTypeTab, quickFilter]);

  // Summary calculations
  const getTotalTime = (groupList = groups) => {
    return groupList.reduce((sum, g) => sum + (g.total_seconds || 0), 0);
  };

  const getTotalSessions = (groupList = groups) => {
    return groupList.reduce((sum, g) => sum + (g.session_count || 0), 0);
  };

  if (loading) {
    return <div className="unassigned-work-container"><div className="loading">Loading unassigned work...</div></div>;
  }

  if (error && sessions.length === 0 && groups.length === 0) {
    return (
      <div className="unassigned-work-container">
        <h2>Unassigned Work</h2>
        <div className="empty-state">
          <p>Unable to load unassigned work data.</p>
          <p className="empty-subtitle">{error}</p>
          <button className="retry-btn" onClick={() => loadUnassignedWork()}>Retry</button>
        </div>
      </div>
    );
  }

  if (sessions.length === 0 && groups.length === 0) {
    return (
      <div className="unassigned-work-container">
        <h2>Unassigned Work</h2>
        <div className="empty-state">
          <p>Great job! You don't have any unassigned work sessions.</p>
          <p className="empty-subtitle">All your work time has been assigned to Jira issues.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="unassigned-work-container">
      <div className="unassigned-work-header">
        <div className="header-top-row">
          <h2>Unassigned Work</h2>
          <div className="header-buttons-row">
            <button
              className="bulk-time-edit-btn"
              onClick={() => setShowBulkEditModal(true)}
              title="Bulk reassign activities by time interval"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              Bulk Time Edit
            </button>
          </div>
        </div>
        <div className="unassigned-work-summary">
          <span className="summary-item">
            <strong>{getTotalSessions(displayedGroups)}</strong> sessions
          </span>
          <span className="summary-divider">•</span>
          <span className="summary-item">
            <strong>{displayedGroups.length}</strong> groups
          </span>
          <span className="summary-divider">•</span>
          <span className="summary-item">
            <strong>{formatTime(getTotalTime(displayedGroups))}</strong> total time
          </span>
        </div>

        <div className="quick-filter-row" role="group" aria-label="Quick filters">
          <button
            type="button"
            className={`group-type-tab${groupTypeTab === 'all' ? ' active' : ''}`}
            onClick={() => { setGroupTypeTab('all'); setQuickFilter('all'); }}
          >
            All ({groupTypeCounts.all})
          </button>
          <button
            type="button"
            className={`quick-filter-btn${quickFilter === 'recommended' ? ' active' : ''}`}
            onClick={() => setQuickFilter('recommended')}
          >
            AI Recommended
          </button>
          <button
            type="button"
            className={`quick-filter-btn${quickFilter === 'review' ? ' active' : ''}`}
            onClick={() => setQuickFilter('review')}
          >
            Needs Review
          </button>
          <button
            type="button"
            className={`group-type-tab${groupTypeTab === 'work' ? ' active' : ''}`}
            onClick={() => { setGroupTypeTab('work'); setQuickFilter('all'); }}
          >
            Unassigned Work ({groupTypeCounts.work})
          </button>
          <button
            type="button"
            className={`group-type-tab${groupTypeTab === 'idle' ? ' active' : ''}`}
            onClick={() => { setGroupTypeTab('idle'); setQuickFilter('all'); }}
          >
            Idle Sessions ({groupTypeCounts.idle})
          </button>
        </div>
      </div>

      {displayedGroups.length > 0 && (
        <AiDisclaimer 
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          savingNotificationSettings={savingNotificationSettings}
        />
      )}

      {displayedGroups.length === 0 && groups.length > 0 && (
        <div className="no-groups-message">
          <p>No groups found for this filter.</p>
          <p>Try switching tabs or quick filters to view more sessions.</p>
        </div>
      )}

      {groups.length === 0 && sessions.length > 0 && (
        <div className="no-groups-message">
          <p>No groups available yet.</p>
          <p>Groups are created automatically when work sessions are analyzed.</p>
          <p>Check back shortly.</p>
        </div>
      )}

      <GroupAccordion
        groups={displayedGroups}
        hasMoreGroups={hasMoreGroups}
        totalGroups={totalGroups}
        loadingMore={loadingMore}
        onLoadMore={loadMoreGroups}
        onAssignClick={handleAssignClick}
        onDismissGroup={handleDismissGroup}
        onDismissMember={handleDismissMember}
        groupDetails={groupDetails}
        loadingDetails={loadingDetails}
        groupWorkSessions={groupWorkSessions}
        loadingWorkSessions={loadingWorkSessions}
        loadGroupDetails={loadGroupDetails}
        loadGroupWorkSessions={loadGroupWorkSessions}
        isGroupFullySelected={isGroupFullySelected}
        isGroupPartiallySelected={isGroupPartiallySelected}
        isIntervalSelected={isIntervalSelected}
        onToggleGroupSelection={toggleGroupSelection}
        onToggleIntervalSelection={toggleIntervalSelection}
        pendingFullSelectGroupIds={pendingFullSelectGroupIds}
        hasAnySelection={selectionSummary.groupCount > 0}
      />

      <SelectionBar
        groupCount={selectionSummary.groupCount}
        sessionCount={selectionSummary.sessionCount}
        totalSeconds={selectionSummary.totalSeconds}
        onClear={clearSelection}
        onAssign={handleAssignSelection}
        onDelete={handleDeleteSelection}
      />

      {/* Assignment Modal */}
      <AssignmentModal
        isOpen={showAssignModal}
        selectedGroup={selectedGroup}
        userIssues={userIssues}
        userProjects={userProjects}
        onClose={() => setShowAssignModal(false)}
        onAssignmentComplete={handleAssignmentComplete}
      />

      {/* Bulk Time Edit Modal */}
      <BulkEditModal
        isOpen={showBulkEditModal}
        userIssues={userIssues}
        onClose={() => setShowBulkEditModal(false)}
        onSuccess={handleBulkEditSuccess}
      />
    </div>
  );
}

export default UnassignedWork;
