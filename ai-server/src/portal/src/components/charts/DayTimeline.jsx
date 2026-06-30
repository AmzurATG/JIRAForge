/**
 * DayTimeline — a user's day as a single continuous, merged activity bar.
 *
 * Each day in `records` renders as one horizontal track trimmed to its active
 * window (first → last activity). Consecutive same-category time is coalesced
 * into a single block (sub-threshold gaps bridged), so the bar reads as a few
 * colored runs (productive / non-productive / unknown / idle) rather than a
 * fence of per-capture tiles; real untracked gaps show as the empty striped
 * track. Blocks are keyed by run identity and ease via CSS transition, so a
 * silent background refresh just extends the bar — no remount, blink, or spinner.
 *
 * Visual language follows the "Spectrum" timeline design
 * (claude.ai/design · Timeline Palettes): an always-on time axis under each
 * bar, plus a floating hover tooltip + scrubber line that reports the precise
 * range/duration of the block (or untracked gap) under the cursor.
 *
 * Spec: plan/2026-06-26_web-productivity-portal_employee-day-timeline.md
 */

import { useState } from 'react';
import { toCategory } from '../common/CategoryBadge';
import { formatDuration } from '../../utils/formatters';

// "Spectrum" palette (claude.ai/design · Timeline Palettes — the chosen scheme).
// The categories separate on two axes at once (hue + lightness), so productive
// (green) and non-productive (vermillion) stay distinguishable even with
// red-green color blindness. NOTE: the other portal charts still use the older
// green/red/slate palette — this is intentionally scoped to the timeline.
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

const localDateKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Pure: activity records → per-day tracks of merged runs.
 * Returns [{ date, windowStart, windowEnd, runs: [{ key, category, start, end,
 * leftPct, widthPct, durationSec, apps }] }], newest day first. Exported for tests.
 */
export function buildDayTracks(records) {
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
      };
    })
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const byDay = new Map();
  for (const r of valid) {
    const key = localDateKey(r.start);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }

  const tracks = [];
  for (const [date, recs] of byDay) {
    const windowStart = recs[0].start;
    const windowEnd = recs.reduce((mx, r) => Math.max(mx, r.end), recs[0].end);
    const span = Math.max(1, windowEnd - windowStart);

    // Coalesce consecutive same-category records (bridging tiny gaps).
    const merged = [];
    let cur = null;
    for (const r of recs) {
      if (cur && r.category === cur.category && r.start - cur.end <= MERGE_BRIDGE_MS) {
        cur.end = Math.max(cur.end, r.end);
        if (r.app) cur.apps.add(r.app);
      } else {
        if (cur) merged.push(cur);
        cur = { category: r.category, start: r.start, end: r.end, apps: new Set(r.app ? [r.app] : []) };
      }
    }
    if (cur) merged.push(cur);

    tracks.push({
      date,
      windowStart,
      windowEnd,
      runs: merged.map((run) => ({
        key: `${date}-${run.start}-${run.category}`,
        category: run.category,
        start: run.start,
        end: run.end,
        leftPct: ((run.start - windowStart) / span) * 100,
        widthPct: Math.max(0.3, ((run.end - run.start) / span) * 100),
        durationSec: Math.round((run.end - run.start) / 1000),
        apps: [...run.apps],
      })),
    });
  }

  return tracks.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest day first
}

// Subtle diagonal stripe for untracked track background (inline to avoid Tailwind
// arbitrary-value parsing of the gradient). Translucent so it reads on both the
// light and dark track base.
const UNTRACKED_BG = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent 0 6px, rgba(148,163,184,0.16) 6px 12px)',
};

// Five evenly-spaced clock ticks across a track's active window. First label is
// left-aligned, last right-aligned, the rest centered on their mark — so end
// labels never overflow the bar edges (mirrors the design's axis treatment).
function buildTicks(windowStart, windowEnd) {
  const span = Math.max(1, windowEnd - windowStart);
  const N = 4; // 5 ticks (0 … N)
  return Array.from({ length: N + 1 }, (_, i) => {
    const frac = i / N;
    const first = i === 0;
    const last = i === N;
    return {
      left: frac * 100,
      tx: first ? '0' : last ? '-100%' : '-50%',
      align: first ? 'flex-start' : last ? 'flex-end' : 'center',
      label: hhmm(windowStart + frac * span),
    };
  });
}

function DayTimeline({ records, loading }) {
  const [hover, setHover] = useState(null);

  if (loading) {
    return <div className="h-24 flex items-center justify-center text-gray-400 text-sm">Loading timeline…</div>;
  }

  const tracks = buildDayTracks(records);
  if (tracks.length === 0) {
    return (
      <div className="h-24 flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
        No activity tracked for the selected period.
      </div>
    );
  }

  const shown = tracks.slice(0, MAX_DAYS);
  const hidden = tracks.length - shown.length;

  // Map the cursor to the block (or untracked gap) under it on a given track.
  const handleMove = (e, track) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const pct = f * 100;
    const span = Math.max(1, track.windowEnd - track.windowStart);
    const t = track.windowStart + f * span;

    const run = track.runs.find((r) => t >= r.start && t < r.end);
    if (run) {
      setHover({
        date: track.date,
        pct,
        tipLeft: Math.max(8, Math.min(92, pct)),
        untracked: false,
        label: CATEGORY_LABEL[run.category],
        color: CATEGORY_COLOR[run.category],
        start: run.start,
        end: run.end,
        durSec: run.durationSec,
        apps: run.apps,
      });
      return;
    }

    // Cursor is in real untracked space — report the gap's bounds.
    let prevEnd = track.windowStart;
    let nextStart = track.windowEnd;
    for (const r of track.runs) {
      if (r.end <= t && r.end > prevEnd) prevEnd = r.end;
      if (r.start >= t && r.start < nextStart) nextStart = r.start;
    }
    setHover({
      date: track.date,
      pct,
      tipLeft: Math.max(8, Math.min(92, pct)),
      untracked: true,
      label: 'Untracked',
      start: prevEnd,
      end: nextStart,
      durSec: Math.max(0, Math.round((nextStart - prevEnd) / 1000)),
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
        const ticks = buildTicks(track.windowStart, track.windowEnd);
        return (
          <div key={track.date}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {new Date(track.windowStart).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <span className="text-[10px] font-mono text-gray-400">{hhmm(track.windowStart)} – {hhmm(track.windowEnd)}</span>
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
                    <div className="text-[11px] font-mono text-gray-300">{hhmm(h.start)} – {hhmm(h.end)}</div>
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

              {/* Activity bar */}
              <div
                className="relative h-[52px] rounded-[9px] overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
                style={UNTRACKED_BG}
              >
                {track.runs.map((run) => (
                  <div
                    key={run.key}
                    className="absolute top-0 h-full transition-all duration-500 ease-out"
                    style={{ left: `${run.leftPct}%`, width: `${run.widthPct}%`, background: CATEGORY_COLOR[run.category] }}
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

              {/* Always-on time axis */}
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
