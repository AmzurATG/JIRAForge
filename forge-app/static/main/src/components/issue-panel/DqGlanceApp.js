import React, { useCallback, useEffect, useState } from 'react';
import { invoke, router, events } from '@forge/bridge';
import './DqGlanceApp.css';

/**
 * DqGlanceApp — jira:issueGlance surface
 *
 * Always-visible DQ score widget rendered in the Jira issue right sidebar.
 * Collapsed state: a single-row score badge + quality label.
 * Expanded state: score circle, issues list, suggestions, and an
 *   "Improve with AI" button that navigates to the full issue panel.
 *
 * Reuses the existing `analyzeDescription` resolver — no new backend
 * endpoint needed.
 */

function badgeClass(score) {
  if (score == null) return 'dqg-badge--unknown';
  if (score >= 80) return 'dqg-badge--green';
  if (score >= 50) return 'dqg-badge--yellow';
  return 'dqg-badge--red';
}

function circleClass(score) {
  if (score == null) return 'dqg-score-circle--unknown';
  if (score >= 80) return 'dqg-score-circle--green';
  if (score >= 50) return 'dqg-score-circle--yellow';
  return 'dqg-score-circle--red';
}

function qualityLabel(score) {
  if (score == null) return 'Not scored';
  if (score >= 80) return 'Excellent';
  if (score >= 50) return 'Needs work';
  return 'Poor quality';
}

function labelClass(score) {
  if (score == null) return '';
  if (score >= 80) return 'dqg-label--good';
  if (score >= 50) return 'dqg-label--warn';
  return 'dqg-label--poor';
}

// Chevron SVG — compact down arrow, rotates when open
function Chevron({ open }) {
  return (
    <svg
      className={`dqg-chevron ${open ? 'dqg-chevron--open' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function DqGlanceApp({ issueKey }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | loading | scored | improving | error
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);

  const fetchScore = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await invoke('analyzeDescription', {
        issueKey,
        requestImprovement: false
      });
      if (!res?.success) {
        setError(res?.error || 'Analysis failed');
        setStatus('error');
        return;
      }
      setAnalysis(res);
      setStatus('scored');
    } catch (err) {
      setError(err?.message || 'Analysis failed');
      setStatus('error');
    }
  }, [issueKey]);

  // Fetch score on mount and subscribe to cross-iframe sync events
  useEffect(() => {
    fetchScore();

    const subLoading = events.on('dq-loading', () => {
      setStatus('loading');
    });

    const subScore = events.on('dq-score-update', (updatedAnalysis) => {
      if (updatedAnalysis?.success) {
        setAnalysis(updatedAnalysis);
        setStatus('scored');
      }
    });

    return () => {
      // Unsubscribe when component unmounts
      subLoading.then(sub => sub.unsubscribe());
      subScore.then(sub => sub.unsubscribe());
    };
  }, [fetchScore]);

  // When user expands and score not yet loaded, trigger fetch
  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && status === 'idle') {
      fetchScore();
    }
  };

  const handleImprove = async () => {
    // Navigate the user to the Time Analytics issue panel tab where they
    // can click "Improve with AI". router.navigate opens the issue page
    // which will show the full IssuePanelApp with the DQ section.
    setStatus('improving');
    try {
      await router.navigate(`/browse/${issueKey}`);
    } catch {
      setStatus('scored');
    }
  };

  const score = analysis?.score ?? null;

  // ── Collapsed row ──
  const collapsedRow = (
    <button
      className="dqg-collapsed"
      onClick={handleToggle}
      aria-expanded={expanded}
      aria-label={`Description Quality Score: ${score ?? 'not scored'}. ${expanded ? 'Collapse' : 'Expand'} details.`}
      type="button"
    >
      {status === 'loading' ? (
        <span className="dqg-loading">
          <span className="dqg-spinner" aria-hidden="true" />
          <span className="dqg-label">Scoring…</span>
        </span>
      ) : status === 'error' ? (
        <span className="dqg-label">⚠️ Score unavailable</span>
      ) : (
        <>
          <span className={`dqg-badge ${badgeClass(score)}`} aria-hidden="true">
            {score ?? '—'}
          </span>
          <span className={`dqg-label ${labelClass(score)}`}>
            {qualityLabel(score)}
          </span>
        </>
      )}
      <Chevron open={expanded} />
    </button>
  );

  // ── Expanded panel ──
  const expandedPanel = expanded && (
    <div className="dqg-expanded" role="region" aria-label="Description Quality details">
      {status === 'loading' && (
        <span className="dqg-loading">
          <span className="dqg-spinner" aria-hidden="true" />
          <span>Analyzing description…</span>
        </span>
      )}

      {status === 'error' && (
        <div className="dqg-error">
          ⚠️ {error || 'Could not load score.'}
          <button type="button" className="dqg-btn dqg-btn--link" onClick={fetchScore}>
            Retry
          </button>
        </div>
      )}

      {status === 'scored' && analysis && (
        <>
          {/* Score circle + meta */}
          <div className="dqg-score-row">
            <div
              className={`dqg-score-circle ${circleClass(score)}`}
              aria-label={`Score ${score} out of 100`}
            >
              <span className="dqg-score-number">{score ?? '—'}</span>
              <span className="dqg-score-denom">/100</span>
            </div>
            <div className="dqg-score-meta">
              <div className="dqg-score-title">{qualityLabel(score)}</div>
              <div className="dqg-score-source">
                {analysis.cached
                  ? 'Cached score'
                  : analysis.source === 'llm'
                    ? 'Scored by AI'
                    : 'Scored by rules'}
              </div>
              {score >= 80 && (
                <div className="dqg-good-msg">Great description — no changes needed.</div>
              )}
            </div>
          </div>

          {/* Issues list (max 3 shown in glance) */}
          {Array.isArray(analysis.issues) && analysis.issues.length > 0 && (
            <div className="dqg-section">
              <div className="dqg-section-label">Issues found</div>
              <ul className="dqg-list dqg-list--issues">
                {analysis.issues.slice(0, 3).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
                {analysis.issues.length > 3 && (
                  <li style={{ color: 'var(--ds-text-subtle, #6B778C)' }}>
                    +{analysis.issues.length - 3} more — see panel for full list
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Suggestions list (max 2 shown in glance) */}
          {Array.isArray(analysis.suggestions) && analysis.suggestions.length > 0 && (
            <div className="dqg-section">
              <div className="dqg-section-label">Suggestions</div>
              <ul className="dqg-list dqg-list--suggestions">
                {analysis.suggestions.slice(0, 2).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          <div className="dqg-actions">
            {score < 80 && (
              <button
                type="button"
                className="dqg-btn dqg-btn--primary"
                onClick={handleImprove}
                disabled={status === 'improving'}
              >
                {status === 'improving' ? 'Opening…' : 'Improve with AI'}
              </button>
            )}
            <button
              type="button"
              className="dqg-btn dqg-btn--link"
              onClick={fetchScore}
            >
              Re-check
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="dqg-root">
      {collapsedRow}
      {expandedPanel}
    </div>
  );
}
