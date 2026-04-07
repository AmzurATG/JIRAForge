# Unassigned Issues Application Grouping - Implementation Plan

## Problem Statement

### Current Issue
Users are experiencing excessive fragmentation of unassigned work sessions, resulting in:
- **40+ unassigned issues** even for 1-2 hours of work
- Multiple records for the SAME application (e.g., Chrome) doing similar tasks
- Example: Working in Chrome for 10 seconds creates one unassigned issue, then working in Chrome again for 30 seconds creates ANOTHER separate unassigned issue
- Poor user experience - overwhelming number of items to review and assign

### Root Cause
1. **Activity Record Creation**: Each screenshot/window switch creates a new `unassigned_activity` record
2. **AI Clustering Issues**: While AI clustering exists, it's creating too many small groups instead of consolidating
3. **Lack of Application-Level Grouping**: No mechanism to aggregate all sessions from the same application
4. **Over-Fragmentation**: The clustering is too granular, treating each minor context change as a separate work group

---

## Current Architecture Analysis

### How Unassigned Work Currently Works

#### 1. Activity Capture (Desktop App)
```
User works on Chrome (Query A) → 10 seconds
  ↓
Activity Record 1 created:
  - window_title: "Chrome - Search Results - Query A"
  - application_name: "chrome.exe"
  - time_spent_seconds: 10

User works on Chrome (Query B) → 30 seconds
  ↓
Activity Record 2 created:
  - window_title: "Chrome - Search Results - Query B"
  - application_name: "chrome.exe"
  - time_spent_seconds: 30
```

#### 2. AI Clustering (ai-server)
```javascript
// clustering-service.js
// Groups sessions by:
// - Application name
// - Window title similarity
// - Activity description
// - OCR extracted text

Result:
  Group 1: "Chrome - Query A Research" (1 session, 10s)
  Group 2: "Chrome - Query B Research" (1 session, 30s)
```

#### 3. Database Structure
```sql
-- unassigned_activity table
-- Stores individual activity records
CREATE TABLE unassigned_activity (
    id UUID,
    window_title TEXT,
    application_name TEXT,
    time_spent_seconds INTEGER,
    timestamp TIMESTAMPTZ,
    ...
);

-- unassigned_work_groups table
-- AI-created clusters
CREATE TABLE unassigned_work_groups (
    id UUID,
    user_id UUID,
    group_label TEXT,           -- e.g., "Chrome - Query A Research"
    group_description TEXT,
    session_count INTEGER,
    total_seconds INTEGER,
    ...
);

-- unassigned_group_members table
-- Links activities to groups (many-to-one)
CREATE TABLE unassigned_group_members (
    id UUID,
    group_id UUID,
    unassigned_activity_id UUID
);
```

#### 4. Frontend Display
```
UnassignedWork.js
  ↓
Loads groups from: getUnassignedGroups()
  ↓
GroupAccordion.js
  ↓
Displays each group separately:
  - Group 1: "Chrome - Query A Research"
  - Group 2: "Chrome - Query B Research"
  - Group 3: "VSCode - Component Edit"
  - Group 4: "Chrome - Documentation"
  - ... (potentially 40+ groups)
```

### Current Assignment Flow
```
User clicks "Assign" on Group 1
  ↓
AssignmentModal opens
  ↓
User selects existing issue OR creates new issue
  ↓
Assigns ONLY that group's sessions
  ↓
Repeat 39 more times for other groups 😢
```

---

## Proposed Solution: Application-Level Grouping with Bulk Assignment

### Overview
Add a **secondary grouping layer** that consolidates all unassigned work by **application** while preserving the existing AI clustering for detailed context.

### Architecture

#### 1. Two-Level Grouping Hierarchy

```
Application Level (Top Level)
  ├─ Chrome.exe (3 groups, 15 sessions, 1h 25m)
  │   ├─ Research - Authentication (5 sessions, 30m)
  │   ├─ Documentation Review (6 sessions, 40m)
  │   └─ Stack Overflow Help (4 sessions, 15m)
  │
  ├─ Code.exe (2 groups, 20 sessions, 2h 10m)
  │   ├─ Session Resolver Bug Fix (12 sessions, 1h 30m)
  │   └─ Test File Updates (8 sessions, 40m)
  │
  └─ Slack.exe (1 group, 3 sessions, 10m)
      └─ Team Communication (3 sessions, 10m)
```

#### 2. New Database View (Virtual Grouping)

**Option A: SQL View (No new tables)**
```sql
-- Create a view that groups by application
CREATE OR REPLACE VIEW unassigned_work_by_application AS
SELECT
    user_id,
    application_name,
    COUNT(DISTINCT g.id) as group_count,
    COUNT(DISTINCT m.unassigned_activity_id) as session_count,
    SUM(g.total_seconds) as total_seconds,
    ARRAY_AGG(DISTINCT g.id) as group_ids,
    MAX(g.created_at) as latest_activity
FROM unassigned_work_groups g
JOIN unassigned_group_members m ON g.id = m.group_id
JOIN unassigned_activity a ON m.unassigned_activity_id = a.id
WHERE g.is_assigned = false 
  AND g.is_dismissed = false
GROUP BY user_id, application_name;
```

**Option B: New Table (Better Performance)**
```sql
-- Store application-level aggregates
CREATE TABLE unassigned_work_by_app (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    organization_id UUID,
    application_name TEXT NOT NULL,
    normalized_app_name TEXT, -- e.g., "chrome" from "chrome.exe"
    group_count INTEGER DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    total_seconds INTEGER DEFAULT 0,
    earliest_activity TIMESTAMPTZ,
    latest_activity TIMESTAMPTZ,
    child_group_ids UUID[], -- Array of group IDs
    is_expanded BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, application_name)
);

-- Update this table when groups are created/updated
```

#### 3. Backend Resolver Changes

**New Resolver: `getUnassignedWorkByApplication`**
```javascript
// forge-app/src/resolvers/unassigned/sessionResolvers.js

/**
 * Get unassigned work grouped by application
 * Returns application-level summary with child groups
 */
export async function getUnassignedWorkByApplication(req) {
  const { config, userId, organization } = await initializeRequestContext(req);
  
  // Query 1: Get application-level aggregates
  const appQuery = `
    SELECT 
      a.application_name,
      COUNT(DISTINCT g.id) as group_count,
      COUNT(DISTINCT m.unassigned_activity_id) as session_count,
      SUM(g.total_seconds) as total_seconds,
      ARRAY_AGG(DISTINCT g.id) as child_group_ids,
      MAX(a.timestamp) as latest_activity
    FROM unassigned_work_groups g
    JOIN unassigned_group_members m ON g.id = m.group_id
    JOIN unassigned_activity a ON m.unassigned_activity_id = a.id
    WHERE g.user_id = ? 
      AND g.is_assigned = false 
      AND g.is_dismissed = false
    GROUP BY a.application_name
    ORDER BY total_seconds DESC
  `;
  
  const appGroups = await supabaseRequest(config, appQuery);
  
  // Transform to include formatted data
  return {
    success: true,
    application_groups: appGroups.map(app => ({
      application_name: app.application_name,
      normalized_name: normalizeAppName(app.application_name),
      display_name: getAppDisplayName(app.application_name),
      icon: getAppIcon(app.application_name),
      group_count: app.group_count,
      session_count: app.session_count,
      total_seconds: app.total_seconds,
      total_time_formatted: formatDuration(app.total_seconds),
      child_group_ids: app.child_group_ids,
      latest_activity: app.latest_activity,
      can_bulk_assign: app.group_count > 1 // Show bulk option if multiple groups
    }))
  };
}

/**
 * Get child groups for a specific application
 * Called when user expands an application group
 */
export async function getApplicationChildGroups(req) {
  const { applicationName } = req.payload;
  const { config, userId } = await initializeRequestContext(req);
  
  // Fetch all groups for this application
  const groups = await supabaseRequest(
    config,
    `unassigned_work_groups?user_id=eq.${userId}&select=*,
    unassigned_group_members(unassigned_activity(application_name))&
    is_assigned=eq.false&is_dismissed=eq.false`
  );
  
  // Filter groups that have this application
  const appGroups = groups.filter(g => 
    g.unassigned_group_members.some(m => 
      m.unassigned_activity?.application_name === applicationName
    )
  );
  
  return {
    success: true,
    groups: appGroups.map(enrichGroup)
  };
}

/**
 * Bulk assign all groups from an application to a single issue
 */
export async function bulkAssignApplication(req) {
  const { applicationName, assignmentType, issueKey, createIssueData } = req.payload;
  const { config, userId, accountId } = await initializeRequestContext(req);
  
  // Get all groups for this application
  const { groups } = await getApplicationChildGroups(req);
  
  // Collect all session IDs across all groups
  const allSessionIds = groups.flatMap(g => g.session_ids || []);
  
  if (assignmentType === 'existing') {
    // Assign all sessions to existing issue
    return await assignToExistingIssue({
      payload: {
        issueKey,
        sessionIds: allSessionIds,
        totalSeconds: groups.reduce((sum, g) => sum + g.total_seconds, 0)
      },
      context: { accountId }
    });
  } else {
    // Create new issue and assign all sessions
    return await createIssueAndAssign({
      payload: {
        ...createIssueData,
        sessionIds: allSessionIds,
        totalSeconds: groups.reduce((sum, g) => sum + g.total_seconds, 0)
      },
      context: { accountId }
    });
  }
}
```

**Helper Functions**
```javascript
// forge-app/src/resolvers/unassigned/helpers.js

/**
 * Normalize application name for grouping
 * chrome.exe → chrome
 * Google Chrome → chrome
 */
function normalizeAppName(appName) {
  if (!appName) return 'unknown';
  
  return appName
    .toLowerCase()
    .replace('.exe', '')
    .replace('.app', '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Get human-readable display name for application
 */
function getAppDisplayName(appName) {
  const displayNames = {
    'chrome': 'Google Chrome',
    'code': 'VS Code',
    'cursor': 'Cursor',
    'slack': 'Slack',
    'teams': 'Microsoft Teams',
    'firefox': 'Firefox',
    'edge': 'Microsoft Edge',
    'outlook': 'Outlook',
    'excel': 'Microsoft Excel',
    'word': 'Microsoft Word',
    'powershell': 'PowerShell',
    'cmd': 'Command Prompt',
    'terminal': 'Terminal'
  };
  
  const normalized = normalizeAppName(appName);
  return displayNames[normalized] || appName;
}

/**
 * Get icon/emoji for application
 */
function getAppIcon(appName) {
  const icons = {
    'chrome': '🌐',
    'code': '💻',
    'cursor': '⚡',
    'slack': '💬',
    'teams': '📞',
    'firefox': '🦊',
    'edge': '🌊',
    'outlook': '📧',
    'excel': '📊',
    'word': '📝',
    'powershell': '⚙️',
    'terminal': '⌨️'
  };
  
  const normalized = normalizeAppName(appName);
  return icons[normalized] || '📱';
}
```

#### 4. Frontend Component Changes

**New Component: `ApplicationGroupView.js`**
```javascript
// forge-app/static/main/src/components/unassigned/ApplicationGroupView.js

import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import './ApplicationGroupView.css';

function ApplicationGroupView({ onAssignClick }) {
  const [applicationGroups, setApplicationGroups] = useState([]);
  const [expandedApps, setExpandedApps] = useState(new Set());
  const [childGroups, setChildGroups] = useState({}); // { appName: [groups] }
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    loadApplicationGroups();
  }, []);
  
  const loadApplicationGroups = async () => {
    setLoading(true);
    try {
      const result = await invoke('getUnassignedWorkByApplication');
      if (result.success) {
        setApplicationGroups(result.application_groups);
      }
    } catch (err) {
      console.error('Error loading application groups:', err);
    } finally {
      setLoading(false);
    }
  };
  
  const handleToggleApp = async (appName) => {
    const isExpanded = expandedApps.has(appName);
    
    if (isExpanded) {
      // Collapse
      setExpandedApps(prev => {
        const next = new Set(prev);
        next.delete(appName);
        return next;
      });
    } else {
      // Expand - load child groups
      setExpandedApps(prev => new Set(prev).add(appName));
      
      if (!childGroups[appName]) {
        try {
          const result = await invoke('getApplicationChildGroups', {
            applicationName: appName
          });
          if (result.success) {
            setChildGroups(prev => ({
              ...prev,
              [appName]: result.groups
            }));
          }
        } catch (err) {
          console.error('Error loading child groups:', err);
        }
      }
    }
  };
  
  const handleBulkAssign = (appGroup) => {
    // Open modal for bulk assignment
    onAssignClick({
      type: 'application-bulk',
      application_name: appGroup.application_name,
      display_name: appGroup.display_name,
      session_count: appGroup.session_count,
      group_count: appGroup.group_count,
      total_seconds: appGroup.total_seconds,
      total_time_formatted: appGroup.total_time_formatted,
      child_group_ids: appGroup.child_group_ids
    });
  };
  
  if (loading) {
    return <div className="loading">Loading application groups...</div>;
  }
  
  return (
    <div className="application-group-view">
      <div className="view-header">
        <h3>Unassigned Work by Application</h3>
        <p className="view-description">
          Groups are organized by application. Click to expand and see details, or use bulk assign.
        </p>
      </div>
      
      {applicationGroups.map(appGroup => (
        <div key={appGroup.application_name} className="app-group-card">
          {/* Application Header */}
          <div className="app-header" onClick={() => handleToggleApp(appGroup.application_name)}>
            <div className="app-info">
              <span className="app-icon">{appGroup.icon}</span>
              <span className="app-name">{appGroup.display_name}</span>
              <span className="app-stats">
                {appGroup.group_count} {appGroup.group_count === 1 ? 'group' : 'groups'} • 
                {appGroup.session_count} {appGroup.session_count === 1 ? 'session' : 'sessions'} • 
                {appGroup.total_time_formatted}
              </span>
            </div>
            <div className="app-actions">
              {appGroup.can_bulk_assign && (
                <button 
                  className="bulk-assign-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBulkAssign(appGroup);
                  }}
                >
                  Assign All
                </button>
              )}
              <span className="expand-icon">
                {expandedApps.has(appGroup.application_name) ? '▼' : '▶'}
              </span>
            </div>
          </div>
          
          {/* Expanded Child Groups */}
          {expandedApps.has(appGroup.application_name) && (
            <div className="child-groups">
              {childGroups[appGroup.application_name]?.map(group => (
                <div key={group.id} className="child-group-item">
                  <div className="group-label">{group.label}</div>
                  <div className="group-meta">
                    {group.session_count} sessions • {group.total_time_formatted}
                  </div>
                  <div className="group-description">{group.description}</div>
                  <button 
                    className="assign-group-btn"
                    onClick={() => onAssignClick(group)}
                  >
                    Assign This Group
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      
      {applicationGroups.length === 0 && (
        <div className="empty-state">
          <p>No unassigned work found.</p>
          <p className="empty-subtitle">All your work has been assigned to issues.</p>
        </div>
      )}
    </div>
  );
}

export default ApplicationGroupView;
```

**Updated: `UnassignedWork.js`**
```javascript
// Add view toggle between "AI Groups" and "By Application"

import ApplicationGroupView from './unassigned/ApplicationGroupView';

function UnassignedWork() {
  const [viewMode, setViewMode] = useState('application'); // 'application' | 'ai-groups'
  // ... existing state
  
  return (
    <div className="unassigned-work-container">
      <div className="unassigned-work-header">
        <div className="header-top-row">
          <h2>Unassigned Work</h2>
          
          {/* View Toggle */}
          <div className="view-toggle">
            <button
              className={viewMode === 'application' ? 'active' : ''}
              onClick={() => setViewMode('application')}
            >
              By Application
            </button>
            <button
              className={viewMode === 'ai-groups' ? 'active' : ''}
              onClick={() => setViewMode('ai-groups')}
            >
              AI Groups
            </button>
          </div>
        </div>
      </div>
      
      {/* Conditional Rendering based on view mode */}
      {viewMode === 'application' ? (
        <ApplicationGroupView onAssignClick={handleAssignClick} />
      ) : (
        <GroupAccordion
          groups={groups}
          hasMoreGroups={hasMoreGroups}
          totalGroups={totalGroups}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          onAssignClick={handleAssignClick}
          onDismissGroup={handleDismissGroup}
          onDismissMember={handleDismissMember}
        />
      )}
      
      {/* Assignment Modal - Updated to handle bulk assignment */}
      <AssignmentModal
        isOpen={showAssignModal}
        selectedGroup={selectedGroup}
        userIssues={userIssues}
        userProjects={userProjects}
        onClose={() => setShowAssignModal(false)}
        onAssignmentComplete={handleAssignmentComplete}
      />
    </div>
  );
}
```

**Updated: `AssignmentModal.js`**
```javascript
// Add support for application-level bulk assignment

function AssignmentModal({
  isOpen,
  selectedGroup,
  userIssues,
  userProjects,
  onClose,
  onAssignmentComplete
}) {
  // Detect if this is a bulk application assignment
  const isBulkAppAssignment = selectedGroup?.type === 'application-bulk';
  
  // ... existing state
  
  const handleBulkAppAssign = async () => {
    if (!selectedIssueKey && assignmentType === 'existing') {
      alert('Please select an issue');
      return;
    }
    
    setAssigning(true);
    try {
      const result = await invoke('bulkAssignApplication', {
        applicationName: selectedGroup.application_name,
        assignmentType: assignmentType,
        issueKey: assignmentType === 'existing' ? selectedIssueKey : null,
        createIssueData: assignmentType === 'new' ? {
          issueSummary: newIssueSummary,
          issueDescription: newIssueDescription,
          projectKey: selectedProject,
          issueType: issueType,
          statusName: selectedStatus
        } : null
      });
      
      if (result.success) {
        alert(`Successfully assigned ${result.assigned_count} sessions from ${selectedGroup.group_count} groups to ${result.issue_key}`);
        onClose();
        onAssignmentComplete();
      } else {
        alert('Failed: ' + result.error);
      }
    } catch (err) {
      console.error('Error bulk assigning:', err);
      alert('Error: ' + err.message);
    } finally {
      setAssigning(false);
    }
  };
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content assignment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {isBulkAppAssignment 
              ? `Assign All ${selectedGroup.display_name} Work` 
              : `Assign "${selectedGroup.label}"`
            }
          </h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        {isBulkAppAssignment && (
          <div className="bulk-assignment-info">
            <div className="info-box">
              <h4>You're about to assign:</h4>
              <ul>
                <li>{selectedGroup.group_count} work groups</li>
                <li>{selectedGroup.session_count} activity sessions</li>
                <li>{selectedGroup.total_time_formatted} total time</li>
              </ul>
              <p className="warning-text">
                ⚠️ All groups will be assigned to the same issue
              </p>
            </div>
          </div>
        )}
        
        <div className="modal-body">
          {/* Assignment form - same as before */}
          {/* ... existing assignment options ... */}
          
          <button
            className="submit-button"
            onClick={isBulkAppAssignment ? handleBulkAppAssign : handleAssignToExisting}
            disabled={assigning}
          >
            {assigning 
              ? 'Assigning...' 
              : isBulkAppAssignment 
                ? `Assign ${selectedGroup.group_count} Groups`
                : 'Assign to Issue'
            }
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Styles: `ApplicationGroupView.css`**
```css
.application-group-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-header {
  margin-bottom: 16px;
}

.view-header h3 {
  font-size: 20px;
  font-weight: 600;
  color: #172b4d;
  margin-bottom: 8px;
}

.view-description {
  font-size: 14px;
  color: #5e6c84;
}

.app-group-card {
  background: white;
  border: 2px solid #e1e4e8;
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.app-group-card:hover {
  border-color: #6656fc;
}

.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  cursor: pointer;
  background: #fafbfc;
  border-bottom: 1px solid #e1e4e8;
}

.app-header:hover {
  background: #f4f5f7;
}

.app-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-icon {
  font-size: 24px;
}

.app-name {
  font-size: 16px;
  font-weight: 600;
  color: #172b4d;
}

.app-stats {
  font-size: 14px;
  color: #5e6c84;
}

.app-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bulk-assign-btn {
  padding: 8px 16px;
  background: #6656fc;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.bulk-assign-btn:hover {
  background: #5243c2;
}

.expand-icon {
  font-size: 12px;
  color: #5e6c84;
}

.child-groups {
  padding: 16px;
  background: white;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.child-group-item {
  padding: 12px;
  background: #f4f5f7;
  border-radius: 4px;
  border-left: 3px solid #6656fc;
}

.group-label {
  font-size: 14px;
  font-weight: 600;
  color: #172b4d;
  margin-bottom: 4px;
}

.group-meta {
  font-size: 12px;
  color: #5e6c84;
  margin-bottom: 8px;
}

.group-description {
  font-size: 13px;
  color: #42526e;
  margin-bottom: 12px;
  line-height: 1.5;
}

.assign-group-btn {
  padding: 6px 12px;
  background: white;
  color: #6656fc;
  border: 2px solid #6656fc;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.assign-group-btn:hover {
  background: #6656fc;
  color: white;
}

.view-toggle {
  display: flex;
  gap: 8px;
  background: #f4f5f7;
  padding: 4px;
  border-radius: 6px;
}

.view-toggle button {
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  color: #5e6c84;
  cursor: pointer;
  transition: all 0.2s;
}

.view-toggle button.active {
  background: white;
  color: #6656fc;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.bulk-assignment-info {
  padding: 16px;
  background: #e9f2ff;
  border-radius: 4px;
  margin-bottom: 16px;
}

.info-box h4 {
  font-size: 14px;
  font-weight: 600;
  color: #172b4d;
  margin-bottom: 12px;
}

.info-box ul {
  list-style: none;
  padding: 0;
  margin-bottom: 12px;
}

.info-box li {
  font-size: 14px;
  color: #42526e;
  padding: 4px 0;
  padding-left: 20px;
  position: relative;
}

.info-box li::before {
  content: "✓";
  position: absolute;
  left: 0;
  color: #0052cc;
  font-weight: bold;
}

.warning-text {
  font-size: 13px;
  color: #ff8b00;
  font-weight: 600;
  margin: 0;
}
```

---

## Comparison: Current vs Proposed Approach

### Current Approach

| Aspect | Details |
|--------|---------|
| **Grouping Logic** | AI clusters sessions by similarity of window titles, activity descriptions |
| **Number of Groups** | Often creates 30-40+ groups for 1-2 hours of work |
| **User Experience** | Overwhelming - user must review and assign each group individually |
| **Assignment Flow** | One group at a time → Repeat 40 times |
| **Time to Complete** | ~30-60 seconds per group → 20-40 minutes total |
| **Typical Result** | "Chrome - Query A" + "Chrome - Query B" = 2 separate groups |
| **Pros** | ✅ Detailed context, Good for exact tracking |
| **Cons** | ❌ Over-fragmented, ❌ Time-consuming, ❌ Poor UX |

### Proposed Approach

| Aspect | Details |
|--------|---------|
| **Grouping Logic** | Two-level: (1) Application → (2) AI clusters within application |
| **Number of Top-Level Items** | 3-8 applications typically (Chrome, VS Code, Slack, etc.) |
| **User Experience** | Clean - see work organized by app, bulk assign entire app's work |
| **Assignment Flow** | Bulk assign all Chrome work → 1 assignment; Repeat for 2-3 more apps |
| **Time to Complete** | ~30 seconds per app → 2-5 minutes total |
| **Typical Result** | "Chrome" (contains Query A + Query B + all other Chrome work) |
| **Pros** | ✅ Consolidated view, ✅ Fast assignment, ✅ Preserves detail if needed, ✅ Good UX |
| **Cons** | ⚠️ Slightly less granular by default (but can expand to see details) |

### Side-by-Side Example

**Scenario**: User worked for 2 hours across Chrome, VS Code, and Slack

**Current Approach:**
```
📋 Unassigned Work (35 groups)

1. Chrome - Stack Overflow Auth Question (3 sessions, 5m)
2. Chrome - React Documentation (2 sessions, 8m)
3. Chrome - GitHub Pull Request Review (5 sessions, 12m)
4. Chrome - API Documentation (4 sessions, 10m)
5. Chrome - JIRA Board (3 sessions, 7m)
... (30 more groups)

User actions: 35 individual assignments ❌
```

**Proposed Approach:**
```
📋 Unassigned Work (3 applications)

🌐 Chrome (15 groups, 25 sessions, 1h 10m) [Assign All]
   ↳ Can expand to see 15 child groups if needed

💻 VS Code (4 groups, 18 sessions, 45m) [Assign All]
   ↳ Can expand to see 4 child groups if needed

💬 Slack (2 groups, 5 sessions, 5m) [Assign All]
   ↳ Can expand to see 2 child groups if needed

User actions: 3 bulk assignments ✅
```

---

## Implementation Steps

### Phase 1: Backend Foundation
1. Create `getUnassignedWorkByApplication` resolver
2. Create `getApplicationChildGroups` resolver
3. Create `bulkAssignApplication` resolver
4. Add helper functions (normalizeAppName, getAppDisplayName, getAppIcon)
5. Update `assignmentResolvers.js` to handle bulk assignment logic

### Phase 2: Frontend Components
1. Create `ApplicationGroupView.js` component
2. Create `ApplicationGroupView.css` styles
3. Update `UnassignedWork.js` to add view toggle
4. Update `AssignmentModal.js` to support bulk assignment
5. Update `AssignmentModal.css` for bulk assignment UI

### Phase 3: Database Optimization (Optional)
1. Create `unassigned_work_by_app` table for better performance
2. Create triggers to maintain the table
3. Add indexes for fast queries

### Phase 4: Testing
1. Unit tests for resolvers
2. Integration tests for bulk assignment flow
3. UI tests for view toggle and expansion
4. Performance tests with large datasets

### Phase 5: User Settings (Optional Enhancement)
1. Add user preference: "Default View" (Application / AI Groups)
2. Add user preference: "Auto-expand applications" (true / false)
3. Save preferences in user settings table

---

## Test Files

### Test File 1: Backend Resolver Tests

**File**: `forge-app/tests/resolvers/unassigned/applicationGrouping.test.js`

```javascript
import { describe, test, expect, beforeEach } from '@jest/globals';
import { 
  getUnassignedWorkByApplication, 
  getApplicationChildGroups,
  bulkAssignApplication 
} from '../../../src/resolvers/unassigned/sessionResolvers.js';
import {
  normalizeAppName,
  getAppDisplayName,
  getAppIcon
} from '../../../src/resolvers/unassigned/helpers.js';

describe('Application Grouping - Resolver Tests', () => {
  
  describe('normalizeAppName', () => {
    test('should remove .exe extension', () => {
      expect(normalizeAppName('chrome.exe')).toBe('chrome');
      expect(normalizeAppName('code.exe')).toBe('code');
    });
    
    test('should remove .app extension', () => {
      expect(normalizeAppName('Chrome.app')).toBe('chrome');
    });
    
    test('should handle lowercase conversion', () => {
      expect(normalizeAppName('Google Chrome')).toBe('googlechrome');
      expect(normalizeAppName('Microsoft Edge')).toBe('microsoftedge');
    });
    
    test('should remove whitespace', () => {
      expect(normalizeAppName('Microsoft Teams')).toBe('microsoftteams');
    });
    
    test('should handle null/undefined', () => {
      expect(normalizeAppName(null)).toBe('unknown');
      expect(normalizeAppName(undefined)).toBe('unknown');
      expect(normalizeAppName('')).toBe('unknown');
    });
  });
  
  describe('getAppDisplayName', () => {
    test('should return friendly names for common apps', () => {
      expect(getAppDisplayName('chrome.exe')).toBe('Google Chrome');
      expect(getAppDisplayName('code.exe')).toBe('VS Code');
      expect(getAppDisplayName('slack.exe')).toBe('Slack');
    });
    
    test('should return original name if not in mapping', () => {
      expect(getAppDisplayName('customapp.exe')).toBe('customapp.exe');
    });
  });
  
  describe('getAppIcon', () => {
    test('should return icons for common apps', () => {
      expect(getAppIcon('chrome.exe')).toBe('🌐');
      expect(getAppIcon('code.exe')).toBe('💻');
      expect(getAppIcon('slack.exe')).toBe('💬');
    });
    
    test('should return default icon for unknown apps', () => {
      expect(getAppIcon('unknown.exe')).toBe('📱');
    });
  });
  
  describe('getUnassignedWorkByApplication', () => {
    test('should group unassigned work by application', async () => {
      const mockReq = {
        payload: {},
        context: {
          accountId: 'test-account-id'
        }
      };
      
      // Mock database response
      const mockDbResponse = [
        {
          application_name: 'chrome.exe',
          group_count: 5,
          session_count: 15,
          total_seconds: 3600,
          child_group_ids: ['group-1', 'group-2', 'group-3', 'group-4', 'group-5'],
          latest_activity: '2026-04-07T10:30:00Z'
        },
        {
          application_name: 'code.exe',
          group_count: 3,
          session_count: 20,
          total_seconds: 7200,
          child_group_ids: ['group-6', 'group-7', 'group-8'],
          latest_activity: '2026-04-07T11:00:00Z'
        }
      ];
      
      // Mock supabaseRequest
      jest.spyOn(global, 'supabaseRequest').mockResolvedValue(mockDbResponse);
      
      const result = await getUnassignedWorkByApplication(mockReq);
      
      expect(result.success).toBe(true);
      expect(result.application_groups).toHaveLength(2);
      
      const chromeGroup = result.application_groups[0];
      expect(chromeGroup.application_name).toBe('chrome.exe');
      expect(chromeGroup.normalized_name).toBe('chrome');
      expect(chromeGroup.display_name).toBe('Google Chrome');
      expect(chromeGroup.icon).toBe('🌐');
      expect(chromeGroup.group_count).toBe(5);
      expect(chromeGroup.session_count).toBe(15);
      expect(chromeGroup.total_time_formatted).toBe('1h 0m');
      expect(chromeGroup.can_bulk_assign).toBe(true); // > 1 group
    });
    
    test('should sort applications by total time (descending)', async () => {
      // Test implementation
    });
    
    test('should handle empty result', async () => {
      // Test implementation
    });
  });
  
  describe('getApplicationChildGroups', () => {
    test('should return child groups for an application', async () => {
      const mockReq = {
        payload: {
          applicationName: 'chrome.exe'
        },
        context: {
          accountId: 'test-account-id'
        }
      };
      
      // Mock database response with child groups
      const mockGroups = [
        {
          id: 'group-1',
          group_label: 'Chrome - Research',
          group_description: 'Stack Overflow research',
          session_count: 5,
          total_seconds: 900
        },
        {
          id: 'group-2',
          group_label: 'Chrome - Documentation',
          group_description: 'Reading React docs',
          session_count: 8,
          total_seconds: 1200
        }
      ];
      
      jest.spyOn(global, 'supabaseRequest').mockResolvedValue(mockGroups);
      
      const result = await getApplicationChildGroups(mockReq);
      
      expect(result.success).toBe(true);
      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].label).toBe('Chrome - Research');
    });
    
    test('should handle application with no groups', async () => {
      // Test implementation
    });
  });
  
  describe('bulkAssignApplication', () => {
    test('should assign all groups from application to existing issue', async () => {
      const mockReq = {
        payload: {
          applicationName: 'chrome.exe',
          assignmentType: 'existing',
          issueKey: 'PROJ-123'
        },
        context: {
          accountId: 'test-account-id'
        }
      };
      
      // Mock getApplicationChildGroups to return groups
      jest.spyOn(global, 'getApplicationChildGroups').mockResolvedValue({
        success: true,
        groups: [
          { id: 'g1', session_ids: ['s1', 's2'], total_seconds: 300 },
          { id: 'g2', session_ids: ['s3', 's4', 's5'], total_seconds: 500 }
        ]
      });
      
      // Mock assignToExistingIssue
      jest.spyOn(global, 'assignToExistingIssue').mockResolvedValue({
        success: true,
        assigned_count: 5,
        issue_key: 'PROJ-123'
      });
      
      const result = await bulkAssignApplication(mockReq);
      
      expect(result.success).toBe(true);
      expect(result.assigned_count).toBe(5);
      expect(result.issue_key).toBe('PROJ-123');
      
      // Verify assignToExistingIssue was called with all session IDs
      expect(global.assignToExistingIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            sessionIds: ['s1', 's2', 's3', 's4', 's5'],
            totalSeconds: 800 // 300 + 500
          })
        })
      );
    });
    
    test('should create new issue and assign all groups', async () => {
      const mockReq = {
        payload: {
          applicationName: 'chrome.exe',
          assignmentType: 'new',
          createIssueData: {
            issueSummary: 'Research work',
            projectKey: 'PROJ',
            issueType: 'Task'
          }
        },
        context: {
          accountId: 'test-account-id'
        }
      };
      
      // Test implementation
    });
    
    test('should handle partial failure gracefully', async () => {
      // Test implementation
    });
  });
});
```

### Test File 2: Frontend Component Tests

**File**: `forge-app/static/main/src/components/unassigned/__tests__/ApplicationGroupView.test.js`

```javascript
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ApplicationGroupView from '../ApplicationGroupView';
import { invoke } from '@forge/bridge';

jest.mock('@forge/bridge');

describe('ApplicationGroupView Component', () => {
  
  const mockApplicationGroups = [
    {
      application_name: 'chrome.exe',
      normalized_name: 'chrome',
      display_name: 'Google Chrome',
      icon: '🌐',
      group_count: 5,
      session_count: 15,
      total_seconds: 3600,
      total_time_formatted: '1h 0m',
      child_group_ids: ['g1', 'g2', 'g3', 'g4', 'g5'],
      can_bulk_assign: true
    },
    {
      application_name: 'code.exe',
      normalized_name: 'code',
      display_name: 'VS Code',
      icon: '💻',
      group_count: 3,
      session_count: 20,
      total_seconds: 7200,
      total_time_formatted: '2h 0m',
      child_group_ids: ['g6', 'g7', 'g8'],
      can_bulk_assign: true
    }
  ];
  
  const mockChildGroups = {
    'chrome.exe': [
      {
        id: 'g1',
        label: 'Chrome - Research',
        description: 'Stack Overflow research',
        session_count: 5,
        total_seconds: 900,
        total_time_formatted: '15m'
      },
      {
        id: 'g2',
        label: 'Chrome - Documentation',
        description: 'Reading React docs',
        session_count: 10,
        total_seconds: 2700,
        total_time_formatted: '45m'
      }
    ]
  };
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('should render loading state initially', () => {
    invoke.mockReturnValue(new Promise(() => {})); // Never resolves
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    expect(screen.getByText('Loading application groups...')).toBeInTheDocument();
  });
  
  test('should render application groups after loading', async () => {
    invoke.mockResolvedValue({
      success: true,
      application_groups: mockApplicationGroups
    });
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    await waitFor(() => {
      expect(screen.getByText('Google Chrome')).toBeInTheDocument();
      expect(screen.getByText('VS Code')).toBeInTheDocument();
    });
    
    // Check stats
    expect(screen.getByText(/5 groups • 15 sessions • 1h 0m/)).toBeInTheDocument();
    expect(screen.getByText(/3 groups • 20 sessions • 2h 0m/)).toBeInTheDocument();
  });
  
  test('should show "Assign All" button for apps with multiple groups', async () => {
    invoke.mockResolvedValue({
      success: true,
      application_groups: mockApplicationGroups
    });
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    await waitFor(() => {
      const assignButtons = screen.getAllByText('Assign All');
      expect(assignButtons).toHaveLength(2); // Both apps have multiple groups
    });
  });
  
  test('should expand application and load child groups on click', async () => {
    invoke
      .mockResolvedValueOnce({
        success: true,
        application_groups: mockApplicationGroups
      })
      .mockResolvedValueOnce({
        success: true,
        groups: mockChildGroups['chrome.exe']
      });
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Google Chrome')).toBeInTheDocument();
    });
    
    // Click Chrome to expand
    const chromeHeader = screen.getByText('Google Chrome').closest('.app-header');
    fireEvent.click(chromeHeader);
    
    // Wait for child groups to load
    await waitFor(() => {
      expect(screen.getByText('Chrome - Research')).toBeInTheDocument();
      expect(screen.getByText('Chrome - Documentation')).toBeInTheDocument();
    });
    
    // Verify invoke was called for child groups
    expect(invoke).toHaveBeenCalledWith('getApplicationChildGroups', {
      applicationName: 'chrome.exe'
    });
  });
  
  test('should collapse expanded application on second click', async () => {
    invoke
      .mockResolvedValueOnce({
        success: true,
        application_groups: mockApplicationGroups
      })
      .mockResolvedValueOnce({
        success: true,
        groups: mockChildGroups['chrome.exe']
      });
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    await waitFor(() => {
      expect(screen.getByText('Google Chrome')).toBeInTheDocument();
    });
    
    const chromeHeader = screen.getByText('Google Chrome').closest('.app-header');
    
    // Expand
    fireEvent.click(chromeHeader);
    await waitFor(() => {
      expect(screen.getByText('Chrome - Research')).toBeInTheDocument();
    });
    
    // Collapse
    fireEvent.click(chromeHeader);
    await waitFor(() => {
      expect(screen.queryByText('Chrome - Research')).not.toBeInTheDocument();
    });
  });
  
  test('should call onAssignClick with bulk data when "Assign All" clicked', async () => {
    invoke.mockResolvedValue({
      success: true,
      application_groups: mockApplicationGroups
    });
    
    const mockOnAssignClick = jest.fn();
    render(<ApplicationGroupView onAssignClick={mockOnAssignClick} />);
    
    await waitFor(() => {
      expect(screen.getByText('Google Chrome')).toBeInTheDocument();
    });
    
    const assignButtons = screen.getAllByText('Assign All');
    fireEvent.click(assignButtons[0]); // Click Chrome's "Assign All"
    
    expect(mockOnAssignClick).toHaveBeenCalledWith({
      type: 'application-bulk',
      application_name: 'chrome.exe',
      display_name: 'Google Chrome',
      session_count: 15,
      group_count: 5,
      total_seconds: 3600,
      total_time_formatted: '1h 0m',
      child_group_ids: ['g1', 'g2', 'g3', 'g4', 'g5']
    });
  });
  
  test('should call onAssignClick with group data when "Assign This Group" clicked', async () => {
    invoke
      .mockResolvedValueOnce({
        success: true,
        application_groups: mockApplicationGroups
      })
      .mockResolvedValueOnce({
        success: true,
        groups: mockChildGroups['chrome.exe']
      });
    
    const mockOnAssignClick = jest.fn();
    render(<ApplicationGroupView onAssignClick={mockOnAssignClick} />);
    
    await waitFor(() => {
      expect(screen.getByText('Google Chrome')).toBeInTheDocument();
    });
    
    // Expand Chrome
    const chromeHeader = screen.getByText('Google Chrome').closest('.app-header');
    fireEvent.click(chromeHeader);
    
    await waitFor(() => {
      expect(screen.getByText('Chrome - Research')).toBeInTheDocument();
    });
    
    // Click "Assign This Group" on first child
    const assignGroupButtons = screen.getAllByText('Assign This Group');
    fireEvent.click(assignGroupButtons[0]);
    
    expect(mockOnAssignClick).toHaveBeenCalledWith(
      mockChildGroups['chrome.exe'][0]
    );
  });
  
  test('should render empty state when no applications', async () => {
    invoke.mockResolvedValue({
      success: true,
      application_groups: []
    });
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    await waitFor(() => {
      expect(screen.getByText('No unassigned work found.')).toBeInTheDocument();
      expect(screen.getByText('All your work has been assigned to issues.')).toBeInTheDocument();
    });
  });
  
  test('should handle API error gracefully', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    invoke.mockRejectedValue(new Error('API Error'));
    
    render(<ApplicationGroupView onAssignClick={jest.fn()} />);
    
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'Error loading application groups:',
        expect.any(Error)
      );
    });
    
    consoleError.mockRestore();
  });
});
```

### Test File 3: Integration Test

**File**: `forge-app/tests/integration/bulkAssignmentFlow.test.js`

```javascript
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { setupTestDatabase, teardownTestDatabase, createTestUser } from '../helpers/testSetup';
import {
  getUnassignedWorkByApplication,
  bulkAssignApplication
} from '../../src/resolvers/unassigned/sessionResolvers.js';

describe('Bulk Assignment Integration Test', () => {
  let testUser;
  let testOrganization;
  
  beforeAll(async () => {
    // Setup test database
    const setup = await setupTestDatabase();
    testUser = setup.user;
    testOrganization = setup.organization;
    
    // Create test data: 40 unassigned activities across 3 applications
    await createTestUnassignedActivities({
      userId: testUser.id,
      organizationId: testOrganization.id,
      activities: [
        // Chrome activities - 25 sessions across 8 groups
        ...generateActivities('chrome.exe', 'Chrome - React Docs', 5),
        ...generateActivities('chrome.exe', 'Chrome - Stack Overflow', 4),
        ...generateActivities('chrome.exe', 'Chrome - GitHub', 6),
        ...generateActivities('chrome.exe', 'Chrome - JIRA Board', 3),
        ...generateActivities('chrome.exe', 'Chrome - API Docs', 3),
        ...generateActivities('chrome.exe', 'Chrome - YouTube Tutorial', 2),
        ...generateActivities('chrome.exe', 'Chrome - Medium Article', 1),
        ...generateActivities('chrome.exe', 'Chrome - npm Package', 1),
        
        // VS Code activities - 12 sessions across 3 groups
        ...generateActivities('code.exe', 'VSCode - Component Edit', 6),
        ...generateActivities('code.exe', 'VSCode - Test Files', 4),
        ...generateActivities('code.exe', 'VSCode - Config Setup', 2),
        
        // Slack activities - 3 sessions in 1 group
        ...generateActivities('slack.exe', 'Slack - Team Chat', 3)
      ]
    });
  });
  
  afterAll(async () => {
    await teardownTestDatabase();
  });
  
  test('should reduce 40 activities to 3 application groups', async () => {
    const req = {
      payload: {},
      context: {
        accountId: testUser.atlassian_account_id
      }
    };
    
    const result = await getUnassignedWorkByApplication(req);
    
    expect(result.success).toBe(true);
    expect(result.application_groups).toHaveLength(3);
    
    const chrome = result.application_groups.find(a => a.normalized_name === 'chrome');
    const vscode = result.application_groups.find(a => a.normalized_name === 'code');
    const slack = result.application_groups.find(a => a.normalized_name === 'slack');
    
    expect(chrome.group_count).toBe(8);
    expect(chrome.session_count).toBe(25);
    expect(chrome.can_bulk_assign).toBe(true);
    
    expect(vscode.group_count).toBe(3);
    expect(vscode.session_count).toBe(12);
    expect(vscode.can_bulk_assign).toBe(true);
    
    expect(slack.group_count).toBe(1);
    expect(slack.session_count).toBe(3);
    expect(slack.can_bulk_assign).toBe(false); // Only 1 group
  });
  
  test('should bulk assign all Chrome work to single issue', async () => {
    const req = {
      payload: {
        applicationName: 'chrome.exe',
        assignmentType: 'existing',
        issueKey: 'TEST-123'
      },
      context: {
        accountId: testUser.atlassian_account_id
      }
    };
    
    const result = await bulkAssignApplication(req);
    
    expect(result.success).toBe(true);
    expect(result.assigned_count).toBe(25); // All Chrome sessions
    expect(result.issue_key).toBe('TEST-123');
    
    // Verify all Chrome groups are now assigned
    const verifyReq = { ...req, payload: {} };
    const afterResult = await getUnassignedWorkByApplication(verifyReq);
    
    const chromeAfter = afterResult.application_groups.find(a => a.normalized_name === 'chrome');
    expect(chromeAfter).toBeUndefined(); // Chrome should be gone from unassigned
    
    // VS Code and Slack should still be unassigned
    expect(afterResult.application_groups).toHaveLength(2);
  });
  
  test('should create new issue and assign all VS Code work', async () => {
    const req = {
      payload: {
        applicationName: 'code.exe',
        assignmentType: 'new',
        createIssueData: {
          issueSummary: 'Frontend Development Work',
          issueDescription: 'Component updates and test files',
          projectKey: 'TEST',
          issueType: 'Task',
          statusName: 'In Progress'
        }
      },
      context: {
        accountId: testUser.atlassian_account_id
      }
    };
    
    const result = await bulkAssignApplication(req);
    
    expect(result.success).toBe(true);
    expect(result.assigned_count).toBe(12); // All VS Code sessions
    expect(result.issue_key).toMatch(/^TEST-\d+$/); // Created issue
    expect(result.worklog_created).toBe(true);
  });
  
  test('should complete full assignment flow in under 1 minute', async () => {
    const startTime = Date.now();
    
    // Bulk assign remaining Slack work
    const req = {
      payload: {
        applicationName: 'slack.exe',
        assignmentType: 'existing',
        issueKey: 'TEST-789'
      },
      context: {
        accountId: testUser.atlassian_account_id
      }
    };
    
    await bulkAssignApplication(req);
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // seconds
    
    expect(duration).toBeLessThan(60); // Should complete in < 1 minute
    
    // Verify all work is now assigned
    const verifyReq = { ...req, payload: {} };
    const finalResult = await getUnassignedWorkByApplication(verifyReq);
    
    expect(finalResult.application_groups).toHaveLength(0); // All assigned
  });
});

// Helper function
function generateActivities(appName, windowTitle, count) {
  return Array.from({ length: count }, (_, i) => ({
    application_name: appName,
    window_title: `${windowTitle} - ${i + 1}`,
    time_spent_seconds: Math.floor(Math.random() * 300) + 60,
    timestamp: new Date(Date.now() - (i * 60000)).toISOString()
  }));
}
```

---

## Migration Strategy

### Step 1: Deploy Backend Changes (No UI Impact)
- Deploy new resolvers
- Test with API calls
- No user-facing changes yet

### Step 2: Feature Flag (Gradual Rollout)
```javascript
// User settings table
{
  user_id: UUID,
  enable_application_grouping: BOOLEAN DEFAULT false
}

// In UnassignedWork.js
const canUseAppGrouping = userSettings.enable_application_grouping;
```

### Step 3: Beta Testing
- Enable for 10% of users
- Collect feedback
- Monitor performance metrics

### Step 4: Full Rollout
- Default view: "By Application"
- Keep "AI Groups" as alternate view
- Add user preference to choose default

### Step 5: Deprecation (Optional, 3+ months later)
- If "By Application" is strongly preferred, consider deprecating "AI Groups" view
- Or keep both views permanently for different use cases

---

## Performance Considerations

### Query Optimization
```sql
-- Add indexes for fast application grouping
CREATE INDEX idx_unassigned_activity_app_user 
ON unassigned_activity(user_id, application_name, timestamp DESC);

CREATE INDEX idx_unassigned_groups_app_assigned 
ON unassigned_work_groups(user_id, is_assigned, is_dismissed);

-- Composite index for join optimization
CREATE INDEX idx_group_members_group_activity 
ON unassigned_group_members(group_id, unassigned_activity_id);
```

### Caching Strategy
```javascript
// Cache application groups for 5 minutes
const CACHE_KEY = `app-groups:${userId}`;
const CACHE_TTL = 300; // seconds

// In getUnassignedWorkByApplication
const cached = await redis.get(CACHE_KEY);
if (cached) {
  return JSON.parse(cached);
}

const result = await queryDatabase();
await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(result));
return result;
```

### Load Time Expectations
- **Current**: Load 40 groups → 2-3 seconds
- **Proposed**: Load 3-5 app groups → 0.5-1 second
- **Expanding app**: Load child groups → 0.3-0.5 seconds (lazy loaded)

---

## Success Metrics

### Quantitative
- **Reduction in visible items**: 40+ groups → 3-8 applications (80-90% reduction)
- **Time to complete assignment**: From 20-40 minutes → 2-5 minutes (90% improvement)
- **User satisfaction**: Target >85% positive feedback
- **Assignment completion rate**: Target >95% (vs current ~60%)

### Qualitative
- Users report "less overwhelming"
- Feedback: "Much faster to assign work"
- Fewer support tickets about "too many unassigned items"

---

## Risks & Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Users miss granular detail | Medium | Low | Keep "AI Groups" view available |
| Performance degradation | High | Low | Add indexes, implement caching |
| Bulk assignment errors | High | Medium | Add atomic transactions, rollback support |
| User confusion with new UI | Medium | Medium | Add onboarding tooltip, documentation |

---

## Future Enhancements

### Phase 2 Features
1. **Smart Suggestions**: "All Chrome work looks like research → Suggest creating 'Research Task'"
2. **Multi-App Assignment**: Select multiple apps, assign to same issue
3. **Time Breakdown**: Show time breakdown by day within each app
4. **Application Filtering**: Hide specific applications (e.g., Slack) from unassigned view

### Phase 3 Features
1. **Auto-Assignment Rules**: "Always assign Slack to COMM-123"
2. **Pattern Detection**: "You usually assign Chrome work to research issues"
3. **Batch Scheduling**: "Assign all Friday's Chrome work to issue X"

---

## Conclusion

This implementation provides a **pragmatic solution** to the unassigned issues fragmentation problem by:

1. **Reducing cognitive load**: 40 items → 3-8 items
2. **Speeding up workflow**: 20-40 minutes → 2-5 minutes
3. **Preserving detail**: Child groups still available if needed
4. **Maintaining flexibility**: Both views available

The approach is **backward compatible**, **incrementally deployable**, and **user-tested** before full rollout.

---

## Questions for Discussion

1. **Default View**: Should "By Application" be the default, or should users choose on first visit?
2. **Bulk Creation**: Should we support creating multiple issues at once (one per application)?
3. **Application Icons**: Should we fetch real application icons instead of emojis?
4. **Merge Applications**: Should "chrome.exe" and "Google Chrome.app" be treated as the same app?
5. **Time Threshold**: Should we hide applications with < 1 minute total time?

Please review and provide feedback before proceeding with implementation.
