import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';
import { useApp } from '../../context';
import { IssueTypeIcon, StatusDropdown } from '../common';
import { navigateToIssue, formatTime } from '../../utils';
import { parseUTC } from '../tabs/time-analytics/dateUtils';
import QualityCell from './QualityCell';
import './DashboardTab.css';


function DashboardTab({ onOpenReassignModal }) {
  const {
    activeIssues,
    issuesLoading,
    loadActiveIssues,
    statusUpdating,
    handleStatusChange,
    loadTransitionsForIssue
  } = useApp();

  const [issueFilter, setIssueFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [approvingSessionId, setApprovingSessionId] = useState(null);
  const [approvingIssueKey, setApprovingIssueKey] = useState(null);
  const itemsPerPage = 10;

  // Description Quality states
  const [qualityScores, setQualityScores] = useState({});
  const [qualitySortOrder, setQualitySortOrder] = useState(null); // null, 'asc', or 'desc'
  const [lastAnalysedTime, setLastAnalysedTime] = useState(null);
  const [, setTick] = useState(0);

  // Timer tick to update last analysed relative time
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 10000);
    return () => clearInterval(interval);
  }, []);


  const pendingReviewCount = activeIssues.filter(i => i.hasPendingApproval).length;
  const isPendingReviewView = issueFilter === 'pending-review';

  const collectPendingSessionIds = (issue) => {
    if (!issue?.sessions?.length) return [];
    const ids = [];
    for (const session of issue.sessions) {
      if (session.approvalStatus !== 'pending_approval') continue;
      for (const id of (session.activityRecordIds || [])) {
        if (id) ids.push(id);
      }
    }
    return ids;
  };

  const handleApproveSession = async (session) => {
    const ids = session.activityRecordIds;
    if (!ids || ids.length === 0 || approvingSessionId) return;
    const sessionKey = ids.join(',');
    setApprovingSessionId(sessionKey);
    try {
      const res = await invoke('approveRecords', { sessionIds: ids });
      if (res?.success) {
        await loadActiveIssues();
      } else {
        alert(`Failed to approve: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      alert(`Error approving session: ${err.message}`);
    } finally {
      setApprovingSessionId(null);
    }
  };

  const handleApproveAllForIssue = async (issue) => {
    if (approvingIssueKey) return;
    const ids = collectPendingSessionIds(issue);
    if (ids.length === 0) return;
    setApprovingIssueKey(issue.key);
    try {
      const res = await invoke('approveRecords', { sessionIds: ids });
      if (res?.success) {
        await loadActiveIssues();
      } else {
        alert(`Failed to approve: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      alert(`Error approving issue time: ${err.message}`);
    } finally {
      setApprovingIssueKey(null);
    }
  };

  // Open the reassign modal for *every* pending session of an issue at once.
  // We synthesise a session whose activityRecordIds contain all pending IDs;
  // App.js's handleReassignSession routes it through reassignAndApproveRecords.
  const handleReassignAllForIssue = (issue) => {
    const ids = collectPendingSessionIds(issue);
    if (ids.length === 0) return;
    const bundledSession = {
      activityRecordIds: ids,
      duration: Number(issue.pendingApprovalSeconds) || 0,
      approvalStatus: 'pending_approval'
    };
    onOpenReassignModal(bundledSession, issue.key);
  };

  useEffect(() => {
    loadActiveIssues();
  }, [loadActiveIssues]);

  // Fetch quality scores for a list of issues
  const fetchQualityScoresForIssues = useCallback(async (issuesList) => {
    if (!issuesList || issuesList.length === 0) return;
    const issueKeys = issuesList.map(i => i.key);
    
    // Set loading state
    setQualityScores(prev => {
      const next = { ...prev };
      for (const key of issueKeys) {
        if (!next[key]) {
          next[key] = { status: 'pending' };
        }
      }
      return next;
    });

    try {
      // Pass 1: Cache read
      const cacheRes = await invoke('getDescriptionScores', { issueKeys });
      const cachedScores = cacheRes?.scores || {};
      
      setQualityScores(prev => {
        const next = { ...prev };
        for (const key of issueKeys) {
          if (cachedScores[key]) {
            next[key] = {
              status: 'success',
              score: cachedScores[key].score,
              source: cachedScores[key].source,
              cachedAt: cachedScores[key].cachedAt
            };
          }
        }
        return next;
      });

      // Update last analysed time
      setLastAnalysedTime(new Date());

      // Pass 2: Cache fill for misses
      const missKeys = issueKeys.filter(key => !cachedScores[key]);
      if (missKeys.length > 0) {
        setQualityScores(prev => {
          const next = { ...prev };
          for (const key of missKeys) {
            next[key] = { status: 'pending' };
          }
          return next;
        });

        const fillRes = await invoke('fillDescriptionScores', { issueKeys: missKeys });
        const filledScores = fillRes?.scores || {};

        setQualityScores(prev => {
          const next = { ...prev };
          for (const key of missKeys) {
            if (filledScores[key]) {
              if (filledScores[key].error) {
                next[key] = { status: 'error', error: filledScores[key].message || filledScores[key].error };
              } else {
                next[key] = {
                  status: 'success',
                  score: filledScores[key].score,
                  source: filledScores[key].source,
                  cachedAt: filledScores[key].cachedAt
                };
              }
            } else {
              next[key] = { status: 'error', error: 'Analysis failed' };
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('[DashboardTab] Failed to fetch quality scores:', err);
      setQualityScores(prev => {
        const next = { ...prev };
        for (const key of issueKeys) {
          if (next[key]?.status === 'pending') {
            next[key] = { status: 'error', error: err.message };
          }
        }
        return next;
      });
    }
  }, []);

  const handleRetryQuality = (issueKey) => {
    const issue = activeIssues.find(i => i.key === issueKey);
    if (issue) {
      fetchQualityScoresForIssues([issue]);
    }
  };



  const handleToggleQualitySort = () => {
    setQualitySortOrder(prev => {
      if (prev === null) return 'asc';
      if (prev === 'asc') return 'desc';
      return null;
    });
  };

  function formatLastAnalysed(time) {
    if (!time) return '';
    const seconds = Math.floor((new Date() - time) / 1000);
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return time.toLocaleTimeString();
  }


  const matchesTimeFilter = (issue) => {
    const trackedSeconds = Number(issue.timeTracked) || 0;
    if (timeFilter === 'all') return true;
    if (timeFilter === 'with-time') return trackedSeconds > 0;
    if (timeFilter === 'without-time') return trackedSeconds <= 0;
    return true;
  };

  const getFilterDescription = () => {
    const parts = [];

    if (issueFilter === 'pending-review') {
      parts.push('pending review');
    }
    if (statusFilter !== 'all') {
      parts.push(statusFilter === 'in-progress' ? 'in progress' : 'done');
    }
    if (timeFilter === 'with-time') {
      parts.push('with time tracked');
    }
    if (timeFilter === 'without-time') {
      parts.push('without time logged');
    }

    if (parts.length === 0) {
      return 'your current filters';
    }

    return parts.join(' and ');
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [issueFilter, searchQuery, timeFilter, statusFilter]);


  const filteredIssues = activeIssues.filter(issue => {
    // Filter by tab (issueFilter)
    let tabMatch = true;
    if (issueFilter === 'pending-review') {
      tabMatch = !!issue.hasPendingApproval;
    }

    // Filter by status category dropdown
    let statusMatch = true;
    if (statusFilter === 'in-progress') {
      statusMatch = issue.statusCategory === 'indeterminate';
    } else if (statusFilter === 'done') {
      statusMatch = issue.statusCategory === 'done';
    }

    // Filter by time tracked
    let timeMatch = matchesTimeFilter(issue);

    // Filter by search query
    let searchMatch = true;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      searchMatch =
        issue.key.toLowerCase().includes(query) ||
        issue.summary.toLowerCase().includes(query) ||
        issue.status.toLowerCase().includes(query) ||
        issue.priority.toLowerCase().includes(query);
    }

    return tabMatch && statusMatch && timeMatch && searchMatch;
  });

  // Apply sorting
  if (qualitySortOrder) {
    filteredIssues.sort((a, b) => {
      const scoreA = qualityScores[a.key]?.status === 'success' ? qualityScores[a.key].score : null;
      const scoreB = qualityScores[b.key]?.status === 'success' ? qualityScores[b.key].score : null;

      // Pending/error/null scores always sort to the end
      if (scoreA === null && scoreB === null) return 0;
      if (scoreA === null) return 1;
      if (scoreB === null) return -1;

      if (qualitySortOrder === 'asc') {
        return scoreA - scoreB;
      } else {
        return scoreB - scoreA;
      }
    });
  }


  // Pagination calculations
  const totalPages = Math.ceil(filteredIssues.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedIssues = filteredIssues.slice(startIndex, endIndex);

  // Fetch quality scores for currently visible issues on mount/paginate/filter
  useEffect(() => {
    if (paginatedIssues.length > 0) {
      const needsLoading = paginatedIssues.filter(i => {
        const state = qualityScores[i.key];
        return !state;
      });
      if (needsLoading.length > 0) {
        fetchQualityScoresForIssues(needsLoading);
      }
    }
  }, [paginatedIssues, fetchQualityScoresForIssues, qualityScores]);

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const handleExpandClick = (e) => {
    e.preventDefault();
    const button = e.target.closest('.expand-button');
    const row = button.closest('tr');
    const detailsRow = row.nextElementSibling;
    if (detailsRow && detailsRow.classList.contains('details-row')) {
      detailsRow.classList.toggle('show');
      button.classList.toggle('expanded', detailsRow.classList.contains('show'));
    }
  };

  const groupSessionsByDate = (sessions) => {
    return sessions.reduce((acc, session) => {
      const dateKey = session.date;
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(session);
      return acc;
    }, {});
  };

  const calculateTotalDuration = (sessions) => {
    return sessions.reduce((sum, s) => {
      // Use the actual accumulated duration from backend, not timestamp span
      // Timestamp span includes idle time between merged screenshots
      return sum + (s.duration || 0);
    }, 0);
  };

  return (
    <div className="dashboard">
      <h2>My Focus</h2>

      <div className="my-focus-widget">
        {/* <h2>My Focus</h2>
        <p className="widget-subtitle">Your personalized development workflow hub</p> */}

        <div className="focus-header">
          <div className="focus-tabs">
            <button
              className={issueFilter === 'all' ? 'active' : ''}
              onClick={() => setIssueFilter('all')}
            >
              All Issues
            </button>
            <button
              className={issueFilter === 'pending-review' ? 'active' : ''}
              onClick={() => setIssueFilter('pending-review')}
              title="AI-assigned time waiting for your approval"
            >
              Pending Review
              {pendingReviewCount > 0 && (
                <span className="focus-tab-badge">{pendingReviewCount}</span>
              )}
            </button>
          </div>

          <div className="focus-controls">
            <div className="focus-status-filter" aria-label="Filter issues by status category">
              <label className="focus-status-filter-label" htmlFor="my-focus-status-filter">Status:</label>
              <select
                id="my-focus-status-filter"
                className="focus-status-filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All</option>
                <option value="in-progress">In Progress</option>
                <option value="done">Done</option>
              </select>
            </div>
            <div className="focus-time-filter" aria-label="Filter issues by time status">
              <label className="focus-time-filter-label" htmlFor="my-focus-time-filter">Time:</label>
              <select
                id="my-focus-time-filter"
                className="focus-time-filter-select"
                value={timeFilter}
                onChange={(e) => setTimeFilter(e.target.value)}
              >
                <option value="all">All</option>
                <option value="with-time">With Time</option>
                <option value="without-time">No Time</option>
              </select>
            </div>
            <div className="focus-actions">
              <div className="focus-search">
                <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search tasks..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    className="clear-search"
                    onClick={() => setSearchQuery('')}
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
              <button className="filter-button" title="Filter options">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="21" x2="4" y2="14"></line>
                  <line x1="4" y1="10" x2="4" y2="3"></line>
                  <line x1="12" y1="21" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12" y2="3"></line>
                  <line x1="20" y1="21" x2="20" y2="16"></line>
                  <line x1="20" y1="12" x2="20" y2="3"></line>
                  <line x1="1" y1="14" x2="7" y2="14"></line>
                  <line x1="9" y1="8" x2="15" y2="8"></line>
                  <line x1="17" y1="16" x2="23" y2="16"></line>
                </svg>
                <span>Filter</span>
              </button>
            </div>
          </div>
        </div>

        {issuesLoading && activeIssues.length === 0 ? (
          // Only show the full-page loader on the FIRST load. Subsequent
          // refetches (after Approve all, Reassign, status change, etc.) keep
          // the table visible so the user doesn't lose expanded rows or
          // scroll position. A subtle inline indicator covers in-flight state.
          <p className="loading-text">Loading issues...</p>
        ) : (
          <>
            {issuesLoading && (
              <div className="refresh-indicator" aria-live="polite">
                Refreshing…
              </div>
            )}
            {lastAnalysedTime && filteredIssues.length > 0 && (
              <div className="quality-recheck-row">
                <span>Last analysed: {formatLastAnalysed(lastAnalysedTime)}</span>
              </div>
            )}
            {filteredIssues.length > 0 ? (
              <div className="issues-table-container">
                <table className="issues-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th 
                        className={`sortable-header ${qualitySortOrder ? 'sorted' : ''}`}
                        onClick={handleToggleQualitySort}
                        style={{ cursor: 'pointer', textAlign: 'right', paddingRight: '16px' }}
                        title="Sort by description quality"
                      >
                        Quality {qualitySortOrder === 'asc' ? '▲' : qualitySortOrder === 'desc' ? '▼' : ''}
                      </th>
                      <th>Time Tracked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedIssues.map((issue, idx) => {
                      const trackedSeconds = Number(issue.timeTracked) || 0;
                      const pendingSeconds = Number(issue.pendingApprovalSeconds) || 0;
                      // pendingApprovalCount is record-count from the backend
                      // (one per activity_record row).  pendingSessionCount is
                      // the count of UI-aggregated sessions (multiple records
                      // collapse into one session within a 10-min gap).  They
                      // measure different things and are NOT interchangeable —
                      // we display the session count because that matches what
                      // the user sees when expanding the row.
                      const pendingCount = Number(issue.pendingApprovalCount) || 0;
                      const pendingSessionCount = (issue.sessions || []).filter(
                        (s) => s.approvalStatus === 'pending_approval'
                      ).length;
                      const hasTrackedTime = trackedSeconds > 0;
                      const showPendingCell = isPendingReviewView && pendingCount > 0;
                      const isApprovingThisIssue = approvingIssueKey === issue.key;

                      return (
                      <React.Fragment key={idx}>
                        <tr className={issue.sessions?.length > 0 ? 'expandable-row' : ''}>
                          <td className="issue-key">
                            {issue.sessions?.length > 0 ? (
                              <button className="expand-button" onClick={handleExpandClick}>
                                ›
                              </button>
                            ) : (
                              <span className="expand-placeholder"></span>
                            )}
                            <IssueTypeIcon
                              issueType={issue.issueType}
                              iconUrl={issue.issueTypeIconUrl}
                            />
                            <a
                              href={`/browse/${issue.key}`}
                              onClick={(e) => {
                                e.preventDefault();
                                navigateToIssue(issue.key);
                              }}
                              style={{ cursor: 'pointer' }}
                            >
                              {issue.key}
                            </a>
                          </td>
                          <td className="issue-title">{issue.summary}</td>
                          <td className="issue-status">
                            <StatusDropdown
                              issue={issue}
                              onStatusChange={handleStatusChange}
                              isUpdating={statusUpdating === issue.key}
                              onLoadTransitions={loadTransitionsForIssue}
                            />
                          </td>
                          <td className="issue-priority">
                            <span className={`priority-badge priority-${issue.priority.toLowerCase()}`}>
                              {issue.priority}
                            </span>
                          </td>
                          <td className="issue-quality-cell">
                            <QualityCell
                              issueKey={issue.key}
                              score={qualityScores[issue.key]?.score}
                              status={qualityScores[issue.key]?.status}
                              error={qualityScores[issue.key]?.error}
                              cachedAt={qualityScores[issue.key]?.cachedAt}
                              onRetry={handleRetryQuality}
                            />
                          </td>
                          <td className={`issue-time ${showPendingCell ? 'pending-cell' : (hasTrackedTime ? 'has-time' : 'no-time')}`}>
                            {showPendingCell ? (
                              <div className="pending-approval-cell">
                                <div className="pending-approval-meta">
                                  <span className="pending-approval-amount">{formatTime(pendingSeconds)}</span>
                                  <span className="pending-approval-label">
                                    awaiting approval · {pendingSessionCount} {pendingSessionCount === 1 ? 'session' : 'sessions'}
                                  </span>
                                </div>
                                <div className="pending-approval-actions">
                                  <button
                                    className="approve-all-button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleApproveAllForIssue(issue);
                                    }}
                                    disabled={isApprovingThisIssue || !!approvingIssueKey}
                                    title={`Approve all ${pendingSessionCount} pending ${pendingSessionCount === 1 ? 'session' : 'sessions'} for ${issue.key}`}
                                  >
                                    {isApprovingThisIssue ? (
                                      'Approving…'
                                    ) : (
                                      <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                          <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                        <span>Approve all</span>
                                      </>
                                    )}
                                  </button>
                                  <button
                                    className="reassign-all-button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleReassignAllForIssue(issue);
                                    }}
                                    disabled={isApprovingThisIssue || !!approvingIssueKey}
                                    title={`Move all pending time on ${issue.key} to a different issue`}
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="17 1 21 5 17 9"></polyline>
                                      <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                                      <polyline points="7 23 3 19 7 15"></polyline>
                                      <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                                    </svg>
                                    <span>Reassign all</span>
                                  </button>
                                </div>
                              </div>
                            ) : hasTrackedTime ? (
                              <span className="issue-time-value">{formatTime(trackedSeconds)}</span>
                            ) : (
                              <span className="no-time-indicator">No time logged</span>
                            )}
                          </td>
                        </tr>
                        {issue.sessions?.length > 0 && (
                          <tr className="details-row">
                            <td colSpan="6">
                              <div className="session-details">
                                <h4>Work Sessions ({issue.sessions.length})</h4>
                                <div className="sessions-by-date">
                                  {Object.keys(groupSessionsByDate(issue.sessions))
                                    .sort((a, b) => new Date(b) - new Date(a))
                                    .map((dateKey, dateIdx) => {
                                      const dateSessions = groupSessionsByDate(issue.sessions)[dateKey];
                                      const displayDate = new Date(dateKey + 'T00:00:00');
                                      const totalDuration = calculateTotalDuration(dateSessions);

                                      return (
                                        <div key={dateIdx} className="date-group">
                                          <div className="date-header">
                                            <span className="date-label">
                                              {displayDate.toLocaleDateString('en-US', {
                                                weekday: 'short',
                                                month: 'short',
                                                day: 'numeric',
                                                year: 'numeric'
                                              })}
                                            </span>
                                            <span className="date-total">
                                              Total: {formatTime(totalDuration)}
                                            </span>
                                          </div>
                                          <div className="sessions-list">
                                            {dateSessions.map((session, sessionIdx) => {
                                              const start = parseUTC(session.startTime) || new Date(session.startTime);
                                              const end = parseUTC(session.endTime) || new Date(session.endTime);
                                              // Use actual duration from backend (accumulated work time)
                                              // Not timestamp span which includes idle gaps
                                              const sessionDuration = session.duration || 0;

                                              // Get unique apps from screenshots or activity records
                                              let uniqueApps = [];
                                              if (session.screenshots && session.screenshots.length > 0) {
                                                uniqueApps = [...new Set(session.screenshots.map(s => s.applicationName).filter(Boolean))];
                                              } else if (session.applicationName) {
                                                // For activity-record-based sessions without screenshots
                                                uniqueApps = [session.applicationName];
                                              }
                                              const visibleApps = uniqueApps.slice(0, 3);
                                              const remainingApps = uniqueApps.slice(3);

                                              // DEPRECATED: Simple heuristic for app classification
                                              // TODO: Replace with database lookup from application_classifications table
                                              // These hardcoded lists do not reflect actual classifications used by the tracker
                                              const productiveApps = ['code', 'visual studio', 'vscode', 'intellij', 'webstorm', 'pycharm', 'sublime', 'atom', 'notepad++', 'postman', 'terminal', 'cmd', 'powershell', 'git', 'jira', 'confluence', 'slack', 'teams', 'zoom', 'figma', 'sketch', 'excel', 'word', 'outlook', 'notion', 'trello', 'asana'];
                                              const nonProductiveApps = ['netflix', 'youtube', 'spotify', 'facebook', 'instagram', 'twitter', 'tiktok', 'reddit', 'discord', 'twitch', 'game', 'steam'];

                                              const getAppType = (appName) => {
                                                const lowerApp = appName.toLowerCase();
                                                if (productiveApps.some(p => lowerApp.includes(p))) return 'productive';
                                                if (nonProductiveApps.some(n => lowerApp.includes(n))) return 'non-productive';
                                                return 'neutral';
                                              };

                                              const getAppTypeLabel = (appName) => {
                                                const type = getAppType(appName);
                                                if (type === 'productive') return 'Productive App';
                                                if (type === 'non-productive') return 'Non-Productive App';
                                                return 'Other App';
                                              };

                                              const isPendingReview = session.approvalStatus === 'pending_approval';
                                              const sessionKey = (session.activityRecordIds || []).join(',');
                                              const isApprovingThisSession = approvingSessionId === sessionKey;

                                              return (
                                                <div key={sessionIdx} className={`session-item ${isPendingReview ? 'session-item--pending-review' : ''}`}>
                                                  <span className="session-time">
                                                    {start.toLocaleTimeString('en-US', {
                                                      hour: '2-digit',
                                                      minute: '2-digit',
                                                      hour12: true
                                                    })}
                                                    {' → '}
                                                    {end.toLocaleTimeString('en-US', {
                                                      hour: '2-digit',
                                                      minute: '2-digit',
                                                      hour12: true
                                                    })}
                                                  </span>
                                                  {isPendingReview && (
                                                    <span className="pending-review-chip" title="AI-assigned — won't sync to Jira until you approve">
                                                      Pending review
                                                    </span>
                                                  )}
                                                  {uniqueApps.length > 0 && (
                                                    <div className="session-apps">
                                                      {visibleApps.map((app, appIdx) => (
                                                        <span
                                                          key={appIdx}
                                                          className={`session-app-chip ${getAppType(app)}`}
                                                        >
                                                          {app.length > 12 ? app.substring(0, 10) + '...' : app}
                                                          <span className="chip-tooltip">{app} • {getAppTypeLabel(app)}</span>
                                                        </span>
                                                      ))}
                                                      {remainingApps.length > 0 && (
                                                        <span className="session-apps-more">
                                                          +{remainingApps.length}
                                                          <span className="session-apps-tooltip">
                                                            {remainingApps.map((app, i) => (
                                                              <span key={i}>{app}{i < remainingApps.length - 1 ? ', ' : ''}</span>
                                                            ))}
                                                          </span>
                                                        </span>
                                                      )}
                                                    </div>
                                                  )}
                                                  <div className="session-right">
                                                    <span className="stat-icon">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                    </span>
                                                    <span className="session-duration">
                                                      {formatTime(sessionDuration)}
                                                    </span>
                                                  </div>
                                                  <div className="session-actions">
                                                    {isPendingReview && (
                                                      <>
                                                        <button
                                                          className="approve-button"
                                                          onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleApproveSession(session);
                                                          }}
                                                          disabled={isApprovingThisSession}
                                                          title="Approve — time will sync to Jira on the next hourly sync"
                                                        >
                                                          {isApprovingThisSession ? 'Approving…' : 'Approve'}
                                                        </button>
                                                        <button
                                                          className="reassign-text-button"
                                                          onClick={(e) => {
                                                            e.stopPropagation();
                                                            onOpenReassignModal(session, issue.key);
                                                          }}
                                                          disabled={isApprovingThisSession}
                                                          title="Wrong issue? Move this session's time to a different issue"
                                                        >
                                                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <polyline points="17 1 21 5 17 9"></polyline>
                                                            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                                                            <polyline points="7 23 3 19 7 15"></polyline>
                                                            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                                                          </svg>
                                                          <span>Reassign</span>
                                                        </button>
                                                      </>
                                                    )}
                                                    {!isPendingReview && session.analysisResultIds?.length > 0 && (
                                                      <button
                                                        className="reassign-button"
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          onOpenReassignModal(session, issue.key);
                                                        }}
                                                        title="Reassign this session to a different issue"
                                                      >
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                                        </svg>
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="pagination">
                    <button
                      className="pagination-btn"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      title="Previous page"
                    >
                      ‹
                    </button>

                    <div className="pagination-pages">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => {
                        // Show first page, last page, current page, and pages around current
                        if (
                          page === 1 ||
                          page === totalPages ||
                          (page >= currentPage - 1 && page <= currentPage + 1)
                        ) {
                          return (
                            <button
                              key={page}
                              className={`pagination-page ${page === currentPage ? 'active' : ''}`}
                              onClick={() => handlePageChange(page)}
                            >
                              {page}
                            </button>
                          );
                        } else if (page === currentPage - 2 || page === currentPage + 2) {
                          return <span key={page} className="pagination-ellipsis">...</span>;
                        }
                        return null;
                      })}
                    </div>

                    <button
                      className="pagination-btn"
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      title="Next page"
                    >
                      ›
                    </button>

                    <span className="pagination-info">
                      {startIndex + 1}-{Math.min(endIndex, filteredIssues.length)} of {filteredIssues.length}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="empty-state">
                No issues match {getFilterDescription()}.
                Start working on issues to see them here!
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default DashboardTab;
