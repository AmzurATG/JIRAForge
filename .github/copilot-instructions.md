# BRD Time Tracker — Copilot Instructions

## Project Overview

Multi-component Jira time-tracking system deployed on the Atlassian Marketplace. Four components communicate to capture desktop activity, run AI analysis, and surface analytics inside Jira.

See [CLAUDE.md](../CLAUDE.md) for full architecture and [docs/](../docs/) for component-specific guides.

---

## Spec-Driven Development Workflow

**Always follow this order. Do not skip steps.**

### 1 — Spec Document

Before writing any code or tests, produce a concise spec in `plan/` (or the relevant component's `plan/` subfolder):

```
plan/<YYYY-MM-DD>_<component>_<feature>.md
```

The spec must include:
- **Problem**: What user-visible behaviour is broken or missing
- **Root cause / context**: Relevant code paths and why the change is needed
- **Proposed solution**: API shape, data flow, or algorithm change (not implementation detail)
- **Acceptance criteria**: Numbered list of observable outcomes the feature must satisfy
- **Out of scope**: Explicitly list what is NOT being changed

Do not proceed past this step until the spec is agreed.

### 2 — Tests First

Write failing tests that map 1-to-1 to each acceptance criterion before touching production code. Tests must be committed (red) before implementation begins.

- **forge-app / ai-server**: Jest, file in `tests/` mirroring `src/` path
- **python-desktop-app**: pytest, file in `tests/` named `test_<module>.py`
- **supabase edge functions**: Deno test (`Deno.test(...)`) adjacent to the function

### 3 — Implementation

Write the minimum code that makes all tests pass. No code without a passing test behind it.

### 4 — Verify & Commit

Run the full test suite for the affected component (commands below) and confirm no regressions before committing.

---

## Components & Tech Stack

| Component | Runtime | Framework | Test runner |
|-----------|---------|-----------|-------------|
| `forge-app/` | Node.js 18 | Atlassian Forge + React | Jest |
| `ai-server/` | Node.js 18 | Express | Jest |
| `python-desktop-app/` | Python 3.9+ | tkinter / system tray | pytest |
| `supabase/functions/` | Deno | Supabase Edge Functions | Deno.test |

---

## Build & Test Commands

```bash
# forge-app
cd forge-app && npm test                # Jest unit tests
cd forge-app && npm run test:coverage   # Coverage report
cd forge-app && npm run build           # Build both React UIs (required before deploy)
forge deploy                            # Deploy to Atlassian (from forge-app/)

# ai-server
cd ai-server && npm test                # Jest unit tests
cd ai-server && npm run dev             # Dev server on port 3001

# python-desktop-app
cd python-desktop-app && python -m pytest tests/   # All unit tests
cd python-desktop-app && python desktop_app.py     # Run locally

# supabase
cd supabase && supabase start           # Local stack (Docker required)
cd supabase && supabase db reset        # Replay all migrations
```

**Run a single test file:**
```bash
# Node.js
npx jest tests/services/activity-service.test.js

# Python
python -m pytest tests/test_ocr_engines.py -v
```

---

## Coding Conventions

### JavaScript / TypeScript (forge-app, ai-server, supabase functions)

- `'use strict'` at the top of every CommonJS module (ai-server)
- ES modules (`import`/`export`) in forge-app and supabase functions
- All Jest test files: declare mocks with `jest.mock(...)` **before** any `require()` calls; call `jest.clearAllMocks()` in `beforeEach`
- No `console.log` in production code — use `logger.info/warn/error` (ai-server) or Forge's built-in logging (forge-app)
- Environment variables accessed only via `process.env`; never hardcode URLs or secrets

### Python (python-desktop-app)

- All test files live under `tests/` and are named `test_<module>.py`
- Import the module under test using the package path (`from ocr.facade import OCRFacade`)
- Use `pytest.fixture` for shared setup; avoid global state in test files
- Sensitive values (tokens, DB passwords) must use `auth/` keyring or OS environment variables — never plain text

### Supabase SQL migrations

- File naming: `supabase/migrations/YYYYMMDD_description.sql` (lowercase, underscores)
- Every new table must have RLS enabled and at least one policy gated on `org_id`
- Never modify an existing migration file — add a new one
- Document the purpose of the migration in a comment block at the top of the file

---

## Architecture Constraints

### Forge Remote (critical)

The Forge app **cannot make arbitrary HTTP calls**. All forge-app → ai-server communication must go through the Forge Remote declared in `manifest.yml` and routed via `src/utils/remote.js`. Never use `fetch()` or `axios` directly in forge-app backend code to call the AI server.

### Multi-tenancy & RLS

Every database operation that reads or writes user data must include `org_id`. The Supabase RLS policies enforce this at the DB level, but service-layer code must also pass `org_id` explicitly. Missing `org_id` in a query is a data leak bug.

### Auth middleware layers

Three token types are in play — match the right middleware to the caller:

| Caller | Middleware |
|--------|-----------|
| Desktop app | `src/middleware/auth.js` (JWT) |
| Forge app | `src/middleware/forge-auth.js` (Forge-signed) |
| Admin dashboard | `src/middleware/dashboard-auth.js` (session) |

### AI prompt changes

When modifying `ai-server/src/services/ai/prompts.js` or `activity-service.js`:
1. Update or add a test in `tests/services/batch-prompt.test.js` or `prompts.test.js`
2. Check `MIN_CONFIDENCE_THRESHOLD` (default `0.4`) — never lower it without measuring the false-positive rate on real data
3. The LLM must only return issue keys from the provided list (`CRITICAL TASK KEY RULE`) — preserve this constraint in any prompt rewrite

---

## Security

- Never log OCR text, window titles, or JWT token values at `info` level — use `debug` and ensure production log level is `info` or higher
- PII in OCR output is redacted by `python-desktop-app/privacy/` before the record leaves the desktop — do not add OCR pass-through paths that bypass this module
- SQL in Supabase migrations must parameterise all user input; never concatenate user values into SQL strings
- OWASP Top 10 applies to all HTTP endpoints in ai-server — validate input at controller boundary using the established pattern in `src/controllers/`

---

## Key Reference Docs

| Topic | File |
|-------|------|
| Full architecture | [docs/01_ARCHITECTURE.md](../docs/01_ARCHITECTURE.md) |
| AI analysis flow | [docs/AI_ANALYSIS_FLOW.md](../docs/AI_ANALYSIS_FLOW.md) |
| AI matching root causes | [docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md](../docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md) |
| Desktop app setup | [docs/desktop-app_README.md](../docs/desktop-app_README.md) |
| Forge app setup | [docs/forge-app_SETUP_GUIDE.md](../docs/forge-app_SETUP_GUIDE.md) |
| Deployment | [docs/DEPLOYMENT_GUIDE_V3.md](../docs/DEPLOYMENT_GUIDE_V3.md) |
