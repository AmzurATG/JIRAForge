import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../utils';
import { generateExcelReport } from '../../utils/excelExport';
import './TeamMemberActivityModal.css';

function formatSessionTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Team Member Activity Modal
 * Displays detailed activity breakdown for a team member
 * Supports multiple views: Today, Week, Month, Comprehensive
 */
function TeamMemberActivityModal({
  isOpen,
  onClose,
  member,           // { userId, displayName, todayHours, weekHours, monthHours }
  projectKey,
  viewType,         // 'today' | 'week' | 'month' | 'comprehensive'
  initialDate       // For specific day/week/month view
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activityData, setActivityData] = useState(null);
  const [activeTab, setActiveTab] = useState(
    viewType === 'comprehensive' ? 'today' : (viewType || 'today')
  );
  const [exportingView, setExportingView] = useState(false);

  const loadActivityData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let result;
      const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

      switch (activeTab) {
        case 'today':
          result = await invoke('getMemberDayDetails', {
            projectKey,
            userId: member.userId,
            date: initialDate || today
          });
          break;

        case 'week':
          const weekStart = getWeekStartDate(initialDate || today);
          result = await invoke('getMemberWeekDetails', {
            projectKey,
            userId: member.userId,
            weekStartDate: weekStart
          });
          break;

        case 'month':
          const month = initialDate ? initialDate.substring(0, 7) : today.substring(0, 7);
          result = await invoke('getMemberMonthDetails', {
            projectKey,
            userId: member.userId,
            month
          });
          break;

        default:
          throw new Error('Invalid view type');
      }

      if (result.success) {
        setActivityData(result.data);
      } else {
        setError(result.error || 'Failed to load activity data');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeTab, projectKey, member, initialDate]);

  useEffect(() => {
    if (isOpen && member) {
      loadActivityData();
    }
  }, [isOpen, member, loadActivityData]);

  const getWeekStartDate = (dateStr) => {
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(date);
    monday.setDate(date.getDate() - daysToMonday);
    return monday.toLocaleDateString('sv-SE');
  };

  const handleExportView = async () => {
    setExportingView(true);
    try {
      const today = new Date();
      const todayStr = today.toLocaleDateString('sv-SE');
      let startDate, endDate;

      switch (activeTab) {
        case 'today':
          startDate = initialDate || todayStr;
          endDate = initialDate || todayStr;
          break;
        case 'week':
          startDate = getWeekStartDate(initialDate || todayStr);
          endDate = todayStr;
          break;
        case 'month':
          startDate = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('sv-SE');
          endDate = todayStr;
          break;
        default:
          startDate = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('sv-SE');
          endDate = todayStr;
      }

      const result = await invoke('exportTeamAnalyticsExcel', {
        projectKey,
        startDate,
        endDate,
        filterUserIds: [member.userId]
      });

      if (result.success) {
        await generateExcelReport(result.data, `${member.displayName}-${activeTab}-${endDate}`);
      }
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setExportingView(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="team-member-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-content">
            <h2>{member.displayName}'s Activity</h2>
            <p className="modal-subtitle">
              {viewType === 'comprehensive' ? 'Comprehensive Report' : 'Detailed Breakdown'}
            </p>
          </div>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        {viewType === 'comprehensive' ? (
          <div className="modal-tabs">
            <button
              className={`tab-btn ${activeTab === 'today' ? 'active' : ''}`}
              onClick={() => setActiveTab('today')}
            >
              Today
            </button>
            <button
              className={`tab-btn ${activeTab === 'week' ? 'active' : ''}`}
              onClick={() => setActiveTab('week')}
            >
              This Week
            </button>
            <button
              className={`tab-btn ${activeTab === 'month' ? 'active' : ''}`}
              onClick={() => setActiveTab('month')}
            >
              This Month
            </button>
          </div>
        ) : null}

        <div className="modal-content" style={{width:'100%',boxSizing:'border-box'}}>
          {loading ? (
            <div className="loading-state" style={{width:'100%',minHeight:'200px'}}>
              <div className="loading-spinner"></div>
              <p>Loading activity data...</p>
            </div>
          ) : error ? (
            <div className="error-state">
              <p>Error: {error}</p>
            </div>
          ) : (
            <>
              {activeTab === 'today' && <TodayActivityView data={activityData} />}
              {activeTab === 'week' && <WeekActivityView data={activityData} />}
              {activeTab === 'month' && <MonthActivityView data={activityData} />}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="primary-btn" onClick={handleExportView} disabled={exportingView || loading}>
            {exportingView ? 'Exporting...' : `Export ${activeTab === 'today' ? "Today's" : activeTab === 'week' ? "Week's" : "Month's"} Report`}
          </button>
          <button className="secondary-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Today Activity View Component
 */
function TodayActivityView({ data }) {
  const [expandedIssue, setExpandedIssue] = useState(null);

  if (!data || !data.issues || data.issues.length === 0) {
    return (
      <div className="empty-state">
        <p>📅 No activity recorded for this day</p>
        <p className="empty-subtitle">Work on an issue to see it here</p>
      </div>
    );
  }

  const totalSeconds = data.totalSeconds;

  return (
    <div className="today-activity-view" style={{width:'100%'}}>
      <div className="summary-section" style={{width:'100%'}}>
        <h3>Today's Summary</h3>
        <div className="summary-stats" style={{width:'100%'}}>
          <div className="stat-item">
            <div className="stat-value">{formatTime(totalSeconds)}</div>
            <div className="stat-label">Total Time</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{data.issueCount}</div>
            <div className="stat-label">Issues Worked</div>
          </div>
        </div>
      </div>

      <div className="issue-breakdown-section" style={{width:'100%'}}>
        <h3>Issue Breakdown</h3>
        <div className="issue-list" style={{width:'100%'}}>
          {data.issues.map((issue, idx) => {
            const percentage = totalSeconds > 0 ? Math.round((issue.totalSeconds / totalSeconds) * 100) : 0;
            const isExpanded = expandedIssue === idx;
            const sessionCount = issue.sessions ? issue.sessions.length : 0;

            return (
              <div key={idx} className="issue-item">
                <div className="issue-header issue-header-clickable" onClick={() => setExpandedIssue(isExpanded ? null : idx)}>
                  <div className="issue-key-summary">
                    <span className="issue-key">{issue.issueKey}</span>
                    {sessionCount > 0 && <span className="session-count">{sessionCount} sessions</span>}
                  </div>
                  <div className="issue-time">
                    <strong>{formatTime(issue.totalSeconds)}</strong>
                    <span className="issue-percentage">({percentage}%)</span>
                    <span className="issue-expand-icon">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>
                <div className="issue-progress">
                  <div 
                    className="progress-bar" 
                    style={{ width: `${percentage}%` }}
                  ></div>
                </div>
                {isExpanded && issue.sessions && issue.sessions.length > 0 && (
                  <div className="session-list">
                    {issue.sessions.map((session, sIdx) => (
                      <div key={sIdx} className="session-row">
                        <span className="session-time-range">
                          {formatSessionTime(session.startTime)} — {formatSessionTime(session.endTime)}
                        </span>
                        <span className="session-duration">{formatTime(session.seconds)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Week Activity View Component
 */
function WeekActivityView({ data }) {
  const [expandedDayIssue, setExpandedDayIssue] = useState(null);

  if (!data || !data.dailyBreakdown || data.dailyBreakdown.length === 0) {
    return (
      <div className="empty-state">
        <p>📅 No activity recorded for this week</p>
      </div>
    );
  }

  const today = new Date().toLocaleDateString('sv-SE');

  const toggleDayIssue = (dayIdx, issueIdx) => {
    const key = `${dayIdx}-${issueIdx}`;
    setExpandedDayIssue(prev => prev === key ? null : key);
  };

  return (
    <div className="week-activity-view" style={{width:'100%'}}>
      <div className="summary-section" style={{width:'100%'}}>
        <h3>Week's Summary</h3>
        <div className="summary-stats" style={{width:'100%'}}>
          <div className="stat-item">
            <div className="stat-value">{formatTime(data.totalSeconds)}</div>
            <div className="stat-label">Total Time</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{data.dailyBreakdown.filter(d => d.totalSeconds > 0).length}</div>
            <div className="stat-label">Active Days</div>
          </div>
        </div>
      </div>

      <div className="daily-breakdown-section" style={{width:'100%'}}>
        <h3>Daily Breakdown</h3>
        <div className="day-list" style={{width:'100%'}}>
          {data.dailyBreakdown.map((day, idx) => {
            const isToday = day.date === today;
            const hasActivity = day.totalSeconds > 0;

            return (
              <div key={idx} className={`day-card ${isToday ? 'today' : ''} ${!hasActivity ? 'no-activity' : ''}`}>
                <div className="day-header">
                  <div className="day-date">
                    <strong>{day.dayOfWeek}, {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</strong>
                    {isToday && <span className="today-badge">★ Today</span>}
                  </div>
                  <div className="day-total">
                    {hasActivity ? formatTime(day.totalSeconds) : 'No activity'}
                  </div>
                </div>
                {hasActivity && day.issues && day.issues.length > 0 && (
                  <div className="day-issues">
                    {day.issues.map((issue, issueIdx) => {
                      const isIssueExpanded = expandedDayIssue === `${idx}-${issueIdx}`;
                      const sessionCount = issue.sessions ? issue.sessions.length : 0;
                      return (
                        <div key={issueIdx} className="day-issue-item-block">
                          <div className="day-issue-item day-issue-clickable" onClick={() => toggleDayIssue(idx, issueIdx)}>
                            <span className="day-issue-key">{issue.issueKey}</span>
                            <span className="day-issue-time">({formatTime(issue.totalSeconds)})</span>
                            {sessionCount > 0 && <span className="session-count">{sessionCount} sessions</span>}
                            <span className="issue-expand-icon">{isIssueExpanded ? '▲' : '▼'}</span>
                          </div>
                          {isIssueExpanded && issue.sessions && issue.sessions.length > 0 && (
                            <div className="session-list compact">
                              {issue.sessions.map((session, sIdx) => (
                                <div key={sIdx} className="session-row">
                                  <span className="session-time-range">
                                    {formatSessionTime(session.startTime)} — {formatSessionTime(session.endTime)}
                                  </span>
                                  <span className="session-duration">{formatTime(session.seconds)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Month Activity View Component
 */
function MonthActivityView({ data }) {
  const [expandedWeek, setExpandedWeek] = useState(null);
  const [expandedMonthIssue, setExpandedMonthIssue] = useState(null);

  if (!data || !data.weeklyBreakdown || data.weeklyBreakdown.length === 0) {
    return (
      <div className="empty-state">
        <p>📅 No activity recorded for this month</p>
      </div>
    );
  }

  const toggleMonthIssue = (weekIdx, dayIdx, issueIdx) => {
    const key = `${weekIdx}-${dayIdx}-${issueIdx}`;
    setExpandedMonthIssue(prev => prev === key ? null : key);
  };

  return (
    <div className="month-activity-view" style={{width:'100%'}}>
      <div className="summary-section" style={{width:'100%'}}>
        <h3>Month's Summary</h3>
        <div className="summary-stats" style={{width:'100%'}}>
          <div className="stat-item">
            <div className="stat-value">{formatTime(data.totalSeconds)}</div>
            <div className="stat-label">Total Time</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{data.weeklyBreakdown.length}</div>
            <div className="stat-label">Active Weeks</div>
          </div>
        </div>
      </div>

      <div className="weekly-breakdown-section" style={{width:'100%'}}>
        <h3>Weekly Breakdown</h3>
        <div className="week-list" style={{width:'100%'}}>
          {data.weeklyBreakdown.map((week, idx) => {
            const isExpanded = expandedWeek === idx;
            const weekNum = idx + 1;

            return (
              <div key={idx} className="week-card">
                <div 
                  className="week-header" 
                  onClick={() => setExpandedWeek(isExpanded ? null : idx)}
                >
                  <div className="week-title">
                    <strong>Week {weekNum}</strong>
                    <span className="week-range">
                      ({new Date(week.weekStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - {new Date(week.weekEnd + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                    </span>
                  </div>
                  <div className="week-info">
                    <span className="week-total">{formatTime(week.totalSeconds)}</span>
                    <span className="week-expand-icon">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>
                {isExpanded && week.dailyBreakdown && week.dailyBreakdown.length > 0 && (
                  <div className="week-details">
                    {week.dailyBreakdown.map((day, dayIdx) => (
                      <div key={dayIdx} className="week-day-item">
                        <div className="week-day-header">
                          <span className="week-day-name">{day.dayOfWeek}, {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                          <span className="week-day-time">{formatTime(day.totalSeconds)}</span>
                        </div>
                        {day.issues && day.issues.length > 0 && (
                          <div className="week-day-issues">
                            {day.issues.map((issue, issueIdx) => {
                              const isIssueExpanded = expandedMonthIssue === `${idx}-${dayIdx}-${issueIdx}`;
                              const sessionCount = issue.sessions ? issue.sessions.length : 0;
                              return (
                                <div key={issueIdx} className="week-day-issue-block">
                                  <div className="week-day-issue day-issue-clickable" onClick={() => toggleMonthIssue(idx, dayIdx, issueIdx)}>
                                    <span className="week-issue-key">{issue.issueKey}</span>
                                    <span className="week-issue-time">({formatTime(issue.totalSeconds)})</span>
                                    {sessionCount > 0 && <span className="session-count">{sessionCount} sessions</span>}
                                    <span className="issue-expand-icon">{isIssueExpanded ? '▲' : '▼'}</span>
                                  </div>
                                  {isIssueExpanded && issue.sessions && issue.sessions.length > 0 && (
                                    <div className="session-list compact">
                                      {issue.sessions.map((session, sIdx) => (
                                        <div key={sIdx} className="session-row">
                                          <span className="session-time-range">
                                            {formatSessionTime(session.startTime)} — {formatSessionTime(session.endTime)}
                                          </span>
                                          <span className="session-duration">{formatTime(session.seconds)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default TeamMemberActivityModal;
