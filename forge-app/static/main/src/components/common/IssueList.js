import React, { useState } from 'react';
import './IssueList.css';
import { IssueTypeIcon, StatusDropdown } from './index'; // assuming exported from common
import { navigateToIssue, formatTime } from '../../utils';
import { parseUTC } from '../tabs/time-analytics/dateUtils';
import QualityCell from '../tabs/QualityCell'; // assuming relative path works

// Helper functions (same as in DashboardTab)
function groupSessionsByDate(sessions) {
  if (!sessions) return {};
  return sessions.reduce((acc, session) => {
    // Determine start time to group by
    const startTimeStr = session.startTime || session.start;
    if (!startTimeStr) return acc;
    
    // Convert to local date string (YYYY-MM-DD)
    const dateObj = new Date(startTimeStr);
    const dateKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
    
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(session);
    return acc;
  }, {});
}

function calculateTotalDuration(sessions) {
  return sessions.reduce((total, session) => total + (session.duration || session.durationSeconds || 0), 0);
}

export default function IssueList({
  issues,
  isPendingReviewView,
  approvingIssueKey,
  approvingSessionId,
  handleApproveAllForIssue,
  handleReassignAllForIssue,
  handleApproveSession,
  onOpenReassignModal,
  handleStatusChange,
  statusUpdating,
  loadTransitionsForIssue,
  qualityScores,
  qualitySortOrder,
  handleToggleQualitySort,
  handleRetryQuality,
  // Lazy loading
  hasMore,
  onLoadMore,
  totalItems
}) {

  const sentinelRef = React.useRef(null);

  React.useEffect(() => {
    if (!hasMore || !onLoadMore) return;
    
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        onLoadMore();
      }
    }, { rootMargin: '100px' });
    
    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }
    
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  const handleExpandClick = (e) => {
    const tr = e.target.closest('tr');
    tr.classList.toggle('expanded');
    const expandBtn = tr.querySelector('.expand-button');
    if (tr.classList.contains('expanded')) {
      expandBtn.textContent = '▾';
    } else {
      expandBtn.textContent = '›';
    }
  };

  if (!issues || issues.length === 0) {
    return null;
  }

  return (
    <div className="issues-table-container">
      <table className="issues-table">
        <thead>
          <tr>
            <th style={{ width: '130px' }}>ID</th>
            <th>Title</th>
            <th style={{ width: '130px', textAlign: 'center' }}>Status</th>
            {qualityScores && (
              <th 
                className={`sortable-header ${qualitySortOrder ? 'sorted' : ''}`}
                onClick={handleToggleQualitySort}
                style={{ cursor: 'pointer', textAlign: 'center', width: '150px' }}
                title="Sort by description quality"
              >
                Description Quality {qualitySortOrder === 'asc' ? '▲' : qualitySortOrder === 'desc' ? '▼' : ''}
              </th>
            )}
            <th style={{ width: '100px', textAlign: 'end' }}>
              {isPendingReviewView ? 'Assigned Time' : 'Time Tracked'}
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, idx) => {
            const trackedSeconds = Number(issue.timeTracked) || Number(issue.totalSeconds) || 0;
            const pendingSeconds = Number(issue.pendingApprovalSeconds) || 0;
            
            // Pending session count based on what UI displays
            const pendingSessionCount = (issue.sessions || []).filter(
              (s) => s.approvalStatus === 'pending_approval'
            ).length;
            const hasTrackedTime = trackedSeconds > 0;
            // Only show pending cell if it's pending review view AND we have pending sessions
            // Or if we don't have isPendingReviewView explicitly true, maybe just use standard time tracking
            const showPendingCell = isPendingReviewView && pendingSessionCount > 0;
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
                      href={`/browse/${issue.key || issue.issueKey}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigateToIssue(issue.key || issue.issueKey);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {issue.key || issue.issueKey}
                    </a>
                  </td>
                  <td className="issue-title">{issue.summary}</td>
                  <td className="issue-status">
                    {(issue.key === 'Unassigned' || issue.issueKey === 'Unassigned') ? (
                      <span className="static-status"></span>
                    ) : handleStatusChange ? (
                      <StatusDropdown
                        issue={issue}
                        onStatusChange={handleStatusChange}
                        isUpdating={statusUpdating === (issue.key || issue.issueKey)}
                        onLoadTransitions={loadTransitionsForIssue}
                      />
                    ) : (
                      <span className="static-status">{issue.status?.name || issue.status}</span>
                    )}
                  </td>

                  {qualityScores && (
                    <td className="issue-quality-cell">
                      <QualityCell
                        issueKey={issue.key || issue.issueKey}
                        score={qualityScores[issue.key || issue.issueKey]?.score}
                        status={qualityScores[issue.key || issue.issueKey]?.status}
                        error={qualityScores[issue.key || issue.issueKey]?.error}
                        cachedAt={qualityScores[issue.key || issue.issueKey]?.cachedAt}
                        onRetry={handleRetryQuality}
                      />
                    </td>
                  )}
                  <td className={`issue-time ${showPendingCell ? 'pending-cell' : (hasTrackedTime ? 'has-time' : 'no-time')}`}>
                    {showPendingCell ? (
                      <div className="pending-approval-cell">
                        <div className="pending-approval-top-row">
                          <div className="pending-approval-time">
                            {formatTime(pendingSeconds)}
                          </div>
                          {handleApproveAllForIssue && (
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
                              {handleReassignAllForIssue && (
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
                              )}
                            </div>
                          )}
                        </div>
                        <div className="pending-approval-meta-row">
                          <span className="pending-approval-badge">Pending approval</span>
                          <span className="pending-approval-sessions-count">
                            {pendingSessionCount} {pendingSessionCount === 1 ? 'Session' : 'Sessions'}
                          </span>
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
                    <td colSpan={qualityScores ? "5" : "4"}>
                      <div className="session-details">
                        <h4>
                          Work Sessions ({issue.sessions.length}){' '}
                          <span 
                            className="info-icon-work-sessions" 
                            title="Work sessions are automatically captured and categorized by activity."
                          >
                            ⓘ
                          </span>
                        </h4>
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
                                      Total Time: <span className="issue-time-value">{formatTime(totalDuration)}</span>
                                    </span>
                                  </div>
                                  <div className="sessions-list">
                                    {dateSessions.map((session, sessionIdx) => {
                                      const start = parseUTC(session.startTime) || new Date(session.startTime || session.start);
                                      const end = parseUTC(session.endTime) || new Date(session.endTime || session.end);
                                      const sessionDuration = session.duration || session.durationSeconds || 0;

                                      const isPendingReview = session.approvalStatus === 'pending_approval';
                                      const sessionKey = (session.activityRecordIds || []).join(',');
                                      const isApprovingThisSession = approvingSessionId && approvingSessionId === sessionKey;

                                      return (
                                        <div key={sessionIdx} className={`session-item ${isPendingReview ? 'session-item--pending-review' : ''}`}>
                                          <div className="session-time-col">
                                            <span className="session-time">
                                              {start && !isNaN(start.getTime()) && start.toLocaleTimeString('en-US', {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                hour12: true
                                              })}
                                              {' - '}
                                              {end && !isNaN(end.getTime()) && end.toLocaleTimeString('en-US', {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                hour12: true
                                              })}
                                            </span>
                                          </div>
                                          <div className="session-status-col">
                                            {isPendingReview ? (
                                              <span className="pending-review-chip" title="AI-assigned — won't sync to Jira until you approve">
                                                Pending review
                                              </span>
                                            ) : (
                                              <span className="approved-chip">
                                                Approved
                                              </span>
                                            )}
                                          </div>
                                          {handleApproveSession && isPendingReview && (
                                            <div className="session-actions-col">
                                              <button
                                                className="approve-button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleApproveSession(session);
                                                }}
                                                disabled={isApprovingThisSession}
                                                title="Approve — time will sync to Jira on the next hourly sync"
                                              >
                                                {isApprovingThisSession ? (
                                                  'Approving…'
                                                ) : (
                                                  <>
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                                                      <polyline points="20 6 9 17 4 12"></polyline>
                                                    </svg>
                                                    <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>Approve</span>
                                                  </>
                                                )}
                                              </button>
                                              {onOpenReassignModal && (
                                                <button
                                                  className="reassign-text-button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    onOpenReassignModal(session, issue.key);
                                                  }}
                                                  disabled={isApprovingThisSession}
                                                  title="Wrong issue? Move this session's time to a different issue"
                                                >
                                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                                                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                                                  </svg>
                                                  <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>Reassign</span>
                                                </button>
                                              )}
                                            </div>
                                          )}
                                          {!isPendingReview && (
                                            <div className="session-actions-col"></div>
                                          )}
                                          <div className="session-duration-col">
                                            <span className="session-duration issue-time-value">
                                              {formatTime(sessionDuration)}
                                            </span>
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

      {/* Lazy Loading Sentinel */}
      {hasMore && (
        <div 
          ref={sentinelRef} 
          className="lazy-load-sentinel" 
          style={{ height: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center', margin: '20px 0', color: '#6B778C' }}
        >
          <span className="loading-indicator">Loading more...</span>
        </div>
      )}

      {!hasMore && totalItems > 0 && (
        <div style={{ textAlign: 'center', margin: '20px 0', color: '#6B778C', fontSize: '12px' }}>
          Showing all {totalItems} {totalItems === 1 ? 'issue' : 'issues'}
        </div>
      )}
    </div>
  );
}
