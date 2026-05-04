# Audit Defects (D1–D3) — Test Report

**Date:** 2025-01-27  
**Scope:** Post-P1–P6 audit — 3 remaining pipeline gaps  
**Test Runner:** Jest 29 (Node.js)  

---

## Summary

| Metric | Value |
|--------|-------|
| Defects fixed | 3 (D1, D2, D3) |
| New tests written | 18 |
| New tests passed | **18 / 18** |
| Related regression tests | **152 / 152** |

---

## Defect Fixes

### D1 — `getUserActiveIssues` Missing Fields (Clustering Dead Code)

**Problem:** `user-db-service.getUserActiveIssues()` only fetched `issue_key, summary, project_key, status`. The P6 fix added `issue.description.substring(0, 200)` in the clustering prompt — but description was never fetched in this path, making P6 dead code for the clustering route.

**Fix:** Expanded SELECT to `issue_key, issue_summary, summary, project_key, status, description, labels, priority, updated_at` and updated the mapping to include all fields.

**File:** `ai-server/src/services/db/user-db-service.js`

**Tests (8):**
- ✅ SELECT description from user_jira_issues_cache
- ✅ SELECT labels from user_jira_issues_cache
- ✅ SELECT priority from user_jira_issues_cache
- ✅ SELECT updated_at for recency signals
- ✅ Map description in returned objects
- ✅ Map labels in returned objects
- ✅ Map updated_at in returned objects
- ✅ Use issue_summary with summary fallback

---

### D2 — Webhooks Missing `updated` Timestamp

**Problem:** Both `screenshot-webhook` and `activity-webhook` SELECTed from `user_jira_issues_cache` without `updated_at` and didn't map it to `updated`. This meant `formatAssignedIssues()` recency annotations (">14 days → likely inactive") never fired in the webhook path.

**Fix:** Added `updated_at` to the SELECT clause and `updated: issue.updated_at || null` to the mapping in both webhooks.

**Files:**
- `supabase/functions/screenshot-webhook/index.ts`
- `supabase/functions/activity-webhook/index.ts`

**Tests (4):**
- ✅ screenshot-webhook: SELECT updated_at
- ✅ screenshot-webhook: map updated field
- ✅ activity-webhook: SELECT updated_at
- ✅ activity-webhook: map updated field

---

### D3 — Polling Service Has No Cache Fallback

**Problem:** `activity-polling-service.processSingleBatch()` only called `extractUserAssignedIssues(records)` — which parses issues embedded in activity records. If records lack `user_assigned_issues` (e.g., older records or edge cases), analysis proceeded with zero issues, causing guaranteed "no match" results.

**Fix:** After `extractUserAssignedIssues()`, if result is empty, the service now falls back to `userDbService.getUserCachedIssues(userId, organizationId)` and maps the result to the expected format. Error handling prevents cache failures from breaking the batch.

**File:** `ai-server/src/services/activity-polling-service.js`

**Tests (6):**
- ✅ Import user-db-service for cache access
- ✅ Call getUserCachedIssues when extracted issues are empty
- ✅ Log when using cache fallback
- ✅ Use issuesForAnalysis (not userAssignedIssues) in analyzeBatch call
- ✅ Handle cache fetch errors gracefully (try/catch)
- ✅ Map cached issues with all required fields including updated

---

## Regression Check

| Test File | Tests | Status |
|-----------|-------|--------|
| audit-defects.test.js | 18 | ✅ PASS |
| activity-polling-service.test.js | 20 | ✅ PASS |
| activity-service.test.js | 48 | ✅ PASS |
| clustering-service.test.js | 36 | ✅ PASS |
| prompts.test.js | 12 | ✅ PASS |
| webhook-select-fields.test.js | 6 | ✅ PASS |
| clustering-description.test.js | 12 | ✅ PASS |

---

## Combined P1–P6 + D1–D3 Impact

All 9 fixes together ensure the complete data pipeline is consistent:

1. **P1–P3:** LLM prompt improvements (description, labels, priority, title prefix, key-level dedup)
2. **P4:** Confidence threshold raised to 0.4
3. **P5:** Recency annotations for issues >14 days old
4. **P6:** Clustering prompt includes description snippet
5. **D1:** Clustering DB path actually fetches the fields P6 needs
6. **D2:** Webhook path provides `updated` so P5 recency annotations fire
7. **D3:** Polling path has cache fallback so issues are always available

**Total tests covering accuracy fixes:** 280 (262 P1–P6 + 18 D1–D3)
