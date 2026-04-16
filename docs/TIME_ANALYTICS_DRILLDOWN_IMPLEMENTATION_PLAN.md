# Time Analytics Drill-Down - Implementation Plan

**Date:** April 16, 2026  
**Feature:** Time Analytics Summary Card Drill-Down  
**Priority:** High  
**Estimated Effort:** 1-2 days  
**Status:** ✅ COMPLETED — Deployed as version 6.27.0 (development environment)

---

## 1. Overview

### 1.1 Problem Statement

The current Time Analytics page shows useful high-level totals for:
- Time Spent Today
- Time Spent This Week
- Time Spent This Month

However, the summary cards do not provide a consistent drill-down experience. Users can see totals, but they cannot click those totals to understand:
- Which days contributed to the weekly or monthly total
- Which issues contributed to today's total
- How the displayed card totals relate to the detailed views below

This creates a visibility gap between the summary cards and the underlying time data.

### 1.2 Goals

Enhance the Time Analytics page so that each summary card supports direct drill-down from the displayed time value:

1. **Month card** opens an issue-level breakdown for a clicked calendar day (right-side panel)
2. **Week card** opens an issue-level breakdown for a clicked day (panel below the table)
3. **Today card** opens an issue-level breakdown for the current day (inline below DayView)
4. All drill-downs render **inline on the page** — no popup/modal
5. The drill-down content aligns with existing totals and current page filters/state

> **Implementation note:** The original plan specified a modal-based approach. During implementation, the user requested an inline drill-down instead. The modal approach was discarded entirely.

### 1.3 User Stories

**As a user, I want to:**
- Click the time shown in "Time Spent This Month" and see which issues I worked on for that day directly on the same page (right-side panel)
- Click the time shown in "Time Spent This Week" and see issue-level breakdown for a specific day below the week table
- Click the time shown in "Time Spent Today" and see the issues I worked on today inline below the day timeline
- See the same interaction pattern across all three cards
- Understand how summary totals are composed without leaving the Time Analytics page or opening a modal

---

## 2. Current State Analysis

### 2.1 Main Frontend Flow

The Time Analytics page is orchestrated by:

- `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js`

Current responsibilities:
- Fetches analytics data through `invoke('getTimeAnalytics')`
- Tracks the active detailed view: `day`, `week`, `month`
- Tracks `selectedMonth` for the month view
- Receives `reconciledTodayTotal` from `DayView` so the summary cards can stay aligned with timeline-based today totals

### 2.2 Summary Cards

The summary cards live in:

- `forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js`

Current responsibilities:
- Compute `Today`, `Week`, and `Month` totals from `dailySummary`
- Apply `todayDelta` reconciliation so week/month totals remain consistent with `DayView`
- Allow clicking the card body to switch the active tab view

Current limitation:
- Card values are not separate drill-down triggers
- No modal or drawer is currently shown from Time Analytics summary cards

### 2.3 Available Data Already Returned

The current `getTimeAnalytics` payload already contains the data needed for this feature:

- `dailySummary`
  - used for day-wise aggregation
  - supports week/day and month/day breakdowns
- `timeByIssue`
  - supports issue-level breakdown for today, but it is currently aggregated across the fetched analytics scope and must be filtered or reshaped carefully for "today only"
- `allUsers`
  - currently limited to the current user in Time Analytics
- `canViewAllUsers`
  - intentionally `false` for Time Analytics

Relevant backend source:

- `forge-app/src/services/analytics/userAnalyticsService.js`

### 2.4 Existing UI Patterns to Reuse

Existing modal pattern:

- `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js`

This provides a useful reference for:
- overlay and close behavior
- loading/error/empty states
- scrollable content structure
- breakdown list styling

This feature should reuse the same interaction expectations, but it should avoid coupling Time Analytics to Team Analytics-specific resolver calls.

---

## 3. Scope

### 3.1 In Scope

- Add drill-down interaction from the displayed time value on each summary card
- Provide day-wise drill-down for the selected month
- Provide day-wise drill-down for the selected week
- Provide issue-level drill-down for today
- Keep interaction and visual behavior consistent across all three breakdown modes
- Reuse already fetched data where feasible
- Preserve the existing card click behavior that switches the visible page section

### 3.2 Out of Scope

- Changes to Team Analytics
- Export functionality
- New backend endpoints unless absolutely required by data-shape gaps
- Changes to desktop app behavior
- Redesign of the broader Time Analytics page layout
- Multi-user or admin team-wide drill-down on this page

---

## 4. Implemented UX

> **Note:** The original UX plan proposed a modal. The actual implementation uses inline drill-down panels rendered within each view.

### 4.1 Interaction Model

Each summary card has two separate interactions:

1. **Card body click** — keeps existing behavior, switches the active tab view
2. **Displayed time value click** — opens an inline drill-down panel for that view

### 4.2 Drill-Down Placement (Implemented)

#### Today (DayView)
- Clicking Today card time → switches to Day view and opens `DayIssueDrilldown` **inline below the timeline**
- Issue-level breakdown for the current day
- Calls backend resolver `getMyDayIssueBreakdown`

#### Week (WeekView)
- Clicking any day's time cell in the week table → opens `DayIssueDrilldown` **below the week table**
- Clicking the Week summary card time → opens today's date drill-down within the week view
- Issue-level breakdown for the clicked day

#### Month (MonthView)
- Clicking any day's time in the calendar grid → opens `DayIssueDrilldown` in a **right-side panel** beside the calendar
- Clicking the Month summary card time → opens the current month and auto-selects today's drill-down
- Issue-level breakdown for the clicked calendar day

### 4.3 Drill-Down Panel Content

Each drill-down shows:
- Date heading
- Total time for that day
- Issue list with: issue key, issue summary, time spent, percentage of daily total, progress bar
- Loading, empty, and error states
- Close button

### 4.4 Visual Affordance for Clickable Times

All clickable time values use:
- Blue-tinted chip/pill styling (`background: #F4F8FF`, blue dashed border, `color: #0747A6`)
- `View` badge via `::after` pseudo-element (summary cards only)
- Hover state with darker border and elevated shadow
- Cursor: pointer
- No text underline

### 4.5 Team Summary Removed

The Team Summary section was removed from the Time Analytics Month view entirely per user request. Helper functions `getUserMonthlyTime()`, `getInitials()`, `getAvatarColor()` were deleted from `MonthView.js`.

---

## 5. Technical Design (As Implemented)

### 5.1 Files Changed

#### A. `forge-app/src/services/analytics/teamAnalyticsService.js` ✅
- Added `fetchMyDayIssueBreakdown(accountId, cloudId, date)` — fetches current user's issue breakdown for a specific date using `daily_time_summary` + `activity_records`, enriched with Jira issue details via `fetchIssueDetailsBatch`
- Returns `{ userId, date, totalSeconds, totalHours, issueCount, issues[] }`
- Does not require admin permissions

#### B. `forge-app/src/services/analyticsService.js` ✅
- Added `fetchMyDayIssueBreakdown` to barrel exports

#### C. `forge-app/src/resolvers/analyticsResolvers.js` ✅
- Registered new resolver `getMyDayIssueBreakdown` — accessible to all users (no admin gate)
- Calls `fetchMyDayIssueBreakdown` from teamAnalyticsService

#### D. New file: `forge-app/static/main/src/components/tabs/time-analytics/DayIssueDrilldown.js` ✅
- Reusable inline drill-down panel component
- Props: `selectedDate`, `onClose`
- Calls `invoke('getMyDayIssueBreakdown', { date })`
- Shows loading / error / empty states
- Lists issues with time, percentage, and progress bar
- Renders entirely inline — no modal overlay

#### E. `forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js` ✅
- Each time value converted from `<div>` to `<button className="stat-value stat-value--drilldown">`
- New `onDrillDown` prop accepted
- Click calls `onDrillDown('today' | 'week' | 'month')` with `e.stopPropagation()`

#### F. `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` ✅
- Added `summaryDrillDate` state
- Added `handleSummaryDrillDown(type)` — today → switches to day view; week → week view; month → sets selectedMonth + switches
- Passes `onDrillDown={handleSummaryDrillDown}` to `SummaryCards`
- Passes `summaryDrillDate` down to `DayView`, `WeekView`, `MonthView`

#### G. `forge-app/static/main/src/components/tabs/time-analytics/WeekView.js` ✅
- Day hour cells converted to `<button className="time-drilldown-btn">`
- `DayIssueDrilldown` renders **below the week table**
- `useEffect` auto-opens drill-down when `summaryDrillDate` matches a day in the current week

#### H. `forge-app/static/main/src/components/tabs/time-analytics/MonthView.js` ✅
- Team Summary section completely removed
- Calendar time values converted to `<button className="cell-time cell-time-drilldown">`
- `DayIssueDrilldown` + placeholder rendered in a `month-right-column` div on the **right side** of the calendar
- `useEffect` auto-opens drill-down when `summaryDrillDate` matches the selected month

#### I. `forge-app/static/main/src/components/tabs/time-analytics/DayView.js` ✅
- Added `summaryDrillDate` prop and `selectedDate` state
- `useEffect` auto-opens drill-down when `summaryDrillDate === todayStr`
- Renders `<DayIssueDrilldown>` inline below the timeline

#### J. `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` ✅
- `.stat-value--drilldown`: blue chip style, `::after` "View" badge, no underline
- `.time-drilldown-btn`: pill shape, blue border, no underline
- `.cell-time-drilldown`: chip style, blue transparent border, no underline
- `.month-right-column`: 360px right-side column for month drill-down
- `.drilldown-placeholder`: dashed border placeholder when nothing selected in month view
- `.day-drilldown-*`: full drill-down panel styles

> **Note:** The original plan proposed `TimeAnalyticsDrillDownModal.js` and `TimeAnalyticsDrillDownModal.css`. These were **not created**. The inline `DayIssueDrilldown.js` component replaced the modal entirely.

### 5.2 Backend Approach

A dedicated backend resolver `getMyDayIssueBreakdown` was added (Conditional Backend Change path from Section 7.2). The existing `getTimeAnalytics` batch payload was not sufficient for per-day issue breakdown, so a new focused endpoint was created instead of extending the batch response.

### 5.3 Build Information

- Build command: `npm run build` in `forge-app/` (runs `build:main` + `build:settings`)
- Deploy command: `forge deploy`
- Node version: v22.22.1, npm 10.9.4
- Latest deployed version: **6.27.0** (development environment)

---

## 6. Implementation Steps (Completed)

### Phase 1: Backend ✅
1. ✅ Added `fetchMyDayIssueBreakdown` to `teamAnalyticsService.js`
2. ✅ Exported from `analyticsService.js`
3. ✅ Registered `getMyDayIssueBreakdown` resolver in `analyticsResolvers.js`

### Phase 2: Inline Drill-Down Component ✅
1. ✅ Created `DayIssueDrilldown.js` (inline, no modal)
2. ✅ Styled within `TimeAnalyticsTab.css`

### Phase 3: Summary Card Trigger ✅
1. ✅ Converted time value `<div>` elements to `<button>` in `SummaryCards.js`
2. ✅ Added `onDrillDown` prop and `stopPropagation` handling
3. ✅ Blue chip/pill visual affordance added

### Phase 4: View Integration ✅
1. ✅ `TimeAnalyticsTab.js` — `summaryDrillDate` state + `handleSummaryDrillDown()`
2. ✅ `WeekView.js` — day cells clickable, drill-down below table
3. ✅ `MonthView.js` — day cells clickable, drill-down on right side, Team Summary removed
4. ✅ `DayView.js` — inline drill-down below timeline

### Phase 5: Visual Polish ✅
1. ✅ Blue tinted chip styling, View badge, hover states
2. ✅ Underline removed from all clickable time values

### Phase 6: Build and Deploy ✅
1. ✅ Fixed corrupted `node_modules/isexe` — resolved by `npm ci`
2. ✅ `npm run build` — compiled successfully
3. ✅ `forge deploy` — deployed version 6.27.0 to development environment

---

## 7. Backend Impact Assessment

### 7.1 No Change Path

No backend change is required if the batch `getTimeAnalytics` payload already provides:
- accurate today issue totals
- optionally issue summaries

In that case, this feature is a frontend-only enhancement.

### 7.2 Conditional Backend Change

Backend work is required only if today's issue breakdown cannot be derived correctly from the current payload.

Most likely adjustment point:

- `forge-app/src/services/analytics/userAnalyticsService.js`

Potential change:
- extend `fetchTimeAnalyticsBatch()` or the downstream batch API contract to include a dedicated today issue breakdown field

This should be treated as a data contract correction, not as a separate feature.

### 7.3 Features Not Expected to Be Affected

- Team Analytics
- Worklog reassignment flow
- DayView timeline rendering
- WeekView and MonthView existing rendering
- Permission model (`canViewAllUsers` remains false here)
- Desktop app download banner

Reason:
- this work stays inside the Time Analytics frontend surface unless today's issue data proves insufficient

---

## 8. Risks and Mitigations

### Risk 1: Today issue data is not actually day-scoped

Impact:
- Today modal would show incorrect issue totals

Mitigation:
- verify payload before frontend implementation
- if needed, add a dedicated backend field for today's issue breakdown

### Risk 2: Summary totals and modal totals diverge because of `todayDelta`

Impact:
- users lose trust in the analytics values

Mitigation:
- apply the same reconciliation logic inside modal data builders
- add a focused regression test for total alignment

### Risk 3: Drill-down click also changes active card view unintentionally

Impact:
- confusing UX

Mitigation:
- use separate click targets
- stop event propagation on the drill-down trigger

### Risk 4: Month drill-down does not reflect selected month navigation

Impact:
- modal shows current month while MonthView shows another month

Mitigation:
- pass `selectedMonth` from `TimeAnalyticsTab` into the modal and use it as the source of truth

### Risk 5: Mobile layout overflow in long issue/day lists

Impact:
- poor usability on smaller screens

Mitigation:
- use a scrollable modal body
- avoid wide column layouts
- test at narrow widths before merge

---

## 9. Testing Plan

### 9.1 Frontend Functional Validation

Validate the following behaviors:

1. Clicking the Today card body still switches to Day view
2. Clicking the Today time value opens the Today drill-down modal
3. Clicking the Week time value opens the Week drill-down modal
4. Clicking the Month time value opens the Month drill-down modal
5. Modal close works via close button and overlay
6. Empty states render without crashing
7. Selected month drill-down reflects the month currently shown in MonthView

### 9.2 Data Consistency Validation

Validate:

1. Today modal total equals Today summary card total
2. Week modal row totals sum to Week summary card total
3. Month modal row totals sum to Month summary card total
4. Current day adjustment remains consistent when `reconciledTodayTotal` differs from raw `dailySummary`

### 9.3 Regression Coverage

Relevant existing test:

- `forge-app/static/main/src/components/tabs/time-analytics/__tests__/timeConsistency.test.js`

Recommended additions:

1. SummaryCards drill-down trigger test
2. Modal data builder tests for:
   - today
   - week
   - month
3. Reconciliation test proving modal totals match summary card totals when `todayDelta` is non-zero

---

## 10. Actual File Change Set

### Backend Files ✅
- Modified `forge-app/src/services/analytics/teamAnalyticsService.js` — added `fetchMyDayIssueBreakdown`
- Modified `forge-app/src/services/analyticsService.js` — added barrel export
- Modified `forge-app/src/resolvers/analyticsResolvers.js` — registered `getMyDayIssueBreakdown` resolver

### Frontend Files ✅
- Modified `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js`
- Modified `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css`
- Modified `forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js`
- Modified `forge-app/static/main/src/components/tabs/time-analytics/WeekView.js`
- Modified `forge-app/static/main/src/components/tabs/time-analytics/MonthView.js`
- Modified `forge-app/static/main/src/components/tabs/time-analytics/DayView.js`
- **Added** `forge-app/static/main/src/components/tabs/time-analytics/DayIssueDrilldown.js`

### Files NOT Created (Originally Planned)
- ~~`forge-app/static/main/src/components/modals/TimeAnalyticsDrillDownModal.js`~~ — replaced by inline `DayIssueDrilldown.js`
- ~~`forge-app/static/main/src/components/modals/TimeAnalyticsDrillDownModal.css`~~ — styles added to `TimeAnalyticsTab.css`

---

## 11. Rollout Notes

Actual delivery sequence:

1. ✅ Added backend resolver `getMyDayIssueBreakdown` (new endpoint, not a batch payload extension)
2. ✅ Created inline `DayIssueDrilldown` component (no modal)
3. ✅ Wired drill-down into all three views (Day, Week, Month)
4. ✅ Made summary card time values real `<button>` elements
5. ✅ Added blue chip/pill visual affordance, removed underline
6. ✅ Removed Team Summary from Time Analytics Month view
7. ✅ Build verified with `npm run build`
8. ✅ Deployed version `6.27.0` to development environment with `forge deploy`

---

## 12. Outcome

After implementation:

- ✅ Users can click each summary card's displayed time to open an inline drill-down on the same page
- ✅ All views (Day, Week, Month) support issue-level drill-down per day via `getMyDayIssueBreakdown`
- ✅ Drill-down renders inline — no modal or popup
- ✅ Week drill-down appears below the week table
- ✅ Month drill-down appears in a right-side panel next to the calendar
- ✅ Today drill-down appears below the day timeline
- ✅ Team Summary section removed from Time Analytics Month view
- ✅ Clickable time values have clear blue chip styling with no underline
- ✅ Other features remain unaffected