# Timeout-Safe Sync with Jira for Unassigned Work

## Problem
The Unassigned Work page `Sync with Jira` action frequently hits Forge invocation timeout limits (25s) when matching many sessions against multiple in-progress issues, causing user-visible failures and no deterministic progress reporting.

## Root cause / context
- Current resolver `syncRecentUnassignedWorkWithAllUpdatedIssues` performs the full workflow in one invocation:
  - fetch previous-day unassigned sessions
  - fetch in-progress Jira issues and details
  - call AI server matching endpoint(s)
  - apply assignments and worklogs
- `sync-all-unassigned` LLM calls can exceed ~25s depending on issue/session volume.
- The UI waits on a single resolver call and cannot continue work after timeout.
- Fixed chunk size does not adapt to issue count/latency.

## Proposed solution
1. Introduce an async job model persisted in Supabase (`unassigned_sync_jobs`):
- start resolver creates job payload (sessions/issues/cursor/progress)
- status resolver polls and advances the job in small budgeted steps
- each poll processes one or more dynamic chunks and persists cursor/progress

2. Dynamic chunk sizing:
- compute per-call session chunk size from issue count + remaining sessions + elapsed invocation budget
- reduce chunk size as complexity/time increases

3. Early partial return near invocation budget:
- enforce a per-invocation processing budget
- stop processing before budget exhaustion, persist state, return `in_progress` with progress counters

4. UI polling workflow:
- `Sync with Jira` starts async job and gets `jobId`
- UI polls status resolver until `completed`/`failed`
- surface progress + final summary banner

## Acceptance criteria
1. `Sync with Jira` no longer depends on a single long Forge invocation for completion.
2. Resolver processing returns partial `in_progress` state before Forge timeout and can resume from saved cursor.
3. Chunk size used for matching adapts based on issues/sessions and invocation progress.
4. UI starts job, polls status, and presents terminal result without the previous timeout error.
5. Tests cover start/status flows and partial-progress behavior.

## Out of scope
- Replacing AI-server matching model/prompt logic.
- Adding a separate external queue worker infrastructure.
- Changes to matching confidence thresholds.