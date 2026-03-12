import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import { AssignmentModal, BulkEditModal, GroupAccordion } from './unassigned';
import { AiDisclaimer } from './common/AiDisclaimer';
import { formatTime } from '../utils';
import './UnassignedWork.css';

function UnassignedWork() {
  const [sessions, setSessions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userIssues, setUserIssues] = useState([]);
  const [userProjects, setUserProjects] = useState([]);

  // Pagination state for lazy loading
  const [hasMoreGroups, setHasMoreGroups] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalGroups, setTotalGroups] = useState(0);
  const GROUPS_PER_PAGE = 10;

  // Modal states
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);

  // Notification settings state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [savingNotificationSettings, setSavingNotificationSettings] = useState(false);

  useEffect(() => {
    loadUnassignedWork();
    loadUserIssues();
    loadUserProjects();
    loadNotificationSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadNotificationSettings = async () => {
    try {
      const result = await invoke('getUnassignedNotificationSettings');
      if (result.success && result.settings) {
        setNotificationsEnabled(result.settings.unassignedWorkNotificationsEnabled ?? true);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error loading notification settings:', err);
    }
  };

  const handleToggleNotifications = async () => {
    const newValue = !notificationsEnabled;
    setSavingNotificationSettings(true);

    try {
      const result = await invoke('saveUnassignedNotificationSettings', {
        settings: {
          unassignedWorkNotificationsEnabled: newValue
        }
      });

      if (result.success) {
        setNotificationsEnabled(newValue);
      }
    } catch (err) {
      console.error('[UnassignedWork] Error saving notification settings:', err);
    } finally {
      setSavingNotificationSettings(false);
    }
  };

  const loadUnassignedWork = async (append = false, retryCount = 0) => {
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 3000;

    if (!append) {
      setLoading(true);
    }

    try {
      const offset = append ? nextOffset : 0;
      const groupsResult = await invoke('getUnassignedGroups', {
        limit: GROUPS_PER_PAGE,
        offset
      });

      if (groupsResult.success) {
        const newGroups = groupsResult.groups || [];

        if (append) {
          setGroups(prev => [...prev, ...newGroups]);
        } else {
          setGroups(newGroups);
        }

        setHasMoreGroups(groupsResult.has_more || false);
        setNextOffset(groupsResult.next_offset || 0);
        setTotalGroups(groupsResult.total_groups || 0);

        if (!append) {
          const sessionsResult = await invoke('getUnassignedWork', { limit: 100 });
          if (sessionsResult.success) {
            setSessions(sessionsResult.sessions || []);
          }
        }

        setLoading(false);
        setLoadingMore(false);
      } else if (!append && retryCount < MAX_RETRIES) {
        console.warn(`[UnassignedWork] Attempt ${retryCount + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`, groupsResult.error);
        setTimeout(() => loadUnassignedWork(false, retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[UnassignedWork] Load failed:', groupsResult.error);
        setLoading(false);
        setLoadingMore(false);
      }
    } catch (err) {
      if (!append && retryCount < MAX_RETRIES) {
        console.warn(`[UnassignedWork] Attempt ${retryCount + 1} threw, retrying in ${RETRY_DELAY_MS}ms...`, err);
        setTimeout(() => loadUnassignedWork(false, retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[UnassignedWork] Load error:', err);
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const loadMoreGroups = async () => {
    if (loadingMore || !hasMoreGroups) return;
    setLoadingMore(true);
    await loadUnassignedWork(true);
  };

  const loadUserIssues = async () => {
    try {
      const result = await invoke('getAllUserAssignedIssues');
      if (result.success) {
        setUserIssues(result.issues || []);
      }
    } catch (err) {
      console.error('Error loading user issues:', err);
    }
  };

  const loadUserProjects = async () => {
    try {
      const result = await invoke('getUserProjects');
      if (result.success) {
        setUserProjects(result.projects || []);
      }
    } catch (err) {
      console.error('Error loading user projects:', err);
    }
  };

  // Assignment handlers
  const handleAssignClick = (groupWithDetails) => {
    setSelectedGroup(groupWithDetails);
    setShowAssignModal(true);
  };

  const handleAssignmentComplete = () => {
    setSelectedGroup(null);
    loadUnassignedWork();
  };

  // Bulk edit handlers
  const handleBulkEditSuccess = () => {
    loadUnassignedWork();
  };

  // Summary calculations
  const getTotalTime = () => {
    return groups.reduce((sum, g) => sum + (g.total_seconds || 0), 0);
  };

  const getTotalSessions = () => {
    return groups.reduce((sum, g) => sum + (g.session_count || 0), 0);
  };

  if (loading) {
    return <div className="unassigned-work-container"><div className="loading">Loading unassigned work...</div></div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="unassigned-work-container">
        <h2>Unassigned Work</h2>
        <div className="empty-state">
          <p>Great job! You don't have any unassigned work sessions.</p>
          <p className="empty-subtitle">All your work time has been assigned to Jira issues.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="unassigned-work-container">
      <div className="unassigned-work-header">
        <div className="header-top-row">
          <h2>Unassigned Work</h2>
          <div className="header-buttons-row">
            <button
              className="bulk-time-edit-btn"
              onClick={() => setShowBulkEditModal(true)}
              title="Bulk reassign activities by time interval"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              Bulk Time Edit
            </button>
          </div>
        </div>
        <div className="unassigned-work-summary">
          <span className="summary-item">
            <strong>{getTotalSessions()}</strong> sessions
          </span>
          <span className="summary-divider">•</span>
          <span className="summary-item">
            <strong>{groups.length}</strong> groups
          </span>
          <span className="summary-divider">•</span>
          <span className="summary-item">
            <strong>{formatTime(getTotalTime())}</strong> total time
          </span>
        </div>
      </div>

      {groups.length > 0 && (
        <AiDisclaimer 
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          savingNotificationSettings={savingNotificationSettings}
        />
      )}

      {groups.length === 0 && sessions.length > 0 && (
        <div className="no-groups-message">
          <p>No groups available yet.</p>
          <p>Groups are created automatically when work sessions are analyzed.</p>
          <p>Check back shortly.</p>
        </div>
      )}

      <GroupAccordion
        groups={groups}
        hasMoreGroups={hasMoreGroups}
        totalGroups={totalGroups}
        loadingMore={loadingMore}
        onLoadMore={loadMoreGroups}
        onAssignClick={handleAssignClick}
      />

      {/* Assignment Modal */}
      <AssignmentModal
        isOpen={showAssignModal}
        selectedGroup={selectedGroup}
        userIssues={userIssues}
        userProjects={userProjects}
        onClose={() => setShowAssignModal(false)}
        onAssignmentComplete={handleAssignmentComplete}
      />

      {/* Bulk Time Edit Modal */}
      <BulkEditModal
        isOpen={showBulkEditModal}
        userIssues={userIssues}
        onClose={() => setShowBulkEditModal(false)}
        onSuccess={handleBulkEditSuccess}
      />
    </div>
  );
}

export default UnassignedWork;
