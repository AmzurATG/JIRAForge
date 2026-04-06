import React, { useState } from 'react';
import { formatTime } from '../../utils';

/**
 * Worklog Split/Reassign Modal
 * Modal for splitting a synced Jira worklog between two issues.
 * Supports partial splits (move X minutes) and full reassignment (move all).
 * Uses PUT on source worklog + POST on target for partial splits,
 * or DELETE + POST for full moves.
 */
function WorklogReassignModal({
  isOpen,
  worklogToReassign,   // { fromIssueKey, timeSpentSeconds, startedAt, issueSummary }
  activeIssues,         // Array of { key, summary, status, statusCategory }
  reassigning,          // boolean - in-progress state
  onClose,
  onReassign            // (toIssueKey, splitSeconds) => void
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [splitMinutes, setSplitMinutes] = useState(null); // null = not yet initialized

  if (!isOpen || !worklogToReassign) return null;

  const { fromIssueKey, timeSpentSeconds } = worklogToReassign;
  const displayIssueKey = fromIssueKey || 'Unassigned';
  const isUnassigned = !fromIssueKey;
  const totalMinutes = Math.floor(timeSpentSeconds / 60);
  // Jira requires minimum 60s — both split and remainder must be ≥ 1 min
  const maxSplitMinutes = totalMinutes;
  const minSplitMinutes = 1;

  // Initialize splitMinutes on first render for this worklog
  const currentSplitMinutes = splitMinutes !== null ? splitMinutes : totalMinutes;
  const splitSeconds = currentSplitMinutes * 60;
  const remainingMinutes = totalMinutes - currentSplitMinutes;
  const isFullMove = currentSplitMinutes >= totalMinutes;
  // Auto-force full move when remainder would be < 1 min (Jira minimum)
  const effectiveIsFullMove = isFullMove || remainingMinutes < 1;

  const handleSliderChange = (e) => {
    let val = parseInt(e.target.value, 10);
    // If remainder < 1 minute, snap to full move
    if (totalMinutes - val < 1 && val < totalMinutes) {
      val = totalMinutes;
    }
    setSplitMinutes(val);
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    if (val === '') {
      setSplitMinutes(minSplitMinutes);
      return;
    }
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    num = Math.max(minSplitMinutes, Math.min(maxSplitMinutes, num));
    // If remainder < 1 minute, snap to full move
    if (totalMinutes - num < 1 && num < totalMinutes) {
      num = totalMinutes;
    }
    setSplitMinutes(num);
  };

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
          <h3>Split Worklog</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="reassign-info">
            <strong>{displayIssueKey}</strong> — Total: <strong>{formatTime(timeSpentSeconds)}</strong>
          </p>

          {/* Time split controls — only show if there's more than 1 minute and not unassigned */}
          {totalMinutes > 1 && !isUnassigned && (
            <div className="split-time-section">
              <label className="split-label">Time to move:</label>
              <div className="split-slider-row">
                <input
                  type="range"
                  className="split-slider"
                  min={minSplitMinutes}
                  max={maxSplitMinutes}
                  value={currentSplitMinutes}
                  onChange={handleSliderChange}
                  aria-label="Minutes to split"
                />
                <input
                  type="number"
                  className="split-minutes-input"
                  min={minSplitMinutes}
                  max={maxSplitMinutes}
                  value={currentSplitMinutes}
                  onChange={handleInputChange}
                  aria-label="Minutes to move"
                />
                <span className="split-unit">min</span>
              </div>
              <p className="split-summary">
                {effectiveIsFullMove ? (
                  <>
                    ⚠ Moving all <strong>{formatTime(timeSpentSeconds)}</strong> to the selected issue.
                    {fromIssueKey && <>Worklog on {fromIssueKey} will be deleted.</>}
                  </>
                ) : (
                  <>
                    <strong>{currentSplitMinutes}m</strong> → selected issue &nbsp;|&nbsp;
                    <strong>{remainingMinutes}m</strong> remains on {fromIssueKey}
                  </>
                )}
              </p>
            </div>
          )}

          {/* If only 1 minute total or unassigned, show simple warning */}
          {(totalMinutes <= 1 || isUnassigned) && (
            <p className="reassign-warning">
              ⚠ This will {isUnassigned ? 'assign' : 'move'} the entire worklog ({formatTime(timeSpentSeconds)}) to the selected issue.
            </p>
          )}

          <div className="reassign-search">
            <input
              type="text"
              className="search-input"
              placeholder="Search issues..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="Search issues"
            />
          </div>

          <div className="issue-list-modal" role="listbox" aria-label="Available issues">
            {filteredIssues.map(issue => (
              <button
                key={issue.key}
                className="issue-option"
                onClick={() => onReassign(issue.key, effectiveIsFullMove ? timeSpentSeconds : splitSeconds)}
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
            <span className="reassigning-text">Splitting worklog...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorklogReassignModal;
