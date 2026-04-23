# Improve Issue Matching Accuracy & Reduce Unassigned Activities

## Problem Statement

User feedback from two teams (Amzur internal + Evoke) on April 16–17, 2026 shows:
- **60–100% of tracked time is UNASSIGNED** across most users
- **Wrong-project matches** for Amzur users (REVUP, GENESIS issues from 4–5 months ago)
- **Correct matches are tiny** (0.01–0.09h) — only when Jira ticket is directly visible
- **Extended work on one issue goes unassigned** (Padmaja: ESW-6489 all day, 74% unassigned)

## Current Architecture

```
Desktop App → OCR → Upload {ocr_text, window_title, app_name, user_assigned_issues}
    ↓
Supabase activity_records (status: pending)
    ↓
Webhook / Polling (3-min fallback) → AI Server
    ↓
LLM (Gemini 2.0 Flash → Qwen2.5 fallback) → Match to Jira issue
    ↓
If confidence >= 0.5 → Matched | If < 0.5 → UNASSIGNED
```

## Feedback Data Summary

### Amzur Team

| Person | Unassigned % | Key Issue |
|--------|-------------|-----------|
| Akhil | 92% | Matched to REVUP (hasn't worked on in 4 months) |
| Prasad | 88% | Matched to REVUP + GENESIS (stale projects) |
| Meghana | 64% | — |
| Sireesha | 100% | Likely no In Progress issues in Jira |

### Evoke Team

| Person | Unassigned % | Key Issue |
|--------|-------------|-----------|
| Dileep | 99% | AI certification + dashboard monitoring — genuinely non-Jira |
| Gayatri | 61% | All matches correct, bulk unassigned |
| Joseph | 99% | — |
| Mahesh | 96% | — |
| Padmaja | 74% | **"Unassigned was ESW-6489 work"** — same issue all day |
| Sadhana | 86% | — |
| Satish | 96% | — |
| Shilpa | 100% | Likely no In Progress issues |
| Soumiya | 94% | 20+ tiny correct matches, massive unassigned |
| Srilakshmi | 66% | **"UI reservations → unassigned"** — coding didn't match issue |

### Key Patterns

1. **When the algorithm matches, it's almost always correct** (Evoke team: near-zero wrong matches)
2. **Matches are tiny** — LLM matches when Jira ticket is visible, drops to unassigned when user switches to IDE/browser
3. **Extended single-issue work goes unassigned** — Padmaja & Srilakshmi cases
4. **Stale issues from old projects matched incorrectly** — Amzur-specific (REVUP, GENESIS)

---

## Root Cause Analysis

### Why So Much Unassigned?

| Root Cause | Impact | Code Location |
|-----------|--------|---------------|
| **Confidence threshold 0.5 too high** | Kills 60–80% of fuzzy matches. Prompt defines 0.4–0.5 as "reasonable match" but threshold rejects it | `ai-server/src/services/db/activity-db-service.js:67` |
| **No session continuity** — each record matched independently | LLM matches when ticket visible, gives 0.3 when in IDE 2 minutes later for same issue | `ai-server/src/services/activity-service.js:130` (prompt) |
| **OCR text capped at 500 chars** | Rich context lost, LLM falls back to window title only | `ai-server/src/services/activity-service.js:133` |
| **Only 20 issues sent to LLM** | Users with many issues lose relevant ones | `ai-server/src/services/ai/prompts.js:24` |
| **Issue descriptions truncated to 200 chars** | LLM can't deeply understand issue scope | `ai-server/src/services/ai/prompts.js:31` |
| **OCR failure → no text** | Record sent with "(no text extracted)", window title alone is weak | `desktop_app.py:4151` |

### Why Wrong Matches? (Amzur)

| Root Cause | Impact | Code Location |
|-----------|--------|---------------|
| **Stale issues in candidate list** | JQL `statusCategory = "In Progress"` fetches ALL including 4-month-old issues | `desktop_app.py:~6804` |
| **Issue cache staleness** | Webhook falls back to stale cache if record-embedded list missing | `supabase/functions/activity-webhook/index.ts:154` |
| **No recency signal in prompt** | LLM treats 4-month-old issue same as today's | `ai-server/src/services/ai/prompts.js:25` |

### Additional Pipeline Factors

| Factor | Impact | Code Location |
|--------|--------|---------------|
| **Session resumption collapses work** — same window title resumes session, collapsing unrelated tasks | Medium | `desktop_app.py:4206` |
| **Record-embedded issues stale** — fetched at upload time, may be hours old | Medium | `desktop_app.py:8176` |
| **Only foreground window tracked** — Jira on monitor 2 invisible if VS Code focused on monitor 1 | Medium | `desktop_app.py:8834` |
| **OCR confidence not used as quality gate** — 20% OCR treated same as 95% | Medium | `activity-service.js:133` |
| **Idle time adjacent to work lost** — reading a Jira ticket (idle mouse) counted as idle, not work | Medium | `desktop_app.py:9369` |
| **Valuable fields dropped before LLM** — project_key, metadata not included in prompt | Low–Med | `activity-polling-service.js:80` |
| **Model fallback accuracy gap** — Qwen2.5 fallback less capable than Gemini 2.0 Flash | Low–Med | `ai-server/src/services/ai/ai-client.js` |
| **Capture interval 5–15 min** — rapid window switches between captures are invisible | Low–Med | `desktop_app.py:349` |
| **No meeting window detection** — Teams/Zoom calls treated as generic productive time | Low | `desktop_app.py:3859` |
| **Issue list limited to 50 from Jira** — users with many issues lose older ones | Low | `desktop_app.py:6818` |

---

## Proposed Fixes

### Fix 1: Lower Confidence Threshold to 0.3

**Priority:** Critical  
**Effort:** 1 line  
**File:** `ai-server/src/services/db/activity-db-service.js:67`

```javascript
// Current:
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.5');

// Proposed:
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.3');
```

**Why:** The prompt defines 0.4–0.5 as "Reasonable match" but the threshold rejects it. Since matched records go through `approval_status: 'pending_approval'` before syncing to Jira, false positives are caught by the human-in-the-loop gate.

**Expected recovery:** 30–50% of currently unassigned hours.

---

### Fix 2: Add Session Continuity Hint to Prompt

**Priority:** Critical  
**Effort:** ~10 lines  
**File:** `ai-server/src/services/activity-service.js` — `buildBatchAnalysisPrompt()`

Add to the user prompt after "CRITICAL TASK KEY RULE":

```
SESSION CONTINUITY: Records are shown in chronological order. If consecutive records show
the same user in the same or related application (e.g., switching between VS Code and Chrome
while working), and a previous record was confidently matched to an issue, subsequent records
in the same work session should inherit that match at slightly lower confidence (0.5-0.6)
unless the content clearly indicates a different task. Developers typically work on one issue
for extended periods, switching between IDE, browser, and terminal.
```

**Why:** Directly solves Padmaja's case (ESW-6489 all day, only matched when ticket visible) and Srilakshmi's case (UI reservations work unmatched).

---

### Fix 3: Add Recency Filter to JQL

**Priority:** Critical  
**Effort:** 1 line  
**File:** `python-desktop-app/desktop_app.py` — JQL query at ~line 6804

```python
# Current:
jql = 'assignee = currentUser() AND statusCategory = "In Progress"'

# Proposed:
jql = 'assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d'
```

**Why:** Eliminates REVUP-1316 (4 months stale), GEN-5839 (5 months stale), REVUP-1180 from Amzur team. No impact on Evoke since their issues are current.

---

### Fix 4: Add Issue Recency Signal to Prompt Context

**Priority:** High  
**Effort:** ~5 lines  
**File:** `ai-server/src/services/ai/prompts.js` — `formatAssignedIssues()`

```javascript
let issueText = `- ${issue.key}: ${issue.summary} (Status: ${issue.status})`;

// ADD: recency signal so LLM deprioritizes stale issues
if (issue.updated) {
  const daysAgo = Math.floor((Date.now() - new Date(issue.updated).getTime()) / 86400000);
  if (daysAgo > 14) {
    issueText += ` [Last updated: ${daysAgo} days ago — likely inactive]`;
  }
}
```

**Why:** Even with JQL filter, borderline issues exist. "Last updated: 25 days ago" naturally deprioritizes stale issues.

---

### Fix 5: Merge Record-Embedded + Cached Issues

**Priority:** High  
**Effort:** ~15 lines  
**File:** `supabase/functions/activity-webhook/index.ts` — issue resolution (~line 154)

```typescript
// Current: use record-embedded OR cache (exclusive)
const issuesForAnalysis = recordIssues.length > 0 ? recordIssues : userAssignedIssues;

// Proposed: merge both, deduplicate by key
const mergedIssues = [...recordIssues];
const seenKeys = new Set(recordIssues.map(i => i.key));
for (const cached of userAssignedIssues) {
  if (!seenKeys.has(cached.key)) {
    mergedIssues.push(cached);
    seenKeys.add(cached.key);
  }
}
const issuesForAnalysis = mergedIssues;
```

**Why:** Record-embedded issues may be hours old. Cache may have newer assignments. Merging gives the widest coverage.

---

### Fix 6: Increase OCR Text Limit to 1000 Chars

**Priority:** High  
**Effort:** 1 line  
**File:** `ai-server/src/services/activity-service.js:133`

```javascript
// Current:
record.ocr_text.substring(0, 500)

// Proposed:
record.ocr_text.substring(0, 1000)
```

**Why:** More text = better semantic matching. Code editors and documentation pages often need 500+ chars for meaningful context.

---

### Fix 7: Increase Issue List to 30 with Relevance Sorting

**Priority:** High  
**Effort:** ~10 lines  
**File:** `ai-server/src/services/ai/prompts.js:24`

```javascript
// Current:
.slice(0, 20)

// Proposed: sort by recency, then slice
const sorted = userAssignedIssues.sort((a, b) => {
  const aDate = a.updated ? new Date(a.updated).getTime() : 0;
  const bDate = b.updated ? new Date(b.updated).getTime() : 0;
  return bDate - aDate; // newest first
});
return sorted.slice(0, 30).map(issue => { ... });
```

**Why:** Soumiya had 20+ matched issues in 2 days. Sorting by recency ensures the most relevant issues survive the cut.

---

### Fix 8: Flag Low-Confidence OCR for LLM

**Priority:** Medium  
**Effort:** ~5 lines  
**File:** `ai-server/src/services/activity-service.js` — `buildBatchAnalysisPrompt()`

```javascript
const ocrSnippet = record.ocr_text
  ? sanitizeOcrText(record.ocr_text.substring(0, 1000))
  : '(no text extracted)';

// ADD: quality signal
const ocrLabel = !record.ocr_text ? '(no text extracted)'
  : record.ocr_confidence && record.ocr_confidence < 0.4
    ? `OCR Text (low confidence - may be inaccurate): ${ocrSnippet}`
    : `OCR Text: ${ocrSnippet}`;
```

**Why:** Prevents LLM from trusting garbage OCR text for matching decisions.

---

### Fix 9: Include project_key in LLM Context

**Priority:** Medium  
**Effort:** ~3 lines  
**File:** `ai-server/src/services/activity-polling-service.js:80` — record transformation

Add `project_key` to the fields sent to the LLM. When the desktop app knows the user's current project context, this gives the LLM a strong hint.

---

### Fix 10: Document AI_MATCH_MIN_CONFIDENCE

**Priority:** Medium  
**Effort:** 1 line  
**File:** `ai-server/.env.example`

```env
# Minimum confidence score for AI issue matching (0.0-1.0). Below this, records stay unassigned.
AI_MATCH_MIN_CONFIDENCE=0.3
```

---

### Fix 11: LLM-Based Idle Classification (No Hardcoded URL/App Lists)

**Priority:** High  
**Effort:** ~40 lines  
**File:** `python-desktop-app/desktop_app.py` — `_create_idle_record()` at line 9377

**Problem:** When a user reads documentation, reviews a PR, reads a Jira ticket, or attends a meeting for 30–60 minutes without touching mouse/keyboard, the current logic classifies it as idle time. The 5-minute idle timeout (`self.idle_timeout = 300` at line 4841) cannot distinguish "user reading" from "user left for coffee." This causes significant productive time loss — a 1-hour documentation reading session produces a 55-minute idle record that never goes to the LLM.

**Affected activities:** Reading Confluence docs, reviewing GitHub PRs, reading Jira tickets, reading Google Docs/Notion, reviewing emails, watching training videos, attending Zoom/Teams/Meet calls, reviewing PDFs/Word docs.

**Current behavior:**
```
10:00 — User opens Confluence in Chrome (active record starts)
10:05 — 5 min idle threshold hit → idle starts, active record ends (~5 min)
11:00 — User moves mouse → 55-min idle record created (classification: 'idle', status: 'analyzed')
         → Never sent to LLM, pure dead time
```

**Key facts about current idle detection:**
- Mouse movement, mouse click, scroll, and keyboard press ALL reset the idle timer via pynput hooks (line 9432–9449). They are **not** differentiated — all call the same `on_activity` callback.
- Therefore, if a user goes idle for 5+ minutes, they truly had **zero input of any kind.** The issue is that reading/meetings genuinely produce zero input, not that we're missing input signals.
- Current idle records are created with `status: 'analyzed'` — they **never reach the LLM.**

**Architecture: 3-Gate Classification**

Instead of maintaining brittle URL/app lists that require constant updates and can never cover internal wikis, custom tools, or offline documents, let the LLM decide. It already has the user's Jira issues and can determine if a window title represents productive work.

```
Idle detected (5 min no input)
       │
       ▼
┌─────────────────────────┐
│  Gate 1: Skip Patterns   │  Lock screen, logon, desktop, empty title
│  (instant → idle)        │  → classification: 'idle', status: 'analyzed'
└──────────┬──────────────┘
           │ Not skipped
           ▼
┌─────────────────────────┐
│  Gate 2: Duration Cap    │  idle_duration > MAX_IDLE_FOR_LLM (3600s = 1 hour)
│  (instant → idle)        │  → Too long, almost certainly away
└──────────┬──────────────┘
           │ Under cap
           ▼
┌─────────────────────────┐
│  Gate 3: Send to LLM     │  Create record with window title context
│                          │  classification: 'unknown', status: 'pending'
│                          │  LLM classifies using Jira issues + title
└─────────────────────────┘
```

**Why no URL/app lists:**
- Can never be exhaustive (internal wikis, custom portals, PDFs in Acrobat, local .md files)
- Requires maintenance as new tools are adopted
- Different organizations use different tools
- The LLM already has the context to make this decision — window titles like "API Design - Confluence" or "Sprint Planning - Google Meet" are obvious to classify

**Fix:** In `_create_idle_record()`, apply the 3-gate classification:

```python
# OS-level screens that are NEVER productive — tiny, stable, never changes
IDLE_SKIP_PATTERNS = frozenset({
    'lock screen', 'windows default lock', 'screensaver',
    'logonui', 'logon', 'windows security', 'user account control',
    'task switching', 'task view',
})

# Maximum idle duration to send to LLM for classification.
# Beyond this, the user almost certainly left — no point asking the LLM.
MAX_IDLE_FOR_LLM_SECONDS = 3600  # 1 hour

def _create_idle_record(self, reason="idle timeout"):
    # ... existing validation (idle_start_time check, duration < 60 skip, work hours check) ...

    # --- Gate 1: Skip OS-level screens (always idle, don't waste LLM tokens) ---
    last_app = None
    last_title = None
    should_send_to_llm = False

    if (self.current_window_key and '|||' in self.current_window_key):
        last_app, last_title = self.current_window_key.split('|||', 1)
        title_lower = last_title.lower().strip() if last_title else ''

        # Skip: OS screens, empty titles, bare desktop
        is_os_screen = any(p in title_lower for p in IDLE_SKIP_PATTERNS)
        is_empty = not title_lower or title_lower in ('', 'desktop', 'program manager')

        if not is_os_screen and not is_empty:
            # --- Gate 2: Duration cap ---
            if idle_duration <= MAX_IDLE_FOR_LLM_SECONDS:
                should_send_to_llm = True

    if should_send_to_llm:
        # Create record for LLM classification — it will decide productive vs idle
        record = {
            'user_id': self.current_user_id,
            'organization_id': self.organization_id,
            'window_title': last_title,
            'application_name': last_app,
            'classification': 'unknown',   # LLM will reclassify
            'is_idle': False,
            'start_time': self.idle_start_time.isoformat(),
            'end_time': idle_end.isoformat(),
            'duration_seconds': idle_duration,
            'total_time_seconds': idle_duration,
            'work_date': _utc_ts_to_local_date(self.idle_start_time.isoformat()),
            'user_timezone': get_local_timezone_name(),
            'project_key': project_key,
            'status': 'pending',           # Enters LLM pipeline
            'metadata': {
                'tracking_mode': 'idle_for_llm_review',
                'idle_reason': reason,
                'idle_duration_seconds': idle_duration,
                'original_classification': 'idle',
                'app_version': self.app_version
            }
        }
        self._pending_idle_records.append(record)
        print(f"[IDLE→LLM] Sending idle for LLM review: {last_title} ({idle_duration}s)")
        self.idle_start_time = None
        return

    # ... existing idle record creation (unchanged — genuine idle) ...
```

**AI Server prompt addition** (in `buildBatchAnalysisPrompt()`, `activity-service.js`):

```
IDLE REVIEW RECORDS: Records with tracking_mode "idle_for_llm_review" represent periods
where the user had no keyboard/mouse input but an application was visible. Use the window
title and application name to determine if this was likely productive activity (reading docs,
attending a meeting, reviewing code) or genuine idle time (user walked away). For reading/
meeting activities, match to the most relevant Jira issue. Assign LOWER confidence for longer
idle durations — a 7-minute idle on Confluence is likely reading (confidence 0.5-0.6), while
a 45-minute idle on Confluence is less certain (confidence 0.2-0.3). If the window title
clearly indicates non-work content, classify as idle with no task match.
```

**Behavior after fix — Reading scenario:**
```
10:00 — User opens Confluence in Chrome (active record starts)
10:05 — 5 min idle threshold hit → idle starts, active record ends (~5 min)
11:00 — User moves mouse → _create_idle_record() called
         → Gate 1: "API Design - confluence.atlassian.net" ≠ skip pattern ✓
         → Gate 2: 3300s ≤ 3600s ✓
         → Gate 3: Record created (classification: 'unknown', status: 'pending')
         → LLM sees title + user's Jira issues → matches to relevant ticket
         → LLM assigns lower confidence due to 55-min duration (~0.3)
         → With Fix 1 (threshold 0.3), this gets matched
```

**Behavior after fix — Meeting scenario:**
```
14:00 — User joins Google Meet (active record starts)
14:05 — 5 min idle threshold hit → idle starts
15:00 — Meeting ends, user moves mouse → _create_idle_record()
         → Gate 1: "Sprint Planning - Google Meet" ≠ skip pattern ✓
         → Gate 2: 3300s ≤ 3600s ✓
         → Gate 3: Record created → LLM matches to sprint-related issue
```

**Behavior after fix — Lock screen:**
```
12:00 — User locks screen for lunch
13:00 — User unlocks → _create_idle_record(reason="screen lock")
         → Gate 1: title contains "lock screen" → SKIP
         → Existing idle record created (status: 'analyzed'), never hits LLM ✓
```

**Behavior after fix — 2-hour away:**
```
10:00 — User on Confluence, walks away
12:00 — Returns → _create_idle_record()
         → Gate 1: "Confluence" ≠ skip pattern ✓
         → Gate 2: 7200s > 3600s → SKIP (too long)
         → Existing idle record created ✓
```

**Cost impact:** Idle records sent to LLM have no OCR text (lightweight). At ~4-6 extra records per user per day for a 50-user team = 200-300 extra LLM calls/day. With Gemini 2.0 Flash, this is <$1/day. The value recovered (15-45 min/user/day of productive time) far exceeds the cost.

**Why this is better than URL/app lists:**
- **Zero maintenance** — no list to update when new docs sites or tools are adopted
- **Handles everything** — internal wikis, PDFs in Acrobat, Word docs, custom portals, meeting apps
- **Context-aware** — LLM sees the user's actual Jira issues and can match "API Design - Confluence" to the right ticket
- **Duration-aware** — LLM naturally assigns lower confidence for longer idle periods
- **Skip patterns are stable** — OS-level screens (lock, logon, screensaver) genuinely never change, unlike app/URL lists

**Expected recovery:** 15–45 minutes per user per day for documentation-heavy and meeting-heavy roles (QA, analysts, PMs, support).

---

### Fix 12: Richer Session Keys

**Priority:** Low–Medium  
**Effort:** ~10 lines  
**File:** `python-desktop-app/desktop_app.py:4206` — session resumption query

Include file path (for IDEs) or URL (for browsers) in the session key to prevent collapsing unrelated work under the same generic window title.

---

### Fix 13: Allow Users to Assign Unassigned/Idle Records from Forge UI

**Priority:** Medium  
**Effort:** ~40 lines  
**Files:** `forge-app/src/resolvers/approval/approvalResolvers.js`, `forge-app/static/main/` (React UI)

**Problem:** The existing approval system (`approveRecords`, `reassignAndApproveRecords`, `createIssueAndApproveRecords`) only works on records that already have an assigned issue (`approval_status: 'pending_approval'`). Unassigned records and idle records have no override path — users can't say "this idle time was actually ESW-6489 work."

With Fix 11 sending more idle records to the LLM, some will still come back unmatched. Users need a way to manually assign these.

**Fix:** Add an "Assign" action to the Unassigned Work panel in the Forge UI:

1. New resolver: `assignUnassignedRecords(recordIds, issueKey)` — sets `task_key`, `approval_status: 'approved'`, `user_assigned_issue_key`
2. UI: Add an "Assign to Issue" button in the Unassigned Work panel with issue key picker
3. Track these corrections via `recordAccuracyEvents()` to measure how often the LLM fails vs. succeeds on idle-origin records

**Why:** Closes the feedback loop. Even the best LLM classification won't be 100% accurate. Users need a fallback.

**Future enhancement:** Feed user corrections back into the LLM prompt as few-shot examples for per-user tuning.

---

### Fix 14: Audio-Based Meeting Detection (Future)

**Priority:** Low  
**Effort:** ~30 lines + new dependency (`pycaw`)  
**File:** `python-desktop-app/desktop_app.py` — idle detection loop

**Problem:** Fix 11 handles meetings via LLM classification of window titles ("Sprint Planning - Google Meet" → productive). This works for ~90% of cases. The remaining 10% are edge cases:
- User on a call but window title is generic ("Google Chrome")
- Screen sharing where the meeting app isn't the foreground window

**Fix:** Use `pycaw` (Windows Core Audio API) to detect if the meeting app's audio session is active:

```python
from pycaw.pycaw import AudioUtilities

def is_meeting_audio_active(foreground_pid):
    """Check if the foreground app has an active audio session."""
    sessions = AudioUtilities.GetAllSessions()
    for session in sessions:
        if (session.Process
                and session.Process.pid == foreground_pid
                and session.State == 1):  # AudioSessionStateActive
            return True
    return False
```

**Critical:** Must correlate audio PID with foreground window PID. Without this, background Spotify/YouTube Music triggers false positives.

**Why deferred to Phase 4:**
- Adds a new dependency (`pycaw` → `comtypes` → Windows COM DLLs)
- Requires PyInstaller spec changes and testing across Windows versions
- Fix 11's LLM approach already handles 90% of meeting cases via window title
- Can be added incrementally without changing the architecture

---

## Implementation Plan

### Phase 1 — Quick Wins (config + prompt changes, no architecture)

| Fix | Effort | Files |
|-----|--------|-------|
| Fix 1: Lower threshold to 0.3 | 1 line | `activity-db-service.js` |
| Fix 2: Session continuity prompt | ~10 lines | `activity-service.js` |
| Fix 3: JQL recency filter | 1 line | `desktop_app.py` |
| Fix 10: Document env var | 1 line | `.env.example` |

### Phase 2 — Data Quality Improvements

| Fix | Effort | Files |
|-----|--------|-------|
| Fix 4: Issue recency in prompt | ~5 lines | `prompts.js` |
| Fix 5: Merge embedded + cached issues | ~15 lines | `activity-webhook/index.ts` |
| Fix 6: OCR text to 1000 chars | 1 line | `activity-service.js` |
| Fix 7: Issue list to 30, sorted | ~10 lines | `prompts.js` |
| Fix 8: Flag low-confidence OCR | ~5 lines | `activity-service.js` |

### Phase 3 — Desktop App + Idle Recovery

| Fix | Effort | Files |
|-----|--------|-------|
| Fix 9: project_key in LLM context | ~3 lines | `activity-polling-service.js` |
| Fix 11: LLM-based idle classification (3-gate) | ~40 lines | `desktop_app.py` + `activity-service.js` (prompt) |
| Fix 12: Richer session keys | ~10 lines | `desktop_app.py` |
| Fix 13: Assign unassigned/idle from UI | ~40 lines | `approvalResolvers.js` + React UI |

### Phase 4 — Future Enhancements

| Fix | Effort | Files |
|-----|--------|-------|
| Fix 14: Audio-based meeting detection | ~30 lines + pycaw dep | `desktop_app.py` |

---

## Expected Impact

### After Phase 1 (Fixes 1–3)

| Person | Current Unassigned | Expected Unassigned |
|--------|-------------------|-------------------|
| Padmaja (Evoke) | 74% | ~25% |
| Srilakshmi (Evoke) | 66% | ~30% |
| Gayatri (Evoke) | 61% | ~30% |
| Akhil (Amzur) | 92% | ~50% (+ no wrong REVUP matches) |
| Prasad (Amzur) | 88% | ~45% (+ no wrong GENESIS/REVUP matches) |

### After Phase 1+2 (Fixes 1–8)

Additional 10–15% reduction in unassigned time from better data quality feeding the LLM.

### Users That Won't Improve

- **Shilpa / Sireesha**: 100% unassigned — likely have no "In Progress" issues in Jira. No algorithm fix helps; they need issues assigned.
- **Dileep**: 99% unassigned — AI certification + dashboard monitoring genuinely doesn't map to Jira issues. Correct behavior; needs a catch-all issue in Jira.
