# API Specification

## AI Server Endpoint

### POST `/api/forge/description/analyze`

Analyzes a Jira ticket's title and description, returns quality score, issues, suggestions, and optionally an AI-improved version.

#### Authentication

- **Middleware**: `forgeAuthMiddleware` (Forge Invocation Token)
- **Extracted claims**: `cloudId`, `accountId`

#### Request

```json
{
  "issueKey": "PROJ-123",
  "title": "Login button not working",
  "description": "The login button doesn't work on mobile",
  "issueType": "Bug",
  "projectKey": "PROJ",
  "requestImprovement": false,
  "context": {
    "labels": ["mobile", "auth"],
    "components": ["frontend"],
    "priority": "High"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueKey` | string | Yes | Jira issue key |
| `title` | string | Yes | Issue summary/title |
| `description` | string | Yes | Plain text extracted from ADF description |
| `issueType` | string | Yes | One of: Bug, Story, Task, Epic, Sub-task |
| `projectKey` | string | Yes | Jira project key |
| `requestImprovement` | boolean | No | If true, force LLM invocation regardless of score |
| `context` | object | No | Additional Jira metadata for context-aware suggestions |

#### Response

```json
{
  "score": 62,
  "source": "llm",
  "cached": false,
  "issues": [
    "Missing acceptance criteria",
    "No steps to reproduce",
    "Ambiguous title — does not specify platform or error type"
  ],
  "suggestions": [
    "Add expected vs actual behavior",
    "Include environment details (OS, browser, device)",
    "Specify which login method fails (email, SSO, OAuth)"
  ],
  "improved_title": "Mobile: Login button unresponsive on tap (iOS Safari)",
  "improved_description": "## Summary\nThe login button on the mobile web app does not respond to tap events...\n\n## Steps to Reproduce\n1. Open app on iOS Safari\n2. Navigate to login page\n3. Tap \"Login\" button\n\n## Expected Result\nLogin form submits and user is authenticated\n\n## Actual Result\nNo response on tap; no network request fired\n\n## Environment\n- Device: iPhone 14\n- OS: iOS 17.2\n- Browser: Safari 17\n\n## Additional Context\nWorks correctly on desktop Chrome."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `score` | number (0–100) | Quality score |
| `source` | string | `"deterministic"` or `"llm"` |
| `cached` | boolean | Whether result was served from cache |
| `issues` | string[] | Identified quality problems |
| `suggestions` | string[] | Actionable improvement suggestions |
| `improved_title` | string | null | AI-improved title (null if deterministic only) |
| `improved_description` | string | null | AI-improved description in markdown (null if deterministic only) |

#### Error Responses

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Missing required field: title" }` | Validation failure |
| 401 | `{ "error": "Invalid Forge Invocation Token" }` | FIT auth failure |
| 429 | `{ "error": "Rate limit exceeded" }` | Too many requests per org |
| 500 | `{ "error": "Internal server error" }` | Unexpected failure |
| 503 | `{ "error": "AI service temporarily unavailable" }` | LLM timeout/failure (deterministic result still returned in body) |

---

## Forge Resolvers

### `analyzeDescription`

Called from the React UI to trigger quality analysis.

#### Input (via `@forge/bridge` invoke)

```json
{
  "issueKey": "PROJ-123",
  "requestImprovement": false
}
```

#### Behavior

1. Calls `GET /rest/api/3/issue/{issueKey}` to fetch current issue data
2. Extracts title, description (ADF → plain text), issue type
3. Calls AI server via `invokeRemote('ai-server', '/api/forge/description/analyze', ...)`
4. Returns the response to the UI

#### Output

Same structure as AI server response above.

---

### `updateDescription`

Called when user accepts the improved description.

#### Input

```json
{
  "issueKey": "PROJ-123",
  "improvedTitle": "Mobile: Login button unresponsive on tap (iOS Safari)",
  "improvedDescription": "Structured markdown content...",
  "updateTitle": true,
  "updateDescription": true
}
```

#### Behavior

1. Converts `improvedDescription` (markdown) to ADF using `adfBuilder.js`
2. Validates the ADF structure
3. Calls `PUT /rest/api/3/issue/{issueKey}` with the ADF body
4. If `updateTitle` is true, also updates the summary field
5. Returns success/failure

#### Output

```json
{
  "success": true,
  "updated": ["summary", "description"]
}
```

---

### `wasDescriptionChanged`

Checks if the description field was modified in a recent issue change event.

#### Input

```json
{
  "issueKey": "PROJ-123",
  "changelogId": "12345"
}
```

#### Behavior

1. Calls `GET /rest/api/3/issue/{issueKey}/changelog`
2. Checks the most recent changelog entry for `description` field change
3. Returns boolean

#### Output

```json
{
  "changed": true
}
```

---

## Deterministic Scoring Criteria

The deterministic scorer evaluates 9 criteria, each weighted:

| # | Criterion | Weight | Pass Condition |
|---|-----------|--------|----------------|
| 1 | Title length | 10 | 10–80 characters |
| 2 | Title specificity | 10 | Contains no generic words only (e.g., not just "Bug" or "Issue") |
| 3 | Description minimum length | 15 | ≥ 50 characters |
| 4 | Steps to reproduce (Bug) | 15 | Contains numbered steps or "steps to reproduce" section |
| 5 | Expected/actual result (Bug) | 15 | Contains "expected" AND "actual" keywords or sections |
| 6 | Acceptance criteria (Story) | 15 | Contains "acceptance criteria" or "given/when/then" pattern |
| 7 | No placeholder text | 10 | No "TODO", "TBD", "fill in", "[placeholder]" |
| 8 | Environment/context info | 10 | Contains OS, browser, version, or environment details |
| 9 | Actionability | 15 | Contains verb phrases indicating clear next actions |

**Notes:**
- Criteria 4–5 only apply to Bug issue type
- Criterion 6 only applies to Story issue type
- Non-applicable criteria redistribute weight to remaining criteria
- Total always sums to 100

---

## Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Per org | 100 requests | 1 hour |
| Per user | 20 requests | 1 hour |
| LLM invocations per org | 50 | 1 hour |
