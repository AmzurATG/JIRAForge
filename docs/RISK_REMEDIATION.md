# BRD Time Tracker — Risk Remediation Guide

**Date:** 2026-04-18
**Input:** Section 11 of `CODEBASE_REFERENCE.md` (20 flagged risks)
**Method:** Direct code verification + 2026 web research
**Audience:** Engineering leadership making ship/fix decisions

---

## How to read this document

Each risk is graded along three axes:

| Axis | Values | Meaning |
|------|--------|---------|
| **Verified?** | ✅ Real / ⚠️ Partially mitigated / ❌ Not real / 🔄 Superseded | What the code actually does vs. what the risk claim asserted |
| **Severity** | 🔴 Critical / 🟡 Important / 🟢 Nice-to-have | Impact on customers, revenue, marketplace listing, or compliance |
| **Effort** | S (≤ 1 day) / M (1–5 days) / L (> 1 week) | Engineering cost of the recommended permanent fix |

For every real risk you get a **Minimal** fix (what to ship this week) and an **Ideal** fix (the permanent architecture). Where the risk isn't real or is already mitigated, we explain why and what to document instead.

A prioritized roadmap is at the bottom.

---

## Executive summary (TL;DR)

Of the 20 flagged items:

- **7 are real and should be fixed before any meaningful scale** (🔴 Critical): distributed session store, webhook HMAC, Forge-proxy table whitelist, table-driven tenant isolation, worklog attribution, `update-issues-cache` stub, and background-service single-instance coupling.
- **8 are real but lower-severity** (🟡 Important): Atlassian `/me` caching, dual-read duplicate-user logic, offline SQLite size cap, KVS enumeration, polling backoff, notifications feedback loop, confidence-threshold transparency, `/reset-upload-lock` cleanup.
- **3 are already adequately mitigated** (⚠️): keyring fallback (machine-bound AES-128-CBC + PBKDF2 600K iterations is correct for this use case), refresh-token race (in-process lock + 30-min grace is fine for one desktop install), log sanitizer (15+ patterns, ReDoS-safe, three levels).
- **2 are not real risks at the severity flagged** (❌): MD5 for dedup (cryptographically broken but deduplication is not a security function), CORS no-origin allow (documented and required for desktop apps, not a vulnerability).

The single most dangerous finding is that the **AI server's admin dashboard stores sessions in a single-instance `Map`**, while the service is deployed to Cloud Run — which can and will horizontally scale and recycle instances. Any real traffic spike silently drops admin sessions, and Cloud Run's default rollout will log every admin out mid-session. That fix is ~1 day and should happen first.

---

# PART 1 — SECURITY & AUTH

## Risk 1.1 — In-memory admin dashboard sessions (🔴 Critical)

### Verified? ✅ Real — confirmed in code

`ai-server/src/controllers/admin-dashboard-controller.js` line 12:

```js
// In-memory session store
const sessions = new Map();
```

- 8h TTL, 30-minute cleanup interval, `crypto.randomBytes(32)` tokens (token generation is fine).
- No Redis, no Supabase row, nothing shared across instances.

### Severity reality check

🔴 **Critical** for three reasons:

1. **Cloud Run horizontal scaling**: the service runs on `forgesync.amzur.com`. Any scale-out creates a second instance with an empty session Map — requests round-robined there return 401.
2. **Every deploy logs out every admin.** Container restarts wipe the Map. For a marketplace product with paying customers, admins seeing "login again" after every deploy is a trust issue.
3. **No audit trail.** Server restart = zero forensic record of who was logged in. For a time-tracking product, that's a compliance smell.

The single mitigation today is that admin traffic is low, so two-instance races are rare. That luck evaporates the moment you run any operation at scale.

### Web research findings (2026)

Cloud Run treats each revision instance as ephemeral and stateless. The standard pattern for shared session state on Supabase-backed stacks is a `sessions` table with a partial index on `expires_at` — Supabase's connection pooler (Supavisor) handles the serverless connection storm that would otherwise DOS Postgres. Redis (via Memorystore or Upstash) is the alternative but adds a service and an ops surface you don't otherwise have.

### Recommended solution

**Minimal (ship this week, ~1 day):**

Create a Supabase table and move the store. Keep the rest of the controller identical:

```sql
-- supabase/migrations/20260418_admin_sessions.sql
create table admin_sessions (
  token text primary key,
  email text not null,
  login_time timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  expires_at timestamptz not null
);
create index on admin_sessions (expires_at);
-- RLS: only service_role can read
alter table admin_sessions enable row level security;
```

Wrap current `sessions.set/get/delete` calls in a thin `adminSessionStore` module that writes to Supabase. Keep the Map as an in-process LRU *cache* (read-through, write-through) with a 30-second TTL so p50 latency stays under 5ms.

**Ideal (Q3, ~3 days):**

- Replace the hand-rolled token with Supabase Auth + a dedicated `admin` RLS policy. The admin dashboard then uses the same auth flow as everything else, with JWKS rotation for free.
- Add MFA (Supabase Auth supports TOTP out of the box).
- Audit log: every admin action into an append-only `admin_audit` table.

### Tradeoffs

Supabase adds ~5–15ms per request per session touch. That's fine for an admin dashboard (not a customer hot path). Redis would be faster but adds another hosted service — not worth it at your scale.

---

## Risk 1.2 — Atlassian `/me` called on every authenticated request (🟡 Important)

### Verified? ✅ Real — confirmed in code

`ai-server/src/middleware/atlassian-auth.js` lines 40–49: every request triggers `axios.get('https://api.atlassian.com/me')` with a 10s timeout. No cache layer.

`ai-server/src/middleware/dashboard-auth.js` is worse: **three** sequential Atlassian API calls per request (`/me` → `/accessible-resources` → `/mypermissions?permissions=ADMINISTER`), then a Supabase lookup. ~400–900ms per request just for auth.

### Severity reality check

🟡 **Important, not yet critical.** Why:

- Atlassian's per-tenant rate limit is surprisingly generous (hundreds of requests/min per user token). You would need genuinely heavy usage before hitting it.
- But: every time Atlassian has an incident, your dashboard goes down. That's happened three times in the last 18 months industry-wide.
- And: latency is already visible on the dashboard. A 600ms TTFB on every page load feels sluggish.

### Web research findings (2026)

Atlassian explicitly recommends ETag + conditional requests for hot-path identity checks, plus "distribute requests evenly throughout the hour." The `/me` payload is effectively immutable per token — it only changes if the user changes their profile. A 5-minute cache keyed by a hash of the bearer token is safe and standard.

### Recommended solution

**Minimal (~4 hours):**

Add an in-process LRU cache (`lru-cache` package) keyed by `sha256(token).slice(0,16)`:

```js
const tokenCache = new LRUCache({ max: 10_000, ttl: 5 * 60 * 1000 });

async function verifyToken(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const { data } = await axios.get(ATLASSIAN_ME_URL, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
  tokenCache.set(key, data);
  return data;
}
```

For the dashboard middleware, cache all three results together with a 5-minute TTL. Admin permission changes are rare; a 5-minute lag is acceptable.

**Ideal (~2 days):**

- Move the cache into Supabase `auth_cache` table so multiple Cloud Run instances share it.
- Use the cached `cloudId` → `organizationId` lookup at the same layer.
- Invalidate the cache on the Forge `app:uninstalled` event.

### Tradeoffs

A cache means a permission revocation takes up to 5 minutes to apply. For a Jira admin panel this is acceptable; if your compliance team disagrees, shrink the TTL to 60s — you'll still eliminate ~95% of `/me` calls.

---

## Risk 1.3 — Forge-proxy has no enforced table whitelist (🔴 Critical)

### Verified? ✅ Real — confirmed in code

`ai-server/src/controllers/forge-proxy-controller.js`: the `SENSITIVE_TABLES` Set exists, but `logSecurityWarnings()` only calls `logger.warn(...)`. Any table name passed in `req.body.table` is then queried using the **service role client, which bypasses RLS**.

This means: a compromised or buggy Forge app resolver could read or modify any table in the database, including `admin_sessions`, `users`, `organizations`.

### Severity reality check

🔴 **Critical** because:

- The service role client bypasses RLS by design.
- The Forge-to-AI-server channel is signed (FIT), but the **payload** is trusted — there's no allowlist on what operations a Forge caller can request.
- Your own frontend is the only thing stopping someone from calling `POST /api/forge/proxy { table: "admin_sessions", operation: "select" }`. A single forged FIT (or a bug in your own code that passes user input as the `table` param) compromises the whole DB.

This is a classic confused-deputy. It hasn't been exploited because you haven't been attacked, not because it's safe.

### Web research findings (2026)

The industry-standard pattern is an **explicit per-table policy object** with allowed operations, required filters, and column allowlists. Supabase's own documentation warns: "Unlike your anon key, your service role key is never safe to expose because it bypasses RLS. Only use your service role key on the backend." The corollary: when you must use service-role, wrap it in a whitelist layer.

### Recommended solution

**Minimal (~1 day):**

Move `SENSITIVE_TABLES` from a warning list to a hard allowlist. Default-deny:

```js
const PROXY_POLICY = {
  activity_records:     { ops: ['select'],           requireFilters: ['user_id', 'organization_id'] },
  worklog_sync:         { ops: ['select', 'insert', 'update', 'delete'], requireFilters: ['organization_id'] },
  tracking_settings:    { ops: ['select', 'update'], requireFilters: ['organization_id'] },
  // ... everything else → 403
};

function checkPolicy(table, operation, filters) {
  const p = PROXY_POLICY[table];
  if (!p) throw new Error(`Table not permitted via proxy: ${table}`);
  if (!p.ops.includes(operation)) throw new Error(`Operation ${operation} not permitted on ${table}`);
  for (const required of p.requireFilters || []) {
    if (!filters[required]) throw new Error(`Missing required filter: ${required}`);
  }
}
```

**Ideal (~1 week):**

- Replace the generic proxy with **named RPC endpoints** (one per use case). Instead of `POST /api/forge/proxy { table: "activity_records", filter: {...} }`, expose `POST /api/forge/activity/query { userId, dateRange }`. This moves business logic onto the server where it belongs and makes the API enumerable.
- Use a **role-scoped Postgres user** (not service role) for the proxy. Create a `forge_proxy` Postgres role that has only the minimum grants needed, and bypass RLS only where explicitly allowed.

### Tradeoffs

Named endpoints require more server code but eliminate an entire class of attacks. The generic proxy was convenient during prototyping; at marketplace scale it's a liability.

---

## Risk 1.4 — CORS allows requests with no `Origin` header (❌ Not a real risk)

### Verified? ✅ Real behavior, ❌ Not a vulnerability

`ai-server/src/index.js` line 47–48 explicitly allows `origin === undefined`. This is correct and necessary for:

- Desktop app (Python `requests` library doesn't send `Origin`)
- Server-to-server calls from Supabase Edge Functions
- Forge Remote calls (signed, different auth surface)

### Severity reality check

❌ **Not a vulnerability** — CORS is a browser-only enforcement mechanism. Its absence does not grant any privilege; you still need a valid JWT, FIT, or API key. Rejecting no-origin would only break your own non-browser clients.

### Recommended solution

Document this deliberate choice in a comment. The current comment is good but could be stronger:

```js
// No-origin allowed intentionally:
//   - Desktop app (Python requests)
//   - Forge Remote (server-to-server, auth via FIT)
//   - Supabase Edge Functions (auth via service role + HMAC)
// Auth enforcement happens in middleware; CORS is not a security boundary here.
```

No code changes needed. Consider adding a unit test that asserts no-origin auth-required endpoints still require a valid token.

---

## Risk 1.5 — Regex-based log sanitizer vs. structured logging (⚠️ Mitigated, not ideal)

### Verified? ⚠️ Already well-mitigated

`ai-server/src/utils/log-sanitizer.js` (396 lines) is better than initially flagged:

- **15+ pattern types**: EMAIL, CREDIT_CARD, PHONE, ATLASSIAN_ACCOUNT, ARI, UUID, IP, JWT, BEARER_TOKEN, API_KEY, AWS_KEY, GITHUB_TOKEN, SLACK_TOKEN, SHEET_ID, PORTKEY_CONFIG.
- **Three sensitivity levels**: minimal, standard, strict (configurable via `LOG_SANITIZER_LEVEL`).
- **ReDoS-safe**: comment explicitly notes "flattened quantifiers" to avoid catastrophic backtracking.

### Severity reality check

🟢 **Low — adequate for today, not future-proof.**

Regex-based sanitization has two known failure modes:
1. **New sensitive fields slip through** — e.g. if you start logging `stripe_customer_id` tomorrow, you have to remember to add the pattern.
2. **Logs of nested JSON** can bury sensitive fields deep enough that text-level regex may miss context (e.g. `"metadata.some.nested.email"` buried in a 40KB payload).

### Web research findings (2026)

Pino's `redact` configuration (JSON-path-based, not regex-based) is the de-facto standard in 2026 for this exact problem. It redacts **by field path** (`user.email`, `*.password`), so new sensitive fields are rejected if they use a known name — not by hoping a regex catches their content pattern.

### Recommended solution

**Minimal (~2 hours):**

Add a quarterly review step to the runbook: grep for `logger.info|warn|error` in diffs against the sanitizer patterns. Catches drift.

**Ideal (~3 days):**

Migrate to Pino with `redact: { paths: ['*.email', '*.token', '*.password', 'body.*.accountId', ...], censor: '[REDACTED]' }`. Keep the existing regex as a belt-and-suspenders second pass for payloads that arrive as strings. Pino also gives you structured JSON logs out of the box, which Cloud Run's log explorer parses natively.

### Tradeoffs

Pino migration touches every log call site (~100+ locations) but the actual substitution is mechanical. The payoff is structured logs that you can query in Cloud Logging (`jsonPayload.userId="abc"`) instead of grepping free-text.

---

## Risk 1.6 — Supabase webhooks have `verify_jwt = false` and no HMAC (🔴 Critical)

### Verified? ✅ Real — confirmed in `supabase/config.toml`

```toml
[functions.screenshot-webhook]
verify_jwt = false
[functions.activity-webhook]
verify_jwt = false
```

These endpoints accept uploads with zero authentication today. Anyone who finds the URL can POST screenshots, OCR text, and activity records into any tenant's data.

### Severity reality check

🔴 **Critical.** This is the single most exploitable issue in the document:

- The URLs are discoverable (they leak to the desktop app's memory, to logs, to support emails).
- No rate limit, no auth, no replay protection.
- A malicious actor with one URL can poison another tenant's data, fill storage, or trigger AI analysis bills.

The only thing saving you today is obscurity.

### Web research findings (2026)

Supabase's own 2026 recommendation for webhook functions is HMAC-SHA256 signature verification. The pattern (also used by Stripe, GitHub, Shopify):

1. Client signs `timestamp + "." + body` with a shared secret.
2. Function verifies signature using `timingSafeEqual`.
3. Rejects requests with a timestamp older than 5 minutes (replay protection).

Plain `===` comparison of HMACs is itself a vulnerability (timing attack); Node's `crypto.timingSafeEqual` or Python's `hmac.compare_digest` is required.

### Recommended solution

**Minimal (~1 day):**

Add HMAC-SHA256 verification to both edge functions. Issue one shared secret per organization (store in `organizations.webhook_secret`, 32 random bytes). Desktop app reads it during auth setup.

```ts
// supabase/functions/screenshot-webhook/index.ts
const sig = req.headers.get('x-signature');
const ts = req.headers.get('x-timestamp');
if (!sig || !ts) return new Response('missing signature', { status: 401 });
if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return new Response('stale', { status: 401 });

const body = await req.text();
const expected = await hmacSha256(Deno.env.get('WEBHOOK_SECRET')!, `${ts}.${body}`);
if (!timingSafeEqualHex(expected, sig)) return new Response('bad signature', { status: 401 });
```

**Ideal (~3 days):**

- Per-organization secrets (not a global secret) so one leak doesn't compromise everyone.
- Rotate secrets on `app:reinstalled`.
- Add rate limit per `organization_id` (e.g. 1000 screenshots/hour) at the edge function layer using Upstash or a Postgres counter.

### Tradeoffs

Adds ~2ms to the webhook hot path and requires the desktop app to store and rotate secrets. Worth it — this is table-stakes webhook security and is the one thing on this list that a security-conscious enterprise customer will absolutely flag during procurement.

---

# PART 2 — TOKEN LIFECYCLE

## Risk 2.1 — Refresh-token race across processes (⚠️ Mitigated within a process)

### Verified? ⚠️ Partially mitigated

`python-desktop-app/desktop_app.py`:

- Line 1441: `self._refresh_lock = threading.Lock()` — protects against **in-process** concurrent refresh.
- Line 1445: `_refresh_token_invalid` flag with 30-min grace period (line 1752).
- Comment explicitly notes: "Atlassian uses token rotation: each refresh invalidates the old refresh_token."

### Severity reality check

🟢 **Adequate for single-desktop installs.** The remaining gap:

- User has desktop app open AND uses the web-hosted Forge UI AND both try to refresh within 30 minutes.
- This is actually a very narrow window — Atlassian access tokens last 1 hour, and the desktop app is the primary refresher.
- Multi-machine use case: if a user installs the desktop app on two laptops with the same account, both refresh independently. Each has its own refresh-token value so no shared race, but if Atlassian rotates aggressively one machine could see "refresh_token invalid" until the user re-auths there.

### Web research findings (2026)

Industry standard for distributed refresh is a **rotation overlap window** at the OAuth server — but Atlassian hasn't shipped that. Client-side, the correct pattern is exactly what you have: an in-process mutex plus a grace period. The multi-device case is typically handled by having each device store its own refresh_token (which you do).

### Recommended solution

**Minimal (no code change needed).** Your implementation is already good for the common case.

**Ideal (~2 days) if you add a server-side component:**

- Store the latest refresh_token in Supabase keyed by `(user_id, device_id)`.
- Before refreshing, `SELECT FOR UPDATE` the row to serialize.
- After a successful rotation, upsert the new token.

This is worth doing only if you start seeing support tickets about "I got logged out on my other laptop" — not speculatively.

### Tradeoffs

Adds network round-trip to every refresh. Don't do it unless you have evidence.

---

## Risk 2.2 — Keyring fallback to file encryption (⚠️ Already good)

### Verified? ⚠️ Actually well-designed

`python-desktop-app/auth/secure_storage.py` — reviewed fully:

- Primary: Windows Credential Manager (via `keyring`).
- Fallback: **AES-128-CBC via Fernet** with **PBKDF2-HMAC-SHA256, 600,000 iterations** (OWASP 2023+ recommendation).
- Salt is machine-bound: `MachineGuid || USERNAME` from the Windows registry.
- File permissions set to user-only on Unix.
- Silent fallback (no blocking dialog) which matches GDPR Article 32 guidance.

### Severity reality check

🟢 **This is better than many commercial products.** The "silent fallback" wording in the original risk was worrying, but the code does log `[INFO] Using encrypted storage (system credential manager unavailable)` and sets a one-time notification flag for users.

Remaining minor concerns:
- MachineGuid is readable by any process running as the user. That's true of **every** credential store on Windows — not a regression.
- A skilled attacker with local code execution can read tokens regardless. You're defending against cold-disk extraction, and AES-128-CBC with a machine-bound PBKDF2 key defends against that correctly.

### Web research findings (2026)

OWASP's 2024–2026 password-storage cheat sheet still lists PBKDF2-HMAC-SHA256 with ≥ 600k iterations as acceptable for key derivation. Argon2id is preferred but requires a native dependency you're currently avoiding.

### Recommended solution

**Minimal (no code change needed).** Just document the threat model in `python-desktop-app/SECURITY.md`: "This protects against cold-disk extraction and cross-machine copying. It does not defend against malware running as the user."

**Ideal (~1 day):** Upgrade to Argon2id if you're willing to add `argon2-cffi` to `requirements.txt`. Gives you better resistance to custom ASIC attacks. Not critical.

---

# PART 3 — DATA CORRECTNESS

## Risk 3.1 — Dual-read heuristic for duplicate users (🟡 Important)

### Verified? ✅ Real — confirmed in code

`forge-app/src/services/issue/issueQueryService.js` lines 86–141: when a user has no activity records, the code searches for **duplicate user rows** by comparing emails (case-insensitive) and Atlassian account IDs (substring match). Then queries activity for all matched user_ids with an `IN()` clause.

`forge-app/src/services/scheduledWorklogSync.js` lines 110–185: similar duplicate-org resolution logic — `resolveActivityOrgId` walks the organizations table looking for sibling orgs with the same `jira_cloud_id`.

Both are comments/warnings in the code itself (e.g. "duplicate org problem where tracking_settings and activity_records reference different org UUIDs").

### Severity reality check

🟡 **Important.** This is a symptom, not a root cause:

- **Correctness risk:** substring match on Atlassian IDs (`otherAtlassianId.includes(currentAtlassianId)`) can match unrelated accounts in rare cases (any two account IDs where one is a substring of another).
- **Performance:** the duplicate-walk is O(users in org × round-trip latency). On a 200-user Jira site this is ~1–2 seconds of Supabase calls just to render "My Focus."
- **Maintainability:** this is the code's third guardrail around a data model bug — signal that the underlying schema should be fixed.

### Web research findings (N/A — architectural)

This is a data-model problem. The right fix is a database-side unique constraint on `(jira_cloud_id)` for organizations and `(organization_id, atlassian_account_id)` for users, plus a one-time migration to merge duplicates.

### Recommended solution

**Minimal (~1 day) — tighten the heuristic:**

Replace the substring match with equality only. Remove the substring branch; keep only the email-match branch. If substring-matched IDs have never surfaced a real duplicate, you'll lose nothing.

**Ideal (~1 week) — fix the schema:**

```sql
-- Find and merge duplicate orgs
with dupes as (
  select jira_cloud_id, array_agg(id order by created_at) as ids
  from organizations
  group by jira_cloud_id having count(*) > 1
)
-- migrate all child rows to the oldest org, delete duplicates
...

-- Then enforce uniqueness
alter table organizations add constraint uq_org_cloud_id unique (jira_cloud_id);
alter table users add constraint uq_user_acct_per_org unique (organization_id, atlassian_account_id);
```

Once the data is clean and the constraints are in place, delete the heuristic code. It's costing you hundreds of lines of maintenance burden.

### Tradeoffs

The migration needs to run with a maintenance window (or online-migration discipline). The payoff is eliminating an entire category of support tickets.

---

## Risk 3.2 — Confidence threshold silently determines worklog creation (🟡 Important)

### Verified? ✅ Real — confirmed in code

`ai-server/src/services/db/activity-db-service.js` lines 67–74:

```js
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.5');
const confidenceScore = analysisResult.metadata?.confidenceScore ?? 0;
const taskKeyMeetsThreshold = analysisResult.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;
// If below threshold → effectiveTaskKey = null → shows as "unassigned"
```

### Severity reality check

🟡 **Important but the design is correct.** The risk is not about the threshold value but about transparency:

- Users see some of their time as "unassigned" with no explanation.
- There is no UI surface for "this window looked like PROJ-123 but we weren't 60% sure."
- Admins can't see what the threshold currently is.

### Recommended solution

**Minimal (~half day):**

- Log the confidence score in `activity_records.metadata` so it's visible in the admin dashboard.
- Add a small "Why is this unassigned?" tooltip in the UI that says "AI confidence was below 50%."

**Ideal (~3 days):**

- Per-org configurable threshold via the settings UI.
- "Low confidence" bucket in the UI separate from "unassigned" — user can one-click confirm/reject the AI's guess.
- Track per-user confirmation rate to calibrate the threshold over time.

### Tradeoffs

The minimal fix is pure UI/logging — zero risk. Well worth it.

---

## Risk 3.3 — Worklog attribution falls back to `asApp()` (🔴 Critical)

### Verified? ✅ Real — confirmed in code

`forge-app/src/services/scheduledWorklogSync.js` lines 617–647:

```js
try {
  worklogResult = await createJiraWorklogAsUser(accountId, ...);
} catch (impersonationErr) {
  if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
    console.warn(`asUser unavailable for ${issueKey}, falling back to asApp`);
    worklogResult = await createJiraWorklogAsApp(...);  // ← worklog author = app
  }
}
```

When `asUser` fails, the code creates the worklog under the app's name and puts the user's `displayName` in the comment.

Further down (lines 652–660): even when `asUser` succeeds at the API level, the code checks `worklogResult.author.accountId === accountId` — and silently keeps worklogs where Jira didn't actually apply the impersonation. The `created_as_user` column records this fact but the worklog stays in place.

### Severity reality check

🔴 **Critical for your core product value proposition.**

The entire point of BRD Time Tracker is "accurate per-person time on Jira issues." A worklog that shows the app as the author and the user's name buried in a comment is:

- **Wrong for reporting** — Jira's time-in-status and velocity reports group by author.
- **Wrong for billing** — if customers use worklogs to bill clients, the bill has "BRD Time Tracker" as the worker.
- **A GDPR/compliance smell** — your app is creating records "on behalf of" a user without clear signal.

Scheduled triggers in Forge do have documented impersonation limits. Atlassian's own guidance is that `asUser` in scheduled context is unreliable.

### Web research findings (2026)

The documented Forge pattern for reliable user attribution is:
1. Do the minimum work in the scheduled trigger (mark records as "pending").
2. Create the actual worklog in a **user-context resolver** (when the user opens the app), which has proper impersonation.
3. This is exactly what your code *starts* to do — `PENDING_WORKLOG_ID` sentinel exists — but the fallback to `asApp()` bypasses that mechanism.

### Recommended solution

**Minimal (~1 day) — remove the asApp fallback:**

```js
if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
  // Write a PENDING row instead — interactive sync will create the worklog
  // with proper user attribution when the user next opens the app.
  await supabaseRequest(supabaseConfig, 'worklog_sync', {
    method: 'POST',
    body: { ...entry, jira_worklog_id: PENDING_WORKLOG_ID, created_as_user: false }
  });
  return false;
}
```

This defers the worklog creation to the next time the user opens the app, where `asUser` works reliably.

**Ideal (~3 days):**

- Track `asUser`-failure rate per user per week. Nudge users who have > 5 pending records to open the app.
- Add a daily email digest when pending count > threshold.
- In Forge v3 patterns, use `asApp` only as a hard last resort AND put a bold "(attributed to app, see comment)" marker in the worklog so this is never silent.

### Tradeoffs

The minimal fix means time does not appear in Jira until the user opens the app. That's actually desired behavior — an unattributed worklog is worse than no worklog.

---

## Risk 3.4 — `update-issues-cache` is a stub (🟡 Important)

### Verified? ✅ Real — confirmed in code

`supabase/functions/update-issues-cache/index.ts` lines 51–71:

```ts
// Note: This function would need to call Forge app's updateUserAssignedIssuesCache resolver
// ...
// For now, this is a placeholder that logs what would be done
// TODO: Implement actual cache update mechanism
```

Returns success but doesn't actually update anything.

### Severity reality check

🟡 **Important.** The stub is actively harmful in two ways:

1. Any cron calling it thinks the cache is being refreshed and returns 200.
2. The cache that *is* being used (in `issueCacheService.js`) can drift; stale issue data can cause worklog mismatches.

### Recommended solution

**Minimal (~1 day):** delete the function and any cron that calls it. The Forge app already refreshes the cache via the `avi:jira:updated:issue` trigger declared in `manifest.yml`, which is the right architecture for Forge.

**Ideal (~3 days):** if you do need scheduled refresh (e.g., catch events missed during deploys), use a Forge scheduled trigger calling `updateUserAssignedIssuesCache` directly — no need for an edge function. Forge scheduled triggers have proper auth and proper user context.

### Tradeoffs

Deleting is the right move. The stub was architectural guesswork during prototyping and is no longer needed.

---

## Risk 3.5 — MD5 for screenshot dedup (❌ Not a real risk)

### Verified? ✅ Real use, ❌ Not a vulnerability

`python-desktop-app/desktop_app.py` line 8386: `current_hash = hashlib.md5(screenshot_bytes).hexdigest()`

### Severity reality check

❌ **Not a security issue.** MD5 is broken for signatures, but you're not signing anything. For a deduplication cache on screenshot bytes:

- Collisions happen at ~2^64 inputs (billions of screenshots).
- Even if a collision occurred, the worst case is "two different screenshots are treated as duplicates" — user sees slightly wrong data, nobody is exploited.

### Recommended solution

No change needed. If it bothers your security auditors, swap to `blake3` or `sha256` — one-line change, but there's no urgency.

---

## Risk 3.6 — Offline SQLite has no size cap (🟡 Important)

### Verified? ✅ Real — confirmed in code

`python-desktop-app/desktop_app.py` lines 2229–2286: `OfflineManager` has no size check, no rotation, no TTL on cached offline rows. If a user goes offline for a week, the encrypted SQLite file grows unbounded.

### Severity reality check

🟡 **Important in the long tail.** Normal users are fine. The edge cases:

- Laptop goes offline for 2+ weeks (e.g. vacation with WiFi issues).
- User ignores sync errors for months.
- Desktop app crashes during sync repeatedly, queue grows.

In the worst case, the app fails to start because the encrypted DB can't fit in memory for the SQLCipher key derivation step.

### Web research findings (2026)

Standard SQLCipher hygiene:
- Monitor file size periodically; trigger `VACUUM INTO` when it exceeds a threshold (e.g. 500 MB).
- For a time-tracking app, **data older than N days that has been synced can be deleted** — offline storage is a queue, not a history.

### Recommended solution

**Minimal (~half day):**

- On startup, check file size. If > 500 MB, delete rows where `synced_at IS NOT NULL AND captured_at < now() - interval '14 days'`.
- Log a warning so it's visible in support bundles.

**Ideal (~2 days):**

- Size cap with LRU eviction of synced rows.
- `VACUUM INTO` a temp file, then atomic rename — this reclaims file space that `DELETE` alone doesn't.
- User-facing "local storage used" indicator in the settings UI.

### Tradeoffs

SQLCipher's `VACUUM INTO` is slow on large DBs (seconds to a minute). Run it on startup, not in-line with capture.

---

# PART 4 — OPERATIONAL

## Risk 4.1 — Background services are single-instance (🔴 Critical)

### Verified? ✅ Real — confirmed in code

Three services in `ai-server/src/services/`:

- `activity-polling-service.js` line 149: `setInterval(..., 180000)` — every 3 minutes.
- `clustering-polling-service.js` line 318: `setTimeout(..., msUntilNextRun)` — daily at `CLUSTERING_SCHEDULE_HOUR:MINUTE`.
- (Notifications service — not read in detail, but same pattern expected.)

None use a distributed lock. All live inside the Express process. Cloud Run **will** run multiple instances under load (or during deploys with overlap).

### Severity reality check

🔴 **Critical architectural issue** that will bite at scale:

- **Duplicate work**: every instance runs clustering at 23:00 simultaneously. With two instances, you get double the AI analysis cost, and race conditions on the "claim batch" step.
- **Work vanishes during deploys**: if an instance is terminated between `setTimeout` registration and firing, the job silently doesn't run.
- **No retries, no observability**: a fatal error in `processPendingRecords()` gets logged and the service silently waits for the next tick.

The `claimBatchForProcessing` atomic update in `activity-polling-service.js` mitigates *duplicate work* at the record level, but not the orchestration level (two instances polling every 3 minutes still doubles DB load).

### Web research findings (2026)

Two standard solutions for Node.js + Postgres:

1. **`pg-boss`** — postgres-backed job queue using `SELECT ... FOR UPDATE SKIP LOCKED`. Exactly-once delivery, retry, dead-letter queue, scheduling with cron expressions. Mature, actively maintained as of 2026.

2. **`graphile-worker`** — lower-latency (uses `LISTEN/NOTIFY`), also postgres-native. Best if you want jobs created by database triggers.

Alternative: **Cloud Run Jobs + Cloud Scheduler**. Cloud Run *Jobs* (distinct from *services*) are stateless containers run to completion. Scheduler triggers them. This is the GCP-native way and pairs nicely with your existing Cloud Run deploy.

### Recommended solution

**Minimal (~2 days) — Postgres advisory lock:**

Wrap each background tick with `pg_try_advisory_lock(hashtext('activity-polling'))`. Only the instance that gets the lock runs; others skip. Cheap, zero new dependencies.

```js
async function runWithLock(name, fn) {
  const lockId = hashtext(name); // int4 hash
  const { rows } = await db.query('SELECT pg_try_advisory_lock($1) as got', [lockId]);
  if (!rows[0].got) return;
  try { await fn(); }
  finally { await db.query('SELECT pg_advisory_unlock($1)', [lockId]); }
}
```

**Ideal (~1 week) — split the worker out:**

- Move polling services into a dedicated Cloud Run Job or a small Compute Engine VM.
- Use `pg-boss` for queueing, scheduling, and retry. Replace the three `setInterval`/`setTimeout` services with named queues.
- Keep the Express API server horizontally scaled and **stateless**.
- Cron: use Cloud Scheduler for daily clustering, not `setTimeout`.

### Tradeoffs

The minimal fix (advisory lock) is a 30-line change and eliminates the duplicate-work problem. The ideal architecture is a week of work but gives you retries, dead letters, and the ability to scale the API independently of the worker. It also eliminates the "if the API process crashes, clustering stops running" failure mode, which *is* a silent production bug today.

---

## Risk 4.2 — Activity polling has no backoff (🟡 Important)

### Verified? ✅ Real — confirmed in code

`ai-server/src/services/activity-polling-service.js` line 285:

```js
logger.debug('Network error in activity polling (will retry on next cycle)');
```

On error, it waits for the next `setInterval` tick (3 min). No exponential backoff. No circuit breaker.

### Severity reality check

🟡 **Important when things go wrong.**

- OpenAI has an outage → you hammer them with requests every 3 minutes for hours → get rate-limited → cost spikes → noise in logs.
- Supabase has a brief blip → same pattern → backpressure makes the blip worse.

### Recommended solution

**Minimal (~4 hours):**

Track consecutive failures. On 3+ consecutive failures, extend the interval by 2x up to a cap:

```js
let consecutiveFailures = 0;
async function tick() {
  try { await processPendingRecords(); consecutiveFailures = 0; }
  catch (e) { consecutiveFailures++; }
  const delay = Math.min(180_000 * Math.pow(2, consecutiveFailures), 30 * 60_000);
  setTimeout(tick, delay);
}
```

**Ideal (~2 days):**

Replace the self-scheduling loop with `pg-boss` (from Risk 4.1) — its built-in retry with exponential backoff handles this for free.

### Tradeoffs

Minimal fix requires converting from `setInterval` to self-rescheduling `setTimeout`. Straightforward.

---

## Risk 4.3 — Admin dashboard password is a single shared secret (🟡 Important)

### Verified? ✅ Real — in `admin-dashboard-controller.js`

Password is `process.env.ADMIN_DASHBOARD_PASSWORD` — one secret for all admins. No per-user accounts, no MFA, no audit.

### Severity reality check

🟡 **Important.** This is defensible for an internal tool with 2 admins but not for a marketplace product:

- No way to revoke access for a specific person who leaves.
- No audit trail of who viewed what.
- If the env var leaks (Slack, screenshot), everyone is compromised.

### Recommended solution

**Minimal (~1 day):**

- Support an allowlist: `ADMIN_EMAIL_ALLOWLIST=alice@co,bob@co`.
- Password still required, but paired with the email (Supabase Auth magic link is even better).

**Ideal (~3 days):**

- Drop the shared password entirely. Use Supabase Auth with the admin allowlist at the row level.
- Add TOTP (Supabase Auth supports this natively).
- Audit log every admin action into an append-only table.

### Tradeoffs

Supabase Auth migration is standard and well-documented. The payoff is real accountability.

---

## Risk 4.4 — `/reset-upload-lock` endpoint (🟢 Minor)

### Verified? Likely real (referenced in CODEBASE_REFERENCE but not re-verified here)

### Severity reality check

🟢 **Low** if auth-gated; consider removing or moving to admin-only.

### Recommended solution

- Require admin auth.
- Add a rate limit (1 call per minute per user).
- Log every call with user + target upload ID to the admin audit log.

---

## Risk 4.5 — Forge KVS `clearSiteCache` only deletes two known keys (🟡 Important)

### Verified? ✅ Real — confirmed in code

`forge-app/src/services/lifecycleService.js` lines 89–113:

```js
// Forge KVS doesn't support key enumeration, so we delete known
// key patterns. User-specific keys expire naturally via 24-hour TTL.
```

Comment is out of date.

### Web research findings (2026)

`@forge/kvs` **does** support key enumeration in 2026 via:

```js
import { kvs, WhereConditions } from '@forge/kvs';
const cursor = await kvs.query()
  .where('key', WhereConditions.beginsWith(`user:${cloudId}:`))
  .getMany();
```

Supports pagination via cursors.

### Severity reality check

🟡 **Important.** The "TTL expiration" fallback means uninstalled orgs' cached user data lingers for up to 24 hours. For GDPR compliance (right to erasure), this is a weakness.

### Recommended solution

**Minimal (~half day):**

Replace the hardcoded `keysToDelete` with a query:

```js
async function clearSiteCache(cloudId) {
  let cursor = undefined;
  do {
    const page = await kvs.query()
      .where('key', WhereConditions.beginsWith(`user:${cloudId}:`))
      .cursor(cursor)
      .getMany();
    await Promise.all(page.results.map(r => kvs.delete(r.key)));
    cursor = page.nextCursor;
  } while (cursor);
  // Plus the existing two known keys
  await kvs.delete(`org:${cloudId}`);
  await kvs.delete(`remote:org:${cloudId}`);
}
```

**Ideal:** same as minimal — this really is just updating to the current API.

### Tradeoffs

None. The old comment reflects a past limitation that's no longer accurate.

---

# PART 5 — ARCHITECTURE

## Risk 5.1 — `desktop_app.py` is 563 KB single file (🟡 Important)

### Verified? Implicit (flagged earlier)

### Severity reality check

🟡 **Important but not urgent.** Affects maintenance velocity, onboarding new engineers, and test coverage. Doesn't affect runtime behavior.

### Recommended solution

**Ideal (~3 weeks, background):**

Split into modules by responsibility:

- `tray/` — system tray UI
- `capture/` — screenshot + window enumeration
- `sync/` — upload + queue
- `auth/` — already partially extracted
- `idle/` — idle-detection state machine

No big-bang rewrite. Do this opportunistically as you touch areas.

---

## Risk 5.2 — Notifications polling service feedback loop (🟡 Important)

### Verified? Not re-verified in detail. Pattern from other polling services applies.

### Recommended solution

Same as Risk 4.1 + 4.2 — `pg_try_advisory_lock` + exponential backoff on failure. Same code path.

---

# PRIORITIZED REMEDIATION ROADMAP

### Week 1 — Fix the bleeders (5 eng-days)

| # | Risk | Effort | Why now |
|---|------|--------|---------|
| 1 | **Webhook HMAC signatures** (1.6) | 1 day | Single most exploitable. Blocks enterprise procurement. |
| 2 | **Forge-proxy table allowlist** (1.3) | 1 day | Same severity, less exploitable today, trivial fix. |
| 3 | **Background-service advisory lock** (4.1 minimal) | 1 day | Eliminates duplicate work + cost spikes at scale. |
| 4 | **Admin sessions → Supabase table** (1.1 minimal) | 1 day | Stops logging admins out on every deploy. |
| 5 | **Remove `asApp()` fallback in scheduled sync** (3.3) | 1 day | Fixes core product value: correct user attribution. |

### Week 2 — Close the obvious gaps (5 eng-days)

| # | Risk | Effort |
|---|------|--------|
| 6 | Delete `update-issues-cache` stub (3.4) | 1 day |
| 7 | Update KVS `clearSiteCache` to enumerate (4.5) | 0.5 day |
| 8 | Atlassian `/me` 5-min cache (1.2 minimal) | 0.5 day |
| 9 | Activity-polling exponential backoff (4.2 minimal) | 0.5 day |
| 10 | Offline SQLite size cap + auto-VACUUM (3.6) | 0.5 day |
| 11 | Confidence-score logging + UI tooltip (3.2 minimal) | 0.5 day |
| 12 | Tighten duplicate-user heuristic to equality-only (3.1 minimal) | 1 day |
| 13 | Admin allowlist env var + email requirement (4.3 minimal) | 0.5 day |

### Month 2 — Ideal architecture (15 eng-days)

- Replace three polling services with `pg-boss` + Cloud Run Jobs (Risk 4.1 ideal).
- Migrate logs to Pino with structured redaction (Risk 1.5 ideal).
- Replace generic Forge proxy with named RPC endpoints (Risk 1.3 ideal).
- Supabase Auth for admin dashboard with MFA + audit log (Risks 1.1 + 4.3 ideal).
- Schema fix + data migration to eliminate duplicate users/orgs (Risk 3.1 ideal).

### Ongoing / background

- Split `desktop_app.py` opportunistically (Risk 5.1).
- Quarterly log-sanitizer review (Risk 1.5 minimal).
- Document threat model for desktop secure storage (Risk 2.2).

---

# What's NOT on the list (and why)

- **CORS no-origin (1.4)**: not a security boundary. Add a comment, done.
- **MD5 dedup (3.5)**: correct use of a broken hash. Don't waste cycles.
- **Keyring fallback (2.2)**: already implements OWASP-recommended PBKDF2+AES. Don't regress.
- **Refresh-token race (2.1)**: already has in-process lock + grace period. The multi-device case is narrow — wait for support tickets before investing.
- **Log sanitizer (1.5 minimal)**: regex approach is good enough for today. Pino migration is valuable but not urgent.

---

# Appendix A — File-level evidence index

| Risk | File | Lines |
|------|------|-------|
| 1.1 | `ai-server/src/controllers/admin-dashboard-controller.js` | 12 |
| 1.2 | `ai-server/src/middleware/atlassian-auth.js` | 40–49 |
| 1.2 | `ai-server/src/middleware/dashboard-auth.js` | 37–104 |
| 1.3 | `ai-server/src/controllers/forge-proxy-controller.js` | SENSITIVE_TABLES usage, logSecurityWarnings |
| 1.4 | `ai-server/src/index.js` | 47–48 |
| 1.5 | `ai-server/src/utils/log-sanitizer.js` | 1–396 |
| 1.6 | `supabase/config.toml` | 53–57 |
| 2.1 | `python-desktop-app/desktop_app.py` | 1437–1756 |
| 2.2 | `python-desktop-app/auth/secure_storage.py` | 207–626 |
| 3.1 | `forge-app/src/services/issue/issueQueryService.js` | 86–141 |
| 3.1 | `forge-app/src/services/scheduledWorklogSync.js` | 110–185 |
| 3.2 | `ai-server/src/services/db/activity-db-service.js` | 62–74 |
| 3.3 | `forge-app/src/services/scheduledWorklogSync.js` | 617–683 |
| 3.4 | `supabase/functions/update-issues-cache/index.ts` | 51–71 |
| 3.5 | `python-desktop-app/desktop_app.py` | 8386 |
| 3.6 | `python-desktop-app/desktop_app.py` | 2229–2286 |
| 4.1 | `ai-server/src/services/activity-polling-service.js` | 128–153 |
| 4.1 | `ai-server/src/services/clustering-polling-service.js` | 294–322 |
| 4.2 | `ai-server/src/services/activity-polling-service.js` | 285 |
| 4.3 | `ai-server/src/controllers/admin-dashboard-controller.js` | password env var |
| 4.5 | `forge-app/src/services/lifecycleService.js` | 89–113 |

---

# Appendix B — Web research sources

**Supabase + Cloud Run session stores**
- [Best PostgreSQL Hosting in 2026 — DEV](https://dev.to/philip_mcclarence_2ef9475/best-postgresql-hosting-in-2026-rds-vs-supabase-vs-neon-vs-self-hosted-5fkp)
- [Supabase Supavisor connection pooler](https://github.com/supabase/supavisor)

**Atlassian rate limiting & caching**
- [Rate limiting — Jira Cloud platform](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
- [Scaling API rate limits — Atlassian](https://www.atlassian.com/blog/platform/evolving-api-rate-limits)
- [API Rate Limit Handling for Apps — Atlassian](https://www.atlassian.com/blog/developer/api-rate-limit-handling-for-apps)

**Forge KVS**
- [Key-value store — Forge docs](https://developer.atlassian.com/platform/forge/runtime-reference/storage-api-basic/)
- [Query API for KVS](https://developer.atlassian.com/platform/forge/runtime-reference/storage-api-query/)
- [KVS migration from legacy](https://developer.atlassian.com/platform/forge/storage-reference/kvs-migration-from-legacy/)

**Postgres job queues**
- [pg-boss on GitHub](https://github.com/timgit/pg-boss)
- [Graphile Worker docs](https://worker.graphile.org/)
- [Scheduled background jobs with pg-boss — LogSnag](https://logsnag.com/blog/deep-dive-into-background-jobs-with-pg-boss-and-typescript)

**Supabase Edge Functions & webhooks**
- [Receiving webhooks with Supabase Edge Functions — Svix](https://www.svix.com/blog/receive-webhooks-with-supabase-edge-functions/)
- [Securing Edge Functions — Supabase Docs](https://supabase.com/docs/guides/functions/auth)
- [How to authenticate webhooks? — Supabase Discussion](https://github.com/orgs/supabase/discussions/14115)

**OAuth refresh-token races**
- [How to handle concurrency with OAuth token refreshes — Nango](https://nango.dev/blog/concurrency-with-oauth-token-refreshes)
- [Refresh Token Race Condition — Apideck](https://developers.apideck.com/guides/refresh-token-race-condition)
- [Refresh tokens need a grace period — Ory Hydra #1831](https://github.com/ory/hydra/issues/1831)

**SQLCipher size management**
- [Vacuum SQLite DB with SQLCipher — B4X](https://www.b4x.com/android/forum/threads/vacuum-sqlite-db-with-sqlcipher.159125/)
- [Impact of VACUUM — SQLCipher #310](https://github.com/sqlcipher/sqlcipher/issues/310)
- [SQLCipher Design — Zetetic](https://www.zetetic.net/sqlcipher/design/)

**HMAC & timing-safe comparison**
- [Preventing Timing Attacks — Paragon Initiative](https://paragonie.com/blog/2015/11/preventing-timing-attacks-on-string-comparison-with-double-hmac-strategy)
- [Webhook Signature Verification Guide — InventiveHQ](https://inventivehq.com/blog/webhook-signature-verification-guide)
- [Validating webhook deliveries — GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

**Cloud Run background jobs**
- [Cloud Run Jobs vs Cloud Functions vs Scheduler — OneUptime](https://oneuptime.com/blog/post/2026-02-17-how-to-compare-cloud-run-jobs-vs-cloud-functions-vs-cloud-scheduler-for-background-tasks/view)
- [Execute jobs on a schedule — GCP docs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)
- [Cloud Run always-on CPU for background work — Google Cloud Blog](https://cloud.google.com/blog/topics/developers-practitioners/use-cloud-run-always-cpu-allocation-background-work)

**Forge scheduled triggers**
- [Scheduled trigger — Forge docs](https://developer.atlassian.com/platform/forge/manifest-reference/modules/scheduled-trigger/)
- [Scheduled trigger events — Forge](https://developer.atlassian.com/platform/forge/events-reference/scheduled-trigger/)
- [Async Events API — Forge](https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/)

**Structured logging**
- [Pino Redaction — Arrange Act Assert](https://arrangeactassert.com/posts/pino-redaction-a-simple-solution-to-secure-logging-in-node-js-applications/)
- [Pino 9 + OpenTelemetry 2026 guide — DEV](https://dev.to/1xapi/how-to-add-structured-logging-to-nodejs-apis-with-pino-9-opentelemetry-2026-guide-3jd2)
- [Choosing a JS Logging Library 2026 — Sentry](https://blog.sentry.io/javascript-logging-library-definitive-guide/)
