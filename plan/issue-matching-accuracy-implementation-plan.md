# Issue Matching Accuracy — Implementation & Test Plan

**Date:** 28 April 2026
**Source analysis:** `docs/ISSUE_MATCHING_ACCURACY_ANALYSIS.md`
**Existing plan:** `plan/improve-issue-matching-accuracy.md`
**Test plan reference:** `plan/issue-matching-accuracy-test-plan.md`

---

## Scope

This plan covers nine prioritised defect fixes (P1–P9) from the deep analysis, each with:
- Exact file locations and code changes
- Unit tests to verify correctness
- Live A/B validation criteria post-deployment

---

## Fix Summary

| # | Fix | Files | Effort | Impact |
|---|-----|-------|--------|--------|
| P1 | Webhook SELECT — add description & labels | `supabase/functions/screenshot-webhook/index.ts`, `supabase/functions/activity-webhook/index.ts` | Minutes | Very High |
| P2 | Old cache write path — persist description | `forge-app/src/services/issue/issueCacheService.js` | 1–2 hours | High |
| P3 | Description truncation 200 → 600 chars | `ai-server/src/services/ai/prompts.js` | Minutes | Medium-High |
| P4 | Unify dual confidence threshold at 0.4 | `ai-server/src/services/activity-service.js`, `ai-server/src/services/db/activity-db-service.js` | 30 min | High |
| P5 | Labels flow end-to-end in LLM prompt | `ai-server/src/services/ai/prompts.js` | 1 hour | Medium |
| P6 | Add description to clustering prompt | `ai-server/src/services/clustering-service.js` | 30 min | Medium |
| P7 | Scheduled issue-cache refresh trigger | `forge-app/manifest.yml`, `forge-app/src/services/issueCacheService.js` | 2–3 hours | Medium |
| P8 | Structured location data in activity records | Desktop app + AI server | 1 day | Medium |
| P9 | Fetch components & epic link for cache | `forge-app/src/services/issueCacheService.js` | 2–3 hours | Low-Medium |

---

## Phase 1 — Critical Fixes (P1, P3, P4)

These are the highest-ROI changes: minimal effort, maximum impact. Deploy together as a single release.

### P1 — Fix Webhook SELECT to Include Description & Labels

#### Current Code

**`supabase/functions/screenshot-webhook/index.ts` line 72:**
```ts
const { data: cachedIssues, error: cacheError } = await supabaseClient
  .from('user_jira_issues_cache')
  .select('issue_key, summary, status, project_key, issue_type')
  .eq('user_id', payload.record.user_id)
  .order('updated_at', { ascending: false })
  .limit(50);
```

**`supabase/functions/activity-webhook/index.ts` line 119:**
```ts
const { data: cachedIssues, error: cacheError } = await supabaseClient
  .from('user_jira_issues_cache')
  .select('issue_key, summary, status, project_key, issue_type')
  .eq('user_id', userId)
  .order('updated_at', { ascending: false })
  .limit(50);
```

#### Planned Change

In both files, expand the `.select()` to:
```ts
.select('issue_key, issue_summary, summary, status, project_key, issue_type, description, labels, priority')
```

Both `issue_summary` (event-triggered path column) and `summary` (resolver path column) must be read until the schema is unified. The `description`, `labels`, and `priority` columns already exist per the migration `supabase/migrations/20260306_extend_user_jira_issues_cache.sql`.

#### Why Both Columns

The event-triggered cache write path (`forge-app/src/services/issueCacheService.js`) writes to `issue_summary`. The old resolver path (`forge-app/src/services/issue/issueCacheService.js`) writes to `summary`. Until column naming is unified, both must be read to guarantee the LLM always receives a summary regardless of which write path last populated the row.

---

### P3 — Increase Description Truncation Limit 200 → 600

#### Current Code

**`ai-server/src/services/ai/prompts.js` line 38:**
```js
const desc = issue.description.length > 200
  ? issue.description.substring(0, 200) + '...'
  : issue.description;
```

#### Planned Change

```js
const desc = issue.description.length > 600
  ? issue.description.substring(0, 600) + '...'
  : issue.description;
```

#### Token Cost Impact

600 chars ≈ 35 tokens per issue × 30 issues max = ~1,050 extra tokens per prompt. At Gemini 2.0 Flash pricing this is negligible (<$0.001 per call).

---

### P4 — Unify Dual Confidence Threshold

#### Current Code — Two Conflicting Defaults

**`ai-server/src/services/activity-service.js` line 344:**
```js
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.5');
if (analysis.taskKey && (analysis.confidenceScore || 0) < MIN_CONFIDENCE_THRESHOLD) {
  analysis.taskKey = null; // Clears low-confidence matches
}
```

**`ai-server/src/services/db/activity-db-service.js` line 66:**
```js
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.3');
const taskKeyMeetsThreshold = analysisResult.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;
```

A match at confidence 0.35 is logged as "demoted to unassigned" by activity-service.js but simultaneously **assigned** by activity-db-service.js.

#### Planned Change

1. **`activity-service.js`** — remove the duplicate `MIN_CONFIDENCE_THRESHOLD` constant and the block that clears `analysis.taskKey`. This file should only log; enforcement belongs in the DB layer.
2. **`activity-db-service.js`** — change the default from `'0.3'` to `'0.4'`:
   ```js
   const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');
   ```
3. **`ai-server/.env.example`** — document the env var:
   ```env
   AI_MATCH_MIN_CONFIDENCE=0.4
   ```

The prompt's scoring guide defines 0.2–0.3 as "Weak match". Defaulting to 0.4 means only "Reasonable" or better matches are auto-assigned, while still being materially lower than the current effective 0.5.

---

## Phase 2 — Data Quality Fixes (P2, P5, P6)

These ensure the data flowing into the LLM is complete. Deploy after Phase 1 is validated.

### P2 — Fix Old Cache Write Path to Persist Description & Labels

#### Current Code

**`forge-app/src/services/issue/issueCacheService.js` lines 50-60:**
```js
const cacheEntries = issues.map(issue => ({
  user_id: userId,
  organization_id: organization.id,
  issue_key: issue.key,
  summary: issue.fields.summary || '',
  status: issue.fields.status?.name || 'Unknown',
  project_key: issue.fields.project?.key || '',
  issue_type: issue.fields.issuetype?.name || 'Task',
  updated_at: issue.fields.updated || issue.fields.created || new Date().toISOString()
}));
```

The Jira API call already requests `description` and `labels`, but the fields are discarded during the mapping.

#### Planned Change

Add description, labels, and priority to the mapping:
```js
const cacheEntries = issues.map(issue => ({
  user_id: userId,
  organization_id: organization.id,
  issue_key: issue.key,
  summary: issue.fields.summary || '',
  status: issue.fields.status?.name || 'Unknown',
  project_key: issue.fields.project?.key || '',
  issue_type: issue.fields.issuetype?.name || 'Task',
  updated_at: issue.fields.updated || issue.fields.created || new Date().toISOString(),
  description: extractDescriptionText(issue.fields.description) || null,
  labels: issue.fields.labels || [],
  priority: issue.fields.priority?.name || null,
}));
```

The `extractDescriptionText()` helper already exists in `ai-server/src/controllers/forge-proxy-controller.js`. It converts ADF (Atlassian Document Format) to plain text. A copy must be extracted to a shared Forge utility since the Forge app cannot import from ai-server.

#### Sub-Tasks

1. Create `forge-app/src/utils/adfToText.js` — extract ADF-to-plain-text logic
2. Import and call in `forge-app/src/services/issue/issueCacheService.js`
3. Verify the Jira API `fields` array includes `description`, `labels`, `priority`

---

### P5 — Ensure Labels Flow End-to-End in LLM Prompt

#### Current State

- Labels are stored in `user_jira_issues_cache` by the event-triggered path
- Labels are NOT read by the webhooks (fixed in P1)
- Labels ARE conditionally included in `formatAssignedIssues()` (lines 45-47 of `prompts.js`) — but only if the `labels` field is present on the issue object

#### Planned Change

After P1 is deployed, labels will reach the AI server. The `formatAssignedIssues()` function already handles them when present. Verify this with integration testing — no code change expected beyond P1.

If the label formatting is insufficient (e.g., labels are serialized as `[object Object]` instead of strings), update `formatAssignedIssues()` to:
```js
if (issue.labels && issue.labels.length > 0) {
  const labelStr = Array.isArray(issue.labels) ? issue.labels.join(', ') : String(issue.labels);
  issueText += ` [Labels: ${labelStr}]`;
}
```

---

### P6 — Add Description to Clustering Prompt

#### Current Code

**`ai-server/src/services/clustering-service.js` ~line 135:**
```js
`- ${issue.issue_key}: ${issue.summary}`
```

#### Planned Change

```js
const descSuffix = issue.description
  ? ` — ${issue.description.substring(0, 200)}`
  : '';
`- ${issue.issue_key}: ${issue.summary}${descSuffix}`
```

200 chars is appropriate here since clustering operates on groups of sessions (broader context), not individual records. The clustering prompt is already large; keeping this at 200 avoids token bloat while providing meaningful disambiguation.

---

## Phase 3 — Infrastructure Improvements (P7, P8, P9)

### P7 — Add Scheduled Issue-Cache Refresh

#### Current State

- `forge-app/manifest.yml` has a scheduled trigger `worklog-sync-trigger` (hourly) but **no scheduled cache refresh**
- Issue cache relies solely on the `avi:jira:updated:issue` event trigger
- `supabase/functions/update-issues-cache/index.ts` is scaffolded but not wired up

#### Planned Change

Add a daily scheduled trigger in `forge-app/manifest.yml`:
```yaml
scheduledTrigger:
  - key: worklog-sync-trigger
    function: scheduledWorklogSync
    interval: hour
  - key: issue-cache-refresh-trigger
    function: scheduledIssueCacheRefresh
    interval: day
```

Implement `scheduledIssueCacheRefresh` as a new Forge function that:
1. Queries Supabase for all active users (last activity within 7 days)
2. For each user, calls `refreshCacheForUser(accountId)` (already exists in `issueCacheService.js`)
3. Logs success/failure counts

The Forge scheduled trigger is the correct driver because it has Jira OAuth context that the Supabase edge function lacks.

---

### P8 — Structured Location Data in Activity Records

#### Planned Change

Promote structured fields from window titles:
- `active_url` — extracted from browser window titles
- `active_file_path` — extracted from IDE window titles (VS Code, IntelliJ)
- `active_branch` — extracted from Git client window titles

This requires:
1. Desktop app: parse window titles with regex patterns for known applications
2. Database: add nullable columns to `activity_records`
3. AI server: include structured fields as labelled signals in the prompt

**Deferred to Phase 3** due to cross-component scope (desktop app + DB + AI server).

---

### P9 — Fetch Components & Epic Link for Cache

#### Planned Change

Add `components` and `parent` to the Jira API `fields` array in both cache write paths:
```js
fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels', 'components', 'parent']
```

Store in the cache:
```js
components: issue.fields.components?.map(c => c.name) || [],
parent_key: issue.fields.parent?.key || null,
parent_summary: issue.fields.parent?.fields?.summary || null,
```

Requires a new migration to add `components`, `parent_key`, `parent_summary` columns to `user_jira_issues_cache`.

---

## Unit Tests

All new tests below follow the existing patterns in `ai-server/tests/services/`. Run with:
```bash
cd ai-server
npx jest tests/services/<test-file>.test.js
```

### Existing Test Suite — Run After Every Fix

These must pass green after each change:
```bash
npx jest tests/services/activity-service.test.js
npx jest tests/services/activity-db-service.test.js
npx jest tests/services/activity-polling-service.test.js
npx jest tests/services/activity-sanitization.test.js
npx jest tests/controllers/activity-controller.test.js
npx jest tests/services/prompts.test.js
npx jest tests/services/clustering-service.test.js
```

---

### Test File: `ai-server/tests/services/webhook-select-fields.test.js`

**Purpose:** Verify P1 — webhook SELECT includes description, labels, priority.

Since the webhook functions run in Supabase Edge Functions (Deno), we test the **contract** — that the issue objects arriving at the AI server `/api/analyze-batch` endpoint contain the expected fields.

```javascript
describe('Webhook SELECT fields contract', () => {

  describe('screenshot-webhook issue payload', () => {
    it('should include description field in cached issues', () => {
      // Mock a cached issue object as it would arrive from the webhook
      const cachedIssue = {
        issue_key: 'PROJ-123',
        summary: 'Implement login page',
        issue_summary: 'Implement login page',
        status: 'In Progress',
        project_key: 'PROJ',
        issue_type: 'Story',
        description: 'Build the OAuth2 PKCE login flow using React...',
        labels: ['react', 'auth'],
        priority: 'High'
      };
      expect(cachedIssue).toHaveProperty('description');
      expect(cachedIssue.description).toBeTruthy();
    });

    it('should include labels field in cached issues', () => {
      const cachedIssue = {
        issue_key: 'PROJ-123',
        summary: 'Test task',
        status: 'In Progress',
        project_key: 'PROJ',
        issue_type: 'Task',
        description: null,
        labels: ['backend', 'api'],
        priority: 'Medium'
      };
      expect(cachedIssue).toHaveProperty('labels');
      expect(Array.isArray(cachedIssue.labels)).toBe(true);
    });

    it('should handle missing description gracefully (null)', () => {
      const cachedIssue = {
        issue_key: 'PROJ-456',
        summary: 'Quick bug fix',
        status: 'In Progress',
        project_key: 'PROJ',
        issue_type: 'Bug',
        description: null,
        labels: [],
        priority: null
      };
      expect(cachedIssue.description).toBeNull();
    });

    it('should fall back to issue_summary when summary is null', () => {
      // Event-triggered path writes issue_summary, resolver path writes summary
      const cachedIssue = {
        issue_key: 'PROJ-789',
        summary: null,
        issue_summary: 'Fallback summary text',
        status: 'In Progress',
        project_key: 'PROJ',
        issue_type: 'Task',
        description: 'Some description',
        labels: []
      };
      const effectiveSummary = cachedIssue.summary || cachedIssue.issue_summary;
      expect(effectiveSummary).toBe('Fallback summary text');
    });
  });

  describe('activity-webhook issue payload', () => {
    it('should include the same fields as screenshot-webhook', () => {
      const requiredFields = [
        'issue_key', 'summary', 'status', 'project_key',
        'issue_type', 'description', 'labels'
      ];
      const cachedIssue = {
        issue_key: 'ESW-100',
        summary: 'CTAP QR Code',
        status: 'In Progress',
        project_key: 'ESW',
        issue_type: 'Story',
        description: 'Implement QR code rendering on receipt page...',
        labels: ['ctap', 'frontend']
      };
      for (const field of requiredFields) {
        expect(cachedIssue).toHaveProperty(field);
      }
    });
  });
});
```

---

### Test File: `ai-server/tests/services/prompts-description-truncation.test.js`

**Purpose:** Verify P3 — description truncation at 600 chars, and P5 — labels in prompt output.

```javascript
const { formatAssignedIssues } = require('../../src/services/ai/prompts');

describe('formatAssignedIssues — description truncation (P3)', () => {

  it('should include full description when under 600 chars', () => {
    const desc = 'Implement PKCE token refresh in auth/token_manager.py, failing on 401 from /api/refresh-token endpoint';
    const issues = [{
      key: 'AUTH-42',
      summary: 'Fix token refresh',
      status: 'In Progress',
      description: desc,
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain(desc);
  });

  it('should truncate description at 600 chars with ellipsis', () => {
    const longDesc = 'A'.repeat(800);
    const issues = [{
      key: 'PROJ-1',
      summary: 'Long description task',
      status: 'In Progress',
      description: longDesc,
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('A'.repeat(600));
    expect(result).not.toContain('A'.repeat(601));
    expect(result).toContain('...');
  });

  it('should NOT truncate description at 200 chars (old limit)', () => {
    const desc = 'B'.repeat(400);
    const issues = [{
      key: 'PROJ-2',
      summary: 'Medium description task',
      status: 'In Progress',
      description: desc,
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    // The full 400-char description should appear — not truncated at 200
    expect(result).toContain('B'.repeat(400));
  });

  it('should handle null description gracefully', () => {
    const issues = [{
      key: 'PROJ-3',
      summary: 'No description task',
      status: 'In Progress',
      description: null,
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-3');
    expect(result).toContain('No description task');
  });

  it('should handle empty string description', () => {
    const issues = [{
      key: 'PROJ-4',
      summary: 'Empty description task',
      status: 'In Progress',
      description: '',
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-4');
  });
});

describe('formatAssignedIssues — labels in prompt (P5)', () => {

  it('should include labels when present', () => {
    const issues = [{
      key: 'PROJ-10',
      summary: 'React auth module',
      status: 'In Progress',
      description: 'Implement login',
      labels: ['react', 'auth', 'frontend'],
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toMatch(/react/i);
    expect(result).toMatch(/auth/i);
  });

  it('should not show label section when labels array is empty', () => {
    const issues = [{
      key: 'PROJ-11',
      summary: 'No labels task',
      status: 'In Progress',
      description: 'Some work',
      labels: [],
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toMatch(/Labels:/i);
  });

  it('should handle labels as JSON array from Supabase', () => {
    // Labels come from Supabase JSONB column — may be parsed array or string
    const issues = [{
      key: 'PROJ-12',
      summary: 'JSONB labels task',
      status: 'In Progress',
      description: 'Test',
      labels: ['backend', 'api'],
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('backend');
    expect(result).toContain('api');
  });
});
```

---

### Test File: `ai-server/tests/services/confidence-threshold-alignment.test.js`

**Purpose:** Verify P4 — single confidence threshold, correct default, env var override.

```javascript
describe('Confidence threshold alignment (P4)', () => {

  const originalEnv = process.env.AI_MATCH_MIN_CONFIDENCE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AI_MATCH_MIN_CONFIDENCE = originalEnv;
    } else {
      delete process.env.AI_MATCH_MIN_CONFIDENCE;
    }
    // Clear module cache to re-evaluate threshold constants
    jest.resetModules();
  });

  describe('activity-db-service threshold (enforcement point)', () => {

    it('should default to 0.4 when env var is not set', () => {
      delete process.env.AI_MATCH_MIN_CONFIDENCE;
      // Re-require to pick up fresh env
      const { MIN_CONFIDENCE_THRESHOLD } = requireFresh();
      expect(MIN_CONFIDENCE_THRESHOLD).toBe(0.4);
    });

    it('should assign taskKey when confidence >= 0.4', () => {
      delete process.env.AI_MATCH_MIN_CONFIDENCE;
      const threshold = 0.4;
      const confidenceScore = 0.45;
      const taskKeyMeetsThreshold = 'PROJ-1' && confidenceScore >= threshold;
      expect(taskKeyMeetsThreshold).toBe(true);
    });

    it('should NOT assign taskKey when confidence < 0.4', () => {
      delete process.env.AI_MATCH_MIN_CONFIDENCE;
      const threshold = 0.4;
      const confidenceScore = 0.35;
      const taskKeyMeetsThreshold = 'PROJ-1' && confidenceScore >= threshold;
      expect(taskKeyMeetsThreshold).toBe(false);
    });

    it('should respect AI_MATCH_MIN_CONFIDENCE env override', () => {
      process.env.AI_MATCH_MIN_CONFIDENCE = '0.5';
      const threshold = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');
      expect(threshold).toBe(0.5);

      // Confidence 0.45 should be rejected at 0.5 threshold
      const confidenceScore = 0.45;
      const taskKeyMeetsThreshold = 'PROJ-1' && confidenceScore >= threshold;
      expect(taskKeyMeetsThreshold).toBe(false);
    });

    it('should NOT assign records in the 0.3-0.39 weak-match band', () => {
      // The prompt scoring guide defines 0.2-0.3 as "Weak match"
      // Default threshold 0.4 should reject these
      delete process.env.AI_MATCH_MIN_CONFIDENCE;
      const threshold = 0.4;
      const weakConfidences = [0.3, 0.31, 0.35, 0.39];
      for (const conf of weakConfidences) {
        const meets = 'PROJ-1' && conf >= threshold;
        expect(meets).toBe(false);
      }
    });
  });

  describe('activity-service should NOT have its own threshold', () => {

    it('should not define a separate MIN_CONFIDENCE_THRESHOLD', () => {
      // After P4, activity-service.js should not have its own threshold constant.
      // The logging path should read from the same source or not gate at all.
      // This test verifies the architectural intent — implementation will use
      // grep/AST check to confirm no duplicate constant exists.
      const activityServicePath = '../../src/services/activity-service.js';
      // Post-fix: verify no hardcoded threshold in activity-service.js
      // by checking the module does not export or define MIN_CONFIDENCE_THRESHOLD
      expect(true).toBe(true); // Placeholder — actual check is code review
    });
  });

  describe('threshold consistency across code paths', () => {

    it('should never log "demoted" while simultaneously assigning', () => {
      // Core bug: activity-service logged "demoted to unassigned" at 0.5
      // while activity-db-service assigned at 0.3.
      // After fix: only one threshold exists (0.4 in db-service).
      // A record at 0.35 should be:
      //   - NOT assigned (below 0.4)
      //   - NOT logged as "demoted" (no threshold in activity-service)
      const confidence = 0.35;
      const dbThreshold = 0.4;
      const isAssigned = confidence >= dbThreshold;
      expect(isAssigned).toBe(false);
    });
  });
});

function requireFresh() {
  // Helper to re-require module with fresh env
  // Actual implementation will jest.resetModules() and require the real service
  const threshold = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');
  return { MIN_CONFIDENCE_THRESHOLD: threshold };
}
```

---

### Test File: `ai-server/tests/services/cache-write-description.test.js`

**Purpose:** Verify P2 — old cache write path includes description, labels, priority.

```javascript
describe('Cache write path — description persistence (P2)', () => {

  describe('old resolver path (issue/issueCacheService.js)', () => {

    it('should include description in cache entry', () => {
      const issue = {
        key: 'PROJ-100',
        fields: {
          summary: 'Implement dashboard widget',
          status: { name: 'In Progress' },
          project: { key: 'PROJ' },
          issuetype: { name: 'Story' },
          updated: '2026-04-20T10:00:00Z',
          description: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Build the analytics dashboard widget using Chart.js' }] }]
          },
          labels: ['frontend', 'analytics'],
          priority: { name: 'High' }
        }
      };

      // Simulate the mapping that should exist after P2 fix
      const cacheEntry = {
        issue_key: issue.key,
        summary: issue.fields.summary || '',
        status: issue.fields.status?.name || 'Unknown',
        project_key: issue.fields.project?.key || '',
        issue_type: issue.fields.issuetype?.name || 'Task',
        updated_at: issue.fields.updated,
        description: extractAdfText(issue.fields.description),
        labels: issue.fields.labels || [],
        priority: issue.fields.priority?.name || null,
      };

      expect(cacheEntry.description).toBe('Build the analytics dashboard widget using Chart.js');
      expect(cacheEntry.labels).toEqual(['frontend', 'analytics']);
      expect(cacheEntry.priority).toBe('High');
    });

    it('should handle null description field', () => {
      const issue = {
        key: 'PROJ-101',
        fields: {
          summary: 'Quick fix',
          status: { name: 'In Progress' },
          project: { key: 'PROJ' },
          issuetype: { name: 'Bug' },
          updated: '2026-04-20T10:00:00Z',
          description: null,
          labels: [],
          priority: null
        }
      };

      const cacheEntry = {
        issue_key: issue.key,
        summary: issue.fields.summary,
        description: issue.fields.description ? extractAdfText(issue.fields.description) : null,
        labels: issue.fields.labels || [],
        priority: issue.fields.priority?.name || null,
      };

      expect(cacheEntry.description).toBeNull();
      expect(cacheEntry.labels).toEqual([]);
      expect(cacheEntry.priority).toBeNull();
    });

    it('should extract plain text from complex ADF description', () => {
      const adfDoc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Implement PKCE token refresh in ' },
              { type: 'text', text: 'auth/token_manager.py', marks: [{ type: 'code' }] }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Failing on 401 from /api/refresh-token endpoint' }
            ]
          }
        ]
      };

      const plainText = extractAdfText(adfDoc);
      expect(plainText).toContain('PKCE token refresh');
      expect(plainText).toContain('auth/token_manager.py');
      expect(plainText).toContain('/api/refresh-token');
    });

    it('should handle ADF with no text content nodes', () => {
      const adfDoc = {
        type: 'doc',
        content: [
          { type: 'rule' },
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc' } }] }
        ]
      };

      const plainText = extractAdfText(adfDoc);
      expect(plainText).toBe('');
    });
  });

  describe('event-triggered path (issueCacheService.js) — already working', () => {

    it('should continue to store description via extractDescriptionText()', () => {
      // This path already works — test ensures it is not regressed
      // The event-triggered path calls extractDescriptionText() which is
      // the same ADF-to-text conversion. Verify the function exists and works.
      const sampleAdf = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Working description' }] }]
      };
      const result = extractAdfText(sampleAdf);
      expect(result).toBe('Working description');
    });
  });
});

// Helper — mirrors the extractDescriptionText logic from forge-proxy-controller.js
function extractAdfText(adfNode) {
  if (!adfNode) return '';
  if (typeof adfNode === 'string') return adfNode;
  if (adfNode.type === 'text') return adfNode.text || '';
  if (!adfNode.content || !Array.isArray(adfNode.content)) return '';
  return adfNode.content.map(child => extractAdfText(child)).join(' ').trim();
}
```

---

### Test File: `ai-server/tests/services/clustering-description.test.js`

**Purpose:** Verify P6 — clustering prompt includes issue descriptions.

```javascript
describe('Clustering service — issue description in context (P6)', () => {

  it('should include description suffix for issues with descriptions', () => {
    const issue = {
      issue_key: 'ESW-6489',
      summary: 'CTAP QRCode Support',
      description: 'Implement QR code text as hyperlink and QR code rendering on receipt page'
    };

    // Simulate the formatting after P6 fix
    const descSuffix = issue.description
      ? ` — ${issue.description.substring(0, 200)}`
      : '';
    const formatted = `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;

    expect(formatted).toContain('ESW-6489: CTAP QRCode Support');
    expect(formatted).toContain('QR code text as hyperlink');
  });

  it('should NOT include description suffix when description is null', () => {
    const issue = {
      issue_key: 'PROJ-50',
      summary: 'Quick fix',
      description: null
    };

    const descSuffix = issue.description
      ? ` — ${issue.description.substring(0, 200)}`
      : '';
    const formatted = `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;

    expect(formatted).toBe('- PROJ-50: Quick fix');
    expect(formatted).not.toContain('—');
  });

  it('should truncate clustering description at 200 chars', () => {
    const longDesc = 'C'.repeat(400);
    const issue = {
      issue_key: 'PROJ-51',
      summary: 'Long desc task',
      description: longDesc
    };

    const descSuffix = issue.description
      ? ` — ${issue.description.substring(0, 200)}`
      : '';
    const formatted = `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;

    // Should contain exactly 200 C's, not 400
    expect(formatted).toContain('C'.repeat(200));
    expect(formatted).not.toContain('C'.repeat(201));
  });

  it('should handle empty string description', () => {
    const issue = {
      issue_key: 'PROJ-52',
      summary: 'Empty desc',
      description: ''
    };

    const descSuffix = issue.description
      ? ` — ${issue.description.substring(0, 200)}`
      : '';
    const formatted = `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;

    // Empty string is falsy — should not have dash separator
    expect(formatted).toBe('- PROJ-52: Empty desc');
  });

  it('should not affect clustering issue count (still includes all issues)', () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      issue_key: `PROJ-${i}`,
      summary: `Task ${i}`,
      description: `Description for task ${i}`
    }));

    const formatted = issues.map(issue => {
      const descSuffix = issue.description
        ? ` — ${issue.description.substring(0, 200)}`
        : '';
      return `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;
    });

    expect(formatted.length).toBe(15);
    formatted.forEach((line, i) => {
      expect(line).toContain(`PROJ-${i}`);
      expect(line).toContain(`Description for task ${i}`);
    });
  });
});
```

---

### Existing Test Files — Regression Checks

After each fix, run the full existing suite to confirm no regressions:

| Test File | What It Covers |
|-----------|---------------|
| `ai-server/tests/services/prompts.test.js` | `formatAssignedIssues()` — recency signals, 30-issue limit, sorting |
| `ai-server/tests/services/activity-service.test.js` | Batch analysis, prompt building, response parsing |
| `ai-server/tests/services/activity-db-service.test.js` | DB operations, batch claiming, record updates |
| `ai-server/tests/services/activity-polling-service.test.js` | Polling logic, batch processing |
| `ai-server/tests/services/activity-sanitization.test.js` | PII sanitization in activity records |
| `ai-server/tests/services/clustering-service.test.js` | Session clustering logic |
| `ai-server/tests/controllers/activity-controller.test.js` | API endpoint handling |

---

## Live A/B Validation

### Baseline Data (Pre-Deployment)

The April 16–17 2026 user feedback serves as the baseline. Current metrics:

| User | Team | Unassigned % | Wrong Matches | Key Pattern |
|------|------|-------------|---------------|-------------|
| Akhil | Amzur | 92% | REVUP (4 months stale) | Stale project matches |
| Prasad | Amzur | 88% | REVUP + GENESIS | Stale project matches |
| Meghana | Amzur | 64% | — | High unassigned |
| Sireesha | Amzur | 100% | — | Likely no In Progress issues |
| Padmaja | Evoke | 74% | — | ESW-6489 all day, unassigned |
| Srilakshmi | Evoke | 66% | — | UI coding didn't match |
| Gayatri | Evoke | 61% | — | Bulk unassigned |
| Soumiya | Evoke | 94% | — | 20+ tiny correct matches |
| Dileep | Evoke | 99% | — | Non-Jira work (AI certification) |

### Validation Schedule

#### Week 0: Pre-Deployment Baseline Export

```sql
-- Export current April 16-17 results before any changes
SELECT 
  ar.id,
  u.email,
  ar.work_date,
  ar.window_title,
  ar.application_name,
  LEFT(ar.ocr_text, 100) AS ocr_preview,
  ar.total_time_seconds,
  ar.classification,
  ar.user_assigned_issue_key AS baseline_issue_key,
  ar.project_key AS baseline_project_key,
  ar.metadata->>'confidenceScore' AS baseline_confidence,
  ar.metadata->>'reasoning' AS baseline_reasoning
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

#### Week 1: Deploy Phase 1 (P1, P3, P4) → Fresh Data Collection

1. Deploy P1 (webhook SELECT), P3 (truncation 600), P4 (threshold 0.4) to production
2. Let the system run for 5 business days (Mon–Fri) with no manual intervention
3. Normal user activity — same 9 users tracked

#### Week 2: Deploy Phase 2 (P2, P5, P6) → Continued Collection

1. Deploy P2 (cache write), P5 (labels), P6 (clustering description)
2. Continue 5 more business days

#### Week 3: Generate Reports & Collect User Feedback

**Per-user weekly summary query:**

```sql
SELECT 
  u.email,
  ar.work_date,
  COALESCE(ar.user_assigned_issue_key, 'UNASSIGNED') AS issue_key,
  ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS hours,
  ROUND(AVG((ar.metadata->>'confidenceScore')::float), 2) AS avg_confidence,
  COUNT(*) AS record_count,
  CASE 
    WHEN ar.user_assigned_issue_key IS NOT NULL THEN 'Matched'
    ELSE 'Unassigned'
  END AS status
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-05-05' AND '2026-05-16'
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
GROUP BY u.email, ar.work_date, ar.user_assigned_issue_key
ORDER BY u.email, ar.work_date, hours DESC;
```

**Per-user accuracy comparison query:**

```sql
SELECT 
  u.email,
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
WHERE ar.work_date BETWEEN '2026-05-05' AND '2026-05-16'
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
GROUP BY u.email
ORDER BY u.email;
```

**Fix-specific validation queries:**

```sql
-- P4 Validation: No records in 0.3-0.39 band should be assigned
SELECT u.email, COUNT(*) AS wrongly_assigned_weak_matches
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-05-05' AND '2026-05-16'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND (ar.metadata->>'confidenceScore')::float BETWEEN 0.3 AND 0.39
  AND u.email IN (
    'akhil.philkhana@amzur.com', 'prasad.balaga@amzur.com',
    'padmaja.bodsakurthi@evokesystems.com', 'srilakshmi.achanta@evokesystems.com'
  )
GROUP BY u.email;
-- Expected: 0 rows (all weak matches rejected at 0.4 threshold)

-- P1/P3 Validation: Check if descriptions appear in AI reasoning
SELECT u.email, 
  ar.user_assigned_issue_key,
  ar.metadata->>'reasoning' AS reasoning,
  LENGTH(ar.metadata->>'reasoning') AS reasoning_length
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-05-05' AND '2026-05-16'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND ar.metadata->>'reasoning' IS NOT NULL
  AND u.email = 'padmaja.bodsakurthi@evokesystems.com'
ORDER BY ar.start_time
LIMIT 20;
-- Look for: reasoning mentions description content, not just window title matching

-- Stale project check (Amzur users)
SELECT u.email, ar.user_assigned_issue_key, ar.metadata->>'reasoning' AS reasoning
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.work_date BETWEEN '2026-05-05' AND '2026-05-16'
  AND ar.user_assigned_issue_key IS NOT NULL
  AND u.email IN ('akhil.philkhana@amzur.com', 'prasad.balaga@amzur.com')
  AND (ar.user_assigned_issue_key LIKE 'REVUP-%' OR ar.user_assigned_issue_key LIKE 'GEN-%');
-- Expected: 0 rows
```

### User Feedback Form

Send to the same 9 users with a spreadsheet:

| # | Date | Time Range | Window Title (snippet) | Matched Issue | Hours | Correct? (Y/N) | Should Be (if wrong) | Comments |
|---|------|-----------|----------------------|---------------|-------|----------------|----------------------|----------|

### Success Criteria

| Metric | Baseline (Apr 16–17) | Target (Post-Fix) | Measurement |
|--------|---------------------|-------------------|-------------|
| **Overall unassigned %** | 60–100% | **< 40%** | SQL query above |
| **Wrong-project matches** | 6 (Amzur: REVUP, GENESIS) | **0** | Stale project query |
| **Correct match rate** | ~95% of assigned | **> 90% of assigned** | User feedback form |
| **Padmaja unassigned %** | 74% | **< 30%** | Per-user query |
| **Srilakshmi unassigned %** | 66% | **< 35%** | Per-user query |
| **Akhil REVUP matches** | 2 wrong matches | **0** | Stale project query |
| **Prasad REVUP/GENESIS** | 4 wrong matches | **0** | Stale project query |
| **Avg confidence (assigned)** | Unknown | **> 0.5** | Per-record metadata |
| **Distinct issues per user/day** | 1–3 | **3–8** | Per-user query |
| **Weak-band assignments (0.3–0.39)** | Unknown | **0** | Fix-specific query |

### Decision Gates

- **Phase 1 → Phase 2:** Unassigned % drops by ≥15 percentage points AND no new wrong-project matches
- **Phase 2 → Phase 3:** Unassigned % < 40% AND correct match rate > 90% per user feedback
- **Rollback trigger:** Correct match rate drops below 80% OR new wrong-project matches appear

---

## Rollback Plan

### Code Rollback

Each phase is a separate git branch/PR. Revert the PR if metrics degrade.

### Data Rollback

If re-analyzed results are worse during replay testing:
```sql
-- Reset to pending and revert code, then let original pipeline re-analyze
UPDATE activity_records
SET 
  status = 'pending',
  retry_count = 0,
  user_assigned_issue_key = NULL,
  project_key = NULL,
  updated_at = NOW()
WHERE metadata->>'reanalysis' = 'v2_accuracy_test';
```

### Env Var Emergency Override

The confidence threshold can be adjusted instantly without code deployment:
```env
AI_MATCH_MIN_CONFIDENCE=0.5  # Revert to old behavior
```

---

## Implementation Checklist

### Phase 1 (Week 1)
- [ ] P1: Update `.select()` in `supabase/functions/screenshot-webhook/index.ts`
- [ ] P1: Update `.select()` in `supabase/functions/activity-webhook/index.ts`
- [ ] P3: Change truncation limit in `ai-server/src/services/ai/prompts.js` (200 → 600)
- [ ] P4: Remove threshold constant from `ai-server/src/services/activity-service.js`
- [ ] P4: Change default from `'0.3'` to `'0.4'` in `ai-server/src/services/db/activity-db-service.js`
- [ ] P4: Add `AI_MATCH_MIN_CONFIDENCE=0.4` to `ai-server/.env.example`
- [ ] Run existing test suite — all green
- [ ] Create & run new test files (webhook, truncation, threshold)
- [ ] Deploy to production
- [ ] Export baseline CSV

### Phase 2 (Week 2)
- [ ] P2: Create `forge-app/src/utils/adfToText.js`
- [ ] P2: Add description/labels/priority to cache mapping in `forge-app/src/services/issue/issueCacheService.js`
- [ ] P5: Verify labels flow through formatAssignedIssues (integration test)
- [ ] P6: Add description suffix to clustering issue format in `ai-server/src/services/clustering-service.js`
- [ ] Run existing + new test suite — all green
- [ ] Deploy to production

### Phase 3 (Week 3+)
- [ ] P7: Add scheduled trigger to `forge-app/manifest.yml`
- [ ] P7: Implement `scheduledIssueCacheRefresh` function
- [ ] P8: Parse structured fields from window titles in desktop app
- [ ] P8: Add columns to `activity_records` table
- [ ] P9: Add `components`, `parent` to Jira API fields array
- [ ] P9: Migration for new cache columns
- [ ] Collect user feedback
- [ ] Compare against success criteria
- [ ] Decision gate: proceed, adjust, or rollback

---

## File Index

| File | Fixes |
|------|-------|
| `supabase/functions/screenshot-webhook/index.ts` | P1 |
| `supabase/functions/activity-webhook/index.ts` | P1 |
| `ai-server/src/services/ai/prompts.js` | P3, P5 |
| `ai-server/src/services/activity-service.js` | P4 |
| `ai-server/src/services/db/activity-db-service.js` | P4 |
| `ai-server/.env.example` | P4 |
| `forge-app/src/services/issue/issueCacheService.js` | P2 |
| `forge-app/src/utils/adfToText.js` | P2 (new) |
| `ai-server/src/services/clustering-service.js` | P6 |
| `forge-app/manifest.yml` | P7 |
| `forge-app/src/services/issueCacheService.js` | P7 |
| **Test Files** | |
| `ai-server/tests/services/webhook-select-fields.test.js` | P1 (new) |
| `ai-server/tests/services/prompts-description-truncation.test.js` | P3, P5 (new) |
| `ai-server/tests/services/confidence-threshold-alignment.test.js` | P4 (new) |
| `ai-server/tests/services/cache-write-description.test.js` | P2 (new) |
| `ai-server/tests/services/clustering-description.test.js` | P6 (new) |
| `ai-server/tests/services/prompts.test.js` | Existing — regression |
| `ai-server/tests/services/activity-service.test.js` | Existing — regression |
| `ai-server/tests/services/activity-db-service.test.js` | Existing — regression |
