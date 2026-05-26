# Security & Compliance

## Threat Model

| Threat | Mitigation | Component |
|--------|-----------|-----------|
| PII sent to LLM | Regex-based sanitization before any LLM call | ai-server |
| Prompt injection via ticket content | Structured prompts with clear delimiters; output schema validation | ai-server |
| Unauthorized access to endpoint | FIT token auth via `forgeAuthMiddleware` | ai-server |
| Cross-org data access | `org_id` in all cache queries; RLS on Supabase table | ai-server / supabase |
| Malicious ADF injection | ADF validation before Jira write; reject invalid structures | forge-app |
| Rate limit abuse | Per-org and per-user rate limits | ai-server |
| Data exfiltration via improved description | Write-back only with explicit user action | forge-app |

---

## PII Sanitization

### Patterns to Redact

| Type | Regex Pattern | Replacement |
|------|--------------|-------------|
| Email | `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g` | `[EMAIL]` |
| API Key (OpenAI) | `/sk-[a-zA-Z0-9]{20,}/g` | `[API_KEY]` |
| API Key (AWS) | `/AKIA[0-9A-Z]{16}/g` | `[API_KEY]` |
| Credit Card | `/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g` | `[CREDIT_CARD]` |
| Phone (US) | `/(\+1[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g` | `[PHONE]` |
| Phone (International) | `/\+\d{1,3}[\s-]?\d{4,14}/g` | `[PHONE]` |
| Atlassian Account ID | `/[0-9a-f]{24}/g` | `[ACCOUNT_ID]` |
| JWT Token | `/eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g` | `[TOKEN]` |
| IP Address | `/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g` | `[IP_ADDRESS]` |

### Sanitization Rules

1. Sanitization runs **before** any content is sent to the LLM
2. Original content is never logged at `info` level — use `debug` only
3. Sanitized content is used for the LLM prompt but NOT for the response (improved description uses generic references, not redacted placeholders)
4. Existing pattern from `activity-service.js` should be reused/extended

---

## Authentication & Authorization

### Endpoint Auth

The `/api/forge/description/analyze` endpoint uses `forgeAuthMiddleware`:

1. Extracts Forge Invocation Token (FIT) from `Authorization` header
2. Validates token signature and expiry
3. Extracts `cloudId` and `accountId`
4. Attaches `req.forgeContext = { cloudId, accountId }` for downstream use

### Authorization Checks

- Any authenticated Forge user can analyze descriptions (read operation)
- Write-back requires the user to have edit permissions on the Jira issue (enforced by Jira API when the PUT is made with `allowImpersonation: true`)
- Rate limits are scoped per `cloudId` (org) and per `accountId` (user)

---

## Data Flow Security

```
User Ticket Content
       │
       ▼
[Forge Resolver] ─── fetches from Jira API (within Forge sandbox)
       │
       ▼ (plain text, via Forge Remote with FIT)
[AI Server] ─── validates auth, validates input schema
       │
       ▼
[PII Sanitization] ─── strips sensitive patterns
       │
       ▼ (sanitized text only)
[LLM Provider] ─── via Portkey (Gemini/GPT-5)
       │
       ▼ (structured JSON response)
[Schema Validation] ─── validates response structure
       │
       ▼
[Cache Storage] ─── Supabase with org_id scoping + RLS
       │
       ▼ (response back to Forge)
[Forge Resolver] ─── returns to UI
       │
       ▼ (user reviews)
[User Decision] ─── Accept/Edit/Reject
       │
       ▼ (only if Accept/Edit)
[ADF Validation] ─── validates structure before write
       │
       ▼
[Jira API] ─── PUT with impersonation (user's permissions enforced)
```

---

## Input Validation (Controller Boundary)

| Field | Validation | Max Length |
|-------|-----------|-----------|
| `issueKey` | Matches `/^[A-Z][A-Z0-9]+-\d+$/` | 50 |
| `title` | Non-empty string | 500 |
| `description` | String (can be empty) | 50,000 |
| `issueType` | One of: Bug, Story, Task, Epic, Sub-task | — |
| `projectKey` | Matches `/^[A-Z][A-Z0-9]+$/` | 20 |
| `requestImprovement` | Boolean | — |

Any field exceeding max length or failing pattern match → 400 response.

---

## Logging Policy

| Data | Log Level | Allowed? |
|------|-----------|----------|
| Issue key, project key | info | ✅ |
| Score result | info | ✅ |
| Ticket title/description content | debug | ⚠️ Only in dev |
| PII-containing text | never | ❌ |
| FIT token value | never | ❌ |
| LLM prompt (sanitized) | debug | ⚠️ Only in dev |
| LLM response | debug | ⚠️ Only in dev |
| Error messages | error | ✅ |
| Rate limit events | warn | ✅ |

---

## Compliance with Existing Standards

- **OWASP Top 10**: Input validation at controller boundary, parameterized queries for cache, no SQL injection vectors
- **Atlassian Security**: Forge Remote used exclusively (no direct HTTP from Forge sandbox), FIT auth for server identity
- **Multi-tenancy**: All cache operations scoped by `org_id`; RLS enforced at DB level
- **GDPR/Privacy**: PII never sent to LLM; no personal data stored in cache beyond `org_id` + content hash; user controls all write operations
