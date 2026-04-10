# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BRD Time Tracker — a time tracking solution integrated with Atlassian Jira. It captures work activity via desktop screenshots, analyzes them with AI, and syncs time logs to Jira issues.

The system has four components:
- **Desktop App** (`python-desktop-app/`) — Python app that captures screenshots, runs OCR, detects activity, and uploads to Supabase
- **AI Server** (`ai-server/`) — Node.js/Express server that processes activities with AI (GPT-4 Vision via Portkey), handles OAuth, and serves an admin dashboard
- **Forge App** (`forge-app/`) — Atlassian Forge plugin for Jira with React UIs for time analytics, issue panels, and settings
- **Supabase** (`supabase/`) — PostgreSQL database with RLS, S3-compatible storage, edge functions, and migrations

## Build & Run Commands

### AI Server (`ai-server/`)
```bash
npm install
npm start              # Production (port 3001)
npm run dev            # Development with nodemon
npm test               # Jest tests
npm run build:dashboard  # Build admin dashboard
```

### Forge App (`forge-app/`)
```bash
npm install
npm run build          # Build all UIs (main + settings + admin-dashboard)
npm run build:main     # Build main UI only
npm run build:settings # Build settings UI only
npm test               # Jest tests
npm run test:coverage  # Jest with LCOV coverage
forge deploy           # Deploy to Atlassian
forge tunnel           # Local development tunnel
```

### Forge React UIs (`forge-app/static/main/` and `forge-app/static/settings/`)
```bash
npm install
npm start              # Local dev server
npm run build          # Production build
```

### Desktop App (`python-desktop-app/`)
```bash
pip install -r requirements.txt
python desktop_app.py  # Launch app
```

## Architecture

### Data Flow
```
Desktop App  →  AI Server  →  Supabase  ←→  Forge App  →  Jira Cloud API
(screenshots)  (AI analysis)  (storage)     (analytics)    (worklogs)
```

### Forge App Resolver Pattern
The Forge app uses `@forge/resolver` with a function-based dispatch pattern. All resolvers register in `forge-app/src/index.js` and are organized by domain in `forge-app/src/resolvers/` (analytics, classification, issues, worklogs, permissions, settings, feedback, users, unassigned work). Business logic lives in `forge-app/src/services/`.

### AI Server Structure
Express app in `ai-server/src/index.js` with:
- **Controllers** (`controllers/`) — route handlers for auth, activity, feedback, notifications, admin dashboard, forge proxy
- **Services** (`services/`) — business logic including AI client (`services/ai/ai-client.js`), clustering, activity processing
- **DB Services** (`services/db/`) — Supabase data access layer
- **Middleware** (`middleware/`) — auth (API key, Forge, Atlassian OAuth, dashboard password), request ID tracking

### Scheduled Triggers
- **Hourly worklog sync** — `scheduledWorklogSync` function (900s timeout) syncs tracked time to Jira worklogs
- **Issue cache sync** — `issueCacheSync` triggers on `avi:jira:updated:issue` events

### Key Architectural Patterns
- **Multi-tenancy**: Row-Level Security (RLS) in Supabase, organization-based data isolation
- **Auth flow**: Desktop initiates Atlassian OAuth → AI Server exchanges client_secret → returns access token + Supabase credentials (client_secret never leaves server)
- **AI pipeline**: Portkey for load balancing/fallback routing to GPT-4 Vision; activity analysis, work classification, unassigned work clustering
- **Privacy**: Presidio PII detection in OCR output, SQLCipher AES-256 local encryption, log sanitization (emails, tokens, IPs)
- **Forge remote**: AI Server registered as a Forge remote at `https://forgesync.amzur.com`

## Environment Configuration

Both `ai-server/.env.example` and `python-desktop-app/.env.example` document all required variables. Key categories:
- **AI Server**: Supabase credentials, Atlassian OAuth client ID/secret, AI provider keys (Portkey/OpenAI), admin dashboard password, feature flags, privacy settings
- **Desktop App**: Atlassian client ID, AI server URL, capture interval, OCR engine config, logging settings

## Database

Supabase PostgreSQL with migrations in `supabase/migrations/` (28 files). Key tables: `users`, `organizations`, `activity_records`, `screenshots`, `clustering_sessions`, `application_classifications`, `project_settings`, `tracking_settings`.

Edge functions in `supabase/functions/`: `screenshot-webhook` and `activity-webhook` (both JWT-disabled for webhook access).

Local dev: `supabase/config.toml` (API port 54321, DB port 54322, Studio port 54323).

## CI/CD

GitHub Actions workflow in `.github/workflows/build.yml` runs SonarQube analysis on push to main. SonarQube config in `sonar-project.properties` analyzes `ai-server/src` and `forge-app/src`.

## Prerequisites

- Node.js 20.x or 22.x
- Python 3.8+
- Atlassian Developer Account
- Supabase Account
- OpenAI API Key (or Portkey key)
