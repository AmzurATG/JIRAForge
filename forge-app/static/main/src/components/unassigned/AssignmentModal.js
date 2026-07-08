import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import './AssignmentModal.css';

function AssignmentModal({
  isOpen,
  selectedGroup,
  userIssues,
  userProjects,
  onClose,
  onAssignmentComplete,
  onDeleteSelection
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
  const [isIssueDropdownOpen, setIsIssueDropdownOpen] = useState(false);
  const [issueSearchQuery, setIssueSearchQuery] = useState('');

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setIsIssueDropdownOpen(false);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

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

  // Multi-group mode: selectedGroup carries a groupIds array (set by handleAssignSelection).
  // When present, route to the multi-group resolver instead of the single-group one.
  const isMultiGroup = Array.isArray(selectedGroup?.groupIds)
    && (selectedGroup.groupIds.length > 1 || !selectedGroup?.id);

  const handleAssignToExisting = async () => {
    if (!selectedIssueKey) {
      alert('Please select an issue');
      return;
    }

    if (!selectedGroup.session_ids || !Array.isArray(selectedGroup.session_ids) || selectedGroup.session_ids.length === 0) {
      alert('No sessions available in this selection. Please select different items.');
      return;
    }

    setAssigning(true);
    try {
      const result = isMultiGroup
        ? await invoke('assignSelectionToExistingIssue', {
            sessionIds: selectedGroup.session_ids,
            groupIds: selectedGroup.groupIds,
            issueKey: selectedIssueKey,
            totalSeconds: selectedGroup.total_seconds
          })
        : await invoke('assignToExistingIssue', {
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
        if (isMultiGroup && result.partial_groups?.length > 0) {
          message += `\n\n${result.partial_groups.length} group(s) had only some intervals reassigned and remain in the unassigned list.`;
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
      const result = isMultiGroup
        ? await invoke('createIssueAndAssignSelection', {
            sessionIds: selectedGroup.session_ids,
            groupIds: selectedGroup.groupIds,
            issueSummary: newIssueSummary,
            issueDescription: newIssueDescription,
            projectKey: selectedProject,
            issueType: issueType,
            totalSeconds: selectedGroup.total_seconds,
            assignToSelf: assignToMe,
            statusName: selectedStatus
          })
        : await invoke('createIssueAndAssign', {
            sessionIds: selectedGroup.session_ids,
            issueSummary: newIssueSummary,
            issueDescription: newIssueDescription,
            projectKey: selectedProject,
            issueType: issueType,
            totalSeconds: selectedGroup.total_seconds,
            groupId: selectedGroup.id,
            assignToSelf: assignToMe,
            statusName: selectedStatus
          });

      if (result.success) {
        let message = `Successfully created issue ${result.issue_key} and assigned ${result.assigned_count} session(s)`;
        if (result.worklog_skipped) {
          message += `\n\nNote: Worklog was not created because ${result.worklog_skipped_reason}. The issue was created but no time was logged.`;
        }
        if (isMultiGroup && result.partial_groups?.length > 0) {
          message += `\n\n${result.partial_groups.length} group(s) had only some intervals reassigned and remain in the unassigned list.`;
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
    <div className="modal-overlay assignment-overlay" onClick={onClose}>
      <div className="modal-content assignment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isMultiGroup ? `Assign ${selectedGroup.groupIds.length} Selected Work Items` : `Assign "${selectedGroup.label}"`}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {isMultiGroup && (
            <div className="selection-summary-pill">
              <span className="pill-item">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                {selectedGroup.groupIds.length} Group
              </span>
              <span className="pill-item text-purple">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                </svg>
                {selectedGroup.session_count}
              </span>
              <span className="pill-item text-blue bg-blue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                {selectedGroup.total_time_formatted}
              </span>
            </div>
          )}

          <div className="match-tip-banner">
            <div>
              <strong>About your timesheet</strong><br/>
              Our AI matches sessions to Jira issues using their <strong>summary</strong> and <strong>description</strong>. Use clear, descriptive titles in Jira to improve matching accuracy.
            </div>
          </div>

          <div className="assignment-tabs">
            <button 
              className={`tab-button ${assignmentType === 'existing' ? 'active' : ''}`}
              onClick={() => setAssignmentType('existing')}
            >
              Existing Issue
            </button>
            <button 
              className={`tab-button ${assignmentType === 'new' ? 'active' : ''}`}
              onClick={() => setAssignmentType('new')}
            >
              Create New
            </button>
          </div>

          {assignmentType === 'existing' && (
            <div className="existing-issue-form">
              <label>
                Select Jira Issue:
                <div 
                  className="custom-issue-select" 
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsIssueDropdownOpen(!isIssueDropdownOpen);
                  }}
                >
                  <div className="custom-issue-select-value">
                    {selectedIssueKey ? userIssues.find(i => i.key === selectedIssueKey)?.key + ' - ' + userIssues.find(i => i.key === selectedIssueKey)?.summary : '-- Select Issue --'}
                  </div>
                  <div className="custom-issue-select-arrow">▼</div>
                  
                  {isIssueDropdownOpen && (
                    <div className="custom-issue-dropdown" onClick={(e) => e.stopPropagation()}>
                      <div className="custom-issue-search-container">
                        <input 
                          type="text" 
                          className="custom-issue-search-input" 
                          placeholder="Search issues..."
                          value={issueSearchQuery}
                          onChange={(e) => setIssueSearchQuery(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="custom-issue-dropdown-list">
                        {userIssues.filter(issue => 
                          issue.key.toLowerCase().includes(issueSearchQuery.toLowerCase()) || 
                          issue.summary.toLowerCase().includes(issueSearchQuery.toLowerCase())
                        ).map(issue => (
                          <div 
                            key={issue.key} 
                            className="custom-issue-dropdown-item"
                            onClick={() => {
                              setSelectedIssueKey(issue.key);
                              setIsIssueDropdownOpen(false);
                              setIssueSearchQuery('');
                            }}
                          >
                            <strong>{issue.key}</strong> - {issue.summary}
                          </div>
                        ))}
                        {userIssues.filter(issue => 
                          issue.key.toLowerCase().includes(issueSearchQuery.toLowerCase()) || 
                          issue.summary.toLowerCase().includes(issueSearchQuery.toLowerCase())
                        ).length === 0 && (
                          <div className="custom-issue-dropdown-empty">No matching issues found</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
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
                What were you working on?
                <input
                  type="text"
                  className="custom-issue-search-input"
                  style={{marginTop: '6px', fontSize: '14px', padding: '10px'}}
                  value={newIssueSummary}
                  onChange={(e) => setNewIssueSummary(e.target.value)}
                  placeholder="e.g. Code review, standup meeting"
                  required
                />
              </label>

              <label>
                Select project
                <select
                  className="custom-issue-search-input"
                  style={{marginTop: '6px', fontSize: '14px', padding: '10px'}}
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  required
                >
                  <option value="">— Select a project —</option>
                  {userProjects.map(project => (
                    <option key={project.key} value={project.key}>
                      {project.name} ({project.key})
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
