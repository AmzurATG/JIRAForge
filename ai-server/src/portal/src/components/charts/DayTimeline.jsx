/**
 * DayTimeline — a user's days as horizontal merged-activity bars on ONE shared
 * time axis.
 *
 * Revamp (spec: plan/2026-07-03_portal_employee-timeline-revamp.md):
 *   - Every visible day renders on the SAME minutes-of-day window, so equal
 *     width = equal duration across rows (a 4-minute day is a sliver on a
 *     striped track, not a full green bar).
 *   - Runs are split at each midnight of the record's own timezone
 *     (user_timezone, i.e. the same local day work_date uses); a day-bar never
 *     contains another calendar day's hours.
 *   - `visibleDates` (optional Set of 'YYYY-MM-DD') trims tracks to the pager's
 *     current chunk — spill pieces from the ±1-day fetch padding are dropped.
 *
 * Kept from the original "Spectrum" design (plan 2026-06-26): consecutive
 * same-category records coalesce into runs (≤2-min gaps bridged), untracked
 * time is the striped track background, hover shows a scrubber + tooltip, and
 * runs are keyed by identity so silent background refreshes extend the bar
 * without remounting.
 */

import { useState } from 'react';
import { toCategory } from '../common/CategoryBadge';
import { formatDuration } from '../../utils/formatters';

// "Spectrum" palette (claude.ai/design · Timeline Palettes — the chosen scheme).
// Categories separate on hue + lightness, so productive (green) and
// non-productive (vermillion) survive red-green color blindness. Other portal
// charts intentionally keep the older palette.
const CATEGORY_COLOR = {
  productive: '#0CA678',
  'non-productive': '#E8590C',
  neutral: '#3D5A80',
  idle: '#B6BECB',
};
const CATEGORY_LABEL = {
  productive: 'Productive',
  'non-productive': 'Non-Productive',
  neutral: 'Unknown',
  idle: 'Idle',
};

// Bridge ≤2-min gaps between same-category records (capture-cadence jitter);
// larger gaps stay as real untracked space between blocks.
const MERGE_BRIDGE_MS = 2 * 60 * 1000;
const MAX_DAYS = 31;
const MIN_AXIS_SPAN_MIN = 4 * 60; // a lone tiny day must not stretch to full width
const DAY_MIN = 24 * 60;

// ---- Timezone helpers -------------------------------------------------------
// Formatter construction is expensive; cache per timezone. An invalid/missing
// IANA name falls back to the viewer's timezone (identical for the current
// fleet, where employees and portal admins share IST).

const dateFmtCache = new Map();
function dateFormatter(tz) {
  const key = tz || '(local)';
  if (!dateFmtCache.has(key)) {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined }); // YYYY-MM-DD
    } catch {
      fmt = new Intl.DateTimeFormat('en-CA');
    }
    dateFmtCache.set(key, fmt);
  }
  return dateFmtCache.get(key);
}

const timeFmtCache = new Map();
function timeFormatter(tz) {
  const key = tz || '(local)';
  if (!timeFmtCache.has(key)) {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    timeFmtCache.set(key, fmt);
  }
  return timeFmtCache.get(key);
}

const dateKeyInTz = (ms, tz) => dateFormatter(tz).format(ms);

function minutesOfDayInTz(ms, tz) {
  const [h, m] = timeFormatter(tz).format(ms).split(':');
  return (parseInt(h, 10) % 24) * 60 + parseInt(m, 10);
}

/**
 * First instant after `ms` where the local date (in tz) changes. Binary search
 * on the date key — DST-proof, no timezone library needed. Crossings are rare
 * (one per overnight run), so the ~40 formats per call are negligible.
 */
function nextMidnightMs(ms, tz) {
  const key = dateKeyInTz(ms, tz);
  let lo = ms;
  let hi = ms + 36 * 3600 * 1000;
  while (dateKeyInTz(hi, tz) === key) hi += 24 * 3600 * 1000;
  while (hi - lo > 500) {
    const mid = (lo + hi) / 2;
    if (dateKeyInTz(mid, tz) === key) lo = mid; else hi = mid;
  }
  return Math.round(hi);
}

/** Minutes-of-day → "09:41 AM" (matches the previous locale-time look). */
function fmtMin(min) {
  const clamped = Math.max(0, Math.min(DAY_MIN, Math.round(min)));
  const h24 = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  // 24:00 (a run ending exactly at midnight) must not read as 12:00 AM of the same day.
  if (clamped === DAY_MIN) return '12:00 AM';
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Union of [start, end] minute intervals, sorted and merged. */
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

/** [start, end) minus a sorted-merged blocker list → remaining fragments. */
function subtractIntervals(start, end, blockers) {
  const out = [];
  let s = start;
  for (const [bs, be] of blockers) {
    if (be <= s) continue;
    if (bs >= end) break;
    if (bs > s) out.push([s, bs]);
    s = Math.max(s, be);
    if (s >= end) break;
  }
  if (s < end) out.push([s, end]);
  return out;
}

/**
 * Pure: activity records → shared-axis day tracks.
 * `visibleDates` (optional Set of 'YYYY-MM-DD') is applied BEFORE the axis is
 * computed, so hidden spill days from the pager's ±1-day fetch padding cannot
 * stretch the shared window.
 * Returns { tracks, axisStartMin, axisEndMin }; tracks newest-day-first, each
 * { date, firstStartMin, lastEndMin, runs: [{ key, category, startMin, endMin,
 * durationSec, apps }] }. Exported for reuse/tests.
 */
export function buildDayTracks(records, visibleDates = null) {
  const valid = (records || [])
    .map((r) => {
      const start = r.startTime ? new Date(r.startTime).getTime() : NaN;
      let end = r.endTime ? new Date(r.endTime).getTime() : NaN;
      if (Number.isNaN(end) && Number.isFinite(start) && r.durationSeconds) {
        end = start + r.durationSeconds * 1000;
      }
      return {
        start,
        end,
        category: toCategory(r.category || r.classification),
        app: r.application || r.applicationName || '',
        tz: r.userTimezone || null,
      };
    })
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // 1. Coalesce consecutive same-category records into runs (bridging tiny
  //    gaps). Midnight handling comes after — bridging across it is fine
  //    because the run is split again below.
  const runs = [];
  let cur = null;
  for (const r of valid) {
    if (cur && r.category === cur.category && r.start - cur.end <= MERGE_BRIDGE_MS) {
      cur.end = Math.max(cur.end, r.end);
      if (r.app) cur.apps.add(r.app);
    } else {
      if (cur) runs.push(cur);
      cur = { category: r.category, start: r.start, end: r.end, tz: r.tz, apps: new Set(r.app ? [r.app] : []) };
    }
  }
  if (cur) runs.push(cur);

  // 2. Split each run at local midnight(s) and key every piece by the local
  //    calendar day it falls in (== work_date for desktop-written records).
  const byDay = new Map();
  const pushPiece = (dayKey, piece) => {
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(piece);
  };

  for (const run of runs) {
    let cursor = run.start;
    let guard = 0;
    while (cursor < run.end && guard < 62) { // 62 = 2 months of midnights, hard stop
      guard += 1;
      const dayKey = dateKeyInTz(cursor, run.tz);
      const midnight = nextMidnightMs(cursor, run.tz);
      const pieceEnd = Math.min(run.end, midnight);
      const startMin = minutesOfDayInTz(cursor, run.tz);
      const endMin = pieceEnd === midnight ? DAY_MIN : startMin + (pieceEnd - cursor) / 60000;
      pushPiece(dayKey, {
        key: `${dayKey}-${Math.round(cursor)}-${run.category}`,
        category: run.category,
        startMin,
        endMin: Math.min(DAY_MIN, endMin),
        durationSec: Math.round((pieceEnd - cursor) / 1000),
        apps: [...run.apps],
      });
      cursor = pieceEnd;
    }
  }

  let tracks = [];
  for (const [date, rawPieces] of byDay) {
    // The desktop can write activity records that OVERLAP an idle block
    // (verified in dev/prod: e.g. idle 11:25–11:31 "containing" productive
    // 11:28–11:31). The idle span is INPUT-AUTHORITATIVE — anchor = last real
    // input, resume = next real input — so overlapped "activity" is phantom
    // wall time from input-less focus changes. IDLE WINS: non-idle pieces are
    // clipped to the gaps left by idle pieces (dropped when fully covered), so
    // color, hover, and durations agree with the data contract enforced at the
    // source (desktop C5) and at insert time (DB triggers C6). Spec:
    // plan/2026-07-03_python-desktop-app_idle-activity-overlap-c5.md
    const idlePieces = rawPieces.filter((p) => p.category === 'idle');
    const blockers = mergeIntervals(idlePieces.map((p) => [p.startMin, p.endMin]));
    const pieces = [...idlePieces];
    for (const p of rawPieces) {
      if (p.category === 'idle') continue;
      subtractIntervals(p.startMin, p.endMin, blockers).forEach(([s, e], i) => {
        if (e - s < 0.05) return; // sub-3s fragment: invisible, skip
        pieces.push({
          ...p,
          key: `${p.key}-f${i}`,
          startMin: s,
          endMin: e,
          durationSec: Math.round((e - s) * 60),
        });
      });
    }
    if (pieces.length === 0) continue;
    pieces.sort((a, b) => a.startMin - b.startMin);
    tracks.push({
      date,
      firstStartMin: pieces[0].startMin,
      lastEndMin: pieces.reduce((mx, p) => Math.max(mx, p.endMin), 0),
      runs: pieces,
    });
  }
  if (visibleDates) tracks = tracks.filter((t) => visibleDates.has(t.date));
  tracks.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest day first

  // 3. One shared axis for every track: hour-snapped envelope of all activity,
  //    stretched to a minimum span so a lone sliver of a day stays a sliver.
  let axisStartMin = 0;
  let axisEndMin = DAY_MIN;
  if (tracks.length > 0) {
    axisStartMin = Math.floor(Math.min(...tracks.map((t) => t.firstStartMin)) / 60) * 60;
    axisEndMin = Math.ceil(Math.max(...tracks.map((t) => t.lastEndMin)) / 60) * 60;
    if (axisEndMin - axisStartMin < MIN_AXIS_SPAN_MIN) {
      axisEndMin = Math.min(DAY_MIN, axisStartMin + MIN_AXIS_SPAN_MIN);
      axisStartMin = Math.max(0, axisEndMin - MIN_AXIS_SPAN_MIN);
    }
  }

  return { tracks, axisStartMin, axisEndMin };
}

// Subtle diagonal stripe for untracked track background (inline to avoid Tailwind
// arbitrary-value parsing of the gradient). Translucent so it reads on both the
// light and dark track base.
const UNTRACKED_BG = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent 0 6px, rgba(148,163,184,0.16) 6px 12px)',
};

// Five evenly-spaced clock ticks across the SHARED axis. First label is
// left-aligned, last right-aligned, the rest centered on their mark.
function buildTicks(axisStartMin, axisEndMin) {
  const span = Math.max(1, axisEndMin - axisStartMin);
  const N = 4; // 5 ticks (0 … N)
  return Array.from({ length: N + 1 }, (_, i) => {
    const frac = i / N;
    const first = i === 0;
    const last = i === N;
    return {
      left: frac * 100,
      tx: first ? '0' : last ? '-100%' : '-50%',
      align: first ? 'flex-start' : last ? 'flex-end' : 'center',
      label: fmtMin(axisStartMin + frac * span),
    };
  });
}

function DayTimeline({ records, loading, visibleDates }) {
  const [hover, setHover] = useState(null);

  if (loading) {
    return <div className="h-24 flex items-center justify-center text-gray-400 text-sm">Loading timeline…</div>;
  }

  const { tracks, axisStartMin, axisEndMin } = buildDayTracks(records, visibleDates);

  if (tracks.length === 0) {
    return (
      <div className="h-24 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
        No activity tracked for the selected period.
      </div>
    );
  }

  const shown = tracks.slice(0, MAX_DAYS);
  const hidden = tracks.length - shown.length;
  const span = Math.max(1, axisEndMin - axisStartMin);
  const ticks = buildTicks(axisStartMin, axisEndMin);
  const pctOf = (min) => ((min - axisStartMin) / span) * 100;

  // Map the cursor to the block (or untracked gap) under it on a given track.
  const handleMove = (e, track) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const pct = f * 100;
    const cursorMin = axisStartMin + f * span;

    // Reverse scan: runs render in array order, so the LAST match is the one
    // painted on top — hover must report what the eye sees if categories still
    // overlap (non-idle is pre-clipped around idle, but this keeps any residual
    // cross-category overlap honest).
    const run = [...track.runs].reverse().find((r) => cursorMin >= r.startMin && cursorMin < r.endMin);
    if (run) {
      setHover({
        date: track.date,
        pct,
        tipLeft: Math.max(8, Math.min(92, pct)),
        untracked: false,
        label: CATEGORY_LABEL[run.category],
        color: CATEGORY_COLOR[run.category],
        startMin: run.startMin,
        endMin: run.endMin,
        durSec: run.durationSec,
        apps: run.apps,
      });
      return;
    }

    // Cursor is in untracked space — report the gap's bounds on the shared axis.
    let prevEnd = axisStartMin;
    let nextStart = axisEndMin;
    for (const r of track.runs) {
      if (r.endMin <= cursorMin && r.endMin > prevEnd) prevEnd = r.endMin;
      if (r.startMin >= cursorMin && r.startMin < nextStart) nextStart = r.startMin;
    }
    setHover({
      date: track.date,
      pct,
      tipLeft: Math.max(8, Math.min(92, pct)),
      untracked: true,
      label: 'Untracked',
      startMin: prevEnd,
      endMin: nextStart,
      durSec: Math.max(0, Math.round((nextStart - prevEnd) * 60)),
      apps: [],
    });
  };

  return (
    <div className="space-y-5">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3">
        {Object.keys(CATEGORY_LABEL).map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span className="w-3 h-3 rounded-sm" style={{ background: CATEGORY_COLOR[c] }} />
            {CATEGORY_LABEL[c]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span className="w-3 h-3 rounded-sm border border-gray-300 dark:border-gray-600" style={UNTRACKED_BG} /> Untracked
        </span>
        <span className="ml-auto text-[11px] text-gray-400 dark:text-gray-500">Hover a bar for detail</span>
      </div>

      {shown.map((track) => {
        const h = hover && hover.date === track.date ? hover : null;
        return (
          <div key={track.date}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {new Date(`${track.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              {/* True active window of THIS day (the bars sit on the shared axis) */}
              <span className="text-[10px] font-mono text-gray-400">{fmtMin(track.firstStartMin)} – {fmtMin(track.lastEndMin)}</span>
            </div>

            <div
              className="relative cursor-crosshair"
              onMouseMove={(e) => handleMove(e, track)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Floating tooltip for the hovered block / gap */}
              {h && (
                <div
                  className="absolute z-20 -translate-x-1/2 pointer-events-none"
                  style={{ left: `${h.tipLeft}%`, bottom: 'calc(100% + 12px)' }}
                >
                  <div className="rounded-lg px-3 py-2 shadow-xl" style={{ background: '#1A2230', minWidth: 140 }}>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={
                          h.untracked
                            ? { ...UNTRACKED_BG, boxShadow: 'inset 0 0 0 1px rgba(220,225,233,0.5)' }
                            : { background: h.color }
                        }
                      />
                      <span className="text-xs font-semibold text-white whitespace-nowrap">{h.label}</span>
                    </div>
                    <div className="text-[11px] font-mono text-gray-300">{fmtMin(h.startMin)} – {fmtMin(h.endMin)}</div>
                    <div className="text-[11px] font-mono text-gray-400 mt-0.5">
                      {h.untracked ? `${formatDuration(h.durSec)} · no data` : formatDuration(h.durSec)}
                    </div>
                    {!h.untracked && h.apps.length > 0 && (
                      <div className="text-[11px] text-gray-400 mt-1 max-w-[220px] truncate">
                        {h.apps.slice(0, 6).join(', ')}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Activity bar (shared axis) */}
              <div
                className="relative h-[52px] rounded-[9px] overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
                style={UNTRACKED_BG}
              >
                {track.runs.map((run) => (
                  <div
                    key={run.key}
                    className="absolute top-0 h-full transition-all duration-500 ease-out"
                    style={{
                      left: `${pctOf(run.startMin)}%`,
                      width: `${Math.max(0.3, pctOf(run.endMin) - pctOf(run.startMin))}%`,
                      background: CATEGORY_COLOR[run.category],
                    }}
                  />
                ))}
                {/* Scrubber line */}
                {h && (
                  <div
                    className="absolute top-0 h-full w-0.5 -translate-x-1/2 pointer-events-none rounded bg-gray-700/50 dark:bg-gray-200/70"
                    style={{ left: `${h.pct}%` }}
                  />
                )}
              </div>

              {/* Always-on time axis — identical on every track (shared window) */}
              <div className="relative h-7 mt-2">
                {ticks.map((tk, i) => (
                  <div
                    key={i}
                    className="absolute top-0 flex flex-col gap-1.5"
                    style={{ left: `${tk.left}%`, transform: `translateX(${tk.tx})`, alignItems: tk.align }}
                  >
                    <div className="w-px h-1.5 bg-gray-300 dark:bg-gray-600" />
                    <span className="font-mono text-[11px] text-gray-400 whitespace-nowrap">{tk.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {hidden > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          +{hidden} more day(s) — narrow the date range to see them.
        </p>
      )}
    </div>
  );
}

export default DayTimeline;
