import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@forge/bridge';
import { AssignmentModal, BulkEditModal, GroupAccordion, SelectionBar } from './unassigned';
import { formatTime } from '../utils';
import './UnassignedWork.css';

function UnassignedWork() {
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupTypeTab] = useState('all');
  const [quickFilter] = useState('all');
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

  const [syncingWithJira, setSyncingWithJira] = useState(false);
  const [syncBanner, setSyncBanner] = useState(null);
  const syncPollTimerRef = useRef(null);
  const syncJobIdRef = useRef(null);
  const syncPollInFlightRef = useRef(false);
  const unassignedRequestIdRef = useRef(0);

  // Sync timeframe and confirmation state
  const [syncTimeframe, setSyncTimeframe] = useState('');
  const [showSyncConfirmModal, setShowSyncConfirmModal] = useState(false);
  const [syncCounts, setSyncCounts] = useState(null);
  const [syncCountsLoading, setSyncCountsLoading] = useState(false);
  const [syncJobResult, setSyncJobResult] = useState(null);

  // Date range filter state
  const [dateFrom] = useState('');
  const [dateTo] = useState('');
  // How many activity records actually fall in the selected date range
  // (null = no filter active; number = count returned by the resolver)

  const isFirstRender = useRef(true);
  // True after the first successful load — used to avoid full-page loader on filter reloads
  const hasLoadedOnce = useRef(false);

  // Hoisted group-detail / work-session caches.
  // Lifted out of GroupAccordion so the upcoming multi-select layer can read
  // session_ids and per-interval data without expanding the accordion.
  const [groupDetails, setGroupDetails] = useState({});
  const [loadingDetails, setLoadingDetails] = useState({});
  const [groupWorkSessions, setGroupWorkSessions] = useState({});
  const [loadingWorkSessions, setLoadingWorkSessions] = useState({});

  const clearGroupCaches = () => {
    setGroupDetails({});
    setGroupWorkSessions({});
    setFullySelectedGroups(new Set());
    setSelectedIntervalsByGroup(new Map());
  };

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
      const result = await invoke('getGroupWorkSessions', {
        sessionIds,
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {})
      });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when date filter changes (skip the initial mount)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    clearGroupCaches();
    loadUnassignedWork(false, 0, { dateFrom, dateTo });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const loadUnassignedWork = async (append = false, retryCount = 0, dateOverrides = null) => {
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
      const activeDateFrom = dateOverrides ? dateOverrides.dateFrom : dateFrom;
      const activeDateTo = dateOverrides ? dateOverrides.dateTo : dateTo;

      const groupsPayload = { limit: GROUPS_PER_PAGE, offset };
      if (activeDateFrom) groupsPayload.dateFrom = activeDateFrom;
      if (activeDateTo) groupsPayload.dateTo = activeDateTo;

      const sessionsPayload = { limit: 100 };
      if (activeDateFrom) sessionsPayload.dateFrom = activeDateFrom;
      if (activeDateTo) sessionsPayload.dateTo = activeDateTo;

      // Fetch groups and sessions independently so a failure in one
      // request doesn't prevent the other result from being processed
      const [groupsOutcome, sessionsOutcome] = await Promise.allSettled([
        invoke('getUnassignedGroups', groupsPayload),
        !append ? invoke('getUnassignedWork', sessionsPayload) : Promise.resolve(null)
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
          // matched_activity_count: null = no filter, number = sessions in date range

        }

        setHasMoreGroups(groupsResult.has_more || false);
        setNextOffset(groupsResult.next_offset || 0);
        setTotalGroups(groupsResult.total_groups || 0);

        hasLoadedOnce.current = true;
        setLoading(false);
        setLoadingMore(false);
      } else if (!append && sessionsResult?.success && (sessionsResult.sessions || []).length > 0) {
        // Groups failed but sessions loaded — show what we have
        console.warn('[UnassignedWork] Groups query failed but sessions loaded:', groupsResult.error);
        hasLoadedOnce.current = true;
        setLoading(false);
        setLoadingMore(false);
      } else if (!append && retryCount < MAX_RETRIES) {
        console.warn(`[UnassignedWork] Attempt ${retryCount + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`, groupsResult.error);
        setTimeout(() => loadUnassignedWork(false, retryCount + 1, dateOverrides), RETRY_DELAY_MS);
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
        setTimeout(() => loadUnassignedWork(false, retryCount + 1, dateOverrides), RETRY_DELAY_MS);
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

  const clearSyncPolling = () => {
    if (syncPollTimerRef.current) {
      window.clearTimeout(syncPollTimerRef.current);
      syncPollTimerRef.current = null;
    }
  };

  const scheduleNextSyncPoll = (delayMs = 2500) => {
    clearSyncPolling();
    if (!syncJobIdRef.current) {
      return;
    }
    syncPollTimerRef.current = window.setTimeout(() => {
      pollSyncJobStatus();
    }, delayMs);
  };

  const buildSyncCompletedMessage = (result) => {
    const count = result?.matchedCount || 0;
    if (count > 0) {
      return `Sync complete. Automatically assigned ${count} session${count === 1 ? '' : 's'} to in-progress tickets.`;
    }
    if (result?.reason === 'no_previous_day_sessions') {
      return 'Sync complete. No unassigned work sessions were found from the previous day.';
    }
    if (result?.reason === 'no_in_progress_issues') {
      return 'Sync complete. No in-progress tickets were found for matching.';
    }
    if (result?.reason === 'no_llm_matches') {
      return `Sync complete. Reviewed ${result?.sessionsScanned || 0} previous-day session(s) against ${result?.issuesScanned || 0} in-progress ticket(s) - no high-confidence matches.`;
    }
    return 'Sync complete. No matching unassigned work found for the previous day.';
  };

  const isSyncTimeoutError = (err) => {
    const message = err?.message || '';
    return /Task timed out after 25\.00 seconds|FUNCTION_TIME_OUT/i.test(message);
  };

  const pollSyncJobStatus = async () => {
    const jobId = syncJobIdRef.current;
    if (!jobId || syncPollInFlightRef.current) return;
    syncPollInFlightRef.current = true;
    try {
      const status = await invoke('getUnassignedSyncWithJiraJobStatus', { jobId });
      if (!status?.success) {
        clearSyncPolling();
        setSyncingWithJira(false);
        setSyncBanner({ type: 'error', message: status?.error || 'Sync failed while polling job status' });
        return;
      }

      if (status.status === 'completed') {
        clearSyncPolling();
        syncJobIdRef.current = null;
        setSyncingWithJira(false);
        setSyncJobResult(status);
        await loadUnassignedWork();
        return;
      }

      if (status.status === 'failed') {
        clearSyncPolling();
        syncJobIdRef.current = null;
        setSyncingWithJira(false);
        setSyncJobResult({ error: status.error || 'Sync failed' });
        return;
      }

      // In-progress: just schedule next poll. We removed banner spam here
      // since the button loader handles the "syncing in progress" state.
      scheduleNextSyncPoll();
    } catch (err) {
      if (isSyncTimeoutError(err) && syncJobIdRef.current) {
        // Just continue polling quietly
        scheduleNextSyncPoll(1000);
      } else {
        clearSyncPolling();
        setSyncingWithJira(false);
        setSyncJobResult({ error: err?.message || 'Sync polling failed' });
      }
    } finally {
      syncPollInFlightRef.current = false;
    }
  };

  const initiateSyncWithJira = async () => {
    const timeframe = syncTimeframe || 'yesterday';
    setSyncCountsLoading(true);
    setShowSyncConfirmModal(true);
    setSyncCounts(null);
    setSyncJobResult(null);
    try {
      const result = await invoke('getUnassignedSyncCounts', { timeframe });
      if (result.success) {
        setSyncCounts({ groupCount: result.groupCount, memberCount: result.memberCount });
      } else {
        setSyncCounts({ error: result.error || 'Failed to fetch counts' });
      }
    } catch (err) {
      setSyncCounts({ error: err.message || 'Failed to fetch counts' });
    } finally {
      setSyncCountsLoading(false);
    }
  };

  const confirmSyncWithJira = async () => {
    const timeframe = syncTimeframe || 'yesterday';
    setSyncingWithJira(true);
    setSyncBanner(null);
    setSyncJobResult(null);
    clearSyncPolling();
    syncJobIdRef.current = null;

    try {
      const startResult = await invoke('startUnassignedSyncWithJiraJob', { timeframe });
      if (!startResult?.success) {
        setSyncJobResult({ error: startResult?.error || 'Sync failed to start' });
        setSyncingWithJira(false);
        return;
      }

      if (startResult.status === 'completed') {
        setSyncingWithJira(false);
        setSyncJobResult(startResult);
        await loadUnassignedWork();
        return;
      }

      if (!startResult.jobId) {
        setSyncingWithJira(false);
        setSyncJobResult({ error: 'Sync job did not return a valid job id' });
        return;
      }

      syncJobIdRef.current = startResult.jobId;
      await pollSyncJobStatus();
    } catch (err) {
      setSyncJobResult({ error: err?.message || 'Sync failed' });
      setSyncingWithJira(false);
    }
  };

  useEffect(() => () => {
    clearSyncPolling();
  }, []);

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
  const hasActiveFilter = !!(dateFrom || dateTo);

  const getTotalTime = (groupList = groups) => {
    return groupList.reduce((sum, g) => {
      if (hasActiveFilter && g.filtered_total_seconds !== null && g.filtered_total_seconds !== undefined) {
        return sum + (g.filtered_total_seconds || 0);
      }
      return sum + (g.total_seconds || 0);
    }, 0);
  };

  const getTotalSessions = (groupList = groups) => {
    return groupList.reduce((sum, g) => {
      if (hasActiveFilter && g.filtered_session_count !== null && g.filtered_session_count !== undefined) {
        return sum + (g.filtered_session_count || 0);
      }
      return sum + (g.session_count || 0);
    }, 0);
  };

  // Full-page loader only on the very first load (before any data has ever been shown)
  if (loading && !hasLoadedOnce.current) {
    return <div className="unassigned-work-container"><div className="loading">Loading unassigned work...</div></div>;
  }

  // Full-page error / empty only when we've never successfully loaded anything
  if (!hasLoadedOnce.current && error && sessions.length === 0 && groups.length === 0) {
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

  if (!hasLoadedOnce.current && sessions.length === 0 && groups.length === 0) {
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
      <div className="unassigned-work-header" style={{ marginBottom: '20px' }}>
        <div className="header-buttons-row" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <select
            className="sync-timeframe-dropdown"
            value={syncTimeframe}
            onChange={(e) => setSyncTimeframe(e.target.value)}
            disabled={syncingWithJira || syncCountsLoading}
            aria-label="Select timeframe for Jira sync"
          >
            <option value="" disabled hidden>Select Range</option>
            <option value="yesterday">Yesterday</option>
            <option value="last_3_days">Last 3 days</option>
            <option value="last_one_week">Last 7 days</option>
          </select>
          <button
            className="sync-with-jira-btn"
            onClick={initiateSyncWithJira}
            disabled={syncingWithJira || syncCountsLoading}
            title="Match unassigned work to your in-progress Jira tickets"
          >
            {syncingWithJira ? (
              <span className="sync-with-jira-spinner" aria-hidden="true" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10M1 14l5.36 5.36A9 9 0 0 0 20.49 15" />
              </svg>
            )}
            {syncingWithJira ? 'Syncing…' : 'Sync Mappings'}
          </button>
        </div>
        {syncBanner && (
          <div className={`sync-banner sync-banner--${syncBanner.type}`} role="status" style={{ marginTop: '12px' }}>
            {syncBanner.message}
          </div>
        )}
      </div>

      {/* Inline loading indicator — shown when re-fetching after a filter change */}
      {loading && (
        <div className="loading">Loading unassigned work...</div>
      )}

      {/* Inline error state — shown when a filter reload fails */}
      {!loading && error && groups.length === 0 && sessions.length === 0 && (
        <div className="empty-state">
          <p>Unable to load unassigned work data.</p>
          <p className="empty-subtitle">{error}</p>
          <button className="retry-btn" onClick={() => loadUnassignedWork(false, 0, dateFrom || dateTo ? { dateFrom, dateTo } : null)}>Retry</button>
        </div>
      )}

      {/* Empty state — no groups (and no sessions) for the selected date range */}
      {!loading && !error && groups.length === 0 && sessions.length === 0 && (dateFrom || dateTo) && (
        <div className="no-groups-message">
          <p>No unassigned work found for the selected date range.</p>
          <p>Try adjusting the dates or clearing the filter to see all sessions.</p>
        </div>
      )}

      {/* Empty state — no data at all, no filter active */}
      {!loading && !error && groups.length === 0 && sessions.length === 0 && !(dateFrom || dateTo) && (
        <div className="no-groups-message">
          <p>Great job! You don't have any unassigned work sessions.</p>
          <p>All your work time has been assigned to Jira issues.</p>
        </div>
      )}



      {!loading && displayedGroups.length === 0 && groups.length > 0 && (
        <div className="no-groups-message">
          <p>No groups found for this filter.</p>
          <p>Try switching tabs or quick filters to view more sessions.</p>
        </div>
      )}

      {/* Sessions exist in the date range but AI hasn't grouped them yet
           (clustering job runs on a delay — typically takes a few hours after activity) */}
      {!loading && groups.length === 0 && sessions.length > 0 && (
        <div className="no-groups-message">
          {(dateFrom || dateTo) ? (
            <>
              <p>Your sessions from this period haven't been grouped yet.</p>
              <p>The AI analyzes and groups your work sessions automatically, usually within a few hours. Check back later or clear the date filter to see already-grouped sessions.</p>
            </>
          ) : (
            <>
              <p>No groups available yet.</p>
              <p>Groups are created automatically when work sessions are analyzed.</p>
              <p>Check back shortly.</p>
            </>
          )}
        </div>
      )}

      {!loading && <GroupAccordion
        groups={displayedGroups}
        hasMoreGroups={hasMoreGroups}
        totalGroups={totalGroups}
        loadingMore={loadingMore}
        onLoadMore={loadMoreGroups}
        hasDateFilter={hasActiveFilter}
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
      />}

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

      {/* Sync Confirm Modal */}
      {showSyncConfirmModal && (
        <div className="sync-confirm-modal-overlay">
          <div className="sync-confirm-modal" style={syncJobResult ? { maxWidth: '600px' } : {}}>
            <div className="sync-confirm-modal-header">
              <h3>{syncJobResult ? 'Jira Sync Results' : 'Confirm Sync Mappings'}</h3>
              <button 
                className="sync-confirm-modal-close" 
                onClick={() => setShowSyncConfirmModal(false)}
                aria-label="Close modal"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="sync-confirm-content">
              {syncJobResult ? (
                syncJobResult.error ? (
                  <p className="sync-confirm-error">Error: {syncJobResult.error}</p>
                ) : (
                  <div>
                    <p className="sync-success-summary" style={{ fontWeight: '600', marginBottom: '12px' }}>
                      {buildSyncCompletedMessage(syncJobResult)}
                    </p>
                    {syncJobResult.matchedSessions && syncJobResult.matchedSessions.length > 0 && (
                      <div className="sync-matched-sessions" style={{ textAlign: 'left', background: '#F4F5F7', padding: '12px', borderRadius: '4px' }}>
                        <h4 style={{ marginTop: '0', marginBottom: '8px', fontSize: '14px' }}>Assigned Sessions:</h4>
                        <ul style={{ maxHeight: '200px', overflowY: 'auto', paddingLeft: '20px', margin: 0, fontSize: '13px' }}>
                          {syncJobResult.matchedSessions.map((session, idx) => (
                            <li key={idx} style={{ marginBottom: '8px' }}>
                              <strong>{session.issueKey}</strong> - {session.windowTitle || session.applicationName} 
                              <span style={{ color: '#6B778C', marginLeft: '8px' }}>({formatTime(session.durationSeconds)})</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              ) : (
                syncCountsLoading ? (
                  <p>Calculating sessions to sync...</p>
                ) : syncCounts?.error ? (
                  <p className="sync-confirm-error">Error: {syncCounts.error}</p>
                ) : (
                  <p>Are you sure you want to sync <strong>{syncCounts?.memberCount || 0} unassigned</strong> sessions across <strong>{syncCounts?.groupCount || 0} groups</strong> for the selected timeframe?</p>
                )
              )}
            </div>
            <div className="sync-confirm-actions">
              {syncJobResult ? (
                <button 
                  className="sync-confirm-btn" 
                  onClick={() => setShowSyncConfirmModal(false)}
                >
                  Close
                </button>
              ) : (
                <>
                  <button 
                    className="sync-cancel-btn" 
                    onClick={() => setShowSyncConfirmModal(false)}
                    disabled={syncingWithJira}
                  >
                    Cancel
                  </button>
                  <button 
                    className="sync-confirm-btn" 
                    onClick={confirmSyncWithJira}
                    disabled={syncingWithJira || syncCountsLoading || !!syncCounts?.error}
                  >
                    {syncingWithJira ? 'Syncing...' : 'Continue Sync'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default UnassignedWork;
