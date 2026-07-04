-- ============================================================================
-- Migration: Trim idle-vs-activity overlap at insert time (C6)
-- Date: 2026-07-03
-- Spec: plan/2026-07-03_python-desktop-app_idle-activity-overlap-c5.md
--
-- Problem: idle records overlap activity records (verified prod+dev, v1.4.10:
-- e.g. idle 11:25–11:31 IST containing productive Code.exe 11:28–11:31). The
-- idle span is INPUT-AUTHORITATIVE (anchor = last real input, resume = next
-- real input; the C1–C3 state machine guarantees no input inside it), so any
-- activity row inside it is phantom wall time from input-less window focus.
-- Both rows count in SUM-based analytics → idle AND productive are inflated by
-- up to idle_timeout (5 min) per idle break, per user, per day.
--
-- The desktop C5 fix stops GENERATING phantom sessions, but cannot reach:
--   * rows a 5-min batch uploaded BEFORE idle was detected (mid-window batch),
--   * offline-queue replays,
--   * every desktop still on <= 1.4.10 during the rollout.
-- These triggers reconcile at insert time. Contract: IDLE WINS.
--
--   T1 (AFTER INSERT of an idle row): same-user non-idle rows fully inside the
--      idle span are NEUTRALIZED (durations → 0, interval collapsed to
--      end_time = start_time — input-less focus flips); rows straddling an
--      edge are TRIMMED to the edge with durations reduced (floor 0).
--   T2 (BEFORE INSERT of a non-idle row): the incoming row is clipped against
--      already-stored idle rows (neutralized the same way when fully covered).
--      Covers replays where activity arrives after its idle row.
--
-- !! WHY NEUTRALIZE INSTEAD OF DELETE/DROP — DO NOT "SIMPLIFY" THIS !!
-- The desktop verifies uploads by (a) requiring a non-empty INSERT result
-- (desktop_app.py:10716/10784) and (b) re-fetching the FIRST inserted row by
-- id over raw HTTP (desktop_app.py:10748-10753 — that branch exists because a
-- previous trigger broke this exact check). A trigger that deletes the first
-- row or drops a whole batch makes the desktop restore + re-insert the same
-- request_id rows → unique-index violation (idx_activity_request_id) → a hard
-- retry loop. Neutralized rows persist as inert zero-duration stubs: every
-- analytics path ignores them (SUMs add 0; the detail page's interval-merge
-- skips end_time <= start_time; the timeline filters them the same way).
-- end_time = start_time is safe: single-event sessions already upload with
-- first_seen == last_seen, so no CHECK constraint can require end > start.
--
-- Batch-order note: the desktop uploads sessions and idle records in ONE
-- insert statement, sessions first. AFTER ROW triggers run at statement end
-- and see every row of the statement, so T1 also reconciles same-batch rows.
--
-- SECURITY DEFINER + pinned search_path: the desktop inserts as a JWT-scoped
-- role whose RLS policies do not necessarily allow UPDATE/DELETE of activity
-- rows; the trigger's internal DML must not depend on the caller's policies.
-- Probes are bounded (same user + 16 h window) and served by
-- idx_activity_user_timestamp (user_id, start_time).
--
-- Sanity guards: NULL/inverted/oversized (>16 h) idle spans reconcile nothing —
-- pathological legacy rows cannot mass-delete history.
--
-- VERIFIED AGAINST THE LIVE SCHEMA (user-run query, 2026-07-03):
--   * No CHECK constraint on start_time/end_time → end_time = start_time stubs
--     are legal. status CHECK includes 'analyzed' → the status flip is legal.
--   * trigger_activity_compute_work_date (BEFORE INSERT OR UPDATE, row-level)
--     recomputes work_date — so T1's start_time trims get a corrected work_date
--     automatically. !! NAMING CONSTRAINT: BEFORE-row triggers fire in
--     alphabetical order; trg_clip_activity_against_idle MUST sort before
--     trigger_activity_compute_work_date ('trg_' < 'tri') so work_date is
--     computed from the CLIPPED start_time. Do not rename either trigger
--     without re-checking this ordering.
--   * on_activity_record_insert (AFTER, statement-level, transition table)
--     coexists safely: it snapshots rows as inserted; T1's updates to other
--     rows don't affect it. A stub row may still be sent to the AI webhook
--     with its pre-neutralization payload — harmless (durations stay 0).
--   * trigger_activity_records_updated_at stamps updated_at on T1's trims —
--     desired.
--
-- SCALE (user-run query, last 7 days, 2026-07-03): 7,914 of 12,331 idle rows
-- (64%) overlap activity across 52 users; most recent overlap same-day. The
-- pairwise overlap upper bound is ~766 h/week — this migration is what stops
-- the accumulation fleet-wide before the desktop rollout completes.
--
-- Apply: paste the whole file in the Supabase Dashboard SQL editor (plain
-- DDL — the implicit transaction is fine). Idempotent (CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS). Rollback: the two DROP TRIGGER statements at the
-- bottom (commented).
-- ============================================================================

-- ---- T1: idle row arrives → reconcile stored activity ----------------------
create or replace function public.trim_activity_overlapping_idle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sanity: only well-formed, plausibly-real idle spans reconcile.
  if new.start_time is null or new.end_time is null
     or new.end_time <= new.start_time
     or new.end_time - new.start_time > interval '16 hours' then
    return null;
  end if;

  -- Input-less focus flips: non-idle rows fully inside the idle span are
  -- neutralized in place (NEVER deleted — see header). status only moves
  -- pending → analyzed so the AI pipeline skips the stub; other statuses kept.
  update public.activity_records ar
     set duration_seconds   = 0,
         total_time_seconds = 0,
         end_time           = ar.start_time,
         status             = case when ar.status = 'pending' then 'analyzed' else ar.status end
   where ar.user_id = new.user_id
     and ar.id <> new.id
     and ar.is_idle = false
     and ar.end_time > ar.start_time
     and ar.start_time >= new.start_time
     and ar.end_time   <= new.end_time;

  -- Tail overlap: row started before the idle span, extended into it.
  update public.activity_records ar
     set duration_seconds   = greatest(0, coalesce(ar.duration_seconds, 0)
                              - cast(extract(epoch from (ar.end_time - new.start_time)) as int)),
         total_time_seconds = greatest(0, coalesce(ar.total_time_seconds, 0)
                              - cast(extract(epoch from (ar.end_time - new.start_time)) as int)),
         end_time = new.start_time
   where ar.user_id = new.user_id
     and ar.id <> new.id
     and ar.is_idle = false
     and ar.start_time <  new.start_time
     and ar.start_time >  new.start_time - interval '16 hours'
     and ar.end_time   >  new.start_time
     and ar.end_time   <= new.end_time;

  -- Head overlap: row started inside the idle span, extended past it.
  update public.activity_records ar
     set duration_seconds   = greatest(0, coalesce(ar.duration_seconds, 0)
                              - cast(extract(epoch from (new.end_time - ar.start_time)) as int)),
         total_time_seconds = greatest(0, coalesce(ar.total_time_seconds, 0)
                              - cast(extract(epoch from (new.end_time - ar.start_time)) as int)),
         start_time = new.end_time
   where ar.user_id = new.user_id
     and ar.id <> new.id
     and ar.is_idle = false
     and ar.start_time >= new.start_time
     and ar.start_time <  new.end_time
     and ar.end_time   >  new.end_time;

  -- Row spanning the whole idle period (rare, legacy shapes): keep its
  -- interval, remove the idle span's seconds from its durations. The portal
  -- timeline clips the display; totals stop double-counting.
  update public.activity_records ar
     set duration_seconds   = greatest(0, coalesce(ar.duration_seconds, 0)
                              - cast(extract(epoch from (new.end_time - new.start_time)) as int)),
         total_time_seconds = greatest(0, coalesce(ar.total_time_seconds, 0)
                              - cast(extract(epoch from (new.end_time - new.start_time)) as int))
   where ar.user_id = new.user_id
     and ar.id <> new.id
     and ar.is_idle = false
     and ar.start_time <  new.start_time
     and ar.start_time >  new.start_time - interval '16 hours'
     and ar.end_time   >  new.end_time;

  return null;
end;
$$;

drop trigger if exists trg_trim_activity_on_idle_insert on public.activity_records;
create trigger trg_trim_activity_on_idle_insert
  after insert on public.activity_records
  for each row
  when (new.is_idle = true)
  execute function public.trim_activity_overlapping_idle();

-- ---- T2: non-idle row arrives → clip it against stored idle ----------------
create or replace function public.clip_activity_against_idle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clip_end   timestamptz;
  v_clip_start timestamptz;
begin
  if new.start_time is null or new.end_time is null
     or new.end_time <= new.start_time then
    return new;
  end if;

  -- Fully covered by one stored idle span → pure phantom. NEVER dropped (the
  -- desktop requires a non-empty insert result — see header): neutralize the
  -- incoming row to an inert zero-duration stub and let it insert.
  if exists (
      select 1 from public.activity_records i
       where i.user_id = new.user_id
         and i.is_idle = true
         and i.start_time <= new.start_time
         and i.end_time   >= new.end_time
         and i.start_time >  new.start_time - interval '16 hours'
  ) then
    new.duration_seconds   := 0;
    new.total_time_seconds := 0;
    new.end_time           := new.start_time;
    if new.status = 'pending' then
      new.status := 'analyzed';
    end if;
    return new;
  end if;

  -- Clip the tail at the earliest idle start inside the row.
  select min(i.start_time) into v_clip_end
    from public.activity_records i
   where i.user_id = new.user_id
     and i.is_idle = true
     and i.start_time > new.start_time
     and i.start_time < new.end_time;
  if v_clip_end is not null then
    new.duration_seconds   := greatest(0, coalesce(new.duration_seconds, 0)
                              - cast(extract(epoch from (new.end_time - v_clip_end)) as int));
    new.total_time_seconds := greatest(0, coalesce(new.total_time_seconds, 0)
                              - cast(extract(epoch from (new.end_time - v_clip_end)) as int));
    new.end_time := v_clip_end;
  end if;

  -- Clip the head at the latest idle end inside the (possibly shortened) row.
  select max(i.end_time) into v_clip_start
    from public.activity_records i
   where i.user_id = new.user_id
     and i.is_idle = true
     and i.end_time > new.start_time
     and i.end_time < new.end_time
     and i.start_time > new.start_time - interval '16 hours';
  if v_clip_start is not null then
    new.duration_seconds   := greatest(0, coalesce(new.duration_seconds, 0)
                              - cast(extract(epoch from (v_clip_start - new.start_time)) as int));
    new.total_time_seconds := greatest(0, coalesce(new.total_time_seconds, 0)
                              - cast(extract(epoch from (v_clip_start - new.start_time)) as int));
    new.start_time := v_clip_start;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_clip_activity_against_idle on public.activity_records;
create trigger trg_clip_activity_against_idle
  before insert on public.activity_records
  for each row
  when (new.is_idle = false)
  execute function public.clip_activity_against_idle();

-- ---- Verification (read-only; run after applying) --------------------------
-- 1) New overlaps should stop appearing: run this tomorrow — expect ~0 rows
--    with created_at after the apply time. (Rows the "spanning" branch handled
--    keep their interval — durations corrected — and can still match this
--    join; anything beyond that means a case the triggers missed.)
--   select count(*) from public.activity_records i
--   join public.activity_records a
--     on a.user_id = i.user_id and a.is_idle = false
--    and a.start_time < i.end_time and a.end_time > i.start_time
--   where i.is_idle = true and i.created_at > '<apply-timestamp>';
-- 2) Functional smoke on DEV: insert a fake non-idle row inside an existing
--    idle span for a test user → it should arrive as a zero-duration stub
--    (duration_seconds = 0, end_time = start_time), NOT be rejected.
--
-- Rollback:
--   drop trigger if exists trg_trim_activity_on_idle_insert on public.activity_records;
--   drop trigger if exists trg_clip_activity_against_idle on public.activity_records;
