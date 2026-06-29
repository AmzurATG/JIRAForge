import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import './App.css';

function App() {
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissionLoading, setPermissionLoading] = useState(true);

  // Non-Jira (Google SSO) email-domain allowlist state
  const [domains, setDomains] = useState([]);
  const [domainInput, setDomainInput] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainError, setDomainError] = useState('');

  useEffect(() => {
    checkPermissions();
  }, []);

  const checkPermissions = async () => {
    setPermissionLoading(true);
    try {
      const result = await invoke('getUserPermissions');
      if (result.success) {
        const jiraAdmin = result.permissions.isJiraAdmin;
        setIsAdmin(jiraAdmin);
        if (jiraAdmin) {
          await loadDomains();
        }
      } else {
        setIsAdmin(false);
      }
    } catch (err) {
      console.error('Failed to check permissions:', err);
      setIsAdmin(false);
    } finally {
      setPermissionLoading(false);
      setLoading(false);
    }
  };

  const loadDomains = async () => {
    try {
      const [list, suggested] = await Promise.all([
        invoke('getEmailDomains'),
        invoke('getSuggestedEmailDomain')
      ]);
      if (list?.success) setDomains(list.domains || []);
      // Pre-fill the input with the admin's own domain if nothing registered yet.
      if (suggested?.success && suggested.domain && (list?.domains || []).length === 0) {
        setDomainInput(suggested.domain);
      }
    } catch (err) {
      console.error('Failed to load email domains:', err);
    }
  };

  const handleAddDomain = async () => {
    setDomainError('');
    const domain = (domainInput || '').trim();
    if (!domain) return;
    setDomainBusy(true);
    try {
      const result = await invoke('addEmailDomain', { domain });
      if (result?.success) {
        setDomainInput('');
        await loadDomains();
      } else {
        setDomainError(result?.error || 'Failed to add domain');
      }
    } catch (err) {
      setDomainError(err.message || 'Failed to add domain');
    } finally {
      setDomainBusy(false);
    }
  };

  const handleRemoveDomain = async (domain) => {
    setDomainError('');
    setDomainBusy(true);
    try {
      const result = await invoke('removeEmailDomain', { domain });
      if (result?.success) {
        await loadDomains();
      } else {
        setDomainError(result?.error || 'Failed to remove domain');
      }
    } catch (err) {
      setDomainError(err.message || 'Failed to remove domain');
    } finally {
      setDomainBusy(false);
    }
  };

  if (permissionLoading || loading) {
    return (
      <div className="App">
        <div className="loading-container">
          <p>Checking permissions...</p>
        </div>
      </div>
    );
  }

  // Check if user is Jira Admin
  if (!isAdmin) {
    return (
      <div className="App">
        <div className="access-denied">
          <h1>Access Denied</h1>
          <p>Only Jira Administrators can access global settings.</p>
          <p className="help-text">Project Administrators can configure Timesheet Settings from the main app.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>Time Tracker - Settings</h1>
        <p className="subtitle">Application Configuration (Administrator Only)</p>
        <div className="admin-badge">Jira Administrator</div>
      </header>

      <main className="settings-content">
        <section className="settings-section info-section">
          <h2>Secure Configuration</h2>
          <p className="section-description">
            Your Time Tracker is pre-configured with secure backend services. All connections
            are managed automatically - no manual configuration is required.
          </p>
          <div className="secure-badge">
            <span className="checkmark">&#10003;</span> Securely Connected
          </div>

          <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#e9f2ff', borderRadius: '4px', border: '1px solid #cce0ff' }}>
            <h3 style={{ marginTop: 0, fontSize: '14px', color: '#0747a6' }}>Advanced Configuration</h3>
            <p style={{ fontSize: '12px', margin: '8px 0' }}>
              The Real-Time Description Scoring feature requires a one-time registration with your Jira workspace to apply to all projects.
            </p>
            <button 
              type="button" 
              onClick={async (e) => {
                e.target.disabled = true;
                e.target.innerText = 'Registering...';
                try {
                  const res = await invoke('registerUim');
                  if (res.success) {
                    e.target.innerText = '✅ Registered Successfully';
                  } else {
                    e.target.innerText = '❌ Failed: ' + res.error;
                  }
                } catch(err) {
                  e.target.innerText = '❌ Error';
                }
              }}
            >
              Enable Real-Time Description Scoring
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h2>Non-Jira Tracking (Google Sign-In)</h2>
          <p className="section-description">
            Let employees <strong>without a Jira account</strong> (e.g. HR, other teams) sign in to
            the desktop app with their company <strong>Google</strong> account and have their time
            tracked. Register your company email domain(s) below — anyone with a verified Google
            account on these domains can sign in and will be tracked under this organization.
          </p>
          <p className="note">
            <strong>Note:</strong> this only works if your company email is on Google Workspace.
            Adding a domain lets <em>any</em> verified account on it self-enroll.
          </p>

          {domainError && <p className="error-text" style={{ color: '#d04437' }}>{domainError}</p>}

          <ul className="domain-list">
            {domains.length === 0 && <li className="note">No domains registered yet.</li>}
            {domains.map((d) => (
              <li key={d} className="domain-item">
                <span>{d}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveDomain(d)}
                  disabled={domainBusy}
                  className="btn-remove"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="domain-add-row">
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="amzur.com"
              disabled={domainBusy}
              aria-label="Company email domain"
            />
            <button type="button" onClick={handleAddDomain} disabled={domainBusy || !domainInput.trim()}>
              {domainBusy ? 'Saving…' : 'Add domain'}
            </button>
          </div>
        </section>

        <section className="settings-section info-section">
          <h2>Tracking Settings</h2>
          <p className="section-description">
            Configure screenshot intervals, application blacklists/whitelists, and other tracking
            preferences from the <strong>Time Tracker</strong> panel in any Jira project.
          </p>
          <p className="note">
            Navigate to any project and open the Time Tracker panel to access tracking settings.
          </p>
        </section>

        <section className="settings-section info-section">
          <h2>Desktop App Installation</h2>
          <p className="section-description">
            To start tracking time, install the desktop application:
          </p>
          <ol>
            <li>Download the desktop app for your platform (Windows/macOS/Linux)</li>
            <li>Install and launch the application</li>
            <li>Sign in with your Atlassian account (or Google, for non-Jira users)</li>
            <li>The app will automatically start capturing screenshots at the configured interval</li>
          </ol>
          <p className="note">
            <strong>Note:</strong> The app is pre-configured to connect to your organization's backend.
            No additional setup is required.
          </p>
        </section>
      </main>
    </div>
  );
}

export default App;
