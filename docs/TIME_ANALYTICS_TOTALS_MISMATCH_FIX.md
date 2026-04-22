# Time Analytics Totals Mismatch — Fix Plan

**Date:** 2026-04-22
**Migration:** [`supabase/migrations/20260422_summaries_include_all_statuses.sql`](../supabase/migrations/20260422_summaries_include_all_statuses.sql)
**Affected screen:** Jira Forge app → Time Analytics tab (Today / Week / Month summary cards)

---

## Symptom

On the Time Analytics screen, the timeline bars and the summary cards disagreed on how much time a user had tracked for a given day.

- Timeline bars showed the correct, full set of tracked intervals (including "unassigned" blocks).
- The **Today / Week / Month** cards at the top showed a much smaller total.
- Example: timeline said **~3 hours**, the Today card said **~5 minutes** — for the exact same day.

## Root cause — in plain English

The Time Analytics screen pulled numbers from **two different places**, and those two places didn't agree on which tracked time to count.

- **The timeline bars** (the horizontal strips showing what was worked on and when) were built from the **raw tracking records** the desktop app sent up. Every tracked interval was there — including ones the AI couldn't classify.
- **The summary cards on top** (Today / Week / Month) were built from a **summary table** that only counted records our AI had **successfully processed** (statuses `pending`, `processing`, `analyzed`). Records that **failed AI processing** (status `failed`) were silently skipped.

So when the desktop app tracked your time but the AI couldn't classify it, that time showed up on the timeline as unassigned blocks, but was **missing from the card totals**.

Result: timeline says ~3 hours, card says ~5 minutes — for the exact same day.

## Why it matters

The product intent is simple: **if the desktop app tracked it, it counts as time worked.** AI classification is a labeling concern, not a gating concern. Users shouldn't lose credit for tracked time just because an OCR pass or AI call failed.

Before this fix, ~12,000 seconds (≈3h 20m) of tracked time for the reporting user on a single day were being dropped from the totals because their `activity_records` were in `failed` status.

## The fix

Remove the `status IN ('pending','processing','analyzed')` filter from the three summary views so they count **all** tracked activity records regardless of AI status.

The three views rebuilt (no other logic changed):

- `public.daily_time_summary`
- `public.weekly_time_summary`
- `public.monthly_time_summary`

What stays the same (intentionally):

- **Idle time still excluded** — `COALESCE(is_idle, false) = false`.
- **Lock-screen processes still excluded** — `lockapp.exe`, `logonui.exe`.
- **Legacy screenshot/analysis branch unchanged** — still gated by `work_type = 'office'`.
- **SECURITY INVOKER** still set on all three views.

## Deploying

The migration file is merged to `main` but has **not** been applied to the production database yet.

```bash
cd supabase
supabase db push
```

This runs [`20260422_summaries_include_all_statuses.sql`](../supabase/migrations/20260422_summaries_include_all_statuses.sql), which drops and recreates the three views.

## Verification

After applying the migration, for a user who had `failed` activity records on a given day:

1. Open **Time Analytics** in Jira.
2. The **Today** card total should now match the sum of the timeline bars for that day.
3. Week and Month totals should include the previously dropped `failed`-status time.

SQL sanity check (replace `<user_id>` / `<date>`):

```sql
-- Raw activity time the timeline sees
SELECT SUM(duration_seconds)
FROM public.activity_records
WHERE user_id = '<user_id>'
  AND work_date = '<date>'
  AND COALESCE(is_idle, false) = false
  AND LOWER(COALESCE(application_name, '')) NOT IN ('lockapp.exe', 'logonui.exe');

-- What the summary card now sees (should match, modulo legacy screenshot data)
SELECT SUM(total_seconds)
FROM public.daily_time_summary
WHERE user_id = '<user_id>'
  AND work_date = '<date>';
```

## Related files (reference only, not changed by this fix)

- [`forge-app/src/services/analytics/teamAnalyticsService.js`](../forge-app/src/services/analytics/teamAnalyticsService.js) — `fetchMyDayTimeline` already queries `activity_records` with no status filter. It has always been correct; the views were the outliers.
- [`forge-app/static/main/src/components/tabs/time-analytics/DayView.js`](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js) — reconciles per-user totals against the timeline via `Math.max`, which papered over the bug at the per-user row level but not at the card-total level.
- [`forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js`](../forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js) — renders Today/Week/Month from `dailySummary` + `todayDelta` reconciliation. Now gets correct numbers from the fixed views.
