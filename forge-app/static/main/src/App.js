import React, { useState } from 'react';
import { invoke } from '@forge/bridge';
import './App.css';
import './components/common/Sidebar.css';
import './components/modals/Modals.css';
import UnassignedWork from './components/UnassignedWork';
import TimesheetSettings from './shared/components/TimesheetSettings';
import { DashboardTab, TimeAnalyticsTab, TeamAnalyticsTab, OrgAnalyticsTab, ScreenshotsTab, BRDUploadTab, ProjectSettingsTab } from './components/tabs';
import { SessionReassignModal, ScreenshotPreviewModal, FullscreenViewer, FeedbackModal } from './components/modals';
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

  // Session Reassignment State
  const [reassignModalOpen, setReassignModalOpen] = useState(false);
  const [sessionToReassign, setSessionToReassign] = useState(null);
  const [reassigning, setReassigning] = useState(false);

  // Feedback State
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);

  // Screenshot Preview State
  const [screenshotPreviewOpen, setScreenshotPreviewOpen] = useState(false);
  const [previewSession, setPreviewSession] = useState(null);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  const [previewScreenshots, setPreviewScreenshots] = useState([]);
  const [loadingScreenshots, setLoadingScreenshots] = useState(false);
  const [expandedScreenshot, setExpandedScreenshot] = useState(false);

  // Session Reassignment Handlers
  const openReassignModal = (session, fromIssueKey) => {
    setSessionToReassign({ session, fromIssueKey });
    setReassignModalOpen(true);
  };

  const closeReassignModal = () => {
    setReassignModalOpen(false);
    setSessionToReassign(null);
  };

  const handleReassignSession = async (toIssueKey) => {
    if (!sessionToReassign || reassigning) return;

    setReassigning(true);
    try {
      const result = await invoke('reassignSession', {
        analysisResultIds: sessionToReassign.session.analysisResultIds,
        fromIssueKey: sessionToReassign.fromIssueKey,
        toIssueKey: toIssueKey,
        totalSeconds: sessionToReassign.session.duration
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

  // Screenshot Preview Handlers
  const openScreenshotPreview = async (session, issueKey) => {
    setPreviewSession({ session, issueKey });
    setPreviewImageIndex(0);
    setScreenshotPreviewOpen(true);
    setLoadingScreenshots(true);
    setPreviewScreenshots([]);

    try {
      const result = await invoke('getSessionScreenshots', {
        analysisResultIds: session.analysisResultIds
      });

      if (result.success && result.screenshots) {
        setPreviewScreenshots(result.screenshots);
      } else {
        console.error('Failed to load screenshots:', result.error);
      }
    } catch (err) {
      console.error('Error loading screenshots:', err);
    } finally {
      setLoadingScreenshots(false);
    }
  };

  const closeScreenshotPreview = () => {
    setScreenshotPreviewOpen(false);
    setPreviewSession(null);
    setPreviewImageIndex(0);
    setPreviewScreenshots([]);
    setExpandedScreenshot(false);
  };

  const toggleExpandedScreenshot = () => {
    setExpandedScreenshot(!expandedScreenshot);
  };

  // Feedback Handlers
  const openFeedbackModal = () => setFeedbackModalOpen(true);
  const closeFeedbackModal = () => setFeedbackModalOpen(false);

  const nextPreviewImage = () => {
    if (previewScreenshots.length > 0) {
      setPreviewImageIndex((prev) =>
        prev < previewScreenshots.length - 1 ? prev + 1 : 0
      );
    }
  };

  const prevPreviewImage = () => {
    if (previewScreenshots.length > 0) {
      setPreviewImageIndex((prev) =>
        prev > 0 ? prev - 1 : previewScreenshots.length - 1
      );
    }
  };

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
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
            </button>
            {sidebarOpen && (
              <h3 className="sidebar-title">Time Tracker</h3>
            )}
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
            <button
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
            </button>
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
              onOpenScreenshotPreview={openScreenshotPreview}
              onOpenReassignModal={openReassignModal}
            />
          )}
          {activeTab === 'time-analytics' && <TimeAnalyticsTab />}
          {activeTab === 'screenshots' && <ScreenshotsTab />}
          {activeTab === 'team-analytics' && (userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && <TeamAnalyticsTab />}
          {activeTab === 'org-analytics' && <OrgAnalyticsTab />}
          {activeTab === 'brd-upload' && <BRDUploadTab />}
          {activeTab === 'unassigned-work' && <UnassignedWork />}
          {activeTab === 'project-settings' && (userPermissions.isJiraAdmin || userPermissions.projectAdminProjects?.length > 0) && (
            <ProjectSettingsTab />
          )}
          {activeTab === 'timesheet-settings' && userPermissions.isJiraAdmin && (
            <TimesheetSettings />
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
      />

      <ScreenshotPreviewModal
        isOpen={screenshotPreviewOpen}
        previewSession={previewSession}
        previewScreenshots={previewScreenshots}
        previewImageIndex={previewImageIndex}
        loadingScreenshots={loadingScreenshots}
        onClose={closeScreenshotPreview}
        onPrev={prevPreviewImage}
        onNext={nextPreviewImage}
        onExpand={toggleExpandedScreenshot}
      />

      <FullscreenViewer
        isOpen={expandedScreenshot}
        screenshots={previewScreenshots}
        currentIndex={previewImageIndex}
        onClose={toggleExpandedScreenshot}
        onPrev={prevPreviewImage}
        onNext={nextPreviewImage}
      />

      <FeedbackModal
        isOpen={feedbackModalOpen}
        onClose={closeFeedbackModal}
      />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
