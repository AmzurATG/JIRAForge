# Architecture & Technical Design

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Jira Cloud                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Issue Panel (jira:issuePanel)                           │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │  DescriptionQuality React Component                 │ │   │
│  │  │  - Score Badge (Red/Yellow/Green)                   │ │   │
│  │  │  - Issues List                                      │ │   │
│  │  │  - Suggestions                                      │ │   │
│  │  │  - Improve Button                                   │ │   │
│  │  │  - Side-by-side Comparison View                     │ │   │
│  │  │  - Accept / Edit / Reject Buttons                   │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │ @forge/bridge invoke()                 │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │  Forge Backend Resolvers                                  │   │
│  │  - analyzeDescription                                     │   │
│  │  - updateDescription                                      │   │
│  │  - wasDescriptionChanged                                  │   │
│  └──────────────────────┬───────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────┘
                          │ Forge Remote (invokeRemote)
                          │ FIT Auth Token
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  AI Server (forgesync.amzur.com)                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  POST /api/forge/description/analyze                      │   │
│  │  Middleware: forgeAuthMiddleware → rate limiter            │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │  Description Service                                      │   │
│  │  1. Deterministic Scorer (9 criteria, 0–100)              │   │
│  │  2. LLM Gate (score < 80 → invoke LLM)                   │   │
│  │  3. PII Sanitization (regex-based)                        │   │
│  │  4. Prompt Selection (Bug/Story/Task/Epic)                │   │
│  │  5. LLM Invocation (Portkey → Gemini/GPT-5)              │   │
│  │  6. Schema Validation + Retry                             │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │                                        │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │  Supabase (Cache Layer)                                   │   │
│  │  Table: description_quality_cache                         │   │
│  │  - SHA-256 content hash for cache lookup                  │   │
│  │  - Upsert on analysis complete                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow — End-to-End (15 Steps)

| Step | Stage | Description |
|------|-------|-------------|
| 1 | **Trigger** | User clicks "Check Quality" or saves description (JIRA_ISSUE_CHANGED event). Panel open only shows last cached score — no background triggers. |
| 2 | **Data Extraction** | Forge resolver calls `GET /rest/api/3/issue/{key}`, extracts ADF description to plain text via `extractDescriptionText()`. |
| 3 | **Remote Call** | `invokeRemote()` sends payload to AI Server at `/api/forge/description/analyze` with Forge Invocation Token (FIT) auth. |
| 4 | **Auth & Validation** | `forgeAuthMiddleware` validates FIT token, extracts `cloudId`/`accountId`, checks rate limits and input schema. |
| 5 | **Deterministic Score** | Rules engine scores 9 criteria (title length, steps to reproduce, acceptance criteria, no placeholders, etc.) out of 100. |
| 6 | **LLM Gate** | Score ≥ 80 → skip LLM, return deterministic result. Score < 80 or user clicks "Improve" → invoke LLM. |
| 7 | **PII Sanitization** | Regex redacts emails, API keys, credit cards, phone numbers, Atlassian IDs before LLM call. |
| 8 | **Prompt Selection** | Issue-type persona selected: Bug → Senior QA Analyst, Story → Product Owner, Task → PM, Epic → Business Analyst. |
| 9 | **LLM Invocation** | `chatCompletionWithFallback()` via Portkey (Gemini/GPT-5), max_tokens: 2000, temperature: 0.3, response_format: json_object. 8s timeout. |
| 10 | **Validation & Cache** | Schema-validates LLM output (retry once if malformed), then upserts to Supabase `description_quality_cache` table. |
| 11 | **Response** | Returns score, source (llm/deterministic), issues[], suggestions[], improved_title, improved_description, cached flag. |
| 12 | **UI Rendering** | Panel shows color-coded score badge (Red <50, Yellow 50-79, Green 80+), issues list, suggestions, and "Improve" button. |
| 13 | **User Decision** | Accept → write back | Edit → pre-filled textarea then accept | Reject → dismiss and log for feedback loop. |
| 14 | **ADF Write-back** | Custom `adfBuilder.js` (~50 lines, no @atlaskit) constructs ADF JSON. Validated then `PUT /rest/api/3/issue/{key}`. |
| 15 | **Analytics** | Logs accept/reject/edit ratio, score distribution per project, avg improvement, LLM invocation count per org. |

## Key Technical Decisions

### 1. Trigger: Changelog API for Description-Change Detection

The `JIRA_ISSUE_CHANGED` event fires for all field changes. Three options evaluated:

| Approach | Extra Call? | Accuracy | Complexity | Decision |
|----------|------------|----------|-----------|----------|
| **Changelog API** | 1 lightweight GET | Exact (field-level) | Low | **✅ Selected** |
| Content Hash | 1 GET + Supabase | High | Medium | Fallback |
| Backend Trigger | None | Exact | High (KVS) | ❌ Not recommended |

### 2. ADF Builder: Custom vs @atlaskit

`@atlaskit/adf-utils` rejected for Forge resolver use:
- Browser-specific DOM dependencies
- 50MB bundle limit risk
- Sandbox incompatibility

Custom `adfBuilder.js` handles all required node types: `doc`, `heading`, `paragraph`, `orderedList`, `listItem`, `text` with no external dependencies.

### 3. LLM Client Changes

Existing `chatCompletionWithFallback()` in `ai-client.js` needs:
- New optional parameter: `temperature` (use 0.3)
- New optional parameter: `response_format: { type: "json_object" }`
- `max_tokens` raised from default 800 → 2000 for full description rewrites
- Note: GPT-5 does not support `temperature` — use Gemini for scored output

### 4. Cost Optimization

- Execute deterministic checks first (zero LLM cost)
- Invoke LLM only when score < 80 OR user explicitly requests
- Cache results by SHA-256 content hash — avoid re-analysis of unchanged content
- Target: LLM usage limited to <5% of interactions

## Fallback & Error Handling

| Failure Point | Fallback Behavior |
|---------------|-------------------|
| AI server unreachable | Show deterministic score only + "AI temporarily unavailable" + retry button |
| LLM timeout (> 8s) | Return deterministic result; queue async retry |
| LLM returns malformed JSON | Retry once with stricter prompt; if fails again → deterministic only |
| ADF validation fails | Do NOT write to Jira — show improved text read-only + "Copy to clipboard" button |
| FIT auth fails | Show "Authentication error" in panel; no retry |

## Integration with Existing Architecture

- **Auth**: Uses existing `forgeAuthMiddleware` (same as other forge-proxy endpoints)
- **Remote**: Uses existing `ai-server` remote declaration in `manifest.yml`
- **Supabase**: New table added via standard migration pattern
- **UI**: New component within existing issue panel resource (`static/main/`)
- **No new Forge modules needed** — the existing `jira:issuePanel` module is sufficient
