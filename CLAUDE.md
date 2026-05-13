# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BRD Time Tracker — a multi-component time tracking system that integrates with Jira. It captures desktop screenshots, runs OCR + AI analysis to classify work activity, syncs worklogs to Jira, and surfaces analytics through a Forge-based Jira UI. The product is deployed on the Atlassian Marketplace.

## Architecture

Four components, each in its own subdirectory:

### forge-app/ — Jira Forge Application (Node.js 22.x runtime)
The Jira-embedded UI and backend logic. Uses Atlassian Forge platform (not a standard Express app).
- **Backend**: `src/index.js` registers resolvers (Forge's RPC-like pattern) and exports handlers for scheduled triggers, issue update events, lifecycle hooks, and personal-data callbacks. Resolvers live in `src/resolvers/`, business logic in `src/services/`, helpers in `src/utils/`.
- **Frontend**: Two React apps under `static/main/` (project page + issue panel) and `static/settings/` (admin page). Built with `react-scripts`, communicate with backend via `@forge/bridge`. `npm run build` at the forge-app root must succeed before `forge deploy`.
- **Manifest**: `manifest.yml` declares modules (`jira:projectPage`, `jira:issuePanel`, `jira:adminPage`), scheduled triggers (hourly worklog sync), event triggers (`avi:jira:updated:issue`), and lifecycle handlers.
- **Forge Remote (critical)**: The Forge app **cannot make arbitrary HTTP calls**. All forge-app → ai-server traffic goes through the remote keyed `ai-server` (baseUrl `https://forgesync.amzur.com`), routed via `src/utils/remote.js`. Never use `fetch()` or `axios` directly in forge-app backend code to call the AI server.

### ai-server/ — AI Analysis Server (Node.js >=20, Express)
Receives screenshots and activity data, runs AI analysis via OpenAI, manages clustering, notifications, and an admin dashboard. Production URL: `forgesync.amzur.com`.
- `src/controllers/` — Express route handlers (activity, auth, feedback, notifications, admin dashboard, forge-proxy, user data, app versioning)
- `src/services/ai/` — OpenAI integration; prompt definitions in `prompts.js`, classification in `activity-service.js`
- `src/services/db/` — Supabase operations (activity, clustering, feedback, notifications, user, storage)
- `src/services/notifications/` — Email via notifme-sdk
- `src/middleware/` — Four auth layers, one per caller type (see Auth below)
- `src/dashboard/` — Single HTML admin dashboard served at `/admin-dashboard` (built via `npm run build:dashboard`)

### python-desktop-app/ — Desktop Screenshot Capture (Python 3.8+)
A large single-file app (`desktop_app.py`, ~563KB) with supporting modules. Runs as a Windows system-tray application.
- `ocr/` — Multi-engine OCR with facade pattern: RapidOCR (primary, ONNX-based PaddleOCR), WinRT OCR (fallback). Engines are discovered dynamically at runtime via `engine_factory.py`.
- `privacy/` — PII detection and redaction using Microsoft Presidio. **All OCR output must flow through this module before leaving the desktop** — do not add pass-through paths that bypass it.
- `auth/` — Secure token storage using OS keyring + encrypted SQLite (sqlcipher).
- `db_connection.py` — Local encrypted SQLite for offline storage; syncs when network returns.
- Built/distributed via PyInstaller (`desktop_app.spec`, `build.bat`).

### supabase/ — Database & Edge Functions
- `migrations/` — Incremental SQL migrations, named `YYYYMMDD_description.sql`. **Never modify an existing migration** — add a new one. Every new table must have RLS enabled with at least one policy gated on `org_id`.
- `functions/` — Edge Functions (Deno/TypeScript): `screenshot-webhook`, `activity-webhook`, `document-webhook`, `update-issues-cache`. JWT verification is **disabled** (`verify_jwt = false`) — these endpoints validate their own callers.
- `config.toml` — Local dev (API 54321, DB 54322, Studio 54323).

## Build & Run Commands

```bash
# forge-app
cd forge-app && npm install
npm run build              # Builds both React UIs (main + settings) — required before deploy
npm run build:main         # Build only main UI
npm run build:settings     # Build only settings UI
npm test                   # Jest
npm run test:coverage      # Jest + coverage (lcov)
forge deploy               # Deploy (requires Forge CLI + auth)
forge tunnel               # Local dev tunnel

# ai-server
cd ai-server && npm install
cp .env.example .env
npm run dev                # nodemon, port 3001
npm start                  # production
npm test                   # Jest
npm run build:dashboard    # Build admin dashboard sub-app

# python-desktop-app
cd python-desktop-app && pip install -r requirements.txt
cp .env.example .env
python desktop_app.py
./run_tests.sh             # or run_tests.bat on Windows
build.bat                  # PyInstaller Windows build

# supabase
cd supabase
supabase start             # Docker required
supabase db reset          # Reset & replay all migrations
supabase functions serve   # Run Edge Functions locally
```

### Running a single test
```bash
# Node (forge-app, ai-server)
npx jest tests/services/someTest.test.js
npx jest -t "name of test"           # by test-name pattern

# Python desktop app
python -m pytest tests/test_specific.py -v

# Supabase Edge Functions
deno test functions/<name>/<file>.test.ts
```

Forge-app Jest config excludes Playwright/e2e dirs and a couple of integration tests (see `forge-app/package.json` `testPathIgnorePatterns`) — those must be run separately.

## Spec-Driven Development Workflow

Non-trivial changes follow this order (from `.github/copilot-instructions.md`):

1. **Spec** in `plan/<YYYY-MM-DD>_<component>_<feature>.md` (or the component's own `plan/` subfolder). Must cover: Problem, Root cause/context, Proposed solution, Numbered acceptance criteria, Out-of-scope.
2. **Failing tests** mapped 1-to-1 to acceptance criteria, committed red before any production code.
3. **Implementation** — minimum code to make tests pass.
4. **Verify** the full component test suite before committing.

Test locations: Jest tests in `tests/` mirroring `src/` (forge-app, ai-server); pytest tests in `python-desktop-app/tests/` named `test_<module>.py`; Deno tests adjacent to Edge Functions.

## CI/CD

- **SonarCloud**: Runs on push to `main` via `.github/workflows/build.yml`. Config in `sonar-project.properties`. Scans `ai-server/src` and `forge-app/src`; coverage from `ai-server/coverage/lcov.info`.
- **Forge deployment**: Manual via `forge deploy` from `forge-app/`. Build the React UIs first.

## Architecture Constraints

### Multi-tenancy & RLS
Every DB operation that reads or writes user data must include `org_id`. Supabase RLS enforces this at the DB level, but service-layer code must also pass `org_id` explicitly — missing it is a data-leak bug, not just a permissions error.

### Auth middleware layers (ai-server)
Three token types are in play — match middleware to caller:

| Caller | Middleware |
|--------|-----------|
| Desktop app | `src/middleware/auth.js` (JWT) |
| Forge app | `src/middleware/forge-auth.js` (Forge-signed) |
| Atlassian OAuth | `src/middleware/atlassian-auth.js` |
| Admin dashboard | `src/middleware/dashboard-auth.js` (session) |

### Data flow
Desktop captures screenshot → OCR extracts text → `privacy/` redacts PII → POST to AI server (or Edge Function webhook) → AI server calls OpenAI → results written to Supabase → Forge app reads from Supabase (via Forge Remote) to render Jira analytics.

### AI prompt changes (ai-server)
When editing `src/services/ai/prompts.js` or `activity-service.js`:
- Update or add tests in `tests/services/batch-prompt.test.js` or `prompts.test.js`
- Do not lower `MIN_CONFIDENCE_THRESHOLD` (default `0.4`) without measuring false-positive rate on real data
- Preserve the **CRITICAL TASK KEY RULE**: the LLM must only return issue keys from the provided list

## Coding Conventions

### JavaScript (forge-app, ai-server)
- `'use strict'` at the top of every CommonJS module in ai-server
- forge-app and supabase functions use ES modules (`import`/`export`)
- Jest test files: declare `jest.mock(...)` **before** any `require()`; call `jest.clearAllMocks()` in `beforeEach`
- No `console.log` in production code — use `logger.info/warn/error` (ai-server) or Forge's built-in logging
- Read env via `process.env`; never hardcode URLs or secrets

### Python (python-desktop-app)
- Test files under `tests/`, named `test_<module>.py`
- Import the module under test by package path (`from ocr.facade import OCRFacade`)
- Use `pytest.fixture` for shared setup; avoid global state
- Secrets via `auth/` keyring or env vars — never plain text

### Supabase SQL
- Migration filename `YYYYMMDD_description.sql`, lowercase + underscores
- Document the migration purpose in a top-of-file comment block
- Parameterise all user input; no string concatenation into SQL

## Security Notes

- Never log OCR text, window titles, or JWT values at `info` — use `debug`, and keep production log level at `info` or higher
- OWASP Top 10 applies to every ai-server HTTP endpoint — validate at controller boundary using the pattern in `src/controllers/`
- Edge Functions have `verify_jwt = false`; they must validate their callers themselves

## Key Reference Docs

| Topic | File |
|-------|------|
| Full architecture | `docs/01_ARCHITECTURE.md` |
| AI analysis flow | `docs/AI_ANALYSIS_FLOW.md` |
| AI matching root causes | `docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md` |
| Desktop app setup | `docs/desktop-app_README.md` |
| Forge app setup | `docs/forge-app_SETUP_GUIDE.md` |
| Deployment | `docs/DEPLOYMENT_GUIDE_V3.md` |
| Copilot/agent workflow rules | `.github/copilot-instructions.md` |

## Environment Variables

Each component has its own `.env` (not committed). See `.env.example` files in `ai-server/` and `python-desktop-app/`. Required: Supabase URL/keys, OpenAI API key, JWT secrets, OCR engine config.
