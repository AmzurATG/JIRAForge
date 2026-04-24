import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import { formatLocalDate, parseUTC } from '../tabs/time-analytics/dateUtils';
import './BulkEditModal.css';

function BulkEditModal({ isOpen, userIssues, onClose, onSuccess }) {
  const [bulkEditDate, setBulkEditDate] = useState(formatLocalDate(new Date()));
  const [bulkEditStartTime, setBulkEditStartTime] = useState('09:00');
  const [bulkEditEndTime, setBulkEditEndTime] = useState('17:00');
  const [bulkEditTargetIssue, setBulkEditTargetIssue] = useState('');
  const [bulkEditCreateWorklog, setBulkEditCreateWorklog] = useState(true);
  const [bulkEditPreview, setBulkEditPreview] = useState(null);
  const [bulkEditLoading, setBulkEditLoading] = useState(false);
  const [bulkEditApplying, setBulkEditApplying] = useState(false);
  const [bulkEditSuccess, setBulkEditSuccess] = useState(null);
  const [bulkEditError, setBulkEditError] = useState(null);

  const timeRangeError = bulkEditStartTime && bulkEditEndTime && bulkEditStartTime >= bulkEditEndTime
    ? 'End time must be after start time on the same day.'
    : null;

  const formatTimeForDisplay = (timestamp) => {
    if (!timestamp) return '';
    const date = parseUTC(timestamp);
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatSeconds = (s) => {
    const total = Math.max(0, Math.round(s || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${total}s`;
  };

  // Convert a user-picked local date+time into a UTC ISO string using the
  // browser's timezone. This is the only reliable place to do the conversion —
  // the resolver runs in UTC and has no knowledge of the user's wall-clock.
  const localToUtcIso = (dateStr, timeStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [h, min] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, h, min, 0).toISOString();
  };

  const handleClose = () => {
    // Reset state on close
    setBulkEditDate(formatLocalDate(new Date()));
    setBulkEditStartTime('09:00');
    setBulkEditEndTime('17:00');
    setBulkEditTargetIssue('');
    setBulkEditCreateWorklog(true);
    setBulkEditPreview(null);
    setBulkEditSuccess(null);
    setBulkEditError(null);
    onClose();
  };

  const handlePreviewBulkEdit = async () => {
    setBulkEditError(null);

    if (!bulkEditDate || !bulkEditStartTime || !bulkEditEndTime) {
      setBulkEditError('Please select date and time range.');
      return;
    }

    if (timeRangeError) {
      setBulkEditError(timeRangeError);
      return;
    }

    setBulkEditLoading(true);
    setBulkEditPreview(null);

    try {
      const result = await invoke('previewBulkReassign', {
        selectedDate: bulkEditDate,
        startTime: bulkEditStartTime,
        endTime: bulkEditEndTime,
        windowStartUtc: localToUtcIso(bulkEditDate, bulkEditStartTime),
        windowEndUtc: localToUtcIso(bulkEditDate, bulkEditEndTime)
      });

      if (result.success) {
        setBulkEditPreview(result.preview);
      } else {
        setBulkEditError('Failed to preview: ' + result.error);
      }
    } catch (err) {
      console.error('[BulkEditModal] Error previewing bulk edit:', err);
      setBulkEditError('Error previewing: ' + err.message);
    } finally {
      setBulkEditLoading(false);
    }
  };

  const handleApplyBulkEdit = async () => {
    setBulkEditError(null);

    if (!bulkEditTargetIssue) {
      setBulkEditError('Please select a target issue.');
      return;
    }

    if (!bulkEditPreview || bulkEditPreview.total_activities === 0) {
      setBulkEditError('No activities to reassign. Please preview first.');
      return;
    }

    setBulkEditApplying(true);

    try {
      const result = await invoke('bulkReassignByTimeInterval', {
        selectedDate: bulkEditDate,
        startTime: bulkEditStartTime,
        endTime: bulkEditEndTime,
        windowStartUtc: localToUtcIso(bulkEditDate, bulkEditStartTime),
        windowEndUtc: localToUtcIso(bulkEditDate, bulkEditEndTime),
        targetIssueKey: bulkEditTargetIssue,
        createWorklog: bulkEditCreateWorklog
      });

      if (result.success) {
        setBulkEditSuccess(result.result);
        onSuccess();
      } else {
        setBulkEditError('Failed to apply bulk edit: ' + result.error);
      }
    } catch (err) {
      console.error('[BulkEditModal] Error applying bulk edit:', err);
      setBulkEditError('Error applying bulk edit: ' + err.message);
    } finally {
      setBulkEditApplying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay bulk-edit-modal" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Bulk Time Edit</h3>
          <button className="modal-close" onClick={handleClose}>×</button>
        </div>

        <div className="modal-body">
          {bulkEditSuccess ? (
            // Success state
            <div className="bulk-edit-success">
              <div className="success-icon">✅</div>
              <h4>Successfully Reassigned!</h4>
              <div className="success-details">
                <p><strong>{bulkEditSuccess.total_reassigned}</strong> activities reassigned to <strong>{bulkEditSuccess.target_issue_key}</strong></p>
                <p>
                  • {bulkEditSuccess.previously_tracked} were tracked to other issues<br />
                  • {bulkEditSuccess.previously_unassigned} were unassigned
                </p>
                <p>Total time: <strong>{bulkEditSuccess.total_time_formatted}</strong></p>
                {bulkEditSuccess.worklog_id && (
                  <p>Worklog created: #{bulkEditSuccess.worklog_id}</p>
                )}
              </div>
              <button
                className="apply-bulk-edit-btn"
                onClick={handleClose}
                style={{ marginTop: '20px' }}
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <p className="match-tip-banner">
                <span>Our AI matches sessions to Jira issues using their <strong>summary</strong> and <strong>description</strong>. Use clear, descriptive titles in Jira to improve matching accuracy.</span>
              </p>

              {/* Time Selection Section */}
              <div className="time-selection-section">
                <h4>Select Time Interval</h4>
                <p style={{ fontSize: '13px', color: '#5e6c84', marginBottom: '16px' }}>
                  Select a date and time range. All activities (tracked and untracked) within this interval will be reassigned.
                </p>
                <div className="time-selection-grid">
                  <div className="time-input-group">
                    <label>Date</label>
                    <input
                      type="date"
                      value={bulkEditDate}
                      onChange={(e) => setBulkEditDate(e.target.value)}
                      max={formatLocalDate(new Date())}
                    />
                  </div>
                  <div className="time-input-group">
                    <label>Start Time</label>
                    <input
                      type="time"
                      value={bulkEditStartTime}
                      onChange={(e) => setBulkEditStartTime(e.target.value)}
                    />
                  </div>
                  <div className="time-input-group">
                    <label>End Time</label>
                    <input
                      type="time"
                      value={bulkEditEndTime}
                      onChange={(e) => setBulkEditEndTime(e.target.value)}
                    />
                  </div>
                </div>

                {timeRangeError && (
                  <div className="bulk-edit-inline-error">{timeRangeError}</div>
                )}
                {bulkEditError && (
                  <div className="bulk-edit-inline-error">{bulkEditError}</div>
                )}

                <button
                  className="preview-btn"
                  onClick={handlePreviewBulkEdit}
                  disabled={bulkEditLoading || !bulkEditDate || !bulkEditStartTime || !bulkEditEndTime || !!timeRangeError}
                >
                  {bulkEditLoading ? (
                    <>
                      <span className="spinner"></span>
                      Loading Preview...
                    </>
                  ) : (
                    'Preview Activities'
                  )}
                </button>
              </div>

              {/* Preview Results Section */}
              {bulkEditPreview && (
                <div className="preview-results">
                  <h4>Activities Found</h4>

                  {bulkEditPreview.total_activities === 0 ? (
                    <div className="no-preview-results">
                      <div className="empty-icon">📭</div>
                      <p>No activities found in this time range.</p>
                      <p>Try adjusting the date or time interval.</p>
                    </div>
                  ) : (
                    <>
                      <div className="preview-stats">
                        <div className="preview-stat">
                          <div className="preview-stat-value">{bulkEditPreview.total_activities}</div>
                          <div className="preview-stat-label">Total Activities</div>
                        </div>
                        <div
                          className="preview-stat total-time"
                          title="Time logged is pro-rated by how much of each activity falls inside the selected window."
                        >
                          <div className="preview-stat-value">{bulkEditPreview.total_time_formatted}</div>
                          <div className="preview-stat-label">Total Time (pro-rated)</div>
                        </div>
                        <div className="preview-stat wrongly-tracked">
                          <div className="preview-stat-value">{bulkEditPreview.wrongly_tracked_count}</div>
                          <div className="preview-stat-label">Currently Tracked</div>
                        </div>
                        <div className="preview-stat unassigned">
                          <div className="preview-stat-value">{bulkEditPreview.unassigned_count}</div>
                          <div className="preview-stat-label">Unassigned</div>
                        </div>
                      </div>

                      {bulkEditPreview.partial_count > 0 && (
                        <div className="bulk-edit-partial-warning">
                          <strong>{bulkEditPreview.partial_count}</strong> activit
                          {bulkEditPreview.partial_count === 1 ? 'y' : 'ies'} partially fall outside this window.
                          Pro-rated time will be logged to the worklog, but each activity will still be
                          fully reassigned to the target issue.
                        </div>
                      )}

                      {bulkEditPreview.currently_assigned_issues.length > 0 && (
                        <div className="current-issues-info">
                          <strong>Activities currently assigned to:</strong>
                          <div style={{ marginTop: '8px' }}>
                            {bulkEditPreview.currently_assigned_issues.map(issueKey => (
                              <span key={issueKey} className="issue-badge">{issueKey}</span>
                            ))}
                          </div>
                          <p style={{ marginTop: '8px', marginBottom: 0, fontSize: '12px' }}>
                            These will be reassigned to your selected target issue.
                          </p>
                        </div>
                      )}

                      {/* Activities Preview List */}
                      <div className="activities-preview">
                        {bulkEditPreview.activities.slice(0, 20).map((activity, index) => (
                          <div key={activity.id || index} className="activity-preview-item">
                            <span className="activity-time">
                              {formatTimeForDisplay(activity.timestamp)}
                            </span>
                            <span className="activity-app" title={activity.window_title}>
                              {activity.application_name || 'Unknown App'}
                            </span>
                            <span
                              className="activity-attributed"
                              title={activity.partial
                                ? `Pro-rated: ${formatSeconds(activity.attributed_seconds)} of ${formatSeconds(activity.record_seconds)}`
                                : `Full attribution: ${formatSeconds(activity.attributed_seconds)}`}
                            >
                              {formatSeconds(activity.attributed_seconds)}
                              {activity.partial && <span className="partial-badge">partial</span>}
                            </span>
                            <span className={`activity-current-issue ${activity.is_unassigned ? 'unassigned' : 'assigned'}`}>
                              {activity.is_unassigned ? 'Unassigned' : activity.current_issue_key}
                            </span>
                          </div>
                        ))}
                        {bulkEditPreview.activities.length > 20 && (
                          <div className="activity-preview-item" style={{ justifyContent: 'center', color: '#5e6c84' }}>
                            ... and {bulkEditPreview.activities.length - 20} more activities
                          </div>
                        )}
                      </div>

                      {/* Target Issue Selection */}
                      <div className="target-issue-section">
                        <h4>Select Target Issue</h4>
                        <select
                          value={bulkEditTargetIssue}
                          onChange={(e) => setBulkEditTargetIssue(e.target.value)}
                        >
                          <option value="">-- Select Issue to Assign --</option>
                          {userIssues.map(issue => (
                            <option key={issue.key} value={issue.key}>
                              {issue.key}: {issue.summary}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Create Worklog Checkbox */}
                      <label className="worklog-checkbox">
                        <input
                          type="checkbox"
                          checked={bulkEditCreateWorklog}
                          onChange={(e) => setBulkEditCreateWorklog(e.target.checked)}
                        />
                        Create worklog entry for this time ({bulkEditPreview.total_time_formatted})
                      </label>

                      {/* Apply Button */}
                      <button
                        className="apply-bulk-edit-btn"
                        onClick={handleApplyBulkEdit}
                        disabled={bulkEditApplying || !bulkEditTargetIssue}
                      >
                        {bulkEditApplying ? (
                          <>
                            <span className="spinner"></span>
                            Reassigning...
                          </>
                        ) : (
                          <>
                            Reassign {bulkEditPreview.total_activities} Activities to {bulkEditTargetIssue || 'Selected Issue'}
                          </>
                        )}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default BulkEditModal;
