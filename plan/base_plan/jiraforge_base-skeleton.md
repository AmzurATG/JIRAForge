# plan.base-skeleton.md — JIRAForge (BRD Time Tracker)

## 1. Scope & goals

### 1.1 Feature overview

This plan defines the **base skeleton** for the JIRAForge (BRD Time Tracker) codebase. It documents the monorepo structure, the authoritative physical layout of all four components, core wiring patterns, and conventions that all future feature-level plans must follow.

It provides the foundation on which all enhancement plans (approval workflows, AI accuracy tracking, RBAC, worklog reassignment, notification improvements, etc.) must be built.

### 1.2 In scope

- Monorepo layout and top-level directories.
- `forge-app/` — Atlassian Forge app (Node.js 22, React) with all resolver, service, and utility modules.
- `ai-server/` — Express.js AI analysis server with all controller, service, middleware, and utility modules.
- `python-desktop-app/` — Python 3.9+ desktop tray application with OCR, privacy, and auth modules.
- `supabase/` — PostgreSQL database with RLS migrations and Deno Edge Functions.
- Shared conventions: authentication layers, multi-tenancy patterns, logging, test structure.
- CI/CD pipeline shape (GitHub Actions + SonarCloud).

### 1.3 Out of scope

- Detailed domain logic for individual features. Each feature is defined in its own `plan/<date>_<component>_<feature>.md` file.
- UI design specifics for the React frontends (defined in per-feature plans).
- Infrastructure provisioning (no Terraform or Kubernetes — deployed on Atlassian Forge + cloud VMs).
- Third-party provider credentials and account configuration.

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- Tech stack (definitive):
  - **Forge app**: Node.js 22 (`nodejs22.x` runtime), Atlassian Forge platform, React (`react-scripts`), `@forge/api`, `@forge/resolver`, `@forge/kvs`.
  - **AI server**: Node.js 20+, Express 4, Winston logging, OpenAI SDK (`openai` 4.x), Supabase JS client, `notifme-sdk` for email notifications.
  - **Desktop app**: Python 3.9+, `flask`, `supabase-py`, `pystray`, `psutil`, `keyring`, `cryptography`, `sqlcipher3-wheels` (Windows encrypted SQLite).
  - **OCR**: RapidOCR (primary, ONNX-based PaddleOCR) + WinRT OCR (Windows fallback), facade pattern.
  - **Privacy**: Microsoft Presidio (`presidio-analyzer`, `presidio-anonymizer`) for PII detection/redaction.
  - **Database**: PostgreSQL 15 via Supabase (hosted), with Row Level Security (RLS) on every table keyed by `org_id`.
  - **Edge Functions**: Deno runtime, Supabase Edge Functions.
  - **Testing**: Jest (forge-app + ai-server), pytest (python-desktop-app), Deno.test (supabase functions).
- Production AI server URL: `https://forgesync.amzur.com`
- Four environments: local (Docker Compose for Supabase), DEV (Forge dev environment), QA/UAT, Production.
- Existing codebase is the reference implementation; this plan documents it as the canonical skeleton going forward.

### 2.2 Dependencies

- `docs/01_ARCHITECTURE.md` — system architecture overview.
- `docs/AI_ANALYSIS_FLOW.md` — AI analysis data flow.
- `docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md` — issue matching constraints.
- `.github/copilot-instructions.md` — repository-wide Copilot and development conventions.
- `CLAUDE.md` — component build and run commands.

---

## 3. UI layouts

JIRAForge has two React apps embedded in the Forge platform:

### 3.1 Main UI (`static/main/`)

Served on the Jira project page and issue panel. Tabs:
- **Time Analytics** — personal time summaries (daily/weekly, by issue, by project).
- **Team Analytics** — org-wide activity visible to managers/admins.
- **Org Analytics** — cross-project organisation analytics.
- **Dashboard** — summary landing tab.
- **Unassigned Work** — AI-clustered activity not linked to Jira issues; group accordion, assignment modal, bulk edit, fullscreen viewer.
- **Project Settings** — per-project tracking configuration.
- **Admin User Status** — admin view of user desktop app state.
- **Admin Accuracy Dashboard** — AI matching accuracy metrics (admin-only).
- **Issue Panel** — embedded in Jira issue sidebar; shows time on current issue.

### 3.2 Settings UI (`static/settings/`)

Single-page admin settings (Jira admin page). Configures AI server connection and global tracking defaults.

---

## 4. File and function names (physical structure)

### 4.1 Forge app (`forge-app/`)

> All forge-app → ai-server HTTP calls must go through `src/utils/remote.js` via the Forge Remote declared in `manifest.yml`. Never use `fetch()` or `axios` directly in forge-app backend code to call the AI server.

```text
forge-app/
  manifest.yml                      # Forge app manifest — modules, remotes, permissions, triggers
  babel.config.js
  package.json
  src/
    index.js                        # Entry point — registers all resolvers, exports Forge handlers
    config/
      constants.js                  # App-wide constants: JQL strings, cache TTLs, default settings
    resolvers/
      analyticsResolvers.js         # Time analytics resolver registrations
      worklogResolvers.js           # Worklog CRUD and sync resolver registrations
      settingsResolvers.js          # Admin settings resolver registrations
      issueResolvers.js             # Jira issue resolver registrations
      permissionsResolvers.js       # RBAC / permission check resolver registrations
      userResolvers.js              # User profile and org membership resolver registrations
      unassignedWorkResolvers.js    # Unassigned work top-level resolver registrations
      diagnosticResolvers.js        # Diagnostic/health resolver registrations
      feedbackResolvers.js          # User feedback resolver registrations
      classificationResolvers.js    # App classification management resolver registrations
      adminUserStatusResolvers.js   # Admin user status resolver registrations
      accuracyDashboardResolvers.js # AI accuracy dashboard resolver registrations (admin-gated)
      approval/
        approvalResolvers.js        # Worklog approval workflow resolver registrations
      unassigned/
        index.js                    # Aggregates all unassigned-work resolver registrations
        adminResolvers.js           # Unassigned work admin actions
        assignmentResolvers.js      # Assign unassigned sessions to Jira issues
        notificationResolvers.js    # Unassigned work notification preferences
        projectResolvers.js         # Project-scoped unassigned work view
        sessionResolvers.js         # Individual session management
        helpers.js                  # Shared helpers used across unassigned resolvers
    services/
      analyticsService.js           # Personal analytics business logic
      classificationService.js      # App classification logic
      issueCacheService.js          # Handles avi:jira:updated:issue trigger
      issueService.js               # Jira issue fetch and manipulation
      lifecycleService.js           # App install/uninstall lifecycle hooks
      personalDataService.js        # GDPR personal data request handler
      projectSettingsService.js     # Per-project tracking settings management
      scheduledWorklogSync.js       # Hourly scheduled worklog sync to Jira
      settingsService.js            # Global admin settings persistence (Forge KVS)
      userService.js                # User identity and org membership resolution
      workAssignmentService.js      # Assign unassigned activity to Jira issues
      worklogReassignmentService.js # Reassign existing worklogs between issues
      worklogService.js             # Create, read, and manage Jira worklogs
      accuracy/
        accuracyTracking.js         # AI accuracy aggregation and tracking
      analytics/
        index.js                    # Analytics service aggregator
        analyticsUtils.js           # Shared analytics helper functions
        orgAnalyticsService.js      # Organisation-level analytics
        teamAnalyticsService.js     # Team analytics (managers/admins)
        userAnalyticsService.js     # Per-user analytics
      issue/
        index.js                    # Issue service aggregator
        issueCacheService.js        # Issue cache query logic
        issueQueryService.js        # JQL-based Jira issue querying
        issueStateService.js        # Issue state transition handling
        sessionService.js           # Session-to-issue linking
    utils/
      adfToText.js                  # Convert Atlassian Document Format to plain text
      cache.js                      # In-memory + Forge KVS cache abstraction
      formatters.js                 # Date/time and display formatting helpers
      jira.js                       # Jira REST API wrapper (admin check, permissions, worklog)
      remote.js                     # Forge Remote proxy — all AI server calls go here
      validators.js                 # Input validation helpers
      supabase/
        config.js                   # Supabase client configuration
        index.js                    # Supabase utility aggregator
        organizations.js            # Get/create org by jira_cloud_id
        storage.js                  # Signed URL and storage helpers
        users.js                    # Get/create user by atlassian_account_id
  static/
    main/                           # Project page + issue panel React app
      src/
        index.js
        App.js
        App.css
        context/                    # React context providers
        shared/                     # Shared components used across tabs
        utils/                      # Frontend utility functions
        components/
          common/                   # Shared UI components (buttons, cards, loaders)
          issue-panel/              # Issue panel specific components
          modals/                   # Modal dialogs
          UnassignedWork.js         # Unassigned work container
          UnassignedWork.css
          tabs/
            DashboardTab.js
            TimeAnalyticsTab.js
            TeamAnalyticsTab.js
            OrgAnalyticsTab.js
            ProjectSettingsTab.js
            AdminUserStatusTab.js
            AdminAccuracyDashboardTab.js
            index.js
            time-analytics/         # Sub-components for time analytics
            org-analytics/          # Sub-components for org analytics
          unassigned/
            GroupAccordion.js       # Collapsible group display
            AssignmentModal.js      # Assign session to issue modal
            BulkEditModal.js        # Bulk action modal
            FullscreenViewer.js     # Screenshot fullscreen view
            SelectionBar.js         # Multi-select action bar
            index.js
    settings/                       # Admin settings React app
      src/
        index.js
        App.js
        App.css
  tests/
    resolvers/
      analytics-resolver.test.js
      approvalResolvers.test.js
      convertUnassignedToWorklog.integration.test.js  # integration, excluded from CI by default
    services/
      issueCacheJql.test.js
      issueQueryService.test.js
      scheduledWorklogSync.test.js
      userAnalyticsVisibility.test.js
      workAssignmentService.test.js
      worklogAuthorVerification.test.js
      worklogReassignmentService.test.js
      worklogService.test.js
      worklogSplit.test.js
    utils/
      adfToText.test.js
      remote.test.js
      subMinuteWorklog.test.js
    fixtures/                       # Shared test fixtures
    e2e/                            # End-to-end tests (excluded from unit CI run)
    playwright/                     # Playwright browser tests (excluded from unit CI run)
```

Key entry-point responsibilities:

- `src/index.js`
  - Creates `Resolver` instance.
  - Calls every `register*Resolvers(resolver)` function to register all RPC handlers.
  - Exports `handler` (Forge resolver), `scheduledWorklogSyncHandler` (hourly trigger), `issueCacheSyncHandler` (issue update trigger), `lifecycleHandler` (install/uninstall), `personalDataHandler` (GDPR).

- `src/utils/remote.js`
  - All forge-app → ai-server communication proxied here.
  - Manages `org_id` and `user_id` persistence via Forge KVS cache (24 h TTL).
  - `syncCacheFromBatchResponse()` keeps local cache consistent with AI server authoritative IDs.

- `src/config/constants.js`
  - `DEFAULT_SETTINGS`, `DEFAULT_TRACKING_SETTINGS` — baseline values for Forge KVS.
  - Cache TTL constants referenced throughout the app.

### 4.2 AI server (`ai-server/`)

> `'use strict'` at the top of every CommonJS module. No `console.log` in production code — use `logger.info/warn/error`.

```text
ai-server/
  .env.example                      # Required env var template
  Dockerfile
  package.json
  src/
    index.js                        # Express app bootstrap, route registration, polling startup
    config/                         # (extend as needed for centralised config)
    controllers/
      activity-controller.js        # POST /activity — desktop app activity upload
      analytics-controller.js       # GET /analytics — aggregated analytics (forge-gated)
      accuracy-dashboard-controller.js  # AI accuracy dashboard endpoints (forge-gated)
      admin-dashboard-controller.js # Admin dashboard endpoints (dashboard-auth gated)
      app-version-controller.js     # GET /app-version — latest desktop app release info
      auth-controller.js            # POST /auth/token — desktop app JWT issuance
      feedback-controller.js        # POST /feedback — user feedback submission
      forge-proxy-controller.js     # POST /forge-proxy — Forge Remote proxy endpoint
      notification-controller.js    # POST /notifications — trigger notifications
      uninstall-controller.js       # POST /uninstall — org data deletion on uninstall
      user-data-controller.js       # DELETE /user-data — GDPR data deletion
    middleware/
      auth.js                       # JWT middleware for desktop app requests
      forge-auth.js                 # Forge-signed request middleware (FIT token)
      atlassian-auth.js             # Atlassian OAuth token middleware
      dashboard-auth.js             # Session middleware for admin dashboard
      request-id.js                 # Attach X-Request-ID to every request
    services/
      activity-polling-service.js   # Polls Supabase for pending screenshots; triggers AI analysis
      activity-service.js           # Core AI analysis orchestration for a single activity batch
      clustering-polling-service.js # Polls for users with unassigned activity; triggers clustering
      clustering-service.js         # AI-powered activity grouping and issue suggestion
      deletion-service.js           # Full org/user data deletion logic (GDPR + uninstall)
      feedback-service.js           # Feedback record persistence
      feedback-session-store.js     # In-memory feedback session state
      supabase-service.js           # Legacy Supabase helpers (prefer db/ submodule for new code)
      user-data-service.js          # User data export and deletion orchestration
      ai/
        index.js                    # AI service entry point; exports analyzeActivity()
        ai-client.js                # OpenAI client wrapper with retry and error handling
        prompts.js                  # All AI prompt templates (CRITICAL TASK KEY RULE must be preserved)
        feedback-prompts.js         # Prompts for feedback-assisted re-analysis
      db/
        index.js                    # DB service aggregator
        activity-db-service.js      # Activity record CRUD
        aggregation-service.js      # Analytics aggregation queries
        clustering-db-service.js    # Unassigned work group CRUD
        feedback-db-service.js      # Feedback record CRUD
        notification-db-service.js  # Notification log CRUD
        storage-service.js          # Supabase Storage (screenshot download/delete)
        supabase-client.js          # Single shared Supabase client instance
        user-db-service.js          # User and org lookup
      notifications/
        index.js                    # Notification service entry point
        notification-polling.js     # Polls for users requiring notifications; dispatches
        notification-service.js     # Notification business logic; cooldowns; preferences
        notifme-wrapper.js          # notifme-sdk wrapper (primary)
        notifme-wrapper-enhanced.js # Enhanced wrapper with fallback chain
        templates/
          index.js                  # Template registry
          inactivity-alert.js       # Inactivity alert email template
          login-reminder.js         # Login reminder email template
          download-reminder.js      # Desktop app download reminder template
          new-version.js            # New version available notification template
          default-password-reminder.js  # Default password change reminder
          admin-inactivity-digest.js    # Admin digest of inactive users
          admin-download-digest.js      # Admin digest of download status
          approval-pending-digest.js    # Pending worklog approval digest
    utils/
      logger.js                     # Winston logger with PII sanitisation middleware
      log-sanitizer.js              # Redacts tokens, passwords, PII from log output
    dashboard/                      # Admin dashboard SPA (served at /admin-dashboard)
    legal/                          # Legal/compliance endpoint assets
    feedback/                       # Feedback static assets
  tests/
    index.test.js                   # Express app smoke test
    log-sanitizer.test.js
    sonar-smoke.test.js
    controllers/
      activity-controller.test.js
      analytics-controller.test.js
      app-version-controller.test.js
      auth-controller.test.js
      feedback-controller.test.js
      forge-proxy-controller.test.js
      notification-controller.test.js
    middleware/
      atlassian-auth.test.js
      forge-auth.test.js
    services/
      activity-db-service.test.js
      activity-id-sanitization.test.js
      activity-polling-service.test.js
      activity-sanitization.test.js
      activity-service.test.js
      aggregation-service.test.js
      ai-client.test.js
      ai-matching-root-cause-fixes.test.js
      audit-defects.test.js
      batch-prompt.test.js
      cache-write-description.test.js
      clustering-description.test.js
      clustering-service.test.js
      confidence-threshold-alignment.test.js
      e2e-advanced-scenarios.test.js
      e2e-ai-accuracy-fixes.test.js
      e2e-time-tracking.test.js
      feedback-service.test.js
      feedback-session-store.test.js
      prompts-description-truncation.test.js
      prompts.test.js
      webhook-select-fields.test.js
      notifications/
        inactivity-data-consistency.test.js
        notification-fixes.test.js
        notification-polling.test.js
        notification-service.test.js
        notifme-wrapper.test.js
```

Key module responsibilities:

- `src/index.js`
  - Creates Express app; registers middleware (helmet, cors, rate-limit, request-id).
  - Mounts all route controllers with the correct auth middleware (see auth middleware matrix below).
  - Starts `activityPollingService`, `clusteringPollingService`, `notificationPollingService`.

- `src/services/ai/prompts.js`
  - Central repository for all LLM prompt strings.
  - The **CRITICAL TASK KEY RULE** — the LLM must only return issue keys from the provided list — must never be removed or weakened.
  - `MIN_CONFIDENCE_THRESHOLD` (default `0.4`) — never lowered without false-positive measurement.

- `src/utils/logger.js`
  - Winston logger. Never logs OCR text, window titles, or JWT values at `info` level.
  - PII sanitisation applied via `log-sanitizer.js` format middleware (enabled by default in production).

**Auth middleware matrix:**

| Caller | Middleware |
|--------|-----------|
| Desktop app | `src/middleware/auth.js` (JWT) |
| Forge app | `src/middleware/forge-auth.js` (Forge FIT token) |
| Admin dashboard | `src/middleware/dashboard-auth.js` (session) |
| Atlassian OAuth callbacks | `src/middleware/atlassian-auth.js` |
| Public endpoints (`/health`, `/app-version`) | None |

### 4.3 Python desktop app (`python-desktop-app/`)

> Sensitive values (tokens, DB passwords) must use `auth/` keyring or OS environment variables — never plain text.

```text
python-desktop-app/
  .env.example
  desktop_app.py                    # Main entry point (~563KB monolith — system tray app)
  desktop_app.spec                  # PyInstaller build specification
  build.bat                         # Windows build script
  launch.bat / launch.ps1 / launch.py  # Dev launch helpers
  requirements.txt                  # All Python dependencies
  config_manager.py                 # Configuration load/save (env + encrypted SQLite)
  db_connection.py                  # Local encrypted SQLite DB (sqlcipher) for offline sync
  secure_logger.py                  # PII-safe logging for the desktop app
  auth/
    __init__.py
    secure_storage.py               # OS keyring + encrypted SQLite token persistence
  ocr/
    __init__.py
    facade.py                       # OCRFacade — single entry point for all OCR operations
    base_engine.py                  # Abstract OCREngine base class
    ocr_engine.py                   # Engine type definitions and contracts
    engine_factory.py               # Dynamic engine discovery and registration
    auto_installer.py               # Runtime OCR engine dependency installer
    runtime_installer.py            # Install OCR engines without app restart
    config.py                       # OCR configuration (engine selection, thresholds)
    image_processor.py              # Image pre-processing for OCR
    text_extractor.py               # Post-OCR text extraction and normalisation
    tabular_enricher.py             # Structured data extraction from OCR output
    engines/
      __init__.py
      rapidocr_engine.py            # RapidOCR (PaddleOCR ONNX) — primary engine
      winrtocr_engine.py            # Windows Runtime OCR — fallback engine (Windows only)
      easyocr_engine.py             # EasyOCR — optional engine
      dynamic_engine.py             # Dynamically loaded engine wrapper
      demo_engine.py                # Demo/test engine for development
      mock_engine.py                # Mock engine for unit tests
  privacy/
    __init__.py
    filter.py                       # PrivacyFilter — main entry point for PII filtering
    config.py                       # Privacy configuration (enabled flag, sensitivity levels)
    detectors/
      __init__.py
      base.py                       # Abstract PIIDetector base class
      presidio_detector.py          # Microsoft Presidio NLP-based PII detector
      custom_patterns.py            # Regex-based custom pattern detector
      entropy_detector.py           # Entropy-based secrets detector
      secrets_detector.py           # Secrets/API key pattern detector
    redactors/
      __init__.py
      text_redactor.py              # Text redaction with configurable replacement tokens
    tests/                          # Privacy module unit tests
  tests/
    __init__.py
    QUICKSTART.md
    README.md
    fixtures/
      generate_fixtures.py          # Test fixture generation scripts
    test_ai_matching_fixes.py
    test_auto_update_silent.py
    test_ocr_engines.py
    test_secure_logger.py
    test_session_maintenance.py
    test_state_machine.py
    test_tray_menu_and_notifications.py
    test_update_manager.py
```

Key module responsibilities:

- `desktop_app.py`
  - System tray application entry point.
  - Screenshot capture loop (configurable interval, default 15 minutes).
  - Activity monitoring (window title, application name, idle detection via `psutil`).
  - Atlassian OAuth 2.0 + PKCE authentication flow.
  - Uploads screenshots + metadata to Supabase via Edge Functions.
  - Offline queue with encrypted local SQLite sync via `db_connection.py`.

- `ocr/facade.py` (`OCRFacade`)
  - Single entry point for all OCR. Primary: `RapidOCROnnxEngine`. Fallback: `WinRTOCREngine`.
  - Engines discovered dynamically via `engine_factory.py`.
  - **PII redaction via `privacy/filter.py` must run on all OCR output before it leaves the desktop.**

- `privacy/filter.py` (`PrivacyFilter`)
  - Orchestrates all detectors (Presidio, custom patterns, entropy, secrets).
  - Redacts PII via `text_redactor.py` before sending to AI server.
  - Do not add OCR pass-through paths that bypass this module.

- `auth/secure_storage.py`
  - Stores Atlassian OAuth tokens in OS keyring.
  - Falls back to encrypted SQLite (`sqlcipher3`) if keyring unavailable.

### 4.4 Supabase (`supabase/`)

```text
supabase/
  config.toml                       # Local dev config (API: 54321, DB: 54322, Studio: 54323)
  migrations/
    YYYYMMDD_description.sql        # Naming convention — always a new file, never modify existing
  functions/
    activity-webhook/               # Receives activity records from desktop app
    screenshot-webhook/             # Receives screenshot metadata from desktop app
    document-webhook/               # Receives document/BRD analysis records
    update-issues-cache/            # Triggers Jira issues cache refresh
```

Migration conventions:
- File naming: `YYYYMMDD_description.sql` (lowercase, underscores).
- Every new table: RLS enabled + at least one policy gated on `org_id`.
- Never modify existing migration files — add a new one.
- Comment block at top of every file documenting its purpose.

Edge Function conventions:
- `verify_jwt = false` in `config.toml` (JWT verification handled inside each function).
- All functions receive POST requests from either the desktop app or AI server.

---

## 5. API contracts

### 5.1 Forge app resolver API (RPC over `@forge/bridge`)

The forge-app backend exposes named resolver functions (not HTTP routes). All calls originate from React components via `@forge/bridge invoke()`.

Key resolver categories:

| Category | Resolver file | Purpose |
|---|---|---|
| Analytics | `analyticsResolvers.js` | Fetch personal/team/org time summaries |
| Worklogs | `worklogResolvers.js` | Create, read, reassign, split worklogs |
| Unassigned work | `unassignedWorkResolvers.js` + `unassigned/` | Manage unassigned activity clusters |
| Settings | `settingsResolvers.js` | Read/write global and project settings |
| Issues | `issueResolvers.js` | Fetch and cache Jira issues |
| Permissions | `permissionsResolvers.js` | Check user roles and Jira permissions |
| Users | `userResolvers.js` | Resolve user identity and org membership |
| Approval | `approval/approvalResolvers.js` | Worklog approval workflow |
| Accuracy | `accuracyDashboardResolvers.js` | AI accuracy metrics (admin-only email allowlist) |
| Feedback | `feedbackResolvers.js` | User feedback on AI classification |
| Classification | `classificationResolvers.js` | Manage app/URL classification rules |
| Diagnostic | `diagnosticResolvers.js` | Desktop app and server health checks |
| Admin status | `adminUserStatusResolvers.js` | Admin view of user app state |

### 5.2 AI server HTTP endpoints

All routes served from `https://forgesync.amzur.com`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | None | Liveness probe |
| `POST` | `/auth/token` | None | Issue JWT to desktop app after Atlassian OAuth |
| `POST` | `/activity` | Desktop JWT | Upload activity batch from desktop app |
| `GET` | `/analytics` | Forge FIT | Fetch aggregated analytics for Forge app |
| `POST` | `/forge-proxy` | Forge FIT | Generic proxy for Forge → AI server requests |
| `POST` | `/feedback` | Desktop JWT | Submit user feedback on AI classification |
| `POST` | `/notifications` | Internal | Trigger notification dispatch |
| `GET` | `/app-version` | None | Latest desktop app release info |
| `DELETE` | `/user-data` | Desktop JWT | GDPR user data deletion |
| `POST` | `/uninstall` | Forge FIT | Org data cleanup on app uninstall |
| `GET` | `/admin-dashboard` | Dashboard session | Admin SPA |
| `GET` | `/accuracy-dashboard/*` | Forge FIT | AI accuracy metrics endpoints |

### 5.3 Supabase Edge Function endpoints

| Function | Trigger | Purpose |
|---|---|---|
| `activity-webhook` | POST from desktop | Persist activity records; `request_id` idempotency |
| `screenshot-webhook` | POST from desktop | Persist screenshot metadata and storage path |
| `document-webhook` | POST from desktop | Persist document analysis records |
| `update-issues-cache` | POST from Forge | Refresh `user_jira_issues_cache` for a user |

---

## 6. Database structure

### 6.1 Core schema (abbreviated)

Every table has `org_id` (FK to `organizations.id`) with RLS policy enforcement.

Key tables:

| Table | Purpose |
|---|---|
| `organizations` | Multi-tenancy root — keyed by `jira_cloud_id` |
| `organization_members` | User ↔ org membership with role and permissions |
| `organization_settings` | Per-org tracking configuration |
| `users` | Users keyed by `atlassian_account_id` |
| `screenshots` | Screenshot metadata (path, window title, app name, timestamp) |
| `activity_records` | Processed activity records with `request_id` idempotency |
| `analysis_results` | AI analysis output per screenshot (task key, confidence, work type) |
| `unassigned_work_groups` | AI-clustered unassigned activity groups |
| `unassigned_group_members` | Activity records belonging to a group |
| `user_jira_issues_cache` | Cached Jira issues per user (refreshed by trigger) |
| `application_classifications` | DB-driven app whitelist/blacklist (replaces legacy config) |
| `daily_time_summary` (VIEW) | Pre-aggregated daily analytics per user |
| `weekly_time_summary` (VIEW) | Pre-aggregated weekly analytics per user |
| `notification_tracking` | Notification send/cooldown log |
| `app_releases` | Desktop app release versions and download URLs |
| `feedback` | User AI classification feedback |
| `ai_accuracy_tracking` | Per-issue AI matching accuracy records |
| `worklog_reassignment_log` | Audit trail for worklog reassignment actions |
| `approval_requests` | Worklog approval workflow state |

### 6.2 Multi-tenancy pattern

Every Supabase query from the AI server and Forge app must include `org_id`. Missing `org_id` in a query is a data-leak bug. The RLS policies enforce this at the DB layer as a safety net — application code must not rely on RLS as the only guard.

### 6.3 Migration pattern

- `supabase db reset` replays all migrations from scratch.
- Migrations use `IF NOT EXISTS` / `IF EXISTS` guards to be re-runnable in dev.
- TimescaleDB extension is not required (plain PostgreSQL 15).

---

## 7. Test plan

### 7.1 Unit tests

**forge-app (Jest):**
- `tests/resolvers/analytics-resolver.test.js` — analytics resolver dispatch and data shape.
- `tests/resolvers/approvalResolvers.test.js` — approval workflow state transitions.
- `tests/services/worklogService.test.js` — worklog create/update/delete edge cases.
- `tests/services/worklogSplit.test.js` — sub-minute worklog splitting logic.
- `tests/services/worklogReassignmentService.test.js` — reassignment validation and audit trail.
- `tests/services/scheduledWorklogSync.test.js` — sync idempotency and error handling.
- `tests/services/issueCacheJql.test.js` — JQL query construction for issue cache.
- `tests/services/issueQueryService.test.js` — issue query filtering and pagination.
- `tests/services/userAnalyticsVisibility.test.js` — role-based analytics visibility.
- `tests/services/worklogAuthorVerification.test.js` — author identity validation.
- `tests/utils/adfToText.test.js` — ADF to plain text conversion.
- `tests/utils/remote.test.js` — Forge Remote call construction.
- `tests/utils/subMinuteWorklog.test.js` — sub-minute duration handling.

**ai-server (Jest):**
- `tests/services/activity-service.test.js` — end-to-end AI analysis pipeline mock.
- `tests/services/batch-prompt.test.js` — batch prompt construction and CRITICAL TASK KEY RULE.
- `tests/services/prompts.test.js` — prompt template validation.
- `tests/services/clustering-service.test.js` — group creation and issue suggestion logic.
- `tests/services/aggregation-service.test.js` — analytics aggregation correctness.
- `tests/services/ai-client.test.js` — OpenAI client retry and error handling.
- `tests/services/feedback-service.test.js` — feedback record persistence.
- `tests/services/confidence-threshold-alignment.test.js` — threshold enforcement (never below 0.4).
- `tests/services/notifications/notification-service.test.js` — cooldown and preference logic.
- `tests/services/notifications/notifme-wrapper.test.js` — provider dispatch and fallback.
- `tests/controllers/activity-controller.test.js` — request validation and response shape.
- `tests/controllers/forge-proxy-controller.test.js` — Forge FIT auth verification.
- `tests/middleware/forge-auth.test.js` — Forge FIT token validation.
- `tests/middleware/atlassian-auth.test.js` — Atlassian OAuth token validation.
- `tests/log-sanitizer.test.js` — PII redaction from log output.

**python-desktop-app (pytest):**
- `tests/test_ocr_engines.py` — engine facade, fallback chain, RapidOCR and WinRT engines.
- `tests/test_session_maintenance.py` — session state machine and persistence.
- `tests/test_secure_logger.py` — PII-safe logging redaction.
- `tests/test_ai_matching_fixes.py` — AI issue matching accuracy fixes.
- `tests/test_state_machine.py` — app state machine transitions.
- `tests/test_tray_menu_and_notifications.py` — tray menu state and notification triggers.
- `tests/test_auto_update_silent.py` — silent auto-update flow.
- `tests/test_update_manager.py` — update download and install management.

### 7.2 Integration tests

- forge-app + AI server: integration via `tests/resolvers/convertUnassignedToWorklog.integration.test.js` (excluded from default CI, requires running AI server).
- ai-server + Supabase: `tests/services/e2e-time-tracking.test.js`, `e2e-ai-accuracy-fixes.test.js`, `e2e-advanced-scenarios.test.js` — require a test Supabase instance.
- Desktop app: `test_session_management.py` and `test_real_tracking.py` — require OS environment.

### 7.3 Running tests

```bash
# forge-app
cd forge-app && npm test
cd forge-app && npm run test:coverage

# ai-server
cd ai-server && npm test

# python-desktop-app (all unit tests)
cd python-desktop-app && python -m pytest tests/ -v

# Single file
npx jest tests/services/worklogService.test.js      # forge-app / ai-server
python -m pytest tests/test_ocr_engines.py -v       # desktop app
```

---

## 8. Interaction diagrams

### 8.1 Desktop app → AI server → Supabase (activity upload)

```
Desktop App (every N minutes)
  ├── Capture screenshot (mss)
  ├── OCR (OCRFacade → RapidOCR / WinRT fallback)
  ├── PII redaction (PrivacyFilter → Presidio + custom patterns)
  ├── POST to Supabase activity-webhook Edge Function
  │     └── Writes activity_record with request_id (idempotent)
  │
  └── AI Server (activity-polling-service, every 30s)
        ├── Fetch pending activity_records
        ├── ai/index.js → ai-client.js → OpenAI GPT-4o
        │     ├── Prompt includes: OCR text, window title, user's Jira issues
        │     ├── LLM returns: task_key (from provided list only), confidence, work_type
        │     └── confidence < 0.4 → classified as unassigned
        ├── Save analysis_result to Supabase
        └── If no task_key → eligible for clustering
```

### 8.2 Forge app request flow

```
React UI (via @forge/bridge invoke())
  └── Forge Resolver (src/index.js handler)
        ├── service logic (services/)
        ├── Direct Supabase query (utils/supabase/) for read-only data
        └── AI server calls → src/utils/remote.js → Forge Remote (manifest.yml)
              └── AI server (forge-proxy-controller or dedicated endpoint)
                    └── Supabase operations with org_id
```

### 8.3 Unassigned work clustering flow

```
AI Server (clustering-polling-service, every 5 min)
  ├── Fetch users with unassigned activity (grouped by user + org)
  ├── For each user: check 24h cooldown
  ├── Fetch unassigned_activity records + user's Jira issues
  ├── clustering-service.js → ai-client.js → GPT-4o
  │     └── Groups similar activities; suggests issue key
  ├── Save unassigned_work_groups + unassigned_group_members to Supabase
  └── Forge UI: GroupAccordion → AssignmentModal → assign/create issue
```

### 8.4 Notification dispatch flow

```
notification-polling-service (scheduled)
  ├── Check users for inactivity / new version / login reminder / approval pending
  ├── notification-service.js
  │     ├── Enforce cooldown (notification_tracking table)
  │     ├── Check user preferences
  │     └── Select template (templates/index.js)
  └── notifme-wrapper.js / notifme-wrapper-enhanced.js
        └── Send via SMTP / SendGrid (configured provider)
```

### 8.5 Worklog sync flow (scheduled, hourly)

```
Forge scheduledWorklogSyncHandler (every hour)
  └── scheduledWorklogSync.js
        ├── Fetch activity_records with approved/pending status
        ├── worklogService.js → Jira REST API (write:jira-work)
        │     └── POST /rest/api/3/issue/{key}/worklog
        └── Update activity_record.worklog_sync_status
```

---

## 9. Architecture constraints

### 9.1 Forge Remote (critical)

The Forge app **cannot make arbitrary HTTP calls**. All `forge-app → ai-server` communication must go through the Forge Remote declared in `manifest.yml` and routed via `src/utils/remote.js`. Never use `fetch()` or `axios` directly in forge-app backend code.

### 9.2 Multi-tenancy

Every DB operation that reads or writes user data must include `org_id`. The `org_id` value comes from:
- **Forge app**: `cloudId` from Forge context → resolved to `organization.id` via `utils/supabase/organizations.js`.
- **AI server**: decoded from the request JWT or Forge FIT token.
- **Desktop app**: extracted from Atlassian accessible-resources API after OAuth.

### 9.3 AI prompt constraints

- The LLM must only return issue keys from the provided list (**CRITICAL TASK KEY RULE**). Preserve this constraint in any prompt rewrite.
- `MIN_CONFIDENCE_THRESHOLD` (default `0.4`) — never lower without measuring false-positive rate.
- When changing `prompts.js` or `activity-service.js`, update `tests/services/batch-prompt.test.js` and `prompts.test.js` first.

### 9.4 Security

- Never log OCR text, window titles, or JWT token values at `info` level — use `debug`.
- PII in OCR output is redacted by `privacy/` before the record leaves the desktop.
- SQL in Supabase migrations must use parameterised queries — never concatenate user values.
- OWASP Top 10 applies to all HTTP endpoints in ai-server — validate input at controller boundary.
- AI server credentials, Supabase keys, and SMTP credentials are stored as environment variables only.

---

## 10. CI/CD

```text
.github/
  workflows/
    build.yml                   # SonarCloud analysis on push to main
  copilot-instructions.md       # Repository Copilot conventions
sonar-project.properties        # Scans ai-server/src + forge-app/src
                                # Coverage from ai-server/coverage/lcov.info
```

- **SonarCloud**: Runs on push to `main`. Coverage threshold enforced.
- **Forge deployment**: Manual — `forge deploy` from `forge-app/` after `npm run build`.
- **AI server deployment**: Docker image built and pushed to registry; deployed to `forgesync.amzur.com`.
- **Desktop app distribution**: PyInstaller (`build.bat`) produces Windows executable; uploaded to `app_releases` table.

---

## 11. Coding conventions (summary)

### JavaScript / TypeScript (forge-app, ai-server)

- `'use strict'` at the top of every CommonJS module (ai-server).
- ES modules (`import`/`export`) in forge-app.
- Jest test files: `jest.mock(...)` declarations **before** any `require()` calls; `jest.clearAllMocks()` in `beforeEach`.
- No `console.log` in production code — use `logger.info/warn/error` (ai-server) or Forge built-in logging (forge-app).
- Environment variables accessed only via `process.env`; never hardcode URLs or secrets.

### Python (python-desktop-app)

- All test files under `tests/` named `test_<module>.py`.
- Import module under test using package path: `from ocr.facade import OCRFacade`.
- Use `pytest.fixture` for shared setup; avoid global state in test files.
- Sensitive values use `auth/` keyring or OS env vars — never plain text.

### Supabase SQL migrations

- `YYYYMMDD_description.sql` naming (lowercase, underscores).
- Every new table: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + policy gated on `org_id`.
- Never modify existing migration file — add a new one.
- Purpose comment block at top of every migration file.

---

## 12. Rollout and feature flagging

All new features built on this skeleton must:
1. Be introduced behind a feature flag (Forge KVS boolean or `DEFAULT_SETTINGS` extension) where the change is visible to end users.
2. Follow the spec-driven development workflow: spec → failing tests → implementation → verify → commit.
3. Not break existing resolver names, API paths, or DB column names (additive only).
4. Pass the full Jest suite for the affected component before merging.

For breaking changes (resolver renames, schema column changes):
- Add new resolver/column in parallel with old.
- Migrate existing data or callers.
- Remove old resolver/column in a follow-up migration.

---

## 13. Open questions / deferred decisions

- Should the AI server move from a polling model (`activity-polling-service`) to a push model via Supabase Realtime or webhooks for lower latency?
- Admin dashboard (`src/dashboard/`) is a separate sub-app served by Express — evaluate moving to the Forge admin page UI for simpler deployment.
- Desktop app `desktop_app.py` monolith (~563 KB) — a modularisation plan (`plan/PYTHON_MIGRATION_PLAN.md`) exists but is not yet started; it should be the first structural refactor before adding new desktop features.
- Should `worklog_reassignment_log` and `approval_requests` be promoted to first-class audit log with immutable append-only policy?
- EasyOCR engine in `ocr/engines/easyocr_engine.py` is present but not set as primary or fallback in default config — confirm intended use or remove.
