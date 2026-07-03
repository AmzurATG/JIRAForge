import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../../utils';
import { normalizeDate, formatLocalDate, parseUTC } from './dateUtils';
import { useApp } from '../../../context';
import DayIssueDrilldown from './DayIssueDrilldown';

/**
 * Day View Component
 * Displays today's timesheet with team member cards and activity timeline
 */
function DayView({ loading, timeData, onTodayTotalReconciled, onOpenWorklogReassignModal, summaryDrillDate }) {
  const { loadActiveIssues } = useApp();
  const [timelineData, setTimelineData] = useState(null);
  const [myTimelineData, setMyTimelineData] = useState(null);
  const [convertingIdle, setConvertingIdle] = useState(null); // { id, startTime, endTime, durationSeconds }
  const [convertingUnassigned, setConvertingUnassigned] = useState(null); // { sessionIds: [], startTime, endTime, durationSeconds }
  const [convertForm, setConvertForm] = useState({ issueKey: '', reason: '', mode: 'existing', projectKey: '' }); // mode: 'existing' | 'new'
  const [convertLoading, setConvertLoading] = useState(false);
  const [convertStatus, setConvertStatus] = useState(null); // { type: 'success'|'error'|'warning', text: string }
  const [userProjects, setUserProjects] = useState([]); // Projects for "Create New" dropdown
  const [userIssues, setUserIssues] = useState([]); // Issues for "Existing Issue" dropdown
  const [issueSearch, setIssueSearch] = useState(''); // Filter text for issue dropdown
  const [dropdownsLoading, setDropdownsLoading] = useState(false);
  // Empty object constant — the expand-user feature below is gated behind `false &&`
  // and cannot mutate this. When the feature is re-enabled, restore useState.
  const expandedUsers = {};

  const [selectedDate, setSelectedDate] = useState(null);
  const popoverRef = useRef(null);
  // Helper function to get user initials
  const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  // Helper function to generate consistent avatar colors
  const getAvatarColor = (name) => {
    const colors = [
      '#0052CC', // Blue
      '#00875A', // Green
      '#FF5630', // Red
      '#6554C0', // Purple
      '#FF991F', // Orange
      '#00B8D9', // Cyan
      '#36B37E', // Teal
      '#FFAB00', // Yellow
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };
  const today = new Date();
  const todayStr = formatLocalDate(today);

  useEffect(() => {
    if (summaryDrillDate && summaryDrillDate === todayStr) {
      setSelectedDate(todayStr);
    }
  }, [summaryDrillDate, todayStr]);

  // Fetch timeline data for today
  useEffect(() => {
    const fetchTimeline = async () => {
      try {
        if (timeData?.canViewAllUsers) {
          // Admin: fetch all users' timeline
          const result = await invoke('getTeamDayTimeline', { 
            projectKey: null, // All projects
            date: todayStr 
          });
          if (result.success) {
            console.log('[DayView] Team timeline API success:',
              'usersWithActivity:', result.data?.usersWithActivity?.length || 0,
              'users:', result.data?.usersWithActivity?.map(u => ({
                id: u.userId, name: u.displayName, sessions: u.sessions?.length || 0
              }))
            );
            setTimelineData(result.data);
          } else {
            console.warn('Failed to fetch team timeline:', result.error);
            // Initialize with empty data so timeline still renders
            setTimelineData({ usersWithActivity: [], usersWithoutActivity: [] });
          }
        } else {
          // Regular user: fetch only their own timeline
          const result = await invoke('getMyDayTimeline', { 
            date: todayStr 
          });
          if (result.success) {
            setMyTimelineData(result.data);
          } else {
            console.warn('Failed to fetch my timeline:', result.error);
            // Initialize with empty data so timeline still renders
            setMyTimelineData({ sessions: [], userId: null });
          }
        }
      } catch (err) {
        console.error('Failed to load timeline:', err);
        // Initialize with empty data so timeline structure still renders
        if (timeData?.canViewAllUsers) {
          setTimelineData({ usersWithActivity: [], usersWithoutActivity: [] });
        } else {
          setMyTimelineData({ sessions: [], userId: null });
        }
      }
    };

    if (timeData && !loading) {
      fetchTimeline();
    }
  }, [timeData, loading, todayStr]);

  // Compute dynamic timeline range from actual activity data
  const getTimelineRange = () => {
    let allSessions = [];

    if (timeData?.canViewAllUsers && timelineData) {
      timelineData.usersWithActivity?.forEach(user => {
        if (user.sessions) {
          allSessions = allSessions.concat(user.sessions);
        }
        // Include idle blocks in range calculation
        if (user.idleBlocks) {
          allSessions = allSessions.concat(user.idleBlocks.map(b => ({
            endTime: b.endTime,
            durationSeconds: b.durationSeconds
          })));
        }
        // Include unassigned blocks in range calculation
        if (user.unassignedBlocks) {
          allSessions = allSessions.concat(user.unassignedBlocks.map(b => ({
            endTime: b.endTime,
            durationSeconds: b.durationSeconds
          })));
        }
      });
    } else if (myTimelineData) {
      if (myTimelineData.sessions) {
        allSessions = myTimelineData.sessions;
      }
      if (myTimelineData.idleBlocks) {
        allSessions = allSessions.concat(myTimelineData.idleBlocks.map(b => ({
          endTime: b.endTime,
          durationSeconds: b.durationSeconds
        })));
      }
      if (myTimelineData.unassignedBlocks) {
        allSessions = allSessions.concat(myTimelineData.unassignedBlocks.map(b => ({
          endTime: b.endTime,
          durationSeconds: b.durationSeconds
        })));
      }
    }

    if (allSessions.length === 0) {
      return { startHour: 8, endHour: 18 };
    }

    const todayMidnight = new Date(today);
    todayMidnight.setHours(0, 0, 0, 0);

    let minHours = Infinity;
    let maxHours = -Infinity;

    allSessions.forEach(session => {
      const end = parseUTC(session.endTime || session.timestamp);
      if (!end) return;

      // Calculate actual work start from endTime - durationSeconds
      const durationSeconds = session.durationSeconds || 0;
      const start = durationSeconds > 0
        ? new Date(end.getTime() - (durationSeconds * 1000))
        : end;

      // Hours from midnight (can exceed 24 for next-day activity)
      const startH = (start - todayMidnight) / (1000 * 60 * 60);
      const endH = (end - todayMidnight) / (1000 * 60 * 60);

      minHours = Math.min(minHours, startH);
      maxHours = Math.max(maxHours, endH);
    });

    // Round down start, round up end, add 1-hour padding
    let startHour = Math.max(0, Math.floor(minHours) - 1);
    let endHour = Math.min(30, Math.ceil(maxHours) + 1);

    // IMPORTANT: Extend timeline to current time to show gaps/inactivity periods
    // This ensures that if user stopped working at 2am and it's now 10am,
    // the gap between last activity and current time is visible
    const now = new Date();
    const currentHoursFromMidnight = (now - todayMidnight) / (1000 * 60 * 60);
    
    // If current time is after the last activity, extend endHour to show the gap
    if (currentHoursFromMidnight > 0 && currentHoursFromMidnight < 30) {
      endHour = Math.max(endHour, Math.ceil(currentHoursFromMidnight) + 1);
    }

    // Ensure minimum 4-hour range for readability
    if (endHour - startHour < 4) {
      const mid = (startHour + endHour) / 2;
      startHour = Math.max(0, Math.floor(mid - 2));
      endHour = Math.min(30, Math.ceil(mid + 2));
    }

    return { startHour, endHour };
  };

  const timelineRange = getTimelineRange();
  const TIMELINE_START_HOUR = timelineRange.startHour;
  const TIMELINE_END_HOUR = timelineRange.endHour;
  const TIMELINE_TOTAL_MINUTES = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60;

  // Generate hour labels dynamically based on range
  const hourStep = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) > 16 ? 2 : 1;
  const timelineHours = [];
  for (let h = TIMELINE_START_HOUR; h < TIMELINE_END_HOUR; h += hourStep) {
    timelineHours.push(h);
  }

  // Format hour label (handles hours > 24 for cross-midnight display)
  const formatHourLabel = (hour) => {
    const h = hour % 24;
    if (h === 0) return '12am';
    if (h === 12) return '12pm';
    if (h > 12) return `${h - 12}pm`;
    return `${h}am`;
  };

  // Convert time to percentage position on timeline
  const timeToPercent = (date) => {
    const todayMidnight = new Date(today);
    todayMidnight.setHours(0, 0, 0, 0);
    const hoursFromMidnight = (date - todayMidnight) / (1000 * 60 * 60);
    const minutesFromStart = (hoursFromMidnight - TIMELINE_START_HOUR) * 60;
    return Math.max(0, Math.min(100, (minutesFromStart / TIMELINE_TOTAL_MINUTES) * 100));
  };

  // Get user's sessions as time blocks for timeline rendering
  const getUserTimeBlocks = (userId) => {
    let sessions = [];

    // For admins, use team timeline data
    if (timeData?.canViewAllUsers && timelineData) {
      const userTimeline = timelineData.usersWithActivity?.find(u => u.userId === userId);
      sessions = userTimeline?.sessions || [];
      if (sessions.length === 0) {
        console.warn('[DayView] No sessions for user:', userId,
          'canViewAll:', true,
          'timelineData null?', timelineData === null,
          'usersWithActivity count:', timelineData?.usersWithActivity?.length,
          'usersWithActivity IDs:', timelineData?.usersWithActivity?.map(u => u.userId),
          'match found?', !!userTimeline,
          'sessions in match:', userTimeline?.sessions?.length
        );
      }
    } else if (myTimelineData && myTimelineData.sessions) {
      // For regular users, use their own timeline data
      sessions = myTimelineData.sessions;
    } else {
      console.warn('[DayView] No timeline source for user:', userId,
        'canViewAll:', timeData?.canViewAllUsers,
        'timelineData null?', timelineData === null,
        'myTimelineData null?', myTimelineData === null
      );
    }

    if (!sessions || sessions.length === 0) return [];

    // Convert sessions to time blocks with position and width
    // IMPORTANT: Use durationSeconds to compute block width, NOT (endTime - startTime).
    // The wall-clock span (startTime to endTime) can include idle/sleep time,
    // but durationSeconds represents actual tracked work time.
    // Block is positioned as: (endTime - durationSeconds) to endTime
    const rawBlocks = sessions.map(session => {
      const endTime = parseUTC(session.endTime || session.timestamp);
      if (!endTime) return null;

      const durationSeconds = session.durationSeconds || 0;
      // Calculate the actual work start: endTime minus tracked duration
      const actualStart = durationSeconds > 0
        ? new Date(endTime.getTime() - (durationSeconds * 1000))
        : endTime;

      const hasIssue = !!(session.issueKey);
      return {
        startTime: actualStart,
        endTime: endTime,
        durationSeconds: durationSeconds,
        hasIssue,
        issueKey: session.issueKey || null
      };
    }).filter(Boolean);

    // Sort by start time for merging
    rawBlocks.sort((a, b) => a.startTime - b.startTime);

    // Coalesce adjacent/overlapping blocks within a 10-minute gap into continuous bars.
    // Individual 5-minute activity records are too thin to see on a multi-hour timeline,
    // so we merge nearby blocks into larger visible segments.
    // Only merge blocks with the same issueKey (so switching issues produces distinct segments).
    const GAP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const merged = [];
    for (const block of rawBlocks) {
      const prev = merged[merged.length - 1];
      const sameIssue = prev && prev.hasIssue === block.hasIssue && prev.issueKey === block.issueKey;
      if (sameIssue && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
        prev.endTime = new Date(Math.max(prev.endTime.getTime(), block.endTime.getTime()));
        prev.durationSeconds += block.durationSeconds;
      } else {
        merged.push({ ...block });
      }
    }

    // Convert merged blocks to percentage positions
    return merged.map(block => {
      const leftPercent = timeToPercent(block.startTime);
      const rightPercent = timeToPercent(block.endTime);
      const widthPercent = Math.max(0.3, rightPercent - leftPercent);

      return {
        left: leftPercent,
        width: widthPercent,
        startTime: block.startTime,
        endTime: block.endTime,
        durationSeconds: block.durationSeconds,
        hasIssue: block.hasIssue,
        issueKey: block.issueKey
      };
    }).filter(block => block.left < 100 && (block.left + block.width) > 0);
  };

  // Get idle blocks for a user's timeline
  const getIdleTimeBlocks = (userId) => {
    let idleBlocks = [];

    if (timeData?.canViewAllUsers && timelineData) {
      const userTimeline = timelineData.usersWithActivity?.find(u => u.userId === userId);
      idleBlocks = userTimeline?.idleBlocks || [];
    } else if (myTimelineData?.idleBlocks) {
      idleBlocks = myTimelineData.idleBlocks;
    }

    if (!idleBlocks || idleBlocks.length === 0) return [];

    return idleBlocks.map(block => {
      const parsedStartTime = parseUTC(block.startTime);
      const endTime = parseUTC(block.endTime);
      if (!parsedStartTime || !endTime) return null;

      const durationSeconds = block.durationSeconds || 0;
      const actualStart = durationSeconds > 0
        ? new Date(endTime.getTime() - (durationSeconds * 1000))
        : endTime;

      const leftPercent = timeToPercent(actualStart);
      const rightPercent = timeToPercent(endTime);
      const widthPercent = Math.max(0.3, rightPercent - leftPercent);

      return {
        id: block.id,
        left: leftPercent,
        width: widthPercent,
        startTime: actualStart,
        endTime,
        durationSeconds: durationSeconds,
        converted: !!block.reclassifiedFrom,
        convertedIssueKey: block.convertedIssueKey,
        convertedReason: block.reason || null,
        projectKey: block.projectKey || null
      };
    }).filter(block => block && block.left < 100 && (block.left + block.width) > 0);
  };

  // Get unassigned work blocks for a user's timeline (coalesced into merged blocks)
  const getUnassignedBlocks = (userId) => {
    let unassignedBlocks = [];

    if (timeData?.canViewAllUsers && timelineData) {
      const userTimeline = timelineData.usersWithActivity?.find(u => u.userId === userId);
      unassignedBlocks = userTimeline?.unassignedBlocks || [];
    } else if (myTimelineData?.unassignedBlocks) {
      unassignedBlocks = myTimelineData.unassignedBlocks;
    }

    if (!unassignedBlocks || unassignedBlocks.length === 0) return [];

    // Build raw blocks with precise timing
    const rawBlocks = unassignedBlocks.map(block => {
      const startTime = parseUTC(block.startTime);
      const endTime = parseUTC(block.endTime);
      if (!startTime || !endTime) return null;

      return {
        id: block.id,
        startTime,
        endTime,
        durationSeconds: block.durationSeconds || 0,
        projectKey: block.projectKey || null
      };
    }).filter(Boolean).sort((a, b) => a.startTime - b.startTime);

    if (rawBlocks.length === 0) return [];

    // Coalesce adjacent/overlapping blocks within 10-minute gap
    const GAP_THRESHOLD_MS = 10 * 60 * 1000;
    const merged = [];
    const sessionIdsByMergedBlock = {}; // Map merged block index to sessionIds
    
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = rawBlocks[i];
      const prev = merged[merged.length - 1];
      
      if (prev && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
        // Extend previous merged block
        const mergedIndex = merged.length - 1;
        prev.endTime = new Date(Math.max(prev.endTime.getTime(), block.endTime.getTime()));
        prev.durationSeconds += block.durationSeconds;
        if (!sessionIdsByMergedBlock[mergedIndex]) {
          sessionIdsByMergedBlock[mergedIndex] = [];
        }
        sessionIdsByMergedBlock[mergedIndex].push(block.id);
      } else {
        // Start new merged block
        const mergedIndex = merged.length;
        merged.push({ ...block, endTime: new Date(block.endTime) });
        sessionIdsByMergedBlock[mergedIndex] = [block.id];
      }
    }

    // Convert to percentage positions — match assigned block positioning
    return merged.map((block, index) => {
      const endTime = block.endTime;
      const durationSeconds = block.durationSeconds || 0;
      const actualStart = durationSeconds > 0
        ? new Date(endTime.getTime() - (durationSeconds * 1000))
        : endTime;

      const leftPercent = timeToPercent(actualStart);
      const rightPercent = timeToPercent(endTime);
      const widthPercent = Math.max(0.3, rightPercent - leftPercent);

      return {
        sessionIds: sessionIdsByMergedBlock[index] || [],
        left: leftPercent,
        width: widthPercent,
        startTime: actualStart,  // for tooltips
        endTime: endTime,
        durationSeconds: durationSeconds
      };
    }).filter(block => block.left < 100 && (block.left + block.width) > 0);
  };

  // Handle unassigned work conversion
  const handleConvertUnassigned = async () => {
    if (!convertingUnassigned || !convertingUnassigned.sessionIds?.length) return;
    if (convertForm.mode === 'existing' && !convertForm.issueKey) return;
    if (convertForm.mode === 'new' && !convertForm.projectKey) return;
    
    setConvertLoading(true);
    setConvertStatus(null);
    try {
      const payload = {
        sessionIds: convertingUnassigned.sessionIds,
        conversionReason: convertForm.reason.trim() || 'Manually converted from unassigned timeline block'
      };
      
      if (convertForm.mode === 'existing') {
        payload.issueKey = convertForm.issueKey.trim();
      } else {
        payload.createNewIssue = true;
        payload.newIssueSummary = convertForm.reason.trim() || 'Unassigned work - auto-created';
        payload.projectKey = convertForm.projectKey;
      }
      
      const result = await invoke('convertUnassignedToWorklog', payload);
      if (result.success) {
        const resolvedIssueKey = result?.data?.issueKey || result?.data?.createdIssueKey || payload.issueKey || null;
        if (resolvedIssueKey) {
          setConvertStatus({
            type: 'success',
            text: result?.data?.createdNewIssue
              ? `Assigned successfully. Created issue ${resolvedIssueKey}.`
              : `Assigned successfully to issue ${resolvedIssueKey}.`
          });
        } else {
          setConvertStatus({ type: 'success', text: 'Unassigned work assigned successfully.' });
        }

        // Refresh timeline data
        setConvertingUnassigned(null);
        setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
        
        // Re-fetch timeline to show updated state (sessions removed from both timeline and Unassigned Work)
        if (timeData?.canViewAllUsers) {
          const refreshResult = await invoke('getTeamDayTimeline', { projectKey: null, date: todayStr });
          if (refreshResult.success) setTimelineData(refreshResult.data);
        } else {
          const refreshResult = await invoke('getMyDayTimeline', { date: todayStr });
          if (refreshResult.success) setMyTimelineData(refreshResult.data);
        }
        
        // Refresh My Focus dashboard so newly created/linked issue appears immediately
        try {
          await loadActiveIssues();
        } catch (e) {
          console.warn('[DayView] Failed to refresh active issues after unassigned conversion:', e);
        }
      } else {
        console.error('Failed to convert unassigned work:', result.error);
        if (result?.createdIssueKey) {
          setConvertStatus({
            type: 'warning',
            text: `Issue ${result.createdIssueKey} was created, but assignment failed: ${result.error || 'Unknown error'}. Please retry using this issue.`
          });
        } else {
          setConvertStatus({ type: 'error', text: `Assignment failed: ${result?.error || 'Unknown error'}` });
        }
      }
    } catch (err) {
      console.error('Error converting unassigned work:', err);
      setConvertStatus({ type: 'error', text: `Assignment failed: ${err?.message || 'Unexpected error'}` });
    } finally {
      setConvertLoading(false);
    }
  };

  // Handle idle block conversion
  const handleConvertIdle = async () => {
    if (!convertingIdle || !convertForm.reason) return;
    if (convertForm.mode === 'existing' && !convertForm.issueKey) return;
    if (convertForm.mode === 'new' && !convertForm.projectKey) return;
    setConvertLoading(true);
    setConvertStatus(null);
    try {
      const payload = {
        idleRecordId: convertingIdle.id,
        reason: convertForm.reason.trim()
      };
      if (convertForm.mode === 'existing') {
        payload.issueKey = convertForm.issueKey.trim();
      } else {
        // Create new issue mode — use the user-selected project
        payload.createNewIssue = true;
        payload.issueSummary = convertForm.reason.trim();
        payload.projectKey = convertForm.projectKey;
      }
      const result = await invoke('convertIdleToWorklog', payload);
      if (result.success) {
        const targetIssue = convertForm.issueKey || result?.data?.issueKey;
        if (targetIssue) {
          setConvertStatus({ type: 'success', text: `Idle time converted successfully to issue ${targetIssue}.` });
        } else {
          setConvertStatus({ type: 'success', text: 'Idle time converted successfully.' });
        }

        // Refresh timeline data
        setConvertingIdle(null);
        setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
        // Re-fetch timeline to show updated state
        if (timeData?.canViewAllUsers) {
          const refreshResult = await invoke('getTeamDayTimeline', { projectKey: null, date: todayStr });
          if (refreshResult.success) setTimelineData(refreshResult.data);
        } else {
          const refreshResult = await invoke('getMyDayTimeline', { date: todayStr });
          if (refreshResult.success) setMyTimelineData(refreshResult.data);
        }
        // Refresh My Focus dashboard so the newly created/linked issue appears immediately
        try {
          await loadActiveIssues();
        } catch (e) {
          console.warn('[DayView] Failed to refresh active issues after idle conversion:', e);
        }
      } else {
        console.error('Failed to convert idle block:', result.error);
        setConvertStatus({ type: 'error', text: `Idle conversion failed: ${result?.error || 'Unknown error'}` });
      }
    } catch (err) {
      console.error('Error converting idle block:', err);
      setConvertStatus({ type: 'error', text: `Idle conversion failed: ${err?.message || 'Unexpected error'}` });
    } finally {
      setConvertLoading(false);
    }
  };

  // Close popover on outside click
  useEffect(() => {
    if (!convertingIdle && !convertingUnassigned) return;
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setConvertingIdle(null);
        setConvertingUnassigned(null);
        setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
        setIssueSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [convertingIdle, convertingUnassigned]);

  // Load user projects and issues when convert popover opens
  useEffect(() => {
    if (!convertingIdle && !convertingUnassigned) return;
    let cancelled = false;
    setDropdownsLoading(true);
    Promise.all([
      invoke('getUserProjects'),
      invoke('getAllUserAssignedIssues')
    ]).then(([projResult, issResult]) => {
      if (cancelled) return;
      if (projResult?.success) setUserProjects(projResult.projects || []);
      if (issResult?.success) setUserIssues(issResult.issues || []);
        // Also fetch recommendation if converting unassigned work
        const fetchRecommendationPromise = convertingUnassigned?.sessionIds?.length > 0
          ? invoke('getUnassignedConversionRecommendation', { sessionIds: convertingUnassigned.sessionIds })
          : Promise.resolve({ success: true, data: null });

        return Promise.all([
          invoke('getUserProjects'),
          invoke('getAllUserAssignedIssues'),
          fetchRecommendationPromise
        ]);
      }).then(([projResult, issResult, recResult]) => {
          if (cancelled) return;
          if (projResult?.success) setUserProjects(projResult.projects || []);
          if (issResult?.success) setUserIssues(issResult.issues || []);

          // Apply recommendation prefill if available
          if (recResult?.success && recResult.data) {
            const rec = recResult.data;
            if (rec.action === 'assign_to_existing' && rec.suggestedIssueKey) {
              setConvertForm(prev => ({
                ...prev,
                mode: 'existing',
                issueKey: rec.suggestedIssueKey,
                reason: rec.summary || prev.reason
              }));
            } else if (rec.action === 'create_new_issue') {
              // Find first available project for new issue creation
              if (projResult?.success && projResult.projects?.length > 0) {
                setConvertForm(prev => ({
                  ...prev,
                  mode: 'new',
                  projectKey: projResult.projects[0].key,
                  reason: rec.summary || prev.reason
                }));
              }
            }
          }
    }).catch(err => {
      const conversionType = convertingIdle ? 'idle' : 'unassigned';
      console.warn(`[DayView] Failed to load projects/issues for ${conversionType} convert:`, err);
    }).finally(() => {
      if (!cancelled) setDropdownsLoading(false);
    });
    return () => { cancelled = true; };
  }, [convertingIdle, convertingUnassigned]);

  // Get last activity info for a user
  const getUserLastActivity = (userId) => {
    // For admins, use team timeline data
    if (timeData?.canViewAllUsers && timelineData) {
      const userTimeline = timelineData.usersWithActivity?.find(u => u.userId === userId);
      return userTimeline?.lastActivity || null;
    }

    // For regular users, use their own timeline data
    if (myTimelineData) {
      return myTimelineData.lastActivity || null;
    }

    return null;
  };

  // Get tooltip text for a time block
  const getBlockTooltip = (block) => {
    const time = block.startTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    const end = block.endTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    const mins = Math.round(block.durationSeconds / 60);
    const label = block.hasIssue ? block.issueKey : 'No issue assigned';
    return `${label} · ${time} – ${end} (${mins}m)`;
  };

  // Get tooltip text for an idle block
  const getIdleBlockTooltip = (block) => {
    const start = block.startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const end = block.endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const mins = Math.round(block.durationSeconds / 60);
    if (block.converted) {
      const parts = [`${block.convertedIssueKey}`];
      if (block.convertedReason) parts.push(`— ${block.convertedReason}`);
      parts.push(`(${start} – ${end}, ${mins}m)`);
      return parts.join(' ');
    }
    return `Idle ${start} – ${end} (${mins}m)`;
  };

  // Check if timeline is available (for admins or regular user)
  const hasTimelineData = () => {
    if (timeData?.canViewAllUsers) {
      return timelineData !== null;
    }
    return myTimelineData !== null;
  };

  // Calculate time ago
  const getTimeAgo = (timestamp) => {
    if (!timestamp) return null;
    const now = new Date();
    const then = parseUTC(timestamp);
    if (!then) return null;
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return null;
  };

  const getTodayData = () => {
    return timeData?.dailySummary?.filter(day => {
      const workDateStr = normalizeDate(day.work_date);
      return workDateStr === todayStr;
    }) || [];
  };

  const getUsers = () => {
    const todayData = getTodayData();
    const tasksByUser = {};

    // Initialize with all known users
    timeData?.allUsers?.forEach(user => {
      tasksByUser[user.id] = {
        userId: user.id,
        displayName: user.display_name || user.email || 'User',
        tasks: [],
        totalSeconds: 0
      };
    });

    // Aggregate today's data by user from dailySummary
    todayData.forEach(item => {
      const userId = item.user_id || 'current_user';
      if (!tasksByUser[userId]) {
        tasksByUser[userId] = {
          userId,
          displayName: item.user_display_name || 'User',
          tasks: [],
          totalSeconds: 0
        };
      }
      tasksByUser[userId].tasks.push(item);
      tasksByUser[userId].totalSeconds += item.total_seconds || 0;
    });

    // Reconcile with timeline data to ensure displayed totals match visible blocks.
    // Timeline sessions come from activity_records (the same source as the blocks),
    // so using these totals prevents visual mismatches between blocks and numbers.
    if (timeData?.canViewAllUsers && timelineData) {
      timelineData.usersWithActivity?.forEach(userTimeline => {
        const assignedTotal = (userTimeline.sessions || []).reduce(
          (sum, s) => sum + (s.durationSeconds || 0), 0
        );
        const unassignedTotal = (userTimeline.unassignedBlocks || []).reduce(
          (sum, b) => sum + (b.durationSeconds || 0),
          0
        );
        const timelineTotal = assignedTotal + unassignedTotal;
        if (tasksByUser[userTimeline.userId]) {
          // Use the higher value: dailySummary may lag behind real-time activity_records
          tasksByUser[userTimeline.userId].totalSeconds = Math.max(
            tasksByUser[userTimeline.userId].totalSeconds,
            timelineTotal
          );
        }
      });
    } else if (myTimelineData) {
      const assignedTotal = (myTimelineData.sessions || []).reduce(
        (sum, s) => sum + (s.durationSeconds || 0), 0
      );
      const unassignedTotal = (myTimelineData.unassignedBlocks || []).reduce(
        (sum, b) => sum + (b.durationSeconds || 0),
        0
      );
      const timelineTotal = assignedTotal + unassignedTotal;
      // For non-admin view, reconcile the single user's total
      Object.values(tasksByUser).forEach(user => {
        user.totalSeconds = Math.max(user.totalSeconds, timelineTotal);
      });
    }

    return Object.values(tasksByUser).sort((a, b) => b.totalSeconds - a.totalSeconds);
  };

  // Report reconciled today total to parent so SummaryCards stays in sync
  const users = getUsers();
  const reconciledTotal = users.reduce((sum, u) => sum + u.totalSeconds, 0);

  useEffect(() => {
    if (onTodayTotalReconciled) {
      onTodayTotalReconciled(reconciledTotal);
    }
  }, [reconciledTotal, onTodayTotalReconciled]);

  const formattedDate = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return (
    <div className="timesheet-day-view">
      <div className="timesheet-header">
        <h3>
          {timeData?.canViewAllUsers ? 'Daily Timesheet' : 'My Daily Timesheet'} - {formattedDate}
        </h3>
      </div>

      {convertStatus && (
        <div className={`conversion-status-banner ${convertStatus.type}`}>
          <span>{convertStatus.text}</span>
          <button
            className="conversion-status-close"
            onClick={() => setConvertStatus(null)}
            aria-label="Dismiss conversion status"
          >
            ✕
          </button>
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div className="team-members-list">
          {(() => {
            if (users.length === 0) {
              return <p className="empty-state">No users found</p>;
            }

            return (
              <>
                {/* Timeline Header - show if we have timeline data (admin or regular user) */}
                {hasTimelineData() && (
                  <div className="day-timeline-header">
                    <div className="timeline-header-name">
                      Name
                    </div>
                    <div className="timeline-header-hours">
                      {timelineHours.map(hour => (
                        <span key={hour} className="timeline-hour-label">
                          {formatHourLabel(hour)}
                        </span>
                      ))}
                    </div>
                    <div className="timeline-header-total"></div>
                  </div>
                )}



                {users.map((user, idx) => {
                  const timeBlocks = getUserTimeBlocks(user.userId);
                  const idleBlocks = getIdleTimeBlocks(user.userId);
                  const unassignedBlocks = getUnassignedBlocks(user.userId);
                  const lastActivity = getUserLastActivity(user.userId);
                  const timeAgo = lastActivity ? getTimeAgo(lastActivity) : null;
                  const hasActivity = user.totalSeconds > 0;
                  const showTimeline = hasTimelineData();
                  const isOwnUser = !timeData?.canViewAllUsers || (timeData?.userId === user.userId) || (myTimelineData && myTimelineData.userId === user.userId);
                  const activeDurationSec = timeBlocks.reduce((sum, b) => sum + (b.durationSeconds || 0), 0);
                  const idleDurationSec = idleBlocks.reduce((sum, b) => sum + (b.durationSeconds || 0), 0);
                  const unassignedDurationSec = unassignedBlocks.reduce((sum, b) => sum + (b.durationSeconds || 0), 0);

                  return (
                    <div key={idx} className={`team-member-card ${showTimeline ? 'with-timeline' : ''}`}>
                      <div className="member-header">
                        {/* Avatar with status indicator */}
                        <div className="member-avatar-wrapper">
                          <div
                            className="member-avatar"
                            style={{ backgroundColor: getAvatarColor(user.displayName) }}
                            title={user.displayName}
                          >
                            {getInitials(user.displayName)}
                          </div>
                          {hasActivity && (
                            <span className="member-status-dot active" title="Active today"></span>
                          )}
                        </div>

                        {/* Name and subtitle */}
                        <div className="member-name-section">
                          <span className="member-name">{user.displayName}</span>
                          {showTimeline && (
                            <span className="member-subtitle">
                              {hasActivity && timeAgo ? (
                                `Last Tracked: ${timeAgo}`
                              ) : !hasActivity ? (
                                <span className="no-activity-today">No activity today</span>
                              ) : null}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Timeline visualization - shows actual work periods */}
                      {showTimeline && (
                        <div className="member-timeline-wrapper">
                          <div className="member-timeline">
                            <div className="timeline-container">
                              {/* Actual time blocks positioned based on start_time and end_time */}
                              <div className="timeline-blocks">
                                {timeBlocks.map((block, blockIdx) => (
                                  <div
                                    key={`work-${blockIdx}`}
                                    className="timeline-block active"
                                    style={{
                                      left: `${block.left}%`,
                                      width: `${block.width}%`
                                    }}
                                    title={getBlockTooltip(block)}
                                  >
                                    <div className="block-tooltip">{getBlockTooltip(block)}</div>
                                  </div>
                                ))}
                                {/* Idle blocks with striped pattern */}
                                {idleBlocks.map((block, blockIdx) => (
                                  <div
                                    key={`idle-${blockIdx}`}
                                    className={`timeline-block idle${block.converted ? ' converted' : ''}`}
                                    style={{
                                      left: `${block.left}%`,
                                      width: `${block.width}%`
                                    }}
                                    title={getIdleBlockTooltip(block)}
                                  >
                                    <div className="block-tooltip">{getIdleBlockTooltip(block)}</div>
                                    {/* Show + button on hover for own unconverted idle blocks */}
                                    {isOwnUser && !block.converted && (
                                      <button
                                        className="idle-convert-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setConvertStatus(null);
                                          setConvertingIdle(block);
                                          setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
                                          setIssueSearch('');
                                        }}
                                        title="Convert to worklog"
                                      >+</button>
                                    )}
                                  </div>
                                ))}
                                {/* Unassigned work blocks with dotted pattern */}
                                {unassignedBlocks.map((block, blockIdx) => {
                                  const mins = Math.round(block.durationSeconds / 60);
                                  const time = block.startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                                  const end = block.endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                                  const titleText = `Unassigned · ${time} – ${end} (${mins}m)`;
                                  return (
                                  <div
                                    key={`unassigned-${blockIdx}`}
                                    className={`timeline-block unassigned${block.width < 1 ? ' thin' : ''}`}
                                    style={{
                                      left: `${block.left}%`,
                                      width: `${block.width}%`
                                    }}
                                    title={titleText}
                                    onClick={() => {
                                      if (!isOwnUser) return;
                                      setConvertStatus(null);
                                      setConvertingUnassigned(block);
                                      setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
                                      setIssueSearch('');
                                    }}
                                  >
                                      <div className="block-tooltip">{titleText}</div>
                                      {/* Show + button on hover for own unassigned blocks */}
                                      {isOwnUser && (
                                        <button
                                          className="unassigned-convert-btn"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setConvertStatus(null);
                                            setConvertingUnassigned(block);
                                            setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' });
                                            setIssueSearch('');
                                          }}
                                          title="Assign or create issue for unassigned work"
                                        >+</button>
                                      )}
                                    </div>
                                  );
                                })}

                              </div>
                            </div>

                            <div className="timeline-legend-bar">
                              <div className="timeline-legend-items">
                                {activeDurationSec > 0 && (
                                  <div className="legend-item-group">
                                    <span className="legend-color-box active"></span>
                                    <span className="legend-label">Active Work ({formatTime(activeDurationSec)})</span>
                                  </div>
                                )}
                                {idleDurationSec > 0 && (
                                  <div className="legend-item-group">
                                    <span className="legend-color-box idle"></span>
                                    <span className="legend-label">Idle Time ({formatTime(idleDurationSec)})</span>
                                  </div>
                                )}
                                {unassignedDurationSec > 0 && (
                                  <div className="legend-item-group">
                                    <span className="legend-color-box unassigned"></span>
                                    <span className="legend-label">Unassigned Work ({formatTime(unassignedDurationSec)})</span>
                                  </div>
                                )}
                                {activeDurationSec === 0 && idleDurationSec === 0 && unassignedDurationSec === 0 && (
                                  <div className="legend-item-group">
                                    <span className="legend-color-box no-activity"></span>
                                    <span className="legend-label">No Activity</span>
                                  </div>
                                )}
                              </div>
                              <div className="timeline-total-tracked">
                                <span className="total-time">{formatTime(user.totalSeconds)}</span>
                                <span className="total-label">Total Tracked</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Expandable issue breakdown with worklog reassignment — temporarily disabled */}
                      {false && isOwnUser && expandedUsers[user.userId] && user.tasks && user.tasks.length > 0 && (
                        <div className="issue-breakdown">
                          {user.tasks.map((task, taskIdx) => {
                            const issueKey = task.task_key || task.issue_key || task.active_task_key;
                            return (
                              <div key={taskIdx} className="issue-row">
                                <span className="issue-row-key">{issueKey || 'Unassigned'}</span>
                                <span className="issue-row-summary">{task.issue_summary || ''}</span>
                                <span className="issue-row-time">{formatTime(task.total_seconds || 0)}</span>
                                {onOpenWorklogReassignModal && (
                                  <button
                                    className="reassign-worklog-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onOpenWorklogReassignModal({
                                        fromIssueKey: issueKey || null,
                                        timeSpentSeconds: task.total_seconds || 0,
                                        issueSummary: task.issue_summary || (issueKey ? '' : 'Unassigned work')
                                      });
                                    }}
                                    title={issueKey ? 'Reassign worklog to another issue' : 'Assign to an issue'}
                                  >
                                    {issueKey ? '⇄' : '→'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                    </div>
                  );
                })}
              </>
            );
          })()}
        </div>
      )}

      {!loading && selectedDate && (
        <DayIssueDrilldown
          selectedDate={selectedDate}
          onClose={() => setSelectedDate(null)}
        />
      )}

      {/* Convert popover — fixed overlay outside the timeline */}
      {(convertingIdle || convertingUnassigned) && (
        <div className="idle-convert-overlay" onClick={() => { setConvertingIdle(null); setConvertingUnassigned(null); setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' }); setIssueSearch(''); }}>
          <div className="idle-convert-modal" ref={popoverRef} onClick={(e) => e.stopPropagation()}>
            <div className="popover-header">
              <span className="popover-title">{convertingUnassigned ? 'Assign unassigned work' : 'Convert idle to worklog'}</span>
              <span className="popover-duration">
                {Math.round(((convertingUnassigned || convertingIdle)?.durationSeconds || 0) / 60)}m {convertingUnassigned ? 'unassigned' : 'idle'}
              </span>
            </div>

            <p className="popover-match-tip">
              <span>Our AI matches sessions to Jira issues using their <strong>summary</strong> and <strong>description</strong>. Clear, descriptive titles in Jira improve matching accuracy.</span>
            </p>

            {/* Step 1: Reason */}
            <label className="popover-label">What were you working on?</label>
            <input
              type="text"
              className="popover-input"
              placeholder="e.g. Code review, standup meeting"
              value={convertForm.reason}
              onChange={(e) => setConvertForm(f => ({ ...f, reason: e.target.value }))}
              autoFocus
            />

            {/* Step 2: Assign to issue */}
            <label className="popover-label">Assign to issue</label>
            <div className="popover-mode-tabs">
              <button
                className={`popover-mode-tab${convertForm.mode === 'existing' ? ' active' : ''}`}
                onClick={() => setConvertForm(f => ({ ...f, mode: 'existing' }))}
              >Existing Issue</button>
              <button
                className={`popover-mode-tab${convertForm.mode === 'new' ? ' active' : ''}`}
                onClick={() => setConvertForm(f => ({ ...f, mode: 'new' }))}
              >Create New</button>
            </div>

            {convertForm.mode === 'existing' ? (
              <div className="popover-issue-selector">
                <input
                  type="text"
                  className="popover-input"
                  placeholder="Search issues by key or summary..."
                  value={issueSearch}
                  onChange={(e) => setIssueSearch(e.target.value)}
                />
                {dropdownsLoading ? (
                  <div className="popover-hint">Loading issues...</div>
                ) : (
                  <div className="popover-dropdown-list">
                    {userIssues
                      .filter(iss => {
                        if (!issueSearch) return true;
                        const q = issueSearch.toLowerCase();
                        return iss.key.toLowerCase().includes(q) || (iss.summary || '').toLowerCase().includes(q);
                      })
                      .slice(0, 20)
                      .map(iss => (
                        <div
                          key={iss.key}
                          className={`popover-dropdown-item${convertForm.issueKey === iss.key ? ' selected' : ''}`}
                          onClick={() => setConvertForm(f => ({ ...f, issueKey: iss.key }))}
                        >
                          <span className="dropdown-item-key">{iss.key}</span>
                          <span className="dropdown-item-summary">{iss.summary}</span>
                        </div>
                      ))
                    }
                    {userIssues.length === 0 && !dropdownsLoading && (
                      <div className="popover-hint">No assigned issues found</div>
                    )}
                  </div>
                )}
                {convertForm.issueKey && (
                  <div className="popover-selected-issue">
                    Selected: <strong>{convertForm.issueKey}</strong>
                  </div>
                )}
              </div>
            ) : (
              <div className="popover-project-selector">
                <label className="popover-label">Select project</label>
                {dropdownsLoading ? (
                  <div className="popover-hint">Loading projects...</div>
                ) : (
                  <select
                    className="popover-select"
                    value={convertForm.projectKey}
                    onChange={(e) => setConvertForm(f => ({ ...f, projectKey: e.target.value }))}
                  >
                    <option value="">— Select a project —</option>
                    {userProjects.map(p => (
                      <option key={p.key} value={p.key}>{p.key} — {p.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="popover-actions">
              <button
                className="popover-btn cancel"
                onClick={() => { setConvertingIdle(null); setConvertingUnassigned(null); setConvertForm({ issueKey: '', reason: '', mode: 'existing', projectKey: '' }); setIssueSearch(''); }}
              >Cancel</button>
              <button
                className="popover-btn confirm"
                disabled={!convertForm.reason.trim() || (convertForm.mode === 'existing' && !convertForm.issueKey.trim()) || (convertForm.mode === 'new' && !convertForm.projectKey) || convertLoading}
                onClick={convertingUnassigned ? handleConvertUnassigned : handleConvertIdle}
              >{convertLoading ? 'Saving...' : (convertingUnassigned ? 'Assign' : 'Convert')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DayView;
