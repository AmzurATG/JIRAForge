# Daily Timesheet Timeline — Multi-Issue Segmentation Plan

## 1. Objective

Make the Daily Timesheet timeline (Day View) render a distinct visual segment for every Jira issue a user worked on during the day, instead of collapsing all consecutive "assigned" activity into a single bar labelled with only the first issue encountered.

After this change, when a user works on FEEDBACK-73, then FEEDBACK-74, then FEEDBACK-73 again in the same morning, the timeline shows three separate green segments — one per stretch per issue — each with its own correct hover tooltip.

---

## 2. Current Problem

### 2.1 Symptom (as reported)

Screenshot: `iswarya.kolimalla` worked on multiple issues on 2026-04-24 — FEEDBACK-73 (18s) and FEEDBACK-74 (1h 28m 46s, across two sessions) were both clearly tracked that day. The My Focus view shows both. However, the Daily Timesheet timeline for that user rendered **one continuous green bar**, and the hover strip always read `FEEDBACK-73 · 10:51 AM – 12:51 PM (107m)` regardless of which part of the bar the mouse was over.

### 2.2 Root Cause

`DayView.getUserTimeBlocks` in
[`forge-app/static/main/src/components/tabs/time-analytics/DayView.js`](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js)
coalesces adjacent raw session records into larger visible segments so that individual 5-minute activity chunks are not reduced to invisible pixel slivers on a multi-hour timeline.

The pre-fix merge condition was:

```js
if (prev && prev.hasIssue === block.hasIssue && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
  // merge
}
```

This merged any two assigned sessions within 10 minutes of each other — regardless of which issue each belonged to. The merged block kept the **first** session's `issueKey` and accumulated duration from all subsequent merged sessions, so switching issues was erased from the UI.

---

## 3. Solution Overview

Require `prev.issueKey === block.issueKey` as an additional merge precondition. Adjacent sessions on the same issue still merge (the visibility-smoothing rationale still holds per-issue); adjacent sessions on different issues stay as separate blocks. Unassigned sessions (both `issueKey === null`) continue to merge with each other, which is required so the dotted "unassigned work" bars render as continuous strokes.

Out of scope:
- Changing the 10-minute `GAP_THRESHOLD_MS`
- Visual styling of thin issue-switch segments (they currently render as distinct rounded rectangles side by side because `.timeline-block` uses `border-radius: 2px`)
- Backend timeline payload shape — resolver output is unchanged
- Idle / unassigned block merging logic (separate functions, untouched)

---

## 4. Implementation

### 4.1 Code change

File: [`forge-app/static/main/src/components/tabs/time-analytics/DayView.js`](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js) — `getUserTimeBlocks`, lines 330-345.

Before:

```js
const merged = [];
for (const block of rawBlocks) {
  const prev = merged[merged.length - 1];
  if (prev && prev.hasIssue === block.hasIssue && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
    // Extend previous block (same assigned/unassigned type)
    prev.endTime = new Date(Math.max(prev.endTime.getTime(), block.endTime.getTime()));
    prev.durationSeconds += block.durationSeconds;
  } else {
    merged.push({ ...block });
  }
}
```

After:

```js
const merged = [];
for (const block of rawBlocks) {
  const prev = merged[merged.length - 1];
  const sameIssue = prev && prev.hasIssue === block.hasIssue && prev.issueKey === block.issueKey;
  if (sameIssue && (block.startTime - prev.endTime) <= GAP_THRESHOLD_MS) {
    prev.endTime = new Date(Math.max(prev.endTime.getTime(), block.endTime.getTime()));
    prev.durationSeconds += block.durationSeconds;
  } else {
    merged.push({ ...block });
  }
}
```

Comment above the loop was updated to reflect the new invariant:
> Only merge blocks with the same issueKey (so switching issues produces distinct segments).

### 4.2 No downstream changes needed

Verified that `getUserTimeBlocks` has exactly one consumer: the render `.map()` at [`DayView.js:980`](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js#L980). The consumer:
- Uses each block's own `block.left` / `block.width` for positioning
- Uses `block.issueKey` via `getBlockTooltip(block)` for the hover strip
- Keys each block by array index — key uniqueness is preserved when the array is longer

Return shape of `getUserTimeBlocks` is unchanged (`{ left, width, startTime, endTime, durationSeconds, hasIssue, issueKey }`).

Idle block merging (`getIdleTimeBlocks`) and unassigned block merging (`getUnassignedBlocks`) are separate functions and were not touched — they already don't carry an issueKey distinction.

---

## 5. Testing

### 5.1 New unit tests

File: [`forge-app/static/main/src/components/tabs/time-analytics/__tests__/timelineBlockMerge.test.js`](../forge-app/static/main/src/components/tabs/time-analytics/__tests__/timelineBlockMerge.test.js)

Replicates the merge logic verbatim from DayView (same pattern used by the existing `timeConsistency.test.js`) and covers:

1. **Bug scenario** — three sessions (FEEDBACK-73 → FEEDBACK-74 → FEEDBACK-73) produce three blocks with correct per-block durations.
2. **Same-issue coalescing** — two adjacent 5-minute chunks on one issue still merge into one 10-minute block.
3. **Gap threshold** — same-issue sessions separated by > 10 min do not merge.
4. **Assigned vs unassigned** — an assigned session adjacent to an unassigned session never merges.
5. **Rapid issue switching** — 5 alternating A/B/A/B/A sessions produce 5 distinct blocks.
6. **Input ordering** — unsorted input still produces the correct chronological output (the internal sort still runs).
7. **Edge cases** — empty list, unparseable `endTime`, two null-issueKey unassigned sessions (must still merge because `null === null`).

### 5.2 Regression-proof check

To confirm the tests meaningfully cover the bug, the merge condition in the test file was temporarily reverted to the buggy form (`hasIssue` only). Result: **4 of 11 tests failed** — exactly the ones that depend on the new behaviour (bug scenario, rapid switching, out-of-order input). The fixed condition was then restored and the suite passed 11 / 11.

### 5.3 Full-suite result

`npx jest` from `forge-app/` — **231 / 232 passed**. The single failure is in
[`forge-app/tests/resolvers/approvalResolvers.test.js:107`](../forge-app/tests/resolvers/approvalResolvers.test.js#L107)
(`TypeError: Cannot read properties of undefined (reading 'method')`). Verified pre-existing on `main` by stashing the fix and re-running — failure reproduces identically with no changes. Unrelated to this work.

### 5.4 Build

`cd forge-app/static/main && npx react-scripts build` — compiled successfully. Bundle size +10 bytes. Only warning is a pre-existing unused-var in `DashboardTab.js`.

### 5.5 Manual verification (not executed here)

Requires running `forge tunnel` against a live Jira instance, which is outside the scope of this plan's automated verification. Steps for the reviewer:

1. `cd forge-app && forge tunnel`
2. Open Time Tracker tab as a user who worked on ≥ 2 different issues today
3. Confirm the user's row shows multiple distinct green segments in the timeline
4. Hover each segment — the tooltip's issue key should match the session that produced it
5. Confirm "Total" and "Unassigned" numbers in the right-hand column are unchanged from before the fix

---

## 6. Files Changed

| File | Change |
|---|---|
| `forge-app/static/main/src/components/tabs/time-analytics/DayView.js` | Merge condition now requires matching `issueKey` (3-line diff) |
| `forge-app/static/main/src/components/tabs/time-analytics/__tests__/timelineBlockMerge.test.js` | New — 11 unit tests |
| `plan/TIMELINE_MULTI_ISSUE_SEGMENTATION_PLAN.md` | New — this document |

---

## 7. Known Limitations / Follow-ups

- **Adjacent same-colour segments may look visually continuous at small widths.** `border-radius: 2px` on each block creates a subtle joint, but two green segments side-by-side can still look like one bar at a glance. If users report this, consider either (a) a 1-2 px gap between adjacent different-issue segments, or (b) alternating subtle shades per adjacent issue. Not implemented in this phase.
- **No backend resolver change.** If a future change re-introduces block merging at the resolver layer (e.g. for payload size reduction), the same `issueKey`-aware rule must be preserved there.
- **Out-of-scope: Week/Month views.** This plan only touches the Day View timeline. Aggregated views don't render per-session blocks, so the bug did not manifest there.
