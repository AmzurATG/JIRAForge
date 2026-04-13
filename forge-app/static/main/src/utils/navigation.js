/**
 * Navigation utility functions for Jira integration
 */

import { router } from '@forge/bridge';

/**
 * Navigate to a Jira issue (works within Forge iframe)
 * Uses @forge/bridge router for proper navigation within Jira
 * @param {string} issueKey - The Jira issue key (e.g., "PROJ-123")
 */
export const navigateToIssue = (issueKey) => {
  try {
    // Use Forge router.navigate for in-app navigation
    router.navigate(`/browse/${issueKey}`);
  } catch (e) {
    console.warn('Navigation failed:', e);
    // Fallback to router.open if navigate fails
    try {
      router.open(`/browse/${issueKey}`);
    } catch (e2) {
      console.error('Could not navigate to issue:', e2);
    }
  }
};

/**
 * Get the initial tab from URL hash
 * @returns {string} The initial tab name
 */
export const getInitialTab = () => {
  try {
    const hash = window.location.hash.replace('#', '');
    const validTabs = ['dashboard', 'analytics', 'unassigned-work', 'org-analytics', 'timesheet-settings', 'admin-user-status'];
    if (hash && validTabs.includes(hash)) {
      return hash;
    }
  } catch (e) {
    // Ignore errors in Forge iframe context
  }
  return 'dashboard';
};