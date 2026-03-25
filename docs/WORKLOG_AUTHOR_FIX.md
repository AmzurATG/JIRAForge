# Worklog Author Fix — "Itracker" → User's Real Name

**Date:** March 25, 2026  
**Branch:** `fix/time-summary-sync-dashboard`  
**Priority:** P0 — directly impacts how the product appears to customers

---

## Problem

Worklogs created by the scheduled sync were appearing in Jira under the app name **"Itracker"** instead of the employee's actual name (e.g., "Srilakshmi Achanta"). This made automated time entries look impersonal and indistinguishable from manual logs, undermining the product's value as a time tracker.

### Screenshot Evidence

| Entry | Author Shown | Method Used |
|-------|-------------|-------------|
| "Itracker logged 6m" | App name | `api.asApp()` — scheduled trigger |
| "Srilakshmi Achanta logged 15m" | User's real name | `api.asUser()` — interactive session |

### Root Cause

The Forge scheduled trigger runs **outside** any user's Jira session. The code was calling `api.asUser(accountId)` for offline impersonation, but Jira was **silently ignoring the impersonation** and recording the app as the worklog author. When the code detected this failure, it fell back to `api.asApp()`, which explicitly creates worklogs under the app name.

**Database evidence confirming the issue:**

```sql
-- All users have atlassian_account_id (not a data issue)
SELECT id, display_name, atlassian_account_id FROM users WHERE atlassian_account_id IS NULL;
-- Result: 0 rows

-- All worklogs were created as the app
SELECT created_as_user, COUNT(*) FROM worklog_sync GROUP BY created_as_user;
-- Result: false | 10
```

---

## Solution

### Strategy: "Never Create Itracker Worklogs"

Instead of falling back to `api.asApp()` when impersonation fails, the scheduled trigger now saves a **pending record** in the database (`jira_worklog_id = NULL`). No worklog is created in Jira at all. The worklog is only created later, when the user opens the Time Tracker in their browser — at which point it runs in the user's live Jira session and is guaranteed to show their real name.

### Architecture (Before vs After)

**Before:**
```
Scheduled Trigger (hourly)
  ├─ Try api.asUser(accountId) → Jira ignores impersonation
  └─ Fall back to api.asApp() → "Itracker logged 6m" ❌
```

**After:**
```
Scheduled Trigger (hourly)
  ├─ Try api.asUser(accountId) → if author matches → worklog under user's name ✅
  ├─ If impersonation fails → save pending record (no Jira worklog created)
  └─ If impersonation runs but author is app → delete it, save pending record

User Opens Time Tracker (any page, 15-min cooldown)
  └─ Finds pending records → creates worklog in live session → "Srilakshmi Achanta logged 6m" ✅
```

---

## Files Changed

### 1. `forge-app/src/services/scheduledWorklogSync.js`

**Three changes in `syncSingleEntry()` function:**

#### Change A — AUTH_TYPE_UNAVAILABLE: Save pending record instead of asApp fallback

```javascript
// BEFORE: Falls back to asApp → creates "Itracker" worklog
catch (impersonationErr) {
  if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
    worklogResult = await createJiraWorklogAsApp(issueKey, timeTracked, startedAt, displayName);
  }
}

// AFTER: Saves pending record → no Jira worklog created
catch (impersonationErr) {
  if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
    await supabaseRequest(supabaseConfig, 'worklog_sync', {
      method: 'POST',
      body: {
        jira_worklog_id: null,        // ← Pending: no Jira worklog
        created_as_user: false,
        last_synced_seconds: timeTracked,
        // ... other fields
      }
    });
    return true;
  }
}
```

#### Change B — No accountId: Save pending record instead of asApp

```javascript
// BEFORE: No accountId → creates via asApp
if (!accountId) {
  worklogResult = await createJiraWorklogAsApp(issueKey, timeTracked, startedAt, displayName);
}

// AFTER: No accountId → saves pending record for user-context sync
if (!accountId) {
  await supabaseRequest(supabaseConfig, 'worklog_sync', {
    method: 'POST',
    body: { jira_worklog_id: null, created_as_user: false, ... }
  });
  return true;
}
```

#### Change C — Impersonation didn't take effect: Delete app worklog + save pending

```javascript
// BEFORE: Saves with created_as_user: false but leaves "Itracker" worklog in Jira
if (usedAsUser && !actuallyCreatedAsUser) {
  console.warn('Impersonation did not take effect...');
  // Worklog still exists in Jira as "Itracker"
}

// AFTER: Immediately deletes the app worklog and saves pending record instead
if (usedAsUser && !actuallyCreatedAsUser) {
  await deleteJiraWorklogAsApp(issueKey, String(worklogResult.id));
  await supabaseRequest(supabaseConfig, 'worklog_sync', {
    method: 'POST',
    body: { jira_worklog_id: null, created_as_user: false, ... }
  });
  return true;
}
```

#### Change D — Pending record update path

When a pending record already exists and tracked time changes, the scheduled trigger updates the `last_synced_seconds` in the database without calling any Jira API:

```javascript
// New code before the update-worklog path:
if (!existingMapping.jira_worklog_id) {
  // Pending record — just update time in DB, no Jira API call
  await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${existingMapping.id}`, {
    method: 'PATCH',
    body: { last_synced_seconds: timeTracked, updated_at: new Date().toISOString() }
  });
  return true;
}
```

#### Change E — Cleanup handles pending records

In `cleanupOrphanedWorklogs()`, pending records (orphaned time reassigned away) are cleaned up by simply deleting the DB row — no Jira API call needed:

```javascript
if (!mapping.jira_worklog_id) {
  // Pending record — just delete DB mapping, no Jira API call
  await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${mapping.id}`, { method: 'DELETE' });
  continue;
}
```

---

### 2. `forge-app/src/services/worklogService.js`

**One change in `syncSingleEntryAsCurrentUser()` function:**

The user-context sync now handles pending records (where `jira_worklog_id` is null) by skipping the Jira delete step and just creating the worklog fresh:

```javascript
// BEFORE: Always tried to delete Jira worklog before recreating
if (existingMapping.created_as_user === false) {
  const migrated = await migrateAppWorklogToUser(issueKey, existingMapping.jira_worklog_id, ...);
}

// AFTER: Handles both pending records and app-created worklogs
if (existingMapping.created_as_user === false) {
  if (existingMapping.jira_worklog_id) {
    // App-created worklog exists in Jira — delete first, then recreate
    const migrated = await migrateAppWorklogToUser(issueKey, existingMapping.jira_worklog_id, ...);
  } else {
    // Pending record — no Jira worklog to delete, just remove the DB mapping
    await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${existingMapping.id}`, { method: 'DELETE' });
  }
  // Fall through to create fresh worklog as user
}
```

---

## Database Schema Impact

### `worklog_sync` table

The `jira_worklog_id` column now accepts `NULL` values for pending records:

| Column | Type | Before | After |
|--------|------|--------|-------|
| `jira_worklog_id` | text | Always set to a Jira worklog ID | Can be `NULL` for pending records |
| `created_as_user` | boolean | `true` or `false` | `false` for all pending records |

**No schema migration required** — `jira_worklog_id` was already a nullable text column.

### Pending Record State Machine

```
[Scheduled Trigger]
  impersonation fails → INSERT worklog_sync (jira_worklog_id=NULL, created_as_user=false)
                              │
  time changes later  → PATCH last_synced_seconds (still pending)
                              │
[User Opens App]              │
  syncMyWorklogs      → DELETE pending record
                       → CREATE Jira worklog as user
                       → INSERT worklog_sync (jira_worklog_id=<real>, created_as_user=true)

[If time reassigned away]
  cleanup             → DELETE pending record (no Jira API call)
```

---

## Migration of Existing "Itracker" Worklogs

The 10 existing worklogs with `created_as_user = false` and a real `jira_worklog_id` will be automatically migrated when each affected user next opens the Time Tracker. The `syncCurrentUserWorklogs` function:

1. Finds mappings with `created_as_user === false` and a non-null `jira_worklog_id`
2. Deletes the app-authored worklog from Jira
3. Creates a new worklog in the user's live Jira session
4. Updates the DB mapping with the new worklog ID and `created_as_user = true`

No manual intervention required.

---

## Restrictions & Edge Cases

Per Atlassian's documentation on offline impersonation:

1. **Deactivated users** — Impersonation cannot be used for deactivated Jira users. Pending records will remain until the user is reactivated and opens the app.
2. **Users without app access** — Users who haven't been granted access to the app cannot be impersonated. Same pending record behavior.
3. **Anonymous users / customer accounts** — Cannot be impersonated. Pending records will accumulate.
4. **User never opens the app** — Pending records stay in the database indefinitely. The hourly scheduled trigger keeps their `last_synced_seconds` up to date, but no Jira worklog is created until the user opens the Time Tracker panel.

---

## Test Coverage

### Updated Tests (`scheduledWorklogSync.test.js`)

| Test Case | Validates |
|-----------|-----------|
| AUTH_TYPE_UNAVAILABLE prevents impersonation | Pending record saved, no `asApp` call |
| No accountId for user | Pending record saved, no Jira API calls |
| Author doesn't match accountId | App worklog deleted + pending record saved |
| No author field in response | Worklog deleted + pending record saved |

### New Tests — Pending Record Handling (`scheduledWorklogSync.test.js`)

| Test Case | Validates |
|-----------|-----------|
| Pending record time update | DB updated, no Jira API calls |
| Pending record time unchanged | Skipped entirely |
| Orphaned pending record cleanup | DB row deleted, no Jira delete call |
| Orphaned real worklog cleanup | Jira delete called normally |

### New Test File (`worklogService.test.js`)

| Test Case | Validates |
|-----------|-----------|
| Pending record → create as user | No Jira delete needed, worklog created in user session |
| App-created worklog → delete + recreate | Full migration path |
| 403 on delete → fallback to app-delete | Permission handling |
| User-created worklog time change → update | In-place update, no recreate |
| Unchanged time → skip | No unnecessary API calls |
| No existing mapping → create new | Fresh worklog creation |
| Sync disabled → early return | Setting respected |

**Total: 144 tests passing across 6 test suites.**

---

## Deployment

1. Code deployed via `forge deploy` on March 25, 2026
2. No database migration required
3. No manifest changes required (permissions already correct)
4. Existing "Itracker" worklogs auto-migrate when users open the app
5. New worklogs will never show "Itracker" — they either show the user's real name (if impersonation works) or remain pending until the user opens the app
