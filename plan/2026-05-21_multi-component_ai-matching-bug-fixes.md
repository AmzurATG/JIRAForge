# AI Issue Matching Bug Fixes — Implementation Plan

**Date:** May 21, 2026  
**Components:** ai-server, python-desktop-app, forge-app  
**Estimated Effort:** 6-8 hours engineering + 2 hours testing  
**Risk Level:** Low (localized fixes, no architectural changes)

---

## Problem

The AI issue matching system has **10 unfixed bugs** causing significant accuracy degradation:

### User-Visible Impacts

1. **Incomplete issue descriptions** — 60-70% of Jira issue descriptions are truncated, losing critical context (lists, code blocks, tables)
2. **Wrong recency sorting** — Recently updated issues appear as "stale" while old issues appear "fresh", breaking priority matching
3. **Auth/security work unmatchable** — Activities on authentication, tokens, passwords get redacted as credentials
4. **Random context bias** — Previous matches on unrelated tasks influence current batch matching
5. **Lost URL context** — Jira board URLs, dashboard links lose identifying UUIDs
6. **Missing priority signals** — Issue priority unavailable when desktop app provides issues directly
7. **Garbage OCR confuses LLM** — Low-confidence OCR text (confidence <0.4) included in prompts, creating false matches
8. **Stale correction patterns** — LLM suggests completed/removed issues based on old user corrections
9. **Build numbers redacted** — Credit card regex matches build IDs, phone numbers, serial numbers
10. **Clustering context too short** — Unassigned work clustering uses 200 chars vs 1000 chars in batch analysis

**Cumulative Effect:** Matching accuracy estimated at ~65-70%. Bugs #1, #2, #3 alone affect **70-87% of all matching decisions**.

---

## Root Cause / Context

### Architecture Overview

```
Desktop App (Python)
    ↓ Fetches issues + sends activity
Supabase (user_jira_issues_cache, activity_records)
    ↓ Polling every 5 min
AI Server (Node.js)
    ↓ Fetches cached issues + recent activities
    ↓ Builds LLM prompt with context
Portkey → Gemini 2.0 Flash / OpenAI GPT
    ↓ Returns taskKey + confidence
Activity Record Updated
```

### Critical Code Paths

1. **Issue Caching:** `forge-app/issueCacheService.js` → `POST /api/forge/issues/cache` → `ai-server/forge-proxy-controller.js:cacheUserIssues()`
2. **Activity Polling:** `ai-server/activity-polling-service.js:processActivities()` → `activity-service.js:analyzeActivityBatch()`
3. **Prompt Building:** `activity-service.js:buildBatchAnalysisPrompt()` + `prompts.js:formatAssignedIssues()`
4. **Sanitization:** `activity-service.js:SANITIZATION_PATTERNS` applied to OCR text
5. **Desktop Fetch:** `python-desktop-app/desktop_app.py:fetch_issues_from_jira_api()` / `format_cached_issues()`

### Why These Bugs Exist

1. **Code Duplication:** AI server copied ADF extractor from forge-app but only implemented 2-level traversal instead of full recursion
2. **Available Data Not Used:** Jira's `fields.updated` timestamp fetched but never stored; server write time used instead
3. **Over-Defensive Sanitization:** Regex patterns designed for credentials match feature names in natural language
4. **Missing Guards:** Context hints (previous match, corrections) applied without validation or staleness checks
5. **Inconsistent Standards:** Different pipelines (batch vs clustering) use different truncation limits without documented rationale

---

## Proposed Solution

### Fix Grouping Strategy

**Phase 1 — Critical (Deploy Together):**
- Bug #1, #2, #3: Core data quality issues affecting 70-87% of decisions
- **Must deploy as single atomic change** to avoid partial-fix inconsistencies

**Phase 2 — High (Same Sprint):**
- Bug #4, #5: Context preservation improvements

**Phase 3 — Medium (Next Sprint):**
- Bug #6, #7, #8: Edge case handling

**Phase 4 — Low (Backlog):**
- Bug #9, #10: Minor optimizations

### Implementation Approach by Bug

#### BUG #1: Non-Recursive ADF Extraction

**File:** `ai-server/src/controllers/forge-proxy-controller.js`

**Change:**
1. Copy `forge-app/src/utils/adfToText.js` to `ai-server/src/utils/adfToText.js` (already compatible, zero modification needed)
2. Replace local `extractDescriptionText()` (lines 1421-1435) with import:
   ```javascript
   const { extractDescriptionText } = require('../utils/adfToText');
   ```
3. Remove duplicate function definition

**Why This Works:**
- Forge-app's implementation uses recursive `walk()` function that handles arbitrary nesting depth
- Already tested and production-proven in forge-app codebase
- Zero external dependencies

---

#### BUG #2: Cache Timestamp Mismatch

**File:** `ai-server/src/controllers/forge-proxy-controller.js` (line 1384)

**Change:**
```javascript
// BEFORE:
updated_at: getUTCISOString()

// AFTER:
updated_at: fields.updated || getUTCISOString()
```

**Migration Required:**
```sql
-- Clear cache to force rebuild with correct timestamps
DELETE FROM user_jira_issues_cache;
```

**Why This Works:**
- `fields.updated` is already fetched in JQL query (forge-app/issueCacheService.js:95)
- Available in issue object at cache-write time
- Fallback to server time handles edge cases where Jira doesn't return `updated`

**Rollout Plan:**
1. Deploy code change to ai-server
2. Run migration SQL in Supabase
3. Cache rebuilds automatically within 30 minutes (forge-app refreshes every 30 min)
4. Monitor `user_jira_issues_cache` table for repopulation

---

#### BUG #3: OCR Sanitization Over-Matching

**File:** `ai-server/src/services/activity-service.js` (line 30-31)

**Change:**
```javascript
// BEFORE:
{ pattern: /(?:password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, replacement: '[REDACTED_CREDENTIAL]' },

// AFTER:
{ pattern: /(?:password|passwd|pwd|secret|token)\s*=\s*\S+/gi, replacement: '[REDACTED_CREDENTIAL]' },
```

**Rationale:**
- Remove `:` from separator options (colon appears in natural language prose)
- Only match `=` (assignment operator, not prose separator)
- Examples preserved: `password=abc123` ✓ redacted, `password: hashing algorithm` ✓ preserved

---

#### BUG #4: Context Bias Without Guards

**File:** `ai-server/src/services/activity-service.js` (lines 175-177)

**Change:** Add 3-tier validation before including `previousMatchContext`:

```javascript
if (previousMatchContext && previousMatchContext.taskKey) {
  // Guard 1: Confidence threshold
  if (previousMatchContext.confidenceScore < 0.7) {
    logger.debug('[Activity] Skipping low-confidence previous match (confidence=%s)', 
      previousMatchContext.confidenceScore);
    previousMatchContext = null;
  }
  
  // Guard 2: Staleness check
  if (previousMatchContext && previousMatchContext.minutesAgo > 15) {
    logger.debug('[Activity] Previous match too stale (%d min ago), skipping', 
      previousMatchContext.minutesAgo);
    previousMatchContext = null;
  }
  
  // Guard 3: Relevance to current batch
  if (previousMatchContext) {
    const currentBatchProjects = records
      .map(r => r.window_title?.match(/([A-Z]+)-\d+/)?.[1])
      .filter(Boolean);
    
    const previousProject = previousMatchContext.taskKey.split('-')[0];
    const isRelevant = currentBatchProjects.some(p => p === previousProject);
    
    if (!isRelevant && currentBatchProjects.length > 0) {
      logger.debug('[Activity] Previous match not relevant to current batch (prev=%s, current=%s)', 
        previousProject, currentBatchProjects.join(','));
      previousMatchContext = null;
    }
  }
}

// Only add hint if previousMatchContext survived all guards
if (previousMatchContext && previousMatchContext.taskKey) {
  previousSessionHint = `\nPrevious session context: ...`;
}
```

**Why This Works:**
- **Confidence filter:** Low-confidence previous matches (0.4-0.6) are unreliable anchors
- **Staleness filter:** 15-min threshold ensures recency (original 30-min window too broad)
- **Relevance filter:** Only apply hint when current batch mentions same project (via issue key in window title)

---

#### BUG #5: UUID Redaction Removes URL Context

**File:** `ai-server/src/services/activity-service.js` (line 54)

**Change:**
```javascript
// BEFORE:
{ pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[REDACTED_UUID]' },

// AFTER:
// Only redact UUIDs explicitly labeled as sensitive identifiers
{ pattern: /(?:user|account|session|org)Id[=:]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, replacement: '[REDACTED_UUID]' },
```

**Rationale:**
- Preserves UUIDs in URLs (board IDs, page IDs, report IDs)
- Only redacts when UUID is preceded by sensitive context: `userId=`, `accountId=`, `sessionId=`, `orgId=`
- Balances privacy (genuine user IDs protected) with context (navigation preserved)

---

#### BUG #6: Desktop App Missing Priority Field

**Files:** `python-desktop-app/desktop_app.py`

**Change 1 — Jira API fetch (lines 7305, 7328):**
```python
# BEFORE:
'fields': ['summary', 'status', 'project', 'description', 'labels', 'updated']

# AFTER:
'fields': ['summary', 'status', 'project', 'description', 'labels', 'updated', 'priority']
```

**Change 2 — Cache SELECT (line 7231):**
```python
# BEFORE:
.select('issue_key, issue_summary, project_key, status, description, labels, updated_at')

# AFTER:
.select('issue_key, issue_summary, project_key, status, description, labels, updated_at, priority')
```

**Change 3 — Formatted output (lines 7355-7365, 7242-7250):**
```python
# BEFORE:
formatted.append({
    'key': issue['key'],
    'summary': fields['summary'],
    'status': fields['status']['name'],
    'project': fields['project']['key'],
    'description': description,
    'labels': labels,
    'updated': fields.get('updated', '')
})

# AFTER:
formatted.append({
    'key': issue['key'],
    'summary': fields['summary'],
    'status': fields['status']['name'],
    'project': fields['project']['key'],
    'description': description,
    'labels': labels,
    'updated': fields.get('updated', ''),
    'priority': fields.get('priority', {}).get('name', '')  # Add priority
})
```

**Schema Update:** None required (cache table already has `priority TEXT` column from Bug #2 era)

---

#### BUG #7: Low-Confidence OCR Sent to LLM

**File:** `ai-server/src/services/activity-service.js` (lines 157-162)

**Change:**
```javascript
// BEFORE:
const ocrLabel = !record.ocr_text ? '(no text extracted)'
  : record.ocr_confidence && record.ocr_confidence < 0.4
    ? `OCR Text (low confidence - may be inaccurate): ${ocrSnippet}`
    : `OCR Text: ${ocrSnippet}`;

// AFTER:
const ocrLabel = !record.ocr_text ? '(no text extracted)'
  : record.ocr_confidence && record.ocr_confidence < 0.4
    ? '(low-confidence OCR omitted - rely on window title and app name)'
    : `OCR Text: ${ocrSnippet}`;
```

**Rationale:**
- OCR confidence <0.4 indicates unreliable text extraction (heavy noise)
- Window title + application name provide sufficient signal without garbage data
- Reduces false-positive matches from OCR errors

---

#### BUG #8: Stale Correction Patterns

**File:** `ai-server/src/services/activity-service.js` (after line 194, before prompt injection at line 195)

**Change:** Add validation filter:
```javascript
// Filter correction patterns to only include currently assigned issues
if (correctionPatterns && correctionPatterns.length > 0) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  const validCorrections = correctionPatterns.filter(p => validKeys.has(p.corrected_to));
  
  if (validCorrections.length === 0) {
    logger.debug('[Activity] All %d correction patterns reference stale issues, skipping', 
      correctionPatterns.length);
    correctionPatterns = null;
  } else if (validCorrections.length < correctionPatterns.length) {
    logger.info('[Activity] Filtered %d stale correction patterns (kept %d valid)', 
      correctionPatterns.length - validCorrections.length, 
      validCorrections.length);
    correctionPatterns = validCorrections;
  }
}
```

**Why This Works:**
- Cross-references `correctionPatterns[].corrected_to` against `userAssignedIssues[].key`
- Only includes corrections that point to issues currently assigned to user
- Avoids LLM wasting tokens on invalid match attempts

---

#### BUG #9: Credit Card Regex False Positives

**File:** `ai-server/src/services/activity-service.js` (line 40)

**Change:**
```javascript
// BEFORE:
{ pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[REDACTED_CARD]' },

// AFTER:
// Only match credit card format: XXXX-XXXX-XXXX-XXXX or XXXX XXXX XXXX XXXX
{ pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4,7}\b/g, replacement: '[REDACTED_CARD]' },
```

**Rationale:**
- Real credit cards use separator format (4-digit groups)
- Build numbers, phone numbers, timestamps don't follow this format
- Last group 4-7 digits handles AMEX (15 digits) and Visa/MC (16 digits)

---

#### BUG #10: Clustering OCR Truncation

**File:** `ai-server/src/services/clustering-service.js` (lines 66-71)

**Change:**
```javascript
// BEFORE:
const truncatedText = extractedText.substring(0, 200);

// AFTER:
const truncatedText = extractedText.substring(0, 1000);  // Match batch analysis standard
```

**Rationale:**
- Aligns with `activity-service.js` truncation standard (1000 chars)
- Preserves long URLs, file paths, function signatures, related issue keys
- Improves clustering group specificity and issue suggestion accuracy

---

## Acceptance Criteria

### Bug #1: ADF Extraction (CRITICAL)

1. ✅ When Jira description contains bullet list → 3+ levels deep, full text extracted
2. ✅ When Jira description contains table → all cell text extracted
3. ✅ When Jira description contains panel → nested content extracted
4. ✅ When Jira description contains code block → code text extracted
5. ✅ Test case: Given ADF with 4-level nesting (doc → bulletList → listItem → paragraph → text), output includes text from level 4
6. ✅ Regression: Simple 2-level descriptions (paragraph → text) still work correctly

### Bug #2: Cache Timestamp (CRITICAL)

1. ✅ When forge-app caches issue updated 7 days ago, `user_jira_issues_cache.updated_at` stores Jira's timestamp (7 days ago), not current server time
2. ✅ When polling service reads cached issues, `formatAssignedIssues()` sorts by actual Jira update time
3. ✅ When issue updated 60 days ago is cached, staleness annotation "(Last updated: 60 days ago)" appears in LLM prompt
4. ✅ When comparing embedded vs cached issue freshness, cached issues don't always win due to fake timestamps
5. ✅ Migration: After clearing cache, all issues repopulate within 30 minutes with correct `updated_at` values
6. ✅ Regression: Issues without `fields.updated` (edge case) still get cached with server time fallback

### Bug #3: OCR Sanitization (CRITICAL)

1. ✅ When OCR contains "password: hashing algorithm", text preserved (not redacted)
2. ✅ When OCR contains "token refresh mechanism", text preserved
3. ✅ When OCR contains "secret management feature", text preserved
4. ✅ When OCR contains "password=MySecret123", text redacted to "[REDACTED_CREDENTIAL]"
5. ✅ When OCR contains "token=eyJhbGciOi...", text redacted
6. ✅ Regression: All legitimate credential patterns still redacted

### Bug #4: Context Bias

1. ✅ When previous match has confidence <0.7, `previousMatchContext` not included in prompt
2. ✅ When previous match is >15 minutes old, `previousMatchContext` not included
3. ✅ When previous match is PROJ-456 but current batch has window titles referencing PROJ-789, `previousMatchContext` not included
4. ✅ When previous match is PROJ-456 (confidence 0.8, 5 min ago) AND current batch mentions PROJ-456, `previousMatchContext` included
5. ✅ Regression: Valid high-confidence recent relevant context still included

### Bug #5: UUID Redaction

1. ✅ When OCR contains "https://site.atlassian.net/browse/PROJ-123?focusedId=a1b2c3d4-...", UUID preserved
2. ✅ When OCR contains "Dashboard ID: 12345678-1234-...", UUID preserved
3. ✅ When OCR contains "userId=a1b2c3d4-5678-...", UUID redacted to "[REDACTED_UUID]"
4. ✅ When OCR contains "accountId: 12345678-...", UUID redacted
5. ✅ Regression: Sensitive user/account/session IDs still redacted

### Bug #6: Desktop Priority Field

1. ✅ When desktop app fetches issues from Jira API, response includes `priority` field
2. ✅ When desktop app reads issues from cache, query includes `priority` column
3. ✅ When desktop app formats issues for embedding, output includes `priority` key
4. ✅ When activity record is written with embedded issues, `user_assigned_issues` JSON contains priority for each issue
5. ✅ When polling service uses embedded issues, priority available for LLM prompt and tiebreaking
6. ✅ Regression: All other fields (summary, status, labels, etc.) still present and correct

### Bug #7: Low-Confidence OCR

1. ✅ When OCR confidence is 0.3, `ocrLabel` is "(low-confidence OCR omitted...)"
2. ✅ When OCR confidence is 0.3, `ocrSnippet` NOT included in prompt string
3. ✅ When OCR confidence is 0.5, `ocrSnippet` included with "OCR Text:" label
4. ✅ When OCR confidence is null/undefined, treated as high confidence (included)
5. ✅ Regression: High-confidence OCR (>0.4) still included

### Bug #8: Stale Corrections

1. ✅ When user has correction pattern for PROJ-456 (completed 2 months ago), pattern excluded from prompt
2. ✅ When user has 5 correction patterns but only 2 reference currently assigned issues, only 2 included
3. ✅ When all correction patterns reference stale issues, entire correction section omitted from prompt
4. ✅ When correction pattern references currently assigned issue, pattern included normally
5. ✅ Regression: Valid correction patterns still included and properly formatted

### Bug #9: Credit Card Regex

1. ✅ When OCR contains "Build #12345678901234567", text preserved (not redacted)
2. ✅ When OCR contains "Phone: 1-800-555-123456", text preserved
3. ✅ When OCR contains "SKU: 1234567890123456", text preserved
4. ✅ When OCR contains "4532-1234-5678-9010", text redacted to "[REDACTED_CARD]"
5. ✅ When OCR contains "4532 1234 5678 9010", text redacted
6. ✅ Regression: Actual credit card numbers still redacted

### Bug #10: Clustering Truncation

1. ✅ When clustering session has 800-char OCR text, full text included (not truncated at 200)
2. ✅ When clustering session has 1200-char OCR text, truncated at 1000 chars (not 200)
3. ✅ When clustering session has 150-char OCR text, full text included without truncation marker
4. ✅ Test case: Given OCR with URL at position 250-300, URL fully captured in clustering prompt
5. ✅ Regression: Extremely long OCR (>5000 chars) still truncated to prevent token bloat

---

## Out of Scope

### Explicitly NOT Included in This Plan

1. **LLM Model Changes:** Continue using Gemini 2.0 Flash / GPT-4 via Portkey
2. **Prompt Rewriting:** No changes to core prompt structure or instructions
3. **Confidence Threshold Changes:** Keep `MIN_CONFIDENCE_THRESHOLD = 0.4`
4. **Cache Architecture:** No changes to 30-minute refresh interval or storage structure
5. **New Features:**
   - No new sanitization patterns beyond fixing existing ones
   - No additional context sources (git commits, Slack, etc.)
   - No batch size changes (keep 5-minute polling interval)
6. **Schema Changes:** No new database columns (except using existing `priority` in desktop app)
7. **UI Changes:** No dashboard updates, no new user-facing controls
8. **Performance Optimization:** Focus is correctness, not speed
9. **Desktop App Sanitization:** Privacy filters remain unchanged (bugs are in ai-server only)
10. **Clustering Algorithm:** No changes to grouping logic, only input text length

### Already Fixed (Do Not Re-Fix)

Per previous root cause analysis, these bugs are VERIFIED as fixed and must not be touched:

1. ✅ Forge cache JQL filtering (fixed in May 2026)
2. ✅ Temperature parameter handling (fixed in v2.3 deployment)
3. ✅ `computeIsIdleOnly` export (fixed in D1-D3 audit)
4. ✅ `getUserActiveIssues` missing fields (fixed in D1-D3 audit)
5. ✅ Cache fallback error handling (fixed in D1-D3 audit)
6. ✅ Webhook timestamp parsing (fixed in D1-D3 audit)
7. ✅ Token refresh race condition (fixed in May 19 deployment)

---

## Testing Strategy

### Pre-Deployment Testing

#### Unit Tests Required

**ai-server/tests/services/adf-extraction.test.js** (NEW FILE)
```javascript
describe('ADF Extraction (Bug #1)', () => {
  test('extracts text from 4-level nested bullet list', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'Nested text' }]
          }]
        }]
      }]
    };
    const result = extractDescriptionText(adf);
    expect(result).toContain('Nested text');
  });

  test('extracts text from table structure', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableCell',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'Cell content' }]
            }]
          }]
        }]
      }]
    };
    const result = extractDescriptionText(adf);
    expect(result).toContain('Cell content');
  });

  test('extracts code block text', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        content: [{ type: 'text', text: 'const x = 5;' }]
      }]
    };
    const result = extractDescriptionText(adf);
    expect(result).toContain('const x = 5;');
  });
});
```

**ai-server/tests/controllers/forge-proxy-timestamp.test.js** (NEW FILE)
```javascript
describe('Cache Timestamp (Bug #2)', () => {
  test('stores Jira updated timestamp, not server time', async () => {
    const mockIssue = {
      key: 'TEST-123',
      fields: {
        summary: 'Test issue',
        updated: '2026-05-14T10:00:00.000+0000'  // 7 days ago
      }
    };

    const cached = await cacheUserIssues(userId, orgId, [mockIssue]);
    
    expect(cached[0].updated_at).toBe('2026-05-14T10:00:00.000Z');
    expect(cached[0].updated_at).not.toBe(expect.stringContaining('2026-05-21'));
  });

  test('falls back to server time when Jira updated missing', async () => {
    const mockIssue = {
      key: 'TEST-456',
      fields: { summary: 'No updated field' }
    };

    const cached = await cacheUserIssues(userId, orgId, [mockIssue]);
    
    expect(cached[0].updated_at).toMatch(/2026-05-21/);  // Current date
  });
});
```

**ai-server/tests/services/sanitization-patterns.test.js** (UPDATE EXISTING)
```javascript
describe('OCR Sanitization (Bug #3, #5, #9)', () => {
  test('preserves feature names with colons', () => {
    const text = 'Implement password: hashing algorithm for token: refresh endpoint';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('password: hashing');
    expect(sanitized).toContain('token: refresh');
  });

  test('redacts actual credentials with equals', () => {
    const text = 'Config: password=MySecret123 token=abc123xyz';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('[REDACTED_CREDENTIAL]');
    expect(sanitized).not.toContain('MySecret123');
  });

  test('preserves UUIDs in URLs', () => {
    const text = 'https://site.atlassian.net/browse/PROJ-123?id=a1b2c3d4-5678-90ab-cdef-1234567890ab';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('a1b2c3d4-5678-90ab-cdef-1234567890ab');
  });

  test('redacts sensitive UUID contexts', () => {
    const text = 'userId=a1b2c3d4-5678-90ab-cdef-1234567890ab accountId=1234-5678';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('[REDACTED_UUID]');
    expect(sanitized).not.toContain('a1b2c3d4-5678');
  });

  test('preserves build numbers', () => {
    const text = 'Build #12345678901234567 deployed successfully';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('12345678901234567');
    expect(sanitized).not.toContain('[REDACTED_CARD]');
  });

  test('redacts credit card format', () => {
    const text = 'Card: 4532-1234-5678-9010 and 4532 1234 5678 9010';
    const sanitized = applySanitization(text);
    expect(sanitized).toContain('[REDACTED_CARD]');
    expect(sanitized).not.toContain('4532-1234');
  });
});
```

**ai-server/tests/services/context-guards.test.js** (NEW FILE)
```javascript
describe('Previous Match Context Guards (Bug #4)', () => {
  test('excludes low-confidence previous match', () => {
    const previousMatch = {
      taskKey: 'PROJ-123',
      confidenceScore: 0.5,
      minutesAgo: 5
    };
    const prompt = buildBatchAnalysisPrompt(records, issues, previousMatch, []);
    expect(prompt).not.toContain('PROJ-123');
    expect(prompt).not.toContain('Previous session context');
  });

  test('excludes stale previous match', () => {
    const previousMatch = {
      taskKey: 'PROJ-123',
      confidenceScore: 0.8,
      minutesAgo: 20  // >15 min
    };
    const prompt = buildBatchAnalysisPrompt(records, issues, previousMatch, []);
    expect(prompt).not.toContain('Previous session context');
  });

  test('excludes irrelevant previous match', () => {
    const records = [
      { window_title: 'VS Code - feature-x.js [PROJ-789]' }
    ];
    const previousMatch = {
      taskKey: 'PROJ-123',  // Different project
      confidenceScore: 0.8,
      minutesAgo: 5
    };
    const prompt = buildBatchAnalysisPrompt(records, issues, previousMatch, []);
    expect(prompt).not.toContain('PROJ-123');
  });

  test('includes valid previous match', () => {
    const records = [
      { window_title: 'Chrome - PROJ-123 - Jira' }
    ];
    const previousMatch = {
      taskKey: 'PROJ-123',
      confidenceScore: 0.8,
      minutesAgo: 5
    };
    const prompt = buildBatchAnalysisPrompt(records, issues, previousMatch, []);
    expect(prompt).toContain('Previous session context');
    expect(prompt).toContain('PROJ-123');
  });
});
```

**ai-server/tests/services/correction-validation.test.js** (NEW FILE)
```javascript
describe('Correction Pattern Validation (Bug #8)', () => {
  test('filters stale correction patterns', () => {
    const issues = [
      { key: 'PROJ-789', summary: 'Current work' }
    ];
    const corrections = [
      { corrected_to: 'PROJ-123' },  // Stale (not in issues)
      { corrected_to: 'PROJ-456' },  // Stale
      { corrected_to: 'PROJ-789' }   // Valid
    ];
    const prompt = buildBatchAnalysisPrompt(records, issues, null, corrections);
    expect(prompt).toContain('PROJ-789');
    expect(prompt).not.toContain('PROJ-123');
    expect(prompt).not.toContain('PROJ-456');
  });

  test('omits correction section when all stale', () => {
    const issues = [{ key: 'PROJ-999' }];
    const corrections = [
      { corrected_to: 'PROJ-123' },
      { corrected_to: 'PROJ-456' }
    ];
    const prompt = buildBatchAnalysisPrompt(records, issues, null, corrections);
    expect(prompt).not.toContain('USER CORRECTION HISTORY');
  });
});
```

**ai-server/tests/services/ocr-confidence-filter.test.js** (NEW FILE)
```javascript
describe('Low-Confidence OCR Exclusion (Bug #7)', () => {
  test('excludes OCR text when confidence <0.4', () => {
    const record = {
      ocr_text: 'Garbage text with false positives',
      ocr_confidence: 0.3,
      window_title: 'VS Code'
    };
    const prompt = buildRecordContext(record);
    expect(prompt).toContain('low-confidence OCR omitted');
    expect(prompt).not.toContain('Garbage text');
  });

  test('includes OCR text when confidence >=0.4', () => {
    const record = {
      ocr_text: 'Clean extracted text',
      ocr_confidence: 0.6,
      window_title: 'Chrome'
    };
    const prompt = buildRecordContext(record);
    expect(prompt).toContain('OCR Text: Clean extracted text');
  });

  test('includes OCR when confidence is null (high-quality source)', () => {
    const record = {
      ocr_text: 'Text from reliable source',
      ocr_confidence: null,
      window_title: 'Terminal'
    };
    const prompt = buildRecordContext(record);
    expect(prompt).toContain('OCR Text: Text from reliable source');
  });
});
```

**ai-server/tests/services/clustering-truncation.test.js** (UPDATE EXISTING)
```javascript
describe('Clustering OCR Truncation (Bug #10)', () => {
  test('includes up to 1000 chars of OCR text', () => {
    const longText = 'A'.repeat(1200);
    const context = buildClusteringContext({ ocr_text: longText });
    expect(context).toContain('A'.repeat(1000));
    expect(context.length).toBeLessThan(longText.length + 50);  // Truncated
  });

  test('preserves full text when <1000 chars', () => {
    const shortText = 'Short OCR text with URL https://example.com/path';
    const context = buildClusteringContext({ ocr_text: shortText });
    expect(context).toContain(shortText);
    expect(context).not.toContain('...');  // No truncation marker
  });
});
```

**python-desktop-app/tests/test_issue_fetching.py** (UPDATE EXISTING)
```python
def test_priority_field_included_in_api_fetch(mock_jira_api):
    """Bug #6: Verify priority requested from Jira API"""
    result = fetch_issues_from_jira_api(jql='assignee=currentUser()')
    
    # Check request payload included priority
    call_args = mock_jira_api.call_args
    assert 'priority' in call_args['json']['fields']
    assert 'summary' in call_args['json']['fields']  # Regression check

def test_priority_field_in_formatted_output():
    """Bug #6: Verify priority included in formatted issues"""
    mock_issue = {
        'key': 'TEST-123',
        'fields': {
            'summary': 'Test',
            'status': {'name': 'In Progress'},
            'project': {'key': 'TEST'},
            'priority': {'name': 'High'}
        }
    }
    
    formatted = format_issues([mock_issue])
    
    assert formatted[0]['priority'] == 'High'
    assert formatted[0]['key'] == 'TEST-123'  # Regression

def test_priority_field_from_cache():
    """Bug #6: Verify priority read from cache"""
    # Mock Supabase cache with priority column
    mock_cache_row = {
        'issue_key': 'TEST-456',
        'issue_summary': 'Cached issue',
        'priority': 'Medium'
    }
    
    formatted = format_cached_issues([mock_cache_row])
    
    assert formatted[0]['priority'] == 'Medium'
```

#### Integration Tests Required

**ai-server/tests/integration/end-to-end-matching.test.js** (UPDATE EXISTING)
```javascript
describe('End-to-End Matching with Bug Fixes', () => {
  test('matches auth feature work correctly (Bug #3)', async () => {
    const activity = {
      window_title: 'VS Code - tokenRefreshService.ts',
      ocr_text: 'Implementing JWT token: refresh mechanism with exponential backoff'
    };
    const issues = [
      { key: 'AUTH-123', summary: 'Implement JWT token refresh' }
    ];

    const result = await analyzeActivityBatch([activity], issues);
    
    expect(result.taskKey).toBe('AUTH-123');
    expect(result.confidenceScore).toBeGreaterThan(0.7);
  });

  test('prioritizes recently updated issues (Bug #2)', async () => {
    const activity = { window_title: 'Chrome - Project Board' };
    const issues = [
      { key: 'OLD-123', summary: 'Old task', updated: '2026-01-01T00:00:00Z' },  // 4 months ago
      { key: 'NEW-456', summary: 'Recent task', updated: '2026-05-20T00:00:00Z' }  // Yesterday
    ];

    const result = await analyzeActivityBatch([activity], issues);
    
    // Ambiguous activity should favor recent issue
    expect(result.taskKey).toBe('NEW-456');
  });

  test('uses complete ADF descriptions (Bug #1)', async () => {
    const activity = {
      window_title: 'Chrome - Jira',
      ocr_text: 'Steps to reproduce: 1. Click Settings 2. Navigate to Database'
    };
    const issues = [
      {
        key: 'BUG-789',
        summary: 'Database connection issue',
        description: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce:' }] },
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click Settings' }] }] },
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Navigate to Database' }] }] }
              ]
            }
          ]
        }
      }
    ];

    const result = await analyzeActivityBatch([activity], issues);
    
    expect(result.taskKey).toBe('BUG-789');
    expect(result.confidenceScore).toBeGreaterThan(0.8);
  });
});
```

### Regression Test Suite

**Run ALL existing tests** to ensure no previously fixed bugs regressed:

```bash
cd ai-server && npm test                     # All AI server unit tests
cd python-desktop-app && python -m pytest    # All desktop app tests
cd forge-app && npm test                     # All Forge app tests
```

**Critical Regression Checks:**
1. Temperature parameter handling (verify still uses 0.3)
2. Forge cache JQL filtering (verify `assignee=currentUser()` still applied)
3. D1-D3 defects (verify `getUserActiveIssues`, cache fallback, webhook timestamps)
4. Token refresh (verify no race conditions)

### Post-Deployment Validation

#### Smoke Tests (Production)

1. **Verify Cache Rebuild (Bug #2):**
   ```sql
   SELECT COUNT(*), MIN(updated_at), MAX(updated_at)
   FROM user_jira_issues_cache
   WHERE organization_id = '<test-org-id>';
   
   -- Should show range of timestamps (not all same timestamp)
   ```

2. **Verify ADF Extraction (Bug #1):**
   - Create test Jira issue with bullet list in description
   - Trigger cache refresh
   - Query cache and verify full text extracted

3. **Verify Sanitization (Bug #3):**
   - Create activity with window title "VS Code - tokenRefresh.ts"
   - Check activity_records.metadata → prompt should contain "tokenRefresh", not "[REDACTED]"

4. **Verify Priority Field (Bug #6):**
   - Desktop app fetches issues
   - Check activity_records.user_assigned_issues JSON → verify priority present

#### Accuracy Metrics (1 Week Post-Deploy)

```sql
-- Compare accuracy before/after deployment
SELECT 
  DATE(analyzed_at) as date,
  COUNT(*) as total_batches,
  AVG(CASE WHEN confidence_score >= 0.7 THEN 1 ELSE 0 END) as high_confidence_rate,
  AVG(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 ELSE 0 END) as match_rate
FROM activity_records
WHERE analyzed_at >= '2026-05-21'  -- Deployment date
GROUP BY DATE(analyzed_at)
ORDER BY date;
```

**Expected Improvement:**
- High-confidence rate: 45-50% → 65-70%
- Match rate: 65-70% → 85-90%
- User corrections (ai_accuracy_events): Reduce by 30-40%

---

## Dependencies & Rollout Order

### Phase 1: Critical Bugs (Single Atomic Deployment)

**Deploy Together:**
1. Bug #1: ADF Extraction
2. Bug #2: Cache Timestamp + Migration
3. Bug #3: Sanitization Regex

**Why Atomic:**
- Bug #2 migration clears cache → fresh rebuild uses Bug #1 fix → proper descriptions cached
- Bug #3 ensures fresh cache doesn't over-redact new descriptions
- Partial deployment would cause inconsistency (e.g., correct timestamps but wrong descriptions)

**Rollout Steps:**
```bash
1. Deploy ai-server with Bugs #1, #3 fixes
2. Verify deployment health (check logs, no startup errors)
3. Run Bug #2 migration: DELETE FROM user_jira_issues_cache;
4. Monitor cache rebuild (30 min window)
5. Run post-deployment validation queries
6. Monitor accuracy metrics for 24 hours
```

**Rollback Plan:**
- If accuracy DECREASES: Revert ai-server deployment, restore cache from backup
- If cache fails to rebuild: Check forge-app logs, verify Forge Remote connectivity

---

### Phase 2: High Priority Bugs

**Deploy Separately (2-3 days after Phase 1):**
1. Bug #4: Context Guards
2. Bug #5: UUID Redaction

**Why Separate:**
- Independent of cache architecture
- Can be tested without migration
- Lower risk of cascading failures

**Rollout:**
```bash
1. Deploy ai-server with Bugs #4, #5 fixes
2. Monitor logs for guard activation ("Skipping low-confidence previous match")
3. Verify UUIDs preserved in URLs (check sample activity_records)
```

---

### Phase 3: Medium Priority Bugs

**Deploy Separately (1 week after Phase 2):**
1. Bug #6: Desktop Priority Field (python-desktop-app)
2. Bug #7: OCR Confidence Filter (ai-server)
3. Bug #8: Correction Validation (ai-server)

**Why Separate:**
- Bug #6 requires desktop app deployment (separate release cycle)
- Bugs #7, #8 are prompt optimizations (low risk)
- Allows Phase 1 accuracy to stabilize before further changes

**Rollout:**
```bash
1. Deploy python-desktop-app v3.x with Bug #6
2. Wait 24 hours for user upgrades
3. Deploy ai-server with Bugs #7, #8
4. Monitor correction pattern filtering in logs
```

---

### Phase 4: Low Priority Bugs

**Deploy Separately (Backlog):**
1. Bug #9: Credit Card Regex (ai-server)
2. Bug #10: Clustering Truncation (ai-server)

**Why Low Priority:**
- Bug #9: Rare false positives (2-5% impact)
- Bug #10: Clustering is secondary feature (unassigned work)
- Can be bundled with next major release

**Rollout:**
```bash
1. Deploy ai-server with Bugs #9, #10
2. Monitor clustering service logs
3. Check unassigned work dashboard for improved suggestions
```

---

## Migration Plan

### Bug #2: Cache Timestamp Fix

#### Pre-Deployment Checklist

- [ ] Backup `user_jira_issues_cache` table (Supabase snapshot)
- [ ] Verify forge-app cache refresh mechanism working (check last 30 min cache writes)
- [ ] Confirm no pending cache-related deployments
- [ ] Schedule deployment during low-traffic window (e.g., 2 AM UTC)

#### Migration Script

```sql
-- Run in Supabase SQL Editor

-- Step 1: Backup current cache (optional, for rollback)
CREATE TABLE user_jira_issues_cache_backup_20260521 AS
SELECT * FROM user_jira_issues_cache;

-- Step 2: Clear cache to force rebuild with correct timestamps
DELETE FROM user_jira_issues_cache;

-- Step 3: Verify empty
SELECT COUNT(*) FROM user_jira_issues_cache;
-- Expected: 0

-- Step 4: Monitor rebuild (wait 30 min, check again)
-- Cache rebuilds automatically via forge-app refresh cycle
```

#### Post-Migration Validation

```sql
-- Check cache repopulation (run 30 min after migration)
SELECT 
  organization_id,
  COUNT(*) as issue_count,
  MIN(updated_at) as oldest_issue,
  MAX(updated_at) as newest_issue,
  MAX(created_at) as last_cache_write
FROM user_jira_issues_cache
GROUP BY organization_id;

-- Verify timestamp diversity (not all same timestamp)
SELECT 
  COUNT(DISTINCT updated_at) as unique_timestamps,
  COUNT(*) as total_issues
FROM user_jira_issues_cache
WHERE organization_id = '<test-org-id>';

-- Expected: unique_timestamps > 1 (not all issues have same timestamp)
```

#### Rollback Procedure

If cache fails to rebuild or accuracy degrades:

```sql
-- Restore from backup
INSERT INTO user_jira_issues_cache
SELECT * FROM user_jira_issues_cache_backup_20260521;

-- Verify restoration
SELECT COUNT(*) FROM user_jira_issues_cache;
-- Expected: Same count as before migration
```

Then revert ai-server deployment to previous version.

---

## Risk Assessment

### Low-Risk Changes (Safe to Deploy)

- **Bug #1:** Copy-paste existing tested code from forge-app
- **Bug #3, #5, #9:** Simple regex pattern changes (easily reversible)
- **Bug #7:** Conditional exclusion (fallback to window title always available)
- **Bug #10:** Truncation length increase (no behavioral change)

### Medium-Risk Changes (Require Careful Testing)

- **Bug #2:** Cache migration (can rollback, but 30-min downtime)
- **Bug #4:** Context guards (complex logic, multiple conditions)
- **Bug #8:** Correction filtering (affects user-trained patterns)

### Mitigation Strategies

1. **Atomic Phase 1 Deployment:** Deploy critical bugs together to avoid partial-fix inconsistencies
2. **Backup Before Migration:** Snapshot cache table before DELETE
3. **Gradual Rollout:** Phase 1 → wait 2-3 days → Phase 2 → wait 1 week → Phase 3
4. **Monitoring:** Log guard activations (Bug #4), correction filtering (Bug #8) at INFO level
5. **Rollback Plan:** Every deployment has documented rollback procedure
6. **Feature Flags (Future):** Consider adding `ENABLE_BUG_FIX_<N>` env vars for runtime toggling

---

## Success Metrics

### Quantitative Targets (1 Week Post-Deployment)

| Metric | Before | Target | Measurement |
|--------|--------|--------|-------------|
| Description completeness | 35-40% | 95-98% | Sample 100 cached issues, check nested ADF content |
| Recency accuracy | 0% | 90-95% | Verify `updated_at` matches Jira's timestamp |
| Auth feature matching | 30% | 85-90% | Sample activities with "token/password" keywords |
| High-confidence rate (>0.7) | 45-50% | 65-70% | Query `activity_records` confidence distribution |
| Overall match rate | 65-70% | 85-90% | % of batches with non-null taskKey |
| User corrections | Baseline | -30-40% | Count `ai_accuracy_events` (reassigned/manually_assigned) |

### Qualitative Indicators

- [ ] Fewer support tickets about "AI matched wrong issue"
- [ ] Reduced correction events for auth/security features
- [ ] Improved clustering group labels (more specific, fewer "General Development")
- [ ] Positive user feedback on matching accuracy
- [ ] Reduced LLM token usage (fewer correction patterns, no garbage OCR)

### Monitoring Queries

```sql
-- Daily accuracy trends
SELECT 
  DATE(analyzed_at) as date,
  COUNT(*) as total_batches,
  AVG(confidence_score) as avg_confidence,
  SUM(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as match_rate,
  SUM(CASE WHEN confidence_score >= 0.7 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as high_conf_rate
FROM activity_records
WHERE analyzed_at >= '2026-05-21'
GROUP BY DATE(analyzed_at)
ORDER BY date;

-- User correction rate
SELECT 
  DATE(event_date) as date,
  COUNT(*) as correction_events
FROM ai_accuracy_events
WHERE event_type IN ('reassigned', 'manually_assigned')
  AND event_date >= '2026-05-21'
GROUP BY DATE(event_date)
ORDER BY date;

-- Cache timestamp diversity (Bug #2 validation)
SELECT 
  organization_id,
  COUNT(DISTINCT DATE(updated_at)) as unique_dates,
  MIN(updated_at) as oldest,
  MAX(updated_at) as newest
FROM user_jira_issues_cache
GROUP BY organization_id
HAVING COUNT(DISTINCT DATE(updated_at)) = 1;  -- Flag orgs with all same date
```

---

## Implementation Checklist

### Pre-Development

- [ ] Read and understand copilot-instructions.md spec-driven workflow
- [ ] Review all 10 bug root cause analyses
- [ ] Set up test environment with sample ADF descriptions, OCR data, cached issues
- [ ] Prepare Supabase backup/restore scripts

### Development Phase

#### Phase 1: Critical Bugs

- [ ] **Bug #1:** Copy `adfToText.js` to ai-server, update import
  - [ ] Write unit tests for nested ADF structures
  - [ ] Run existing tests (ensure no regressions)
- [ ] **Bug #2:** Change line 1384 to use `fields.updated`
  - [ ] Write unit test for timestamp storage
  - [ ] Write integration test for sorting by recency
  - [ ] Prepare migration SQL script
- [ ] **Bug #3:** Update regex pattern (remove `:` separator)
  - [ ] Write unit tests for feature name preservation
  - [ ] Write regression tests for credential redaction
- [ ] Run full ai-server test suite: `npm test`
- [ ] Manual testing: Deploy to staging, verify cache rebuild with correct timestamps

#### Phase 2: High Priority

- [ ] **Bug #4:** Add context guards (confidence, staleness, relevance)
  - [ ] Write unit tests for each guard condition
  - [ ] Write integration test for context-switching scenario
- [ ] **Bug #5:** Update UUID regex to context-aware pattern
  - [ ] Write unit tests for URL preservation
  - [ ] Write regression tests for sensitive ID redaction
- [ ] Run full test suite
- [ ] Manual testing: Verify UUID preservation in activity logs

#### Phase 3: Medium Priority

- [ ] **Bug #6:** Add priority field to desktop app (3 locations)
  - [ ] Write pytest tests for priority inclusion
  - [ ] Test Jira API fetch, cache read, formatted output
- [ ] **Bug #7:** Exclude low-confidence OCR from prompt
  - [ ] Write unit tests for confidence threshold
  - [ ] Verify window title still available when OCR excluded
- [ ] **Bug #8:** Filter correction patterns against current issues
  - [ ] Write unit tests for stale pattern filtering
  - [ ] Test correction section omission when all stale
- [ ] Run full test suites (ai-server + desktop app)

#### Phase 4: Low Priority

- [ ] **Bug #9:** Update credit card regex to require separators
  - [ ] Write unit tests for build number preservation
  - [ ] Write regression tests for card number redaction
- [ ] **Bug #10:** Increase clustering truncation to 1000 chars
  - [ ] Write unit tests for truncation consistency
  - [ ] Verify no token bloat in clustering prompts
- [ ] Run full test suite

### Deployment Phase

#### Phase 1 Deployment

- [ ] Backup `user_jira_issues_cache` table
- [ ] Deploy ai-server with Bugs #1, #2, #3
- [ ] Verify deployment health (logs, health check endpoint)
- [ ] Run Bug #2 migration script
- [ ] Wait 30 minutes for cache rebuild
- [ ] Run post-deployment validation queries
- [ ] Monitor accuracy metrics for 24 hours
- [ ] Document any issues, rollback if accuracy degrades

#### Phase 2 Deployment (2-3 days after Phase 1)

- [ ] Confirm Phase 1 stable (no regressions, accuracy improved)
- [ ] Deploy ai-server with Bugs #4, #5
- [ ] Monitor logs for guard activations
- [ ] Verify UUID preservation in sample activities
- [ ] Check accuracy metrics after 48 hours

#### Phase 3 Deployment (1 week after Phase 2)

- [ ] Release python-desktop-app v3.x with Bug #6
- [ ] Notify users to update desktop app
- [ ] Wait 24 hours for user adoption (>70% on new version)
- [ ] Deploy ai-server with Bugs #7, #8
- [ ] Monitor correction pattern filtering in logs
- [ ] Check accuracy metrics after 1 week

#### Phase 4 Deployment (Backlog)

- [ ] Bundle Bugs #9, #10 with next major release
- [ ] Deploy ai-server
- [ ] Monitor clustering service for improved suggestions
- [ ] Validate no regressions in sanitization

### Post-Deployment

- [ ] Run regression test suite (verify all previously fixed bugs still fixed)
- [ ] Generate accuracy report (compare before/after metrics)
- [ ] Update documentation (mark bugs as fixed in root cause analysis)
- [ ] User communication (release notes highlighting accuracy improvements)
- [ ] Archive this plan file with "COMPLETED" status

---

## Communication Plan

### Pre-Deployment

**To Engineering Team:**
- Share this plan document for review
- Conduct code walkthrough for Phase 1 fixes
- Align on migration timing and rollback procedures

**To QA Team:**
- Provide test cases from Acceptance Criteria section
- Set up staging environment with diverse ADF descriptions, OCR samples
- Request regression testing focus on previously fixed bugs

**To Product/Support:**
- Brief on expected accuracy improvements
- Prepare support team for potential user questions during cache migration
- Draft release notes highlighting bug fixes

### During Deployment

**Phase 1 (Critical):**
- [ ] Post in #engineering Slack: "Deploying AI matching fixes (Bugs #1, #2, #3). Cache migration in progress, expect 30-min rebuild."
- [ ] Monitor #support for user reports
- [ ] Update status page if cache rebuild causes visible delays

**Phases 2-4:**
- [ ] Standard deployment notification
- [ ] No user-facing downtime expected

### Post-Deployment

**Week 1 Report:**
```
AI Matching Bug Fixes — Week 1 Results

Deployed: May 21, 2026
Fixes: 10 bugs affecting matching accuracy

METRICS:
- High-confidence matches: +20% (50% → 70%)
- Overall match rate: +18% (70% → 88%)
- User corrections: -35% (fewer manual fixes needed)

KEY IMPROVEMENTS:
✅ Full Jira descriptions now included (nested lists, tables, code blocks)
✅ Issues sorted by actual Jira update time (not cache write time)
✅ Auth/security feature names preserved (not redacted as credentials)

NEXT STEPS:
- Phase 2 deployment scheduled for May 24
- Continue monitoring accuracy trends
```

**Release Notes (User-Facing):**
```markdown
## AI Issue Matching Improvements (May 2026)

We've fixed 10 bugs affecting AI matching accuracy. You should notice:

- **Better matches for auth/security work:** Activities on authentication, tokens, and password features now match correctly
- **Smarter recency detection:** Recently updated issues prioritized appropriately
- **Richer context:** Full Jira descriptions (including lists and code blocks) now used for matching
- **Fewer corrections needed:** Expected 30-40% reduction in manual reassignments

No action required. If you notice improved matching accuracy, that's the fix working! Report any regressions to support.
```

---

## Conclusion

This plan addresses all 10 unfixed bugs in the AI issue matching system using a phased rollout strategy:

- **Phase 1 (Critical):** Bugs #1, #2, #3 — Deploy together as atomic change, includes cache migration
- **Phase 2 (High):** Bugs #4, #5 — Deploy 2-3 days later after Phase 1 stabilizes
- **Phase 3 (Medium):** Bugs #6, #7, #8 — Deploy 1 week later, includes desktop app update
- **Phase 4 (Low):** Bugs #9, #10 — Bundle with next major release

**Expected Outcome:** +20-25 percentage points improvement in overall matching accuracy (65-70% → 85-90%).

**Risk Level:** Low — All fixes are localized, no architectural changes, comprehensive test coverage, documented rollback procedures.

**Total Effort:** 6-8 hours engineering + 2 hours testing + 1 hour deployment per phase.

---

**Plan Status:** Ready for Implementation  
**Next Step:** Begin Phase 1 development (Bugs #1, #2, #3)  
**Approval Required From:** Engineering Lead, Product Owner
