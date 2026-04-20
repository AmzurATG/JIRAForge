import React from 'react';
import { formatTime } from '../../utils';
import './SelectionBar.css';

function SelectionBar({ groupCount, sessionCount, totalSeconds, onClear, onAssign }) {
  if (groupCount === 0 && sessionCount === 0) return null;

  const groupLabel = groupCount === 1 ? 'group' : 'groups';
  const sessionLabel = sessionCount === 1 ? 'session' : 'sessions';

  return (
    <div className="selection-bar" role="region" aria-label="Bulk selection actions">
      <div className="selection-bar-summary">
        <strong>{groupCount}</strong> {groupLabel}
        <span className="selection-bar-divider">·</span>
        <strong>{sessionCount}</strong> {sessionLabel}
        <span className="selection-bar-divider">·</span>
        <strong>{formatTime(totalSeconds)}</strong> selected
      </div>
      <div className="selection-bar-actions">
        <button className="selection-bar-clear" onClick={onClear}>
          Clear
        </button>
        <button className="selection-bar-assign" onClick={onAssign}>
          Assign Selected
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12"></line>
            <polyline points="12 5 19 12 12 19"></polyline>
          </svg>
        </button>
      </div>
    </div>
  );
}

export default SelectionBar;
