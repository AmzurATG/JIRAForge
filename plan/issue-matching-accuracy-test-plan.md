# Issue Matching Accuracy — Test Plan

## Overview

Validate that the proposed fixes in `plan/improve-issue-matching-accuracy.md` reduce unassigned activity records and eliminate wrong-project matches, using April 16–17 2026 feedback data as the baseline.

## Test Layers

1. **Unit Tests** — Verify code changes don't break existing behavior
2. **Replay Testing** — Re-analyze April 16–17 records with updated pipeline
3. **Live A/B Validation** — Collect fresh user feedback post-deployment

---

## Layer 1: Unit Tests

### Run Existing Suite After Each Fix

```bash
cd ai-server
npx jest tests/services/activity-service.test.js
npx jest tests/services/activity-db-service.test.js
npx jest tests/services/activity-polling-service.test.js
npx jest tests/services/activity-sanitization.test.js
npx jest tests/controllers/activity-controller.test.js
```

### New Tests Per Fix

#### Fix 1: Confidence Threshold 0.3
**File:** `ai-server/tests/services/activity-db-service.test.js`

```javascript
describe('confidence threshold gating', () => {
  it('should assign taskKey when confidence is 0.35 (above 0.3)', async () => {
    // Mock analysisResult with confidence 0.35
    // Assert: effectiveTaskKey is NOT null
  });

  it('should set taskKey to null when confidence is 0.25 (below 0.3)', async () => {
    // Mock analysisResult with confidence 0.25
    // Assert: effectiveTaskKey IS null
  });

  it('should respect AI_MATCH_MIN_CONFIDENCE env override', async () => {
    // Set process.env.AI_MATCH_MIN_CONFIDENCE = '0.4'
    // Mock analysisResult with confidence 0.35
    // Assert: effectiveTaskKey IS null (below custom threshold)
  });
});
```

#### Fix 2: Session Continuity Prompt
**File:** `ai-server/tests/services/activity-service.test.js`

```javascript
describe('session continuity in prompt', () => {
  it('should include SESSION CONTINUITY instruction in batch prompt', () => {
    const prompt = buildBatchAnalysisPrompt(mockRecords, mockIssuesText);
    expect(prompt).toContain('SESSION CONTINUITY');
    expect(prompt).toContain('chronological order');
  });
});
```

#### Fix 4: Issue Recency Signal
**File:** `ai-server/tests/services/prompts.test.js` (new)

```javascript
describe('formatAssignedIssues', () => {
  it('should add recency warning for issues updated >14 days ago', () => {
    const issues = [{ key: 'PROJ-1', summary: 'Old task', status: 'In Progress',
      updated: new Date(Date.now() - 30 * 86400000).toISOString() }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('Last updated: 30 days ago');
    expect(result).toContain('likely inactive');
  });

  it('should NOT add recency warning for recently updated issues', () => {
    const issues = [{ key: 'PROJ-2', summary: 'Fresh task', status: 'In Progress',
      updated: new Date().toISOString() }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('Last updated');
  });
});
```

#### Fix 6: OCR Text Limit 1000
**File:** `ai-server/tests/services/activity-service.test.js`

```javascript
describe('OCR text limit in prompt', () => {
  it('should include up to 1000 chars of OCR text', () => {
    const longText = 'A'.repeat(1500);
    const records = [{ ...mockRecord, ocr_text: longText }];
    const prompt = buildBatchAnalysisPrompt(records, 'None');
    expect(prompt).toContain('A'.repeat(1000));
    expect(prompt).not.toContain('A'.repeat(1001));
  });
});
```

#### Fix 7: Issue List Limit 30, Sorted by Recency
**File:** `ai-server/tests/services/prompts.test.js` (new)

```javascript
describe('issue list limits and sorting', () => {
  it('should return up to 30 issues', () => {
    const issues = Array.from({ length: 40 }, (_, i) => ({
      key: `PROJ-${i}`, summary: `Task ${i}`, status: 'In Progress',
      updated: new Date(Date.now() - i * 86400000).toISOString()
    }));
    const result = formatAssignedIssues(issues);
    const keys = result.match(/PROJ-\d+/g);
    expect(keys.length).toBe(30);
  });

  it('should sort issues by recency (newest first)', () => {
    const issues = [
      { key: 'PROJ-OLD', summary: 'Old', status: 'In Progress',
        updated: '2026-03-01T00:00:00Z' },
      { key: 'PROJ-NEW', summary: 'New', status: 'In Progress',
        updated: '2026-04-20T00:00:00Z' }
    ];
    const result = formatAssignedIssues(issues);
    expect(result.indexOf('PROJ-NEW')).toBeLessThan(result.indexOf('PROJ-OLD'));
  });
});
```

#### Fix 8: Low-Confidence OCR Flag
**File:** `ai-server/tests/services/activity-service.test.js`

```javascript
describe('low-confidence OCR flagging', () => {
  it('should flag OCR text with confidence < 0.4', () => {
    const records = [{ ...mockRecord, ocr_text: 'some text', ocr_confidence: 0.2 }];
    const prompt = buildBatchAnalysisPrompt(records, 'None');
    expect(prompt).toContain('low confidence');
  });

  it('should NOT flag OCR text with confidence >= 0.4', () => {
    const records = [{ ...mockRecord, ocr_text: 'some text', ocr_confidence: 0.8 }];
    const prompt = buildBatchAnalysisPrompt(records, 'None');
    expect(prompt).not.toContain('low confidence');
  });
});
```

---

## Layer 2: Replay Testing

### Prerequisites

- Fixes deployed to AI server (staging or production)
- Supabase access to run SQL queries
- Baseline CSV exported before resetting records

### Step 1: Export Baseline

Save current results for April 16–17 records:

```sql
-- Run against Supabase and export as baseline_apr16_17.csv
SELECT 
  ar.id,
  u.email,
  ar.work_date,
  ar.window_title,
  ar.application_name,
  LEFT(ar.ocr_text, 100) AS ocr_preview,
  ar.total_time_seconds,
  ar.classification,
  -- Baseline results
  ar.user_assigned_issue_key AS baseline_issue_key,
  ar.project_key AS baseline_project_key,
  ar.metadata->>'confidenceScore' AS baseline_confidence,
  ar.metadata->>'reasoning' AS baseline_reasoning,
  ar.metadata->>'aiModel' AS baseline_model
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-04-16' AND '2026-04-17'
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
ORDER BY u.email, ar.start_time;
```

### Step 2: Reset Records for Re-Analysis (Start with 4 Users)

```sql
-- Phase 1: Reset 4 users (2 from each team) to limit blast radius
UPDATE activity_records
SET 
  status = 'pending',
  retry_count = 0,
  user_assigned_issue_key = NULL,
  project_key = NULL,
  metadata = metadata || '{"reanalysis": "v2_accuracy_test"}'::jsonb,
  updated_at = NOW()
WHERE work_date BETWEEN '2026-04-16' AND '2026-04-17'
  AND classification = 'productive'
  AND user_id IN (
    SELECT id FROM users WHERE email IN (
      'akhil.philkhana@amzur.com',       -- Amzur: stale project matches
      'prasad.balaga@amzur.com',          -- Amzur: stale project matches
      'padmaja.bodsakurthi@evokesystems.com',  -- Evoke: same-issue-all-day
      'srilakshmi.achanta@evokesystems.com'    -- Evoke: UI work unmatched
    )
  );
```

### Step 3: Monitor Re-Analysis Progress

```sql
-- Check every 3-5 minutes until all records are analyzed
SELECT status, COUNT(*) 
FROM activity_records 
WHERE work_date BETWEEN '2026-04-16' AND '2026-04-17'
  AND metadata->>'reanalysis' = 'v2_accuracy_test'
GROUP BY status;

-- Expected progression:
-- pending → processing → analyzed (15-20 min for ~200 records)
```

### Step 4: Compare Results

```sql
-- Side-by-side comparison: new results
SELECT 
  u.email,
  ar.work_date,
  ar.window_title,
  ar.total_time_seconds,
  ar.user_assigned_issue_key AS new_issue_key,
  ar.metadata->>'confidenceScore' AS new_confidence,
  ar.metadata->>'reasoning' AS new_reasoning,
  ar.metadata->>'aiModel' AS new_model
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-04-16' AND '2026-04-17'
  AND ar.metadata->>'reanalysis' = 'v2_accuracy_test'
ORDER BY u.email, ar.start_time;
```

### Step 5: Compute Accuracy Metrics

```sql
-- Per-user assigned vs unassigned hours
SELECT 
  u.email,
  ar.work_date,
  ROUND(SUM(CASE WHEN ar.user_assigned_issue_key IS NOT NULL 
    THEN ar.total_time_seconds ELSE 0 END) / 3600.0, 2) AS assigned_hours,
  ROUND(SUM(CASE WHEN ar.user_assigned_issue_key IS NULL 
    THEN ar.total_time_seconds ELSE 0 END) / 3600.0, 2) AS unassigned_hours,
  ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS total_hours,
  ROUND(
    SUM(CASE WHEN ar.user_assigned_issue_key IS NULL THEN ar.total_time_seconds ELSE 0 END) * 100.0 
    / NULLIF(SUM(ar.total_time_seconds), 0), 1
  ) AS unassigned_pct,
  COUNT(DISTINCT ar.user_assigned_issue_key) 
    FILTER (WHERE ar.user_assigned_issue_key IS NOT NULL) AS distinct_issues
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-04-16' AND '2026-04-17'
  AND ar.metadata->>'reanalysis' = 'v2_accuracy_test'
  AND ar.classification = 'productive'
GROUP BY u.email, ar.work_date
ORDER BY u.email, ar.work_date;
```

### Step 6: Validate Fix-Specific Outcomes

```sql
-- Fix 1: Records with confidence 0.3-0.49 that are now assigned
SELECT u.email, COUNT(*) AS newly_assigned_count,
  ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS newly_assigned_hours
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.metadata->>'reanalysis' = 'v2_accuracy_test'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND (ar.metadata->>'confidenceScore')::float BETWEEN 0.3 AND 0.49
GROUP BY u.email;

-- Fix 2: Consecutive records inheriting same issue (session continuity)
SELECT u.email, ar.user_assigned_issue_key, 
  COUNT(*) AS consecutive_records,
  ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS total_hours
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.metadata->>'reanalysis' = 'v2_accuracy_test'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND u.email = 'padmaja.bodsakurthi@evokesystems.com'
GROUP BY u.email, ar.user_assigned_issue_key
ORDER BY total_hours DESC;

-- Fix 3: Verify no stale project matches for Amzur users
SELECT u.email, ar.user_assigned_issue_key, ar.metadata->>'reasoning' AS reasoning
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.metadata->>'reanalysis' = 'v2_accuracy_test'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND u.email IN ('akhil.philkhana@amzur.com', 'prasad.balaga@amzur.com')
  AND (ar.user_assigned_issue_key LIKE 'REVUP-%' 
    OR ar.user_assigned_issue_key LIKE 'GEN-%');
-- Expected: 0 rows
```

---

## Layer 3: Live A/B Validation

### Week 1: Fresh Data Collection

1. Deploy Phase 1 fixes to production
2. Let the system run for 5 business days (Mon–Fri)
3. No intervention — normal user activity

### Week 2: Generate Report & Collect Feedback

Generate the same per-person report format as the April 16–17 feedback:

```sql
-- Weekly summary per user
SELECT 
  u.email,
  ar.work_date,
  COALESCE(ar.user_assigned_issue_key, 'UNASSIGNED') AS issue_key,
  ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS hours,
  CASE 
    WHEN ar.user_assigned_issue_key IS NOT NULL THEN '✅ Matched'
    ELSE '⚠️ Unassigned'
  END AS status
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-04-28' AND '2026-05-02'
  AND ar.classification = 'productive'
GROUP BY u.email, ar.work_date, ar.user_assigned_issue_key
ORDER BY u.email, ar.work_date, hours DESC;
```

Send to same users with the feedback form:

| # | Issue Key | Date | Issue Summary | Hours | Status | ✅ Confirmation | 💬 Comments |
|---|-----------|------|---------------|-------|--------|----------------|------------|

### Success Criteria

| Metric | Baseline (Apr 16–17) | Target | Pass? |
|--------|---------------------|--------|-------|
| **Overall unassigned %** | 60–100% | **< 40%** | |
| **Wrong-project matches** | 6 (Amzur: REVUP, GENESIS) | **0** | |
| **Correct match rate** | ~95% of assigned | **> 90%** | |
| **Padmaja: unassigned %** | 74% | **< 30%** | |
| **Srilakshmi: unassigned %** | 66% | **< 35%** | |
| **Akhil: REVUP matches** | 2 wrong matches | **0** | |
| **Prasad: REVUP/GENESIS** | 4 wrong matches | **0** | |

---

## Smoke Test (Pre-Replay)

Before resetting real records, validate with a manual API call simulating Padmaja's case:

```bash
curl -X POST https://forgesync.amzur.com/api/analyze-batch \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "id": "smoke-1",
        "window_title": "ESW-6489 - CTAP QRCode Support - Jira",
        "application_name": "chrome.exe",
        "ocr_text": "CTAP Support QRCodeText as Hyperlink and QRCode on Receipt",
        "total_time_seconds": 120,
        "start_time": "2026-04-16T09:00:00Z",
        "end_time": "2026-04-16T09:02:00Z"
      },
      {
        "id": "smoke-2",
        "window_title": "receipt-qrcode.tsx - ctap-frontend - Visual Studio Code",
        "application_name": "Code.exe",
        "ocr_text": "function QRCodeReceipt({ url, text }) { return <div><img src={generateQR(url)} /><a href={url}>{text}</a></div> }",
        "total_time_seconds": 900,
        "start_time": "2026-04-16T09:02:00Z",
        "end_time": "2026-04-16T09:17:00Z"
      },
      {
        "id": "smoke-3",
        "window_title": "Terminal - ctap-frontend - Visual Studio Code",
        "application_name": "Code.exe",
        "ocr_text": "git push origin feature/qrcode-receipt\nnpm run build\nBuild successful",
        "total_time_seconds": 300,
        "start_time": "2026-04-16T09:17:00Z",
        "end_time": "2026-04-16T09:22:00Z"
      }
    ],
    "userAssignedIssues": [
      {"key": "ESW-6489", "summary": "CTAP – Support QRCodeText as Hyperlink and QRCode on Receipt", "status": "In Progress"},
      {"key": "ESW-6500", "summary": "Dashboard login page redesign", "status": "In Progress"}
    ]
  }'
```

**Expected results:**

| Record | Expected Issue | Expected Confidence | Before Fix |
|--------|---------------|-------------------|------------|
| smoke-1 (Jira tab) | ESW-6489 | 0.8–0.9 | ✅ Would match |
| smoke-2 (VS Code coding) | ESW-6489 | 0.5–0.6 | ❌ Would be ~0.3–0.4, unassigned |
| smoke-3 (Terminal deploy) | ESW-6489 | 0.4–0.5 | ❌ Would be ~0.2–0.3, unassigned |

If smoke-2 and smoke-3 match ESW-6489 at >= 0.3 confidence, the session continuity fix is working.

---

## Rollback Plan

If re-analyzed results are worse, restore baseline:

```sql
-- Rollback: reset re-analyzed records to their original state
-- Only works if baseline CSV was exported in Step 1
-- Import baseline CSV to a temp table, then:
UPDATE activity_records ar
SET 
  user_assigned_issue_key = tmp.baseline_issue_key,
  project_key = tmp.baseline_project_key,
  status = 'analyzed',
  metadata = ar.metadata - 'reanalysis'
FROM baseline_temp tmp
WHERE ar.id = tmp.id;
```

Alternatively, if no temp table: reset to `pending` again and revert the code changes, then let the original pipeline re-analyze.
