# Implementation Phases

## Phase Overview

| Phase | Scope | Days | LLM Cost | Risk |
|-------|-------|------|----------|------|
| **MVP** | Deterministic scoring + suggestions UI | 5–7 | $0 | Low |
| **V1** | + LLM analysis + improved description (read-only) | +5–7 | Low | Medium |
| **V2** | + Accept/write-back + edit mode + caching + analytics | +5–7 | Low | Medium |

---

## MVP — Deterministic Scoring (5–7 days)

### Scope

- Deterministic rules engine (9 criteria, score 0–100)
- AI server endpoint (deterministic path only, no LLM)
- Forge resolver (`analyzeDescription` — deterministic only)
- React UI: score badge, issues list, suggestions list
- No LLM calls, no write-back, no caching

### Acceptance Criteria

1. User can click "Check Quality" button in the issue panel
2. System displays a quality score (0–100) with color badge (Red <50, Yellow 50-79, Green 80+)
3. System lists specific issues found in the ticket
4. System provides actionable suggestions for improvement
5. Score correctly adapts criteria based on issue type (Bug vs Story vs Task)
6. Non-applicable criteria redistribute weight correctly
7. Response time < 2 seconds
8. Auth via FIT token works correctly
9. Input validation rejects malformed requests with 400 status

### Tasks

| # | Task | Component | Days |
|---|------|-----------|------|
| 1 | Create `description-controller.js` with route + input validation | ai-server | 0.5 |
| 2 | Create `description-service.js` with deterministic scorer | ai-server | 1.5 |
| 3 | Register route in `ai-server/src/index.js` | ai-server | 0.5 |
| 4 | Create `descriptionResolvers.js` (analyzeDescription only) | forge-app | 1 |
| 5 | Register resolvers in `forge-app/src/index.js` | forge-app | 0.5 |
| 6 | Create `DescriptionQuality` React component (score + issues + suggestions) | forge-app/static | 2 |
| 7 | Write unit tests for deterministic scorer | ai-server/tests | 1 |
| 8 | Write unit tests for Forge resolver | forge-app/tests | 0.5 |

---

## V1 — LLM Analysis (5–7 days)

### Scope (additive to MVP)

- LLM gate logic (invoke only when score < 80 or `requestImprovement: true`)
- PII sanitization before LLM call
- Issue-type-aware prompts (Bug/Story/Task/Epic)
- LLM invocation via existing `chatCompletionWithFallback()`
- Schema validation of LLM response (retry once on malformed)
- UI: "Improve" button, improved description display (read-only)
- UI: "Copy to clipboard" button for improved content
- Fallback handling (timeout, malformed, unavailable)

### Acceptance Criteria

1. LLM is NOT invoked when deterministic score ≥ 80 (unless `requestImprovement: true`)
2. LLM IS invoked when score < 80 and produces improved title + description
3. PII (emails, API keys, credit cards, phone numbers) is redacted before LLM call
4. Correct prompt persona is selected based on issue type
5. LLM response is schema-validated; malformed response triggers one retry
6. If LLM fails after retry, deterministic result is still returned
7. 8-second timeout on LLM calls; deterministic result returned on timeout
8. User can click "Improve" to see AI-generated improved version
9. Improved description is displayed read-only with "Copy to clipboard"
10. `temperature: 0.3` and `response_format: json_object` passed to LLM

### Tasks

| # | Task | Component | Days |
|---|------|-----------|------|
| 1 | Add `temperature` and `response_format` params to `chatCompletionWithFallback()` | ai-server | 0.5 |
| 2 | Create `description-prompts.js` with 4 issue-type personas | ai-server | 1 |
| 3 | Add PII sanitization function to `description-service.js` | ai-server | 0.5 |
| 4 | Add LLM gate + invocation logic to `description-service.js` | ai-server | 1.5 |
| 5 | Add schema validation for LLM response + retry logic | ai-server | 0.5 |
| 6 | Update UI: "Improve" button + read-only improved description | forge-app/static | 1.5 |
| 7 | Add "Copy to clipboard" functionality | forge-app/static | 0.5 |
| 8 | Write tests for LLM integration (mocked) | ai-server/tests | 1 |
| 9 | Write tests for PII sanitization | ai-server/tests | 0.5 |

---

## V2 — Full Workflow (5–7 days)

### Scope (additive to V1)

- ADF builder utility (`adfBuilder.js`)
- `updateDescription` resolver (write-back to Jira)
- `wasDescriptionChanged` resolver (changelog detection)
- Side-by-side comparison view (original vs improved)
- Accept / Edit / Reject buttons
- Edit mode: pre-filled textarea with improved content
- Caching layer (Supabase `description_quality_cache` table)
- Cache lookup on panel open (show last score without re-analysis)
- Analytics logging (accept/reject/edit ratio, score distribution)
- Supabase migration for cache table

### Acceptance Criteria

1. User can Accept improved description → writes back to Jira via ADF
2. User can Edit improved description → pre-filled textarea → then Accept
3. User can Reject → dismisses suggestion, logs rejection for feedback loop
4. ADF builder correctly generates valid ADF from markdown-like structure
5. ADF validation prevents invalid content from being written to Jira
6. If ADF validation fails, improved text shown read-only + "Copy to clipboard"
7. `wasDescriptionChanged` correctly identifies description field changes via changelog
8. Cache hit returns previous analysis without AI server call (panel open)
9. Cache is invalidated when description content hash changes
10. Analytics events logged: accept_count, reject_count, edit_count, score per project
11. Side-by-side view renders original and improved content simultaneously

### Tasks

| # | Task | Component | Days |
|---|------|-----------|------|
| 1 | Create `adfBuilder.js` utility | forge-app/src/utils | 1 |
| 2 | Add `updateDescription` resolver | forge-app/src/resolvers | 1 |
| 3 | Add `wasDescriptionChanged` resolver | forge-app/src/resolvers | 0.5 |
| 4 | Create Supabase migration for `description_quality_cache` | supabase/migrations | 0.5 |
| 5 | Add cache read/write logic to `description-service.js` | ai-server | 1 |
| 6 | Build side-by-side comparison UI | forge-app/static | 1.5 |
| 7 | Build Accept/Edit/Reject action buttons | forge-app/static | 1 |
| 8 | Build edit mode textarea | forge-app/static | 0.5 |
| 9 | Add analytics logging | ai-server | 0.5 |
| 10 | Write tests for ADF builder | forge-app/tests | 0.5 |
| 11 | Write tests for write-back resolver | forge-app/tests | 0.5 |
| 12 | Integration testing | all | 1 |

---

## Parallelization (Two Developers)

| Dev A — Backend | Dev B — Frontend |
|-----------------|------------------|
| MVP Tasks 1–3, 7 (3 days) | MVP Tasks 6 with mock data (2.5 days) |
| V1 Tasks 1–5, 8–9 (4.5 days) | MVP Task 4–5 + V1 Tasks 6–7 (2.5 days) |
| V2 Tasks 4–5, 9 (2 days) | V2 Tasks 1–3, 6–8 (5 days) |
| V2 Tasks 10–11 (1 day) | V2 Task 12 (1 day) |

**Total with 2 devs: ~10–12 days**
