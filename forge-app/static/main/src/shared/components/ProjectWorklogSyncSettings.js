import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';

/**
 * ProjectWorklogSyncSettings Component
 * Allows project admins to enable/disable worklog sync for their project
 */
function ProjectWorklogSyncSettings({ projectKey, projectName }) {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [settingsSource, setSettingsSource] = useState('organization');

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  const loadSettings = async () => {
    if (!projectKey) return;
    setLoading(true);
    try {
      const result = await invoke('getTrackingSettings', { projectKey });
      if (result.success && result.settings) {
        setEnabled(result.settings.jiraWorklogSyncEnabled ?? true);
        setSettingsSource(result.settings.settingsSource || 'organization');
      }
    } catch (err) {
      console.error('Failed to load worklog sync settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async () => {
    setSaving(true);
    setMessage({ type: '', text: '' });
    const newValue = !enabled;

    try {
      // We need to get current settings first to preserve other values
      const currentResult = await invoke('getTrackingSettings', { projectKey });
      const currentSettings = currentResult.success ? currentResult.settings : {};

      const result = await invoke('saveTrackingSettings', {
        settings: {
          ...currentSettings,
          jiraWorklogSyncEnabled: newValue
        },
        projectKey
      });

      if (result.success) {
        setEnabled(newValue);
        setSettingsSource('project');
        setMessage({
          type: 'success',
          text: `Worklog sync ${newValue ? 'enabled' : 'disabled'} for ${projectKey}`
        });
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to save setting' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setMessage({ type: '', text: '' });
    try {
      const result = await invoke('triggerWorklogSync');
      if (result.success) {
        const synced = result.synced || 0;
        const errors = result.errors || 0;
        setMessage({ type: 'success', text: `Sync completed! Synced: ${synced}, Errors: ${errors}` });
      } else {
        setMessage({ type: 'error', text: result.error || 'Sync failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Sync failed: ' + err.message });
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="project-worklog-sync-settings" style={styles.container}>
        <div style={styles.loadingText}>Loading worklog sync settings...</div>
      </div>
    );
  }

  return (
    <div className="project-worklog-sync-settings" style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={styles.icon}>
            <path d="M23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12Z" stroke="#0052CC" strokeWidth="2"/>
            <path d="M12 6V12L16 14" stroke="#0052CC" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div>
            <h3 style={styles.title}>Jira Worklog Sync</h3>
            <p style={styles.subtitle}>Auto-sync tracked time to Jira worklogs for {projectName}</p>
          </div>
        </div>
        <label style={styles.toggleContainer}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={handleToggle}
            disabled={saving}
            style={styles.checkbox}
          />
          <span style={{
            ...styles.toggleSlider,
            backgroundColor: enabled ? '#36B37E' : '#DFE1E6'
          }}>
            <span style={{
              ...styles.toggleKnob,
              transform: enabled ? 'translateX(20px)' : 'translateX(0)'
            }} />
          </span>
          <span style={{
            ...styles.toggleLabel,
            color: enabled ? '#36B37E' : '#6B778C'
          }}>
            {saving ? 'Saving...' : (enabled ? 'Enabled' : 'Disabled')}
          </span>
        </label>
      </div>

      <div style={styles.content}>
        <p style={styles.description}>
          When enabled, tracked time from the desktop app is automatically pushed to Jira's
          "Time Spent" field as worklogs for issues in <strong>{projectKey}</strong>.
        </p>
        
        {settingsSource === 'organization' && !enabled && (
          <p style={styles.inheritHint}>
            ⚠️ This project inherits the organization default setting. Toggle to override.
          </p>
        )}
        
        {settingsSource === 'project' && (
          <p style={styles.projectHint}>
            ✓ Project-specific setting active
          </p>
        )}

        {enabled && (
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            style={{
              ...styles.syncButton,
              opacity: syncing ? 0.7 : 1,
              cursor: syncing ? 'not-allowed' : 'pointer'
            }}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}
      </div>

      {message.text && (
        <div style={{
          ...styles.message,
          backgroundColor: message.type === 'success' ? '#E3FCEF' : '#FFEBE6',
          color: message.type === 'success' ? '#006644' : '#BF2600'
        }}>
          {message.text}
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: '8px',
    border: '1px solid #DFE1E6',
    marginTop: '16px',
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #F4F5F7',
    backgroundColor: '#FAFBFC'
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  },
  icon: {
    flexShrink: 0
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: '#172B4D'
  },
  subtitle: {
    margin: '4px 0 0 0',
    fontSize: '12px',
    color: '#6B778C'
  },
  toggleContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer'
  },
  checkbox: {
    display: 'none'
  },
  toggleSlider: {
    position: 'relative',
    width: '44px',
    height: '24px',
    borderRadius: '12px',
    transition: 'background-color 0.2s ease'
  },
  toggleKnob: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    backgroundColor: '#FFFFFF',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    transition: 'transform 0.2s ease'
  },
  toggleLabel: {
    fontSize: '14px',
    fontWeight: 500,
    minWidth: '60px'
  },
  content: {
    padding: '16px 20px'
  },
  description: {
    margin: 0,
    fontSize: '14px',
    color: '#42526E',
    lineHeight: 1.5
  },
  inheritHint: {
    margin: '12px 0 0 0',
    fontSize: '13px',
    color: '#FF991F',
    padding: '8px 12px',
    backgroundColor: '#FFFAE6',
    borderRadius: '4px'
  },
  projectHint: {
    margin: '12px 0 0 0',
    fontSize: '13px',
    color: '#36B37E',
    fontWeight: 500
  },
  syncButton: {
    marginTop: '16px',
    padding: '8px 16px',
    backgroundColor: '#0052CC',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '4px',
    fontSize: '14px',
    fontWeight: 500,
    transition: 'background-color 0.2s ease'
  },
  message: {
    padding: '12px 20px',
    fontSize: '14px',
    borderTop: '1px solid #F4F5F7'
  },
  loadingText: {
    padding: '20px',
    textAlign: 'center',
    color: '#6B778C'
  }
};

export default ProjectWorklogSyncSettings;
