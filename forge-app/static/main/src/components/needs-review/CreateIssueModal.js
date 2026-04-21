import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../utils';

const ISSUE_TYPES = ['Task', 'Story', 'Bug'];

function buildDefaultDescription(target) {
  const count = target.recordCount || 0;
  const duration = formatTime(target.totalSeconds || 0);
  const date = target.workDate || '';
  return `Work performed across ${count} record${count === 1 ? '' : 's'}${date ? ` from ${date}` : ''}, totaling ${duration}. Imported from time tracking.`;
}

function CreateIssueModal({ target, onClose, onSubmit, submitting }) {
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState(buildDefaultDescription(target));
  const [statuses, setStatuses] = useState([]);
  const [statusName, setStatusName] = useState('');
  const [assignToSelf, setAssignToSelf] = useState(true);
  const [summaryError, setSummaryError] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoadingProjects(true);
      try {
        const result = await invoke('getUserProjects');
        if (!mounted) return;
        if (result?.success) {
          const list = result.projects || [];
          setProjects(list);
          if (list.length > 0 && !projectKey) {
            setProjectKey(list[0].key);
          }
        }
      } finally {
        if (mounted) setLoadingProjects(false);
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectKey) return;
    let mounted = true;
    (async () => {
      try {
        const result = await invoke('getProjectStatuses', { projectKey });
        if (!mounted) return;
        if (result?.success) {
          const list = result.statuses || [];
          setStatuses(list);
          const toDo = list.find(s => s.name === 'To Do');
          setStatusName(toDo ? 'To Do' : (list[0]?.name || ''));
        }
      } catch {
        setStatuses([]);
      }
    })();
    return () => { mounted = false; };
  }, [projectKey]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, submitting]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setSummaryError('Summary is required');
      return;
    }
    if (trimmedSummary.length > 255) {
      setSummaryError('Summary must be 255 characters or fewer');
      return;
    }
    if (!projectKey) return;

    setSummaryError(null);
    await onSubmit({
      sessionIds: target.sessionIds,
      issueSummary: trimmedSummary,
      issueDescription: description.trim(),
      projectKey,
      issueType,
      assignToSelf,
      statusName: statusName || undefined
    });
  };

  const recordLabel = `${target.recordCount || 0} record${(target.recordCount || 0) === 1 ? '' : 's'}`;
  const canSubmit = !submitting && summary.trim().length > 0 && !!projectKey;

  return (
    <div
      className="needs-review-modal-overlay"
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-issue-modal-title"
    >
      <div
        className="needs-review-modal needs-review-modal--large"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="needs-review-modal-header">
          <h3 id="create-issue-modal-title">
            Create issue for {recordLabel} ({formatTime(target.totalSeconds || 0)})
          </h3>
          <button
            className="needs-review-modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close create-issue dialog"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="needs-review-modal-body">
            <div className="needs-review-form-row-split">
              <div className="needs-review-form-row">
                <label className="needs-review-form-label" htmlFor="create-project">
                  Project
                </label>
                <select
                  id="create-project"
                  className="needs-review-form-select"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value)}
                  disabled={submitting || loadingProjects}
                >
                  {loadingProjects && <option>Loading…</option>}
                  {!loadingProjects && projects.length === 0 && (
                    <option value="">No projects</option>
                  )}
                  {projects.map(p => (
                    <option key={p.key} value={p.key}>
                      {p.key} — {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="needs-review-form-row">
                <label className="needs-review-form-label" htmlFor="create-issuetype">
                  Issue type
                </label>
                <select
                  id="create-issuetype"
                  className="needs-review-form-select"
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value)}
                  disabled={submitting}
                >
                  {ISSUE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div className="needs-review-form-row">
              <label className="needs-review-form-label" htmlFor="create-summary">
                Summary <span style={{ color: '#de350b' }}>*</span>
              </label>
              <input
                id="create-summary"
                type="text"
                className="needs-review-form-input"
                value={summary}
                onChange={(e) => { setSummary(e.target.value); if (summaryError) setSummaryError(null); }}
                maxLength={255}
                autoFocus
                disabled={submitting}
                aria-invalid={!!summaryError}
                aria-describedby={summaryError ? 'create-summary-error' : undefined}
              />
              {summaryError && (
                <span id="create-summary-error" className="needs-review-form-hint" style={{ color: '#de350b' }}>
                  {summaryError}
                </span>
              )}
            </div>

            <div className="needs-review-form-row">
              <label className="needs-review-form-label" htmlFor="create-description">
                Description
              </label>
              <textarea
                id="create-description"
                className="needs-review-form-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="needs-review-form-row-split">
              <div className="needs-review-form-row">
                <label className="needs-review-form-label" htmlFor="create-status">
                  Initial status
                </label>
                <select
                  id="create-status"
                  className="needs-review-form-select"
                  value={statusName}
                  onChange={(e) => setStatusName(e.target.value)}
                  disabled={submitting || statuses.length === 0}
                >
                  {statuses.length === 0 && <option value="">Default</option>}
                  {statuses.map(s => (
                    <option key={s.id || s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div className="needs-review-form-row" style={{ justifyContent: 'flex-end' }}>
                <label
                  className="needs-review-form-label"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}
                >
                  <input
                    type="checkbox"
                    checked={assignToSelf}
                    onChange={(e) => setAssignToSelf(e.target.checked)}
                    disabled={submitting}
                    style={{ accentColor: '#6656fc' }}
                  />
                  <span>Assign to me</span>
                </label>
              </div>
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
              {submitting ? 'Creating…' : 'Create and approve'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CreateIssueModal;
