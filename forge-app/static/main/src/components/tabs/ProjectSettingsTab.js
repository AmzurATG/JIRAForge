import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import ProjectStatusSettings from '../../shared/components/ProjectStatusSettings';
import '../../shared/components/ProjectStatusSettings.css';
import AppClassificationSettings from '../../shared/components/AppClassificationSettings';
import ProjectWorklogSyncSettings from '../../shared/components/ProjectWorklogSyncSettings';
import './ProjectSettingsTab.css';

/**
 * ProjectSettingsTab Component
 * A dedicated tab for project admins to configure project-level settings
 * including tracked statuses for time tracking.
 */
function ProjectSettingsTab() {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [allProjectSettings, setAllProjectSettings] = useState([]);

  useEffect(() => {
    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadInitialData = async () => {
    setLoading(true);
    try {
      // Check permissions and get admin projects
      const permResult = await invoke('getUserPermissions');
      if (permResult.success) {
        // Jira Admins or Project Admins can access this tab
        const isJiraAdmin = permResult.permissions.isJiraAdmin;
        const hasProjectAdmin = permResult.permissions.projectAdminProjects?.length > 0;
        const hasAccess = isJiraAdmin || hasProjectAdmin;
        setIsAdmin(hasAccess);

        if (hasAccess) {
          // Server-side filtering: getJiraProjects already returns only
          // projects the user can administer (all for Jira admins, verified
          // admin projects for project admins).
          await loadProjects();
        }
      }

      // Load existing project settings
      await loadAllProjectSettings();
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadProjects = async () => {
    try {
      const result = await invoke('getJiraProjects');
      if (result.success && result.projects) {
        setProjects(result.projects);
        if (result.projects.length > 0 && !selectedProject) {
          setSelectedProject(result.projects[0]);
        }
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  };

  const loadAllProjectSettings = async () => {
    try {
      const result = await invoke('getAllProjectSettings');
      if (result.success && result.projectSettings) {
        setAllProjectSettings(result.projectSettings);
      }
    } catch (err) {
      console.error('Failed to load project settings:', err);
    }
  };

  const handleProjectSelect = (project) => {
    setSelectedProject(project);
  };

  const handleSettingsSaved = async () => {
    // Refresh project settings list after save
    await loadAllProjectSettings();
  };

  const getProjectSettingsStatus = (projectKey) => {
    const settings = allProjectSettings.find(s => s.projectKey === projectKey);
    return settings ? settings.trackedStatuses : null;
  };

  if (loading) {
    return (
      <div className="project-settings-tab loading">
        <div className="loading-spinner"></div>
        <p>Loading project settings...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="project-settings-tab">
        <div className="access-denied">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="#DE350B" strokeWidth="2"/>
            <path d="M15 9L9 15" stroke="#DE350B" strokeWidth="2" strokeLinecap="round"/>
            <path d="M9 9L15 15" stroke="#DE350B" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <h2>Access Denied</h2>
          <p>Only Jira Administrators or Project Administrators can access project settings.</p>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="project-settings-tab">
        <div className="no-projects">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 3L21 21" stroke="#6B778C" strokeWidth="2" strokeLinecap="round"/>
            <path d="M10.584 10.587C10.2087 10.962 9.99782 11.4708 9.99756 12.0013C9.9973 12.5318 10.2077 13.0408 10.5826 13.4161C10.9576 13.7914 11.4662 14.0026 11.9967 14.0029C12.5272 14.0032 13.036 13.7925 13.4116 13.4176" stroke="#6B778C" strokeWidth="2" strokeLinecap="round"/>
            <path d="M17.357 17.349C15.726 18.449 13.942 19 12 19C8.2 19 4.8 16.6 2 12C3.2 10 4.6 8.4 6.2 7.2M9.879 5.519C10.579 5.2 11.279 5 12 5C15.8 5 19.2 7.4 22 12C21.321 13.1 20.611 14.069 19.879 14.899" stroke="#6B778C" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <h2>No Projects Found</h2>
          <p>You don't have admin access to any projects.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="project-settings-tab">
      <div className="tab-header">
        <h1>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Project Settings
        </h1>
        <p className="tab-subtitle">
          Configure time tracking settings for your projects
        </p>
      </div>

      <div className="tab-content">
        {/* Project List Sidebar */}
        <div className="project-list-panel">
          <div className="panel-header">
            <h3>Your Projects</h3>
            <span className="project-count">{projects.length}</span>
          </div>
          <div className="project-list">
            {projects.map(project => {
              const configuredStatuses = getProjectSettingsStatus(project.key);
              const isConfigured = configuredStatuses !== null;
              const isSelected = selectedProject?.key === project.key;
              
              return (
                <button
                  key={project.key}
                  className={`project-item ${isSelected ? 'selected' : ''} ${isConfigured ? 'configured' : ''}`}
                  onClick={() => handleProjectSelect(project)}
                >
                  <div className="project-info">
                    <span className="project-key">{project.key}</span>
                    <span className="project-name">{project.name}</span>
                  </div>
                  <div className="project-status">
                    {isConfigured ? (
                      <span className="status-badge configured" title={`Tracking: ${configuredStatuses.join(', ')}`}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        Configured
                      </span>
                    ) : (
                      <span className="status-badge default" title="Using default: In Progress">
                        Default
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Settings Panel */}
        <div className="settings-panel">
          {selectedProject ? (
            <>
              <ProjectStatusSettings
                projectKey={selectedProject.key}
                projectName={selectedProject.name}
                onSave={handleSettingsSaved}
              />
              <AppClassificationSettings projectKey={selectedProject.key} />
              <ProjectWorklogSyncSettings 
                projectKey={selectedProject.key}
                projectName={selectedProject.name}
              />
            </>
          ) : (
            <div className="no-selection">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M15 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9" stroke="#6B778C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 12H12.01" stroke="#6B778C" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              <p>Select a project from the list to configure its settings</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProjectSettingsTab;