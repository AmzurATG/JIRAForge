import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@forge/bridge';
import { useApp } from '../../context';
import { IssueTypeIcon, StatusDropdown } from '../common';
import { navigateToIssue, formatTime } from '../../utils';
import { parseUTC } from '../tabs/time-analytics/dateUtils';
import QualityCell from './QualityCell';
import UnassignedWork from '../UnassignedWork';
import { IssueList } from '../common';
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
  const [projectFilter, setProjectFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [approvingSessionId, setApprovingSessionId] = useState(null);
  const [approvingIssueKey, setApprovingIssueKey] = useState(null);
  const itemsPerPage = 10;

  const projectKeys = useMemo(() => {
    const keys = activeIssues.map(issue => issue.projectKey || issue.key.split('-')[0]).filter(Boolean);
    return ['all', ...new Set(keys)];
  }, [activeIssues]);

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


  const getFilterDescription = () => {
    const parts = [];

    if (issueFilter === 'pending-review') {
      parts.push('pending review');
    }
    if (statusFilter !== 'all') {
      parts.push(statusFilter === 'in-progress' ? 'in progress' : 'done');
    }
    if (projectFilter !== 'all') {
      parts.push(`project ${projectFilter}`);
    }

    if (parts.length === 0) {
      return 'your current filters';
    }

    return parts.join(' and ');
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [issueFilter, searchQuery, statusFilter, projectFilter]);


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

    // Filter by project dropdown
    let projectMatch = true;
    if (projectFilter !== 'all') {
      const issueProj = issue.projectKey || issue.key.split('-')[0];
      projectMatch = issueProj.toUpperCase() === projectFilter.toUpperCase();
    }

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

    return tabMatch && statusMatch && projectMatch && searchMatch;
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
              My Work
            </button>
            <button
              className={issueFilter === 'pending-review' ? 'active' : ''}
              onClick={() => setIssueFilter('pending-review')}
              title="AI-assigned time waiting for your approval"
            >
              <strong>Approve</strong> assigned-time
              {pendingReviewCount > 0 && (
                <span className="focus-tab-badge">{pendingReviewCount}</span>
              )}
            </button>
            <button
              className={issueFilter === 'unassigned-time' ? 'active' : ''}
              onClick={() => setIssueFilter('unassigned-time')}
            >
              <strong>Assign</strong> Unassigned-Time
            </button>
          </div>
        </div>

        {issueFilter === 'unassigned-time' ? (
          <UnassignedWork />
        ) : (
          <>
            {issueFilter === 'all' && (
              <div className="focus-controls" style={{ marginBottom: '16px' }}>
                <div className="focus-status-filter" aria-label="Filter issues by project">
                  <label className="focus-status-filter-label" htmlFor="my-focus-project-filter">Project:</label>
                  <select
                    id="my-focus-project-filter"
                    className="focus-status-filter-select"
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                  >
                    {projectKeys.map(key => (
                      <option key={key} value={key}>
                        {key === 'all' ? 'All' : key}
                      </option>
                    ))}
                  </select>
                </div>
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
                </div>
              </div>
            )}

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
              <IssueList
                issues={paginatedIssues}
                isPendingReviewView={isPendingReviewView}
                approvingIssueKey={approvingIssueKey}
                approvingSessionId={approvingSessionId}
                handleApproveAllForIssue={handleApproveAllForIssue}
                handleReassignAllForIssue={handleReassignAllForIssue}
                handleApproveSession={handleApproveSession}
                onOpenReassignModal={onOpenReassignModal}
                handleStatusChange={handleStatusChange}
                statusUpdating={statusUpdating}
                loadTransitionsForIssue={loadTransitionsForIssue}
                qualityScores={qualityScores}
                qualitySortOrder={qualitySortOrder}
                handleToggleQualitySort={handleToggleQualitySort}
                handleRetryQuality={handleRetryQuality}
                currentPage={currentPage}
                handlePageChange={handlePageChange}
                totalPages={totalPages}
                startIndex={startIndex}
                endIndex={endIndex}
                totalItems={filteredIssues.length}
              />
            ) : (
              <p className="empty-state">
                No issues match {getFilterDescription()}.
                Start working on issues to see them here!
              </p>
            )}
          </>
        )}
      </>
    )
  }
      </div>
    </div>
  );
}

export default DashboardTab;
