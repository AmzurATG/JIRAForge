-- ============================================================================
-- Diagnostic: is the idle-vs-activity overlap (C5/C6) still being generated?
-- Date: 2026-07-04 | READ-ONLY — safe to run on prod and dev.
-- Run each statement SEPARATELY in the Supabase Dashboard SQL editor
-- (the editor shows only the last result if you run them together).
--
-- Baseline for comparison (user-run, 2026-07-03, prod, last 7 days):
--   7,914 / 12,331 idle rows (64%) overlapped activity, 52 users affected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Q1 — Are the C6 triggers installed? (expect 2 rows, tgenabled = 'O')
--      0 rows = migration not applied yet → overlaps are still accumulating.
-- ---------------------------------------------------------------------------
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.activity_records'::regclass
  and tgname in ('trg_trim_activity_on_idle_insert',
                 'trg_clip_activity_against_idle');

-- ---------------------------------------------------------------------------
-- Q2 — Overlap generation trend, by UPLOAD day (last 7 days).
--      If C6 is applied and working, overlap_hours should collapse to ~0 for
--      days after the apply time. (Rows handled by the trigger's "spanning"
--      branch keep their interval — durations corrected — and can still match
--      this join, so a small residue on the apply day itself is expected.)
--      Neutralized stubs (end_time = start_time) are excluded on both sides.
-- ---------------------------------------------------------------------------
with recent_idle as (
  select id, user_id, start_time, end_time, created_at
  from public.activity_records
  where is_idle = true
    and created_at >= now() - interval '7 days'
    and end_time > start_time
    and end_time - start_time <= interval '16 hours'
)
select
  date_trunc('day', i.created_at)           as upload_day,
  count(distinct i.id)                      as idle_rows_with_overlap,
  count(*)                                  as overlapping_pairs,
  count(distinct i.user_id)                 as users_affected,
  round((sum(extract(epoch from
      (least(i.end_time, a.end_time) - greatest(i.start_time, a.start_time))
    )) / 3600.0)::numeric, 2)               as overlap_hours,
  max(greatest(i.created_at, a.created_at)) as most_recent_overlap_upload
from recent_idle i
join public.activity_records a
  on  a.user_id   = i.user_id
  and a.is_idle   = false
  and a.end_time  > a.start_time                          -- skip C6 stubs
  and a.start_time < i.end_time
  and a.end_time   > i.start_time
  and a.start_time > i.start_time - interval '16 hours'   -- index-bounded probe
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- Q3 — The 20 most recently UPLOADED overlap pairs, with desktop version.
--      Shows whether fresh overlaps are still arriving right now, from which
--      app versions, and what they look like (times in UTC).
-- ---------------------------------------------------------------------------
with recent_idle as (
  select id, user_id, start_time, end_time, created_at,
         metadata->>'app_version' as idle_app_version
  from public.activity_records
  where is_idle = true
    and created_at >= now() - interval '3 days'
    and end_time > start_time
    and end_time - start_time <= interval '16 hours'
)
select
  greatest(i.created_at, a.created_at)      as uploaded_at,
  i.user_id,
  coalesce(a.metadata->>'app_version',
           i.idle_app_version)              as app_version,
  i.start_time                              as idle_start,
  i.end_time                                as idle_end,
  a.application_name,
  a.classification,
  a.start_time                              as act_start,
  a.end_time                                as act_end,
  round((extract(epoch from
      (least(i.end_time, a.end_time) - greatest(i.start_time, a.start_time))
    ) / 60.0)::numeric, 1)                  as overlap_minutes
from recent_idle i
join public.activity_records a
  on  a.user_id   = i.user_id
  and a.is_idle   = false
  and a.end_time  > a.start_time
  and a.start_time < i.end_time
  and a.end_time   > i.start_time
  and a.start_time > i.start_time - interval '16 hours'
order by greatest(i.created_at, a.created_at) desc
limit 20;
