import React, { useEffect, useState, useMemo, useRef } from 'react';
import { formatTime } from '../../../utils';
import { normalizeDate, formatLocalDate, getWeekDates } from './dateUtils';
import DayIssueDrilldown from './DayIssueDrilldown';

/**
 * Week View Component
 * Displays weekly timesheet with table layout
 */
function WeekView({ loading, timeData, summaryDrillDate }) {
  const [selectedDate, setSelectedDate] = useState(null);

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
  today.setHours(0, 0, 0, 0);
  const todayStr = formatLocalDate(today);
  const startOfWeek = new Date(today);
  const dow = today.getDay();
  startOfWeek.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekDates = useMemo(() => getWeekDates(today), [todayStr]);
  const daysCount = weekDates.length;

  // Track the last consumed summaryDrillDate to avoid re-applying on every render
  const lastDrillDateRef = useRef(null);

  useEffect(() => {
    if (!summaryDrillDate) return;
    if (summaryDrillDate === lastDrillDateRef.current) return;
    lastDrillDateRef.current = summaryDrillDate;
    if (weekDates.some(item => item.dateStr === summaryDrillDate)) {
      setSelectedDate(summaryDrillDate);
    }
  }, [summaryDrillDate, weekDates]);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const getWeekStartDate = () => {
    return startOfWeek.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const getUserTimeByDay = () => {
    const userTimeByDay = {};

    // Initialize with all known users
    timeData?.allUsers?.forEach(user => {
      userTimeByDay[user.id] = {
        userId: user.id,
        name: user.display_name || user.email || 'User',
        days: Array(daysCount).fill(0),
        total: 0
      };
    });

    // Aggregate daily data by user
    timeData?.dailySummary?.forEach(day => {
      const workDateStr = normalizeDate(day.work_date);
      const weekDateItem = weekDates.find(item => item.dateStr === workDateStr);

      if (weekDateItem && workDateStr <= todayStr) {
        const userId = day.user_id || 'current_user';
        const dayIndex = weekDates.indexOf(weekDateItem);

        if (!userTimeByDay[userId]) {
          userTimeByDay[userId] = {
            userId,
            name: day.user_display_name || 'User',
            days: Array(daysCount).fill(0),
            total: 0
          };
        }
        if (dayIndex >= 0 && dayIndex < daysCount) {
          userTimeByDay[userId].days[dayIndex] += day.total_seconds || 0;
          userTimeByDay[userId].total += day.total_seconds || 0;
        }
      }
    });

    return Object.values(userTimeByDay).sort((a, b) => b.total - a.total);
  };

  return (
    <div className="timesheet-week-view">
      <div className="timesheet-header">
        <h3>
          {timeData?.canViewAllUsers ? 'Weekly Timesheet' : 'My Weekly Timesheet'} - Week of {getWeekStartDate()}
        </h3>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div className="week-table-container">
          <table className="week-table">
            <thead>
              <tr>
                <th>{timeData?.canViewAllUsers ? 'Team Member' : 'User'}</th>
                {weekDates.map((item, i) => (
                  <th key={i}>{dayNames[item.date.getDay()]}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const users = getUserTimeByDay();

                if (users.length === 0) {
                  return (
                    <tr>
                      <td colSpan={daysCount + 2} className="empty-state">No users found</td>
                    </tr>
                  );
                }

                return (
                  <>
                    {users.map((user, idx) => (
                      <tr key={idx}>
                        <td className="member-name-cell">
                          <div 
                            className="member-avatar-small"
                            style={{ backgroundColor: getAvatarColor(user.name) }}
                            title={user.name}
                          >
                            {getInitials(user.name)}
                          </div>
                          {user.name}
                        </td>
                        {user.days.map((seconds, dayIdx) => {
                          const dateStr = weekDates[dayIdx]?.dateStr;
                          return (
                          <td key={dayIdx} className="time-cell">
                            {seconds > 0 ? (
                              <button
                                className={`time-drilldown-btn ${selectedDate === dateStr ? 'active' : ''}`}
                                onClick={() => setSelectedDate(selectedDate === dateStr ? null : dateStr)}
                                title="Click for issue breakdown"
                              >
                                {formatTime(seconds)}
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                          );
                        })}
                        <td className="total-cell">{formatTime(user.total)}</td>
                      </tr>
                    ))}
                    {timeData?.canViewAllUsers && users.length > 1 && (
                      <tr className="totals-row">
                        <td><strong>Daily Totals</strong></td>
                        {Array.from({ length: daysCount }, (_, dayIdx) => {
                          const dayTotal = users.reduce((sum, user) => sum + user.days[dayIdx], 0);
                          return (
                            <td key={dayIdx} className="total-cell">
                              {dayTotal > 0 ? formatTime(dayTotal) : '-'}
                            </td>
                          );
                        })}
                        <td className="grand-total-cell">
                          {formatTime(users.reduce((sum, user) => sum + user.total, 0))}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}

      {!loading && selectedDate && (
        <DayIssueDrilldown
          selectedDate={selectedDate}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </div>
  );
}

export default WeekView;
