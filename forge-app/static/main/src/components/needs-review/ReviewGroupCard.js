import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime, formatTimeOfDay } from '../../utils';

function ConfidenceDots({ confidence }) {
  if (confidence === null || confidence === undefined) {
    return <span className="review-card-confidence" aria-label="No AI confidence data">—</span>;
  }
  const filled = Math.max(0, Math.min(5, Math.round(confidence * 5)));
  const pct = Math.round(confidence * 100);
  return (
    <span
      className="review-card-confidence"
      title={`Confidence this record belongs to this issue: ${pct}%. Low confidence means the AI was uncertain.`}
    >
      <span className="review-card-confidence-dots" aria-hidden="true">
        {[0, 1, 2, 3, 4].map(i => (
          <span
            key={i}
            className={`review-card-confidence-dot ${i < filled ? 'filled' : ''}`}
          />
        ))}
      </span>
      <span>AI confidence: {pct}%</span>
    </span>
  );
}

function ReviewGroupCard({
  group,
  selected,
  onToggleSelect,
  onApprove,
  onReassign,
  onCreateIssue,
  onApprovePartial,
  mutating
}) {
  const [expanded, setExpanded] = useState(false);
  const [records, setRecords] = useState(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState(new Set());
  const [approving, setApproving] = useState(false);

  const timeRange = `${formatTimeOfDay(group.startTime)} – ${formatTimeOfDay(group.endTime)}`;

  const loadRecords = async () => {
    if (records || loadingRecords) return;
    setLoadingRecords(true);
    try {
      const result = await invoke('getPendingApprovalRecords', {
        sessionIds: group.sessionIds
      });
      if (result?.success) {
        setRecords(result.records || []);
      } else {
        setRecords([]);
      }
    } catch {
      setRecords([]);
    } finally {
      setLoadingRecords(false);
    }
  };

  const toggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !records) await loadRecords();
  };

  const toggleRecordSelect = (recordId) => {
    setSelectedRecordIds(prev => {
      const next = new Set(prev);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  };

  const handlePartialApprove = async () => {
    if (selectedRecordIds.size === 0) return;
    setApproving(true);
    try {
      await onApprovePartial(Array.from(selectedRecordIds));
    } finally {
      setApproving(false);
    }
  };

  const handleApproveClick = async () => {
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  };

  const issueUrl = `/browse/${group.issueKey}`;
  const cardClass = [
    'review-card',
    selected ? 'selected' : '',
    approving ? 'approving' : ''
  ].join(' ').trim();

  const approveLabel = `Approve ${group.recordCount} records on ${group.issueKey} totaling ${formatTime(group.totalSeconds)}`;

  return (
    <div className={cardClass}>
      <div className="review-card-top">
        <input
          type="checkbox"
          className="review-card-check"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${group.issueKey} session`}
          disabled={mutating || approving}
        />
        <div className="review-card-main">
          <div className="review-card-issue">
            <a
              className="review-card-issue-key"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {group.issueKey}
            </a>
            {group.issueSummary && (
              <span className="review-card-issue-summary">"{group.issueSummary}"</span>
            )}
          </div>

          <div className="review-card-meta">
            <span>{timeRange}</span>
            <span className="needs-review-dot">·</span>
            <span><strong>{formatTime(group.totalSeconds)}</strong></span>
            <span className="needs-review-dot">·</span>
            <span>{group.recordCount} record{group.recordCount === 1 ? '' : 's'}</span>
            <span className="needs-review-dot">·</span>
            <ConfidenceDots confidence={group.aiConfidence} />
          </div>

          {group.sampleApps?.length > 0 && (
            <div className="review-card-apps">
              {group.sampleApps.slice(0, 2).map(app => (
                <span key={app} className="review-card-app-chip">{app}</span>
              ))}
            </div>
          )}

          {group.sampleWindowTitles?.length > 0 && (
            <div className="review-card-context">
              {group.sampleWindowTitles.slice(0, 2).map((title, i) => (
                <span key={i} className="review-card-context-line" title={title}>
                  {title}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="review-card-actions">
        <button
          className="needs-review-btn needs-review-btn--approve"
          onClick={handleApproveClick}
          disabled={mutating || approving}
          aria-label={approveLabel}
          aria-busy={approving}
          title="Approve — time will sync to Jira on the next hourly sync."
        >
          {approving ? 'Approving…' : 'Approve'}
        </button>
        <button
          className="needs-review-btn needs-review-btn--secondary"
          onClick={onReassign}
          disabled={mutating || approving}
          title="The AI's issue pick wasn't right — pick a different one."
        >
          Reassign…
        </button>
        <button
          className="needs-review-btn needs-review-btn--secondary"
          onClick={onCreateIssue}
          disabled={mutating || approving}
          title="The right issue doesn't exist yet — create one now."
        >
          Create issue…
        </button>
        <button
          className="review-card-expand-toggle"
          onClick={toggleExpand}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide details ▴' : 'Details ▾'}
        </button>
      </div>

      {expanded && (
        <div className="review-card-details">
          <div className="review-card-details-head">
            <span className="review-card-details-title">
              Individual records ({group.recordCount})
            </span>
            {selectedRecordIds.size > 0 && (
              <span className="review-card-details-title">
                {selectedRecordIds.size} selected
              </span>
            )}
          </div>

          {loadingRecords ? (
            <div className="review-card-records-loading">Loading records…</div>
          ) : records && records.length === 0 ? (
            <div className="review-card-records-loading">No records found.</div>
          ) : (
            <div className="review-card-records">
              {(records || []).map(r => (
                <label key={r.id} className="review-card-record-row">
                  <input
                    type="checkbox"
                    checked={selectedRecordIds.has(r.id)}
                    onChange={() => toggleRecordSelect(r.id)}
                    disabled={mutating || approving}
                  />
                  <span className="review-card-record-time">
                    {formatTimeOfDay(r.start_time)}
                  </span>
                  <span className="review-card-record-title" title={r.window_title || r.application_name}>
                    {r.window_title || r.application_name || '—'}
                  </span>
                  <span className="review-card-record-duration">
                    {formatTime(r.duration_seconds || 0)}
                  </span>
                </label>
              ))}
            </div>
          )}

          {selectedRecordIds.size > 0 && (
            <div className="review-card-partial-bar">
              <button
                className="needs-review-btn needs-review-btn--tertiary"
                onClick={() => setSelectedRecordIds(new Set())}
                disabled={approving}
              >
                Clear
              </button>
              <button
                className="needs-review-btn needs-review-btn--approve"
                onClick={handlePartialApprove}
                disabled={mutating || approving}
              >
                Approve {selectedRecordIds.size} selected record{selectedRecordIds.size === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ReviewGroupCard;
