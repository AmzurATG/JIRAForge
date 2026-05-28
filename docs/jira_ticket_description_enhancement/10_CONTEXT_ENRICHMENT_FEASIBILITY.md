# Context Enrichment Feasibility Report
## AI Description Quality — Attachments, Screenshots & Parent Context

**Date:** 2026-05-27  
**Scope:** Feasibility analysis for two context-enrichment strategies:
1. Feeding Jira ticket screenshots / attached documents to the LLM
2. Including parent Epic / User Story description as additional LLM context

---

## Executive Summary

| Enrichment | Technically Feasible | Effort | Recommended? |
|---|---|---|---|
| Image attachments (screenshots, diagrams) | Yes — conditional | High | Yes (V3 roadmap) |
| Text document attachments (PDF, .docx) | Partially — requires server-side parsing | Medium-High | Conditional |
| Parent Epic / User Story description | Yes — straightforward | Low | **Yes — implement now** |
| Grandparent / linked issues | Yes — with depth limit | Low-Medium | Yes (V2 extension) |

---

## 1. Current State of the Implementation

The current pipeline is **text-only** end to end:

```
Jira Issue
  └─ fields: summary, description, issuetype, project
       │
       ▼ adfToText()                              [forge-app/src/utils/adfBuilder.js]
  Plain text title + description
       │
       ▼ remoteRequest('/api/forge/description/analyze')
  ai-server /api/forge/description/analyze        [description-controller.js]
       │
       ▼ scoreDeterministic() + runLLMAnalysis()  [description-service.js]
  buildMessages({ title, description, issueType }) [description-prompts.js]
       │
       ▼ chatCompletionWithFallback({ messages })  [ai-client.js]
  Portkey → Gemini / OpenAI (text chat completion)
```

**What the resolver currently fetches** (`descriptionResolvers.js:fetchIssueForAnalysis`):
```js
const fields = 'summary,description,issuetype,project';
```
No attachments. No parent. No linked issues.

**What the LLM prompt currently receives** (`description-prompts.js:buildMessages`):
```
--- BEGIN TICKET ---
Title: {title}
Description: {description}
--- END TICKET ---
```
Plain text only. No images. No parent context.

---

## 2. Screenshots and Attached Documents

### 2.1 What Jira Exposes

The Jira v3 REST API exposes attachments via two mechanisms:

**Listing attachments** (available in the issue response):
```
GET /rest/api/3/issue/{key}?fields=attachment
```
Returns each attachment as:
```json
{
  "id": "10001",
  "filename": "screenshot.png",
  "mimeType": "image/png",
  "size": 245600,
  "content": "https://your-site.atlassian.net/rest/api/3/attachment/content/10001"
}
```

**Fetching attachment content**:
```
GET /rest/api/3/attachment/content/{id}
```
Returns raw binary bytes with the appropriate `Content-Type`. Requires Atlassian user authentication — the same credentials used by `api.asUser()` in the Forge resolver.

### 2.2 Images / Screenshots — Feasibility

**Is it possible?** Yes. The full pipeline is:

```
Forge Resolver
  1. GET /rest/api/3/issue/{key}?fields=...,attachment
  2. Filter: mimeType in [image/png, image/jpeg, image/webp, image/gif]
  3. For each selected image (capped at 2–3):
       GET /rest/api/3/attachment/content/{id}   ← api.asUser().requestJira()
       arrayBuffer() → base64 encode
  4. Pass base64 strings + mimeTypes in the remoteRequest body
  5. ai-server buildMessages() builds a multimodal message
  6. chatCompletionWithFallback({ messages, isVision: true })
  7. Portkey → vision-capable model (Gemini 2.0 Flash, GPT-4o)
```

**What already works today in the codebase:**

| Component | Status | Detail |
|---|---|---|
| `chatCompletionWithFallback` in `ai-client.js` | ✅ Has `isVision` param | Parameter exists but is never passed `true` from description path |
| Portkey gateway | ✅ Routes to vision models | Gemini 2.0 Flash and GPT-4o both support vision |
| `api.asUser().requestJira()` in Forge | ✅ Can fetch attachment content | Works with the `/rest/api/3/attachment/content/{id}` endpoint |
| `buildMessages` in `description-prompts.js` | ❌ Text-only | Returns `[{ role: 'system', ... }, { role: 'user', content: string }]` |
| Forge Remote payload | ⚠️ Size-constrained | Forge Remote JSON payload limit is approximately 6 MB |

**What needs to be built:**

1. **`fetchIssueForAnalysis` change** — add `attachment` to the fields list, filter to image types, download and base64-encode up to 2 images (to stay within token and payload limits).

2. **`buildMessages` change** — when image data is present, convert the `user` message `content` from a plain `string` to an array of content parts (OpenAI multimodal format):
   ```js
   // Current
   { role: 'user', content: `--- BEGIN TICKET ---\n...` }
   
   // With images
   { role: 'user', content: [
     { type: 'text', text: `--- BEGIN TICKET ---\n...` },
     { type: 'image_url', image_url: { url: 'data:image/png;base64,...', detail: 'low' } },
     { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...', detail: 'low' } }
   ]}
   ```

3. **Controller `validateAnalyzePayload`** — accept an optional `attachments: Array<{data: string, mimeType: string}>` field with size guard.

4. **`description-service.js analyzeDescription`** — pass attachments through to `runLLMAnalysis` → `invokeLLMOnce` → `buildMessages`.

5. **PII sanitization** — images cannot be scanned by the current regex-based `sanitizePII`. A blanket policy should be established: images attached to Jira tickets are assumed non-sensitive (they are already stored in Jira). Document this assumption in `07_SECURITY_AND_COMPLIANCE.md`.

**Hard constraints and risks:**

| Constraint | Detail | Mitigation |
|---|---|---|
| Forge Remote payload cap ~6 MB | Two 1 MB images + JSON overhead fits; three 2 MB images does not | Limit to 2 images, resize to max 800×600 before encoding |
| LLM vision token cost | GPT-4o: ~1000 tokens per 512×512 tile; Gemini 2.0 Flash: ~258 tokens per image | Use `detail: 'low'` on OpenAI; keep images below 768px |
| `response_format: { type: 'json_object' }` with vision | OpenAI GPT-4o supports JSON mode + vision; Gemini supports JSON output + vision | Both work via Portkey; no change needed to response parsing |
| Forge resolver execution time limit | 25 seconds per Forge function invocation | Downloading 2 images adds ~1–2 s; well within limit |
| `arraybuffer()` availability in Forge runtime | Forge nodejs22 runtime supports standard `Response.arrayBuffer()` | No issue |
| Images containing PII (faces, screens with personal data) | Cannot be auto-redacted | User consent is already required before the feature runs; document the policy |

**Estimated effort:** 3–4 days. No new infrastructure. Purely additive changes to 4 files.

### 2.3 Text Document Attachments — Feasibility

Jira users commonly attach PDFs, Word documents, Excel sheets, and plain text files that contain requirements, acceptance criteria, or design notes directly relevant to the ticket.

**Can the LLM read these?** Not directly — LLMs accept text or images, not binary document formats.

**Extraction pipeline required on the ai-server:**

| Format | Library | Notes |
|---|---|---|
| `.txt`, `.md`, `.csv` | Native string read | Trivial |
| `.pdf` | `pdf-parse` (npm) | Server-side only; no browser support |
| `.docx` | `mammoth` (npm) | Extracts raw text; good fidelity |
| `.xlsx` | `xlsx` (npm) | Can extract cell values as plain text |
| `.png/.jpg` embedded in docs | OCR already exists in `python-desktop-app/` | Would require calling the desktop OCR service; not realistic from ai-server |

**Recommended approach (if pursued):**
- The Forge resolver downloads the attachment bytes (same mechanism as images)
- Passes the raw bytes + `mimeType` + `filename` to the ai-server in the request body
- ai-server detects the type and extracts text server-side
- Extracted text is appended to the LLM prompt under `## Attached Documents`
- Maximum extracted text per document: 3000 characters (to control token cost)

**Key risk:** Payload size. A 500 KB PDF encoded as base64 becomes ~667 KB. Multiple attachments could exceed the Forge Remote payload limit. A safer alternative is to have the ai-server download the attachment directly using a short-lived delegated token — but Jira does not issue such tokens in the standard Forge model.

**Estimated effort:** 5–7 days (requires npm package additions to ai-server, new extraction module, integration tests).

**Recommendation:** Defer document extraction to a future release. Prioritize image support first.

---

## 3. Parent Epic / User Story Context

### 3.1 What Jira Exposes

The parent-child hierarchy in Jira Cloud v3:

| Scenario | Field to read | API |
|---|---|---|
| Sub-task → Task | `fields.parent.key` | Included in issue response |
| Task → Epic (NextGen / Team-managed) | `fields.parent.key` | Included in issue response |
| Story → Epic (Classic project) | `fields.parent.key` | Included in issue response (Jira 9+) |
| Issue → Epic (classic, Jira 8.x) | `fields.customfield_10014` | Legacy Epic Link field |

For modern Jira Cloud (which this app targets), `fields.parent` is the correct field. No custom field lookup needed.

### 3.2 Fetching Parent Data

**Change required in `fetchIssueForAnalysis`** (`descriptionResolvers.js`):

```js
// Current
const fields = 'summary,description,issuetype,project';

// With parent context
const fields = 'summary,description,issuetype,project,parent';
```

Then, if `issue.fields.parent` exists, make a **second Jira API call** to fetch the parent's description:

```js
async function fetchParentContext(parentKey) {
  if (!parentKey) return null;
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${parentKey}?fields=summary,description,issuetype`, {
      headers: { Accept: 'application/json' }
    });
  if (!response.ok) return null;
  const parent = await response.json();
  return {
    key: parentKey,
    title: parent.fields?.summary || '',
    description: parent.fields?.description ? adfToText(parent.fields.description) : '',
    issueType: parent.fields?.issuetype?.name || ''
  };
}
```

**Cost:** One additional Jira API call per analysis. Jira rate limits are generous (300 requests/minute per user); this has no practical impact.

### 3.3 Using Parent Context in the LLM Prompt

**Change required in `description-prompts.js:buildMessages`:**

```js
// Current user message
const user = `--- BEGIN TICKET ---
Title: ${title}
Description:
${description || '(empty)'}
--- END TICKET ---`;

// With parent context
const parentSection = parentContext
  ? `--- PARENT ${parentContext.issueType.toUpperCase()} (${parentContext.key}) ---
Title: ${parentContext.title}
Description:
${parentContext.description ? parentContext.description.slice(0, 1500) : '(no description)'}
--- END PARENT ---

`
  : '';

const user = `${parentSection}--- BEGIN TICKET ---
Title: ${title}
Description:
${description || '(empty)'}
--- END TICKET ---`;
```

Truncating parent description at 1500 characters prevents token overrun while still giving the LLM the strategic context it needs.

**Update to system prompt:** Add an instruction:

```
If a parent issue is provided, use it to understand the strategic context 
and ensure the ticket's description aligns with the parent's goals. Do NOT 
rewrite the ticket to match the parent — only use the parent for context.
Do NOT invent acceptance criteria from the parent.
```

### 3.4 What This Enables

**Example: FEEDBACK-82 "AI Issue Matching Accuracy (Median)"**

Without parent context, the LLM evaluates the ticket in isolation. With parent context:

- If the parent Epic says "Build a real-time AI matching system with 95% accuracy", the LLM knows the ticket's `ADFParser` fix is a sub-component of a larger accuracy initiative
- The improved description can reference the strategic goal
- The score can account for whether the ticket's scope is consistent with the parent
- Suggestions can be tailored: "link this to the Epic's success metric: 95% accuracy"

### 3.5 Depth: Going Beyond the Immediate Parent

For Sub-tasks, the hierarchy can be 3 levels deep:

```
Epic → Story → Sub-task (3 levels)
Epic → Task (2 levels)
```

**Recommendation:** Fetch at most **2 levels** of ancestry. A Sub-task's grandparent Epic provides useful strategic context; going further adds noise.

**Implementation:** Call `fetchParentContext(parentKey)` and, if the parent is itself a child (its `issueType` is not Epic), optionally fetch one more level. Cap total parent context at 3000 characters to protect LLM context.

---

## 4. Combined Context Architecture (Target State)

```
Forge Resolver: fetchIssueForAnalysis()
  ├─ GET issue: summary, description, issuetype, project, parent, attachment
  ├─ adfToText(description) → plain text description
  ├─ if issue.fields.parent:
  │     └─ GET parent: summary, description, issuetype
  │          └─ adfToText(parent.description) → parent context (truncated 1500 chars)
  └─ for attachment (mimeType starts with 'image/') [up to 2]:
        └─ GET /rest/api/3/attachment/content/{id}
             └─ arrayBuffer() → base64 encode → {data, mimeType, filename}

POST /api/forge/description/analyze
  Body: {
    issueKey, title, description, issueType, projectKey, requestImprovement,
    parentContext: { key, title, description, issueType } | null,
    attachments: [{ data: base64, mimeType, filename }]  // 0-2 items
  }

ai-server: analyzeDescription()
  ├─ scoreDeterministic({ title, description, issueType }) — unchanged
  └─ runLLMAnalysis({ sanitizedTitle, sanitizedDescription, issueType,
                      parentContext, attachments })
       └─ buildMessages() — multimodal if attachments present
            ├─ System: persona + criteria (unchanged)
            └─ User: [parentSection] + [ticket text] + [image content parts]
```

---

## 5. Implementation Phases

### Phase A — Parent Context (Low effort, High impact) — Recommended immediately

**Effort:** 1–2 days  
**Files changed:** 3  
**Risks:** Low — purely additive, no infrastructure change

| # | Change | File |
|---|---|---|
| 1 | Add `parent` to fields query; call `fetchParentContext()` | `forge-app/src/resolvers/descriptionResolvers.js` |
| 2 | Add `parentContext` to the request body sent to ai-server | `forge-app/src/resolvers/descriptionResolvers.js` |
| 3 | Add `parentContext` param to `validateAnalyzePayload` | `ai-server/src/controllers/description-controller.js` |
| 4 | Pass `parentContext` through `analyzeDescription` → `runLLMAnalysis` → `buildMessages` | `ai-server/src/services/description-service.js` |
| 5 | Add parent section to user message; update system prompt instruction | `ai-server/src/services/ai/description-prompts.js` |
| 6 | Add `parentContext` to `generateContentHash` so cache invalidates when parent changes | `ai-server/src/services/description-service.js` |

**Acceptance criteria:**
- When analyzing a Task with a parent Epic, the LLM prompt includes the Epic's title and description (truncated to 1500 chars)
- When analyzing an issue with no parent, behavior is identical to current
- Cache key changes when parent description changes
- No regression in deterministic scoring (parent context only affects LLM path)

### Phase B — Image Attachments (Medium effort, Medium impact) — V3 roadmap

**Effort:** 3–4 days  
**Files changed:** 5  
**Risks:** Medium — payload size, token cost, image PII policy

| # | Change | File |
|---|---|---|
| 1 | Add `attachment` to fields query; download + base64-encode up to 2 images | `forge-app/src/resolvers/descriptionResolvers.js` |
| 2 | Add `attachments` to request body | `forge-app/src/resolvers/descriptionResolvers.js` |
| 3 | Add `attachments` to `validateAnalyzePayload` with size + count guards | `ai-server/src/controllers/description-controller.js` |
| 4 | Pass `attachments` through to `runLLMAnalysis` → `invokeLLMOnce` → `buildMessages` | `ai-server/src/services/description-service.js` |
| 5 | Build multimodal message when attachments present; pass `isVision: true` | `ai-server/src/services/ai/description-prompts.js` |

### Phase C — Text Document Extraction — Future release

**Effort:** 5–7 days  
**Risks:** High — binary parsing complexity, payload size  
**Recommendation:** Defer until image support is validated in production.

---

## 6. Token Cost Impact

All estimates use Gemini 2.0 Flash pricing (via Portkey).

| Scenario | Approx. Input Tokens | Approx. Cost per Call |
|---|---|---|
| Current (title + description only) | ~500–1500 | ~$0.0002 |
| + Parent Epic description (1500 chars) | ~1000–2500 | ~$0.0004 |
| + 2 images (800×600, detail: low) | ~2000–4000 | ~$0.0008–0.001 |
| Full enriched (text + parent + 2 images) | ~2500–5500 | ~$0.001–0.002 |

Even at the maximum enriched scenario, cost per analysis remains under $0.002. At 1000 analyses/month, the cost delta from context enrichment is under $2/month.

---

## 7. Recommendations

### Immediate (this sprint)

**Implement Phase A — Parent Context.** It requires changes to only 3 files, adds no infrastructure, and provides the most meaningful quality uplift. A ticket's context is fundamentally incomplete without knowing its parent's goal. The implementation is low-risk and can be delivered alongside the current scoring bug fix.

### Next sprint

**Implement Phase B — Image Attachments.** The `isVision` parameter already exists in `chatCompletionWithFallback`; the Portkey model already supports multimodal input. The work is primarily in the Forge resolver (downloading images) and prompt builder (constructing multimodal messages). Images are most valuable for Bug tickets where the reporter has attached screenshots of UI errors.

### Deferred

**Phase C — Document Extraction.** Requires server-side binary parsing libraries and adds meaningful complexity. Assess after Phase B is in production.

---

## 8. Constraints Not Solvable in the Current Architecture

| Limitation | Reason | Workaround |
|---|---|---|
| Attachments protected by Atlassian auth | ai-server cannot access Jira attachment URLs directly — only the Forge resolver (running as the user) can | Forge resolver downloads and passes base64 encoded data |
| Forge Remote payload cap | Large numbers of large images will exceed the limit | Hard cap: 2 images, resize to max 800px before encoding |
| No real-time parent updates in cache | If the Epic description changes, the child ticket cache is stale | Include parent's `updated` timestamp in the content hash |
| PDF/DOCX parsing | Server-side only; not available in Forge resolver runtime | Must be handled by ai-server after receiving raw bytes |
