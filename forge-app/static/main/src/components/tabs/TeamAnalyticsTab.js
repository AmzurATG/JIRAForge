import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import { useApp } from '../../context';
import { navigateToIssue, formatTime } from '../../utils';
import TeamMemberActivityModal from '../modals/TeamMemberActivityModal';
import ExportTeamAnalyticsModal from '../modals/ExportTeamAnalyticsModal';
import './TeamAnalyticsTab.css';

function TeamAnalyticsTab() {
  const { userPermissions, selectedProjectKey, setSelectedProjectKey } = useApp();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [teamAnalytics, setTeamAnalytics] = useState(null);
  const [issueViewMode, setIssueViewMode] = useState('list'); // 'list' or 'grid'
  const [selectedTrendDay, setSelectedTrendDay] = useState(null); // Selected day from Activity Trend
  
  // Modal state
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [activityViewType, setActivityViewType] = useState('today');
  const [exportModalOpen, setExportModalOpen] = useState(false);

  const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  const getAvatarColor = (name) => {
    const colors = [
      '#0052CC', '#00875A', '#FF5630', '#6554C0',
      '#FF991F', '#00B8D9', '#36B37E', '#FFAB00',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  useEffect(() => {
    if (selectedProjectKey) {
      loadTeamAnalytics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectKey]);

  const loadTeamAnalytics = async () => {
    if (!selectedProjectKey) return;
    setLoading(true);
    setError(null);
    setSelectedTrendDay(null); // Reset selected day when loading new data
    try {
      const result = await invoke('getProjectTeamAnalytics', {
        projectKey: selectedProjectKey,
        clientToday: new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD in local timezone
      });
      if (result.success) {
        setTeamAnalytics(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to load team analytics: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Handle clicking on a trend bar - show that day's member breakdown
  const handleTrendBarClick = (day) => {
    if (selectedTrendDay?.date === day.date) {
      // Clicking same day again clears selection
      setSelectedTrendDay(null);
    } else {
      setSelectedTrendDay(day);
    }
  };

  // Get member activity for a specific selected day
  const getSelectedDayMemberActivity = () => {
    if (!selectedTrendDay || !teamAnalytics?.teamDailySummary) {
      return null;
    }

    const selectedDate = selectedTrendDay.date;
    const allUsers = new Set();

    // Get all users from the regular member activity
    (teamAnalytics.teamMemberActivity || []).forEach(m => {
      allUsers.add(m.userId);
    });

    // Filter daily summary for the selected date
    const dayData = teamAnalytics.teamDailySummary.filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate === selectedDate;
    });

    // Add any users from the day data
    dayData.forEach(d => allUsers.add(d.user_id));

    // Calculate hours per user for this specific day
    const memberData = Array.from(allUsers).map(userId => {
      const memberInfo = (teamAnalytics.teamMemberActivity || []).find(m => m.userId === userId);
      const displayName = memberInfo?.displayName || 'Unknown User';

      const userDayData = dayData.filter(d => d.user_id === userId);
      const totalSeconds = userDayData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
      const hours = Math.round(totalSeconds / 3600 * 10) / 10;

      return {
        userId,
        displayName,
        hours
      };
    });

    // Sort by hours (descending)
    return memberData.sort((a, b) => b.hours - a.hours);
  };

  // Format selected day for display
  const formatSelectedDay = () => {
    if (!selectedTrendDay) return '';
    const date = new Date(selectedTrendDay.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', { 
      weekday: 'long', 
      month: 'short', 
      day: 'numeric' 
    });
  };

  // Handler for clicking on "Today" hours
  const handleTodayClick = (member) => {
    setSelectedMember(member);
    setActivityViewType('today');
    setActivityModalOpen(true);
  };

  // Handler for clicking on "This Week" hours
  const handleWeekClick = (member) => {
    setSelectedMember(member);
    setActivityViewType('week');
    setActivityModalOpen(true);
  };

  // Handler for clicking on "This Month" hours
  const handleMonthClick = (member) => {
    setSelectedMember(member);
    setActivityViewType('month');
    setActivityModalOpen(true);
  };

  // Handler for clicking on member name
  const handleMemberNameClick = (member) => {
    setSelectedMember(member);
    setActivityViewType('comprehensive');
    setActivityModalOpen(true);
  };

  // Handler for export button
  const handleExportClick = () => {
    setExportModalOpen(true);
  };

  return (
    <div className="team-analytics">
      <div className="team-analytics-header">
        <h2>Team Analytics Dashboard</h2>
        <div className="header-actions">
          <div className="project-selector">
            <label htmlFor="team-project-select">Project: </label>
            <select
              id="team-project-select"
              value={selectedProjectKey}
              onChange={(e) => setSelectedProjectKey(e.target.value)}
            >
              {(userPermissions.isJiraAdmin
                ? userPermissions.allProjectKeys
                : userPermissions.projectAdminProjects
              )?.map(pk => (
                <option key={pk} value={pk}>{pk}</option>
              ))}
            </select>
          </div>
          <button className="export-btn" onClick={handleExportClick} title="Export Team Analytics">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Export
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading team analytics...</p>
        </div>
      ) : error ? (
        <p className="error">Error: {error}</p>
      ) : (
        <>
          {/* KPI Summary Cards */}
          <div className="team-kpi-cards">
            <div className="team-kpi-card">
              <div className="kpi-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16 21V19C16 17.9391 15.5786 16.9217 14.8284 16.1716C14.0783 15.4214 13.0609 15 12 15H5C3.93913 15 2.92172 15.4214 2.17157 16.1716C1.42143 16.9217 1 17.9391 1 19V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M8.5 11C10.7091 11 12.5 9.20914 12.5 7C12.5 4.79086 10.7091 3 8.5 3C6.29086 3 4.5 4.79086 4.5 7C4.5 9.20914 6.29086 11 8.5 11Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M20 8V14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M23 11H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="kpi-content">
                <div className="kpi-value-row">
                  <div className="kpi-value">{teamAnalytics?.teamSummary?.activeMembers || 0}</div>
                  <div className="kpi-info-wrapper">
                    <span className="kpi-info-icon">i</span>
                    <span className="kpi-info-tooltip">
                      Number of team members who have tracked at least some time on this project this month.
                    </span>
                  </div>
                </div>
                <div className="kpi-label">Active Members</div>
              </div>
            </div>
            <div className="team-kpi-card">
              <div className="kpi-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 20V10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 20V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M6 20V14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="kpi-content">
                <div className="kpi-value-row">
                  <div className="kpi-value">{teamAnalytics?.teamSummary?.totalSecondsThisMonth ? formatTime(teamAnalytics.teamSummary.totalSecondsThisMonth) : '0s'}</div>
                  <div className="kpi-info-wrapper">
                    <span className="kpi-info-icon">i</span>
                    <span className="kpi-info-tooltip">
                      Total hours tracked by all team members on this project during the current month.
                    </span>
                  </div>
                </div>
                <div className="kpi-label">Total Hours This Month</div>
              </div>
            </div>
            <div className="team-kpi-card">
              <div className="kpi-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M14 2V8H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M16 13H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M16 17H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M10 9H9H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="kpi-content">
                <div className="kpi-value-row">
                  <div className="kpi-value">{teamAnalytics?.teamSummary?.issuesWorked || 0}</div>
                  <div className="kpi-info-wrapper">
                    <span className="kpi-info-icon">i</span>
                    <span className="kpi-info-tooltip">
                      Number of unique Jira issues with tracked time entries this month.
                    </span>
                  </div>
                </div>
                <div className="kpi-label">Issues Worked</div>
              </div>
            </div>
          </div>

          {/* Two Column Layout: Activity Trend + Member Activity */}
          <div className="team-analytics-grid">
            {/* Activity Trend Chart - First */}
            <div className="team-section team-activity-trend">
              <div className="section-header">
                <div className="section-title-row">
                  <h3>Activity Trend</h3>
                  <div className="section-info-wrapper">
                    <span className="section-info-icon">i</span>
                    <span className="section-info-tooltip">
                      Visual representation of daily team work hours over the last 14 days. Taller bars indicate more hours tracked.
                    </span>
                  </div>
                </div>
                <span className="section-subtitle">Daily team hours - Last 14 days</span>
              </div>
              <div className="trend-chart-container">
                {teamAnalytics?.activityTrend?.length > 0 ? (
                  <div className="trend-chart">
                    {(() => {
                      const maxHours = Math.max(...teamAnalytics.activityTrend.map(d => d.totalHours), 0.1);
                      const maxBarHeight = 140; // Fixed pixel height for the tallest bar
                      return teamAnalytics.activityTrend.map((day, idx) => {
                        // Calculate bar height in pixels (minimum 8px if there's any value for visibility)
                        const barHeight = day.totalHours > 0
                          ? Math.max(8, Math.round((day.totalHours / maxHours) * maxBarHeight))
                          : 0;
                        const isWeekend = day.dayOfWeek === 'Sat' || day.dayOfWeek === 'Sun';
                        const isSelected = selectedTrendDay?.date === day.date;
                        return (
                          <div 
                            key={idx} 
                            className={`trend-bar-wrapper clickable ${isSelected ? 'selected' : ''}`}
                            onClick={() => handleTrendBarClick(day)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && handleTrendBarClick(day)}
                          >
                            <span className="trend-bar-value">{day.totalHours > 0 ? `${day.totalHours}h` : '\u00A0'}</span>
                            <div
                              className={`trend-bar ${day.totalHours === 0 ? 'empty-bar' : ''} ${isWeekend ? 'weekend' : ''} ${isSelected ? 'selected' : ''}`}
                              style={{ height: `${barHeight}px` }}
                              title={`${day.date}: ${day.totalHours}h - Click to see member breakdown`}
                            >
                            </div>
                            <div className="trend-bar-labels">
                              <span className="trend-bar-day">{day.dayOfWeek}</span>
                              <span className="trend-bar-date">{day.dayOfMonth}</span>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                ) : (
                  <p className="empty-state">No activity trend data available</p>
                )}
              </div>
            </div>

            {/* Team Member Activity Table - Second */}
            <div className="team-section team-member-activity">
              <div className="section-header">
                <div className="section-title-row">
                  <h3>Team Member Activity</h3>
                  <div className="section-info-wrapper">
                    <span className="section-info-icon">i</span>
                    <span className="section-info-tooltip">
                      {selectedTrendDay 
                        ? `Hours tracked by each team member on ${formatSelectedDay()}`
                        : 'Breakdown of hours tracked by each team member for today, this week (Mon-Sun), and this month.'
                      }
                    </span>
                  </div>
                  {selectedTrendDay && (
                    <button 
                      className="clear-selection-btn"
                      onClick={() => setSelectedTrendDay(null)}
                      title="Clear selection"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Clear
                    </button>
                  )}
                </div>
                <span className="section-subtitle">
                  {selectedTrendDay 
                    ? `Showing activity for ${formatSelectedDay()} (${selectedTrendDay.totalHours}h total)`
                    : 'Hours tracked by each team member'
                  }
                </span>
              </div>
              <div className="team-member-table-container">
                {selectedTrendDay ? (
                  // Show selected day's breakdown
                  <table className="team-member-table selected-day-view">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Hours on {selectedTrendDay.dayOfWeek} {selectedTrendDay.dayOfMonth}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const dayMembers = getSelectedDayMemberActivity();
                        if (!dayMembers || dayMembers.length === 0) {
                          return (
                            <tr>
                              <td colSpan="2" className="empty-state">No activity on this day</td>
                            </tr>
                          );
                        }
                        return dayMembers.map((member, idx) => (
                          <tr key={idx} className={member.hours === 0 ? 'no-activity' : ''}>
                            <td className="member-name-cell">
                              <div 
                                className="member-avatar"
                                style={{ backgroundColor: getAvatarColor(member.displayName) }}
                                title={member.displayName}
                              >
                                {getInitials(member.displayName)}
                              </div>
                              <span className="member-name">{member.displayName}</span>
                            </td>
                            <td className="hours-cell single-day">
                              <strong>{member.hours}h</strong>
                              {member.hours === 0 && <span className="no-activity-label">No activity</span>}
                            </td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                ) : (
                  // Show default Today/Week/Month view
                  <table className="team-member-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Today</th>
                        <th>This Week</th>
                        <th>This Month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamAnalytics?.teamMemberActivity?.length > 0 ? (
                        teamAnalytics.teamMemberActivity.map((member, idx) => (
                          <tr key={idx}>
                            <td className="member-name-cell clickable" onClick={() => handleMemberNameClick(member)}>
                              <div 
                                className="member-avatar"
                                style={{ backgroundColor: getAvatarColor(member.displayName) }}
                                title={member.displayName}
                              >
                                {getInitials(member.displayName)}
                              </div>
                              <span className="member-name">{member.displayName}</span>
                            </td>
                            <td className="hours-cell clickable" onClick={() => handleTodayClick(member)}>
                              <strong>{formatTime(member.todaySeconds)}</strong>
                            </td>
                            <td className="hours-cell clickable" onClick={() => handleWeekClick(member)}>
                              <strong>{formatTime(member.weekSeconds)}</strong>
                            </td>
                            <td className="hours-cell clickable" onClick={() => handleMonthClick(member)}>
                              <strong>{formatTime(member.monthSeconds)}</strong>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="4" className="empty-state">No team member activity yet</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* Time by Issue Section */}
          <div className="team-section team-time-by-issue">
            <div className="section-header">
              <div className="section-title-row">
                <h3>Time by Issue</h3>
                <div className="section-info-wrapper">
                  <span className="section-info-icon">i</span>
                  <span className="section-info-tooltip">
                    Top issues by time tracked. Distribution shows what percentage of total team time was spent on each issue.
                  </span>
                </div>
                <div className="view-toggle-buttons">
                  <button
                    className={`view-toggle-btn ${issueViewMode === 'list' ? 'active' : ''}`}
                    onClick={() => setIssueViewMode('list')}
                    title="List View"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M8 6H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M8 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M8 18H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M3 6H3.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M3 12H3.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M3 18H3.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  <button
                    className={`view-toggle-btn ${issueViewMode === 'grid' ? 'active' : ''}`}
                    onClick={() => setIssueViewMode('grid')}
                    title="Grid View"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="3" y="3" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <rect x="14" y="3" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <rect x="3" y="14" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <rect x="14" y="14" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              </div>
              {/* <span className="section-subtitle">Team effort distribution across issues</span> */}
            </div>
            <div className="issue-list-container">
              {teamAnalytics?.teamTimeByIssue?.length > 0 ? (
                issueViewMode === 'list' ? (
                  <table className="issue-list-table">
                    <thead>
                      <tr>
                        <th className="issue-rank-header">#</th>
                        <th className="issue-key-header">Issue</th>
                        <th className="issue-time-header">Time Spent</th>
                        <th className="issue-progress-header">Distribution</th>
                        <th className="issue-members-header">Contributors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        // Calculate total time across ALL issues for true distribution percentage
                        const totalSeconds = teamAnalytics.teamTimeByIssue.reduce((sum, i) => sum + i.totalSeconds, 0);
                        return teamAnalytics.teamTimeByIssue.slice(0, 10).map((issue, idx) => {
                          const percentage = totalSeconds > 0 ? Math.round((issue.totalSeconds / totalSeconds) * 100) : 0;
                          const visibleContributors = (issue.contributorDetails || []).slice(0, 3);
                          const remainingCount = (issue.contributorDetails || []).length - 3;
                          return (
                            <tr key={idx} className="issue-list-row">
                              <td className="issue-rank-cell">
                                <span className={`rank-badge rank-${idx + 1}`}>{idx + 1}</span>
                              </td>
                              <td className="issue-key-cell">
                                <a
                                  href={`/browse/${issue.issueKey}`}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    navigateToIssue(issue.issueKey);
                                  }}
                                  className="issue-key-link"
                                >
                                  {issue.issueKey}
                                </a>
                              </td>
                              <td className="issue-time-cell">
                                <span className="time-value">{formatTime(issue.totalSeconds)}</span>
                              </td>
                              <td className="issue-progress-cell">
                                <div className="progress-wrapper">
                                  <div className="issue-bar-track">
                                    <div
                                      className={`issue-bar-fill rank-fill-${Math.min(idx + 1, 6)}`}
                                      style={{ width: `${percentage}%` }}
                                    ></div>
                                  </div>
                                  <span className="progress-percentage">{percentage}%</span>
                                </div>
                              </td>
                              <td className="issue-members-cell">
                                <div className="contributors-avatars">
                                  {visibleContributors.map((contributor, cIdx) => (
                                    <div
                                      key={cIdx}
                                      className="contributor-avatar"
                                      style={{ backgroundColor: getAvatarColor(contributor.displayName) }}
                                      title={contributor.displayName}
                                    >
                                      {getInitials(contributor.displayName)}
                                      <span className="contributor-tooltip">{contributor.displayName}</span>
                                    </div>
                                  ))}
                                  {remainingCount > 0 && (
                                    <div className="contributor-avatar contributor-more" title={`${remainingCount} more contributor${remainingCount > 1 ? 's' : ''}`}>
                                      +{remainingCount}
                                      <span className="contributor-tooltip">
                                        {(issue.contributorDetails || []).slice(3).map(c => c.displayName).join(', ')}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                ) : (
                  <div className="issue-grid">
                    {(() => {
                      // Calculate total time across ALL issues for true distribution percentage
                      const totalSeconds = teamAnalytics.teamTimeByIssue.reduce((sum, i) => sum + i.totalSeconds, 0);
                      return teamAnalytics.teamTimeByIssue.slice(0, 10).map((issue, idx) => {
                        const percentage = totalSeconds > 0 ? Math.round((issue.totalSeconds / totalSeconds) * 100) : 0;
                        const visibleContributors = (issue.contributorDetails || []).slice(0, 3);
                        const remainingCount = (issue.contributorDetails || []).length - 3;
                        return (
                          <div key={idx} className="issue-card">
                            <div className="issue-card-header">
                              <span className={`rank-badge rank-${idx + 1}`}>{idx + 1}</span>
                              <a
                                href={`/browse/${issue.issueKey}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  navigateToIssue(issue.issueKey);
                                }}
                                className="issue-key-link"
                              >
                                {issue.issueKey}
                              </a>
                            </div>
                            <div className="issue-card-time">
                              <span className="time-label">Time Spent</span>
                              <span className="time-value">{formatTime(issue.totalSeconds)}</span>
                            </div>
                            <div className="issue-card-progress">
                              <div className="issue-bar-track">
                                <div
                                  className={`issue-bar-fill rank-fill-${Math.min(idx + 1, 6)}`}
                                  style={{ width: `${percentage}%` }}
                                ></div>
                              </div>
                              <span className="progress-percentage">{percentage}%</span>
                            </div>
                            <div className="issue-card-contributors">
                              <span className="contributors-label">Contributors</span>
                              <div className="contributors-avatars">
                                {visibleContributors.map((contributor, cIdx) => (
                                  <div
                                    key={cIdx}
                                    className="contributor-avatar"
                                    style={{ backgroundColor: getAvatarColor(contributor.displayName) }}
                                    title={contributor.displayName}
                                  >
                                    {getInitials(contributor.displayName)}
                                    <span className="contributor-tooltip">{contributor.displayName}</span>
                                  </div>
                                ))}
                                {remainingCount > 0 && (
                                  <div className="contributor-avatar contributor-more" title={`${remainingCount} more contributor${remainingCount > 1 ? 's' : ''}`}>
                                    +{remainingCount}
                                    <span className="contributor-tooltip">
                                      {(issue.contributorDetails || []).slice(3).map(c => c.displayName).join(', ')}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )
              ) : (
                <p className="empty-state">No issue data available yet</p>
              )}
            </div>
          </div>
        </>
      )}
      
      {/* Team Member Activity Modal */}
      {activityModalOpen && selectedMember && (
        <TeamMemberActivityModal
          isOpen={activityModalOpen}
          onClose={() => {
            setActivityModalOpen(false);
            loadTeamAnalytics(); // Refresh table data to stay in sync with modal
          }}
          member={selectedMember}
          viewType={activityViewType}
          projectKey={selectedProjectKey}
        />
      )}

      {/* Export Team Analytics Modal */}
      {exportModalOpen && (
        <ExportTeamAnalyticsModal
          isOpen={exportModalOpen}
          onClose={() => setExportModalOpen(false)}
          projectKey={selectedProjectKey}
          teamAnalytics={teamAnalytics}
        />
      )}
    </div>
  );
}

export default TeamAnalyticsTab;
