# AI-Assisted Jira Ticket Description Enhancement — Overview

## Feature Summary

An AI-assisted capability integrated into the existing BRD Time Tracker Jira app that evaluates ticket titles and descriptions, provides a quality score, and suggests structured improvements. The system operates with explicit user consent — users review, edit, and accept changes before anything is saved to Jira.

## Business Value

- Improves ticket quality across projects without manual enforcement
- Reduces back-and-forth between reporters and developers
- Provides measurable quality metrics per project
- Zero cost for high-quality tickets (LLM invoked only when score < 80)

## How It Works

1. User opens an issue panel or clicks "Check Quality"
2. System extracts title + description and runs deterministic scoring (9 criteria, 0–100)
3. If score < 80 or user requests improvement → LLM generates structured rewrite
4. User sees score badge, issues list, suggestions, and improved version
5. User can Accept (write back to Jira), Edit, or Reject
6. Only user-approved content is persisted — no automatic overwrites

## Integration Points

- **Forge Issue Panel** (`jira:issuePanel`) — reuses existing panel module
- **AI Server** — new `/api/forge/description/analyze` endpoint
- **Supabase** — new `description_quality_cache` table for caching results
- **Forge Remote** — all communication routed through existing `ai-server` remote

## Delivery Strategy

| Phase | Scope | Timeline |
|-------|-------|----------|
| **MVP** | Deterministic scoring + suggestions display (no LLM, no write-back) | 5–7 days |
| **V1** | + LLM analysis + improved description (read-only, copy to clipboard) | +5–7 days |
| **V2 (Full)** | + Accept/write-back + edit mode + caching + analytics | +5–7 days |

## Key Constraints

- Must use Forge Remote for all ai-server calls (no direct fetch/axios)
- ADF builder must be custom (~50 lines) — @atlaskit/adf-utils is incompatible with Forge resolvers
- PII must be sanitized before any LLM call
- LLM invoked only when deterministic score < 80 or user explicitly requests
- No automatic modification of Jira content without user approval

## Related Documents

| Document | Description |
|----------|-------------|
| [01_ARCHITECTURE.md](./01_ARCHITECTURE.md) | Technical architecture and data flow |
| [02_API_SPECIFICATION.md](./02_API_SPECIFICATION.md) | API endpoints and contracts |
| [03_IMPLEMENTATION_PHASES.md](./03_IMPLEMENTATION_PHASES.md) | Phased delivery plan with acceptance criteria |
| [04_FILE_CHANGES.md](./04_FILE_CHANGES.md) | Files to create and modify |
| [05_TESTING_STRATEGY.md](./05_TESTING_STRATEGY.md) | Test plan per phase |
| [06_UI_SPECIFICATION.md](./06_UI_SPECIFICATION.md) | Frontend component specs |
| [07_SECURITY_AND_COMPLIANCE.md](./07_SECURITY_AND_COMPLIANCE.md) | PII, auth, and data handling |
| [08_DATABASE_SCHEMA.md](./08_DATABASE_SCHEMA.md) | Supabase migration and table design |
