# Realtime description-quality refresh for all in-progress tickets

## Problem
Description quality values shown in desktop popup can diverge from issue-panel values because scheduler uses cached/stale scores and does not guarantee a 30-minute recency window.

## Root cause / context
The nudge scheduler reads `description_quality_cache` and only warms missing scores with a per-run cap. Existing cached scores can remain stale after ticket edits. Scheduled trigger interval is hourly, so even refreshed values can be delayed.

## Proposed solution
1. In nudge scheduler, re-analyze all open in-progress candidate issues on every run (using analyzer path) and overwrite in-memory scores used for notification selection.
2. Enforce effective 30-minute cadence by running frequently and throttling execution with a persisted last-run timestamp.
3. Update Forge manifest schedule to frequent trigger cadence and rely on lock+throttle to avoid overrun.

## Acceptance criteria
1. Scheduler evaluates fresh score for every in-progress candidate issue each execution.
2. Effective scheduler execution happens at most once per 30 minutes per tenant.
3. Trigger config supports 30-minute cadence operation.
4. Existing channel threshold behavior (`score < 80`) remains intact.

## Out of scope
- Changing score thresholds.
- UI layout changes in issue panel.
- Database schema migrations.
