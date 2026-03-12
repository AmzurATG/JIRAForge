import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  // User Permissions State
  const [userPermissions, setUserPermissions] = useState({
    isJiraAdmin: false,
    projectAdminProjects: [],
    allProjectKeys: [],
    canCreateIssues: false,
    canEditIssues: false
  });

  // Active Issues State (for Dashboard)
  const [activeIssues, setActiveIssues] = useState([]);
  const [issuesLoading, setIssuesLoading] = useState(true);

  // Status Update State
  const [statusUpdating, setStatusUpdating] = useState(null);
  const [issueTransitions, setIssueTransitions] = useState({});

  // Team Analytics State
  const [selectedProjectKey, setSelectedProjectKey] = useState('');

  // Load user permissions on mount
  useEffect(() => {
    loadUserPermissions();
  }, []);

  // Sync worklogs for the current user on mount (fire-and-forget, 15-min cooldown).
  // Runs in the user's live Jira session so worklogs appear under their real name.
  useEffect(() => {
    const COOLDOWN_KEY = 'tt_worklog_sync_last_run';
    const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
    try {
      const lastRun = localStorage.getItem(COOLDOWN_KEY);
      const lastRunTs = parseInt(lastRun, 10);
      const cooldownExpired = !Number.isFinite(lastRunTs) || Date.now() - lastRunTs > COOLDOWN_MS;
      if (cooldownExpired) {
        localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        invoke('syncMyWorklogs').catch(err =>
          console.warn('[WorklogSync] Background sync failed:', err)
        );
      }
    } catch (err) {
      console.warn('[WorklogSync] localStorage unavailable, skipping background sync:', err);
    }
  }, []);

  const loadUserPermissions = async () => {
    try {
      const result = await invoke('getUserPermissions');
      if (result.success) {
        setUserPermissions(result.permissions);
        if (result.permissions.isJiraAdmin && result.permissions.allProjectKeys?.length > 0) {
          setSelectedProjectKey(result.permissions.allProjectKeys[0]);
        } else if (result.permissions.projectAdminProjects?.length > 0) {
          setSelectedProjectKey(result.permissions.projectAdminProjects[0]);
        }
      }
    } catch (err) {
      console.error('Failed to load permissions:', err);
    }
  };

  const loadActiveIssues = useCallback(async (retryCount = 0) => {
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 3000;

    setIssuesLoading(true);
    try {
      const result = await invoke('getActiveIssuesWithTime');
      if (result.success) {
        setActiveIssues(result.issues || []);
        setIssuesLoading(false);
      } else if (retryCount < MAX_RETRIES) {
        console.warn(`[loadActiveIssues] Attempt ${retryCount + 1} failed, retrying in ${RETRY_DELAY_MS}ms...`, result.error);
        setTimeout(() => loadActiveIssues(retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[loadActiveIssues] All retries exhausted:', result.error);
        setIssuesLoading(false);
      }
    } catch (err) {
      if (retryCount < MAX_RETRIES) {
        console.warn(`[loadActiveIssues] Attempt ${retryCount + 1} threw, retrying in ${RETRY_DELAY_MS}ms...`, err);
        setTimeout(() => loadActiveIssues(retryCount + 1), RETRY_DELAY_MS);
      } else {
        console.error('[loadActiveIssues] All retries exhausted:', err);
        setIssuesLoading(false);
      }
    }
  }, []);

  const loadTransitionsForIssue = useCallback(async (issueKey) => {
    if (issueTransitions[issueKey]) {
      return issueTransitions[issueKey];
    }
    try {
      const result = await invoke('getIssueTransitions', { issueKey });
      if (result.success) {
        setIssueTransitions(prev => ({ ...prev, [issueKey]: result.transitions }));
        return result.transitions;
      }
    } catch (err) {
      console.error('Failed to load transitions:', err);
    }
    return [];
  }, [issueTransitions]);

  const handleStatusChange = useCallback(async (issueKey, transitionId) => {
    setStatusUpdating(issueKey);
    try {
      const result = await invoke('updateIssueStatus', { issueKey, transitionId });
      if (result.success) {
        await loadActiveIssues();
        setIssueTransitions(prev => {
          const newTransitions = { ...prev };
          delete newTransitions[issueKey];
          return newTransitions;
        });
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setStatusUpdating(null);
    }
  }, [loadActiveIssues]);

  const value = {
    // Permissions
    userPermissions,

    // Active Issues
    activeIssues,
    issuesLoading,
    loadActiveIssues,

    // Status Updates
    statusUpdating,
    handleStatusChange,
    loadTransitionsForIssue,

    // Team Analytics Project Selection
    selectedProjectKey,
    setSelectedProjectKey
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}

export default AppContext;
