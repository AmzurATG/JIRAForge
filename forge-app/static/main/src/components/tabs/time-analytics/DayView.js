import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../../utils';
import { normalizeDate, formatLocalDate, parseUTC } from './dateUtils';

/**
 * Day View Component
 * Displays today's timesheet with team member cards and activity timeline
 */
function DayView({ loading, timeData }) {
  const [timelineData, setTimelineData] = useState(null);
  const [myTimelineData, setMyTimelineData] = useState(null);
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
      });
    } else if (myTimelineData?.sessions) {
      allSessions = myTimelineData.sessions;
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
    } else if (myTimelineData && myTimelineData.sessions) {
      // For regular users, use their own timeline data
      sessions = myTimelineData.sessions;
    }

    if (!sessions || sessions.length === 0) return [];

    // Convert sessions to time blocks with position and width
    // IMPORTANT: Use durationSeconds to compute block width, NOT (endTime - startTime).
    // The wall-clock span (startTime to endTime) can include idle/sleep time,
    // but durationSeconds represents actual tracked work time.
    // Block is positioned as: (endTime - durationSeconds) to endTime
    return sessions.map(session => {
      const endTime = parseUTC(session.endTime || session.timestamp);
      if (!endTime) return null;

      const durationSeconds = session.durationSeconds || 0;
      // Calculate the actual work start: endTime minus tracked duration
      const actualStart = durationSeconds > 0
        ? new Date(endTime.getTime() - (durationSeconds * 1000))
        : endTime;

      const leftPercent = timeToPercent(actualStart);
      const rightPercent = timeToPercent(endTime);
      // Use actual session duration for block width — no arbitrary cap.
      // The width already represents tracked work time (durationSeconds),
      // not wall-clock time, so it accurately reflects real activity.
      const widthPercent = Math.max(0.3, rightPercent - leftPercent);

      return {
        left: leftPercent,
        width: widthPercent,
        startTime: actualStart,
        endTime: endTime,
        durationSeconds: durationSeconds
      };
    }).filter(block => block && block.left < 100 && (block.left + block.width) > 0); // Filter out nulls and blocks outside visible range
  };

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
            const users = getUsers();

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
                  const lastActivity = getUserLastActivity(user.userId);
                  const timeAgo = lastActivity ? getTimeAgo(lastActivity) : null;
                  const hasActivity = user.totalSeconds > 0;
                  const showTimeline = hasTimelineData();

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
                                {timeBlocks.map((block, blockIdx) => (
                                  <div
                                    key={blockIdx}
                                    className="timeline-block active"
                                    style={{
                                      left: `${block.left}%`,
                                      width: `${block.width}%`
                                    }}
                                    title={getBlockTooltip(block)}
                                  ></div>
                                ))}
                              </div>
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
