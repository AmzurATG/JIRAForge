import React, { useCallback, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import './DescriptionQuality.css';

/**
 * Description Quality panel — AI-assisted Jira ticket description enhancement.
 *
 * Lives inside the issue panel beneath the time-approval banner. Lets the
 * user score the current ticket, see issues + suggestions, and (optionally)
 * generate an improved version that can be accepted, edited, or rejected.
 *
 * State machine:
 *   idle → loading → scored
 *                 → error
 *   scored + click "Improve" → loadingLLM → comparison
 *   comparison + Accept     → writing → success
 *   comparison + Edit       → editing → writing → success
 *   comparison + Reject     → scored (with rejected event sent)
 */

const STAGE = {
  IDLE: 'idle',
  LOADING: 'loading',
  SCORED: 'scored',
  LOADING_LLM: 'loadingLLM',
  COMPARISON: 'comparison',
  EDITING: 'editing',
  WRITING: 'writing',
  SUCCESS: 'success',
  ERROR: 'error'
};

function scoreColor(score) {
  if (score == null) return 'dq-score--unknown';
  if (score >= 80) return 'dq-score--green';
  if (score >= 50) return 'dq-score--yellow';
  return 'dq-score--red';
}

function scoreLabel(score) {
  if (score == null) return 'No score';
  if (score >= 80) return 'Good';
  if (score >= 50) return 'Needs work';
  return 'Poor';
}

function ScoreBadge({ score }) {
  return (
    <div className={`dq-score-badge ${scoreColor(score)}`} aria-label={`Quality score ${score} of 100`}>
      <div className="dq-score-value">{score == null ? '–' : score}</div>
      <div className="dq-score-label">{scoreLabel(score)}</div>
    </div>
  );
}

function BulletedList({ items, className }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <ul className={className}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function recordEvent(issueKey, eventType, scoreBefore, scoreAfter, source) {
  // Fire-and-forget; analytics failures should not affect the UI.
  invoke('recordDescriptionEvent', { issueKey, eventType, scoreBefore, scoreAfter, source }).catch(() => {});
}

export default function DescriptionQuality({ issueKey }) {
  const [stage, setStage] = useState(STAGE.IDLE);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedDescription, setEditedDescription] = useState('');
  const [syncingRecentWork, setSyncingRecentWork] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);

  const runAnalysis = useCallback(async (requestImprovement) => {
    setError(null);
    setStage(requestImprovement ? STAGE.LOADING_LLM : STAGE.LOADING);
    try {
      const res = await invoke('analyzeDescription', { issueKey, requestImprovement });
      if (!res?.success) {
        setError(res?.error || 'Analysis failed');
        setStage(STAGE.ERROR);
        return;
      }
      setAnalysis(res);
      setEditedTitle(res.improved_title || '');
      setEditedDescription(res.improved_description || '');
      if (requestImprovement && res.improved_description) {
        setStage(STAGE.COMPARISON);
      } else {
        setStage(STAGE.SCORED);
      }
    } catch (err) {
      setError(err?.message || 'Analysis failed');
      setStage(STAGE.ERROR);
    }
  }, [issueKey]);

  const handleAccept = async ({ updateTitle, updateDescription }) => {
    if (!analysis) return;
    setStage(STAGE.WRITING);
    try {
      const res = await invoke('updateDescription', {
        issueKey,
        improvedTitle: editedTitle,
        improvedDescription: editedDescription,
        updateTitle,
        updateDescription
      });
      if (!res?.success) {
        setError(res?.error || 'Update failed');
        setStage(STAGE.ERROR);
        return;
      }
      recordEvent(
        issueKey,
        stage === STAGE.EDITING ? 'edit' : 'accept',
        analysis.score,
        analysis.score, // server-side improved score; refresh on next run
        analysis.source
      );
      setStage(STAGE.SUCCESS);
    } catch (err) {
      setError(err?.message || 'Update failed');
      setStage(STAGE.ERROR);
    }
  };

  const handleReject = () => {
    if (analysis) {
      recordEvent(issueKey, 'reject', analysis.score, analysis.score, analysis.source);
    }
    setStage(STAGE.SCORED);
  };

  const handleReset = () => {
    setStage(STAGE.IDLE);
    setAnalysis(null);
    setError(null);
    setEditedTitle('');
    setEditedDescription('');
    setSyncingRecentWork(false);
    setSyncMessage(null);
  };

  const handleDone = () => {
    router.reload();
  };

  const handleSyncRecentWork = async () => {
    setSyncingRecentWork(true);
    setSyncMessage(null);
    setError(null);
    try {
      const res = await invoke('syncRecentUnassignedWorkForIssue', { issueKey });
      if (!res?.success) {
        setError(res?.error || 'Sync failed');
        setSyncingRecentWork(false);
        return;
      }
      const count = res.matchedCount || 0;
      if (count > 0) {
        setSyncMessage(`Matched and assigned ${count} session${count === 1 ? '' : 's'}!`);
        window.setTimeout(() => router.reload(), 2000);
      } else {
        setSyncMessage('No matching recent unassigned work found in the last 30 minutes.');
        setSyncingRecentWork(false);
      }
    } catch (err) {
      setError(err?.message || 'Sync failed');
      setSyncingRecentWork(false);
    }
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (stage === STAGE.IDLE) {
    return (
      <div className="dq-root">
        <div className="dq-header">
          <h3 className="dq-title">Description quality</h3>
          <p className="dq-sub">
            Get an AI-powered review of this ticket’s title and description.
          </p>
        </div>
        <button
          type="button"
          className="dq-btn dq-btn--primary"
          onClick={() => runAnalysis(false)}
        >
          Check quality
        </button>
      </div>
    );
  }

  if (stage === STAGE.LOADING) {
    return (
      <div className="dq-root">
        <div className="dq-loading">
          <div className="dq-spinner" aria-hidden="true" />
          <span>Reading ticket and scoring…</span>
        </div>
      </div>
    );
  }

  if (stage === STAGE.LOADING_LLM) {
    return (
      <div className="dq-root">
        <div className="dq-loading">
          <div className="dq-spinner" aria-hidden="true" />
          <span>Generating an improved version…</span>
        </div>
      </div>
    );
  }

  if (stage === STAGE.ERROR) {
    return (
      <div className="dq-root">
        <div className="dq-error">
          {error || 'Something went wrong'}
          <button type="button" className="dq-btn dq-btn--link" onClick={handleReset}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (stage === STAGE.SUCCESS) {
    return (
      <div className="dq-root">
        <div className="dq-success">
          <span className="dq-success-icon" aria-hidden="true">✓</span>
          <div className="dq-success-body">
            <div>Ticket updated successfully.</div>
            {syncingRecentWork && (
              <div className="dq-loading dq-loading--inline">
                <div className="dq-spinner" aria-hidden="true" />
                <span>Syncing recent unassigned work…</span>
              </div>
            )}
            {syncMessage && !syncingRecentWork && (
              <div className="dq-sync-message">{syncMessage}</div>
            )}
            <div className="dq-success-actions">
              <button
                type="button"
                className="dq-btn dq-btn--primary"
                onClick={handleSyncRecentWork}
                disabled={syncingRecentWork}
              >
                {syncingRecentWork ? 'Syncing…' : 'Sync Recent Work'}
              </button>
              <button type="button" className="dq-btn dq-btn--link" onClick={handleDone}>
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (stage === STAGE.WRITING) {
    return (
      <div className="dq-root">
        <div className="dq-loading">
          <div className="dq-spinner" aria-hidden="true" />
          <span>Updating ticket in Jira…</span>
        </div>
      </div>
    );
  }

  // SCORED / COMPARISON / EDITING share a layout
  const showComparison = stage === STAGE.COMPARISON || stage === STAGE.EDITING;
  const isEditing = stage === STAGE.EDITING;

  return (
    <div className="dq-root">
      <div className="dq-header">
        <h3 className="dq-title">Description quality</h3>
      </div>

      <div className="dq-summary">
        <ScoreBadge score={analysis?.score} />
        <div className="dq-summary-text">
          <div className="dq-source-line">
            {analysis?.cached
              ? 'From cache'
              : analysis?.source === 'llm'
                ? 'Scored by AI'
                : 'Scored by rules'}
          </div>
          {analysis?.score != null && analysis.score >= 80 && !showComparison && (
            <div className="dq-good-msg">This description is in good shape.</div>
          )}
        </div>
      </div>

      {analysis?.issues?.length > 0 && (
        <div className="dq-section">
          <h4 className="dq-section-title">Issues found</h4>
          <BulletedList items={analysis.issues} className="dq-list dq-list--issues" />
        </div>
      )}

      {analysis?.suggestions?.length > 0 && (
        <div className="dq-section">
          <h4 className="dq-section-title">Suggestions</h4>
          <BulletedList items={analysis.suggestions} className="dq-list dq-list--suggestions" />
        </div>
      )}

      {showComparison && (
        <>
          <div className="dq-section">
            <h4 className="dq-section-title">Improved title</h4>
            {isEditing ? (
              <input
                type="text"
                className="dq-input"
                value={editedTitle}
                maxLength={255}
                onChange={(e) => setEditedTitle(e.target.value)}
              />
            ) : (
              <div className="dq-improved-title">{editedTitle}</div>
            )}
          </div>

          <div className="dq-section">
            <h4 className="dq-section-title">Improved description</h4>
            {isEditing ? (
              <textarea
                className="dq-textarea"
                value={editedDescription}
                rows={12}
                onChange={(e) => setEditedDescription(e.target.value)}
              />
            ) : (
              <pre className="dq-improved-desc">{editedDescription}</pre>
            )}
          </div>

          <div className="dq-actions">
            {isEditing ? (
              <>
                <button
                  type="button"
                  className="dq-btn dq-btn--primary"
                  disabled={!editedTitle.trim() || !editedDescription.trim()}
                  onClick={() => handleAccept({ updateTitle: true, updateDescription: true })}
                >
                  Save to Jira
                </button>
                <button
                  type="button"
                  className="dq-btn dq-btn--link"
                  onClick={() => setStage(STAGE.COMPARISON)}
                >
                  Cancel edit
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="dq-btn dq-btn--primary"
                  onClick={() => handleAccept({ updateTitle: true, updateDescription: true })}
                >
                  Apply both
                </button>
                <button
                  type="button"
                  className="dq-btn dq-btn--secondary"
                  onClick={() => handleAccept({ updateTitle: false, updateDescription: true })}
                >
                  Apply description only
                </button>
                <button
                  type="button"
                  className="dq-btn dq-btn--secondary"
                  onClick={() => setStage(STAGE.EDITING)}
                >
                  Edit first
                </button>
                <button type="button" className="dq-btn dq-btn--link" onClick={handleReject}>
                  Discard
                </button>
              </>
            )}
          </div>
        </>
      )}

      {!showComparison && (
        <div className="dq-actions">
          <button
            type="button"
            className="dq-btn dq-btn--primary"
            onClick={() => runAnalysis(true)}
            disabled={!analysis}
          >
            Improve with AI
          </button>
          <button
            type="button"
            className="dq-btn dq-btn--link"
            onClick={() => runAnalysis(false)}
          >
            Re-check
          </button>
        </div>
      )}
    </div>
  );
}
