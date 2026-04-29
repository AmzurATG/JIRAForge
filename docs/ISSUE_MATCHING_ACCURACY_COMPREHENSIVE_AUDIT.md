# Issue Matching Accuracy — Comprehensive Audit Report

**Date:** 29 April 2026  
**Scope:** Full pipeline audit covering P1–P6 fixes, D1–D3 defect fixes, and remaining gaps  
**Test Runner:** Jest 29 (Node.js)  
**Total Tests Passing:** 280 / 280  

---

## Executive Summary

9 fixes have been implemented across the issue matching accuracy pipeline (P1–P6 + D1–D3). All are verified applied and passing tests. A post-fix audit reveals **5 remaining defects** — 2 HIGH severity, 2 MEDIUM, and 1 LOW — that still degrade matching accuracy.

---

## Part 1: Verified Fixes (All Passing)

### P1 — Webhook SELECT: description, labels, priority ✅

| Item | Status |
|------|--------|
| **Files** | `supabase/functions/screenshot-webhook/index.ts`, `supabase/functions/activity-webhook/index.ts` |
| **SELECT** | `issue_key, issue_summary, summary, status, project_key, issue_type, description, labels, priority, updated_at` |
| **Mapping** | All fields mapped including `updated: issue.updated_at \|\| null` |
| **Tests** | 14 pass |

---

### P2 — Old Cache Write: persist description, labels, priority ✅

| Item | Status |
|------|--------|
| **Files** | `forge-app/src/services/issue/issueCacheService.js`, `forge-app/src/utils/jira.js`, `forge-app/src/utils/adfToText.js` |
| **Jira API fields** | `['summary', 'status', 'project', 'issuetype', 'updated', 'description', 'labels', 'priority']` |
| **Cache entry** | Includes `description: extractDescriptionText(...)`, `labels`, `priority` |
| **Tests** | 12 pass |

---

### P3 — Description Truncation: 200 → 600 characters ✅

| Item | Status |
|------|--------|
| **File** | `ai-server/src/services/ai/prompts.js` |
| **Limit** | 600 characters (was 200) |
| **Tests** | 14 pass (boundary tests at 600/601) |

---

### P4 — Unified Confidence Threshold at 0.4 ✅

| Item | Status |
|------|--------|
| **Files** | `ai-server/src/services/activity-service.js` (removed duplicate), `ai-server/src/services/db/activity-db-service.js` |
| **Single source** | `activity-db-service.js` with default `0.4` |
| **No duplicate** | Confirmed `activity-service.js` has no `MIN_CONFIDENCE_THRESHOLD` |
| **Tests** | 5 pass |

---

### P5 — Labels End-to-End ✅

| Item | Status |
|------|--------|
| **File** | `ai-server/src/services/ai/prompts.js` (lines 54–56) |
| **Format** | `Labels: label1, label2` appended when present |
| **Tests** | 5 pass (via prompts-description-truncation.test.js) |

---

### P6 — Clustering Prompt: Add Descriptions ✅

| Item | Status |
|------|--------|
| **File** | `ai-server/src/services/clustering-service.js` |
| **Format** | `- KEY: summary — description (200 chars)` |
| **formatDuration(0)** | Returns `"0m"` (bug fixed) |
| **Tests** | 4 pass |

---

### D1 — getUserActiveIssues SELECT Expansion ✅

| Item | Status |
|------|--------|
| **File** | `ai-server/src/services/db/user-db-service.js` |
| **SELECT** | `issue_key, issue_summary, summary, project_key, status, description, labels, priority, updated_at` |
| **Mapping** | All fields including `updated_at` |
| **Tests** | 8 pass |

---

### D2 — Webhooks Include `updated` Timestamp ✅

| Item | Status |
|------|--------|
| **Files** | Both webhooks now SELECT `updated_at` and map it to `updated` |
| **Tests** | 4 pass |

---

### D3 — Polling Service Cache Fallback ✅

| Item | Status |
|------|--------|
| **File** | `ai-server/src/services/activity-polling-service.js` |
| **Imports** | `user-db-service` |
| **Fallback** | Calls `getUserCachedIssues` when `extractUserAssignedIssues` returns empty |
| **Variable** | `issuesForAnalysis` passed to `analyzeBatch` |
| **Tests** | 6 pass |

---

## Part 2: Remaining Defects Found

### R1 — Activity Webhook Drops `ocr_confidence` and `metadata` (HIGH)

**File:** `supabase/functions/activity-webhook/index.ts` lines 197–205

```typescript
records: records.map(r => ({
  id: r.id,
  window_title: r.window_title,
  application_name: r.application_name,
  ocr_text: r.ocr_text,
  // MISSING: ocr_confidence
  total_time_seconds: r.total_time_seconds,
  start_time: r.start_time,
  end_time: r.end_time,
  classification: r.classification
  // MISSING: metadata
})),
```

**Impact:** The AI server uses `ocr_confidence` to flag unreliable OCR text (`"OCR Text (low confidence - may be inaccurate)"`) and `metadata.tracking_mode` to identify idle records. Without these fields on the primary webhook path, the LLM:
- Trusts garbled OCR text at face value → false matches
- Cannot distinguish idle review records → forced matches on idle time

**Compare with:** `activity-polling-service.js` `transformRecordForAnalysis()` which correctly includes both fields.

---

### R2 — Event-Triggered Cache Path Uses Server Time Instead of Jira `updated` (HIGH)

**File:** `forge-app/src/services/issueCacheService.js` line 85 + `ai-server/src/controllers/forge-proxy-controller.js` line 1348

The Forge app's Jira API call does NOT request `'updated'`:
```javascript
fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels']
// Missing: 'updated'
```

The AI server's `cacheUserIssues` then writes:
```javascript
updated_at: getUTCISOString()  // Server timestamp, NOT Jira's issue update time
```

**Impact:** Two mechanisms broken:
1. **Recency sorting** — `formatAssignedIssues()` sorts by `issue.updated` (descending). When all issues have the same cache-refresh timestamp, the sort is arbitrary.
2. **Stale-issue flagging** — P5's ">14 days → likely inactive" annotation never fires because `updated_at` is always "today".

**Compare with:** The old resolver path (`forge-app/src/services/issue/issueCacheService.js`) correctly stores `issue.fields.updated`.

---

### R3 — Desktop App Jira API Missing `priority` and `updated` (MEDIUM)

**File:** `python-desktop-app/desktop_app.py` lines 6844, 6866, 6895

```python
'fields': ['summary', 'status', 'project', 'description', 'labels']
# Missing: 'priority', 'updated'
```

**Impact:** Record-embedded issues (used in the webhook merge/dedup) lack the `updated` field. Since the activity webhook puts record-embedded issues first in the merge, these `updated`-less issues take priority over cached ones. The recency sort then treats them as epoch-0, pushing them to the end.

---

### R4 — Desktop App Cache Read Missing `updated_at` and `priority` (MEDIUM)

**File:** `python-desktop-app/desktop_app.py` line 6777

```python
.select('issue_key, issue_summary, project_key, status, description, labels')
# Missing: updated_at, priority
```

**Impact:** When the desktop app falls back to reading from `user_jira_issues_cache` (offline/stale token), the formatted issues lack recency and priority signals.

---

### R5 — `priority` Field Never Included in LLM Prompt Text (LOW)

**File:** `ai-server/src/services/ai/prompts.js` `formatAssignedIssues()`

The function formats `key`, `summary`, `status`, `updated`, `description`, `labels` — but never `priority`. Despite priority being passed through the entire pipeline, it's dropped at the last mile.

**Impact:** Marginal. Priority could help the LLM disambiguate between multiple plausible matches (prefer the "Highest" priority bug over a "Low" enhancement), but it's not a functional break.

---

## Part 3: Fix vs Defect Consistency Matrix

| Pipeline Stage | Fields Expected | Fields Present | Gap |
|----------------|-----------------|----------------|-----|
| **Jira API (old resolver path)** | summary, status, project, issuetype, updated, description, labels, priority | ✅ All present | None |
| **Jira API (event-triggered path)** | summary, status, project, issuetype, **updated**, description, labels, priority | ❌ Missing `updated` | **R2** |
| **Jira API (desktop app)** | summary, status, project, description, labels, **priority, updated** | ❌ Missing `priority`, `updated` | **R3** |
| **Cache write (old resolver)** | All fields mapped | ✅ Correct `updated_at` from Jira | None |
| **Cache write (event → forge-proxy)** | All fields mapped | ❌ `updated_at` = server time | **R2** |
| **Desktop app cache read** | All relevant fields | ❌ Missing `updated_at`, `priority` | **R4** |
| **Webhook SELECT** | All cache columns | ✅ All 10 columns | None |
| **Webhook record mapping** | All record fields for AI | ❌ Missing `ocr_confidence`, `metadata` | **R1** |
| **AI prompts** | key, summary, status, updated, description, labels, **priority** | ❌ `priority` not formatted | **R5** |
| **Clustering prompt** | issue_key, summary, description | ✅ All present | None |
| **Confidence threshold** | Single source at 0.4 | ✅ Only in `activity-db-service.js` | None |
| **Polling fallback** | Cache fallback + full field mapping | ✅ All fields | None |

---

## Part 4: Test Results

| Test File | Tests | Status |
|-----------|-------|--------|
| activity-service.test.js | 48 | ✅ PASS |
| activity-db-service.test.js | 37 | ✅ PASS |
| activity-polling-service.test.js | 55 | ✅ PASS |
| activity-controller.test.js | 21 | ✅ PASS |
| activity-sanitization.test.js | 9 | ✅ PASS |
| prompts.test.js | 14 | ✅ PASS |
| clustering-service.test.js | 36 | ✅ PASS |
| audit-defects.test.js | 18 | ✅ PASS |
| webhook-select-fields.test.js | 14 | ✅ PASS |
| prompts-description-truncation.test.js | 14 | ✅ PASS |
| confidence-threshold-alignment.test.js | 5 | ✅ PASS |
| cache-write-description.test.js | 12 | ✅ PASS |
| clustering-description.test.js | 4 | ✅ PASS |
| **TOTAL** | **280** | **✅ ALL PASS** |

---

## Part 5: Remaining Defect Priority & Recommended Fix Order

| # | Defect | Severity | Effort | Recommended Fix |
|---|--------|----------|--------|-----------------|
| R1 | Webhook drops `ocr_confidence` + `metadata` | **HIGH** | 5 min | Add both fields to the `records.map()` in activity-webhook |
| R2 | Event cache path uses server time for `updated_at` | **HIGH** | 15 min | Add `'updated'` to Forge API fields; use `fields.updated` in cacheUserIssues |
| R3 | Desktop app Jira API missing `priority`/`updated` | MEDIUM | 5 min | Add to `'fields'` array in desktop_app.py (3 locations) |
| R4 | Desktop app cache read missing `updated_at`/`priority` | MEDIUM | 5 min | Add to `.select()` at line 6777 |
| R5 | `priority` not in LLM prompt | LOW | 5 min | Add `Priority: ${issue.priority}` in `formatAssignedIssues()` |

**R1 and R2 are the highest priority** — they affect the primary (webhook) code path and degrade LLM context quality for every analysis call through the main pipeline.

---

## Part 6: Data Flow Diagram (Current State)

```
Jira Issue (summary + description + labels + priority + updated)
  │
  ├─→ Old Resolver Path (P2 fixed)
  │     → stores description ✅, labels ✅, priority ✅, updated_at from Jira ✅
  │
  ├─→ Event-Triggered Path (R2 broken)
  │     → stores description ✅, labels ✅, priority ✅, updated_at = SERVER TIME ❌
  │
  └─→ Desktop App Embed (R3 gap)
        → embeds summary, status, project, description, labels
        → MISSING: priority ❌, updated ❌

user_jira_issues_cache
  │
  ├─→ Webhook SELECT (P1 + D2 fixed) ✅ All 10 columns
  │     │
  │     └─→ Record mapping to AI server (R1 broken)
  │           → drops ocr_confidence ❌, metadata ❌
  │
  ├─→ Polling fallback (D3 fixed) ✅ Full fields
  │
  └─→ Clustering path (D1 fixed) ✅ issue_key, summary, description

AI Server receives issues
  │
  └─→ formatAssignedIssues() (P3, P5 fixed)
        → key ✅, summary ✅, status ✅, updated ✅, description ✅, labels ✅
        → priority ❌ (R5 — field passed but never formatted)
```
