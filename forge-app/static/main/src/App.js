import React, { useEffect, useState } from 'react';
import { invoke, view } from '@forge/bridge';
import IssuePanelApp from './components/issue-panel/IssuePanelApp';
import DqGlanceApp from './components/issue-panel/DqGlanceApp';
import DqActionApp from './components/issue-panel/DqActionApp';
import './App.css';
import './components/common/Sidebar.css';
import './components/modals/Modals.css';
import UnassignedWork from './components/UnassignedWork';
import TimesheetSettings from './shared/components/TimesheetSettings';
import { DashboardTab, TimeAnalyticsTab, TeamAnalyticsTab, OrgAnalyticsTab, ProjectSettingsTab, AdminUserStatusTab, AdminAccuracyDashboardTab } from './components/tabs';
import { SessionReassignModal, WorklogReassignModal, FeedbackModal } from './components/modals';
import { DesktopAppStatusBanner } from './components/common';
import { AppProvider, useApp } from './context';
import { getInitialTab } from './utils';

// Fallback download URL - used only if API doesn't return a URL
// The primary URL comes from the app_releases table via getDesktopAppStatus
const FALLBACK_DOWNLOAD_URL = 'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/TimeTracker.exe';

function AppContent() {
  const { userPermissions, activeIssues, loadActiveIssues } = useApp();

  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // REMOVABLE: AI accuracy dashboard visibility — gated by the
  // accuracy_dashboard_users email allowlist (checked once on mount via the
  // checkAccuracyDashboardAccess resolver). Hide on failure to keep the
  // sidebar clean for users who aren't on the list.
  const [accuracyDashboardAllowed, setAccuracyDashboardAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    invoke('checkAccuracyDashboardAccess')
      .then((res) => { if (!cancelled) setAccuracyDashboardAllowed(!!res?.allowed); })
      .catch(() => { if (!cancelled) setAccuracyDashboardAllowed(false); });
    return () => { cancelled = true; };
  }, []);

  // Session Reassignment State
  const [reassignModalOpen, setReassignModalOpen] = useState(false);
  const [sessionToReassign, setSessionToReassign] = useState(null);
  const [reassigning, setReassigning] = useState(false);

  // Feedback State
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);

  // Worklog Reassignment State
  const [worklogReassignModalOpen, setWorklogReassignModalOpen] = useState(false);
  const [worklogToReassign, setWorklogToReassign] = useState(null);
  const [reassigningWorklog, setReassigningWorklog] = useState(false);
  const [timeAnalyticsRefreshKey, setTimeAnalyticsRefreshKey] = useState(0);

  // Session Reassignment Handlers
  const openReassignModal = (session, fromIssueKey) => {
    setSessionToReassign({ session, fromIssueKey });
    setReassignModalOpen(true);
  };

  const closeReassignModal = () => {
    setReassignModalOpen(false);
    setSessionToReassign(null);
  };

  const handleReassignSession = async (toIssueKey, reason) => {
    if (!sessionToReassign || reassigning) return;

    const { session, fromIssueKey } = sessionToReassign;
    const isPendingApproval =
      session?.approvalStatus === 'pending_approval' &&
      Array.isArray(session?.activityRecordIds) &&
      session.activityRecordIds.length > 0;

    setReassigning(true);
    try {
      // Pending-approval rows live in activity_records and reassign+approve in
      // a single PATCH via reassignAndApproveRecords. Legacy screenshot-based
      // sessions (analysis_results) keep the original reassignSession path.
      const result = isPendingApproval
        ? await invoke('reassignAndApproveRecords', {
            sessionIds: session.activityRecordIds,
            newIssueKey: toIssueKey,
            reason: reason || undefined
          })
        : await invoke('reassignSession', {
            analysisResultIds: session.analysisResultIds,
            fromIssueKey: fromIssueKey,
            toIssueKey: toIssueKey,
            totalSeconds: session.duration
          });

      if (result.success) {
        await loadActiveIssues();
        closeReassignModal();
      } else {
        alert(`Failed to reassign session: ${result.error}`);
      }
    } catch (err) {
      console.error('Error reassigning session:', err);
      alert(`Error reassigning session: ${err.message}`);
    } finally {
      setReassigning(false);
    }
  };

  // Create-new path for the Reassign modal — only available for pending-approval
  // sessions (the only ones routed through createIssueAndApproveRecords).
  const handleCreateAndReassignSession = async (formData) => {
    if (!sessionToReassign || reassigning) return;

    const { session } = sessionToReassign;
    const isPendingApproval =
      session?.approvalStatus === 'pending_approval' &&
      Array.isArray(session?.activityRecordIds) &&
      session.activityRecordIds.length > 0;

    if (!isPendingApproval) {
      alert('Create-new is only available for pending-approval sessions.');
      return;
    }

    setReassigning(true);
    try {
      const result = await invoke('createIssueAndApproveRecords', {
        sessionIds: session.activityRecordIds,
        issueSummary: formData.issueSummary,
        issueDescription: formData.issueDescription,
        projectKey: formData.projectKey,
        issueType: formData.issueType,
        statusName: formData.statusName,
        assignToSelf: formData.assignToSelf,
        reason: formData.reason
      });

      if (result?.success) {
        await loadActiveIssues();
        closeReassignModal();
      } else {
        alert(`Failed to create issue: ${result?.error || 'unknown error'}`);
      }
    } catch (err) {
      console.error('Error creating issue and reassigning:', err);
      alert(`Error creating issue: ${err.message}`);
    } finally {
      setReassigning(false);
    }
  };

  // Worklog Reassignment Handlers
  const openWorklogReassignModal = (worklogInfo) => {
    setWorklogToReassign(worklogInfo);
    setWorklogReassignModalOpen(true);
  };

  const closeWorklogReassignModal = () => {
    setWorklogReassignModalOpen(false);
    setWorklogToReassign(null);
  };

  const handleReassignWorklog = async (toIssueKey, splitSeconds) => {
    if (!worklogToReassign || reassigningWorklog) return;

    setReassigningWorklog(true);
    try {
      const result = await invoke('splitWorklog', {
        fromIssueKey: worklogToReassign.fromIssueKey,
        toIssueKey: toIssueKey,
        splitSeconds: splitSeconds
      });

      if (result.success) {
        await loadActiveIssues();
        setTimeAnalyticsRefreshKey(k => k + 1);
        closeWorklogReassignModal();
      } else {
        alert(`Failed to split worklog: ${result.error}`);
      }
    } catch (err) {
      console.error('Error splitting worklog:', err);
      alert(`Error splitting worklog: ${err.message}`);
    } finally {
      setReassigningWorklog(false);
    }
  };

  // Feedback Handlers
  const openFeedbackModal = () => setFeedbackModalOpen(true);
  const closeFeedbackModal = () => setFeedbackModalOpen(false);

  return (
    <div className="App">
      <div className="App-layout">
        <aside className={`App-sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
          <div className="sidebar-header">
            <button
              className={`sidebar-toggle ${sidebarOpen ? 'open' : ''}`}
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {sidebarOpen ? (
                  <polyline points="15 18 9 12 15 6"></polyline>
                ) : (
                  <polyline points="9 18 15 12 9 6"></polyline>
                )}
              </svg>
            </button>
            {/* {sidebarOpen && (
              <h3 className="sidebar-title">Time Tracker</h3>
            )} */}
          </div>
          <nav className="sidebar-nav">
            <button
              className={`sidebar-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
              title="My Focus"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
              </span>
              {sidebarOpen && <span className="sidebar-label">My Focus</span>}
            </button>
            <button
              className={`sidebar-item ${activeTab === 'time-analytics' ? 'active' : ''}`}
              onClick={() => setActiveTab('time-analytics')}
              title="Time Analytics"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"></line>
                  <line x1="12" y1="20" x2="12" y2="4"></line>
                  <line x1="6" y1="20" x2="6" y2="14"></line>
                </svg>
              </span>
              {sidebarOpen && <span className="sidebar-label">Time Analytics</span>}
            </button>
            {/* <button
              className={`sidebar-item ${activeTab === 'unassigned-work' ? 'active' : ''}`}
              onClick={() => setActiveTab('unassigned-work')}
              title="Unassigned Work"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </span>
              {sidebarOpen && <span className="sidebar-label">Unassigned Work</span>}
            </button> */}
            {(userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && (
              <button
                className={`sidebar-item ${activeTab === 'team-analytics' ? 'active' : ''}`}
                onClick={() => setActiveTab('team-analytics')}
                title="Team Analytics"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">Team Analytics</span>}
              </button>
            )}
            {/* {userPermissions.isJiraAdmin && (
              <button
                className={`sidebar-item ${activeTab === 'org-analytics' ? 'active' : ''}`}
                onClick={() => setActiveTab('org-analytics')}
                title="Organization Analytics"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="2" width="16" height="20"></rect>
                  <path d="M9 22v-4h6v4"></path>
                  <line x1="8" y1="6" x2="8.01" y2="6"></line>
                  <line x1="16" y1="6" x2="16.01" y2="6"></line>
                  <line x1="12" y1="6" x2="12.01" y2="6"></line>
                  <line x1="8" y1="10" x2="8.01" y2="10"></line>
                  <line x1="16" y1="10" x2="16.01" y2="10"></line>
                  <line x1="12" y1="10" x2="12.01" y2="10"></line>
                  <line x1="8" y1="14" x2="8.01" y2="14"></line>
                  <line x1="16" y1="14" x2="16.01" y2="14"></line>
                  <line x1="12" y1="14" x2="12.01" y2="14"></line>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">Organization Analytics</span>}
              </button>
            )} */}
            {(userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && (
              <button
                className={`sidebar-item ${activeTab === 'project-settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('project-settings')}
                title="Project Settings"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7L12 12L22 7L12 2Z"></path>
                    <path d="M2 17L12 22L22 17"></path>
                    <path d="M2 12L12 17L22 12"></path>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">Project Settings</span>}
              </button>
            )}
            {userPermissions.isJiraAdmin && (
              <button
                className={`sidebar-item ${activeTab === 'timesheet-settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('timesheet-settings')}
                title="Timesheet Settings"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">Timesheet Settings</span>}
              </button>
            )}
            {userPermissions.isJiraAdmin && (
              <button
                className={`sidebar-item ${activeTab === 'admin-user-status' ? 'active' : ''}`}
                onClick={() => setActiveTab('admin-user-status')}
                title="User Status"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                    <circle cx="9" cy="7" r="4"></circle>
                    <polyline points="22 11 16 17 13 14"></polyline>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">User Status</span>}
              </button>
            )}
            {accuracyDashboardAllowed && (
              <button
                className={`sidebar-item ${activeTab === 'admin-accuracy-dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('admin-accuracy-dashboard')}
                title="AI Accuracy Dashboard"
              >
                <span className="sidebar-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3v18h18"></path>
                    <path d="M7 14l4-4 4 4 5-5"></path>
                  </svg>
                </span>
                {sidebarOpen && <span className="sidebar-label">AI Accuracy</span>}
              </button>
            )}
            <div className="sidebar-spacer"></div>
            <button
              className="sidebar-item sidebar-feedback"
              onClick={openFeedbackModal}
              title="Send Feedback"
            >
              <span className="sidebar-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </span>
              {sidebarOpen && <span className="sidebar-label">Send Feedback</span>}
            </button>
          </nav>
        </aside>

        <main className="App-content">
          <DesktopAppStatusBanner downloadUrl={FALLBACK_DOWNLOAD_URL} />
          {activeTab === 'dashboard' && (
            <DashboardTab
              onOpenReassignModal={openReassignModal}
            />
          )}
          {activeTab === 'time-analytics' && <TimeAnalyticsTab onOpenWorklogReassignModal={openWorklogReassignModal} refreshKey={timeAnalyticsRefreshKey} />}
          {activeTab === 'team-analytics' && (userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && <TeamAnalyticsTab />}
          {activeTab === 'org-analytics' && <OrgAnalyticsTab />}
          {activeTab === 'unassigned-work' && <UnassignedWork />}
          {activeTab === 'project-settings' && (userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && (
            <ProjectSettingsTab />
          )}
          {activeTab === 'timesheet-settings' && userPermissions.isJiraAdmin && (
            <TimesheetSettings />
          )}
          {activeTab === 'admin-user-status' && userPermissions.isJiraAdmin && (
            <AdminUserStatusTab />
          )}
          {activeTab === 'admin-accuracy-dashboard' && accuracyDashboardAllowed && (
            <AdminAccuracyDashboardTab />
          )}
        </main>
      </div>

      <SessionReassignModal
        isOpen={reassignModalOpen}
        sessionToReassign={sessionToReassign}
        activeIssues={activeIssues}
        reassigning={reassigning}
        onClose={closeReassignModal}
        onReassign={handleReassignSession}
        onCreateAndReassign={handleCreateAndReassignSession}
      />

      <WorklogReassignModal
        isOpen={worklogReassignModalOpen}
        worklogToReassign={worklogToReassign}
        activeIssues={activeIssues}
        reassigning={reassigningWorklog}
        onClose={closeWorklogReassignModal}
        onReassign={handleReassignWorklog}
      />

      <FeedbackModal
        isOpen={feedbackModalOpen}
        onClose={closeFeedbackModal}
      />
    </div>
  );
}

function App() {
  const [surface, setSurface] = useState({ ready: false, issueKey: null, extensionType: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await view.getContext();
        const issueKey = ctx?.extension?.issue?.key || null;
        // The extension.type field identifies which Forge module is rendering:
        //   'jira:issuePanel'  → IssuePanelApp  (existing)
        //   'jira:issueGlance' → DqGlanceApp    (new)
        //   'jira:issueAction' → DqActionApp    (new)
        //   undefined          → AppContent (project page / admin page)
        const extensionType = ctx?.extension?.type || null;
        if (!cancelled) setSurface({ ready: true, issueKey, extensionType });
      } catch {
        if (!cancelled) setSurface({ ready: true, issueKey: null, extensionType: null });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!surface.ready) return null;

  // ── jira:issueGlance — DQ score chip in the right sidebar ──
  if (surface.extensionType === 'jira:issueGlance') {
    return <DqGlanceApp issueKey={surface.issueKey} />;
  }

  // ── jira:issueAction — "Check Description Quality" ··· menu entry ──
  if (surface.extensionType === 'jira:issueAction') {
    return <DqActionApp issueKey={surface.issueKey} />;
  }

  // ── jira:issuePanel — existing Time Analytics + DQ panel ──
  if (surface.issueKey) {
    return <IssuePanelApp issueKey={surface.issueKey} />;
  }

  // ── jira:projectPage / jira:adminPage — full sidebar app ──
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
