import React, { useState } from 'react';
import { formatTime } from '../../utils';

/**
 * Worklog Reassign Modal
 * Modal for moving a synced Jira worklog from one issue to another.
 * Unlike SessionReassignModal (which only moves activity records),
 * this handles the full Jira worklog lifecycle (delete + create).
 */
function WorklogReassignModal({
  isOpen,
  worklogToReassign,   // { fromIssueKey, timeSpentSeconds, startedAt, issueSummary }
  activeIssues,         // Array of { key, summary, status, statusCategory }
  reassigning,          // boolean - in-progress state
  onClose,
  onReassign            // (toIssueKey) => void
}) {
  const [searchTerm, setSearchTerm] = useState('');

  if (!isOpen || !worklogToReassign) return null;

  const { fromIssueKey, timeSpentSeconds } = worklogToReassign;

  // Filter issues: exclude current issue, optionally filter by search
  const filteredIssues = activeIssues
    .filter(issue => issue.key !== fromIssueKey)
    .filter(issue => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return (
        issue.key.toLowerCase().includes(term) ||
        (issue.summary || '').toLowerCase().includes(term)
      );
    });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content reassign-worklog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reassign Worklog</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="reassign-info">
            Moving <strong>{formatTime(timeSpentSeconds)}</strong> from{' '}
            <strong>{fromIssueKey}</strong>
          </p>
          <p className="reassign-warning">
            ⚠ This will delete the worklog on {fromIssueKey} and create a new one on the selected issue.
          </p>

          <div className="reassign-search">
            <input
              type="text"
              className="search-input"
              placeholder="Search issues..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
              aria-label="Search issues"
            />
          </div>

          <div className="issue-list-modal" role="listbox" aria-label="Available issues">
            {filteredIssues.map(issue => (
              <button
                key={issue.key}
                className="issue-option"
                onClick={() => onReassign(issue.key)}
                disabled={reassigning}
                role="option"
                aria-selected={false}
              >
                <span className="issue-key">{issue.key}</span>
                <span className="issue-summary">{issue.summary}</span>
                <span className={`status-badge status-${issue.statusCategory}`}>
                  {issue.status}
                </span>
              </button>
            ))}
            {filteredIssues.length === 0 && !searchTerm && (
              <p className="empty-state">No other issues available for reassignment.</p>
            )}
            {filteredIssues.length === 0 && searchTerm && (
              <p className="empty-state">No issues match &ldquo;{searchTerm}&rdquo;</p>
            )}
          </div>
        </div>
        {reassigning && (
          <div className="modal-footer">
            <span className="reassigning-text">Reassigning worklog...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorklogReassignModal;
