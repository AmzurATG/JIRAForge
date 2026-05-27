# File Changes — Detailed Inventory

## New Files to Create

### AI Server

| File | Purpose | Phase |
|------|---------|-------|
| `ai-server/src/controllers/description-controller.js` | Express route handler for `/api/forge/description/analyze` | MVP |
| `ai-server/src/services/description-service.js` | Deterministic scorer + LLM orchestration + cache logic | MVP (scorer) / V1 (LLM) / V2 (cache) |
| `ai-server/src/services/ai/description-prompts.js` | Issue-type-aware scoring/rewrite prompts (Bug, Story, Task, Epic) | V1 |
| `ai-server/tests/services/description-service.test.js` | Unit tests for deterministic scorer and LLM orchestration | MVP / V1 |
| `ai-server/tests/controllers/description-controller.test.js` | Unit tests for endpoint validation and routing | MVP |
| `ai-server/tests/services/description-prompts.test.js` | Tests for prompt generation per issue type | V1 |

### Forge App — Backend

| File | Purpose | Phase |
|------|---------|-------|
| `forge-app/src/resolvers/descriptionResolvers.js` | Resolvers: `analyzeDescription`, `updateDescription`, `wasDescriptionChanged` | MVP / V2 |
| `forge-app/src/utils/adfBuilder.js` | Custom lightweight ADF builder (~50 lines, no @atlaskit) | V2 |
| `forge-app/tests/resolvers/descriptionResolvers.test.js` | Unit tests for description resolvers | MVP / V2 |
| `forge-app/tests/utils/adfBuilder.test.js` | Unit tests for ADF builder | V2 |

### Forge App — Frontend (React)

| File | Purpose | Phase |
|------|---------|-------|
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/DescriptionQuality.js` | Main container component | MVP |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/DescriptionQuality.css` | Styles for quality panel | MVP |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/ScoreBadge.js` | Color-coded score display (Red/Yellow/Green) | MVP |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/IssuesList.js` | List of identified quality issues | MVP |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/SuggestionsList.js` | Actionable suggestions display | MVP |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/ImproveButton.js` | "Improve" CTA button | V1 |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/ComparisonView.js` | Side-by-side original vs improved | V2 |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/ActionButtons.js` | Accept / Edit / Reject buttons | V2 |
| `forge-app/static/main/src/components/issue-panel/DescriptionQuality/EditMode.js` | Editable textarea with pre-filled improved content | V2 |

### Supabase

| File | Purpose | Phase |
|------|---------|-------|
| `supabase/migrations/YYYYMMDD_description_quality_cache.sql` | Cache table + RLS policies | V2 |

---

## Existing Files — Modifications Required

### AI Server

| File | Change | Phase |
|------|--------|-------|
| `ai-server/src/index.js` | Register `POST /api/forge/description/analyze` route → `description-controller.js` | MVP |
| `ai-server/src/services/ai/ai-client.js` | Add optional `temperature` and `response_format` parameters to `chatCompletionWithFallback()` | V1 |

### Forge App — Backend

| File | Change | Phase |
|------|--------|-------|
| `forge-app/src/index.js` | Import and register `descriptionResolvers` in the resolver map | MVP |

### Forge App — Frontend

| File | Change | Phase |
|------|--------|-------|
| `forge-app/static/main/src/components/issue-panel/` (parent) | Import and render `DescriptionQuality` component in the issue panel layout | MVP |

### Forge App — Manifest

| File | Change | Phase |
|------|--------|-------|
| `forge-app/manifest.yml` | **No change needed** — existing `jira:issuePanel` module and `ai-server` remote are sufficient | — |

---

## File Dependency Graph

```
MVP:
  ai-server/src/controllers/description-controller.js
    └── ai-server/src/services/description-service.js (deterministic scorer)
  ai-server/src/index.js (route registration)
  forge-app/src/resolvers/descriptionResolvers.js
    └── forge-app/src/utils/remote.js (existing)
  forge-app/src/index.js (resolver registration)
  forge-app/static/main/src/components/issue-panel/DescriptionQuality/*

V1 (builds on MVP):
  ai-server/src/services/ai/ai-client.js (modify)
  ai-server/src/services/ai/description-prompts.js (new)
  ai-server/src/services/description-service.js (add LLM path)

V2 (builds on V1):
  forge-app/src/utils/adfBuilder.js (new)
  forge-app/src/resolvers/descriptionResolvers.js (add updateDescription, wasDescriptionChanged)
  supabase/migrations/YYYYMMDD_description_quality_cache.sql (new)
  ai-server/src/services/description-service.js (add cache logic)
```

---

## Patterns to Follow

### Controller Pattern (ai-server)

Follow `forge-proxy-controller.js`:
- Validate input at controller boundary
- Extract auth info from middleware-attached `req.forgeContext`
- Delegate to service layer
- Return structured JSON response

### Resolver Pattern (forge-app)

Follow `analyticsResolvers.js`:
- Export a flat object of resolver functions
- Each function receives `payload` from `@forge/bridge` invoke
- Use `invokeRemote()` from `src/utils/remote.js` for AI server calls
- Use Jira REST API via `@forge/api` for issue data

### React Component Pattern (forge-app/static)

Follow `issue-panel/` existing components:
- Functional components with hooks
- CSS modules or `.css` files alongside components
- Use `@forge/bridge` `invoke()` for backend communication
- Loading states with spinners for async operations
