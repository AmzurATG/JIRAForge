# Multi-Select Bulk Assign Plan

**Status:** Draft — awaiting approval before implementation
**Date:** 2026-04-20
**Owner:** Vishnu (with Claude)
**Tracker row:** *Bulk unassigned issues conversion — Allow users to select all or multiple unassigned work logs to assign them to a single ticket. (4/20/2026 → 4/21/2026, In Progress)*

**Goal:** Let users select **multiple unassigned groups** and/or **individual intervals across groups** via checkboxes, then assign the combined selection to a single Jira issue (existing or new) in one action. Reuses the existing assignment modal and backend assignment primitives — only the selection layer + a thin orchestration resolver are new.

> **Note:** This is **not** the time-window bulk reassign feature. That separate effort is documented in [bulk-reassign-revival-plan.md](./bulk-reassign-revival-plan.md) and is currently **hidden** in the UI pending Phase 2 work.

---

## 1. Background

### 1.1 Today's flow (single-group only)
The Unassigned Work page renders an accordion of AI-generated groups. Each group has an **Assign** button that opens [AssignmentModal](../forge-app/static/main/src/components/unassigned/AssignmentModal.js) prefilled with that group's `session_ids`. The user picks an existing issue or creates a new one; the resolver PATCHes those activity records to point at the chosen Jira key.

### 1.2 What's missing
There's no way to:
- Select **multiple groups** and assign them all to one issue.
- Select **a subset of intervals within a group** (or across groups) and assign that subset.

Today, users have to repeat the assign flow per group. For a week's worth of unassigned work this is tedious.

### 1.3 What already supports this on the backend
- [assignToExistingIssue](../forge-app/src/resolvers/unassigned/assignmentResolvers.js) takes `sessionIds: string[]` and a `groupId`. The PATCH path doesn't care whether those IDs come from one group or many.
- [createIssueAndAssign](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L328) is structurally identical, plus it creates the issue first.
- [GroupAccordion](../forge-app/static/main/src/components/unassigned/GroupAccordion.js) already lazy-loads `session_ids` per group via `getGroupDetails`, and each rendered interval row carries `session.activityIds: string[]`.

So the only group-aware step that needs new logic is "mark the group as assigned at the end" when only **part** of a group was assigned.

---

## 2. Scope Decision

**Approved scope (v1):**
- Multi-group selection (whole groups).
- Partial-group selection (individual intervals).
- Cross-group selection in one action.
- "Assign Selected" routes to **existing issue** target.
- Per-group **Assign** button is preserved (single-group flow stays as muscle memory).

**Deferred (v2):**
- "Create new issue" target from a multi-group selection. Existing issue is the common case; create-new can come right after.
- Inheriting AI recommendations into the modal when multi-selecting (no single recommendation to surface).
- Keyboard shortcuts (shift-click range select, ⌘A select-all-visible).

**Not in scope:**
- Time-window-based bulk reassign — covered by a separate plan, currently hidden.
- Cross-page selection persistence (selection clears on data reload).

---

## 3. Data Model Mapping

| UI unit | Underlying data | Source |
|---|---|---|
| Group | `unassigned_work_groups` row → on expand, `getGroupDetails` returns `session_ids: string[]` (UUIDs of `activity_records`) | [GroupAccordion.js:128](../forge-app/static/main/src/components/unassigned/GroupAccordion.js#L128) |
| Interval (session row inside expanded group) | `session.activityIds: string[]` | [GroupAccordion.js:86](../forge-app/static/main/src/components/unassigned/GroupAccordion.js#L86) |

**Selection → payload conversion:**
- Group fully checked → push entire `details.session_ids` and the `groupId`.
- Group partially checked → push the `flat()` of `activityIds` from its checked intervals + the `groupId` (still included so the resolver can compute partial-coverage).
- Dedupe `sessionIds` array before sending.

---

## 4. UX Design

### 4.1 Checkbox affordances
- **Group-level checkbox:** top-left of every accordion header, before the toggle arrow. Tri-state:
  - ☐ none of its intervals selected
  - ⊟ some intervals selected (indeterminate)
  - ☑ all intervals selected
- **Interval-level checkbox:** left of each interval's time label, inside the expanded view.

**Visibility:** **always rendered, low-emphasis until interaction.** Idle = subtle border + reduced opacity (~0.4). On row hover OR when *any* item in the page is selected → full opacity. Selected boxes themselves are always full opacity. This balances discoverability (Notion / Linear pattern) against visual noise on long lists.

Click semantics:
- Toggling a group checkbox selects/deselects all its intervals.
- Toggling intervals updates the parent group state automatically.
- Clicking a checkbox does **not** expand/collapse the accordion — `e.stopPropagation()` on the checkbox handler.

### 4.2 Selection bar (floating bottom action bar)
Slides up from the viewport bottom on first selection.
```
┌─────────────────────────────────────────────────────────────────┐
│  3 groups · 7 intervals · 2h 15m selected                       │
│                              [ Clear ]  [ Assign Selected → ]   │
└─────────────────────────────────────────────────────────────────┘
```
- Stays pinned during scroll, expand/collapse, and pagination "Load More".
- "Clear" deselects everything.
- "Assign Selected" opens `AssignmentModal` with the combined payload.
- Bar disappears when the selection is empty.

**Why floating bottom bar (not top toolbar):** common selection-pattern (Gmail, Asana, Linear); zero clutter when nothing's selected; scales with selection text width.

### 4.3 What stays
- Per-group **Assign** button on the accordion header → unchanged.
- Per-group **Delete** button → unchanged.
- Per-interval **dismiss (×)** → unchanged.
- Lazy-load on accordion expand → unchanged.

---

## 5. Frontend Implementation

### 5.1 New component — `SelectionBar.js`
**Path:** [forge-app/static/main/src/components/unassigned/SelectionBar.js](../forge-app/static/main/src/components/unassigned/SelectionBar.js) *(new)*

Pure presentational component. Props: `{ groupCount, intervalCount, totalSeconds, onClear, onAssign }`. CSS in a sibling `SelectionBar.css`. Renders nothing if `groupCount === 0 && intervalCount === 0`.

### 5.2 Selection state — owned by `UnassignedWork.js`
**Path:** [forge-app/static/main/src/components/UnassignedWork.js](../forge-app/static/main/src/components/UnassignedWork.js)

Add:
```js
// Map<groupId, Set<intervalKey>> — intervalKey = activityIds.join('|')
const [selectedIntervalsByGroup, setSelectedIntervalsByGroup] = useState(new Map());
// Set<groupId> — groups checked at the header level (full-group select)
const [fullySelectedGroups, setFullySelectedGroups] = useState(new Set());
```
Why two pieces of state: full-group selection should *not* require expanding the group / loading intervals. We track full-selection by groupId; partial-selection by interval keys. The two compose into the final payload.

Selection handlers:
- `toggleGroupSelection(group)` — if any state for group exists, clear it; otherwise mark full.
- `toggleIntervalSelection(groupId, intervalKey, activityIds)` — adds/removes from `selectedIntervalsByGroup`. If, after toggle, the group's checked-interval count equals its session count, promote to "fully selected" (remove from interval map, add to fullySelectedGroups).
- `clearSelection()` — empties both.

Selection summary derived state:
```js
const selectionSummary = useMemo(() => {
  // For each fully-selected group: use group.total_seconds + session_count
  // For each partial group: sum durations from loaded interval data
  // Aggregate counts + total seconds
}, [fullySelectedGroups, selectedIntervalsByGroup, groups, groupDetailsCache]);
```

### 5.3 GroupAccordion — checkbox wiring
**Path:** [forge-app/static/main/src/components/unassigned/GroupAccordion.js](../forge-app/static/main/src/components/unassigned/GroupAccordion.js)

New props passed down from `UnassignedWork`:
```js
selectedIntervalsByGroup, fullySelectedGroups,
onToggleGroupSelection, onToggleIntervalSelection
```
Render:
- One `<input type="checkbox" />` in the accordion header (use `ref` to set `indeterminate`).
- One `<input type="checkbox" />` per interval row inside the expanded view.
- Compute group-checkbox state from props (none / partial / all).

Checkbox `onClick` calls `e.stopPropagation()` to keep accordion behaviour intact.

### 5.4 AssignmentModal — payload reshape
**Path:** [forge-app/static/main/src/components/unassigned/AssignmentModal.js](../forge-app/static/main/src/components/unassigned/AssignmentModal.js)

Add a new prop `selectionPayload` *or* generalise `selectedGroup` into a shape that handles both single and multi:
```js
// When called from per-group Assign button:
{ sessionIds, groupIds: [groupId], totalSeconds, sessionCount,
  recommendation, label, description }   // last 3 enable AI prefill

// When called from "Assign Selected":
{ sessionIds, groupIds, totalSeconds, sessionCount,
  recommendation: null, label: null, description: null }   // no prefill
```

Form UI doesn't change. The existing AI-prefill `useEffect` (lines 49–58) becomes a no-op when `recommendation` is null. The `assigning` action calls the new resolver (5.5 below) with `groupIds` instead of a single `groupId`.

### 5.5 Lazy-load handling for collapsed-group full-select
When the user checks a group header for a group whose `session_ids` aren't yet loaded:
1. Show a tiny spinner inside the checkbox.
2. Fire `getGroupDetails` (already implemented in `GroupAccordion`'s expand flow — extract into a callback exposed by the parent).
3. On success, mark the group fully-selected and update selection state.
4. On failure, show a one-line error toast and leave the checkbox unchecked.

This is the only mildly tricky piece of UI plumbing. Implementation: hoist the `groupDetails` cache from `GroupAccordion` up to `UnassignedWork.js` so both the accordion and the selection logic share it.

---

## 6. Backend Implementation

### 6.1 New resolver — `assignSelectionToExistingIssue`
**Path:** [forge-app/src/resolvers/unassigned/assignmentResolvers.js](../forge-app/src/resolvers/unassigned/assignmentResolvers.js)

Signature:
```js
{
  sessionIds: string[],          // combined, deduped activity_record UUIDs
  groupIds: string[],            // every group touched (for partial-mark logic)
  targetIssueKey: string,
  totalSeconds: number,
  createWorklog: boolean
}
```
Body:
1. Validate inputs (reuse `sanitizeUUIDArray`, `isValidIssueKey`, etc).
2. Initialize request context (org/user/cloud).
3. Validate target issue is accessible (reuse the same access-check pattern that single-issue assign already runs).
4. PATCH `activity_records` in one call:
   ```
   PATCH /activity_records?id=in.(...)&user_id=eq.${userId}&organization_id=eq.${orgId}
   { user_assigned_issue_key: targetIssueKey, ... }
   ```
   Reuse the helper that single-group assign uses.
5. Optional Jira worklog — one call for the combined `totalSeconds`. Reuse `createWorklogIfNeeded`.
6. **Partial-group marking:**
   - For each `groupId`:
     - Fetch the group's full `session_ids` set from DB (single `SELECT session_ids FROM unassigned_work_groups WHERE id = ?`).
     - If every member is in `sessionIds`, call existing `markGroupAsAssigned`.
     - Else: do nothing (group survives with remaining intervals — same as today's per-interval dismiss flow).
7. Return:
   ```js
   { success, attributed_count, fully_assigned_groups: [...], partial_groups: [...], worklog_id, ... }
   ```

Register in [forge-app/src/index.js](../forge-app/src/index.js).

### 6.2 v2 resolver — `createIssueAndAssignSelection` *(deferred)*
Mirror of `createIssueAndAssign` but with multi-group orchestration. Same structure as 6.1 plus the issue-create step at the front. Build only when v1 is shipped and stable.

### 6.3 No new tables, no new columns
Reuses existing schema completely. The `conversion_reason` / `converted_at` columns from migration `20260417_add_unassigned_conversion_columns.sql` could be filled if desired but aren't required for v1.

---

## 7. Implementation Steps (ordered)

1. **Hoist `groupDetails` cache** from `GroupAccordion` to `UnassignedWork.js`. Pass cache + setter as props. No behaviour change. Verify per-group Assign and accordion expand still work.
2. **Selection state in `UnassignedWork.js`.** Add `fullySelectedGroups` + `selectedIntervalsByGroup` + handlers + derived `selectionSummary`. No UI yet.
3. **Checkbox UI in `GroupAccordion.js`.** Group header + per-interval. Tri-state via ref. `e.stopPropagation()` on every checkbox handler. Verify the row click → expand still works.
4. **`SelectionBar.js` component** + CSS. Mount in `UnassignedWork.js`. "Clear" wired; "Assign Selected" opens the modal with the multi-group payload.
5. **`AssignmentModal.js` payload reshape.** Accept either single-group or multi-group payload. AI prefill skipped when no single recommendation. Wire submit to new resolver.
6. **Backend resolver `assignSelectionToExistingIssue`** + register in `index.js`.
7. **Lazy-fetch on collapsed full-select.** Spinner inside checkbox; on resolve, populate cache + mark group selected.
8. **Reload + clear-selection on assign success.** `loadUnassignedWork()` + `clearSelection()`.
9. **QA pass** (see §8).
10. **Forge deploy** to dev → production.

Each step is reviewable on its own; steps 1–4 are pure UI and can be merged before the resolver lands (the modal won't submit yet, but selection mechanics can be validated).

---

## 8. Testing Plan

### 8.1 Unit / integration
- Selection state transitions:
  - Toggle group → all its intervals marked.
  - Toggle one interval → group becomes indeterminate.
  - Toggle all intervals manually → group becomes fully-checked, state migrates from interval map to `fullySelectedGroups`.
  - Clear → both states empty.
- `assignSelectionToExistingIssue`:
  - Multi-group full → all groups marked assigned.
  - Multi-group partial → no group marked, all activity_records PATCHed.
  - Mixed full + partial → only full groups marked.
  - Empty `sessionIds` → rejected.
  - Inaccessible target issue → rejected before PATCH.
  - Multi-tenant safety: PATCH includes `user_id=eq` and `organization_id=eq`.

### 8.2 Manual QA
1. Select 1 whole group via header checkbox → assign → group disappears, worklog created with full time.
2. Select 3 whole groups across pages → assign → all three disappear, single worklog created with summed time.
3. Select 2 intervals from Group A and 1 interval from Group B → assign → both groups remain (smaller), worklog has summed time of 3 intervals only.
4. Select all intervals in Group A manually → header checkbox shows ☑ → assign → group disappears.
5. Check a collapsed group's header checkbox without expanding → spinner inside checkbox → resolves → selection bar count updates.
6. Per-group **Assign** button still works for single-group flow (no regressions).
7. Selection bar persists during "Load More" pagination.
8. Selection clears after successful assign.
9. Modal cancel → selection preserved.
10. Lazy-fetch failure → graceful inline message; checkbox stays unchecked.

### 8.3 Regression
- Per-interval dismiss (×) still works.
- Per-group delete still works.
- AI recommendation prefill still works in single-group Assign.
- Page summary numbers (groups / sessions / total time) unaffected by selection state.

---

## 9. Tricky Bits / Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Selection bar covers content at the bottom | Med | Low | Add bottom padding to the container equal to bar height when bar is visible |
| Stale selection after data reload | Med | Med | Always clear selection on `loadUnassignedWork()` success |
| User selects across pages, then refreshes mid-flow | Low | Low | Selection state is in-memory only; refresh clears it. Document this. |
| Lazy-loading slowness — checking 5 collapsed groups fires 5 sequential `getGroupDetails` calls | Med | Med | Fire in parallel via `Promise.all` when batch action is initiated |
| Partial-group marking logic mishandles deduped sessionIds | Med | High | Unit-test the "is this group fully covered" check carefully |
| Worklog amount > sum of pro-rated time from earlier hidden feature confuses users | Low | Low | This feature uses *whole* activity_records' `total_time_seconds` — no pro-rating involved. Document clearly |
| Tri-state checkbox `indeterminate` only settable via DOM ref, not React props | Cert | Low | Use `useRef` + `useEffect` to set `el.indeterminate = ...` on each render |

---

## 10. Out of Scope / Deferred

- "Create new issue" from selection (v2 — `createIssueAndAssignSelection`).
- Keyboard shortcuts (shift-click range, ⌘A).
- "Select all visible" header action.
- Persisting selection across page reloads.
- Time-window bulk reassign (covered separately, hidden today).
- Sprint-add and status-set on selection assign (could come later — same hooks as the other plan).

---

## 11. Open Decisions

| # | Question | Default if unresolved |
|---|---|---|
| D1 | Keep per-group **Assign** button alongside selection bar? | **Yes** — preserves muscle memory; selection bar is purely additive |
| D2 | Show selection bar at top or bottom of viewport? | **Bottom** (Gmail/Asana convention) |
| D3 | Allow "Assign Selected" → Create New Issue in v1? | **No** — defer to v2 to keep v1 small |
| D4 | Auto-select all intervals in a group on first select, or require explicit interval ticks? | **Auto-select all** (one click selects whole group; intervals are an opt-out) |
| D5 | When multi-selecting groups with conflicting AI recommendations, show any of them? | **No** — skip AI prefill entirely for multi-group |
| D6 | Behaviour when a partially-assigned group becomes empty (every interval moved out one-by-one)? | Already handled today by dismiss flow — group becomes empty and is hidden |
| D7 | Cap on selection size? | **No cap in v1**; if PATCH performance degrades, add a soft warning at 200+ records |

---

## 12. Rollout

1. Deploy to Forge dev.
2. Manually exercise §8.2 cases.
3. Deploy to production.
4. Monitor `forge-app` logs for `[assignSelectionToExistingIssue]` errors for one week.
5. Announce in release notes; mention the per-group Assign button still works for single-group flow.

---

## 13. Files Touched (estimate)

**New:**
- `forge-app/static/main/src/components/unassigned/SelectionBar.js`
- `forge-app/static/main/src/components/unassigned/SelectionBar.css`

**Modified:**
- `forge-app/static/main/src/components/UnassignedWork.js` — selection state, derived summary, mount selection bar, hoist groupDetails cache.
- `forge-app/static/main/src/components/unassigned/GroupAccordion.js` — checkbox wiring, accept hoisted cache as props.
- `forge-app/static/main/src/components/unassigned/GroupAccordion.css` — checkbox styles, indeterminate visual.
- `forge-app/static/main/src/components/unassigned/AssignmentModal.js` — payload reshape, conditional AI prefill, route to new resolver for multi-group.
- `forge-app/static/main/src/components/unassigned/index.js` — export `SelectionBar`.
- `forge-app/src/resolvers/unassigned/assignmentResolvers.js` — new `assignSelectionToExistingIssue`.
- `forge-app/src/index.js` — register the new resolver.

**Untouched intentionally:**
- Bulk reassign feature files (still hidden).
- Schema / migrations.
- Other tabs (analytics, day view).
