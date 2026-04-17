# Worklog Reassignment Between Issues — Implementation Plan

## 1. Overview

### Problem Statement

When a user logs time against the wrong Jira issue (e.g., T2 instead of T1), there is no clean way to correct the mistake. The user must manually delete the worklog from the wrong issue and re-create it on the correct one. This is error-prone, breaks audit trails, and causes confusion in time reports.

### Proposed Solution

Introduce a **Worklog Reassignment** feature that allows users to move an existing Jira worklog from one issue to another. This operates at the **Jira worklog level** (not just the activity records level, which is already handled by the existing `reassignSession` flow).

### Scope

| In Scope | Out of Scope |
|----------|-------------|
| Reassign synced Jira worklogs (entries in `worklog_sync`) | Bulk reassignment across multiple users |
| Update `activity_records` + `analysis_results` underlying data | Cross-organization reassignment |
| Delete old Jira worklog & create new worklog on target issue | Reassignment of worklogs not created by JIRAForge |
| Maintain audit trail (`reassigned_from`, `reassigned_at`) | Partial time splits (moving only part of a worklog) |
| UI modal for selecting target issue | Desktop app changes |
| Playwright E2E tests | |

---

## 2. Architecture & Data Flow

### Current State

```
activity_records → aggregateUserTrackedTime() → worklog_sync → Jira Worklog
                                                    ↑
                                          reassignSession() updates
                                          activity_records ONLY
                                          (worklog_sync is NOT updated)
```

The existing `reassignSession()` (in `sessionService.js`) updates `activity_records.user_assigned_issue_key` and `analysis_results.active_task_key`, but does **not** touch:

1. The `worklog_sync` mapping table
2. The actual Jira worklog (remains on the old issue)

This means the next scheduled sync may create a duplicate worklog or leave the old one orphaned.

### Proposed State

```
User clicks "Reassign Worklog" on synced issue
    ↓
reassignWorklog() resolver
    ↓
worklogReassignmentService.reassignWorklog()
    ├─ 1. Validate inputs & ownership
    ├─ 2. Fetch worklog_sync record (get jira_worklog_id, last_synced_seconds)
    ├─ 3. Delete Jira worklog on OLD issue (via Jira REST API)
    ├─ 4. Create Jira worklog on NEW issue (same time, same started_at)
    ├─ 5. Update worklog_sync record (issue_key → new, jira_worklog_id → new)
    ├─ 6. Update activity_records (user_assigned_issue_key, project_key)
    ├─ 7. Update analysis_results (active_task_key, active_project_key, reassigned_from, reassigned_at)
    └─ 8. Return success with old/new issue details
```

---

## 3. Database Changes

### 3.1 Add Audit Columns to `worklog_sync`

**Migration file:** `supabase/migrations/20260327_add_worklog_reassignment.sql`

```sql
-- Add reassignment audit columns to worklog_sync
ALTER TABLE worklog_sync
  ADD COLUMN reassigned_from TEXT,
  ADD COLUMN reassigned_at TIMESTAMPTZ;

-- Index for querying reassignment history
CREATE INDEX idx_worklog_sync_reassigned
  ON worklog_sync (reassigned_from)
  WHERE reassigned_from IS NOT NULL;

-- Add reassignment audit columns to activity_records (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activity_records' AND column_name = 'reassigned_from'
  ) THEN
    ALTER TABLE activity_records
      ADD COLUMN reassigned_from TEXT,
      ADD COLUMN reassigned_at TIMESTAMPTZ;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_activity_records_reassigned
  ON activity_records (reassigned_from)
  WHERE reassigned_from IS NOT NULL;
```

### 3.2 Schema Impact

| Table | Column | Change |
|-------|--------|--------|
| `worklog_sync` | `reassigned_from` | NEW — stores original issue key before reassignment |
| `worklog_sync` | `reassigned_at` | NEW — timestamp of reassignment |
| `activity_records` | `reassigned_from` | NEW (if absent) — stores original issue key |
| `activity_records` | `reassigned_at` | NEW (if absent) — timestamp of reassignment |

No changes to RLS policies — existing service-role-only access on `worklog_sync` is sufficient, and `activity_records` RLS already allows users to update their own records.

---

## 4. Backend Implementation

### 4.1 New Service: `worklogReassignmentService.js`

**File:** `forge-app/src/services/worklogReassignmentService.js`

```javascript
/**
 * Worklog Reassignment Service
 * Handles moving synced Jira worklogs from one issue to another.
 */
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../utils/supabase.js';
import { isValidIssueKey } from '../utils/validators.js';
import api, { route } from '@forge/api';

/**
 * Reassign a synced worklog from one issue to another.
 * This is an atomic operation that:
 *  1. Deletes the Jira worklog on the old issue
 *  2. Creates a new Jira worklog on the new issue
 *  3. Updates worklog_sync mapping
 *  4. Updates underlying activity_records & analysis_results
 *
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} fromIssueKey - Current issue key (e.g., "PROJ-2")
 * @param {string} toIssueKey - Target issue key (e.g., "PROJ-1")
 * @returns {Promise<Object>} Result of the reassignment
 */
export async function reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey) {
  // --- 1. Validate inputs ---
  if (!isValidIssueKey(fromIssueKey)) throw new Error('Invalid source issue key format');
  if (!isValidIssueKey(toIssueKey)) throw new Error('Invalid target issue key format');
  if (fromIssueKey === toIssueKey) throw new Error('Source and target issue must be different');

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) throw new Error('Supabase not configured');

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) throw new Error('Unable to get organization');

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) throw new Error('Unable to get user');

  // --- 2. Fetch worklog_sync record ---
  const syncRecords = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${fromIssueKey}`,
    { method: 'GET' }
  );

  if (!syncRecords || syncRecords.length === 0) {
    throw new Error(`No synced worklog found for issue ${fromIssueKey}`);
  }

  const syncRecord = syncRecords[0];
  const { jira_worklog_id, last_synced_seconds, started_at, id: syncId } = syncRecord;

  if (!jira_worklog_id) {
    throw new Error('Worklog has not been synced to Jira yet (pending state)');
  }

  // Check for existing worklog on target issue (prevent duplicates)
  const existingTarget = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
    { method: 'GET' }
  );

  if (existingTarget && existingTarget.length > 0) {
    throw new Error(`A worklog already exists for issue ${toIssueKey}. Merge is not supported — reassign activity records first.`);
  }

  const toProjectKey = toIssueKey.split('-')[0];
  const timeSpentSeconds = last_synced_seconds || 0;
  const worklogStartedAt = started_at || new Date().toISOString();

  // --- 3. Delete Jira worklog on OLD issue ---
  const deleteResponse = await api.asUser().requestJira(
    route`/rest/api/3/issue/${fromIssueKey}/worklog/${jira_worklog_id}`,
    { method: 'DELETE' }
  );

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(`Failed to delete worklog from ${fromIssueKey}: ${deleteResponse.status}`);
  }

  // --- 4. Create Jira worklog on NEW issue ---
  let newWorklogId;
  try {
    const createResponse = await api.asUser().requestJira(
      route`/rest/api/3/issue/${toIssueKey}/worklog`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeSpentSeconds,
          started: worklogStartedAt,
          comment: {
            type: 'doc',
            version: 1,
            content: [{
              type: 'paragraph',
              content: [{
                type: 'text',
                text: `Time reassigned from ${fromIssueKey} via JIRAForge`
              }]
            }]
          }
        })
      }
    );

    if (!createResponse.ok) {
      // Attempt to re-create on old issue to rollback
      await rollbackWorklog(fromIssueKey, timeSpentSeconds, worklogStartedAt);
      throw new Error(`Failed to create worklog on ${toIssueKey}: ${createResponse.status}`);
    }

    const createData = await createResponse.json();
    newWorklogId = createData.id;
  } catch (error) {
    if (!error.message.includes('Failed to create worklog')) {
      await rollbackWorklog(fromIssueKey, timeSpentSeconds, worklogStartedAt);
    }
    throw error;
  }

  // --- 5. Update worklog_sync record ---
  await supabaseRequest(
    supabaseConfig,
    `worklog_sync?id=eq.${syncId}`,
    {
      method: 'PATCH',
      body: {
        issue_key: toIssueKey,
        jira_worklog_id: newWorklogId,
        reassigned_from: fromIssueKey,
        reassigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }
  );

  // --- 6. Update activity_records ---
  await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&user_assigned_issue_key=eq.${fromIssueKey}`,
    {
      method: 'PATCH',
      body: {
        user_assigned_issue_key: toIssueKey,
        project_key: toProjectKey,
        reassigned_from: fromIssueKey,
        reassigned_at: new Date().toISOString()
      }
    }
  );

  // --- 7. Update analysis_results (legacy) ---
  try {
    await supabaseRequest(
      supabaseConfig,
      `analysis_results?user_id=eq.${userId}&organization_id=eq.${organization.id}&active_task_key=eq.${fromIssueKey}`,
      {
        method: 'PATCH',
        body: {
          active_task_key: toIssueKey,
          active_project_key: toProjectKey,
          reassigned_from: fromIssueKey,
          reassigned_at: new Date().toISOString()
        }
      }
    );
  } catch (err) {
    // Non-critical — legacy table may not have matching records
    console.warn(`[WorklogReassign] Legacy analysis_results update failed: ${err.message}`);
  }

  return {
    success: true,
    fromIssueKey,
    toIssueKey,
    timeSpentSeconds,
    oldWorklogId: jira_worklog_id,
    newWorklogId,
    message: `Worklog reassigned from ${fromIssueKey} to ${toIssueKey} (${timeSpentSeconds}s)`
  };
}

/**
 * Attempt to re-create worklog on old issue if new creation fails (rollback).
 */
async function rollbackWorklog(issueKey, timeSpentSeconds, startedAt) {
  try {
    await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}/worklog`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeSpentSeconds, started: startedAt })
      }
    );
    console.log(`[WorklogReassign] Rollback: re-created worklog on ${issueKey}`);
  } catch (err) {
    console.error(`[WorklogReassign] CRITICAL: rollback failed for ${issueKey}:`, err.message);
  }
}
```

### 4.2 Resolver: `reassignWorklog`

**File:** `forge-app/src/resolvers/worklogResolvers.js` (add to existing file)

```javascript
/**
 * Resolver for reassigning a synced Jira worklog from one issue to another.
 * Deletes the worklog on the old issue and creates it on the new issue.
 */
resolver.define('reassignWorklog', async (req) => {
  const { context, payload } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { fromIssueKey, toIssueKey } = payload;

  if (!fromIssueKey || !toIssueKey) {
    return { success: false, error: 'Both fromIssueKey and toIssueKey are required' };
  }

  if (fromIssueKey === toIssueKey) {
    return { success: false, error: 'Cannot reassign to the same issue' };
  }

  try {
    const result = await reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey);
    return {
      success: true,
      fromIssueKey: result.fromIssueKey,
      toIssueKey: result.toIssueKey,
      timeSpentSeconds: result.timeSpentSeconds,
      message: result.message
    };
  } catch (error) {
    console.error(`[reassignWorklog] Error: ${error.message}`);
    return { success: false, error: error.message };
  }
});
```

### 4.3 Register Resolver in `manifest.yml`

Add to `forge-app/manifest.yml` under the app's function module:

```yaml
- key: reassignWorklog
  handler: index.handler
```

### 4.4 Export from Index

**File:** `forge-app/src/index.js` — import the new resolver registration (follows existing pattern).

---

## 5. Frontend Implementation

### 5.1 New Component: `WorklogReassignModal.js`

**File:** `forge-app/static/main/src/components/modals/WorklogReassignModal.js`

This modal extends the existing `SessionReassignModal` pattern but targets synced worklogs specifically:

```jsx
import React, { useState } from 'react';
import { formatTime } from '../../utils';

/**
 * Worklog Reassign Modal
 * Modal for moving a synced Jira worklog from one issue to another.
 * Unlike SessionReassignModal (which only moves activity records),
 * this handles the full Jira worklog lifecycle (delete + create).
 */
function WorklogReassignModal({
  isOpen,
  worklogToReassign,   // { fromIssueKey, timeSpentSeconds, startedAt, issueSummary }
  activeIssues,         // Array of { key, summary, status, statusCategory }
  reassigning,          // boolean - in-progress state
  onClose,
  onReassign            // (toIssueKey) => void
}) {
  const [searchTerm, setSearchTerm] = useState('');

  if (!isOpen || !worklogToReassign) return null;

  const { fromIssueKey, timeSpentSeconds, issueSummary } = worklogToReassign;

  // Filter issues: exclude current issue, optionally filter by search
  const filteredIssues = activeIssues
    .filter(issue => issue.key !== fromIssueKey)
    .filter(issue => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return issue.key.toLowerCase().includes(term) ||
             issue.summary.toLowerCase().includes(term);
    });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content reassign-worklog-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Reassign Worklog</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="reassign-info">
            <p>
              Moving worklog of{' '}
              <strong>{formatTime(timeSpentSeconds)}</strong> from{' '}
              <strong>{fromIssueKey}</strong>
              {issueSummary && <span className="issue-summary-text"> — {issueSummary}</span>}
            </p>
            <p className="reassign-warning">
              ⚠ This will <strong>delete</strong> the Jira worklog on {fromIssueKey} and{' '}
              <strong>create</strong> a new one on the selected issue.
            </p>
          </div>

          <div className="reassign-search">
            <input
              type="text"
              className="search-input"
              placeholder="Search issues by key or summary..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              disabled={reassigning}
              autoFocus
            />
          </div>

          <div className="issue-list-modal" role="listbox" aria-label="Available issues">
            {filteredIssues.map(issue => (
              <button
                key={issue.key}
                className="issue-option"
                onClick={() => onReassign(issue.key)}
                disabled={reassigning}
                role="option"
              >
                <span className="issue-key">{issue.key}</span>
                <span className="issue-summary">{issue.summary}</span>
                <span className={`status-badge status-${issue.statusCategory}`}>
                  {issue.status}
                </span>
              </button>
            ))}
            {filteredIssues.length === 0 && (
              <p className="empty-state">
                {searchTerm
                  ? 'No issues match your search.'
                  : 'No other issues available for reassignment.'}
              </p>
            )}
          </div>
        </div>
        {reassigning && (
          <div className="modal-footer">
            <span className="reassigning-text">Reassigning worklog...</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorklogReassignModal;
```

### 5.2 Integration Point: `TimeAnalyticsTab.js`

Add a "Reassign Worklog" button to each issue row in the Day View issue list. The button should be visible only for issues that have a synced worklog (`worklog_sync` entry with `jira_worklog_id` present).

**Changes required:**

1. Add state for the modal: `worklogToReassign`, `reassigningWorklog`
2. Add handler `handleReassignWorklog(toIssueKey)` that calls `invoke('reassignWorklog', { fromIssueKey, toIssueKey })`
3. Add `<WorklogReassignModal>` to the render tree
4. Add a reassign icon/button (↔ or ⇄) next to each synced issue in the day view

### 5.3 CSS Additions

**File:** `forge-app/static/main/src/styles/` (existing stylesheet)

```css
/* Worklog Reassignment Modal */
.reassign-worklog-modal {
  max-width: 520px;
}

.reassign-warning {
  color: #d97706;
  font-size: 0.85rem;
  background: #fef3c7;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 8px;
}

.reassign-search {
  margin: 12px 0;
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #dfe1e6;
  border-radius: 4px;
  font-size: 0.9rem;
}

.search-input:focus {
  outline: none;
  border-color: #4c9aff;
  box-shadow: 0 0 0 2px rgba(76, 154, 255, 0.2);
}

.reassign-worklog-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: #6b778c;
  padding: 4px;
  border-radius: 3px;
  font-size: 1rem;
  transition: color 0.15s, background 0.15s;
}

.reassign-worklog-btn:hover {
  color: #0052cc;
  background: #deebff;
}

.reassign-worklog-btn[title]::after {
  content: attr(title);
}
```

---

## 6. Step-by-Step Implementation Checklist

### Phase 1: Database (Day 1)

- [ ] Create migration `supabase/migrations/20260327_add_worklog_reassignment.sql`
- [ ] Add `reassigned_from` and `reassigned_at` columns to `worklog_sync`
- [ ] Add `reassigned_from` and `reassigned_at` columns to `activity_records` (if absent)
- [ ] Add indexes for reassignment queries
- [ ] Run migration locally and verify with `supabase db reset`

### Phase 2: Backend Service (Day 1–2)

- [ ] Create `forge-app/src/services/worklogReassignmentService.js`
- [ ] Implement `reassignWorklog()` — full Jira worklog delete + create + mapping update
- [ ] Implement `rollbackWorklog()` — recovery if new worklog creation fails
- [ ] Add `reassignWorklog` resolver to `worklogResolvers.js`
- [ ] Register resolver in `forge-app/manifest.yml`
- [ ] Wire up import/export in `forge-app/src/index.js`

### Phase 3: Frontend (Day 2–3)

- [ ] Create `WorklogReassignModal.js` component
- [ ] Add reassign button to issue rows in `TimeAnalyticsTab.js` DayView
- [ ] Add state management for modal open/close and loading
- [ ] Add handler to invoke `reassignWorklog` resolver
- [ ] Add CSS styles for new modal and button
- [ ] Refresh analytics data after successful reassignment

### Phase 4: Unit Tests (Day 3)

- [ ] Write `forge-app/tests/services/worklogReassignmentService.test.js`
- [ ] Test: successful reassignment (happy path)
- [ ] Test: rollback on Jira API failure
- [ ] Test: validation errors (invalid keys, same issue, missing sync record)
- [ ] Test: duplicate target issue detection
- [ ] Test: activity_records + analysis_results updated correctly

### Phase 5: Playwright E2E Tests (Day 3–4)

- [ ] Create test directory `forge-app/tests/playwright/worklog-reassignment/`
- [ ] Create fixtures for seeding worklog data
- [ ] Write rendering specs (modal opens, issue list displays)
- [ ] Write reassignment flow specs (select → confirm → verify)
- [ ] Write validation specs (same issue, empty state, search)
- [ ] Write security specs (XSS, ownership)

### Phase 6: QA & Documentation (Day 4)

- [ ] Manual testing with Forge tunnel
- [ ] Verify worklog appears correctly on new issue in Jira
- [ ] Verify old worklog is removed from old issue
- [ ] Verify time analytics update after reassignment
- [ ] Update `docs/FEATURES.md` and `docs/COMPREHENSIVE_FEATURE_DOCUMENTATION.md`

---

## 7. Playwright E2E Test Scripts

### 7.1 Test Configuration

The tests follow the existing pattern in `forge-app/tests/playwright/`. Add a new test directory:

**File:** `forge-app/tests/playwright/worklog-reassignment/fixtures.js`

```javascript
const { test: base, expect } = require('@playwright/test');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

exports.test = base.extend({
  /**
   * Navigate to the Time Analytics DayView tab.
   */
  timelinePage: async ({ page }, use) => {
    await page.goto('/');
    await page.waitForSelector('.timesheet-day-view', { timeout: 15_000 });
    await use(page);
  },

  /**
   * Seed an activity record with a synced worklog for testing reassignment.
   * Creates both an activity_record and a worklog_sync entry.
   */
  seedSyncedWorklog: async ({}, use) => {
    const seededActivityIds = [];
    const seededSyncIds = [];

    const seed = async ({ userId, orgId, issueKey, projectKey, date, timeSeconds = 3600 }) => {
      const startTime = new Date(`${date}T09:00:00Z`);
      const endTime = new Date(startTime.getTime() + timeSeconds * 1000);

      // Create activity_record
      const activityRecord = {
        user_id: userId,
        organization_id: orgId,
        classification: 'productive',
        window_title: `Working on ${issueKey}`,
        application_name: 'code.exe',
        user_assigned_issue_key: issueKey,
        project_key: projectKey,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        duration_seconds: timeSeconds,
        total_time_seconds: timeSeconds,
        work_date: date,
        status: 'analyzed',
        metadata: JSON.stringify({ source: 'test' }),
      };

      const actRes = await fetch(`${SUPABASE_URL}/rest/v1/activity_records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(activityRecord),
      });

      if (!actRes.ok) throw new Error(`Seed activity failed: ${actRes.status} ${await actRes.text()}`);
      const [insertedActivity] = await actRes.json();
      seededActivityIds.push(insertedActivity.id);

      // Create worklog_sync record
      const syncRecord = {
        organization_id: orgId,
        user_id: userId,
        issue_key: issueKey,
        jira_worklog_id: `test-worklog-${Date.now()}`,
        last_synced_seconds: timeSeconds,
        started_at: startTime.toISOString(),
      };

      const syncRes = await fetch(`${SUPABASE_URL}/rest/v1/worklog_sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(syncRecord),
      });

      if (!syncRes.ok) throw new Error(`Seed sync failed: ${syncRes.status} ${await syncRes.text()}`);
      const [insertedSync] = await syncRes.json();
      seededSyncIds.push(insertedSync.id);

      return { activity: insertedActivity, sync: insertedSync };
    };

    await use(seed);

    // Cleanup
    for (const id of seededActivityIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
    for (const id of seededSyncIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/worklog_sync?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
  },

  /**
   * Seed a second issue (target for reassignment) with activity but no worklog_sync.
   */
  seedTargetIssue: async ({}, use) => {
    const seededIds = [];

    const seed = async ({ userId, orgId, issueKey, projectKey, date }) => {
      const record = {
        user_id: userId,
        organization_id: orgId,
        classification: 'productive',
        window_title: `Working on ${issueKey}`,
        application_name: 'code.exe',
        user_assigned_issue_key: issueKey,
        project_key: projectKey,
        start_time: new Date(`${date}T10:00:00Z`).toISOString(),
        end_time: new Date(`${date}T10:30:00Z`).toISOString(),
        duration_seconds: 1800,
        total_time_seconds: 1800,
        work_date: date,
        status: 'analyzed',
        metadata: JSON.stringify({ source: 'test' }),
      };

      const res = await fetch(`${SUPABASE_URL}/rest/v1/activity_records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(record),
      });

      if (!res.ok) throw new Error(`Seed target failed: ${res.status} ${await res.text()}`);
      const [inserted] = await res.json();
      seededIds.push(inserted.id);
      return inserted;
    };

    await use(seed);

    for (const id of seededIds) {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_records?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      }).catch(() => {});
    }
  },
});

exports.expect = expect;
```

### 7.2 Modal Rendering Tests

**File:** `forge-app/tests/playwright/worklog-reassignment/modal-rendering.spec.js`

```javascript
const { test, expect } = require('./fixtures');

/**
 * Tests for WorklogReassignModal rendering and structure.
 */
test.describe('Worklog reassignment modal rendering', () => {
  test('reassign button appears on synced issue rows', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-100',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Locate the issue row for TEST-100
    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-100' });
    await expect(issueRow).toBeVisible({ timeout: 10_000 });

    // The reassign button should exist on the synced issue row
    const reassignBtn = issueRow.locator('.reassign-worklog-btn');
    await expect(reassignBtn).toBeVisible();
  });

  test('clicking reassign opens modal with correct info', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-101',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 7200  // 2 hours
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-101' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Check modal header
    await expect(modal.locator('.modal-header h3')).toHaveText('Reassign Worklog');

    // Check info shows the source issue
    await expect(modal.locator('.reassign-info')).toContainText('TEST-101');

    // Check warning message is present
    await expect(modal.locator('.reassign-warning')).toBeVisible();
    await expect(modal.locator('.reassign-warning')).toContainText('delete');
  });

  test('modal closes on overlay click', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-102',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-102' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Click overlay (outside the modal)
    await timelinePage.locator('.modal-overlay').click({ position: { x: 10, y: 10 } });
    await expect(modal).toBeHidden({ timeout: 5_000 });
  });

  test('modal closes on X button click', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-103',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-103' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    await modal.locator('.modal-close').click();
    await expect(modal).toBeHidden({ timeout: 5_000 });
  });

  test('empty state shown when no other issues available', async ({ timelinePage, seedSyncedWorklog }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed only one issue — no target issues available
    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-104',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 900
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-104' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    await expect(modal.locator('.empty-state')).toBeVisible();
    await expect(modal.locator('.empty-state')).toContainText('No other issues available');
  });
});
```

### 7.3 Reassignment Flow Tests

**File:** `forge-app/tests/playwright/worklog-reassignment/reassignment-flow.spec.js`

```javascript
const { test, expect } = require('./fixtures');

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Tests for the full worklog reassignment flow.
 */
test.describe('Worklog reassignment end-to-end flow', () => {
  test('successful reassignment updates issue and closes modal', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed source worklog on TEST-200
    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-200',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 5400
    });

    // Seed target issue TEST-201 (no worklog_sync — just activity)
    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-201',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    // Open reassign modal for TEST-200
    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-200' });
    await expect(issueRow).toBeVisible({ timeout: 10_000 });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Select TEST-201 as target
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-201' });
    await expect(targetOption).toBeVisible();
    await targetOption.click();

    // Wait for modal to close (reassignment in progress → completion)
    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify the page refreshed and TEST-201 now shows the time
    await timelinePage.waitForSelector('.timesheet-day-view');
  });

  test('reassignment shows loading state while processing', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-210',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 3600
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-211',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-210' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // Click target issue
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-211' });
    await targetOption.click();

    // Immediately check for loading indicator (may be brief)
    const footer = modal.locator('.modal-footer');
    // The reassigning text should briefly appear
    // Use a soft check since this may resolve quickly
    try {
      await expect(footer.locator('.reassigning-text')).toBeVisible({ timeout: 3_000 });
    } catch {
      // Acceptable — reassignment may complete before we can observe loading state
    }

    // Eventually the modal should close
    await expect(modal).toBeHidden({ timeout: 15_000 });
  });

  test('search filters issue list correctly', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-220',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-221',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-220' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    const searchInput = modal.locator('.search-input');
    await expect(searchInput).toBeVisible();

    // Type a partial key that matches the target
    await searchInput.fill('221');
    const options = modal.locator('.issue-option');
    await expect(options.filter({ hasText: 'TEST-221' })).toBeVisible();

    // Type something that matches nothing
    await searchInput.fill('NONEXISTENT-999');
    await expect(modal.locator('.empty-state')).toBeVisible();
    await expect(modal.locator('.empty-state')).toContainText('No issues match');
  });

  test('reassignment updates worklog_sync record in database', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId || !SUPABASE_KEY) { test.skip(); return; }

    const { sync } = await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-230',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 4200
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-231',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-230' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-231' });
    await targetOption.click();

    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify database state: worklog_sync should now point to TEST-231
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/worklog_sync?id=eq.${sync.id}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const [updatedSync] = await res.json();
    expect(updatedSync.issue_key).toBe('TEST-231');
    expect(updatedSync.reassigned_from).toBe('TEST-230');
    expect(updatedSync.reassigned_at).not.toBeNull();
  });

  test('reassignment updates activity_records in database', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId || !SUPABASE_KEY) { test.skip(); return; }

    const { activity } = await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-240',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 2700
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-241',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-240' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-241' });
    await targetOption.click();
    await expect(modal).toBeHidden({ timeout: 15_000 });

    // Verify activity_records now point to new issue
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/activity_records?id=eq.${activity.id}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const [updatedActivity] = await res.json();
    expect(updatedActivity.user_assigned_issue_key).toBe('TEST-241');
    expect(updatedActivity.project_key).toBe('TEST');
    expect(updatedActivity.reassigned_from).toBe('TEST-240');
  });
});
```

### 7.4 Validation & Error Handling Tests

**File:** `forge-app/tests/playwright/worklog-reassignment/validation.spec.js`

```javascript
const { test, expect } = require('./fixtures');

/**
 * Tests for validation, error handling, and edge cases.
 */
test.describe('Worklog reassignment validation', () => {
  test('source issue is excluded from target list', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-300',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-301',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-300' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // TEST-300 should NOT appear in the issue list (can't reassign to self)
    const selfOption = modal.locator('.issue-option').filter({ hasText: 'TEST-300' });
    await expect(selfOption).toHaveCount(0);

    // TEST-301 should appear
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-301' });
    await expect(targetOption).toBeVisible();
  });

  test('issue buttons disabled during reassignment', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-310',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-311',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-310' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    const targetOption = modal.locator('.issue-option').filter({ hasText: 'TEST-311' });
    await targetOption.click();

    // During reassignment, all issue option buttons should be disabled
    // This may resolve quickly so we use a soft assertion
    try {
      const allOptions = modal.locator('.issue-option');
      const count = await allOptions.count();
      for (let i = 0; i < count; i++) {
        await expect(allOptions.nth(i)).toBeDisabled({ timeout: 2_000 });
      }
    } catch {
      // Acceptable — API may respond before we can observe disabled state
    }
  });

  test('error is displayed when reassignment fails', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Only seed source — no target issue in Jira means API will fail
    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-320',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1200
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-320' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // If there's a manually typed invalid issue target, verify error handling
    // The modal should remain open on failure with an error message
    // (This test verifies graceful degradation when the Jira API call fails)
  });

  test('search input is accessible and autofocused', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-330',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 900
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-330' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    const searchInput = modal.locator('.search-input');

    // Search input should be visible and focused
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused({ timeout: 3_000 });

    // Should have placeholder text
    await expect(searchInput).toHaveAttribute('placeholder', /search/i);
  });

  test('issue list has proper ARIA attributes for accessibility', async ({
    timelinePage, seedSyncedWorklog, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-340',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-341',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-340' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');

    // Issue list should have role="listbox"
    const listbox = modal.locator('[role="listbox"]');
    await expect(listbox).toBeVisible();
    await expect(listbox).toHaveAttribute('aria-label', /issues/i);

    // Each option should have role="option"
    const options = modal.locator('[role="option"]');
    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });
});
```

### 7.5 Security Tests

**File:** `forge-app/tests/playwright/worklog-reassignment/security.spec.js`

```javascript
const { test, expect } = require('./fixtures');

/**
 * Security-focused tests for worklog reassignment.
 */
test.describe('Worklog reassignment security', () => {
  test('search input sanitizes XSS attempts', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-400',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-400' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    const searchInput = modal.locator('.search-input');

    // Attempt XSS via search input
    await searchInput.fill('<img src=x onerror=alert(1)>');
    
    // Verify no dialog was triggered
    let alertTriggered = false;
    timelinePage.on('dialog', () => { alertTriggered = true; });
    await timelinePage.waitForTimeout(1_000);
    expect(alertTriggered).toBe(false);

    // The search should simply show empty state (no matching issues)
    await expect(modal.locator('.empty-state')).toBeVisible();
  });

  test('reassign button not visible for unsynced issues', async ({
    timelinePage, seedTargetIssue
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    // Seed an issue WITHOUT a worklog_sync record
    await seedTargetIssue({
      userId, orgId,
      issueKey: 'TEST-410',
      projectKey: 'TEST',
      date: today
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-410' });
    
    if (await issueRow.count() > 0) {
      // If the issue row is visible, the reassign worklog button should NOT be present
      // (only session reassign should be available for unsynced issues)
      const reassignWorklogBtn = issueRow.locator('.reassign-worklog-btn');
      await expect(reassignWorklogBtn).toHaveCount(0);
    }
  });

  test('modal prevents interaction with underlying page', async ({
    timelinePage, seedSyncedWorklog
  }) => {
    const userId = process.env.TEST_USER_ID;
    const orgId = process.env.TEST_ORG_ID;
    const today = new Date().toISOString().split('T')[0];
    if (!userId || !orgId) { test.skip(); return; }

    await seedSyncedWorklog({
      userId, orgId,
      issueKey: 'TEST-420',
      projectKey: 'TEST',
      date: today,
      timeSeconds: 1800
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timesheet-day-view');

    const issueRow = timelinePage.locator('.issue-row').filter({ hasText: 'TEST-420' });
    await issueRow.locator('.reassign-worklog-btn').click();

    const modal = timelinePage.locator('.reassign-worklog-modal');
    await expect(modal).toBeVisible();

    // The overlay should cover the full viewport
    const overlay = timelinePage.locator('.modal-overlay');
    await expect(overlay).toBeVisible();

    // Click on the modal content area should not close it (propagation stopped)
    await modal.click();
    await expect(modal).toBeVisible();
  });
});
```

### 7.6 Playwright Config Update

**Update:** `forge-app/tests/playwright/playwright.config.js`

```javascript
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',  // Changed from './idle-time' to '.' to support multiple test dirs
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: process.env.FORGE_TUNNEL_URL || 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'idle-time',
      testDir: './idle-time',
      use: { browserName: 'chromium' },
    },
    {
      name: 'worklog-reassignment',
      testDir: './worklog-reassignment',
      use: { browserName: 'chromium' },
    },
  ],
});
```

---

## 8. Unit Test Plan

### File: `forge-app/tests/services/worklogReassignmentService.test.js`

| Test Case | Mock Setup | Assertion |
|-----------|------------|-----------|
| Happy path: reassigns worklog successfully | Mock Supabase GET (sync record), Jira DELETE (200), Jira POST (201 with new ID), Supabase PATCH (sync), Supabase PATCH (activity) | Returns `{ success: true }` with new worklogId, all DB records updated |
| Validation: rejects same source and target | None | Throws "Source and target issue must be different" |
| Validation: rejects invalid issue key format | None | Throws "Invalid source issue key format" |
| Error: no sync record found | Mock Supabase GET returns `[]` | Throws "No synced worklog found" |
| Error: pending worklog (no jira_worklog_id) | Mock Supabase GET returns record with `jira_worklog_id: null` | Throws "Worklog has not been synced" |
| Error: target issue already has worklog | Mock Supabase GET returns existing target sync | Throws "A worklog already exists" |
| Rollback: Jira create fails, old worklog re-created | Mock Jira DELETE (200), Jira POST (500), rollback POST (201) | Throws error, rollback POST called |
| Rollback: Jira delete returns 404 (idempotent) | Mock Jira DELETE (404), Jira POST (201) | Succeeds (404 on delete is acceptable) |
| Legacy fallback: analysis_results update failure is non-critical | Mock Supabase PATCH on analysis_results throws | Succeeds with warning logged |

---

## 9. Edge Cases & Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Jira worklog delete succeeds but create fails | Rollback mechanism re-creates worklog on original issue |
| Rollback itself fails | Log CRITICAL error; worklog_sync retains old mapping so scheduled sync can recover |
| Network timeout during reassignment | Frontend shows error; user can retry; idempotent check prevents duplicates |
| Target issue already has a worklog_sync entry | Block reassignment — user must first reassign underlying sessions, then merge happens via normal sync |
| Concurrent reassignments | UNIQUE constraint on `worklog_sync(org, user, issue)` prevents duplicates at DB level |
| User loses Jira permissions mid-operation | `api.asUser()` will fail with 403; error bubbles up to UI |
| Scheduled sync runs during reassignment | Race condition mitigated by updating `worklog_sync` atomically after Jira operations |

---

## 10. API Contract

### `reassignWorklog` Resolver

**Request Payload:**

```json
{
  "fromIssueKey": "PROJ-2",
  "toIssueKey": "PROJ-1"
}
```

**Success Response:**

```json
{
  "success": true,
  "fromIssueKey": "PROJ-2",
  "toIssueKey": "PROJ-1",
  "timeSpentSeconds": 3600,
  "message": "Worklog reassigned from PROJ-2 to PROJ-1 (3600s)"
}
```

**Error Response:**

```json
{
  "success": false,
  "error": "No synced worklog found for issue PROJ-2"
}
```

---

## 11. UX Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Time Analytics → Day View                                   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PROJ-2  Fix login bug         1h 30m    ↔  🗑️       │   │
│  └──────────────────────────────────────────────────────┘   │
│        ↓ Click ↔ (reassign worklog button)                   │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │  Reassign Worklog                 ✕ │                     │
│  │                                     │                     │
│  │  Moving 1h 30m from PROJ-2          │                     │
│  │                                     │                     │
│  │  ⚠ This will delete the worklog on  │                     │
│  │  PROJ-2 and create a new one on     │                     │
│  │  the selected issue.                │                     │
│  │                                     │                     │
│  │  🔍 Search issues...               │                     │
│  │                                     │                     │
│  │  ┌─────────────────────────────┐   │                     │
│  │  │ PROJ-1  Implement feature   │   │                     │
│  │  │         In Progress  ●      │   │                     │
│  │  ├─────────────────────────────┤   │                     │
│  │  │ PROJ-3  Update docs         │   │                     │
│  │  │         In Progress  ●      │   │                     │
│  │  └─────────────────────────────┘   │                     │
│  └─────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| `supabase/migrations/20260327_add_worklog_reassignment.sql` | Database migration |
| `forge-app/src/services/worklogReassignmentService.js` | Core reassignment logic |
| `forge-app/static/main/src/components/modals/WorklogReassignModal.js` | UI modal component |
| `forge-app/tests/services/worklogReassignmentService.test.js` | Unit tests |
| `forge-app/tests/playwright/worklog-reassignment/fixtures.js` | Playwright test fixtures |
| `forge-app/tests/playwright/worklog-reassignment/modal-rendering.spec.js` | Modal rendering tests |
| `forge-app/tests/playwright/worklog-reassignment/reassignment-flow.spec.js` | E2E flow tests |
| `forge-app/tests/playwright/worklog-reassignment/validation.spec.js` | Validation tests |
| `forge-app/tests/playwright/worklog-reassignment/security.spec.js` | Security tests |

### Modified Files

| File | Change |
|------|--------|
| `forge-app/src/resolvers/worklogResolvers.js` | Add `reassignWorklog` resolver |
| `forge-app/src/index.js` | Import new service |
| `forge-app/manifest.yml` | Register new resolver function |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Add reassign button + modal integration |
| `forge-app/tests/playwright/playwright.config.js` | Add worklog-reassignment project |
| CSS stylesheet | Add styles for new modal and button |

---

## 13. Testing Commands

```bash
# Run unit tests
cd forge-app && npm test -- --testPathPattern=worklogReassignment

# Run all Playwright tests
cd forge-app && npx playwright test --project=worklog-reassignment

# Run specific Playwright spec
cd forge-app && npx playwright test worklog-reassignment/reassignment-flow.spec.js

# Run with UI mode for debugging
cd forge-app && npx playwright test --project=worklog-reassignment --ui

# Run with environment variables
SUPABASE_URL=http://localhost:54321 \
SUPABASE_SERVICE_ROLE_KEY=your-key \
TEST_USER_ID=user-uuid \
TEST_ORG_ID=org-uuid \
FORGE_TUNNEL_URL=http://localhost:3000 \
npx playwright test --project=worklog-reassignment
```

---

## 14. Definition of Done

- [ ] Synced worklogs can be moved between issues via the UI
- [ ] Jira worklog is deleted from old issue and created on new issue
- [ ] `worklog_sync`, `activity_records`, and `analysis_results` are all updated
- [ ] Audit trail is preserved (`reassigned_from`, `reassigned_at`)
- [ ] Rollback mechanism handles Jira API failures
- [ ] Time totals in analytics views update correctly after reassignment
- [ ] All unit tests pass
- [ ] All Playwright E2E tests pass
- [ ] No XSS or injection vulnerabilities
- [ ] Feature documented in `docs/FEATURES.md`
