# Plan: Non-Jira user tracking via Google SSO (company-domain self-signup)

> Status: **Approved — implementation in progress (2026-05-29).**
> Author: prepared for manager review, 2026-05-29.
>
> **Prerequisite (load-bearing):** "Sign in with Google" only works if the company's email is on
> **Google Workspace** (so `@company.com` addresses are real Google accounts). If the company runs
> email on Microsoft 365 / Outlook, this Google-SSO approach does not fit — switch to Microsoft/Entra
> SSO or email+password instead. Implementation assumes Google Workspace.

## Context

Today the desktop tracker authenticates **only** via Atlassian OAuth (3LO). Employees without a
Jira account (HR, other teams) therefore cannot log in or be tracked at all. The goal is to let
those employees **sign in with their company Google account** and have their time tracked exactly
like Jira users, minus the Jira-specific outputs (which are impossible without a Jira account).

The whole downstream pipeline (`upload_activity_batch`, RLS inserts, polling/AI classification,
team analytics) only needs three things populated at login: `current_user_id`, `organization_id`,
and a valid **Supabase JWT**. So we add a second login path that produces those three things from a
Google identity instead of an Atlassian one — the rest of the pipeline is unchanged.

### Data scope for these users (clarified with user)
We need: **which application they're working in**, the **on-screen context** (window title + OCR
text), **an AI analysis of that OCR/context describing *what they are working on***, and **productive
vs non-productive** time. We do **NOT** need Jira **issue matching** for them.

Key distinction: **AI analysis = YES, AI issue-matching = NO.** The AI must read the (privacy-
redacted) OCR text + window title + app and produce a short description/summary of the activity
("what is this person doing"), but it must **not** map that to a Jira issue key.

- ✅ Tracking, OCR + PII redaction, **AI analysis of OCR/context → an activity description** (what
  they're working on), **productive/non-productive/private classification** (baseline decided locally
  by `AppClassificationManager`), idle detection, time totals, offline sync, and visibility to admins
  in the **Web Portal** (and Forge team analytics, since they share the org).
- ❌ AI **issue matching** to Jira (`taskKey` always null), worklog sync, and the in-Jira Forge panel.
  Skipped, not broken.
- **The AI pipeline IS used for these users** — but in a *describe-the-activity* mode, not a
  *match-to-issue* mode (see ai-server §2). An empty `user_assigned_issues` is the natural trigger.

## Decisions (locked with user)
- **Auth method:** Google SSO only.
- **Provisioning:** self-signup; **restricted to an allowed company email domain**.
- **Org:** non-Jira users join the **same** organization as that company's Jira users.

## Key design point — domain → org mapping
Google SSO proves *who* the user is, not *which org* they belong to. So an org registers its company
email **domain** (e.g. `amzur.com`) **once** — not a list of employee emails. To minimize friction,
the Forge settings page **auto-derives the domain from the installing/admin user's own Atlassian
email** (Forge context provides it) and the admin just **confirms** it (they can add more domains for
multi-domain orgs). At signup the ai-server resolves `email domain → organization_id`; unregistered
domains are rejected with a clear message. Domains are globally unique (one domain → one org).

The domain allowlist does double duty: it (a) routes a Google user to the correct org and (b) enforces
"company email only" self-signup — both are required for a multi-tenant Marketplace product.

---

## Changes by component

### 1. Database — new migration `supabase/migrations/YYYYMMDD_add_non_jira_google_auth.sql`
(Never edit existing migrations; add a new one. New table gets RLS with an org policy.)

- `users`:
  - `ALTER COLUMN atlassian_account_id DROP NOT NULL` (Google users have none; existing UNIQUE
    constraint already tolerates multiple NULLs in Postgres).
  - `ADD COLUMN auth_provider text NOT NULL DEFAULT 'atlassian' CHECK (auth_provider IN ('atlassian','google'))`.
  - `ADD COLUMN google_sub text` (stable Google subject id) + **partial `UNIQUE` index on `google_sub`
    `WHERE auth_provider = 'google'`**. This is the dedup key for Google users.
  - **Do NOT add an email-unique index** (code-review #7): `users.email` has no unique constraint
    today and may already contain duplicates, so adding one risks failing on existing data. Dedup on
    `google_sub` instead. Allowing the same email to exist as both an Atlassian row and a Google row
    is acceptable (two different login methods); we key identity on `google_sub`, not email.
- New table `org_email_domains (id uuid pk, organization_id uuid fk → organizations on delete cascade,
  domain text NOT NULL, created_at)` with a **`UNIQUE` index on `lower(domain)`** — avoids the `citext`
  extension dependency (code-review #1: `citext` is **not** enabled in this project; it would need
  `create extension citext with schema extensions`). `text` + `lower()` matches how the codebase
  already normalizes (`lower(email)`). RLS enabled:
  - service_role full access — **the domain row is written server-side via the service role** (Forge
    admin → ai-server proxy), so there is intentionally **no user-level INSERT policy** (code-review #4);
  - authenticated org members may `SELECT` rows for their own org (mirrors existing `*_select_org`
    policies in the schema).

### 2. ai-server
- **New endpoint** `POST /api/auth/desktop-google` in a new `controllers/google-auth-controller.js`
  (or extend `auth-controller.js`). Flow, mirroring `exchangeToken` (auth-controller.js:572) and the
  portal Google flow (`portal-auth-controller.js` `googleCallback`):
  1. Receive `{ code, redirect_uri, code_verifier }` from the desktop. **PKCE is used** (code-review
     #3): forward the `code_verifier` to Google's token endpoint, same as the Atlassian flow. The
     Google **client secret is optional** for a Desktop client (code-review #2) — PKCE is the real
     protection; include the secret if configured.
  2. Exchange code → Google tokens; **verify the `id_token`** (signature, `aud` = our client id,
     `email_verified === true`). Reuse the verification approach already in `portal-auth-controller`.
  3. Extract `email`, `sub`, `hd` (hosted domain). Resolve `organization_id` via `org_email_domains`
     using `lower(domain)`. **Domain check (code-review #5):** require `email_verified === true` AND
     the domain is allowlisted; for Google **Workspace** accounts prefer the `hd` claim as the
     authoritative domain (fall back to the email's domain when `hd` is absent, e.g. non-Workspace).
     If no allowlisted match → `403` "Your company hasn't enabled non-Jira access."
  4. Find-or-create the `users` row (`auth_provider='google'`, `google_sub`, `email`,
     `organization_id`, `supabase_user_id = id`) + `organization_members` row (role `member`) —
     reuse helpers in `services/db/user-db-service.js` and the membership pattern in
     `forge-proxy-controller.js` `ensureOrganizationMembership`.
  5. **Mint the Supabase JWT identically** to `exchangeToken` (same `jwt.sign` payload shape:
     `sub = users.id`, `app_metadata.org_id`, `role: authenticated`, HS256, `SUPABASE_JWT_SECRET`).
  6. Return `{ supabase_token, expires_in, organization_id, user_id, email, display_name }` (same
     shape the desktop already consumes from exchange-token).
- Register the route in `src/index.js` under the public auth block with `authLimiter`/`oauthLimiter`.
- **DB service:** add `getOrgIdByEmailDomain(domain)` and `findOrCreateGoogleUser(...)` to
  `services/db/user-db-service.js`.
- Reuse existing Google OAuth env vars already used by `portal-auth-controller` (add a dedicated
  desktop client id/secret if a loopback redirect requires a separate Google "Desktop" client — see
  Prerequisites).

- **Activity-analysis ("describe") mode — the key AI change for these users.** Google users' productive
  records still flow through `analyze-batch` (`status='pending'`), so we get AI on them — but the AI
  must *describe the activity*, not match a Jira issue. In `activity-service.js`
  (`buildBatchAnalysisPrompt` / `analyzeBatch`), branch on **empty `user_assigned_issues`**:
  - **Matching mode** (issues present — today's behavior, unchanged): returns `taskKey`, `workType`,
    `confidenceScore`, short `reasoning`.
  - **Describe mode** (no issues — Google users): a prompt that reads window title + app +
    (sanitized) OCR text and returns a concise **activity description / summary** of *what the user is
    working on* (e.g., "Editing onboarding deck in Google Slides", "Reviewing Q3 budget in Sheets") and
    optionally a coarse **activity category** — with **`taskKey` forced to `null`** (no fabrication).
  - Persist the description into `activity_records.metadata` (e.g. `metadata.activitySummary` /
    `activityCategory`) via `updateActivityRecordAnalysis` — **jsonb, no schema change needed.** The
    Portal reads it to show "what they're working on" per session.
  - Server-side OCR sanitization (`sanitizeOcrText`) and the existing CRITICAL TASK KEY RULE still
    apply; describe mode just omits the issue list and changes the output shape.

### 3. forge-app — admin registers company domain(s)
- Add a small "Allowed company email domains (non-Jira tracking)" field to the **settings** admin UI
  (`static/settings/src/App.js`) and a resolver in `src/resolvers/settingsResolvers.js` +
  `services/settingsService.js` that writes `org_email_domains` through the existing AI-server proxy
  (`utils/remote.js` → `forge-proxy-controller.supabaseQuery`). This is the only new admin surface and
  is a one-time config per org.

### 4. python-desktop-app — add the Google login path
- **Login UI:** in `render_login_page` (desktop_app.py ~11823) add a "Sign in with Google
  (no Jira account)" button alongside the existing Atlassian button.
- **Routes (`setup_routes`, ~5634):** add `/auth/google` and `/auth/google/callback`. Use the
  **loopback IP redirect `http://127.0.0.1:{web_port}/auth/google/callback`** — **not `localhost`**
  (code-review #2: Google's native-app docs require/recommend the loopback IP; `localhost` is
  discouraged). Generate and store a **PKCE `code_verifier`** for the Google flow, reusing the S256
  infrastructure already in `AtlassianAuthManager.get_auth_url()` (code-review #3). The callback
  receives `code`, POSTs `{ code, redirect_uri, code_verifier }` to ai-server
  `/api/auth/desktop-google`, and on success stores the returned Supabase token + org/user ids in
  `auth_manager.tokens` (reuse the same keys the Atlassian path uses: `supabase_token`,
  `supabase_token_expires_at`, `exchange_organization_id`, `exchange_user_id`).
- **Auth manager:** add an `auth_provider` attribute + a `google` branch to `AtlassianAuthManager`
  (single object, branch inside — keeps the Atlassian path byte-for-byte unchanged; see Hotspot #1).
  Token persists via the existing `SecureTokenStorage` (auth/secure_storage.py), which is already
  provider-agnostic.
- **Token refresh (code-review #6 — required, not optional):** the Supabase JWT expires in 1h and is
  refreshed on the hot upload path via `get_valid_supabase_token()` → `get_supabase_token()`, which
  today re-exchanges the **Atlassian** access token. Add a Google branch: store `google_refresh_token`
  (add it to `SENSITIVE_TOKEN_KEYS`), and on refresh POST it to ai-server (which calls Google's token
  endpoint with the client secret server-side) to get a fresh Google token, then re-mint the Supabase
  JWT via `/api/auth/desktop-google`. Without this, Google sessions silently stop uploading after ~1h.
  (Google returns refresh tokens automatically for Desktop/installed clients.)
- **Post-login sequence:** after Google login, call `initialize_supabase()` + `_set_supabase_jwt()`
  (both already populate `current_user_id`/`organization_id` from the exchange response — they work
  unchanged), set `self.current_user = {account_id: <users.id>, email, name, auth_provider:'google'}`
  so the consent flow and tracking loop function, then **guard the Jira-only steps** so they no-op
  for `auth_provider == 'google'`: `register_organization`, `fetch_jira_issues`,
  `fetch_jira_projects`, `get_jira_cloud_id`, worklog sync, and issue-cache refresh.
- **No change to `upload_activity_batch` status logic:** productive records stay `status='pending'`
  so they **do** flow through the AI — which runs in *describe mode* (ai-server §2) because
  `user_assigned_issues` is empty for Google users. `tracking_loop`, classification, and offline sync
  are unchanged (they key on `current_user_id`/`organization_id`/JWT). Result: app + window/OCR
  context + **AI activity description** + productive/non-productive + time. (taskKey is always null —
  the AI describes, it doesn't match.)

---

## Prerequisites / config (not code) — verified against Google native-app docs
- Create a dedicated Google OAuth client of type **"Desktop app"** (not "Web application"). Per
  Google's native-app docs: the redirect must be the **loopback IP `http://127.0.0.1:{port}`** (or
  `[::1]`); **`localhost` is discouraged** ("may cause issues with client firewalls"). The **client
  secret is optional** for Desktop clients — PKCE is the required protection. Set the client id (and
  secret if used) in the ai-server `.env`.
- Loopback Desktop clients accept a **dynamic port**, so the exact port need not be pre-registered;
  we'll reuse the existing fixed `web_port` for consistency with the Atlassian flow.

## Security considerations
- Verify the Google `id_token` (signature + `aud` + `email_verified`); never trust the email blindly.
- Enforce the domain allowlist server-side — this is what prevents arbitrary Google users from
  joining an org. Reject unverified emails and unregistered domains.
- Mint the Supabase JWT with the resolved org only (no cross-org access); reuse the exact payload
  shape from `exchangeToken`.
- Rate-limit `/api/auth/desktop-google` (reuse `oauthLimiter`).
- This path never touches Atlassian, so it adds **zero** Atlassian-Marketplace/OAuth compliance
  surface — but the data handling is fully your responsibility (already covered by your privacy policy).

## Verification (spec-driven: write failing tests first, per repo workflow)
- **ai-server (Jest, `tests/controllers/`):** new `google-auth-controller.test.js` — mocks Google
  token verification; asserts (a) valid company-domain login mints a JWT with `sub=users.id` and the
  resolved `org_id`; (b) unregistered domain → 403; (c) unverified email → 401; (d) repeat login
  re-uses the same `users` row (idempotent by `google_sub`).
- **db:** apply the migration on a local Supabase (`supabase db reset`) and confirm a Google `users`
  row inserts with `atlassian_account_id NULL` and RLS still scopes by org.
- **desktop (pytest):** unit-test the post-login guard that skips Jira-only steps when
  `auth_provider=='google'`; that a Google session produces a batch insert into `activity_records`
  with the right `organization_id`/`user_id` and productive records `status='pending'` (extend
  existing batch tests in `test_batch_*`/`test_existing_data_upload.py`).
- **ai-server describe mode (Jest):** with empty `user_assigned_issues`, `analyzeBatch` returns
  `taskKey=null` for every record and writes a non-empty `metadata.activitySummary` describing the
  activity (no fabricated issue keys).
- **End-to-end manual:** register `yourcompany.com` for the org in Forge settings → run desktop →
  "Sign in with Google" with a company account → confirm tracking, a batch upload, and that the user
  appears in Portal/team analytics; sign in with a non-company Google account → confirm rejection.

## Out of scope (this change)
- Jira issue matching, worklog sync, and the in-Jira Forge panel for these users (impossible without
  a Jira account).
- Email/password and admin-invite provisioning (Google SSO self-signup chosen instead).

## Required follow-up (design now, build as fast-follow)
- **GDPR deletion for Google users (code-review #8):** the Forge `personalDataHandler` only fires for
  Atlassian account IDs, so Google users are **not** covered by Atlassian's data-deletion events. We
  must provide our own deletion path (portal- or desktop-triggered, delete-by `user_id`). The data
  model already supports it; the endpoint is the follow-up. This is a compliance obligation — track it,
  don't drop it.

---

## Atlassian policy compliance (verified against Atlassian docs, 2026-05-29)

**Verdict: permitted — not prohibited, with clear precedent.** The non-Jira Google-SSO path runs
entirely on our desktop app + Google + our Supabase + our AI server, touching **no Atlassian API and
no Jira data**. Atlassian's rules govern the Forge app, the handling of Atlassian/Jira data, the
Marketplace listing, and our OAuth integration — a login path that touches none of those is outside
Atlassian's scope, and nothing in their policies forbids it.

What was checked in the actual policy text:
- **No rule requires app users to be Atlassian users**, and no rule prohibits serving non-Atlassian
  users. The app-approval guidelines only require the app to "perform as described" and not break the
  host UI.
- **No rule requires every feature to integrate Atlassian.** Adding a non-Jira capability to our
  companion app violates nothing.
- **Third-party-account rule (the one condition that applies):** *"If your app listing is free,
  ensure your app provides some useful function in the Atlassian app 'as is'. If your app requires a
  separate third-party account this must be clear…"* Our Forge/Jira app already provides standalone
  value to Jira users (analytics + worklogs), so we satisfy this — we simply must **disclose** that
  non-Jira tracking requires a Google account.
- **Acceptable Use Policy does not prohibit monitoring / time tracking / screen capture.** It governs
  conduct *within Atlassian's own services* (no scraping, no harvesting personal data *from*
  Atlassian, no AI inference *through* Atlassian) — none of which our independent Google path does.
- **Precedent:** Monitask ("Time Tracking for Jira with Monitask") and "Time Tracking and
  Productivity Monitoring For Jira" are approved listings whose desktop trackers run with their own
  separate accounts, independent of Jira membership. Same pattern as ours.

**Conditions we must keep meeting (none are blockers):**
1. The Forge/Jira app keeps providing standalone value to Jira users (already true).
2. Disclose in the listing + at install that non-Jira tracking uses Google sign-in.
3. The non-Jira path must never pull in Atlassian/Jira data for those users (the design keeps it
   Jira-free — see the §4 "guard Jira-only steps" item).
4. Our own privacy policy, EULA, consent flow, and GDPR handling must cover these users — Atlassian
   makes this the developer's responsibility, not theirs.
5. Employee-monitoring legality (consent/notice) is on us under local employment/privacy law — not an
   Atlassian rule, but a real obligation.

**Honest caveat:** there is no clause that *explicitly* says "you may serve non-Atlassian users" —
the conclusion rests on absence of any prohibition + matching approved precedent + the path being
outside Atlassian's platform. That is a strong basis but is "not prohibited," not "blessed in
writing." Recommend confirming with **Atlassian Developer Support / our Marketplace partner manager**
before launch for an on-the-record answer.

Sources: App approval guidelines; Atlassian Acceptable Use Policy; Marketplace Partner Agreement;
Atlassian Developer Terms; Security requirements for cloud apps; Monitask & "Productivity Monitoring
for Jira" Marketplace listings.

---

## Notes for reviewers / manager
- **One unavoidable admin step:** even with self-signup, an admin must register the company email
  domain → org **once** (otherwise Google SSO cannot know which org to place users in). Captured above
  as a small Forge settings addition.
- **Scope reality:** for these users this is a pure time/productivity tracker — no Jira task
  attribution or worklog sync. The only way to get those is a Jira account.
- **Google client type:** a dedicated Google **"Desktop app"** OAuth client with a **`127.0.0.1`
  loopback** redirect is required (confirmed against Google's native-app docs); coordinate with
  whoever manages the Google Cloud project.

## Code-review corrections applied (2026-05-29)
A code review of an earlier draft raised 8 points; each was independently verified against Google's
official native-app docs, Supabase docs, and our actual schema. Outcome:
1. **citext** — valid; resolved by using `text` + `UNIQUE(lower(domain))` instead (no extension needed).
2. **127.0.0.1 not localhost + "Desktop app" client** — valid (Google docs); applied. (Note: client
   secret is *optional*; PKCE is the real requirement.)
3. **PKCE for Google** — valid; reuse the existing S256 `code_verifier` infrastructure; applied.
4. **`org_email_domains` INSERT via service role only** — valid/minor; documented (no user policy).
5. **`hd` claim** — valid with correction: for Workspace, `hd` is the *primary* signal (+ `email_verified`),
   email-domain is the fallback; applied.
6. **Supabase JWT refresh for Google** — valid/important; explicit `google_refresh_token` refresh path
   added (kept 1h JWT + refresh, rather than a longer-lived token).
7. **email uniqueness** — valid, and bigger than flagged: `users.email` has no unique constraint and may
   have dupes, so we **dedup on `google_sub`** and add **no** email-unique index.
8. **GDPR deletion for Google users** — valid; captured as a required follow-up above.

Plus a scope clarification from the product owner: Google users **do** need AI analysis — but to
**describe what they're working on** (from OCR/window/app), **not** to match a Jira issue. So their
productive records still flow through `analyze-batch` in a new *describe mode* (empty issue list →
`taskKey=null` + `metadata.activitySummary`); AI issue-matching, worklog sync, and the Forge panel
remain out of scope.
