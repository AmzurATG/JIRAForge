# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BRD Time Tracker — a multi-component time tracking system that integrates with Jira. It captures desktop screenshots, runs OCR + AI analysis to classify work activity, syncs worklogs to Jira, and surfaces analytics through a Forge-based Jira UI. The product is deployed on the Atlassian Marketplace.

## Architecture

Four components, each in its own subdirectory:

### forge-app/ — Jira Forge Application (Node.js)
The Jira-embedded UI and backend logic. Uses Atlassian Forge platform (not a standard Express app).
- **Backend**: `src/index.js` registers resolvers (Forge's RPC-like pattern) and event handlers. Resolvers live in `src/resolvers/`, business logic in `src/services/`, helpers in `src/utils/`.
- **Frontend**: Two React apps under `static/main/` (project page + issue panel) and `static/settings/` (admin page). Built with `react-scripts`, communicate with backend via `@forge/bridge`.
- **Triggers**: Scheduled worklog sync (hourly), issue update cache sync, app install/uninstall lifecycle hooks — all declared in `manifest.yml`.
- **Remote**: The Forge app calls the AI server via Forge Remote (`remotes` in manifest.yml, key `ai-server`), routed through `src/utils/remote.js`.

### ai-server/ — AI Analysis Server (Node.js/Express)
Receives screenshots and activity data, runs AI analysis via OpenAI, manages clustering, notifications, and an admin dashboard.
- `src/controllers/` — Express route handlers (activity, auth, feedback, notifications, admin dashboard, forge-proxy, user data, app versioning)
- `src/services/ai/` — OpenAI integration for screenshot analysis and activity classification
- `src/services/db/` — Supabase database operations (activity, clustering, feedback, notifications, user, storage)
- `src/services/notifications/` — Email notification system using notifme-sdk
- `src/middleware/` — Auth middleware: `auth.js` (desktop JWT), `forge-auth.js` (Forge-signed requests), `atlassian-auth.js` (Atlassian OAuth), `dashboard-auth.js` (admin dashboard sessions)
- `src/dashboard/` — Single HTML admin dashboard served at `/admin-dashboard`
- Production URL: `forgesync.amzur.com`

### python-desktop-app/ — Desktop Screenshot Capture (Python)
A large single-file app (`desktop_app.py`, ~563KB) with supporting modules. Runs as a system tray application on Windows.
- `ocr/` — Multi-engine OCR system with facade pattern: RapidOCR (primary), WinRT OCR (fallback). Dynamic engine discovery via `engine_factory.py`.
- `privacy/` — PII detection and redaction using Microsoft Presidio before sending data to AI server.
- `auth/` — Secure token storage using OS keyring + encrypted SQLite (sqlcipher).
- `db_connection.py` — Local encrypted SQLite database for offline storage and sync.
- Built/distributed via PyInstaller (`desktop_app.spec`, `build.bat`).

### supabase/ — Database & Edge Functions
- `migrations/` — Incremental SQL migrations (naming: `YYYYMMDD_description.sql`). Applied via Supabase CLI.
- `functions/` — Supabase Edge Functions (TypeScript): `screenshot-webhook`, `activity-webhook`, `document-webhook`, `update-issues-cache`.
- `config.toml` — Local Supabase dev config (API port 54321, DB port 54322, Studio port 54323).

## Build & Run Commands

### Forge App
```bash
cd forge-app
npm install
npm run build              # Builds both React UIs (main + settings)
npm run build:main         # Build only the main UI
npm run build:settings     # Build only the settings UI
npm test                   # Jest tests
npm run test:coverage      # Jest with coverage
forge deploy               # Deploy to Atlassian (requires Forge CLI + auth)
forge tunnel               # Local dev tunnel for Forge
```

### AI Server
```bash
cd ai-server
npm install
cp .env.example .env       # Configure env vars (Supabase, OpenAI keys, etc.)
npm run dev                # Dev server with nodemon (port 3001)
npm start                  # Production start
npm test                   # Jest tests
npm run build:dashboard    # Build admin dashboard sub-app
```

### Python Desktop App
```bash
cd python-desktop-app
pip install -r requirements.txt
cp .env.example .env       # Configure Supabase URL, keys, OCR settings
python desktop_app.py      # Run the desktop app
python run_tests.sh        # Run test suite (or run_tests.bat on Windows)
build.bat                  # Build Windows executable via PyInstaller
```

### Supabase
```bash
cd supabase
supabase start             # Start local Supabase (Docker required)
supabase db reset           # Reset local DB and replay all migrations
supabase functions serve    # Serve Edge Functions locally
```

### Running a Single Test
```bash
# Forge app (Jest)
cd forge-app && npx jest tests/services/someTest.test.js

# AI server (Jest)
cd ai-server && npx jest tests/controllers/someController.test.js

# Python desktop app
cd python-desktop-app && python -m pytest tests/test_specific.py
```

## CI/CD

- **SonarCloud**: Runs on push to `main` via `.github/workflows/build.yml`. Config in `sonar-project.properties`. Scans `ai-server/src` and `forge-app/src`, reports coverage from `ai-server/coverage/lcov.info`.
- **Forge deployment**: Manual via `forge deploy` from `forge-app/`.

## Key Technical Details

- **Auth flow**: Desktop app authenticates users via Atlassian OAuth (PKCE). The AI server validates JWTs from three sources: desktop app tokens, Forge-signed requests, and Atlassian OAuth tokens — each with its own middleware.
- **Data flow**: Desktop app captures screenshots -> OCR extracts text -> privacy filter redacts PII -> sends to AI server -> AI server calls OpenAI for classification -> stores results in Supabase -> Forge app reads from Supabase to display analytics in Jira.
- **Multi-tenancy**: Organization-based isolation via Supabase Row Level Security (RLS). The `org_id` column partitions data across tenants.
- **Forge Remote pattern**: The Forge app cannot make arbitrary HTTP calls. It uses Forge Remote (declared in `manifest.yml`) to proxy requests to the AI server. All Forge-to-AI-server communication goes through `src/utils/remote.js`.
- **Edge Functions**: Supabase Edge Functions act as webhooks — the desktop app and AI server POST data to them (screenshot uploads, activity records, issue cache updates). JWT verification is disabled on these endpoints (`verify_jwt = false` in `config.toml`).
- **OCR architecture**: Uses a facade pattern (`ocr/facade.py`) with pluggable engines. Primary engine is RapidOCR (ONNX-based PaddleOCR). Engines are discovered dynamically at runtime via `engine_factory.py`.
- **Offline support**: The desktop app stores data in an encrypted local SQLite database when the network is unavailable, then syncs when connectivity is restored.

## Environment Variables

Each component has its own `.env` file (not committed). See `.env.example` files in `ai-server/` and `python-desktop-app/` for required variables. Key variables include Supabase URL/keys, OpenAI API key, JWT secrets, and OCR engine configuration.
