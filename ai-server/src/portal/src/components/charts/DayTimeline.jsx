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
 * Spec: plan/2026-06-26_web-productivity-portal_employee-day-timeline.md
 */

import { toCategory } from '../common/CategoryBadge';
import { formatDuration } from '../../utils/formatters';

// Match the chart/KPI palette (DailyLineChart).
const CATEGORY_COLOR = {
  productive: '#10b981',
  'non-productive': '#ef4444',
  neutral: '#64748b',
  idle: '#9ca3af',
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
// arbitrary-value parsing of the gradient).
const UNTRACKED_BG = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(100,116,139,0.10) 6px, rgba(100,116,139,0.10) 12px)',
};

function DayTimeline({ records, loading }) {
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

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {Object.keys(CATEGORY_LABEL).map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <span className="w-3 h-3 rounded-sm" style={{ background: CATEGORY_COLOR[c] }} />
            {CATEGORY_LABEL[c]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span className="w-3 h-3 rounded-sm border border-gray-300 dark:border-gray-600" style={UNTRACKED_BG} /> Untracked
        </span>
      </div>

      {shown.map((track) => (
        <div key={track.date}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {new Date(track.windowStart).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
            <span className="text-[10px] text-gray-400">{hhmm(track.windowStart)} – {hhmm(track.windowEnd)}</span>
          </div>
          <div
            className="relative h-8 rounded-md overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
            style={UNTRACKED_BG}
          >
            {track.runs.map((run) => (
              <div
                key={run.key}
                className="absolute top-0 h-full transition-all duration-500 ease-out"
                style={{ left: `${run.leftPct}%`, width: `${run.widthPct}%`, background: CATEGORY_COLOR[run.category] }}
                title={`${CATEGORY_LABEL[run.category]} · ${hhmm(run.start)}–${hhmm(run.end)} · ${formatDuration(run.durationSec)}${run.apps.length ? `\n${run.apps.slice(0, 6).join(', ')}` : ''}`}
              />
            ))}
          </div>
        </div>
      ))}

      {hidden > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          +{hidden} more day(s) — narrow the date range to see them.
        </p>
      )}
    </div>
  );
}

export default DayTimeline;
