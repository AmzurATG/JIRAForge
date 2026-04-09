import React from 'react';
import { formatTime } from '../../../utils';

/**
 * User Activity Table Component
 * Displays team member activity overview
 */
function UserActivityTable({ users = [] }) {
  const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  const getAvatarColor = (name) => {
    // Generate a consistent color based on the name
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

  const getTodayDateStr = () => {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const getWeekRangeStr = () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const formatDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${formatDate(monday)} - ${formatDate(sunday)}, ${now.getFullYear()}`;
  };

  const getMonthStr = () => {
    return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  return (
    <div className="user-activity-section">
      <div className="section-header">
        <h3>Team Activity Overview</h3>
        <span className="section-subtitle">Daily, weekly, and monthly hours by team member</span>
      </div>
      <div className="user-activity-table-container">
        <table className="user-activity-table">
          <thead>
            <tr>
              <th>User</th>
              <th>
                Today
                <span className="info-icon-wrapper">
                  <span className="info-icon">ℹ</span>
                  <span className="info-tooltip">{getTodayDateStr()}</span>
                </span>
              </th>
              <th>
                This Week
                <span className="info-icon-wrapper">
                  <span className="info-icon">ℹ</span>
                  <span className="info-tooltip">{getWeekRangeStr()}</span>
                </span>
              </th>
              <th>
                This Month
                <span className="info-icon-wrapper">
                  <span className="info-icon">ℹ</span>
                  <span className="info-tooltip">{getMonthStr()}</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan="4" className="empty-state">No user activity data available</td>
              </tr>
            ) : (
              users.map((user, idx) => (
                <tr key={idx}>
                  <td className="user-name-cell">
                    <div 
                      className="user-avatar"
                      style={{ backgroundColor: getAvatarColor(user.displayName) }}
                      title={user.displayName}
                    >
                      {getInitials(user.displayName)}
                    </div>
                    <span className="user-name">{user.displayName}</span>
                  </td>
                  <td className="hours-cell">
                    <strong>{formatTime(user.todaySeconds)}</strong>
                  </td>
                  <td className="hours-cell">
                    <strong>{formatTime(user.weekSeconds)}</strong>
                  </td>
                  <td className="hours-cell">
                    <strong>{formatTime(user.monthSeconds)}</strong>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UserActivityTable;
