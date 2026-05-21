# AI Issue Matching — Multi-Root-Cause Fix

**Date:** 2026-05-05  
**Components:** python-desktop-app, ai-server, forge-app  
**Reference:** docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md

---

## Problem

High rate of unassigned activity records (~30-50%) requiring manual user intervention. Eight root causes identified in the analysis compound each other.

---

## Root Causes & Proposed Fixes

### RC1 — Missing `updated` field breaks recency sort (High)
**File:** `python-desktop-app/desktop_app.py` → `fetch_jira_issues()`  
**Fix:** Add `'updated'` to Jira API `fields` list and include `'updated': fields.get('updated', '')` in formatted_issues.

### RC2 — Forge cache JQL hardcoded to `['In Progress']` (High)
**File:** `forge-app/src/config/constants.js`  
**Fix:** Change `JQL_ACTIVE_STATUSES` usage so the JQL uses `statusCategory = "In Progress"` instead of exact status name match. Update `getUserAssignedIssues()` in `forge-app/src/utils/jira.js`.

### RC4 — 30-issue hard cap silently drops active issues (High)
**File:** `ai-server/src/services/ai/prompts.js`  
**Fix:** Increase `.slice(0, 30)` to `.slice(0, 50)`. With RC1 fix, sort is now correct so truncation is safe.

### RC5 — Session continuity resets at batch boundary (Medium)
**File:** `ai-server/src/services/activity-polling-service.js`  
**Fix:** Before analysis, query the user's most recently assigned record (within 30 min). Pass previous-match context to `buildBatchAnalysisPrompt()`.

### RC6 — Small per-user batch size in multi-user environments (Medium)
**File:** `ai-server/src/services/activity-polling-service.js`  
**Fix:** Increase default `ACTIVITY_POLLING_BATCH_SIZE` from 20 to 60.

### RC7 — ADF description extraction only handles paragraphs (Medium)
**File:** `python-desktop-app/desktop_app.py` → `fetch_jira_issues()`  
**Fix:** Replace type-specific ADF parser with recursive text extraction traversing all node types.

### RC8 — `temperature` parameter dropped in AI client (Medium)
**File:** `ai-server/src/services/ai/ai-client.js`  
**Fix:** Accept `temperature` parameter in `chatCompletionWithFallback()`. Only pass it to the API when the model is not GPT-5/o-series (which rejects non-default temperature). Default to `0.1` for Gemini models.

---

## Acceptance Criteria

1. Desktop app includes `updated` field in `formatted_issues` and requests it from Jira API
2. Forge cache JQL uses `statusCategory = "In Progress"` (covers all workflow variants)
3. `formatAssignedIssues()` returns up to 50 issues (not 30)
4. Activity polling default batch size is 60
5. `buildBatchAnalysisPrompt()` accepts optional `previousMatchContext` parameter
6. ADF extraction recursively traverses all node types, not just paragraphs
7. `chatCompletionWithFallback()` accepts and conditionally passes `temperature`
8. All existing tests continue to pass; new tests cover each acceptance criterion

---

## Out of Scope

- RC3 (resolve issues at analysis time instead of upload time) — architectural, deferred
- A1/A2/A3 recommendations — require multi-day effort
- `MIN_CONFIDENCE_THRESHOLD` changes (not touching 0.4)
- Prompt wording changes beyond adding session context hint
