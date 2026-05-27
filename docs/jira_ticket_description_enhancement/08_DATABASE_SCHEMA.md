# Database Schema

## New Table: `description_quality_cache`

### Purpose

Caches analysis results to avoid redundant scoring/LLM calls when the issue panel is opened on a previously analyzed ticket with unchanged content.

### Schema

```sql
-- Migration: YYYYMMDD_description_quality_cache.sql
-- Purpose: Cache table for AI-assisted description quality analysis results.
-- Stores per-issue analysis with content-hash-based invalidation.

CREATE TABLE IF NOT EXISTS description_quality_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,          -- SHA-256 of (title + description)
  score INTEGER NOT NULL,              -- 0–100
  source TEXT NOT NULL DEFAULT 'deterministic',  -- 'deterministic' | 'llm'
  issues JSONB NOT NULL DEFAULT '[]',  -- string array of identified issues
  suggestions JSONB NOT NULL DEFAULT '[]',  -- string array of suggestions
  improved_title TEXT,                 -- null if deterministic only
  improved_description TEXT,           -- null if deterministic only
  issue_type TEXT NOT NULL,            -- Bug, Story, Task, Epic, Sub-task
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Unique constraint: one cache entry per issue per org
  CONSTRAINT uq_org_issue UNIQUE (org_id, issue_key)
);

-- Index for fast lookups
CREATE INDEX idx_desc_cache_org_issue ON description_quality_cache (org_id, issue_key);
CREATE INDEX idx_desc_cache_content_hash ON description_quality_cache (content_hash);

-- RLS
ALTER TABLE description_quality_cache ENABLE ROW LEVEL SECURITY;

-- Policy: users can only access their org's cache entries
CREATE POLICY "org_isolation" ON description_quality_cache
  FOR ALL
  USING (org_id = current_setting('request.jwt.claims')::json->>'org_id')
  WITH CHECK (org_id = current_setting('request.jwt.claims')::json->>'org_id');

-- Service role bypass for ai-server operations
CREATE POLICY "service_role_access" ON description_quality_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

### Column Details

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID | No | Primary key |
| `org_id` | TEXT | No | Organization/tenant identifier (maps to Jira cloudId) |
| `issue_key` | TEXT | No | Jira issue key (e.g., "PROJ-123") |
| `content_hash` | TEXT | No | SHA-256 hash of `title + "\n" + description` for cache invalidation |
| `score` | INTEGER | No | Quality score 0–100 |
| `source` | TEXT | No | "deterministic" or "llm" — indicates which engine produced the result |
| `issues` | JSONB | No | Array of identified quality issues |
| `suggestions` | JSONB | No | Array of improvement suggestions |
| `improved_title` | TEXT | Yes | AI-improved title (null when only deterministic scoring) |
| `improved_description` | TEXT | Yes | AI-improved description (null when only deterministic scoring) |
| `issue_type` | TEXT | No | Issue type at time of analysis |
| `created_at` | TIMESTAMPTZ | No | First analysis timestamp |
| `updated_at` | TIMESTAMPTZ | No | Last upsert timestamp |

---

## Cache Logic

### Write (Upsert)

After successful analysis, upsert by `(org_id, issue_key)`:

```sql
INSERT INTO description_quality_cache 
  (org_id, issue_key, content_hash, score, source, issues, suggestions, 
   improved_title, improved_description, issue_type, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
ON CONFLICT (org_id, issue_key) 
DO UPDATE SET 
  content_hash = EXCLUDED.content_hash,
  score = EXCLUDED.score,
  source = EXCLUDED.source,
  issues = EXCLUDED.issues,
  suggestions = EXCLUDED.suggestions,
  improved_title = EXCLUDED.improved_title,
  improved_description = EXCLUDED.improved_description,
  issue_type = EXCLUDED.issue_type,
  updated_at = NOW();
```

### Read (Cache Lookup)

On panel open, check if cached result exists with matching content hash:

```sql
SELECT score, source, issues, suggestions, improved_title, improved_description
FROM description_quality_cache
WHERE org_id = $1 
  AND issue_key = $2 
  AND content_hash = $3;
```

- If row exists with matching hash → return cached result (`cached: true`)
- If row exists with different hash → cache stale, re-analyze
- If no row → first analysis, proceed with scoring

### Content Hash Generation

```javascript
const crypto = require('crypto');

function generateContentHash(title, description) {
  const content = `${title}\n${description}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

---

## Analytics Table (Future — V2+)

For tracking accept/reject/edit ratios and score trends:

```sql
-- Optional: analytics event log (can be added in a follow-up migration)
CREATE TABLE IF NOT EXISTS description_quality_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,            -- 'analyze' | 'improve' | 'accept' | 'edit' | 'reject'
  score_before INTEGER,                -- score at time of event
  score_after INTEGER,                 -- score after improvement (if applicable)
  source TEXT,                         -- 'deterministic' | 'llm'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE description_quality_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON description_quality_events
  FOR ALL
  USING (org_id = current_setting('request.jwt.claims')::json->>'org_id')
  WITH CHECK (org_id = current_setting('request.jwt.claims')::json->>'org_id');

CREATE POLICY "service_role_access" ON description_quality_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_desc_events_org ON description_quality_events (org_id, created_at DESC);
```

---

## Migration Naming

Following the project convention:
```
supabase/migrations/YYYYMMDD_description_quality_cache.sql
```

Replace `YYYYMMDD` with the actual implementation date (e.g., `20260527_description_quality_cache.sql`).
