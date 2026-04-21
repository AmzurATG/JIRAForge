import React from 'react';

function EmptyState() {
  return (
    <div className="needs-review-empty" role="status">
      <div className="needs-review-empty-emoji" aria-hidden="true">🎉</div>
      <h3 className="needs-review-empty-title">All caught up!</h3>
      <p className="needs-review-empty-text">
        When the AI assigns time to issues, you'll review it here before it syncs to Jira.
        Nothing to review right now.
      </p>
    </div>
  );
}

export default EmptyState;
