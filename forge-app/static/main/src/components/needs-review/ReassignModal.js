import React, { useState, useMemo, useEffect } from 'react';
import { formatTime } from '../../utils';

function ReassignModal({ target, activeIssues = [], onClose, onSubmit, submitting }) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, submitting]);

  const currentIssueKey = target?.issueKey;

  const filteredIssues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = activeIssues.filter(i => i.key !== currentIssueKey);
    if (!q) return list.slice(0, 50);
    return list.filter(i =>
      i.key.toLowerCase().includes(q) ||
      (i.summary || '').toLowerCase().includes(q)
    ).slice(0, 50);
  }, [activeIssues, query, currentIssueKey]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedKey || submitting) return;
    await onSubmit({
      sessionIds: target.sessionIds,
      newIssueKey: selectedKey,
      reason: reason.trim() || undefined
    });
  };

  const canSubmit = !!selectedKey && !submitting;
  const recordLabel = `${target.recordCount || 0} record${(target.recordCount || 0) === 1 ? '' : 's'}`;

  return (
    <div
      className="needs-review-modal-overlay"
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reassign-modal-title"
    >
      <div
        className="needs-review-modal needs-review-modal--large"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="needs-review-modal-header">
          <h3 id="reassign-modal-title">
            Reassign {recordLabel} ({formatTime(target.totalSeconds || 0)})
          </h3>
          <button
            className="needs-review-modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close reassign dialog"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="needs-review-modal-body">
            {currentIssueKey && currentIssueKey !== 'multiple' && (
              <div className="needs-review-current-issue">
                Currently assigned to: <strong>{currentIssueKey}</strong>
              </div>
            )}
            {currentIssueKey === 'multiple' && (
              <div className="needs-review-current-issue">
                Selection spans multiple issues — reassigning all to a single new issue.
              </div>
            )}

            <div className="needs-review-form-row">
              <label className="needs-review-form-label" htmlFor="reassign-search">
                Reassign to
              </label>
              <input
                id="reassign-search"
                type="text"
                className="needs-review-form-input"
                placeholder="Search by issue key or summary…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                disabled={submitting}
              />
            </div>

            <div className="needs-review-issue-picker" role="radiogroup" aria-label="Select replacement issue">
              {filteredIssues.length === 0 ? (
                <div className="needs-review-issue-picker-empty">
                  {query ? 'No issues match your search.' : 'No assignable issues available.'}
                </div>
              ) : (
                filteredIssues.map(issue => (
                  <label
                    key={issue.key}
                    className={`needs-review-issue-row ${selectedKey === issue.key ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="reassign-target-issue"
                      value={issue.key}
                      checked={selectedKey === issue.key}
                      onChange={() => setSelectedKey(issue.key)}
                      disabled={submitting}
                    />
                    <span className="needs-review-issue-row-key">{issue.key}</span>
                    <span className="needs-review-issue-row-summary">
                      {issue.summary || '(no summary)'}
                    </span>
                  </label>
                ))
              )}
            </div>

            <div className="needs-review-form-row" style={{ marginTop: 14 }}>
              <label className="needs-review-form-label" htmlFor="reassign-reason">
                Optional note <span style={{ color: 'var(--ds-text-subtle)', fontWeight: 400 }}>
                  (visible in audit log)
                </span>
              </label>
              <input
                id="reassign-reason"
                type="text"
                className="needs-review-form-input"
                placeholder="e.g. Actually part of the auth refactor"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="needs-review-modal-footer">
            <button
              type="button"
              className="needs-review-btn needs-review-btn--tertiary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="needs-review-btn needs-review-btn--primary"
              disabled={!canSubmit}
              aria-busy={submitting}
            >
              {submitting ? 'Reassigning…' : `Reassign to ${selectedKey || '…'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ReassignModal;
