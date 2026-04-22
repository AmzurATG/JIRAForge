import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@forge/bridge';
import { formatTime } from '../../utils';

/**
 * Session Reassign Modal
 *
 * Two tabs (only when reassigning a PENDING APPROVAL session):
 *   - Existing Issue  -> reassignAndApproveRecords
 *   - Create New      -> createIssueAndApproveRecords
 *
 * For LEGACY sessions (analysisResultIds-based, no pending_approval flag),
 * only the Existing Issue tab is shown — there is no equivalent
 * "create-new + reassign" resolver for the legacy path.
 *
 * The optional comment field maps to the resolver's `reason` parameter; the
 * legacy reassignSession resolver ignores it, the pending-approval one stores
 * it as approval_notes for audit + accuracy event metadata.
 */
function SessionReassignModal({
  isOpen,
  sessionToReassign,
  activeIssues,
  reassigning,
  onClose,
  onReassign,
  onCreateAndReassign
}) {
  const isPendingApproval =
    sessionToReassign?.session?.approvalStatus === 'pending_approval' &&
    Array.isArray(sessionToReassign?.session?.activityRecordIds) &&
    sessionToReassign.session.activityRecordIds.length > 0;

  // ---- shared state ----
  const [activeTab, setActiveTab] = useState('existing');
  const [reason, setReason] = useState('');

  // ---- existing-tab state ----
  const [searchQuery, setSearchQuery] = useState('');

  // ---- create-tab state (lazy-loaded projects/statuses) ----
  const [userProjects, setUserProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [newIssueSummary, setNewIssueSummary] = useState('');
  const [newIssueDescription, setNewIssueDescription] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [availableStatuses, setAvailableStatuses] = useState([]);
  const [selectedStatus, setSelectedStatus] = useState('To Do');
  const [assignToMe, setAssignToMe] = useState(true);

  // Reset everything when the modal (re)opens for a new session.
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab('existing');
    setReason('');
    setSearchQuery('');
    setNewIssueSummary('');
    setNewIssueDescription('');
    setIssueType('Task');
    setAssignToMe(true);
    setSelectedStatus('To Do');
  }, [isOpen, sessionToReassign]);

  // Lazy-load projects the first time the user opens the Create tab.
  useEffect(() => {
    if (!isOpen || activeTab !== 'new' || userProjects.length > 0 || projectsLoading) return;
    let cancelled = false;
    setProjectsLoading(true);
    (async () => {
      try {
        const res = await invoke('getUserProjects');
        if (cancelled) return;
        const projects = res?.projects || [];
        setUserProjects(projects);
        if (projects.length > 0 && !selectedProject) {
          setSelectedProject(projects[0].key);
        }
      } catch (err) {
        console.error('[SessionReassignModal] failed to load projects:', err);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeTab]);

  // Load statuses when the project changes (only relevant on Create tab).
  useEffect(() => {
    if (activeTab !== 'new' || !selectedProject) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await invoke('getProjectStatuses', { projectKey: selectedProject });
        if (cancelled) return;
        const statuses = res?.statuses || [];
        setAvailableStatuses(statuses);
        if (statuses.length > 0) {
          const toDo = statuses.find(s => s.name === 'To Do');
          setSelectedStatus(toDo ? 'To Do' : statuses[0].name);
        }
      } catch (err) {
        // Fall back to common defaults — don't block the user.
        setAvailableStatuses([
          { name: 'To Do' },
          { name: 'In Progress' },
          { name: 'Done' }
        ]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, selectedProject]);

  // Sort issues for the existing-issue list — In Progress first, Done last.
  const sortedIssues = useMemo(() => {
    if (!sessionToReassign) return [];
    const statusRank = (status) => {
      const s = (status || '').toLowerCase();
      if (s === 'in progress') return 0;
      if (s === 'to do' || s === 'open' || s === 'backlog') return 1;
      if (s === 'done' || s === 'closed' || s === 'resolved') return 3;
      return 2;
    };
    return activeIssues
      .filter(issue => issue.key !== sessionToReassign.fromIssueKey)
      .slice()
      .sort((a, b) => statusRank(a.status) - statusRank(b.status));
  }, [activeIssues, sessionToReassign]);

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sortedIssues;
    return sortedIssues.filter(issue =>
      issue.key.toLowerCase().includes(q) ||
      (issue.summary || '').toLowerCase().includes(q) ||
      (issue.status || '').toLowerCase().includes(q)
    );
  }, [sortedIssues, searchQuery]);

  if (!isOpen || !sessionToReassign) return null;

  const durationSeconds = sessionToReassign.session.duration || 0;

  const handlePickExisting = (toIssueKey) => {
    onReassign(toIssueKey, reason.trim() || undefined);
  };

  const handleCreateNew = () => {
    if (!newIssueSummary.trim()) {
      alert('Please enter an issue summary');
      return;
    }
    if (!selectedProject) {
      alert('Please select a project');
      return;
    }
    if (typeof onCreateAndReassign !== 'function') {
      alert('Create-new is not available for this session.');
      return;
    }
    onCreateAndReassign({
      issueSummary: newIssueSummary.trim(),
      issueDescription: newIssueDescription.trim(),
      projectKey: selectedProject,
      issueType,
      statusName: selectedStatus,
      assignToSelf: assignToMe,
      reason: reason.trim() || undefined
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content reassign-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reassign Session</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <p className="reassign-info">
            Moving <strong>{formatTime(durationSeconds)}</strong> from{' '}
            <strong>{sessionToReassign.fromIssueKey}</strong>
          </p>

          {/* Optional comment / reason — shown for pending sessions only,
              since the legacy reassignSession resolver ignores it. */}
          {isPendingApproval && (
            <label className="reassign-reason-label">
              What were you actually working on? <span className="optional-hint">(optional)</span>
              <input
                type="text"
                className="reassign-search"
                placeholder="e.g. Code review, standup meeting"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}

          {/* Tabs (only when create-new is wired) */}
          {isPendingApproval && typeof onCreateAndReassign === 'function' && (
            <div className="reassign-tabs">
              <button
                type="button"
                className={`reassign-tab ${activeTab === 'existing' ? 'active' : ''}`}
                onClick={() => setActiveTab('existing')}
                disabled={reassigning}
              >
                Existing Issue
              </button>
              <button
                type="button"
                className={`reassign-tab ${activeTab === 'new' ? 'active' : ''}`}
                onClick={() => setActiveTab('new')}
                disabled={reassigning}
              >
                Create New
              </button>
            </div>
          )}

          {activeTab === 'existing' && (
            <>
              <p className="reassign-prompt">Select the issue to reassign this time to:</p>
              <input
                type="text"
                className="reassign-search"
                placeholder="Search by key, title, or status…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div className="issue-list-modal">
                {filteredIssues.map(issue => (
                  <button
                    key={issue.key}
                    className="issue-option"
                    onClick={() => handlePickExisting(issue.key)}
                    disabled={reassigning}
                  >
                    <span className="issue-key">{issue.key}</span>
                    <span className="issue-summary">{issue.summary}</span>
                    <span className={`status-badge status-${issue.statusCategory}`}>
                      {issue.status}
                    </span>
                  </button>
                ))}
                {filteredIssues.length === 0 && (
                  <p className="empty-state">
                    {searchQuery
                      ? `No issues match "${searchQuery}".`
                      : 'No other issues available for reassignment.'}
                  </p>
                )}
              </div>
            </>
          )}

          {activeTab === 'new' && isPendingApproval && (
            <div className="new-issue-form">
              <label>
                Issue Summary <span className="required">*</span>
                <input
                  type="text"
                  value={newIssueSummary}
                  onChange={(e) => setNewIssueSummary(e.target.value)}
                  placeholder="Enter issue title"
                  required
                />
              </label>

              <label>
                Description <span className="optional-hint">(optional)</span>
                <textarea
                  value={newIssueDescription}
                  onChange={(e) => setNewIssueDescription(e.target.value)}
                  placeholder="Describe the work performed…"
                  rows={3}
                />
              </label>

              <label>
                Project <span className="required">*</span>
                <select
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  disabled={projectsLoading}
                  required
                >
                  {projectsLoading && <option>Loading projects…</option>}
                  {!projectsLoading && userProjects.length === 0 && (
                    <option value="">No projects available</option>
                  )}
                  {userProjects.map(project => (
                    <option key={project.key} value={project.key}>
                      {project.name} ({project.key})
                    </option>
                  ))}
                </select>
              </label>

              <div className="form-row">
                <label>
                  Issue Type
                  <select
                    value={issueType}
                    onChange={(e) => setIssueType(e.target.value)}
                  >
                    <option value="Task">Task</option>
                    <option value="Bug">Bug</option>
                    <option value="Story">Story</option>
                  </select>
                </label>

                <label>
                  Initial Status
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value)}
                  >
                    {availableStatuses.length > 0 ? (
                      availableStatuses.map(status => (
                        <option key={status.id || status.name} value={status.name}>
                          {status.name}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="To Do">To Do</option>
                        <option value="In Progress">In Progress</option>
                        <option value="Done">Done</option>
                      </>
                    )}
                  </select>
                </label>
              </div>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={assignToMe}
                  onChange={(e) => setAssignToMe(e.target.checked)}
                />
                Assign new issue to me
              </label>

              <button
                className="submit-button"
                onClick={handleCreateNew}
                disabled={reassigning || !newIssueSummary.trim() || !selectedProject || projectsLoading}
              >
                {reassigning ? 'Creating…' : `Create issue & reassign ${formatTime(durationSeconds)}`}
              </button>
            </div>
          )}
        </div>

        {reassigning && (
          <div className="modal-footer">
            <span className="reassigning-text">Working…</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default SessionReassignModal;
