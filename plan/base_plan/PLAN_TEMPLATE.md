# PLAN TEMPLATE — JIRAForge (BRD Time Tracker)

> All feature and sub-feature plan files must follow this template.
> File naming convention: `plan/YYYY-MM-DD_<component>_<feature>.md`
> Component values: `forge-app`, `ai-server`, `python-desktop-app`,
> `supabase`, or `multi` for cross-component changes.
>
> Examples:
>   `plan/2026-05-20_forge-app_bulk-worklog-export.md`
>   `plan/2026-05-20_ai-server_confidence-threshold-tuning.md`
>   `plan/2026-05-20_multi_approval-workflow-v2.md`

---

## 1. Scope & goals

### 1.1 Feature overview

- Short description of what this feature or sub-feature does.
- Which component(s) it touches: `forge-app`, `ai-server`,
  `python-desktop-app`, `supabase`.
- Primary personas affected: end user (developer in Jira), team
  manager/admin, desktop app user, system/scheduled job.

### 1.2 In scope

- Bullet list of concrete capabilities included in this plan.
- Include both user-visible behaviours and backend behaviours.
- Clarify what "done" means for this feature (observable outcomes).

### 1.3 Out of scope

- Explicit list of related items not included here, even if they
  will be built later.
- Call out any known future enhancements that are intentionally
  deferred.

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- Assumptions about upstream data or state (for example: Supabase
  `activity_records` table populated by desktop app, Jira issues
  cache warm before analytics queries run).
- Assumptions about auth (Forge context provides `cloudId` and
  `accountId`; desktop app has valid Atlassian OAuth token in OS
  keyring).
- Assumptions about existing components (for example: Forge app
  `remote.js` wired; `org_id` resolution in place; notification
  service running).
- All features depend on `plan/2026-05-13_jiraforge_base-skeleton.md`
  being in place.
- If this feature fires notifications: assume `notification-service.js`
  and `notification-polling.js` are operational and `notifme-wrapper.js`
  is configured with a live SMTP/SendGrid provider before notification
  dispatch is enabled.

### 2.2 Dependencies

- Other plans this feature depends on (list plan file names).
- External systems:
  - Jira REST API endpoints consumed (list if applicable).
  - Supabase tables or views that must exist before this migration
    runs.
  - Supabase Edge Functions consumed by this feature (list if
    applicable).
  - Third-party APIs or services (for example: OpenAI models,
    Atlassian OAuth endpoints).

---

## 3. UI layouts

If the feature has no UI, write: "No UI surfaces for this feature."

### 3.1 User flows

High-level flows as bullet points for each UI surface:

- `static/main/` (Jira project page / issue panel tabs) — describe
  user journey through affected tabs or components.
- `static/settings/` (Jira admin settings page) — describe any
  admin-facing configuration steps.
- Note which flows are triggered by user action vs. by the scheduled
  worklog sync or a Forge trigger.

### 3.2 Screens and components

For each UI surface:

- **Tab or component name** and its location in
  `static/main/src/components/tabs/` or
  `static/main/src/components/unassigned/` etc.
  - Purpose of the tab or component.
  - Sections or regions on the screen.
  - Critical states: loading, error, empty, success.
  - Data source: resolver call via `@forge/bridge invoke()` vs.
    data already in React context.
- **Components to add or modify**:
  - Component file name and path.
  - Props (inputs) and events (outputs) at a high level.
  - Navigation links (from which tab/component, to which).

You may include simple ASCII wireframes if helpful.

---

## 4. File and function names (physical structure)

This section defines the physical file and function naming that all
engineers and Copilot must follow for this feature. Only list files
that are **new** or **modified** by this plan.

> General rules that apply to every section below:
>
> - Do not put business logic in resolver files (`resolvers/`).
>   Resolvers dispatch to service functions only.
> - Do not put Supabase queries in service files (`services/`).
>   DB access belongs in `utils/supabase/` (forge-app) or
>   `services/db/` (ai-server).
> - Do not call `fetch()` or `axios` directly in forge-app backend
>   code to reach the AI server. All such calls go through
>   `src/utils/remote.js` via Forge Remote.
> - Never call notification templates or `notifme-wrapper.js` directly
>   from controllers or services outside `notifications/`. All
>   notification dispatch must go through `notification-service.js`.
>   See Section 13 for notification declaration.

### 4.1 Forge app (`forge-app/src/`)

List all new or modified files:

```text
forge-app/src/
  resolvers/
    <featureResolvers>.js     # New or modified resolver registrations
  services/
    <featureService>.js       # New or modified service business logic
  utils/
    supabase/
      <supabaseUtil>.js       # New or modified Supabase query helpers
  config/
    constants.js              # New constants (TTLs, defaults, limits)
static/main/src/
  components/
    tabs/
      <FeatureTab>.js         # New or modified tab component
    <SubComponent>.js         # Supporting components
tests/
  resolvers/
    <featureResolvers>.test.js
  services/
    <featureService>.test.js
```

For each file, list functions to be created or modified, with a
one-line description:

- `resolvers/<featureResolvers>.js`
  - `register<Feature>Resolvers(resolver)` — registers all RPC
    handlers for this feature.
- `services/<featureService>.js`
  - `doSomething(orgId, userId, params)` — describe what it does.
    Must not contain Supabase queries.
- `utils/supabase/<supabaseUtil>.js`
  - `fetchSomething(orgId, userId)` — Supabase query returning …

### 4.2 AI server (`ai-server/src/`)

List all new or modified files:

```text
ai-server/src/
  controllers/
    <feature>-controller.js   # New or modified Express route handler
  services/
    <feature>-service.js      # New or modified service logic
    db/
      <feature>-db-service.js # New or modified Supabase DB queries
  middleware/
    <new-middleware>.js        # New middleware (if required)
tests/
  controllers/
    <feature>-controller.test.js
  services/
    <feature>-service.test.js
    <feature>-db-service.test.js
```

Rules:
- `'use strict'` at the top of every new CommonJS module.
- Controller files handle only request parsing, auth delegation,
  input validation, and response serialisation. No business logic.
- Service files contain domain logic only. No Express `req`/`res`
  objects.
- DB service files contain Supabase queries only. Every query must
  include `org_id` in its filter.
- Use `logger.info/warn/error` (never `console.log`) for all logging.
- New endpoints must specify which auth middleware they use (see
  auth middleware matrix in base skeleton §4.2).

For each file, list functions with descriptions:

- `controllers/<feature>-controller.js`
  - `POST /<path>` — validates input, calls service, returns
    standardised JSON response.
- `services/<feature>-service.js`
  - `processFeature(orgId, params)` — describe logic.
- `services/db/<feature>-db-service.js`
  - `insertRecord(orgId, data)` — inserts row in `<table>`
    filtered by `org_id`.

### 4.3 Python desktop app (`python-desktop-app/`)

List all new or modified files:

```text
python-desktop-app/
  <module>.py                   # New or modified module
  ocr/
    engines/
      <engine>.py               # New OCR engine (if applicable)
  privacy/
    detectors/
      <detector>.py             # New PII detector (if applicable)
tests/
  test_<module>.py              # Corresponding test file
```

Rules:
- All new module code must have a corresponding `tests/test_<module>.py`.
- Import using package paths: `from ocr.facade import OCRFacade`.
- Never add OCR pass-through paths that bypass `privacy/filter.py`.
- Sensitive values in `auth/secure_storage.py` or OS env vars only.
- Use `pytest.fixture` for shared setup.

For each file, list functions or classes with descriptions.

### 4.4 Supabase (`supabase/`)

List all new or modified items:

```text
supabase/
  migrations/
    YYYYMMDD_<description>.sql  # New migration file(s)
  functions/
    <function-name>/
      index.ts                  # New or modified Edge Function
```

For each migration file, state:
- Purpose (one sentence).
- Tables created, altered, or dropped.
- RLS policies added.

For each Edge Function, state:
- Trigger (POST from desktop app / POST from AI server / scheduled).
- Input shape and output shape.
- Auth/verification approach.

---

## 5. API contracts

### 5.1 Forge app resolver API (RPC over `@forge/bridge`)

For each new or modified resolver function exposed to the React
frontend:

- **Resolver name** (the string key used in `resolver.define()`).
- **Auth/context**: Forge context fields consumed (`cloudId`,
  `accountId`, user role check).
- **Input payload**: fields passed from the React component.
- **Response shape**: fields returned in the resolver response.
- **Error cases**: what is returned when data is missing or
  permission is denied.

Example:

```
resolver: 'getFeatureSummary'
input:  { projectKey: string, dateRange: { start: string, end: string } }
output: { items: FeatureItem[], total: number }
errors: { error: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'SERVER_ERROR' }
```

### 5.2 AI server HTTP endpoints

For each new or modified HTTP endpoint:

- **Method and path** (for example: `POST /feature/action`).
- **Auth middleware**: one of `auth.js` (desktop JWT), `forge-auth.js`
  (Forge FIT), `dashboard-auth.js` (admin session), or none for
  public endpoints.
- **Request body**: field names, types, and validation rules.
- **Response body**: field names and types.
- **Error responses**: HTTP status codes and JSON shape:
  `{ "error": "ERROR_CODE", "message": "..." }`.

### 5.3 Supabase Edge Functions (if applicable)

For each new or modified Edge Function:

- **Function path** (for example: `supabase/functions/feature-webhook/`).
- **Trigger**: POST from desktop app, POST from AI server.
- **Request body** and **response body**.
- **Idempotency**: describe any `request_id` or dedupe logic.

---

## 6. Database structure

### 6.1 New tables

For each new table:

- **Schema**: `public` (all JiraForge tables use the `public` schema
  via Supabase).
- **Table name** (snake_case).
- **Columns**: name, type, default, nullable, primary key, foreign key.
- **Indexes**: field(s), type, purpose.
- **RLS**: policy name and condition (every new table must have
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and at least one
  policy gated on `org_id`).

> **Multi-tenancy guard — applies to every new table:**
>
> - Every table that holds user-generated or org-scoped data must
>   have an `org_id UUID NOT NULL REFERENCES organizations(id)` column.
> - Tables that are genuinely cross-org (for example: `app_releases`,
>   `application_classifications`) must explicitly document why
>   `org_id` is absent.
> - Missing `org_id` on a user-scoped table is a data-leak bug and
>   must be caught in PR review.

### 6.2 Changes to existing tables

- Columns to add or remove (additive changes preferred).
- New or modified indexes.
- New or modified constraints or RLS policies.
- Expected impact on existing queries or views.

### 6.3 New or modified views

If this feature adds or modifies a `daily_time_summary`,
`weekly_time_summary`, or any other Supabase view:

- View name and purpose.
- Columns exposed.
- Filtering logic (for example: excludes `idle` work type,
  respects `org_id`).

---

## 7. Migration files

### 7.1 Migration files

List all Supabase SQL migration files required for this feature:

- Filename: `YYYYMMDD_<short_description>.sql`.
- Summary: one sentence describing purpose.
- Dependencies: which prior migration this depends on (reference
  the filename).

Example:

- `20260520_add_feature_table.sql` — creates `feature_records` table
  with `org_id` RLS policy.
- `20260520_add_feature_summary_view.sql` — creates
  `feature_summary` view aggregating `feature_records` by
  `org_id` and `user_id`.

Rules:
- Every migration must begin with a comment block stating its purpose.
- Use `IF NOT EXISTS` / `IF EXISTS` guards throughout so the file
  can be replayed in dev (`supabase db reset`).
- Never modify an existing migration file — add a new one.

### 7.2 Data migrations and seed data

- Any initial seed rows required (for example: default
  `application_classifications`, initial `org_settings` defaults).
- Backfill logic for existing rows in modified tables (if applicable).
- How to run backfill safely in staging before production.

---

## 8. Background jobs and Edge Functions

If this feature does not introduce any background processing or Edge
Functions, write: "No background jobs for this feature."

### 8.1 Polling services (ai-server)

If this feature adds or modifies a polling service in `ai-server/`:

- **Service file**: `src/services/<name>-polling-service.js`.
- **Poll interval** and trigger condition.
- **Idempotency**: how duplicate processing is prevented (for
  example: status column guard, `request_id` check).
- **Error handling**: what happens when Supabase or OpenAI is
  unavailable.
- **Impact on existing polling services**: does this change poll
  frequency or query scope?

### 8.2 Forge scheduled triggers

If this feature adds or modifies a Forge scheduled trigger declared
in `manifest.yml`:

- **Trigger key** and **interval**.
- **Handler function** exported from `src/index.js`.
- **Idempotency**: how the handler avoids duplicate work on
  overlapping runs.

### 8.3 Supabase Edge Functions

If this feature adds or modifies a Supabase Edge Function:

- **Function directory** and purpose.
- **Input/output contract** (repeated from §5.3 for completeness
  in context).
- **Error/retry behaviour**: does the desktop app retry on 5xx?
  Does the AI server?

---

## 9. Test plan

### 9.1 Unit tests

For each new service, utility, or module, list:

- **Test file** (mirroring source path).
- **Scenarios to cover**:
  - Happy path.
  - Boundary values / edge cases.
  - Error / failure cases.
  - Permission denial cases (where `org_id` mismatch or missing role
    should be rejected).

Rules per test runner:

**forge-app (Jest)**:
- `jest.mock(...)` declarations before any `require()` calls.
- `jest.clearAllMocks()` in `beforeEach`.
- Mock `@forge/api` and `@forge/kvs` — never call real Forge APIs
  in unit tests.

**ai-server (Jest)**:
- `jest.mock(...)` declarations before any `require()` calls.
- `jest.clearAllMocks()` in `beforeEach`.
- Mock `supabase-client.js` using `jest.mock('../db/supabase-client')`.
- Mock `openai` SDK for any AI-touching tests.
- Use `supertest` for controller-level tests.

**python-desktop-app (pytest)**:
- `pytest.fixture` for shared setup.
- Mock `requests` and Supabase client calls with `unittest.mock.patch`.
- Import under test via full package path
  (for example: `from ocr.facade import OCRFacade`).

### 9.2 Integration tests

- **forge-app + AI server**: if this feature adds a new Forge Remote
  call, add an integration test in
  `tests/resolvers/<feature>.integration.test.js` (excluded from
  default `npm test` run — requires a running AI server).
- **ai-server + Supabase**: list any new `tests/services/e2e-*.test.js`
  scenarios covering this feature against a real Supabase test
  instance.
- **Desktop app**: list any integration test that requires OS
  environment (file system, keyring, tray).
- **Notification integration**: if this feature fires notifications,
  assert that `notification-service.js` is called with the correct
  event type and `orgId`/`userId`. Mock `notifme-wrapper.js` — do
  not make real SMTP/SendGrid calls in this feature's tests.
  See §13.5.

### 9.3 End-to-end tests (vertical slices)

- Full flows that cross multiple components, for example:
  - Desktop app uploads activity → AI server analyses → Forge app
    displays updated analytics.
  - User assigns unassigned work in Forge → worklog created in Jira
    → worklog sync confirms.
- Describe how these will be tested (manual, automated, Playwright).

---

## 10. Interaction diagrams

Every significant flow in this feature must have a numbered sequence
diagram. The minimum required diagrams per plan are:

- **Happy path** — primary success flow, end to end.
- **Error / failure path** — what happens when a dependency fails
  (Supabase error, OpenAI timeout, Jira API error, Forge context
  missing).
- **Notification dispatch flow** — if this feature fires
  notifications, include a dedicated sequence (see §13). This
  counts as one of the required diagrams.

Each diagram must show **all layers crossed** by the flow.
Use this layer reference for every sequence:

```
React component (static/main/ or static/settings/)
  → @forge/bridge invoke()
    → Forge resolver (resolvers/<feature>Resolvers.js)
      → Service (services/<featureService>.js)
        → Supabase query (utils/supabase/*.js)        ← forge-app direct reads
        → Forge Remote (utils/remote.js)
          → AI server controller (controllers/<feature>-controller.js)
            → AI server service (services/<feature>-service.js)
              → DB service (services/db/<feature>-db-service.js) → Supabase
              → AI service (services/ai/index.js) → OpenAI GPT-4o
              → Notification service (services/notifications/notification-service.js)
                → notifme-wrapper.js → SMTP / SendGrid
Forge scheduled trigger (manifest.yml scheduledTrigger)
  → services/scheduledWorklogSync.js → Jira REST API
Supabase Edge Function (functions/<name>/)
  → Supabase DB insert
Desktop app (desktop_app.py)
  → OCRFacade → PrivacyFilter → Supabase Edge Function
```

Do not skip layers in a diagram. If a layer is not crossed by a
specific flow, explicitly note it rather than omitting it silently.

A plan with fewer than two sequence diagrams (happy path + at least
one failure path) will not be approved in review.

---

### Example flow: user assigns unassigned work to a Jira issue

**10.1 Happy path**

1. User opens **Unassigned Work** tab in the Forge app.
2. `GroupAccordion` renders cluster; user clicks **Assign**.
3. `AssignmentModal` calls
   `@forge/bridge invoke('assignToExistingIssue', { groupId, issueKey })`.
4. Forge resolver `unassigned/assignmentResolvers.js` receives call.
5. Resolver calls `workAssignmentService.assignToIssue(orgId, userId, groupId, issueKey)`.
6. `workAssignmentService.js` validates issue key exists in
   `user_jira_issues_cache`.
7. Service calls `utils/supabase/` to update
   `unassigned_work_groups.assigned_issue_key = issueKey`.
8. Service calls `worklogService.createWorklog(...)`.
9. `worklogService.js` calls Jira REST API `POST /rest/api/3/issue/{key}/worklog`.
10. Jira returns `201`; worklog ID stored in Supabase
    `activity_records.jira_worklog_id`.
11. Resolver returns `{ success: true, worklogId }`.
12. `AssignmentModal` closes; `GroupAccordion` removes the assigned group.

**10.2 Failure path: Jira API rejects worklog**

1–9. Same as happy path.
10. Jira returns `403 Forbidden` (user lacks `EDIT_ISSUES` permission).
11. `worklogService.js` throws `JiraPermissionError`.
12. Resolver catches error; returns `{ error: 'JIRA_PERMISSION_DENIED' }`.
13. `AssignmentModal` displays inline error; group remains unassigned.
14. No Supabase write for worklog ID. `unassigned_work_groups` row unchanged.

---

## 11. Risks, edge cases, and open questions

### 11.1 Risks

- Technical risks:
  - Forge execution time limit (900 s for scheduled handlers,
    shorter for resolvers) — identify if any new flow is at risk.
  - Supabase rate limits or row limits for new polling queries.
  - OpenAI API latency or cost increase if new prompt is longer.
  - OCR accuracy impact if new pre-processing step changes image
    quality.
- Security risks:
  - New surface for `org_id` leakage if query lacks filter.
  - New endpoint without correct auth middleware.
  - New log statement that might capture PII or token values.

### 11.2 Edge cases

- `org_id` resolution fails (new org, first install, race condition).
- Jira issues cache is stale or empty when the feature reads it.
- Desktop app is offline when a sync is triggered.
- User is a member of multiple Jira cloud instances (multi-org).
- Partial failure: Supabase write succeeds but Jira API call fails —
  describe rollback or retry strategy.
- Sub-minute worklog durations (< 60 s) — confirm whether they should
  be skipped or rounded.

### 11.3 Open questions

- Questions needing input from product, management, or other teams.
- Mark any open issues that block final sign-off of this plan.

---

## 12. Rollout and feature flagging

- **Feature flag**: if the change is user-visible, gate it behind a
  boolean in `DEFAULT_SETTINGS` (Forge KVS) or an `org_settings`
  column so it can be toggled without a code deploy.
- **Additive-only rule**: new resolver names, new API paths, new DB
  columns only. Do not rename or remove existing ones in the same
  plan.
- **Deploy order** for multi-component changes:
  1. Supabase migration (`supabase db reset` / apply on production).
  2. AI server deploy (Docker image → `forgesync.amzur.com`).
  3. Forge app build and deploy (`npm run build && forge deploy`).
  4. Desktop app build and distribute if applicable (`build.bat`).
- **Rollback**:
  - Supabase: add a reversal migration (new `.sql` file); never edit
    existing migrations.
  - AI server: redeploy previous Docker image tag.
  - Forge app: `forge deploy` with previous revision.
  - Desktop app: keep previous installer in `app_releases` table;
    users can downgrade via download link.

---

## 13. Notification events

> This section is **mandatory** for every plan that fires
> notifications. If this feature fires no notifications, write:
> "No notification events for this feature." and stop.
>
> Incomplete or missing Section 13 blocks plan approval.
>
> All notification dispatch must go through
> `notification-service.js`. Do not call `notifme-wrapper.js` or
> template files directly from controllers or services outside the
> `notifications/` module.

### 13.1 Events fired by this feature

List every notification event this feature introduces or modifies.
For each event:

- **Event name**: the string identifier used internally
  (for example: `'inactivity_alert'`, `'approval_pending_digest'`).
- **Trigger**: the exact domain action that causes the notification
  (for example: "user has no activity records for 2+ work days").
- **Recipient(s)**: who receives the notification (for example: the
  inactive user; the org admin; all members of the org).
- **Key payload fields** passed to `notification-service.js`.

Example:

| Event | Trigger | Recipient | Key payload fields |
|---|---|---|---|
| `approval_pending_digest` | Worklog approval request created and no action for 24 h | Approver (admin/manager) | `orgId`, `approverId`, `pendingCount`, `oldestRequestAge` |
| `new_version` | New row inserted in `app_releases` | All users with desktop app | `orgId`, `userId`, `version`, `downloadUrl` |

### 13.2 Template requirements

For each event in §13.1, specify:

- **Existing template** in `ai-server/src/services/notifications/templates/`
  that will be reused, **or** new template file to be created.
- **Key variables** the template receives from the payload context.

If all events use existing templates, write:
"No new templates required — all events use existing templates."

If new templates are needed, list:
- Template filename (for example: `feature-alert.js`).
- Export shape:
  ```js
  module.exports = {
    subject: (ctx) => `...`,
    html: (ctx) => `...`,
    text: (ctx) => `...`
  };
  ```
- Key context variables.

### 13.3 Dispatch call location

For each event in §13.1, specify:

- **File** where `notification-service.dispatch(...)` (or equivalent)
  is called.
- **Function** that makes the call.
- **Timing**: synchronous after the triggering DB write, or inside
  `notification-polling.js` on the next poll cycle.

Example:

- `approval_pending_digest` → dispatched inside
  `notification-polling.js` `checkPendingApprovals()` on the
  scheduled poll cycle, after querying `approval_requests` for
  rows older than 24 h.

### 13.4 Cooldown and deduplication

- **Cooldown period**: how long before the same notification type
  is re-sent to the same user (reference `notification_tracking`
  table).
- **Deduplication key**: fields used to identify a duplicate
  (for example: `orgId + userId + eventType`).
- Any new columns needed in `notification_tracking` to support
  this event's cooldown logic.

### 13.5 Notification integration test requirement

For each event in §13.1, add a test in this feature's test file
that:

- Triggers the domain action (mock Supabase responses as needed).
- Asserts that `notification-service.js` (or
  `notification-polling.js`) is called with the correct event
  type, `orgId`, `userId`, and key payload fields.
- Mocks `notifme-wrapper.js` — do not make real SMTP or SendGrid
  calls in this feature's tests.

> Provider-level delivery tests (real SMTP / SendGrid sandbox
> calls) are the responsibility of
> `tests/services/notifications/notifme-wrapper.test.js` and are
> not duplicated in feature-level tests.
