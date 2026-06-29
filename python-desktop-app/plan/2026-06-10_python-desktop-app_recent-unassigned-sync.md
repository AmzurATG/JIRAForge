# Desktop DQ Popup Startup Sync For Recent Unassigned Work

> **Status:** Planning only. No code changes in this file.  
> **Related:** [13_SCHEDULED_QUALITY_NOTIFICATIONS.md](../../docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md), `python-desktop-app/dq_nudge/poller.py`, `python-desktop-app/desktop_app.py`

## Problem

The desktop app tracks activity every 5 minutes, but the Description Quality popup path currently relies on a 30-minute nudge cadence. If a user starts tracking and has recent unassigned work, the app may wait up to 30 minutes before the DQ popup can appear. During that wait, the user can lose another 30-minute window of time before the work is assigned/synced.

Furthermore, due to this lag difference (5-minute time tracking vs 30-minute DQ popup), work related to a poor description ticket can get miscategorized or left as unassigned work. 

Currently, after a user enhances a description using our enhancement screen, the "Done" button does not do anything (instead, it should refresh the page automatically). Additionally, there is no way for the user to immediately sync these unassigned work sessions against the newly updated description, or to sync all unassigned sessions in the past 30 minutes with recently updated Jira tickets.

## Root Cause / Context

- The desktop time tracker runs on a 5-minute capture cadence, while the DQ desktop popup runs on a 30-minute cadence.
- This creates lag, resulting in recent work being left in the unassigned work pool.
- The description enhancement screen successfully updates a ticket's description in Jira but lacks:
  - An automatic page reload on clicking the "Done" button to show the updated ticket state.
  - A trigger button to immediately sync the past 30 minutes of unassigned work against this newly updated ticket.
- The main Unassigned Work screen of the Forge app lacks a "Sync with Jira" button on the top right to back-match recent unassigned work to recently updated tickets in bulk.
- Auto-assigning these matched sessions requires a secure, high-confidence LLM matching pipeline.

## Goal

1. Run a one-time Description Quality popup sync at the end of time-tracker initialization.
2. In the Description Quality screen (`DescriptionQuality.js`):
   - Add a button "Sync Recent Work" after a successful description update to sync unassigned work in the past 30 minutes with the updated description.
   - Automatically reload the page using `@forge/bridge` `router.reload()` when the user clicks the "Done" button.
3. In the Unassigned Work tab (`UnassignedWork.js`):
   - Add a "Sync with Jira" button in the top right corner.
   - Automatically scan unassigned work in the last 30 minutes and run it against Jira tickets whose descriptions were enhanced/updated in the last 30 minutes.
   - Automatically assign matching time sessions to the respective tickets and sync worklogs to Jira.
4. Ensure all matching calls use custom LLM prompts with a high confidence threshold (>= 0.7) to prevent false assignments.

## Proposed Solution

### 1. Add a startup DQ sync hook in the desktop app

After time-tracker initialization has completed successfully, call a one-time DQ startup sync before relying on the normal scheduled poller.
Recommended call site: In `python-desktop-app/desktop_app.py` after valid authenticated context is verified.

### 2. Add a dedicated “recent unassigned” DQ sync endpoint

```http
POST /api/desktop/description-quality-nudges/sync-recent-unassigned
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "windowMinutes": 30,
  "limit": 5,
  "force": false
}
```

### 3. Desktop poller method for startup sync

Add `sync_recent_unassigned_once(self, timeout: float = 15.0, limit: int = 5) -> dict` in `python-desktop-app/dq_nudge/poller.py`.

### 4. Immediately show the startup popup when nudges exist

The startup flow should not wait for the next scheduled poll.

---

### 5. Description Quality UI Enhancements (Issue Panel)

In `forge-app/static/main/src/components/issue-panel/DescriptionQuality.js`:
- In `STAGE.SUCCESS` state (after successful update):
  - Change the "Done" button action: instead of resetting state (`handleReset`), invoke `router.reload()` from `@forge/bridge` to refresh the parent Jira page.
  - Add a **"Sync Recent Work"** button next to "Done" (styled as a primary button with a loading spinner/state).
  - When clicked:
    - Invoke a new Forge resolver `syncRecentUnassignedWorkForIssue` passing the current `issueKey`.
    - Show a loading spinner: "Syncing recent unassigned work...".
    - On success: Show success feedback (e.g. "Matched and assigned X session(s)!") and then reload the page after a short delay (e.g., 2 seconds) so the time analytics refresh.

### 6. Unassigned Work UI Enhancements (Top-Right Sync Button)

In `forge-app/static/main/src/components/UnassignedWork.js`:
- In the header top-row, next to the "Bulk Time Edit" button, render a new **"Sync with Jira"** button.
- Styling: Premium aesthetic matching the Forge design system, featuring a refresh/sync icon and a loading spinner when active.
- When clicked:
  - Disable the button and show a spinner.
  - Invoke a new Forge resolver `syncRecentUnassignedWorkWithAllUpdatedIssues`.
  - On success: Show a toast/banner message with the sync summary (e.g. "Sync complete. Automatically assigned X session(s) to updated tickets.") and reload the unassigned work list (`loadUnassignedWork()`).

---

### 7. Forge Backend Resolvers & AI Server Sync Endpoints

#### Resolver: `syncRecentUnassignedWorkForIssue({ issueKey })`
- Lives in `forge-app/src/resolvers/descriptionResolvers.js`.
- Steps:
  1. Fetch unassigned sessions (both `activity_records` and `unassigned_activity`) in the last 30 minutes for the current user.
  2. Fetch the current ticket's updated summary and description from Jira.
  3. Send a POST request to the AI server: `/api/forge/description/sync-issue-unassigned`.
  4. The AI server returns a list of matched session IDs.
  5. If matched sessions exist:
     - Assign them to the issue via the existing helper `updateSessionsAndAnalysis` (marks manually assigned, updates project/task keys, generates accuracy events).
     - Find the corresponding groups for these sessions and mark them assigned via `markGroupAsAssigned` if all members are assigned.
     - Log a combined worklog in Jira using `createWorklogIfNeeded`.
  6. Return `{ success: true, matchedCount: X }`.

#### Resolver: `syncRecentUnassignedWorkWithAllUpdatedIssues()`
- Lives in `forge-app/src/resolvers/descriptionResolvers.js`.
- Steps:
  1. Query `description_quality_events` from the database for the current organization to find issue keys that were updated (`event_type` in `('accept', 'edit')`) in the last 30 minutes.
  2. For those issue keys, fetch their summaries and descriptions from Jira.
  3. Fetch unassigned sessions (both `activity_records` and `unassigned_activity`) in the last 30 minutes for the current user.
  4. Send a POST request to the AI server: `/api/forge/description/sync-all-unassigned` with the list of candidate issues and unassigned sessions.
  5. The AI server returns a mapping: `[ { sessionId: "uuid", issueKey: "KEY-123" } ]`.
  6. Group matched sessions by issue key.
  7. For each issue key with matches:
     - Automatically assign the sessions to that issue via `updateSessionsAndAnalysis`.
     - Update group assignment statuses.
     - Log the worklog using `createWorklogIfNeeded`.
  8. Return `{ success: true, matchedCount: X }`.

---

### 8. AI Server Endpoints & LLM Prompting

#### Endpoint: `POST /api/forge/description/sync-issue-unassigned`
- Gated by `forgeAuthMiddleware`.
- Receives: `issueKey`, `title`, `description`, `sessions`.
- Prompting:
  - **System Prompt**:
    ```text
    You are an expert assistant matching time tracking activity records to a specific Jira issue.
    You will be given the Jira issue's key, title, and description, and a list of unassigned work sessions from the last 30 minutes.
    Determine which sessions represent work on this specific issue.
    
    MATCHING RULES:
    1. Look at application names, window titles, and screen text context to identify a semantic match.
    2. Be conservative. Only match if you are highly confident (confidence score >= 0.7) that the activity directly maps to the issue.
    3. Return a JSON object containing only the array of matched session IDs.
    ```
  - **Expected JSON Response**:
    ```json
    {
      "matchedSessionIds": ["uuid-1", "uuid-3"]
    }
    ```

#### Endpoint: `POST /api/forge/description/sync-all-unassigned`
- Gated by `forgeAuthMiddleware`.
- Receives: `issues` (array of issue details), `sessions` (array of unassigned sessions).
- Prompting:
  - **System Prompt**:
    ```text
    You are an expert assistant matching time tracking activity records to a list of recently updated Jira issues.
    You will be given a list of candidate Jira issues (each with its key, title, and description) and a list of unassigned work sessions from the last 30 minutes.
    Determine which session matches which issue.
    
    MATCHING RULES:
    1. Match a session to an issue key only if there is a strong semantic relationship (e.g. VS Code folder matches issue component, browser URL matches ticket context).
    2. Be conservative. Only match if you are highly confident (confidence score >= 0.7). If no candidate issue is a strong match, do not assign it.
    3. Return a JSON object with the mappings.
    ```
  - **Expected JSON Response**:
    ```json
    {
      "assignments": [
        { "sessionId": "uuid-1", "issueKey": "PROJ-123" },
        { "sessionId": "uuid-2", "issueKey": "PROJ-456" }
      ]
    }
    ```

## 30-Minute Window Rule

Both sync utilities must rigidly enforce the 30-minute lookback limit:
- Unassigned sessions: `created_at >= now() - 30 minutes` (for activity records) and `timestamp >= now() - 30 minutes` (for unassigned activities).
- Updated tickets: `created_at >= now() - 30 minutes` (from `description_quality_events`).
- This limits token consumption and avoids processing legacy backlogs.

## Files To Modify

| Path | Planned Change |
|---|---|
| `python-desktop-app/desktop_app.py` | Call a one-time DQ recent-unassigned startup sync after tracking initialization succeeds. |
| `python-desktop-app/dq_nudge/poller.py` | Add `sync_recent_unassigned_once()` and endpoint constant. |
| `ai-server/src/controllers/desktop-dq-nudges-controller.js` | Add `POST /sync-recent-unassigned` route that scans only recent unassigned work and creates desktop nudge rows. |
| `ai-server/src/services/db/description-quality-notifications-repo.js` | Add helpers for inserting recent-unassigned DQ rows if not already covered by existing methods. |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality.js` | Modify Success view: Page reload on Done, add "Sync Recent Work" button with spinner. |
| `forge-app/static/main/src/components/UnassignedWork.js` | Add "Sync with Jira" button in top-right header, handle click loading state and reload unassigned work list. |
| `forge-app/src/resolvers/descriptionResolvers.js` | Implement resolvers: `syncRecentUnassignedWorkForIssue` and `syncRecentUnassignedWorkWithAllUpdatedIssues`. |
| `ai-server/src/controllers/description-controller.js` | Add endpoints `/api/forge/description/sync-issue-unassigned` and `/api/forge/description/sync-all-unassigned`. |
| `ai-server/src/services/description-service.js` | Implement matching prompts and LLM validation logic for issue-specific and global unassigned sync. |
| `python-desktop-app/tests/test_dq_nudge_poller.py` | Add tests for the new startup sync method. |
| `ai-server/tests/controllers/desktop-dq-nudges-controller.test.js` | Add controller tests for the 30-minute filter, unassigned-only filter, cap, cooldown, and response mapping. |

## Acceptance Criteria

1. A one-time DQ recent-unassigned sync runs after time-tracker initialization succeeds.
2. Only work items from the previous 30 minutes are considered for startup sync.
3. Clicking "Done" on the Description Quality screen successfully reloads the Jira parent page.
4. Description Quality success screen displays a "Sync Recent Work" button which queries the past 30 minutes of unassigned work and auto-assigns matching items to the issue via the LLM.
5. The top-right corner of the Unassigned Work page contains a "Sync with Jira" button.
6. Clicking "Sync with Jira" runs all unassigned sessions in the past 30 minutes against tickets updated in the past 30 minutes, automatically assigning them.
7. Sync calls always route to the LLM using the designated prompts with a confidence threshold >= 0.7.
8. Matched sessions automatically have Jira worklogs created (unless auto-sync is enabled, where it is deferred to the scheduled sync).

## Test Plan

| Area | Test |
|---|---|
| Desktop startup hook | Mock `start_tracking` success path and assert `sync_recent_unassigned_once()` is called once after DQ poller startup. |
| Done Button Reload | Assert that clicking "Done" on the success stage triggers `@forge/bridge` `router.reload`. |
| Single Ticket Sync | Mock 30-minute unassigned work, trigger `syncRecentUnassignedWorkForIssue`, assert correct matching and assignment DB updates. |
| Global Sync Button | Trigger `syncRecentUnassignedWorkWithAllUpdatedIssues` and assert that the LLM is prompted with correct issues and sessions, and matching sessions are assigned. |
| LLM Prompts & Schema | Verify that the LLM parses correct schemas, handles empty sessions gracefully, and filters out low-confidence assignments (< 0.7). |

## Out Of Scope

- Changing the desktop tracking interval from 5 minutes.
- Changing the normal DQ scheduled cadence.
- Bulk backfilling all historical unassigned work.
- Changing DQ scoring rules.
- Changing popup layout or acknowledgement behavior.