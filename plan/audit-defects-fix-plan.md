# Issue Matching Accuracy — Audit Defects & Fix Plan

**Date:** 29 April 2026  
**Source:** Post-implementation audit of P1–P6 fixes  
**Scope:** 3 remaining defects discovered during pipeline verification

---

## Defect Summary

| # | Severity | Area | Issue | Effort |
|---|----------|------|-------|--------|
| D1 | CRITICAL | Clustering | `getUserActiveIssues` doesn't SELECT description/labels — P6 is dead code | 5 min |
| D2 | MODERATE | Webhooks | `updated` timestamp missing from issue mapping — recency signals never fire | 5 min |
| D3 | MODERATE | Polling | No cache fallback when records lack embedded issues — silent 0-match | 30 min |

---

## D1 — getUserActiveIssues Missing Description/Labels (CRITICAL)

### Problem

The clustering service calls `getUserActiveIssues()` from `user-db-service.js` to fetch issues for the clustering prompt. This function SELECTs only:

```js
.select('issue_key, summary, project_key, status')
```

The P6 fix added `issue.description.substring(0, 200)` to the clustering prompt format, but `issue.description` is always `undefined` because it's never fetched. **P6 is dead code.**

### Files to Change

- `ai-server/src/services/db/user-db-service.js` — expand SELECT and mapping

### Fix

```js
// BEFORE
.select('issue_key, summary, project_key, status')

// AFTER
.select('issue_key, issue_summary, summary, project_key, status, description, labels, priority')
```

And update the mapping (if any) to include:
```js
{
  issue_key: row.issue_key,
  summary: row.issue_summary || row.summary,
  project_key: row.project_key,
  status: row.status,
  description: row.description || null,
  labels: row.labels || [],
  priority: row.priority || null
}
```

---

## D2 — Webhook Issue Mapping Missing `updated` Timestamp (MODERATE)

### Problem

Both webhooks map cached issues to objects sent to the AI server:

```ts
userAssignedIssues = cachedIssues.map(issue => ({
  key: issue.issue_key,
  summary: issue.issue_summary || issue.summary,
  status: issue.status,
  project: issue.project_key,
  issueType: issue.issue_type,
  description: issue.description || null,
  labels: issue.labels || [],
  priority: issue.priority || null
  // ← MISSING: updated
}));
```

In `formatAssignedIssues()` (prompts.js lines 36–41), the code checks `issue.updated` to add a "likely inactive" annotation for issues not touched in >14 days. Without this field, stale issues carry equal weight — causing false matches to dormant projects (e.g., REVUP).

### Files to Change

- `supabase/functions/screenshot-webhook/index.ts` — add `updated_at` to SELECT and mapping
- `supabase/functions/activity-webhook/index.ts` — add `updated_at` to SELECT and mapping

### Fix

1. Add `updated_at` to the `.select()` (already exists in table):
```ts
.select('issue_key, issue_summary, summary, status, project_key, issue_type, description, labels, priority, updated_at')
```

2. Add to the mapping:
```ts
updated: issue.updated_at || null
```

---

## D3 — Activity Polling Path Has No Cache Fallback (MODERATE)

### Problem

The activity-polling-service (safety net when webhook delivery fails) processes batches by calling `extractUserAssignedIssues()` on the records' embedded `user_assigned_issues` field.

If records don't have embedded issues (common when the desktop app can't reach Jira at capture time), the LLM receives **zero** issues to match against — guaranteeing `taskKey: null` for all records in that batch.

The webhook path handles this by falling back to `user_jira_issues_cache`. The polling path does not.

### Files to Change

- `ai-server/src/services/activity-polling-service.js` — add cache lookup fallback

### Fix

In `processSingleBatch()`, after `extractUserAssignedIssues()` returns empty, query the cache:

```js
let userAssignedIssues = extractUserAssignedIssues(records);

// Fallback: if no issues embedded in records, fetch from cache
if (!userAssignedIssues || userAssignedIssues.length === 0) {
  const userId = records[0]?.user_id;
  if (userId) {
    const cachedIssues = await supabaseService.getUserCachedIssues(userId);
    if (cachedIssues && cachedIssues.length > 0) {
      userAssignedIssues = cachedIssues.map(issue => ({
        key: issue.issue_key,
        summary: issue.issue_summary || issue.summary,
        status: issue.status,
        project: issue.project_key,
        issueType: issue.issue_type,
        description: issue.description || null,
        labels: issue.labels || [],
        priority: issue.priority || null,
        updated: issue.updated_at || null
      }));
      logger.info(`[Polling] Fetched ${userAssignedIssues.length} cached issues as fallback for user ${userId}`);
    }
  }
}
```

A new `getUserCachedIssues(userId)` helper is needed in the Supabase service layer (or reuse `getUserActiveIssues` from `user-db-service.js` after D1 fix).

---

## Unit Tests

### Test File: `ai-server/tests/services/audit-defects.test.js`

```javascript
/**
 * Audit Defects D1, D2, D3 — Unit Tests
 * Verifies the remaining pipeline gaps are fixed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ===========================================================================
// D1 — getUserActiveIssues includes description/labels/priority
// ===========================================================================

describe('D1 — getUserActiveIssues SELECT fields', () => {

  let src;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/user-db-service.js'),
      'utf8'
    );
  });

  it('should SELECT description from user_jira_issues_cache', () => {
    // Find the getUserActiveIssues function's select call
    expect(src).toContain('description');
  });

  it('should SELECT labels from user_jira_issues_cache', () => {
    expect(src).toContain('labels');
  });

  it('should SELECT priority from user_jira_issues_cache', () => {
    expect(src).toContain('priority');
  });

  it('should SELECT updated_at for recency signals', () => {
    expect(src).toContain('updated_at');
  });
});

// ===========================================================================
// D2 — Webhook issue mapping includes `updated` field
// ===========================================================================

describe('D2 — Webhook issue mapping includes updated timestamp', () => {

  const SUPABASE_ROOT = path.join(__dirname, '../../../supabase/functions');

  const webhookFiles = [
    { name: 'screenshot-webhook', file: 'screenshot-webhook/index.ts' },
    { name: 'activity-webhook', file: 'activity-webhook/index.ts' },
  ];

  webhookFiles.forEach(({ name, file }) => {
    describe(`${name}`, () => {
      let src;

      beforeAll(() => {
        src = fs.readFileSync(path.join(SUPABASE_ROOT, file), 'utf8');
      });

      it('should SELECT updated_at from user_jira_issues_cache', () => {
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toContain('updated_at');
      });

      it('should map updated field into the issue object', () => {
        expect(src).toMatch(/updated:\s*issue\.updated_at/);
      });
    });
  });
});

// ===========================================================================
// D3 — Polling service has cache fallback
// ===========================================================================

describe('D3 — Polling service cache fallback', () => {

  let src;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '../../src/services/activity-polling-service.js'),
      'utf8'
    );
  });

  it('should have a cache fallback when extractUserAssignedIssues returns empty', () => {
    // The polling service should query the cache when embedded issues are empty
    expect(src).toMatch(/getUserCachedIssues|getUserActiveIssues|user_jira_issues_cache/);
  });

  it('should log when using cache fallback', () => {
    expect(src).toMatch(/cached issues.*fallback|fallback.*cached/i);
  });
});
```

### Run Command

```bash
cd ai-server
npx jest tests/services/audit-defects.test.js --no-coverage
```

### Existing Tests — Regression Check

After each fix, run:

```bash
npx jest tests/services/clustering-service.test.js --no-coverage
npx jest tests/services/activity-polling-service.test.js --no-coverage
npx jest tests/services/activity-service.test.js --no-coverage
npx jest tests/services/prompts.test.js --no-coverage
```

---

## Live A/B Validation

### Pre-Deployment Baseline (same 9 users, April 16–17 data)

```sql
SELECT 
  u.email,
  ar.work_date,
  ROUND(SUM(CASE WHEN ar.user_assigned_issue_key IS NULL 
    THEN ar.total_time_seconds ELSE 0 END) * 100.0 
    / NULLIF(SUM(ar.total_time_seconds), 0), 1) AS unassigned_pct,
  COUNT(DISTINCT ar.user_assigned_issue_key) 
    FILTER (WHERE ar.user_assigned_issue_key IS NOT NULL) AS distinct_issues
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-04-16' AND '2026-04-17'
  AND ar.classification = 'productive'
  AND u.email IN (
    'akhil.philkhana@amzur.com',
    'meghana.nemani@amzur.com',
    'prasad.balaga@amzur.com',
    'sireesha.saripilli@amzur.com',
    'dileep.yelleti@evokesystems.com',
    'gayatri.alluri@evokesystems.com',
    'padmaja.bodsakurthi@evokesystems.com',
    'srilakshmi.achanta@evokesystems.com',
    'soumiya.panigrahy@evokesystems.com'
  )
GROUP BY u.email, ar.work_date
ORDER BY u.email, ar.work_date;
```

### Post-Deployment Validation (5 business days after deploy)

#### D1 Validation — Clustering now uses descriptions

```sql
-- Check clustering suggestions include reasoning that references description content
SELECT 
  u.email,
  cs.group_name,
  cs.suggested_issue_key,
  cs.reasoning
FROM clustering_sessions cs
JOIN users u ON u.id = cs.user_id
WHERE cs.created_at >= NOW() - INTERVAL '5 days'
  AND cs.suggested_issue_key IS NOT NULL
  AND u.email IN (
    'padmaja.bodsakurthi@evokesystems.com',
    'srilakshmi.achanta@evokesystems.com'
  )
ORDER BY cs.created_at DESC
LIMIT 20;
-- Look for: reasoning mentions technical terms from issue descriptions
```

#### D2 Validation — Stale issues get deprioritized

```sql
-- Verify no matches to issues inactive >30 days
SELECT 
  u.email,
  ar.user_assigned_issue_key,
  ar.metadata->>'reasoning' AS reasoning,
  ar.metadata->>'confidenceScore' AS confidence
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date >= NOW() - INTERVAL '5 days'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND u.email IN ('akhil.philkhana@amzur.com', 'prasad.balaga@amzur.com')
  AND (ar.user_assigned_issue_key LIKE 'REVUP-%' OR ar.user_assigned_issue_key LIKE 'GEN-%');
-- Expected: 0 rows (stale projects deprioritized by recency signal)
```

#### D3 Validation — Polling path no longer produces 100% unassigned

```sql
-- Check records processed by polling (no webhook) still get matches
SELECT 
  u.email,
  COUNT(*) AS total_records,
  COUNT(ar.user_assigned_issue_key) AS matched_records,
  ROUND(COUNT(ar.user_assigned_issue_key) * 100.0 / COUNT(*), 1) AS match_rate_pct
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date >= NOW() - INTERVAL '5 days'
  AND ar.classification = 'productive'
  AND ar.metadata->>'source' = 'polling'  -- or check for absence of webhook marker
  AND u.email IN (
    'akhil.philkhana@amzur.com',
    'padmaja.bodsakurthi@evokesystems.com'
  )
GROUP BY u.email;
-- Expected: match_rate_pct > 50% (not 0%)
```

### Success Criteria

| Metric | Before D1-D3 Fixes | Target After | Measurement |
|--------|-------------------|-------------|-------------|
| Clustering suggestions with reasoning | Generic/empty | Contains description keywords | D1 query |
| REVUP/GENESIS false matches | Possible (no recency) | 0 | D2 query |
| Polling-path match rate | 0% (no issues provided) | > 50% | D3 query |
| Overall unassigned % (all users) | < 40% (after P1-P6) | **< 30%** | Baseline query |

### Decision Gates

- **Deploy D1+D2 together** (both are 5-min fixes, deploy as one PR)
- **Deploy D3 separately** (requires new helper function, slightly higher risk)
- **Rollback trigger:** If match rate drops below pre-fix levels or new wrong-project matches appear

---

## Implementation Checklist

- [ ] D1: Expand SELECT in `user-db-service.js` `getUserActiveIssues()`
- [ ] D1: Update mapping to include description, labels, priority, updated_at
- [ ] D2: Add `updated_at` to webhook `.select()` in screenshot-webhook
- [ ] D2: Add `updated_at` to webhook `.select()` in activity-webhook
- [ ] D2: Add `updated: issue.updated_at` to mapping in both webhooks
- [ ] D3: Add `getUserCachedIssues()` to supabase service layer
- [ ] D3: Add cache fallback logic in `activity-polling-service.js`
- [ ] Create test file `ai-server/tests/services/audit-defects.test.js`
- [ ] Run existing test suite — all green
- [ ] Run new test file — all green
- [ ] Deploy D1+D2
- [ ] Deploy D3
- [ ] Run live validation queries after 5 days

---

## File Index

| File | Defect | Change Type |
|------|--------|-------------|
| `ai-server/src/services/db/user-db-service.js` | D1 | Modified |
| `supabase/functions/screenshot-webhook/index.ts` | D2 | Modified |
| `supabase/functions/activity-webhook/index.ts` | D2 | Modified |
| `ai-server/src/services/activity-polling-service.js` | D3 | Modified |
| `ai-server/src/services/db/user-db-service.js` or supabase service | D3 | Modified |
| `ai-server/tests/services/audit-defects.test.js` | D1, D2, D3 | Created |
