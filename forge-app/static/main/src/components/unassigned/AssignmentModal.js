import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import './AssignmentModal.css';

function AssignmentModal({
  isOpen,
  selectedGroup,
  userIssues,
  userProjects,
  onClose,
  onAssignmentComplete
}) {
  const [assignmentType, setAssignmentType] = useState('existing');
  const [selectedIssueKey, setSelectedIssueKey] = useState('');
  const [newIssueSummary, setNewIssueSummary] = useState('');
  const [newIssueDescription, setNewIssueDescription] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [selectedStatus, setSelectedStatus] = useState('To Do');
  const [availableStatuses, setAvailableStatuses] = useState([]);
  const [assignToMe, setAssignToMe] = useState(true);
  const [assigning, setAssigning] = useState(false);

  // Load statuses when project changes
  useEffect(() => {
    if (selectedProject) {
      loadProjectStatuses(selectedProject);
    }
  }, [selectedProject]);

  // Reset and initialize form when modal opens with a new group
  useEffect(() => {
    if (isOpen && selectedGroup) {
      // Reset all form state first
      setAssignmentType('existing');
      setSelectedIssueKey('');
      setNewIssueSummary('');
      setNewIssueDescription('');
      setIssueType('Task');
      setSelectedStatus('To Do');
      setAssignToMe(true);
      setAssigning(false);

      // Set default project
      if (userProjects?.length > 0) {
        setSelectedProject(userProjects[0].key);
      }

      // Pre-fill form with AI suggestions
      if (selectedGroup.recommendation?.action === 'assign_to_existing' &&
          selectedGroup.recommendation?.suggested_issue_key) {
        setAssignmentType('existing');
        setSelectedIssueKey(selectedGroup.recommendation.suggested_issue_key);
      } else if (selectedGroup.recommendation?.action === 'create_new_issue') {
        setAssignmentType('new');
        setNewIssueSummary(selectedGroup.label || '');
        setNewIssueDescription(selectedGroup.description || '');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedGroup]);

  const loadProjectStatuses = async (projectKey) => {
    try {
      const result = await invoke('getProjectStatuses', { projectKey });
      if (result.success) {
        setAvailableStatuses(result.statuses || []);
        if (result.statuses && result.statuses.length > 0) {
          const toDoStatus = result.statuses.find(s => s.name === 'To Do');
          setSelectedStatus(toDoStatus ? 'To Do' : result.statuses[0].name);
        }
      }
    } catch (err) {
      console.error('Error loading project statuses:', err);
      setAvailableStatuses([
        { name: 'To Do', id: '1' },
        { name: 'In Progress', id: '3' },
        { name: 'Done', id: '10001' }
      ]);
    }
  };

  const handleAssignToExisting = async () => {
    if (!selectedIssueKey) {
      alert('Please select an issue');
      return;
    }

    if (!selectedGroup.session_ids || !Array.isArray(selectedGroup.session_ids) || selectedGroup.session_ids.length === 0) {
      alert('No sessions available in this group. Please select a different group.');
      return;
    }

    setAssigning(true);
    try {
      const result = await invoke('assignToExistingIssue', {
        sessionIds: selectedGroup.session_ids,
        issueKey: selectedIssueKey,
        groupId: selectedGroup.id,
        totalSeconds: selectedGroup.total_seconds
      });

      if (result.success) {
        let message = `Successfully assigned ${result.assigned_count} session(s) to ${result.issue_key}`;
        if (result.worklog_skipped) {
          message += `\n\nNote: Worklog was not created because ${result.worklog_skipped_reason}. The work session has been linked to the issue but no time was logged in Jira.`;
        }
        alert(message);
        onClose();
        onAssignmentComplete();
      } else {
        alert('Failed to assign work: ' + result.error);
      }
    } catch (err) {
      console.error('Error assigning work:', err);
      alert('Error assigning work: ' + err.message);
    } finally {
      setAssigning(false);
    }
  };

  const handleCreateNewIssue = async () => {
    if (!newIssueSummary) {
      alert('Please enter issue summary');
      return;
    }

    if (!selectedProject) {
      alert('Please select a project');
      return;
    }

    if (!selectedGroup.session_ids || !Array.isArray(selectedGroup.session_ids) || selectedGroup.session_ids.length === 0) {
      alert('No sessions available in this group. Please select a different group.');
      return;
    }

    setAssigning(true);
    try {
      const result = await invoke('createIssueAndAssign', {
        sessionIds: selectedGroup.session_ids,
        issueSummary: newIssueSummary,
        issueDescription: newIssueDescription,
        projectKey: selectedProject,
        issueType: issueType,
        totalSeconds: selectedGroup.total_seconds,
        groupId: selectedGroup.id,
        assigneeAccountId: assignToMe ? null : null,
        statusName: selectedStatus
      });

      if (result.success) {
        let message = `Successfully created issue ${result.issue_key} and assigned ${result.assigned_count} session(s)`;
        if (result.worklog_skipped) {
          message += `\n\nNote: Worklog was not created because ${result.worklog_skipped_reason}. The issue was created but no time was logged.`;
        }
        alert(message);
        onClose();
        onAssignmentComplete();
      } else {
        alert('Failed to create issue: ' + result.error);
      }
    } catch (err) {
      console.error('Error creating issue:', err);
      alert('Error creating issue: ' + err.message);
    } finally {
      setAssigning(false);
    }
  };

  if (!isOpen || !selectedGroup) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content assignment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Assign "{selectedGroup.label}"</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="assignment-options">
            <label className="radio-option">
              <input
                type="radio"
                name="assignment-type"
                value="existing"
                checked={assignmentType === 'existing'}
                onChange={() => setAssignmentType('existing')}
              />
              <span>Add to Existing Issue</span>
            </label>

            <label className="radio-option">
              <input
                type="radio"
                name="assignment-type"
                value="new"
                checked={assignmentType === 'new'}
                onChange={() => setAssignmentType('new')}
              />
              <span>Create New Issue</span>
            </label>
          </div>

          {assignmentType === 'existing' && (
            <div className="existing-issue-form">
              <label>
                Select Jira Issue:
                <select
                  value={selectedIssueKey}
                  onChange={(e) => setSelectedIssueKey(e.target.value)}
                >
                  <option value="">-- Select Issue --</option>
                  {userIssues.map(issue => (
                    <option key={issue.key} value={issue.key}>
                      {issue.key}: {issue.summary}
                    </option>
                  ))}
                </select>
              </label>
              <div className="time-preview">
                Time to log: <strong>{selectedGroup.total_time_formatted}</strong>
                {selectedGroup.total_seconds < 60 && (
                  <div className="time-warning">
                    Note: Time is under 1 minute. The worklog will be deferred to the next scheduled sync, where it will be aggregated with other time on this issue before logging to Jira.
                  </div>
                )}
              </div>
              <button
                className="submit-button"
                onClick={handleAssignToExisting}
                disabled={assigning || !selectedIssueKey}
              >
                {assigning ? 'Assigning...' : 'Assign to Issue'}
              </button>
            </div>
          )}

          {assignmentType === 'new' && (
            <div className="new-issue-form">
              <label>
                Issue Summary: *
                <input
                  type="text"
                  value={newIssueSummary}
                  onChange={(e) => setNewIssueSummary(e.target.value)}
                  placeholder="Enter issue title"
                  required
                />
              </label>

              <label>
                Description:
                <textarea
                  value={newIssueDescription}
                  onChange={(e) => setNewIssueDescription(e.target.value)}
                  placeholder="Describe the work performed..."
                  rows={4}
                />
              </label>

              <label>
                Project: *
                <select
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  required
                >
                  {userProjects.map(project => (
                    <option key={project.key} value={project.key}>
                      {project.name} ({project.key})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Issue Type:
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
                Status: *
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  required
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
                <small>Selecting a status prevents the issue from going to backlog</small>
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={assignToMe}
                  onChange={(e) => setAssignToMe(e.target.checked)}
                />
                Assign to me (current user)
              </label>

              <div className="time-preview">
                Time to log: <strong>{selectedGroup.total_time_formatted}</strong>
                {selectedGroup.total_seconds < 60 && (
                  <div className="time-warning">
                    Note: Time is under 1 minute. The worklog will be deferred to the next scheduled sync, where it will be aggregated with other time on this issue before logging to Jira.
                  </div>
                )}
              </div>

              <button
                className="submit-button"
                onClick={handleCreateNewIssue}
                disabled={assigning || !newIssueSummary || !selectedProject}
              >
                {assigning ? 'Creating...' : 'Create Issue & Log Time'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AssignmentModal;
