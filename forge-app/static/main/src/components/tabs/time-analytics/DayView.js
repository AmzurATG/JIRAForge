import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../../utils';
import { normalizeDate, formatLocalDate, parseUTC } from './dateUtils';

/**
 * Day View Component
 * Displays today's timesheet with team member cards and activity timeline
 */
function DayView({ loading, timeData, onTodayTotalReconciled }) {
  const [timelineData, setTimelineData] = useState(null);
  const [myTimelineData, setMyTimelineData] = useState(null);
  const [convertingIdle, setConvertingIdle] = useState(null); // { id, startTime, endTime, durationSeconds }
  const [convertForm, setConvertForm] = useState({ issueKey: '', reason: '', mode: 'existing' }); // mode: 'existing' | 'new'
  const [convertLoading, setConvertLoading] = useState(false);
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

  // Work hours boundary lines
  const getWorkHourBoundaries = () => {
    const wh = (timeData?.canViewAllUsers ? timelineData?.workHours : myTimelineData?.workHours) || null;
    if (!wh) return [];
    const todayMidnight = new Date(today);
    todayMidnight.setHours(0, 0, 0, 0);
    const parseHM = (str) => {
      const parts = (str || '').split(':').map(Number);
      return { h: parts[0] || 0, m: parts[1] || 0 };
    };
    const boundaries = [];
    const start = parseHM(wh.workHoursStart);
    const end = parseHM(wh.workHoursEnd);
    const startDate = new Date(todayMidnight);
    startDate.setHours(start.h, start.m, 0, 0);
    const endDate = new Date(todayMidnight);
    endDate.setHours(end.h, end.m, 0, 0);
    const sp = timeToPercent(startDate);
    const ep = timeToPercent(endDate);
    if (sp > 0 && sp < 100) boundaries.push({ percent: sp, label: wh.workHoursStart });
    if (ep > 0 && ep < 100) boundaries.push({ percent: ep, label: wh.workHoursEnd });
    return boundaries;
  };
  const workHourBoundaries = getWorkHourBoundaries();

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

      return {
        startTime: actualStart,
        endTime: endTime,
        durationSeconds: durationSeconds
      };
    }).filter(Boolean);

    // Sort by start time for merging
    rawBlocks.sort((a, b) => a.startTime - b.startTime);

    // Coalesce adjacent/overlapping blocks within a 10-minute gap into continuous bars.
    // Individual 5-minute activity records are too thin to see on a multi-hour timeline,
    // so we merge nearby blocks into larger visible segments.
    const GAP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const merged = [];
    for (const block of rawBlocks) {
      const prev = merged[merged.length - 1];
      if (prev && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
        // Extend previous block
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
        durationSeconds: block.durationSeconds
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
      const startTime = parseUTC(block.startTime);
      const endTime = parseUTC(block.endTime);
      if (!startTime || !endTime) return null;

      const leftPercent = timeToPercent(startTime);
      const rightPercent = timeToPercent(endTime);
      const widthPercent = Math.max(0.3, rightPercent - leftPercent);

      return {
        id: block.id,
        left: leftPercent,
        width: widthPercent,
        startTime,
        endTime,
        durationSeconds: block.durationSeconds || 0,
        converted: !!block.reclassifiedFrom,
        convertedIssueKey: block.convertedIssueKey
      };
    }).filter(block => block && block.left < 100 && (block.left + block.width) > 0);
  };

  // Handle idle block conversion
  const handleConvertIdle = async () => {
    if (!convertingIdle || !convertForm.reason) return;
    if (convertForm.mode === 'existing' && !convertForm.issueKey) return;
    setConvertLoading(true);
    try {
      const payload = {
        idleRecordId: convertingIdle.id,
        reason: convertForm.reason.trim()
      };
      if (convertForm.mode === 'existing') {
        payload.issueKey = convertForm.issueKey.trim();
      } else {
        // Create new issue mode — issueKey is empty, backend will handle
        payload.createNewIssue = true;
        payload.issueSummary = convertForm.reason.trim();
      }
      const result = await invoke('convertIdleToWorklog', payload);
      if (result.success) {
        // Refresh timeline data
        setConvertingIdle(null);
        setConvertForm({ issueKey: '', reason: '', mode: 'existing' });
        // Re-fetch timeline to show updated state
        if (timeData?.canViewAllUsers) {
          const refreshResult = await invoke('getTeamDayTimeline', { projectKey: null, date: todayStr });
          if (refreshResult.success) setTimelineData(refreshResult.data);
        } else {
          const refreshResult = await invoke('getMyDayTimeline', { date: todayStr });
          if (refreshResult.success) setMyTimelineData(refreshResult.data);
        }
      } else {
        console.error('Failed to convert idle block:', result.error);
      }
    } catch (err) {
      console.error('Error converting idle block:', err);
    } finally {
      setConvertLoading(false);
    }
  };

  // Close popover on outside click
  useEffect(() => {
    if (!convertingIdle) return;
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setConvertingIdle(null);
        setConvertForm({ issueKey: '', reason: '', mode: 'existing' });
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [convertingIdle]);

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
    return block.startTime.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  // Get tooltip text for an idle block
  const getIdleBlockTooltip = (block) => {
    const start = block.startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const end = block.endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const mins = Math.round(block.durationSeconds / 60);
    if (block.converted) return `Converted to worklog (${block.convertedIssueKey}) ${start} – ${end}`;
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
        const timelineTotal = (userTimeline.sessions || []).reduce(
          (sum, s) => sum + (s.durationSeconds || 0), 0
        );
        if (tasksByUser[userTimeline.userId]) {
          // Use the higher value: dailySummary may lag behind real-time activity_records
          tasksByUser[userTimeline.userId].totalSeconds = Math.max(
            tasksByUser[userTimeline.userId].totalSeconds,
            timelineTotal
          );
        }
      });
    } else if (myTimelineData && myTimelineData.sessions) {
      const timelineTotal = myTimelineData.sessions.reduce(
        (sum, s) => sum + (s.durationSeconds || 0), 0
      );
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
                    <div className="timeline-header-name">Name</div>
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
                  const lastActivity = getUserLastActivity(user.userId);
                  const timeAgo = lastActivity ? getTimeAgo(lastActivity) : null;
                  const hasActivity = user.totalSeconds > 0;
                  const showTimeline = hasTimelineData();
                  const isOwnUser = !timeData?.canViewAllUsers || (timeData?.userId === user.userId) || (myTimelineData && myTimelineData.userId === user.userId);

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

                        {/* Timeline visualization - shows actual work periods */}
                        {showTimeline && (
                          <div className="member-timeline">
                            <div className="timeline-container">
                              {/* Hour grid lines for visual reference */}
                              <div className="timeline-grid">
                                {timelineHours.map(hour => (
                                  <div key={hour} className="timeline-grid-cell"></div>
                                ))}
                              </div>
                              {/* Actual time blocks positioned based on start_time and end_time */}
                              <div className="timeline-blocks">
                                {/* Work hours boundary lines */}
                                {workHourBoundaries.map((b, i) => (
                                  <div
                                    key={`wh-${i}`}
                                    className="work-hour-boundary"
                                    style={{ left: `${b.percent}%` }}
                                    title={`Work hours: ${b.label}`}
                                  />
                                ))}
                                {timeBlocks.map((block, blockIdx) => (
                                  <div
                                    key={`work-${blockIdx}`}
                                    className="timeline-block active"
                                    style={{
                                      left: `${block.left}%`,
                                      width: `${block.width}%`
                                    }}
                                    title={getBlockTooltip(block)}
                                  ></div>
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
                                    {/* Show + button on hover for own unconverted idle blocks */}
                                    {isOwnUser && !block.converted && (
                                      <button
                                        className="idle-convert-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setConvertingIdle(block);
                                          setConvertForm({ issueKey: '', reason: '', mode: 'existing' });
                                        }}
                                        title="Convert to worklog"
                                      >+</button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Convert idle popover — rendered outside timeline for better visibility */}
                        {convertingIdle && idleBlocks.some(b => b.id === convertingIdle.id) && (
                          <div className="idle-convert-popover-outer" ref={popoverRef} onClick={(e) => e.stopPropagation()}>
                            <div className="popover-header">
                              <span className="popover-title">Convert idle to worklog</span>
                              <span className="popover-duration">{Math.round(convertingIdle.durationSeconds / 60)}m idle</span>
                            </div>

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
                              <input
                                type="text"
                                className="popover-input"
                                placeholder="Issue key (e.g. PROJ-123)"
                                value={convertForm.issueKey}
                                onChange={(e) => setConvertForm(f => ({ ...f, issueKey: e.target.value }))}
                              />
                            ) : (
                              <p className="popover-hint">A new issue will be created with the reason above as the summary.</p>
                            )}

                            <div className="popover-actions">
                              <button
                                className="popover-btn cancel"
                                onClick={() => { setConvertingIdle(null); setConvertForm({ issueKey: '', reason: '', mode: 'existing' }); }}
                              >Cancel</button>
                              <button
                                className="popover-btn confirm"
                                disabled={!convertForm.reason.trim() || (convertForm.mode === 'existing' && !convertForm.issueKey.trim()) || convertLoading}
                                onClick={handleConvertIdle}
                              >{convertLoading ? 'Saving...' : 'Convert'}</button>
                            </div>
                          </div>
                        )}

                        {/* Time total */}
                        <div className="member-total-section">
                          <span className="member-total">{formatTime(user.totalSeconds)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default DayView;
