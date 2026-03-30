# Multi-Project Key Attribution Fix

**Date:** March 30, 2026  
**Affected Component:** Desktop App (Python), AI Server (Node.js)  
**Severity:** Critical — timelogs silently misattributed to wrong projects

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Data Flow (Before Fix)](#3-data-flow-before-fix)
4. [Solution Design](#4-solution-design)
5. [Changes Made](#5-changes-made)
6. [Data Flow (After Fix)](#6-data-flow-after-fix)
7. [Impact Analysis](#7-impact-analysis)

---

## 1. Problem Statement

When a user works on **multiple Jira projects simultaneously**, activity records (timelogs) from other projects were being incorrectly attributed to whichever project happened to load first when the desktop app started. This caused:

- **Timelogs going to "unassigned work"** — the AI couldn't match activities to the correct issues because the `project_key` on the record pointed to the wrong project
- **Timelogs logged under the wrong project** — even when the AI identified the correct issue, the pre-stamped `project_key` on the record conflicted
- **App classification settings only applied for one project** — productivity rules (e.g., "Twitter is productive for social media projects but non-productive for internal tools") only loaded for the initial project

### Example Scenario

1. User opens laptop, desktop app starts
2. User has issues in **PROJ-A** and **PROJ-B**
3. `PROJ-A` happens to be the first issue returned → `current_project_key = "PROJ-A"`
4. User works on VS Code editing code for PROJ-B (but window title doesn't contain "PROJ-B")
5. Activity record gets `project_key = "PROJ-A"` (wrong!)
6. AI receives the record with `project_key = "PROJ-A"` already set
7. AI sees issues from both projects but the record says "PROJ-A"
8. Result: Timelog either goes to wrong PROJ-A issue or becomes "unassigned"

---

## 2. Root Cause Analysis

The issue was a **three-part misattribution chain** in the desktop app. Contrary to initial suspicion, the JIRA issue fetching was NOT the problem — issues from ALL projects were already being fetched and sent to the AI.

### Root Cause #1: Arbitrary Default Project Key

**File:** `python-desktop-app/desktop_app.py`  
**Method:** `get_user_project_key()` (line ~6422)

```python
# PROBLEM: Returns first issue's project as "the" project key
if self.user_issues and len(self.user_issues) > 0:
    project_key = self.user_issues[0].get('project')  # ← Always first issue's project!
    if project_key:
        return project_key
```

This method picked the **first issue's project** as the default. Since Jira returns issues sorted by `updated DESC`, the "current project" could change unpredictably based on which issue was last updated.

### Root Cause #2: Fallback to Wrong Default in Per-Record Resolution

**File:** `python-desktop-app/desktop_app.py`  
**Method:** `_resolve_record_project_key()` (line ~6378)

```python
# PROBLEM: When window title detection fails, falls back to batch default
def _resolve_record_project_key(self, window_title, default_project_key):
    # ... tries to extract from window title ...
    # ... tries VS Code workspace name matching ...
    return default_project_key  # ← Falls back to wrong project!
```

The per-record detection had good strategies (extract Jira keys from window titles, match VS Code workspace names), but when these failed (common for generic apps like browsers, terminals, etc.), it fell back to `default_project_key` which was the arbitrary first-issue project.

### Root Cause #3: Single-Project Classification Sync

**File:** `python-desktop-app/desktop_app.py`  
**Method:** `sync_classifications()` (line ~3611)

```python
# PROBLEM: Only loads project overrides for one project
def sync_classifications(self, supabase_client, organization_id, project_key=None):
    # Tier 3: Project overrides — ONLY for current_project_key
    if organization_id and project_key:
        project_result = supabase_client.table('application_classifications') \
            .eq('project_key', project_key).execute()  # ← Only one project!
```

Classification settings (productive/non-productive/private) can be customized per-project. But the sync only loaded overrides for `current_project_key`, meaning project-specific rules for other projects were ignored.

### What Was NOT the Problem

- **Issue fetching** — `build_jql_for_tracked_statuses()` already builds JQL across ALL configured projects, not just the current one
- **`user_assigned_issues` in records** — already includes issues from ALL projects
- **AI analysis** — the AI server receives all issues and has multi-project detection in its prompt
- **AI server `projectKey` write-back** — `updateActivityRecordAnalysis()` already writes `projectKey` when AI resolves one

---

## 3. Data Flow (Before Fix)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DESKTOP APP                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  App Starts                                                         │
│    │                                                                │
│    ▼                                                                │
│  get_user_project_key()                                             │
│    │  Returns first issue's project (e.g., "PROJ-A")                │
│    ▼                                                                │
│  current_project_key = "PROJ-A"  ◄── LOCKED to one project         │
│    │                                                                │
│    ├──► sync_classifications(project_key="PROJ-A")                  │
│    │      Only PROJ-A classification overrides loaded ❌             │
│    │                                                                │
│    ├──► fetch_jira_issues()                                         │
│    │      Returns issues from ALL projects ✅                       │
│    │      (PROJ-A-1, PROJ-A-2, PROJ-B-1, PROJ-B-2, ...)            │
│    │                                                                │
│    ▼                                                                │
│  Every 5 min: upload_activity_batch()                               │
│    │                                                                │
│    │  default_project_key = "PROJ-A"                                │
│    │                                                                │
│    │  For each activity record:                                     │
│    │    _resolve_record_project_key(window_title, "PROJ-A")         │
│    │      │                                                         │
│    │      ├── Window title has "PROJ-B-123"? → return "PROJ-B" ✅   │
│    │      ├── VS Code workspace matches? → return matched key ✅    │
│    │      └── Can't detect? → return "PROJ-A" ❌ (wrong default!)   │
│    │                                                                │
│    │  Record uploaded with:                                         │
│    │    project_key: "PROJ-A" (often wrong)                         │
│    │    user_assigned_issues: [all issues from all projects] ✅     │
│    │    metadata.user_projects: ["PROJ-A", "PROJ-B"] ✅             │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AI SERVER                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  analyzeBatch() receives:                                           │
│    - records (with pre-stamped project_key = "PROJ-A")              │
│    - user_assigned_issues (all projects) ✅                         │
│    - user_projects metadata ✅                                      │
│                                                                     │
│  AI CAN detect correct project from context...                      │
│  BUT record already has project_key = "PROJ-A"                      │
│                                                                     │
│  updateActivityRecordAnalysis():                                    │
│    - Writes AI's projectKey ONLY if AI returns one                  │
│    - If AI is uncertain → keeps wrong "PROJ-A" ❌                   │
│                                                                     │
│  Result: PROJ-B work attributed to PROJ-A or "unassigned" ❌        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Solution Design

### Principle: "Don't guess — let the AI decide"

The desktop app has limited context for project detection (only window titles). The AI server has much richer context: OCR text, window titles, application names, AND the full list of issues across ALL projects with their descriptions, labels, and statuses.

**Instead of pre-stamping a potentially wrong `project_key`, let records arrive with `project_key = null` when the desktop app isn't confident, and let the AI server determine the correct project.**

### Three-Part Fix

| # | Problem | Fix | Rationale |
|---|---------|-----|-----------|
| 1 | `_resolve_record_project_key()` falls back to wrong default | Fall back to `None` instead of batch default | AI has better context to determine project |
| 2 | `sync_classifications()` loads overrides for only one project | Load overrides for ALL known projects | Multi-project users need all classification rules |
| 3 | Batch upload uses arbitrary `default_project_key` | Remove the default — each record gets `None` if not detected | Stop pre-stamping wrong project keys |

---

## 5. Changes Made

### File: `python-desktop-app/desktop_app.py`

#### Change 1: `_resolve_record_project_key()` — Stop falling back to wrong default

**Location:** ~Line 6384

**Before:**
```python
def _resolve_record_project_key(self, window_title, default_project_key):
    """...
    Strategy:
    1. Extract Jira issue keys from the window title (e.g., PROJ-123 → PROJ)
    2. Extract VS Code workspace/folder name and match against known projects
    3. Fall back to batch-level default_project_key
    """
    if not window_title:
        return default_project_key

    # ... detection strategies ...

    return default_project_key  # Wrong project for multi-project users!
```

**After:**
```python
def _resolve_record_project_key(self, window_title, default_project_key):
    """...
    Strategy:
    1. Extract Jira issue keys from the window title (e.g., PROJ-123 → PROJ)
    2. Extract VS Code workspace/folder name and match against known projects
    3. Fall back to None — let the AI server determine the project from context
       (previously fell back to batch-level default which was often wrong for
       multi-project users, causing timelogs to be misattributed)
    """
    if not window_title:
        # No window title to analyze — return None so AI determines the project
        return None

    # ... detection strategies (unchanged) ...

    # No confident match from window title — return None instead of the
    # batch-level default so the AI server can determine the correct project
    # from OCR text, window titles, and issue context across ALL projects.
    return None
```

**What changed:** The fallback at the end and for empty window titles now returns `None` instead of `default_project_key`. The detection strategies (Jira key extraction from window titles, VS Code workspace matching) remain unchanged — they still return the correct project when they can detect it.

---

#### Change 2: `sync_classifications()` — Load ALL project overrides

**Location:** ~Line 3611

**Before:**
```python
def sync_classifications(self, supabase_client, organization_id, project_key=None):
    """..."""
    # Tier 3: Project overrides
    if organization_id and project_key:
        project_result = supabase_client.table('application_classifications').select(
            'identifier, display_name, classification, match_by'
        ).eq('organization_id', organization_id).eq('project_key', project_key).execute()
        project_rows = project_result.data or []
        project_count = len(project_rows)
        for row in project_rows:
            key = ((row.get('identifier') or '').lower(), row.get('match_by'))
            merged[key] = row
```

**After:**
```python
def sync_classifications(self, supabase_client, organization_id, project_key=None, all_project_keys=None):
    """..."""
    # Tier 3: Project overrides — load for ALL known projects so
    # multi-project users get correct classifications regardless of
    # which project is "current".
    project_keys_to_load = set()
    if project_key:
        project_keys_to_load.add(project_key)
    if all_project_keys:
        project_keys_to_load.update(all_project_keys)

    if organization_id and project_keys_to_load:
        for pk in project_keys_to_load:
            try:
                project_result = supabase_client.table('application_classifications').select(
                    'identifier, display_name, classification, match_by'
                ).eq('organization_id', organization_id).eq('project_key', pk).execute()
                project_rows = project_result.data or []
                project_count += len(project_rows)
                for row in project_rows:
                    key = ((row.get('identifier') or '').lower(), row.get('match_by'))
                    merged[key] = row
            except Exception as project_err:
                print(f"[WARN] Project-level classification fetch failed for {pk}: {project_err}")
```

**What changed:** 
- New parameter `all_project_keys` accepts a list of all known project keys
- Tier 3 now iterates over ALL known projects instead of just one
- Each project's classification overrides are loaded and merged (later project overrides take precedence in case of conflicts)
- Log message updated to show all loaded projects

---

#### Change 3: All `sync_classifications()` call sites — Pass all project keys

**Locations:** 4 call sites updated

**Before (all sites):**
```python
self.classification_manager.sync_classifications(
    client, self.organization_id, self.current_project_key
)
```

**After (all sites):**
```python
self.classification_manager.sync_classifications(
    client, self.organization_id, self.current_project_key,
    all_project_keys=list(self._get_known_project_keys())
)
```

**Call sites updated:**

| Location | Context |
|----------|---------|
| Line ~4748 | During authentication |
| Line ~6537 | On project change (`update_current_project()`) |
| Line ~8515 | Periodic sync in tracking loop |
| Line ~9514 | During app startup |

---

#### Change 4: `upload_activity_batch()` — Remove arbitrary default project key

**Location:** ~Line 7112

**Before:**
```python
# Build activity_records payload
records = []
default_project_key = self.current_project_key or self.get_user_project_key()
project_key_source = "current_project_key" if self.current_project_key else "derived_from_issues_or_projects"
print(f"[BATCH] Default project_key: {default_project_key} (source: {project_key_source})")

# ... later in the loop:
record_project_key = self._resolve_record_project_key(
    s.get('window_title', ''), default_project_key
)
```

**After:**
```python
# Build activity_records payload
records = []
# Per-record project key resolution extracts the project from window
# title context (Jira keys, VS Code workspace name, etc.).
# When detection fails, project_key is set to None — the AI server
# will determine the correct project from OCR text, window titles,
# and the full set of user_assigned_issues across ALL projects.
# This prevents misattribution when users work on multiple projects.
known_projects = self._get_known_project_keys()
print(f"[BATCH] Known project keys: {sorted(known_projects) if known_projects else 'none'}")
print(f"[BATCH] User assigned issues: {len(self.user_issues) if self.user_issues else 0} across {len(set(i.get('project') for i in (self.user_issues or []) if i.get('project')))} projects")

# ... later in the loop:
record_project_key = self._resolve_record_project_key(
    s.get('window_title', ''), None  # No default — AI determines if detection fails
)
```

**What changed:** Removed `default_project_key` variable. The `_resolve_record_project_key()` method is now always called with `None` as the fallback, so records that can't be attributed from window title context arrive at the AI server with `project_key = null`.

---

## 6. Data Flow (After Fix)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DESKTOP APP                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  App Starts                                                         │
│    │                                                                │
│    ▼                                                                │
│  sync_classifications(all_project_keys=["PROJ-A", "PROJ-B"])       │
│    │  Loads classification overrides for ALL projects ✅             │
│    │                                                                │
│    ├──► fetch_jira_issues()                                         │
│    │      Returns issues from ALL projects ✅                       │
│    │                                                                │
│    ▼                                                                │
│  Every 5 min: upload_activity_batch()                               │
│    │                                                                │
│    │  NO default_project_key (removed)                              │
│    │                                                                │
│    │  For each activity record:                                     │
│    │    _resolve_record_project_key(window_title, None)             │
│    │      │                                                         │
│    │      ├── Window title has "PROJ-B-123"? → return "PROJ-B" ✅   │
│    │      ├── VS Code workspace matches? → return matched key ✅    │
│    │      └── Can't detect? → return None ✅ (AI will decide!)      │
│    │                                                                │
│    │  Record uploaded with:                                         │
│    │    project_key: null (when not detectable) ✅                  │
│    │    user_assigned_issues: [all issues from all projects] ✅     │
│    │    metadata.user_projects: ["PROJ-A", "PROJ-B"] ✅             │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AI SERVER                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  analyzeBatch() receives:                                           │
│    - records (project_key = null for ambiguous records)              │
│    - user_assigned_issues (all projects) ✅                         │
│    - user_projects metadata ✅                                      │
│                                                                     │
│  AI analyzes FULL context:                                          │
│    - OCR text content                                               │
│    - Window titles                                                  │
│    - Application names                                              │
│    - All assigned issues with descriptions & labels                 │
│    - All accessible project keys                                    │
│                                                                     │
│  Returns: { taskKey: "PROJ-B-42", projectKey: "PROJ-B" }           │
│                                                                     │
│  updateActivityRecordAnalysis():                                    │
│    - Writes AI's projectKey to the record ✅                        │
│    - Writes AI's taskKey (matched issue) ✅                         │
│                                                                     │
│  Result: Correct project and issue attribution ✅                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Impact Analysis

### What Improves

| Scenario | Before | After |
|----------|--------|-------|
| User works on PROJ-B but PROJ-A loaded first | Timelog goes to PROJ-A or unassigned | AI correctly attributes to PROJ-B |
| User switches between 3+ projects in one session | All non-detectable records go to first project | Each record independently attributed by AI |
| Project-specific classification rules (e.g., Twitter = productive for marketing project) | Only one project's rules loaded | All projects' rules loaded |
| VS Code with workspace name that doesn't match project key | Wrong project stamped | `null` sent, AI matches from code content/OCR |

### What Stays the Same

- Records where the desktop app **can** detect the project from window titles (Jira keys visible, VS Code workspace matching) still get the correct `project_key` pre-set — no change
- Issue fetching remains cross-project — `build_jql_for_tracked_statuses()` unchanged
- AI prompt and analysis logic unchanged — it already had multi-project detection capabilities
- The `current_project_key` still exists for tracking settings purposes — it's just no longer used as the default for record attribution

### Edge Cases

| Case | Behavior |
|------|----------|
| Single-project user | No change — detection strategies still work, AI has only one project to choose |
| Offline mode | Records stored locally with `project_key = null`, synced later for AI analysis |
| AI returns `projectKey = null` | Record stays with `project_key = null` — shows as "unattributed" rather than wrongly attributed |
| AI unavailable | Records stay in `pending` status for retry — same as before |

### Trade-off

More records will arrive at the AI server with `project_key = null`, slightly increasing reliance on AI for project detection. This is intentional — the AI has significantly better context (OCR text, issue descriptions, labels) than the desktop app's window-title-only detection, making it the right component to make this decision.
