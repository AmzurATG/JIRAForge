import React, { useState } from 'react';
import { formatTime } from '../../utils';
import { parseUTC } from '../tabs/time-analytics/dateUtils';
import './GroupAccordion.css';

function GroupAccordion({
  groups,
  hasMoreGroups,
  totalGroups,
  loadingMore,
  onLoadMore,
  onAssignClick,
  onDismissGroup,
  onDismissMember,
  // Hoisted cache + loaders (owned by UnassignedWork)
  groupDetails,
  loadingDetails,
  groupWorkSessions,
  loadingWorkSessions,
  loadGroupDetails,
  loadGroupWorkSessions,
  // Date filter active flag (controls which stats to display)
  hasDateFilter,
  // Selection (multi-select bulk assign)
  isGroupFullySelected,
  isGroupPartiallySelected,
  isIntervalSelected,
  onToggleGroupSelection,
  onToggleIntervalSelection,
  pendingFullSelectGroupIds,
  hasAnySelection
}) {
  // Local UI state (not shared with parent)
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  // Dismiss states
  const [confirmingDismiss, setConfirmingDismiss] = useState({}); // { groupId: true }
  const [dismissingGroup, setDismissingGroup] = useState({});     // { groupId: true }
  const [dismissingMember, setDismissingMember] = useState({});   // { key: true }

  const formatTimeOfDay = (dateString) => {
    const date = parseUTC(dateString);
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatDate = (dateString) => {
    // Date group labels are YYYY-MM-DD strings representing local calendar dates
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const getSessionDuration = (session) => {
    // Use actual tracked duration from backend (sum of screenshot durations)
    // Fall back to calculated time span for backwards compatibility
    if (session.durationSeconds !== undefined && session.durationSeconds !== null) {
      return session.durationSeconds;
    }
    // Fallback: calculate from time span (less accurate for merged sessions)
    const start = parseUTC(session.startTime);
    const end = parseUTC(session.endTime);
    if (!start || !end) return 0;
    return Math.round((end - start) / 1000);
  };

  const handleDismissGroupClick = (groupId, e) => {
    e.stopPropagation();
    setConfirmingDismiss(prev => ({ ...prev, [groupId]: true }));
  };

  const handleConfirmDismiss = async (groupId, e) => {
    e.stopPropagation();
    setConfirmingDismiss(prev => ({ ...prev, [groupId]: false }));
    setDismissingGroup(prev => ({ ...prev, [groupId]: true }));
    try {
      await onDismissGroup(groupId);
    } finally {
      setDismissingGroup(prev => ({ ...prev, [groupId]: false }));
    }
  };

  const handleCancelDismiss = (groupId, e) => {
    e.stopPropagation();
    setConfirmingDismiss(prev => ({ ...prev, [groupId]: false }));
  };

  const handleDismissMemberClick = async (groupId, session, e) => {
    e.stopPropagation();
    const key = `${groupId}-${(session.activityIds || []).join('-')}`;
    setDismissingMember(prev => ({ ...prev, [key]: true }));
    try {
      // Parent owns cache + selection reconciliation (see removeSessionFromGroupCache).
      await onDismissMember(groupId, session);
    } finally {
      setDismissingMember(prev => ({ ...prev, [key]: false }));
    }
  };

  const toggleGroup = async (groupId) => {
    const newExpanded = new Set(expandedGroups);

    if (newExpanded.has(groupId)) {
      newExpanded.delete(groupId);
      setExpandedGroups(newExpanded);
      return;
    }

    newExpanded.add(groupId);
    setExpandedGroups(newExpanded);

    // Lazy-load via parent helpers (cache-aware)
    const details = groupDetails[groupId] || await loadGroupDetails(groupId);
    if (details?.session_ids?.length > 0 && !groupWorkSessions[groupId]) {
      await loadGroupWorkSessions(groupId, details.session_ids);
    }
  };

  const handleAssignClick = async (group, e) => {
    e.stopPropagation();

    const details = groupDetails[group.id] || await loadGroupDetails(group.id);
    if (!details) {
      alert('Failed to load group details. Please try again.');
      return;
    }

    // Merge group summary with detailed data for assignment
    const groupWithDetails = {
      ...group,
      session_ids: details.session_ids,
      session_count: details.session_count,
      total_seconds: details.total_seconds,
      total_time_formatted: details.total_time_formatted
    };

    onAssignClick(groupWithDetails);
  };

  return (
    <>
      <div
        className={`groups-accordion${hasAnySelection ? ' groups-accordion--has-selection' : ''}`}
      >
        {groups.map((group, index) => {
          const isExpanded = expandedGroups.has(group.id);
          const dateGroups = groupWorkSessions[group.id] || [];
          const isLoadingWorkSessionsForGroup = loadingWorkSessions[group.id];
          const isLoadingGroupDetails = loadingDetails[group.id];
          const details = groupDetails[group.id];
          const groupFullySelected = isGroupFullySelected ? isGroupFullySelected(group.id) : false;
          const groupPartiallySelected = isGroupPartiallySelected ? isGroupPartiallySelected(group.id) : false;
          const isPendingSelect = pendingFullSelectGroupIds?.has(group.id) || false;
          const groupSelectedClass = groupFullySelected || groupPartiallySelected ? ' accordion-item--selected' : '';

          return (
            <div key={group.id || index} className={`accordion-item confidence-${group.confidence}${groupSelectedClass}`}>
              <div
                className="accordion-header"
                onClick={() => toggleGroup(group.id)}
              >
                <div className="accordion-header-left">
                  <label
                    className="group-checkbox-wrapper"
                    onClick={(e) => e.stopPropagation()}
                    title={groupFullySelected ? 'Unselect group' : 'Select group'}
                  >
                    <input
                      type="checkbox"
                      className="group-checkbox"
                      checked={groupFullySelected}
                      ref={(el) => { if (el) el.indeterminate = groupPartiallySelected && !groupFullySelected; }}
                      onChange={() => onToggleGroupSelection && onToggleGroupSelection(group)}
                      disabled={isPendingSelect}
                    />
                    {isPendingSelect && <span className="checkbox-spinner" aria-hidden="true" />}
                  </label>
                  <span className={`accordion-toggle ${isExpanded ? 'expanded' : ''}`}>
                    ›
                  </span>
                  <div className="group-title-section">
                    <h3 className="group-label">{group.label || 'Untitled Group'}</h3>
                    {!isExpanded && group.description && (
                      <p className="group-description-preview">{group.description}</p>
                    )}
                  </div>
                </div>
                <div className="accordion-header-right">
                  <div className="stat-compact">
                    <span className="stat-icon">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                        <line x1="8" y1="21" x2="16" y2="21"></line>
                        <line x1="12" y1="17" x2="12" y2="21"></line>
                      </svg>
                    </span>
                    <span className="stat-value">
                      {hasDateFilter && group.filtered_session_count !== null
                        ? group.filtered_session_count
                        : (details?.session_count || group.session_count)}
                    </span>
                  </div>
                  <div className="stat-compact">
                    <span className="stat-icon">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                    </span>
                    <span className="stat-value">
                      {hasDateFilter && group.filtered_total_seconds !== null
                        ? group.filtered_time_formatted
                        : (details?.total_seconds ? details.total_time_formatted : group.total_time_formatted)}
                    </span>
                  </div>
                  <button
                    className="assign-button-compact"
                    onClick={(e) => handleAssignClick(group, e)}
                  >
                    Assign
                  </button>
                  {confirmingDismiss[group.id] ? (
                    <div className="dismiss-confirm" onClick={e => e.stopPropagation()}>
                      <span>Delete?</span>
                      <button
                        className="dismiss-confirm-yes"
                        onClick={(e) => handleConfirmDismiss(group.id, e)}
                        disabled={dismissingGroup[group.id]}
                      >
                        Yes
                      </button>
                      <button
                        className="dismiss-confirm-no"
                        onClick={(e) => handleCancelDismiss(group.id, e)}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      className="dismiss-button-compact"
                      onClick={(e) => handleDismissGroupClick(group.id, e)}
                      disabled={dismissingGroup[group.id]}
                      title="Delete this group"
                    >
                      {dismissingGroup[group.id] ? '…' : '×'}
                    </button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="accordion-content">
                  <p className="group-description">{group.description}</p>

                  {group.recommendation && (
                    <div className={`group-recommendation recommendation-${group.recommendation.action}`}>
                      <span className={`confidence-badge confidence-${group.confidence}`}>
                        {group.confidence}
                      </span>
                      <div className="recommendation-content">
                        <strong>AI Recommendation:</strong> {group.recommendation.reason}
                        {group.recommendation.suggested_issue_key && (
                          <div className="suggested-issue">
                            Suggested Issue: <strong>{group.recommendation.suggested_issue_key}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Loading state for group details */}
                  {isLoadingGroupDetails && (
                    <div className="loading-details">
                      <span className="spinner"></span>
                      Loading group details...
                    </div>
                  )}

                  {/* Show details when loaded */}
                  {!isLoadingGroupDetails && details && (
                    <div className="work-sessions-section">
                      {isLoadingWorkSessionsForGroup && (
                        <div className="loading-sessions">Loading work sessions...</div>
                      )}

                      {!isLoadingWorkSessionsForGroup && dateGroups.length === 0 && (
                        <div className="no-sessions">No work sessions available</div>
                      )}

                      {!isLoadingWorkSessionsForGroup && dateGroups.length > 0 && (
                        <div className="sessions-by-date">
                          {dateGroups.map((dateGroup, dateIdx) => (
                            <div key={dateIdx} className="date-group">
                              <div className="date-header">
                                <span className="date-label">
                                  {formatDate(dateGroup.date)}
                                </span>
                                <span className="date-total">
                                  Total: {formatTime(dateGroup.totalSeconds)}
                                </span>
                              </div>
                              <div className="sessions-list">
                                {dateGroup.sessions.map((session, sessionIdx) => {
                                  const sessionDuration = getSessionDuration(session);
                                  const memberKey = `${group.id}-${(session.activityIds || []).join('-')}`;
                                  const isDismissingThis = dismissingMember[memberKey];
                                  const intervalSelected = isIntervalSelected ? isIntervalSelected(group.id, session) : false;
                                  return (
                                    <div key={sessionIdx} className={`session-item${isDismissingThis ? ' session-item-dismissing' : ''}${intervalSelected ? ' session-item--selected' : ''}`}>
                                      <label
                                        className="interval-checkbox-wrapper"
                                        onClick={(e) => e.stopPropagation()}
                                        title={intervalSelected ? 'Unselect interval' : 'Select interval'}
                                      >
                                        <input
                                          type="checkbox"
                                          className="interval-checkbox"
                                          checked={intervalSelected}
                                          onChange={() => onToggleIntervalSelection && onToggleIntervalSelection(group, session)}
                                        />
                                      </label>
                                      <span className="session-time">
                                        {formatTimeOfDay(session.startTime)}
                                        {' → '}
                                        {formatTimeOfDay(session.endTime)}
                                      </span>
                                      <span className="session-duration-icon">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <circle cx="12" cy="12" r="10"></circle>
                                          <polyline points="12 6 12 12 16 14"></polyline>
                                        </svg>
                                      </span>
                                      <span className="session-duration">
                                        {formatTime(sessionDuration)}
                                      </span>
                                      <button
                                        className="session-dismiss-btn"
                                        onClick={(e) => handleDismissMemberClick(group.id, session, e)}
                                        disabled={isDismissingThis}
                                        title="Remove from cluster"
                                      >
                                        {isDismissingThis ? (
                                          <span style={{ fontSize: '11px' }}>…</span>
                                        ) : (
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action buttons — always visible once group is expanded.
                      handleAssignClick loads group details on-demand if not yet cached,
                      so these buttons work correctly even when details haven't loaded yet. */}
                  {!isLoadingGroupDetails && (
                    <div className="accordion-actions">
                      <button
                        className="assign-button-full"
                        onClick={(e) => handleAssignClick(group, e)}
                      >
                        Assign This Group
                      </button>
                      <button
                        className="dismiss-button-full"
                        onClick={(e) => handleConfirmDismiss(group.id, e)}
                        disabled={dismissingGroup[group.id]}
                      >
                        {dismissingGroup[group.id] ? 'Deleting…' : 'Delete Group'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Load More Button for Pagination */}
      {hasMoreGroups && (
        <div className="load-more-container">
          <button
            className="load-more-btn"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <span className="spinner"></span>
                Loading...
              </>
            ) : (
              <>
                Load More Groups ({groups.length} of {totalGroups})
              </>
            )}
          </button>
        </div>
      )}
    </>
  );
}

export default GroupAccordion;
