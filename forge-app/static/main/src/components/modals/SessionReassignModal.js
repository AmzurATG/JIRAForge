import React, { useMemo, useState } from 'react';
import { formatTime } from '../../utils';

/**
 * Session Reassign Modal Component
 * Modal for reassigning time sessions between issues
 */
function SessionReassignModal({
  isOpen,
  sessionToReassign,
  activeIssues,
  reassigning,
  onClose,
  onReassign
}) {
  const [searchQuery, setSearchQuery] = useState('');

  // Show every active issue except the source — sorted with In Progress first
  // so the most likely targets stay at the top, then To Do, then everything
  // else (Done at the bottom). Searchable so the list is usable even when
  // the user has hundreds of active issues.
  const sortedIssues = useMemo(() => {
    if (!sessionToReassign) return [];
    const statusRank = (status) => {
      const s = (status || '').toLowerCase();
      if (s === 'in progress') return 0;
      if (s === 'to do' || s === 'open' || s === 'backlog') return 1;
      if (s === 'done' || s === 'closed' || s === 'resolved') return 3;
      return 2;
    };
    return activeIssues
      .filter(issue => issue.key !== sessionToReassign.fromIssueKey)
      .slice()
      .sort((a, b) => statusRank(a.status) - statusRank(b.status));
  }, [activeIssues, sessionToReassign]);

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sortedIssues;
    return sortedIssues.filter(issue =>
      issue.key.toLowerCase().includes(q) ||
      (issue.summary || '').toLowerCase().includes(q) ||
      (issue.status || '').toLowerCase().includes(q)
    );
  }, [sortedIssues, searchQuery]);

  if (!isOpen || !sessionToReassign) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content reassign-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reassign Session</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="reassign-info">
            Moving <strong>{formatTime(sessionToReassign.session.duration)}</strong> from{' '}
            <strong>{sessionToReassign.fromIssueKey}</strong>
          </p>
          <p className="reassign-prompt">Select the issue to reassign this time to:</p>
          <input
            type="text"
            className="reassign-search"
            placeholder="Search by key, title, or status…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          <div className="issue-list-modal">
            {filteredIssues.map(issue => (
              <button
                key={issue.key}
                className="issue-option"
                onClick={() => onReassign(issue.key)}
                disabled={reassigning}
              >
                <span className="issue-key">{issue.key}</span>
                <span className="issue-summary">{issue.summary}</span>
                <span className={`status-badge status-${issue.statusCategory}`}>
                  {issue.status}
                </span>
              </button>
            ))}
            {filteredIssues.length === 0 && (
              <p className="empty-state">
                {searchQuery
                  ? `No issues match "${searchQuery}".`
                  : 'No other issues available for reassignment.'}
              </p>
            )}
          </div>
        </div>
        {reassigning && (
          <div className="modal-footer">
            <span className="reassigning-text">Reassigning...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default SessionReassignModal;
