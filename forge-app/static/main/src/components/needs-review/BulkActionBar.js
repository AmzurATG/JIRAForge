import React from 'react';
import { formatTime } from '../../utils';

function BulkActionBar({
  count,
  totalSeconds,
  onApprove,
  onReassign,
  onCreateIssue,
  onClear,
  disabled
}) {
  if (!count) return null;

  return (
    <div
      className="needs-review-bulk-bar"
      role="region"
      aria-label="Bulk actions for selected sessions"
    >
      <div className="needs-review-bulk-bar-info">
        <strong>{count}</strong> selected
        <span className="needs-review-dot"> · </span>
        <strong>{formatTime(totalSeconds)}</strong> total
      </div>
      <div className="needs-review-bulk-bar-actions">
        <button
          type="button"
          className="needs-review-btn needs-review-btn--approve"
          onClick={onApprove}
          disabled={disabled}
        >
          Approve selected
        </button>
        <button
          type="button"
          className="needs-review-btn needs-review-btn--secondary"
          onClick={onReassign}
          disabled={disabled}
        >
          Reassign…
        </button>
        <button
          type="button"
          className="needs-review-btn needs-review-btn--secondary"
          onClick={onCreateIssue}
          disabled={disabled}
        >
          Create issue…
        </button>
        <button
          type="button"
          className="needs-review-btn needs-review-btn--tertiary"
          onClick={onClear}
          disabled={disabled}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

export default BulkActionBar;
