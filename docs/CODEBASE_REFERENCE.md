# BRD Time Tracker — Codebase Reference

> Comprehensive end-to-end reference for the BRD Time Tracker system.
> Generated from a deep-dive exploration of all four components on 2026-04-18.
> Keep this alongside `CLAUDE.md` (architecture snapshot) as living onboarding material.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [End-to-End Data Flow](#2-end-to-end-data-flow)
3. [Repository Layout](#3-repository-layout)
4. [Component: Forge App](#4-component-forge-app-jira-embedded-ui--backend)
5. [Component: AI Analysis Server](#5-component-ai-analysis-server-nodejsexpress)
6. [Component: Python Desktop App](#6-component-python-desktop-app-windows-tray)
7. [Component: Supabase Backend](#7-component-supabase-backend)
8. [Authentication & Security Deep Dive](#8-authentication--security-deep-dive)
9. [Database Schema Reference](#9-database-schema-reference)
10. [Triggers, Schedules & Background Jobs](#10-triggers-schedules--background-jobs)
11. [Risks, Gotchas & Fragile Areas](#11-risks-gotchas--fragile-areas)
12. [Onboarding Quickstart — File-by-File Read Order](#12-onboarding-quickstart--file-by-file-read-order)

---

## 1. System Overview

**BRD Time Tracker** is a multi-component Jira-integrated time-tracking product distributed on the Atlassian Marketplace. It silently captures desktop screenshots, runs OCR + AI classification to determine what the user is working on, maps activity to Jira issues, and syncs worklogs to Jira. Analytics surface in a Jira-embedded Forge UI.

### The four components

| Component | Tech | Role | Deploys to |
|---|---|---|---|
| `forge-app/` | Node.js + React (Atlassian Forge) | Jira-embedded UI, resolvers, scheduled worklog sync, lifecycle | Atlassian Marketplace |
| `ai-server/` | Node.js / Express | AI classification, Supabase proxy for Forge, admin dashboard, notifications | `forgesync.amzur.com` (Cloud Run) |
| `python-desktop-app/` | Python (Windows tray) | Screenshot capture, OCR, PII redaction, offline buffering | PyInstaller `.exe`, self-installs to `%LOCALAPPDATA%\TimeTracker\` |
| `supabase/` | PostgreSQL + Edge Functions (Deno/TS) | Database, RLS-enforced tenancy, webhooks, storage | Supabase Cloud |

### Three trust zones

1. **Desktop app** — runs on user's machine, holds Atlassian OAuth tokens (PKCE), talks to AI server with Bearer token, writes directly to Supabase with anon key + custom JWT.
2. **AI server** — the only component that holds Supabase service-role keys and OpenAI/Portkey/Fireworks keys. Brokers all Forge ↔ Supabase traffic.
3. **Forge app** — cannot make arbitrary HTTP calls; signs all AI-server requests via Forge Remote (FIT token). Never sees Supabase credentials directly.

### Core design invariants

- **Multi-tenancy via `organization_id`** on every tenant-scoped table, enforced by Supabase RLS.
- **Custom JWT auth model** (as of migration `20260401`): the AI server mints Supabase JWTs where `sub = users.id`, so RLS works without relying on `auth.users`.
- **Offline-first desktop**: if network is down, screenshots + activity records buffer in an encrypted SQLite (SQLCipher) DB and sync on reconnect.
- **PII redaction before upload**: Microsoft Presidio + custom regex patterns applied to OCR text on the desktop *before* anything leaves the machine.
- **Sub-minute aggregation**: Jira enforces ≥1-minute worklogs, so durations <60s are deferred to the hourly scheduled sync and aggregated (preventing time inflation).
- **Two-phase activity model**: legacy `screenshots` + `analysis_results` tables coexist with the newer `activity_records` table. Summary views UNION both.

---

## 2. End-to-End Data Flow

### 2.1 The happy path (screenshot → worklog)

```
Desktop App (user's Windows machine)
   │  1. Timer fires every 5 min OR window-switch event
   │  2. Capture screenshot (mss/pyautogui)
   │  3. Active-window detection (window title, app name, URL if browser)
   │  4. OCR via facade → RapidOCR (primary) | WinRT (fallback)
   │  5. Privacy filter: Presidio + custom regex → redact PII
   │  6. Hash screenshot (dedupe), compute `work_date` using user TZ
   │  7. Buffer to encrypted local SQLite if offline; else push directly
   │
   ▼
Supabase (anon key + custom JWT; RLS enforced)
   │  INSERT into `activity_records` (status='pending', batch)
   │         OR
   │  INSERT into `screenshots` (legacy path, storage upload)
   │
   │  Database trigger → HTTP webhook
   ▼
Supabase Edge Function: activity-webhook (verify_jwt=false, internal only)
   │  - Fetches user's assigned issues from user_jira_issues_cache
   │  - Prefers fresh issues embedded in the record batch if present
   │  - POSTs entire batch + issues to AI server
   ▼
AI Server: /api/analyze-batch
   │  - authMiddleware: Bearer AI_SERVER_API_KEY
   │  - activity-service.analyzeBatch():
   │      · Builds Portkey/Gemini prompt with first 20 assigned issues
   │      · Calls Portkey primary; fallback to Fireworks if provider demoted
   │      · Parses JSON, validates issue keys against assigned set (anti-hallucination)
   │      · If confidence < AI_MATCH_MIN_CONFIDENCE (default 0.5): issue_key = NULL
   │      · UPDATE activity_records SET status='analyzed', active_task_key=...
   ▼
Supabase activity_records (status='analyzed', assigned to issue or unassigned)

─── Hours later ─────────────────────────────────────────────

Forge scheduled trigger: worklog-sync-trigger (hourly, manifest.yml)
   │  Handler: scheduledWorklogSyncHandler → runScheduledWorklogSync()
   │  - Reads tracking_settings (project > org > global hierarchy)
   │  - Groups activity_records by user+issue, sums duration
   │  - If < 60s aggregated: defer (pending_aggregation)
   │  - If ≥ 60s: INSERT worklog_sync row
   │    · Attempts api.asUser(accountId).requestJira(...)  — offline impersonation
   │    · Success → jira_worklog_id = <real id>
   │    · Failure → jira_worklog_id = NULL (pending), user-context sync picks it up
   │
   │  Meanwhile, user opens the Jira app panel:
   ▼
Forge UI (static/main) → @forge/bridge → invoke('syncMyWorklogs')
   │  - syncCurrentUserWorklogs() queries worklog_sync WHERE jira_worklog_id IS NULL
   │  - Calls api.asUser().requestJira('/rest/api/3/issue/{key}/worklog')
   │  - UPDATE worklog_sync SET jira_worklog_id = <new id>, created_as_user = true
   ▼
Jira displays worklog attributed to the real user.
```

### 2.2 Forge → Supabase reads (analytics, settings, etc.)

Forge cannot hit Supabase directly. Every read goes through Forge Remote → AI server's proxy.

```
React UI (static/main)
   │  invoke('getTimeAnalytics', { clientToday })
   ▼
Resolver (src/resolvers/analyticsResolvers.js)
   │  accountId + cloudId auto-populated from req.context
   ▼
Service (src/services/analytics/userAnalyticsService.js)
   │  fetchTimeAnalyticsBatch(...)
   ▼
src/utils/remote.js → invokeRemote('ai-server', {...})
   │  Forge SDK signs with FIT (Forge Invocation Token) — signed by Atlassian
   │  Includes accountId, cloudId, appId, installationId claims
   ▼
AI Server: forgeAuthMiddleware (src/middleware/forge-auth.js)
   │  - jose.jwtVerify against Atlassian JWKS
   │  - Validates iss='forge/invocation-token', aud matches FORGE_APP_ID
   │  - Attaches req.forgeContext = { cloudId, accountId, appId, ... }
   ▼
forge-proxy-controller.supabaseQuery() or /api/forge/dashboard
   │  - Resolves organization_id from cloudId
   │  - Builds Supabase query via service-role client
   │  - Returns JSON
   ▼
Back through the chain; React renders charts.
```

**Why this matters:** Supabase credentials never leave the AI server. Even if the Forge app's code leaks, the blast radius is bounded.

### 2.3 Unassigned work → worklog (manual)

```
User sees unassigned session chunks in the "Unassigned Work" tab
  → invoke('assignToExistingIssue', { sessionIds, issueKey })
  → Resolver updates activity_records.user_assigned_issue_key
  → If auto-sync enabled: scheduled sync creates worklog next hour
  → Else: createWorklogIfNeeded() → api.asUser().requestJira() immediately
  → Sub-minute guard: if timeToLog < 60s, defer to scheduled sync
```

### 2.4 Uninstall / reinstall (with 30-day grace)

```
User uninstalls app
  → Forge fires avi:forge:uninstalled:app
  → lifecycleHandler → AI server /api/forge/uninstall
  → organizations.status = 'pending_deletion', scheduledDeletionAt = now+30d
  → Reinstall within 30 days: organization reactivates, no data loss
  → After 30 days: admin cron job (/api/admin/process-deletions) hard-deletes
```

---

## 3. Repository Layout

```
JIRAForge/
├── CLAUDE.md                         # High-level architecture (keep updated)
├── README.md
├── SECURITY_AUDIT_APRIL_2026.md      # Most recent security review
├── SECURITY_IMPLEMENTATION_GUIDE.md
├── BUG_REPORT_TIME_MISMATCH_*.md     # Known-bug log
├── sonar-project.properties          # SonarCloud config
├── .github/workflows/build.yml       # CI (SonarCloud scan on main)
│
├── forge-app/                        # Jira Forge app (Node.js + React)
│   ├── manifest.yml                  # Modules, permissions, triggers, remotes
│   ├── src/
│   │   ├── index.js                  # Resolver registration + handler exports
│   │   ├── resolvers/                # @forge/bridge → resolver mapping
│   │   ├── services/                 # Business logic
│   │   ├── utils/remote.js           # AI-server invocation gateway (CRITICAL)
│   │   ├── utils/jira.js             # Jira REST API wrapper
│   │   └── config/constants.js       # JQL, permissions, limits
│   ├── static/main/src/              # Main React app (Dashboard, Analytics tabs)
│   ├── static/settings/src/          # Admin settings React app
│   ├── tests/                        # Jest + Playwright
│   └── legal/                        # Privacy policy, etc.
│
├── ai-server/                        # AI analysis server (Node.js/Express)
│   ├── Dockerfile                    # Node 20.18, PORT=8080 (Cloud Run)
│   ├── src/
│   │   ├── index.js                  # Entry (~631 lines), route registration
│   │   ├── controllers/              # Express route handlers
│   │   ├── middleware/               # auth.js, forge-auth.js, atlassian-auth.js, dashboard-auth.js
│   │   ├── services/
│   │   │   ├── ai/                   # Portkey+Fireworks, prompts
│   │   │   ├── db/                   # Supabase ops (activity, clustering, feedback, etc.)
│   │   │   ├── notifications/        # notifme-sdk email
│   │   │   ├── activity-service.js
│   │   │   ├── clustering-service.js
│   │   │   └── activity-polling-service.js
│   │   ├── dashboard/                # Admin dashboard React build
│   │   ├── utils/                    # logger, log-sanitizer, datetime
│   │   └── config/                   # user-data GDPR config
│   ├── test-matching.js              # Prod-like AI matching test harness
│   ├── test-notification.js          # Email notification smoke test
│   ├── test-unassigned-work-integration.js
│   └── tests/                        # Jest
│
├── python-desktop-app/               # Windows tray screenshot capture
│   ├── desktop_app.py                # Main file (~12,569 lines — yes, really)
│   ├── launch.py / .bat / .ps1       # Launchers with dependency checks
│   ├── config_manager.py             # Local config + hardcoded public values
│   ├── db_connection.py              # SQLCipher-encrypted offline SQLite
│   ├── secure_logger.py
│   ├── create_sqlite_tables.sql      # Local DB schema
│   ├── auth/                         # Secure token storage (keyring + encrypted fallback)
│   ├── ocr/
│   │   ├── facade.py                 # Unified OCR interface
│   │   ├── engine_factory.py         # Dynamic engine registry
│   │   ├── base_engine.py            # Abstract base
│   │   ├── config.py                 # Engine config (env-driven)
│   │   └── <engines>/                # RapidOCR, WinRT, EasyOCR, demo
│   ├── privacy/
│   │   ├── filter.py                 # PII detection coordinator
│   │   ├── config.py                 # PII types, app-specific elevation
│   │   └── detectors/                # Custom patterns + Presidio
│   ├── desktop_app.spec              # PyInstaller build spec (dynamic engine bundling)
│   ├── build.bat
│   ├── requirements.txt
│   └── test_*.py                     # Many standalone test scripts
│
├── supabase/
│   ├── config.toml                   # Local dev ports; verify_jwt=false on webhooks
│   ├── migrations/                   # ~50 migrations, YYYYMMDD_description.sql
│   └── functions/
│       ├── screenshot-webhook/       # INSERT on screenshots → AI server
│       ├── activity-webhook/         # Batch INSERT on activity_records → AI server
│       ├── document-webhook/         # INSERT on documents (BRD processing)
│       └── update-issues-cache/      # Periodic cache refresh (placeholder)
│
├── docs/                             # ~100 markdown deep-dives on specific topics
│                                     # Good references: AI_ANALYSIS_FLOW, ATLASSIAN_OAUTH_SETUP,
│                                     # MULTI_TENANCY_DATABASE_ARCHITECTURE, PKCE_IMPLEMENTATION,
│                                     # SCHEMA_REVIEW, OAUTH_FLOW_CORRECTED
│
├── plan/                             # Planning docs
└── debug_*.sql                       # Ad-hoc debugging queries
```

---

## 4. Component: Forge App (Jira-embedded UI + backend)

Directory: `forge-app/` • Tech: Node.js + React (react-scripts) + Forge SDK

### 4.1 Manifest (`manifest.yml`)

Declares: modules (project page, issue panel, admin settings), permissions scopes, **remotes** (key `ai-server` pointing at `forgesync.amzur.com`), and **triggers**:

| Trigger | Interval/Event | Handler | Purpose |
|---|---|---|---|
| `worklog-sync-trigger` | Hourly (`interval: hour`) | `scheduledWorklogSync` | Creates worklogs from accumulated activity records |
| `issue-cache-trigger` | `avi:jira:updated:issue` | `issueCacheSync` | Keeps `user_jira_issues_cache` fresh |
| `app-installed-trigger` | `avi:forge:installed:app` | `lifecycleHandler` | Creates organization row |
| `app-uninstalled-trigger` | `avi:forge:uninstalled:app` | `lifecycleHandler` | Marks org `pending_deletion` (30-day grace) |
| Personal data handler | Atlassian GDPR polling | `personalDataHandler` | Returns PENDING → COMPLETED for delete/export |

### 4.2 Backend structure (`src/`)

```
src/index.js                        # Resolver.define() registrations; exports 5 handlers
src/resolvers/                      # @forge/bridge invoke() targets
  ├─ analyticsResolvers.js          # getTimeAnalytics, getAllAnalytics, getProjectAnalytics
  ├─ worklogResolvers.js            # createWorklog, syncMyWorklogs, triggerWorklogSync
  ├─ issueResolvers.js              # getActiveIssuesWithTime, getAvailableTransitions, updateIssueStatus
  ├─ permissionsResolvers.js        # getUserPermissions (isJiraAdmin + verified project admins)
  ├─ settingsResolvers.js           # tracking settings CRUD
  ├─ classificationResolvers.js
  └─ unassigned/                    # Unassigned-work submodules (sessionResolvers, assignmentResolvers, ...)

src/services/
  ├─ worklogService.js              # createWorklog, syncCurrentUserWorklogs
  ├─ worklogReassignmentService.js  # reassignWorklog, splitWorklog
  ├─ scheduledWorklogSync.js        # Hourly cron handler
  ├─ analytics/                     # user/org/team analytics
  ├─ issue/                         # query, cache, state, session
  ├─ workAssignmentService.js       # Shared: unassigned + idle-conversion
  ├─ lifecycleService.js            # install/uninstall handlers
  └─ personalDataService.js         # GDPR export/delete

src/utils/
  ├─ remote.js                      # **CRITICAL** — all AI-server calls, org/user resolution,
  │                                   request dedup, batch dashboard API, in-memory cache
  ├─ supabase/                      # Re-exports via remote.js (deprecated direct access)
  ├─ jira.js                        # Jira REST helpers
  ├─ cache.js                       # TTL + request-scoped cache
  └─ formatters.js, validators.js
```

### 4.3 Frontend (`static/main/src/` and `static/settings/src/`)

**Main UI** — tab-based React app using `@forge/bridge` for all backend calls:

| Tab | File | Gated by |
|---|---|---|
| Dashboard | `components/tabs/DashboardTab.js` | All users |
| Time Analytics | `TimeAnalyticsTab.js` | All users |
| Unassigned Work | `components/UnassignedWork.js` | All users |
| Team Analytics | `TeamAnalyticsTab.js` | Project admin+ |
| Org Analytics | `OrgAnalyticsTab.js` | Jira admin |
| Project Settings | `ProjectSettingsTab.js` | Project admin |
| Admin User Status | `AdminUserStatusTab.js` | Jira admin |

Global state lives in `context/AppContext.js`:
- `userPermissions` — isJiraAdmin, projectAdminProjects, allProjectKeys, canCreate/EditIssues
- `activeIssues` with retry logic (5 attempts × 3s delay)
- Worklog sync fires every 5 min on a localStorage-cooldown-guarded useEffect

**Settings UI** — currently mostly informational, gated to Jira admins.

### 4.4 Notable patterns

- **Batch dashboard API** (`/api/forge/dashboard`): Replaced 8+ individual calls with a single batched request. Cache key includes sorted project keys so permissions-filtered views cache distinctly.
- **Request deduplication** (`remote.js`): `inFlightRequests` Map deduplicates concurrent `getOrCreateOrganization(cloudId)` calls, preventing duplicate org rows on cold start.
- **KVS cache was removed** for org/user lookups — recreated orgs returned stale IDs. Only in-memory (invocation-scoped) cache remains.
- **Two-step admin verification** (`getVerifiedAdminProjectKeys`): Jira's `ADMINISTER_PROJECTS` permission alone is ambiguous; the app verifies by listing projects and cross-checking with an edit-issue capability check.

### 4.5 Tests

- `tests/services/` — unit tests for worklog, reassignment, analytics, scheduled sync
- `tests/utils/remote.test.js` — retry/backoff logic for 401/429/5xx
- `tests/utils/subMinuteWorklog.test.js` — sub-minute aggregation correctness
- `tests/resolvers/convertUnassignedToWorklog.integration.test.js` — end-to-end unassigned→worklog
- `tests/playwright/` — E2E for idle-time conversion, worklog reassignment, security (owner-only mutation)

---

## 5. Component: AI Analysis Server (Node.js/Express)

Directory: `ai-server/` • ~9,944 LOC • Production: `forgesync.amzur.com` (Cloud Run, Docker)

### 5.1 Entry point (`src/index.js`, ~631 lines)

Boot sequence:
1. Express app + `helmet` (CSP), `cors` (allows no-origin for desktop clients), `express-rate-limit` (multiple tiered limiters), timeouts (request 120s, headers 15s, keepalive 5s)
2. AI clients initialized (Portkey primary, Fireworks fallback) via `src/services/ai/ai-client.js`
3. **Three background services start:**
   - Clustering polling service (groups unassigned work sessions)
   - Activity polling service (processes pending activity_records through AI)
   - Notification polling service (sends queued emails if `EMAIL_PROVIDER` set)
4. Graceful shutdown on SIGTERM/SIGINT stops all pollers.

### 5.2 Route groups

| Prefix | Auth | Rate limit | Purpose |
|---|---|---|---|
| `/` `/health` `/legal/*` | None | 30/min per IP | Public |
| `/api/auth/*` | Mixed | 30/15min per IP | OAuth callback, token exchange, Supabase config |
| `/api/feedback/*` | Atlassian OAuth / session | 10/15min | Feedback submission form |
| `/api/app-version/*` | Mixed (public GETs, API-key POSTs) | 60/15min | Desktop auto-update |
| `/api/notifications/*` | API key | — | Internal triggering |
| `/api/forge/*` | Forge FIT | 200/min per cloudId | **All Forge-app traffic** (supabase proxy, dashboard batch, storage, uninstall, etc.) |
| `/api/analyze-batch` `/api/classify-app` `/api/identify-app` | API key / Atlassian OAuth / FIT | — | AI analysis endpoints |
| `/api/admin/*` `/admin-dashboard/api/*` | API key / dashboard session | — | Admin operations |
| `/api/v1/user-data/*` | Forge FIT | — | GDPR Personal Data Reporting API |

### 5.3 Controllers

- **`activity-controller.js`** — `/analyze-batch`, `/classify-app`, `/identify-app`. Calls `activityService.analyzeBatch()` with assigned-issues context.
- **`auth-controller.js`** — OAuth code exchange, refresh, Supabase JWT minting, OCR config, diagnostic logging.
- **`forge-proxy-controller.js`** — Generic Supabase proxy (`/api/forge/supabase/query`) with filter DSL (eq/neq/gt/gte/lt/lte/in/is/not/order/limit/offset/or/single/maybeSingle). Also batch dashboard, org lifecycle, storage signed URLs, issues cache, uninstall.
- **`feedback-controller.js`** — Session-based feedback form; creates Jira issues from submissions (up to 3 images, 5MB each).
- **`admin-dashboard-controller.js`** — Password login (in-memory session Map, 8h TTL) + stats aggregation.
- **`app-version-controller.js`** — Release management for desktop auto-updater.
- **`notification-controller.js`**, **`user-data-controller.js`**, **`uninstall-controller.js`** — Specialized.

### 5.4 Services

- **`services/ai/ai-client.js`** — Dual-provider with failure demotion: Portkey (Gemini 2.0 Flash via gateway) primary, Fireworks (Qwen2.5-VL-32B) fallback. `FAILURE_THRESHOLD=2`, `COOLDOWN_MINUTES=30`, `PERMANENT_FAILURE_COOLDOWN_MINUTES=120`.
- **`services/ai/prompts.js`** — Centralized prompts: `BATCH_ANALYSIS_SYSTEM_PROMPT`, `APP_IDENTIFICATION_SYSTEM_PROMPT`, `buildBatchAnalysisPrompt`, `formatAssignedIssues` (first 20 issues, truncated descriptions).
- **`services/activity-service.js`** — `analyzeBatch()` (issue matching with anti-hallucination check) and `classifyUnknownApp()` (single-app classification with confidence).
- **`services/db/activity-db-service.js`** — `claimBatchForProcessing(ids)` does atomic UPDATE to prevent races; `updateActivityRecordAnalysis()` applies the 0.5 confidence threshold.
- **`services/clustering-service.js`** — Groups unassigned sessions. System apps (lockapp, screensaver, idle) excluded.
- **`services/notifications/notification-service.js`** — Per-user preferences, per-type cooldowns (e.g., 7-day login reminder), daily limit (default 5/day), notifme-sdk for delivery.

### 5.5 Admin dashboard (`src/dashboard/`)

- Served at `/admin-dashboard` (static HTML)
- Password login (`ADMIN_DASHBOARD_PASSWORD` env var) — single shared password, no per-user accounts
- Stats endpoint returns all orgs + per-org user stats (installed/active-now heartbeats within 10 min)

### 5.6 Test scripts (top-level, not in `tests/`)

- **`test-matching.js`** — Reproduces the exact production AI pipeline against real DB data. Use for prompt iteration. `node test-matching.js --limit 20 --status pending --user <uuid>`.
- **`test-notification.js`** — Sends all four notification types to a configured email.
- **`test-unassigned-work-integration.js`** — Creates sample sessions, tests grouping + conversion.

### 5.7 Deployment

`Dockerfile` — Node 20.18-slim, `npm ci --only=production`, builds React dashboard at container build time, `PORT=8080` for Cloud Run. Single-instance by default (background pollers assume this).

---

## 6. Component: Python Desktop App (Windows tray)

Directory: `python-desktop-app/` • Main: `desktop_app.py` (~12,569 LOC single file) • Build: PyInstaller one-file `.exe`

### 6.1 Launch sequence

`launch.py` / `launch.bat` / `launch.ps1` → dependency check (`ocr.auto_installer`) → run `desktop_app.py`.

`desktop_app.py` main (line 12556) → `TimeTracker().run()` (line 10415):
1. **Single-instance lock** (system-wide mutex).
2. **Self-install**: copies exe to `%LOCALAPPDATA%\TimeTracker\`, registers Windows startup entry.
3. **Network probe**: Atlassian + Supabase + Google DNS → online/offline decision.
4. **Auth check**: validates cached tokens; opens browser for OAuth if missing.
5. **Consent check**: GDPR screenshot-capture consent required.
6. **Tracking loop** (`tracking_loop`, line 9270) runs on a daemon thread.
7. **Local Flask web server** on port 51777 for OAuth callback + local dashboard.

### 6.2 Tracking loop

- **Interval mode**: fixed 5-min clock ticks (not "5 min since last capture").
- **Event-based mode** (optional): also captures on window switch.
- **Idle detection**: configurable threshold (default 5 min) stops capture.
- **Sleep/wake detection**: 30s+ gap → finalize session so sleep doesn't count as work.
- **Pause**: fixed or open-ended; tray icon reflects state.
- **Settings refresh** every 5 min from `tracking_settings` / `project_settings`.
- **Classification sync** every 30 min from `application_classifications`.

### 6.3 Auth (`auth/` + `AtlassianAuthManager` in `desktop_app.py:1424`)

**OAuth PKCE flow** (lines 1561–1597):
- State: 32-byte URL-safe random (CSRF).
- Code verifier: 64-byte URL-safe random (stored encrypted).
- Code challenge: `BASE64URL(SHA256(verifier))`.
- Scopes: `read:me read:jira-work write:jira-work offline_access`.
- **Code exchange happens via AI server, NOT direct to Atlassian** — keeps client_secret server-side.

**Token storage (`auth/secure_storage.py`)**:
- Preferred: Windows Credential Manager (keyring).
- Fallback: AES-128-CBC + PBKDF2 (600K iterations), machine-derived key.
- Plaintext is never written to disk.
- **Token chunking** for Windows Credential Manager's 2560-byte limit: `__b64_chunked__:` marker.
- Automatic migration from legacy plaintext JSON on first load.

**Token refresh** (lines 1736–1900):
- Thread-safe lock prevents burning the refresh_token (Atlassian rotates on every refresh).
- Double-check pattern inside the lock (another thread may have already refreshed).
- Grace period: 5+ failures in 10 min → 30-min backoff, auto-recovers.

### 6.4 OCR subsystem (`ocr/`)

Facade pattern:
```
OCRFacade (facade.py)
     └─ EngineFactory (engine_factory.py)
           ├─ RapidOCR (primary)       — PaddleOCR PP-OCRv4 ONNX
           ├─ WinRT OCR (fallback)     — Windows built-in (Win10+)
           ├─ EasyOCR (optional)       — slower, higher accuracy
           ├─ DemoEngine (testing)
           └─ Dynamic engines          — env-configurable package loading
```

- Each engine subclasses `BaseOCREngine` (`ocr/base_engine.py`): `is_available()`, `extract_text()`, `_preprocess_image()`.
- **Instability backoff**: repeated failures disable an engine for 120s.
- **Tabular enricher** (`ocr/tabular_enricher.py`) elevates PII confidence in structured/spreadsheet contexts.

### 6.5 Privacy / PII (`privacy/`)

`PrivacyFilter` (`privacy/filter.py`) coordinates three detectors:
1. **Custom regex** (passwords, API keys, connection strings, bearer tokens, encryption keys) — always on.
2. **Microsoft Presidio** — credit cards, SSNs, emails, phones, driver licenses, passports, IBAN, crypto, etc.
3. **detect-secrets** — disabled by default (too many false positives).

**App-specific elevation** (`privacy/config.py`):
- Excel/Calc: confidence → 0.5, extra SSN/CC patterns.
- Notepad(++): confidence → 0.6, key=value patterns.
- VS Code: confidence → 0.6.

Redaction strategies: `MASK` (asterisks), `ENTITY_TYPE` (`[PASSWORD]`), `HASH` (short), `REMOVE`.

Performance: skip texts <10 chars, truncate >50KB.

### 6.6 Offline storage (`db_connection.py` + `OfflineManager` in `desktop_app.py:2229`)

- **SQLCipher** encrypting SQLite at page level (AES-256).
- Encryption key: keyring first, PBKDF2 machine-derived fallback.
- Per-thread connection pooling via `threading.local()`.
- WAL mode for concurrent readers.
- Location: `%LOCALAPPDATA%\TimeTracker\time_tracker_offline.db`.
- Schema (`create_sqlite_tables.sql`):
  - `active_sessions` — real-time between batch uploads
  - `offline_screenshots` — image blobs + thumbnails + sync status
  - `app_classifications_cache`
  - `project_settings_cache`
- `sync_all()` iterates pending records, uploads to Supabase Storage + inserts screenshot/activity rows, marks synced.

### 6.7 Build (`desktop_app.spec` + `build.bat`)

PyInstaller one-file exe. The spec **reads `.env` at build time** to decide which OCR engines to bundle (excludes torch/torchvision if EasyOCR not used). Hidden imports auto-resolved per engine.

### 6.8 Hardcoded public config (`config_manager.py`)

Public values (Supabase URL, anon key, AI server URL, Atlassian client ID) are compiled into the exe — safe because they're public anyway. User-specific config in `%LOCALAPPDATA%\JIRAForge\config.json`.

### 6.9 The `2.6.0/` and `2.8.1/` folders

Empty marker directories — likely release version tags or artifacts from a packaging script. Real version lives inside `desktop_app.py` and on `app_releases` table.

---

## 7. Component: Supabase Backend

Directory: `supabase/` • Postgres 15 • Deno Edge Functions

### 7.1 `config.toml`

Local dev: API 54321, DB 54322, Studio 54323, Inbucket 54324. Storage limit 50MB. JWT expiry 3600s.

**Critical flag:** `verify_jwt = false` on `screenshot-webhook` and `activity-webhook`. Safe because these are fired only by DB triggers, but if any of them ever becomes externally callable, this needs to change.

### 7.2 Migration history (~50 files)

Phased evolution, summarized by era:

**Foundation (pre-2026-02)** — Users, organizations, org_members (RBAC with 5 roles + granular `can_*` flags), screenshots, analysis_results, documents, worklogs, OCR test table.

**Feb 2026 — Feature expansion:**
- `20260125_add_desktop_app_status.sql` — heartbeats/presence
- `20260130_add_timezone_support.sql` — `work_date` + auto-compute trigger
- `20260203_add_app_releases.sql` — desktop version management
- `20260204_add_project_settings.sql` — per-project tracked_statuses with RBAC RLS
- `20260206_add_feedback.sql` — feedback + private storage bucket (5MB)
- `20260208_add_worklog_sync.sql` — sync mapping + enable flag on tracking_settings
- `20260220/0226_add_application_classifications.sql` — app → productive/non_productive/private/unknown mappings (seeded)
- `20260221_add_activity_records.sql` — **NEW CORE TABLE** (lightweight, window/app-level, replacing screenshot-first model)
- `20260225_add_notification_tracking.sql` — logs + preferences + cooldowns

**Feb 2026 — RLS hardening:**
- `20260211_fix_rls_performance.sql` — removes redundant `service_role` policies (service role bypasses RLS anyway → `multiple_permissive_policies` warning resolved); wraps `auth.jwt()` calls in subselects for once-per-query eval
- `20260211_fix_security_definer_views.sql` — all views → SECURITY INVOKER
- `20260212_fix_function_search_paths.sql` — sets explicit `search_path` on SECURITY DEFINER functions

**Mar 2026 — Idle time + admin dashboard:**
- `20260325_add_idle_time_support.sql` — adds `is_idle`, `idle_start_time`, `idle_end_time`, `reclassified_from`, `converted_issue_key`, `worklog_id` to activity_records
- `20260326_add_work_hours_to_tracking_settings.sql`
- `20260327_add_worklog_reassignment.sql`
- `20260330_create_admin_dashboard_tables.sql` — 4 aggregation tables + `dashboard_tickets_summary` view

**Apr 2026 — Auth model switch + cleanup:**
- `20260401_drop_supabase_user_id_fk_and_backfill.sql` — **MAJOR**. Drops FK `users.supabase_user_id → auth.users(id)`. Now `supabase_user_id = users.id` (self-reference). Desktop app switches from service-role to anon key + custom JWT (minted by AI server with `sub = users.id`). RLS becomes the real security boundary.
- `20260401_fix_feedback_rls_for_custom_jwt.sql` — feedback policy uses `(select auth.jwt() ->> 'sub')` to match new JWT shape
- `20260402_fix_user_has_permission_ambiguous_variable.sql` — PL/pgSQL var name collision with column name (only surfaced once RLS started being enforced)
- `20260413_fix_idle_classification_constraint.sql` — relaxes `ocr_method` CHECK to accept dynamic engine names
- `20260414_fix_garbage_project_keys.sql` — data-quality cleanup
- `20260417_exclude_idle_from_summaries.sql` — **IMPORTANT**: daily/weekly/monthly summary views now filter `is_idle = false` AND app NOT IN ('lockapp.exe', 'logonui.exe'). LockApp time was inflating "Time Today".
- `20260417_add_unassigned_conversion_columns.sql`

### 7.3 Edge functions

| Function | Trigger | Auth | Calls | Writes |
|---|---|---|---|---|
| `screenshot-webhook` | INSERT on `screenshots` (pending) | `verify_jwt=false` (internal only) | `AI_SERVER_URL/api/analyze-screenshot` | On permanent 4xx → `screenshots.status='failed'` |
| `activity-webhook` | INSERT on `activity_records` (FOR EACH STATEMENT — batch) | `verify_jwt=false` | `AI_SERVER_URL/api/analyze-batch` (one call per batch) | On permanent error → batch update to 'failed' |
| `document-webhook` | INSERT on `documents` (uploaded) | `verify_jwt=false` | `AI_SERVER_URL/process-brd` | `documents.processing_status` transitions |
| `update-issues-cache` | Manual/cron (currently placeholder) | — | — | — |

Both webhooks prefer **embedded fresh issues** in the record payload, fall back to `user_jira_issues_cache`. Neither transitions status to 'processing' — that's an atomic `claimBatchForProcessing` on the AI server to avoid races.

### 7.4 The issues cache problem

Forge apps can't be invoked via HTTP from outside Atlassian, so `update-issues-cache` has no clean trigger path. Current workaround: the Forge `issue-cache-trigger` fires on `avi:jira:updated:issue` and POSTs to the AI server, which writes to the cache table. `update-issues-cache` itself is effectively a stub with TODO-style logs.

---

## 8. Authentication & Security Deep Dive

### 8.1 The four AI-server middleware layers

**1. API key (`src/middleware/auth.js`, ~60 LOC)**
- Bearer token compared against `AI_SERVER_API_KEY` env var.
- Guards admin + internal endpoints (`/api/trigger-clustering`, `/api/admin/*`, release-management POSTs, `/api/analyze-batch`).
- Simple shared secret. No rotation. Relies on TLS + env-var secrecy.

**2. Forge Invocation Token — FIT (`src/middleware/forge-auth.js`, ~269 LOC)** ⭐
- Used by every `/api/forge/*` route.
- Bearer JWT from Forge SDK's `invokeRemote()`.
- Verification with `jose.jwtVerify()` against Atlassian's JWKS endpoint (`createRemoteJWKSet` caches keys).
- **Audience matching** is defensive: `FORGE_APP_ID` can be comma-separated, handles both full ARI and UUID-only formats, also tries the token's own `aud` claims if the configured list doesn't match.
- Required claims: `iss=forge/invocation-token`, audience ∈ configured set.
- Extracts: `cloudId`, `accountId`, `appId`, `installationId`, `environment` → `req.forgeContext`.
- Error handling differentiates expired/invalid-signature/audience-mismatch.

**3. Atlassian OAuth (`src/middleware/atlassian-auth.js`, ~74 LOC)**
- Used for desktop-app endpoints like `/api/classify-app`.
- Validates Bearer access_token by calling `https://api.atlassian.com/me`.
- Network-dependent: every request to these endpoints hits Atlassian's API. No caching currently.
- 10s timeout, 1MB max response.

**4. Dashboard session (`src/middleware/dashboard-auth.js`, ~137 LOC)**
- Not mounted as middleware; called from the admin dashboard controller.
- Three-step chain: Atlassian `/me` → `/oauth/token/accessible-resources` → per-cloud `/rest/api/3/mypermissions?permissions=ADMINISTER`.
- Also ties to `organizations` row (404 if org not yet installed).

### 8.2 Rate limiting

Tiered `express-rate-limit`:
- Public: 30/min per IP
- Auth: 30/15min per IP (stricter — brute-force defense)
- Feedback: 10/15min per IP
- Version check: 60/15min per IP
- **Forge: 200/min per cloudId** (tenant-aware, not just per-IP — critical because one tenant could have thousands of users behind a single egress IP)
- General: 100/15min per IP

### 8.3 Desktop app OAuth (PKCE)

- Client type: **public** (desktop); no client_secret on device.
- Redirect URI: `http://localhost:51777/callback` (local Flask server).
- Browser opens Atlassian authorize URL → user consents → browser redirects to local server → local server receives code + state.
- State verified against stored state to defend against CSRF.
- **Code exchange routes through the AI server** — so the server's `ATLASSIAN_CLIENT_SECRET` is applied and returned tokens come with a freshly-minted Supabase JWT (`sub = users.id`).

### 8.4 Supabase RLS model (post-`20260401`)

- Anon key + custom JWT from AI server.
- `get_current_user_id()` SQL function: `SELECT id FROM users WHERE supabase_user_id = auth.uid()`. After backfill, `supabase_user_id = id`, so this is effectively `auth.uid()`.
- `get_current_user_organization_id()` joins via `organization_members`.
- `user_has_permission(permission)` checks RBAC in `organization_members` (roles: owner/admin/manager/member; granular `can_*` columns).
- **Service role key** (held only by AI server) bypasses RLS entirely — used for admin queries, cross-tenant analytics, cleanup jobs.
- **`activity_records` has two SELECT policies** OR'd together:
  - Own rows: `user_id = get_current_user_id()`
  - Org-visible rows: `organization_id IN (select org from org_members where user_id = current user)` (team analytics).

### 8.5 Secrets & trust boundaries (what lives where)

| Secret | Desktop | Forge | AI Server | Supabase |
|---|---|---|---|---|
| Atlassian client_id | ✅ (public) | — | ✅ | — |
| Atlassian client_secret | ❌ | ❌ | ✅ | ❌ |
| Supabase URL | ✅ (public) | ❌ (proxied) | ✅ | — |
| Supabase anon key | ✅ | ❌ | ✅ | — |
| Supabase service_role key | ❌ | ❌ | ✅ | — |
| Supabase JWT secret (mint) | ❌ | ❌ | ✅ | — |
| OpenAI / Portkey / Fireworks keys | ❌ | ❌ | ✅ | — |
| `AI_SERVER_API_KEY` | ✅ | ❌ | ✅ | — |
| `ADMIN_DASHBOARD_PASSWORD` | ❌ | ❌ | ✅ | — |
| User access/refresh tokens | ✅ (keyring) | ❌ | — | — |

---

## 9. Database Schema Reference

Current table landscape. "RLS" = explicit policies exist; "Implicit" = inherits from joined table.

| Table | Purpose | Multi-tenant | RLS | Primary writers | Primary readers |
|---|---|---|---|---|---|
| `organizations` | Tenants (1 per Jira cloud install) | is-a-tenant | Via `organization_members` | Forge lifecycle | Forge, AI server |
| `users` | User accounts | `organization_id` FK | Via members | AI server (OAuth callback), Forge | All |
| `organization_members` | RBAC (role + can_* flags) | `organization_id` | ✅ | Forge, AI server | All auth checks |
| `screenshots` | Legacy screenshot + metadata | `organization_id` | ✅ (own + org admin) | Desktop app | Desktop, Forge, AI |
| `activity_records` | **New** lightweight per-window records | `organization_id` | ✅ dual (own + org) | Desktop app | Desktop, Forge, AI |
| `analysis_results` | AI output for screenshots (legacy) | `organization_id` | Implicit | AI server | Forge (analytics), views |
| `documents` | BRD file processing | `organization_id` | Implicit | Desktop | Forge, AI |
| `worklogs` | Jira worklog records | `organization_id` | Implicit | AI server, desktop | Forge, desktop |
| `worklog_sync` | Pending sync queue (one per user+issue) | `organization_id` | ✅ service-role only | Forge scheduled sync, AI | AI server |
| `tracking_settings` | Desktop capture + sync config | `organization_id` | Implicit | Forge admin, desktop | Desktop, Forge |
| `project_settings` | Per-project tracked_statuses etc. | `organization_id` | ✅ (admins) | Forge admin | Forge, desktop |
| `user_jira_issues_cache` | Cached assigned issues per user | `organization_id` | Implicit | Forge `issue-cache-trigger` | Edge functions, desktop |
| `application_classifications` | App → productive/private/etc. (with org-specific overrides) | optional `organization_id` | Implicit | Seed script, Forge admin | Desktop, activity-webhook |
| `feedback` | Bug/feature submissions | — | ✅ (user owns own via atlassian_account_id in JWT) | Desktop, AI | Forge, AI |
| `notification_logs` / `notification_preferences` / `notification_cooldowns` | Email system | `organization_id` | ✅ (org members) | Desktop, AI | AI server |
| `unassigned_activity` / `unassigned_work_groups` / `unassigned_group_members` | Manual assignment UX | `organization_id` | Implicit | Desktop, Forge | Forge |
| `created_issues_log` | Issues created from BRD | `organization_id` | Implicit | AI | Forge |
| `app_releases` | Desktop version management | global | ✅ (public read) | Forge admin / script | Desktop |
| `dashboard_header_metrics` / `dashboard_organizations` / `dashboard_tickets_per_team` / `dashboard_ticket_status` | Admin reporting | aggregated | ✅ service-role only | Admin scripts | Admin UI |
| `ocr_test_results` | Test harness (legacy) | `organization_id` | ✅ (own) | Test harness | Test harness |

### Summary views

- `daily_time_summary`, `weekly_time_summary`, `monthly_time_summary` — UNION across legacy screenshots + new activity_records; SECURITY INVOKER; **filter out idle + lockscreen/logon** as of `20260417`; use `work_date` (not UTC-derived) to respect timezones.
- `dashboard_tickets_summary` — calculated percentages over dashboard admin tables.

---

## 10. Triggers, Schedules & Background Jobs

| Where | Trigger | Cadence | What it does |
|---|---|---|---|
| Forge manifest | `worklog-sync-trigger` | Hourly (`:00`) | Build worklogs from `activity_records`, create `worklog_sync` rows, attempt `asUser` impersonation |
| Forge manifest | `issue-cache-trigger` | `avi:jira:updated:issue` | Refresh `user_jira_issues_cache` for affected users |
| Forge manifest | `app-installed-trigger` / `app-uninstalled-trigger` | Lifecycle events | Org create / mark pending_deletion |
| Forge manifest | Personal data handler | Atlassian polling | GDPR PENDING → COMPLETED |
| Forge React app | `useEffect` | Every 5 min (localStorage cooldown) | `invoke('syncMyWorklogs')` to pick up pending worklog_sync rows |
| AI server | Clustering polling service | Configurable (optional daily) | Group unassigned sessions via AI |
| AI server | Activity polling service | Continuous | Process `activity_records` where status='pending' (belt-and-suspenders alongside webhooks) |
| AI server | Notification polling service | Continuous | Send queued emails (cooldowns + prefs + daily caps) |
| AI server | `/api/admin/process-deletions` | Manual / external cron | Hard-delete orgs past 30-day grace |
| Supabase | `activity-webhook` + `screenshot-webhook` + `document-webhook` | DB INSERT | Call AI server for analysis |
| Supabase | `compute_work_date()` trigger | BEFORE INSERT on screenshots/activity_records | Auto-fill `work_date` using user TZ |
| Supabase | `app_releases` latest-flag trigger | INSERT on `app_releases` | Auto-mark older versions as non-latest |
| Desktop app | Capture timer | Every 5 min (configurable), fixed clock | Capture + OCR + redact + upload |
| Desktop app | Settings refresh | Every 5 min | Re-fetch tracking_settings/project_settings |
| Desktop app | Classification sync | Every 30 min | Pull latest `application_classifications` for known projects |
| Desktop app | Offline-sync loop | On reconnect | Flush encrypted local SQLite to Supabase |

---

## 11. Risks, Gotchas & Fragile Areas

Collected from all four deep dives. Rated 🔴 high / 🟡 medium / 🟢 low.

### Security & auth
- 🔴 **In-memory admin dashboard sessions** (`admin-dashboard-controller.js`). Lost on restart, not distributed. Breaks if Cloud Run scales >1 instance.
- 🔴 **Atlassian `/me` call on every `/api/classify-app`** request (`atlassian-auth.js`). Hangs the desktop app if Atlassian is slow. Needs short-lived cache.
- 🟡 **Forge proxy has no table whitelist.** `SENSITIVE_TABLES` only warns in logs. Forge app is Atlassian-signed (trusted) but defense-in-depth would help.
- 🟡 **Dashboard auth never caches** permission lookups — every stats refresh triggers a full `/me` + `/accessible-resources` + `/mypermissions` chain.
- 🟡 **CORS allows no-origin** (desktop app + server-to-server). Intentional but undocumented; consider logging.
- 🟡 **Log sanitizer is regex-based** — can miss emails inside URL query strings.
- 🟢 **Screenshot dedup uses MD5.** Collision risk is low for user screenshots but migrate to SHA-256 at some point.

### Token lifecycle
- 🟡 **Refresh grace-period can mask persistent revocation** (30-min auto-clear in `AtlassianAuthManager`). Monitor refresh-fail metrics.
- 🟡 **Keyring-unavailable fallback** silently uses in-memory tokens if encrypted file also fails. Verify `SecureTokenStorage.fail_open` behavior matches threat model.

### Data correctness
- 🔴 **Dual read against `screenshots` + `activity_records`** in `issueQueryService`. Must ensure neither double-counts.
- 🟡 **Confidence threshold <0.5 → NULL issue key** means marginal matches become unassigned work, not "suggested". Consider a suggested-low-confidence tier.
- 🟡 **No worklog attribution fallback.** `scheduledWorklogSync` only tries `asUser`; on failure the sync row is left with NULL `jira_worklog_id` waiting for user-context pickup. If the user never reopens the app, work never syncs to Jira.
- 🟡 **Idle-to-worklog conversion** writes `reclassified_from`, `converted_issue_key`, `worklog_id` but atomicity is enforced in UI logic; any partial failure could create duplicate worklogs.

### Operational
- 🔴 **Offline SQLite has no size cap.** Long offline periods could exhaust disk; add rotation/cleanup.
- 🟡 **KVS cache can't be enumerated** → lifecycleService manually deletes known key patterns. Rename a key → stale entries leak forever until TTL.
- 🟡 **Clustering/activity pollers lack exponential backoff** on AI errors → provider hammer on outage.
- 🟡 **`update-issues-cache` edge function is a placeholder.** The actual refresh is driven by Forge's `avi:jira:updated:issue` trigger — if that ever breaks, cache goes stale without alarm.
- 🟢 **Feedback form relies on browser session** — if the session cookie doesn't ride along with the form URL, users see "session not found".

### Architecture
- 🟡 **Single-instance background services.** Multi-instance Cloud Run would double-process. Either keep min/max=1 or add distributed locks / move to a queue (BullMQ / Supabase functions cron).
- 🟡 **Webhook `verify_jwt=false`** is safe today (DB-trigger only) but easily forgotten if any function is re-exposed externally.
- 🟡 **Custom JWT model switch (20260401)** means any lingering code paths that still assumed `auth.users` tie-in are now broken; `20260402` revealed one such case. Audit for more.

---

## 12. Onboarding Quickstart — File-by-File Read Order

If you're new to the codebase, read these in order.

### Start here (cross-component context)
1. `CLAUDE.md` — 2-minute architecture snapshot.
2. `docs/01_ARCHITECTURE.md` + `docs/SYSTEM_ARCHITECTURE_DIAGRAMS.md` — visuals.
3. `docs/MULTI_TENANCY_DATABASE_ARCHITECTURE.md` — mental model for RLS + org_id.
4. `docs/OAUTH_FLOW_CORRECTED.md` + `docs/PKCE_IMPLEMENTATION.md` — auth model.

### Forge app
5. `forge-app/manifest.yml` — modules, triggers, remotes.
6. `forge-app/src/index.js` — resolver registrations and handler exports.
7. `forge-app/src/utils/remote.js` — the AI-server gateway. Everything flows through here.
8. `forge-app/src/services/worklogService.js` + `scheduledWorklogSync.js` — the core sync engine.
9. `forge-app/static/main/src/context/AppContext.js` + `App.js` — React shell.
10. `forge-app/src/services/workAssignmentService.js` — shared unassigned/idle conversion logic.

### AI server
11. `ai-server/src/index.js` — entry, route wiring, rate limits, startup sequence.
12. `ai-server/src/middleware/forge-auth.js` — FIT validation (complex, well-commented).
13. `ai-server/src/controllers/forge-proxy-controller.js` — Supabase proxy + filter DSL.
14. `ai-server/src/services/ai/ai-client.js` — Portkey/Fireworks with demotion.
15. `ai-server/src/services/activity-service.js` + `src/services/ai/prompts.js` — classification pipeline.
16. `ai-server/src/controllers/auth-controller.js` — desktop OAuth callback.
17. `ai-server/test-matching.js` — production-equivalent AI test harness. Run this before iterating on prompts.

### Desktop app
18. `python-desktop-app/desktop_app.py` around lines 12556 (`main`), 10415 (`TimeTracker.run()`), 9270 (`tracking_loop`), 1424 (`AtlassianAuthManager`), 2229 (`OfflineManager`), 3748 (`ActiveSessionManager`).
19. `python-desktop-app/auth/secure_storage.py` — token storage architecture.
20. `python-desktop-app/ocr/facade.py` + `engine_factory.py` — OCR engine system.
21. `python-desktop-app/privacy/filter.py` + `privacy/config.py` — PII redaction.
22. `python-desktop-app/db_connection.py` — SQLCipher offline DB.
23. `python-desktop-app/desktop_app.spec` + `build.bat` — how the exe is built.

### Supabase
24. `supabase/config.toml` — ports + `verify_jwt` flags.
25. `supabase/migrations/20260221_add_activity_records.sql` — the new core table + RLS.
26. `supabase/migrations/20260401_drop_supabase_user_id_fk_and_backfill.sql` — the auth-model switch.
27. `supabase/migrations/20260211_fix_rls_performance.sql` — RLS cost model.
28. `supabase/migrations/20260417_exclude_idle_from_summaries.sql` — how summary views work today.
29. `supabase/functions/activity-webhook/index.ts` — batch invocation of the AI server.
30. `supabase/functions/screenshot-webhook/index.ts` — single-record path.

---

_End of reference. When the architecture shifts, update this doc (or regenerate from a fresh deep-dive)._
