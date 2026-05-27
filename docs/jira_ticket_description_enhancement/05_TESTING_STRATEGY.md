# Testing Strategy

## Test Framework Alignment

| Component | Runner | Location | Naming |
|-----------|--------|----------|--------|
| ai-server | Jest | `ai-server/tests/` | `*.test.js` |
| forge-app (resolvers) | Jest | `forge-app/tests/` | `*.test.js` |
| forge-app (React UI) | Jest + React Testing Library | `forge-app/static/main/src/` | `*.test.js` |
| supabase | Deno.test | Adjacent to function | `*.test.ts` |

---

## MVP Tests

### `ai-server/tests/services/description-service.test.js`

```
Deterministic Scorer:
  ✓ scores a well-formed Bug ticket at 80+
  ✓ scores a minimal Bug ticket (no steps, no expected/actual) below 50
  ✓ scores a well-formed Story ticket with acceptance criteria at 80+
  ✓ scores a Story ticket without acceptance criteria below 70
  ✓ deducts points for placeholder text ("TODO", "TBD")
  ✓ deducts points for title shorter than 10 characters
  ✓ deducts points for title longer than 80 characters
  ✓ deducts points for description shorter than 50 characters
  ✓ redistributes Bug-specific criteria weight for non-Bug types
  ✓ redistributes Story-specific criteria weight for non-Story types
  ✓ returns issues array listing each failed criterion
  ✓ returns suggestions array with actionable improvements
  ✓ handles empty description gracefully (score near 0)
  ✓ handles missing title gracefully
```

### `ai-server/tests/controllers/description-controller.test.js`

```
Input Validation:
  ✓ returns 400 when title is missing
  ✓ returns 400 when description is missing
  ✓ returns 400 when issueType is missing
  ✓ returns 400 when issueKey is missing
  ✓ returns 400 when title exceeds max length (500 chars)
  ✓ returns 400 when description exceeds max length (50000 chars)

Auth:
  ✓ returns 401 when FIT token is missing
  ✓ returns 401 when FIT token is invalid
  ✓ extracts cloudId and accountId from valid FIT token

Route Integration:
  ✓ POST /api/forge/description/analyze returns 200 with valid input
  ✓ response contains score, issues, suggestions fields
  ✓ response source is "deterministic" when no LLM invoked
```

### `forge-app/tests/resolvers/descriptionResolvers.test.js` (MVP portion)

```
analyzeDescription:
  ✓ fetches issue data from Jira API
  ✓ extracts plain text from ADF description
  ✓ calls invokeRemote with correct endpoint and payload
  ✓ returns score and suggestions from AI server response
  ✓ handles AI server error gracefully (returns error message)
  ✓ handles missing issue key with validation error
```

---

## V1 Tests

### `ai-server/tests/services/description-service.test.js` (additions)

```
LLM Gate:
  ✓ does NOT invoke LLM when deterministic score >= 80
  ✓ invokes LLM when deterministic score < 80
  ✓ invokes LLM when requestImprovement is true regardless of score

PII Sanitization:
  ✓ redacts email addresses (user@example.com → [EMAIL])
  ✓ redacts API keys (patterns like sk-xxx, AKIA-xxx)
  ✓ redacts credit card numbers (16 digits)
  ✓ redacts phone numbers
  ✓ redacts Atlassian account IDs
  ✓ preserves non-PII content unchanged
  ✓ handles text with no PII (returns original)

LLM Integration (mocked):
  ✓ passes correct prompt for Bug issue type
  ✓ passes correct prompt for Story issue type
  ✓ passes correct prompt for Task issue type
  ✓ passes correct prompt for Epic issue type
  ✓ passes temperature: 0.3 to chatCompletionWithFallback
  ✓ passes response_format: json_object to chatCompletionWithFallback
  ✓ passes max_tokens: 2000 to chatCompletionWithFallback
  ✓ returns improved_title and improved_description from LLM
  ✓ validates LLM response schema (score, issues, suggestions, improved)
  ✓ retries once on malformed LLM response
  ✓ falls back to deterministic result after retry failure
  ✓ falls back to deterministic result on LLM timeout (8s)
  ✓ sets source to "llm" when LLM result is used
```

### `ai-server/tests/services/description-prompts.test.js`

```
Prompt Generation:
  ✓ generates Bug prompt with QA Analyst persona
  ✓ generates Story prompt with Product Owner persona
  ✓ generates Task prompt with PM persona
  ✓ generates Epic prompt with Business Analyst persona
  ✓ includes title and description in prompt
  ✓ includes scoring criteria in prompt
  ✓ specifies JSON response format in prompt
  ✓ does not include PII-containing original text in returned prompt
```

---

## V2 Tests

### `forge-app/tests/utils/adfBuilder.test.js`

```
ADF Builder:
  ✓ builds valid ADF document node
  ✓ converts heading text to ADF heading node
  ✓ converts paragraph text to ADF paragraph node
  ✓ converts numbered list to ADF orderedList node
  ✓ converts bullet list to ADF bulletList node
  ✓ handles nested list items correctly
  ✓ handles bold/italic text marks
  ✓ produces valid ADF structure (passes Atlassian ADF schema validation)
  ✓ handles empty input gracefully
  ✓ handles input with only whitespace
```

### `forge-app/tests/resolvers/descriptionResolvers.test.js` (V2 additions)

```
updateDescription:
  ✓ converts improved description to ADF using adfBuilder
  ✓ calls PUT /rest/api/3/issue/{key} with ADF body
  ✓ updates title when updateTitle is true
  ✓ does not update title when updateTitle is false
  ✓ returns success: true on successful write
  ✓ returns error when ADF validation fails (does not call Jira API)
  ✓ handles Jira API error gracefully

wasDescriptionChanged:
  ✓ returns true when changelog shows description field change
  ✓ returns false when changelog shows only other field changes
  ✓ returns false when changelog is empty
  ✓ handles Jira API error gracefully
```

### Cache Tests (in `description-service.test.js`)

```
Caching:
  ✓ stores result in Supabase after successful analysis
  ✓ generates SHA-256 hash from title + description content
  ✓ returns cached result when content hash matches
  ✓ does not invoke scorer/LLM when cache hit
  ✓ invalidates cache when content hash differs
  ✓ sets cached: true in response for cache hits
  ✓ sets cached: false in response for fresh analysis
```

---

## Test Commands

```bash
# Run all description enhancement tests (ai-server)
cd ai-server && npx jest tests/services/description-service.test.js tests/controllers/description-controller.test.js tests/services/description-prompts.test.js

# Run all description enhancement tests (forge-app)
cd forge-app && npx jest tests/resolvers/descriptionResolvers.test.js tests/utils/adfBuilder.test.js

# Run full component test suite (regression check)
cd ai-server && npm test
cd forge-app && npm test
```

---

## Integration Test Scenarios (Manual / E2E)

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | Open issue panel on a high-quality Bug ticket | Score ≥ 80, green badge, minimal issues |
| 2 | Open issue panel on a low-quality ticket (1-line description) | Score < 50, red badge, multiple issues listed |
| 3 | Click "Check Quality" on a Story without acceptance criteria | Score deducted, suggestion to add AC |
| 4 | Click "Improve" on a low-quality ticket | LLM returns structured improved description |
| 5 | Accept improved description | Jira issue description updates with ADF content |
| 6 | Edit improved description then Accept | Modified content written to Jira |
| 7 | Reject improved description | No Jira write, panel dismisses suggestion |
| 8 | LLM timeout during improvement | Deterministic score still shown, "AI unavailable" message |
| 9 | Re-open panel on previously analyzed ticket | Cache hit, instant display of last score |
| 10 | Modify ticket description, re-analyze | Cache miss, fresh analysis runs |
