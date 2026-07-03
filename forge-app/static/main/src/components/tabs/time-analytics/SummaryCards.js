import React from 'react';
import { formatTime } from '../../../utils';
import { normalizeDate, formatLocalDate, getMonthStr } from './dateUtils';

/**
 * Summary Cards Component
 * Displays Today's, Week's, and Month's total time
 * Cards are clickable to switch between Day/Week/Month views
 */
function SummaryCards({ loading, timeData, activeView, onViewChange, reconciledTodayTotal, onDrillDown }) {
  // Get the dailySummary total for today (before reconciliation) so we can
  // compute the delta and apply it to week/month totals as well.
  const rawTodayTotal = (() => {
    const today = new Date();
    const todayStr = formatLocalDate(today);
    return (timeData?.dailySummary || []).filter(day => {
      const workDateStr = normalizeDate(day.work_date);
      return workDateStr === todayStr;
    }).reduce((sum, day) => sum + (day.total_seconds || 0), 0) || 0;
  })();

  // Difference between reconciled (timeline-accurate) and raw (dailySummary) today value
  const todayDelta = (reconciledTodayTotal != null) ? reconciledTodayTotal - rawTodayTotal : 0;

  const calculateWeekTotal = () => {
    const today = new Date();
    const todayStr = formatLocalDate(today);

    // Calculate start of week (Monday) - ISO week standard, consistent with Team Analytics
    const startOfWeek = new Date(today);
    const dayOfWeek = startOfWeek.getDay();
    // If Sunday (0), go back 6 days. Otherwise, go back (dayOfWeek - 1) days.
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startOfWeek.setDate(today.getDate() - daysToMonday);
    startOfWeek.setHours(0, 0, 0, 0);

    // Build array of date strings for this week up to today
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const weekDate = new Date(startOfWeek);
      weekDate.setDate(startOfWeek.getDate() + i);
      return formatLocalDate(weekDate);
    }).filter(dateStr => dateStr <= todayStr);

    const rawTotal = (timeData?.dailySummary || []).filter(day => {
      const workDateStr = normalizeDate(day.work_date);
      return weekDates.includes(workDateStr);
    }).reduce((sum, day) => sum + (day.total_seconds || 0), 0) || 0;

    return rawTotal + todayDelta;
  };

  const calculateMonthTotal = () => {
    const currentMonth = getMonthStr();

    const rawTotal = (timeData?.dailySummary || []).filter(day => {
      const workDateStr = normalizeDate(day.work_date);
      return workDateStr.startsWith(currentMonth);
    }).reduce((sum, day) => sum + (day.total_seconds || 0), 0) || 0;

    return rawTotal + todayDelta;
  };

  return (
    <div className="analytics-summary-cards">
      <div 
        className={`analytics-card cumulative-card clickable ${activeView === 'day' ? 'active' : ''}`}
        onClick={() => {
          if (onViewChange) onViewChange('day');
          if (onDrillDown) onDrillDown('today');
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (onViewChange) onViewChange('day');
            if (onDrillDown) onDrillDown('today');
          }
        }}
        title="Click to view issue breakdown"
      >
        <div className="card-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </div>
        <div className="card-content">
          <h3>Time Spent Today</h3>
          {loading ? (
            <p>Loading...</p>
          ) : (
            <div className="cumulative-stat">
              <span className="stat-value">
                {formatTime(reconciledTodayTotal != null ? reconciledTodayTotal : rawTodayTotal)}
              </span>
            </div>
          )}
        </div>
      </div>

      <div 
        className={`analytics-card cumulative-card clickable ${activeView === 'week' ? 'active' : ''}`}
        onClick={() => {
          if (onViewChange) onViewChange('week');
          if (onDrillDown) onDrillDown('week');
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (onViewChange) onViewChange('week');
            if (onDrillDown) onDrillDown('week');
          }
        }}
        title="Click to view issue breakdown"
      >
        <div className="card-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </div>
        <div className="card-content">
          <h3>Time Spent This Week</h3>
          {loading ? (
            <p>Loading...</p>
          ) : (
            <div className="cumulative-stat">
              <span className="stat-value">
                {formatTime(calculateWeekTotal())}
              </span>
            </div>
          )}
        </div>
      </div>

      <div 
        className={`analytics-card cumulative-card clickable ${activeView === 'month' ? 'active' : ''}`}
        onClick={() => {
          if (onViewChange) onViewChange('month');
          if (onDrillDown) onDrillDown('month');
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (onViewChange) onViewChange('month');
            if (onDrillDown) onDrillDown('month');
          }
        }}
        title="Click to view issue breakdown"
      >
        <div className="card-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
            <line x1="9" y1="14" x2="9" y2="18"></line>
            <line x1="15" y1="14" x2="15" y2="18"></line>
          </svg>
        </div>
        <div className="card-content">
          <h3>Time Spent This Month</h3>
          {loading ? (
            <p>Loading...</p>
          ) : (
            <div className="cumulative-stat">
              <span className="stat-value">
                {formatTime(calculateMonthTotal())}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SummaryCards;
