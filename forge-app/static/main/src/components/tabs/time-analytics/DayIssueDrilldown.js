import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../../utils';

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Inline day drill-down panel (no modal).
 * Shows issue-wise breakdown for the selected date.
 */
function DayIssueDrilldown({ selectedDate, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(null);

  useEffect(() => {
    if (!selectedDate) {
      setDetails(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    invoke('getMyDayIssueBreakdown', { date: selectedDate })
      .then((result) => {
        if (!active) return;
        if (result?.success) {
          setDetails(result.data || null);
        } else {
          setError(result?.error || 'Failed to load day details');
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message || 'Failed to load day details');
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedDate]);

  if (!selectedDate) return null;

  return (
    <div className="day-drilldown" role="region" aria-label="Day issue breakdown">
      <div className="day-drilldown-header">
        <div>
          <h4>Issue Breakdown</h4>
          <p>{formatDisplayDate(selectedDate)}</p>
        </div>
        <button className="day-drilldown-close" onClick={onClose}>Hide</button>
      </div>

      {loading && (
        <div className="day-drilldown-state">
          <p>Loading issue details...</p>
        </div>
      )}

      {!loading && error && (
        <div className="day-drilldown-state day-drilldown-error">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="day-drilldown-summary">
            <span>Total: {formatTime(details?.totalSeconds || 0)}</span>
            <span>Issues: {details?.issueCount || 0}</span>
          </div>

          {details?.issues?.length ? (
            <div className="day-drilldown-list">
              {details.issues.map((issue, idx) => {
                const pct = (details.totalSeconds || 0) > 0
                  ? Math.round((issue.totalSeconds / details.totalSeconds) * 100)
                  : 0;

                return (
                  <div key={`${issue.issueKey}-${idx}`} className="day-drilldown-item">
                    <div className="day-drilldown-item-top">
                      <div className="day-drilldown-issue-meta">
                        <span className="day-drilldown-issue-key">{issue.issueKey}</span>
                        {issue.summary && (
                          <span className="day-drilldown-issue-summary">{issue.summary}</span>
                        )}
                      </div>
                      <div className="day-drilldown-time">
                        {formatTime(issue.totalSeconds)}
                        <span className="day-drilldown-pct">({pct}%)</span>
                      </div>
                    </div>
                    <div className="day-drilldown-bar-track">
                      <div className="day-drilldown-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="day-drilldown-state">
              <p>No issue activity recorded for this day.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default DayIssueDrilldown;
