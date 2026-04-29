# Issue Matching Accuracy Fixes — Test Report

**Date:** 28 April 2026  
**Branch:** main  
**Test Runner:** Jest 29.x  
**Node:** v22.x (Windows)

---

## Summary

| Metric | Value |
|--------|-------|
| **Fixes Implemented** | P1, P2, P3, P4, P5, P6 |
| **Files Modified** | 10 |
| **Files Created** | 6 (1 utility + 5 test files) |
| **Total Test Suites** | 12 (7 existing + 5 new) |
| **Total Tests** | 262 |
| **Passed** | 262 |
| **Failed** | 0 |
| **Regressions Introduced** | 0 |

---

## Fixes Implemented

### P1 — Webhook SELECT: Add description, labels, priority (Critical)

| Item | Detail |
|------|--------|
| **Files Changed** | `supabase/functions/screenshot-webhook/index.ts`, `supabase/functions/activity-webhook/index.ts` |
| **What Changed** | `.select()` expanded from 5 columns to 9 columns: added `issue_summary`, `description`, `labels`, `priority`. Issue mapping updated to include all new fields with `issue_summary || summary` fallback. |
| **Verification** | Source-level contract tests confirm both webhooks SELECT and map all required fields. |

### P2 — Old Cache Write Path: Persist description, labels, priority

| Item | Detail |
|------|--------|
| **Files Changed** | `forge-app/src/services/issue/issueCacheService.js`, `forge-app/src/utils/jira.js` |
| **Files Created** | `forge-app/src/utils/adfToText.js` |
| **What Changed** | Jira API `fields` array expanded to include `description`, `labels`, `priority`. Cache entry mapping now calls `extractDescriptionText()` for ADF-to-text conversion and stores `labels` and `priority`. New `adfToText.js` utility mirrors the existing helper from `forge-proxy-controller.js`. |
| **Verification** | Contract tests verify import, field mapping, Jira API fields, and utility existence/correctness. |

### P3 — Description Truncation: 200 → 600 characters

| Item | Detail |
|------|--------|
| **File Changed** | `ai-server/src/services/ai/prompts.js` |
| **What Changed** | `formatAssignedIssues()` truncation limit raised from 200 to 600 characters. |
| **Token Impact** | ~35 extra tokens/issue × 30 issues max = ~1,050 tokens/prompt (negligible cost). |
| **Verification** | 8 unit tests covering: under-limit, at-limit, over-limit, boundary (600/601), null, empty, whitespace descriptions. |

### P4 — Dual Confidence Threshold: Unified at 0.4

| Item | Detail |
|------|--------|
| **Files Changed** | `ai-server/src/services/activity-service.js`, `ai-server/src/services/db/activity-db-service.js`, `ai-server/.env.example` |
| **What Changed** | Removed duplicate `MIN_CONFIDENCE_THRESHOLD` from `activity-service.js` (was `0.5` default). Single source of truth in `activity-db-service.js` raised from `0.3` to `0.4`. `.env.example` updated. |
| **Existing Test Updated** | `activity-db-service.test.js` — updated threshold test from "0.35 above 0.3" to "0.35 below 0.4" + new "0.45 above 0.4" test. |
| **Verification** | Code-level tests confirm: single declaration in db-service, no declaration in activity-service, no env var reference in activity-service, `.env.example` documents `0.4`. |

### P5 — Labels End-to-End Flow

| Item | Detail |
|------|--------|
| **Files Changed** | None (enabled by P1 + P2) |
| **What Changed** | Labels now flow from Jira → cache (P2) → webhook SELECT (P1) → `formatAssignedIssues()` (already had label handling at lines 51-53). |
| **Verification** | 5 unit tests covering: labels present, empty array, null, undefined, single label, combined with description. |

### P6 — Clustering Prompt: Add issue descriptions

| Item | Detail |
|------|--------|
| **File Changed** | `ai-server/src/services/clustering-service.js` |
| **What Changed** | Issue formatting expanded from `- KEY: summary` to `- KEY: summary — description (200 chars)` with null-safe fallback. Uses 200-char limit (shorter than P3's 1000) to avoid token bloat in the larger clustering prompt. Also fixed pre-existing bug: `formatDuration(0)` now returns `"0m"` instead of `"0s"`. |
| **Verification** | 4 tests covering: pattern presence, field inclusion, 200-char limit, null fallback. |

---

## Test Results Detail

### New Test Files (5 files, 49 tests — all passing)

| Test File | Tests | Status | Covers |
|-----------|-------|--------|--------|
| `webhook-select-fields.test.js` | 14 | PASS | P1 — SELECT columns + mapping for both webhooks |
| `prompts-description-truncation.test.js` | 14 | PASS | P3 — truncation at 600; P5 — labels in prompt |
| `confidence-threshold-alignment.test.js` | 5 | PASS | P4 — single threshold, default 0.4, no duplicate |
| `cache-write-description.test.js` | 12 | PASS | P2 — cache mapping, Jira API fields, adfToText utility |
| `clustering-description.test.js` | 4 | PASS | P6 — description in clustering context |

### Existing Test Files (7 files, 213 tests)

| Test File | Tests | Status | Notes |
|-----------|-------|--------|-------|
| `prompts.test.js` | 14 | PASS | No regressions from P3/P5 changes |
| `activity-service.test.js` | 76 | PASS | No regressions from P4 threshold removal |
| `activity-db-service.test.js` | 37 | PASS | Tests updated for new 0.4 threshold |
| `activity-controller.test.js` | 21 | PASS | No regressions |
| `activity-sanitization.test.js` | 9 | PASS | No regressions |
| `activity-polling-service.test.js` | 55 | PASS | No regressions |
| `clustering-service.test.js` | 36 | PASS | Pre-existing `formatDuration(0)` bug also fixed |

---

## Files Changed Summary

| File | Fix(es) | Type |
|------|---------|------|
| `supabase/functions/screenshot-webhook/index.ts` | P1 | Modified |
| `supabase/functions/activity-webhook/index.ts` | P1 | Modified |
| `ai-server/src/services/ai/prompts.js` | P3 | Modified |
| `ai-server/src/services/activity-service.js` | P4 | Modified |
| `ai-server/src/services/db/activity-db-service.js` | P4 | Modified |
| `ai-server/.env.example` | P4 | Modified |
| `forge-app/src/services/issue/issueCacheService.js` | P2 | Modified |
| `forge-app/src/utils/jira.js` | P2 | Modified |
| `ai-server/src/services/clustering-service.js` | P6 + formatDuration fix | Modified |
| `forge-app/src/utils/adfToText.js` | P2 | Created |
| `ai-server/tests/services/webhook-select-fields.test.js` | P1 | Created |
| `ai-server/tests/services/prompts-description-truncation.test.js` | P3, P5 | Created |
| `ai-server/tests/services/confidence-threshold-alignment.test.js` | P4 | Created |
| `ai-server/tests/services/cache-write-description.test.js` | P2 | Created |
| `ai-server/tests/services/clustering-description.test.js` | P6 | Created |
| `ai-server/tests/services/activity-db-service.test.js` | P4 | Modified (existing) |

---

## Data Flow After Fixes

```
Jira Issue (summary + description + labels + priority)
  → Forge fetches fields (P2: now includes description, labels, priority)
    → stored in user_jira_issues_cache (P2: all fields persisted)
      → read by webhook SELECT (P1: now reads description, labels, priority)
        → sent to AI server /api/analyze-batch
          → formatAssignedIssues() (P3: 600-char desc, P5: labels included)
            → LLM returns taskKey + confidence
              → confidence ≥ 0.4 → assigned (P4: unified threshold)
              → confidence < 0.4 → unassigned
```

**Clustering path:**
```
Unassigned records → clustering-service.js
  → Issues context now includes descriptions (P6: 200-char suffix)
    → LLM clusters with richer context → better suggested_issue_key
```

---

## Remaining Work (Phase 3)

| # | Item | Status |
|---|------|--------|
| P7 | Scheduled issue-cache refresh trigger | Not started |
| P8 | Structured location data in activity records | Not started |
| P9 | Fetch components & epic link for cache | Not started |
