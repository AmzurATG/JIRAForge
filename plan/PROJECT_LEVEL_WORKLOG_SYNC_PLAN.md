# Project-Level Worklog Sync Configuration Plan

## Overview

Enable worklog sync to be configured at the project level, allowing different projects within the same organization to have different sync settings.

## Current State

| Component | Status | Notes |
|-----------|--------|-------|
| `tracking_settings` table | ✅ Ready | Has `project_key` column and `jira_worklog_sync_enabled` |
| `settingsService.js` | ✅ Ready | `saveTrackingSettings()` accepts `projectKey` parameter |
| UI/API | ✅ Ready | Settings can be saved per project |
| `scheduledWorklogSync.js` | ✅ Updated | Now supports project-level sync filtering |
| `worklogService.js` | ✅ Updated | User-context sync respects project settings |

## Requirements

1. **Project-level sync enable/disable** - Each project can independently enable/disable worklog sync
2. **Override logic** - Project settings override organization settings
3. **Backwards compatibility** - Org-level setting applies to projects without explicit settings

## Implementation Tasks

### Task 1: Update `scheduledWorklogSync.js`

**File:** `forge-app/src/services/scheduledWorklogSync.js`

**Changes:**

1. **Fetch project-level settings alongside org settings**
   ```javascript
   // Current: Only fetches org-level enabled
   const orgsWithSync = await supabaseRequest(
     supabaseConfig,
     'tracking_settings?jira_worklog_sync_enabled=eq.true&select=organization_id'
   );
   
   // New: Fetch all settings (org + project level)
   const allSyncSettings = await supabaseRequest(
     supabaseConfig,
     'tracking_settings?select=organization_id,project_key,jira_worklog_sync_enabled'
   );
   ```

2. **Build project sync map per organization**
   ```javascript
   // Map structure: { orgId: { orgEnabled: bool, projects: { projectKey: bool } } }
   ```

3. **Update `aggregateTrackedTime()` to accept excluded projects**
   - Add parameter for projects to exclude from sync
   - Filter activity records by `project_key` not in excluded list

4. **Update `syncOrganization()` to use project settings**
   - Pass excluded projects to aggregation
   - Only sync worklogs for enabled projects

### Task 2: Update `worklogService.js`

**File:** `forge-app/src/services/worklog/worklogService.js`

**Changes:**

1. **Add project-level sync check in `syncCurrentUserWorklogs()`**
   - Before syncing an issue, check if that project has sync disabled
   - Query `tracking_settings` for the issue's project key

2. **Create helper function `isWorklogSyncEnabledForProject()`**
   ```javascript
   async function isWorklogSyncEnabledForProject(supabaseConfig, organizationId, projectKey) {
     // 1. Check project-specific setting
     // 2. Fall back to org-level setting
     // 3. Default to false if no settings exist
   }
   ```

### Task 3: Add Helper Functions

**File:** `forge-app/src/services/scheduledWorklogSync.js` (or new utility file)

**New functions:**

1. **`buildProjectSyncMap()`** - Build map of which projects have sync enabled/disabled
2. **`getEnabledProjectsForOrg()`** - Get list of projects with sync enabled for an org
3. **`getDisabledProjectsForOrg()`** - Get list of projects with sync explicitly disabled

### Task 4: Update Activity Records Query

**Changes to `aggregateTrackedTime()`:**

```javascript
// Current query (simplified)
`activity_records?organization_id=eq.${orgId}&...`

// New query - exclude disabled projects
`activity_records?organization_id=eq.${orgId}&project_key=not.in.(${disabledProjects})&...`
```

## Logic Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Scheduled Sync Trigger                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Fetch ALL tracking_settings (org + project level)          │
│  - organization_id, project_key, jira_worklog_sync_enabled  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Build Project Sync Map per Organization                    │
│  {                                                          │
│    "org-uuid-1": {                                          │
│      orgEnabled: true,                                      │
│      projects: {                                            │
│        "PROJ-A": true,   // explicitly enabled              │
│        "PROJ-B": false,  // explicitly disabled             │
│        // PROJ-C: inherits org setting (true)               │
│      }                                                      │
│    }                                                        │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  For each organization with sync enabled:                   │
│  1. Get list of explicitly disabled projects                │
│  2. Aggregate time (excluding disabled projects)            │
│  3. Sync worklogs only for enabled projects                 │
└─────────────────────────────────────────────────────────────┘
```

## Priority Decision Matrix

| Scenario | Org Setting | Project Setting | Result |
|----------|-------------|-----------------|--------|
| Org enabled, no project setting | ✅ | - | ✅ Sync |
| Org enabled, project enabled | ✅ | ✅ | ✅ Sync |
| Org enabled, project disabled | ✅ | ❌ | ❌ Skip |
| Org disabled, no project setting | ❌ | - | ❌ Skip |
| Org disabled, project enabled | ❌ | ✅ | ✅ Sync |
| Org disabled, project disabled | ❌ | ❌ | ❌ Skip |

## Files to Modify

1. `forge-app/src/services/scheduledWorklogSync.js`
   - `runScheduledWorklogSync()` - Fetch project-level settings
   - `aggregateTrackedTime()` - Filter by enabled projects
   - `syncOrganization()` - Use project sync map
   - New helper functions

2. `forge-app/src/services/worklog/worklogService.js`
   - `syncCurrentUserWorklogs()` - Check project setting before sync
   - `aggregateUserTrackedTime()` - Filter by enabled projects
   - New helper function `isWorklogSyncEnabledForProject()`

## Testing Checklist

- [ ] Org sync enabled, no project settings → All projects sync
- [ ] Org sync enabled, Project A disabled → Project A skipped, others sync
- [ ] Org sync disabled, Project A enabled → Only Project A syncs
- [ ] Org sync disabled, all projects inherit → No sync
- [ ] Mixed settings → Correct per-project behavior

## Estimated Changes (Actual)

| File | Lines Added | Lines Modified |
|------|-------------|----------------|
| scheduledWorklogSync.js | ~80 | ~25 |
| worklogService.js | ~55 | ~20 |
| **Total** | ~135 | ~45 |

## Implementation Order

1. ✅ Create plan document (this file)
2. ✅ Add helper functions for project sync map
3. ✅ Update `scheduledWorklogSync.js` 
4. ✅ Update `worklogService.js`
5. 🔲 Test all scenarios
6. 🔲 Deploy and verify
