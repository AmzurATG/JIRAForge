# Week View Drill-Down Day Selection Fix

## Bug Report

**Date:** 2026-04-29  
**Component:** Time Analytics → Week View → Day Drill-Down  
**Severity:** Medium (functional regression)  
**Reporter:** User (via screenshot)

### Observed Behavior

When viewing the "Time Spent This Week" summary card and clicking on a specific day's time cell in the weekly table, the drill-down panel always shows **today's** data instead of the data for the **selected day**.

### Expected Behavior

Clicking on any day cell (e.g., Monday's `2h 39m`) should open the `DayIssueDrilldown` panel showing the issue breakdown **for that specific date**, not today.

---

## Root Cause Analysis

### Problem 1: Unstable `weekDates` Reference (Primary Cause)

**File:** `forge-app/static/main/src/components/tabs/time-analytics/WeekView.js`  
**Lines:** 49–55

```javascript
// BEFORE (BUGGY)
const weekDates = getWeekDates(today);  // New array on EVERY render

useEffect(() => {
  if (!summaryDrillDate) return;
  if (weekDates.some(item => item.dateStr === summaryDrillDate)) {
    setSelectedDate(summaryDrillDate);
  }
}, [summaryDrillDate, weekDates]);  // weekDates changes every render → effect fires every render
```

`getWeekDates(today)` returns a **new array reference** on every render. Since `weekDates` is listed in the `useEffect` dependency array, React treats it as changed on every render, causing the effect to fire repeatedly. Because `summaryDrillDate` is always set to today's date (and never cleared), this effect keeps resetting `selectedDate` back to today on every render — overriding whatever day cell the user clicked.

### Problem 2: `summaryDrillDate` Never Consumed/Cleared

**File:** `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js`  
**Lines:** 95–107

```javascript
const handleSummaryDrillDown = (type) => {
  const todayStr = new Date().toLocaleDateString('sv-SE');
  setSummaryDrillDate(todayStr);  // Always today, never cleared after consumption
  ...
};
```

Once the summary card "View" button is clicked, `summaryDrillDate` is set to today's date string and stays there indefinitely. Combined with Problem 1, this means every subsequent render re-applies the drill date, overriding any user-initiated `setSelectedDate(dateStr)` call from clicking a day cell.

### Impact Chain

1. User clicks summary card "View" → `summaryDrillDate = "2026-04-29"` (today)
2. WeekView renders → `weekDates` is a new array → effect fires → `setSelectedDate("2026-04-29")`
3. User clicks Monday's cell (e.g., `"2026-04-28"`) → `setSelectedDate("2026-04-28")`
4. React re-renders → `weekDates` is again a new array → effect fires again → `setSelectedDate("2026-04-29")` (overrides step 3)
5. `DayIssueDrilldown` receives `selectedDate="2026-04-29"` → fetches and shows today's data

---

## Fix Applied

### Change 1: Memoize `weekDates`

Wrap the `getWeekDates()` call in `useMemo` with `todayStr` (a stable string primitive) as the dependency. This ensures the array reference stays stable across renders within the same day.

```javascript
// AFTER (FIXED)
const weekDates = useMemo(() => getWeekDates(today), [todayStr]);
```

### Change 2: Track Last Consumed `summaryDrillDate`

Add a ref to track the last consumed drill date. The effect now skips execution if the same drill date has already been applied, allowing user clicks on day cells to take precedence.

```javascript
// AFTER (FIXED)
const lastDrillDateRef = useRef(null);

useEffect(() => {
  if (!summaryDrillDate) return;
  if (summaryDrillDate === lastDrillDateRef.current) return;  // Already consumed
  lastDrillDateRef.current = summaryDrillDate;
  if (weekDates.some(item => item.dateStr === summaryDrillDate)) {
    setSelectedDate(summaryDrillDate);
  }
}, [summaryDrillDate, weekDates]);
```

### Files Modified

| File | Change |
|------|--------|
| `forge-app/static/main/src/components/tabs/time-analytics/WeekView.js` | Added `useMemo`, `useRef` imports; memoized `weekDates`; added `lastDrillDateRef` guard |

### Why DayView and MonthView Are Not Affected

- **DayView:** Dependencies are `[summaryDrillDate, todayStr]` — both primitive strings, stable across renders.
- **MonthView:** Dependencies are `[summaryDrillDate, selectedMonthStr]` — both primitive strings, stable across renders.

Only `WeekView` had an **array** in its dependency list, causing the instability.

---

## Verification Steps (Manual)

1. Navigate to Time Analytics → Week View
2. Confirm the weekly table shows data for multiple days
3. Click on a non-today day cell (e.g., Monday) → Verify drill-down shows Monday's issue breakdown
4. Click on Wednesday's cell → Verify drill-down updates to Wednesday's data
5. Click the same cell again → Verify drill-down closes (toggle behavior)
6. Click the "View" button on the "Time Spent This Week" summary card → Verify it opens today's drill-down
7. After step 6, click on a different day cell → Verify it switches to that day (not stuck on today)
8. Switch to Day view and back to Week view → Verify drill-down state is clean

---

## Test Scripts

### Location

- **Unit Tests:** `forge-app/static/main/src/components/tabs/time-analytics/__tests__/WeekView.test.js`
- **Integration Test:** `forge-app/tests/services/weekViewDrilldown.test.js`

### Test Coverage

| Test | What It Verifies |
|------|-----------------|
| Renders week table with correct day columns | Basic rendering |
| Clicking a day cell sets selectedDate to that date | User click works |
| Clicking the same day cell toggles drill-down closed | Toggle behavior |
| summaryDrillDate auto-opens the drill-down | Card "View" flow |
| User click after summaryDrillDate overrides the auto-opened date | THE BUG FIX |
| weekDates memoization prevents stale override | Stability guarantee |
| DayIssueDrilldown receives correct selectedDate prop | Prop passing |

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `useMemo` with `todayStr` not updating at midnight | Very Low | User would refresh or navigate away; no session spans midnight realistically |
| `lastDrillDateRef` prevents re-opening same date from card | Low | Only affects repeated clicks on same summary card without navigation; acceptable UX |
| Breaking existing summaryDrillDate flow for DayView/MonthView | None | Those components are unmodified |

---

## Rollback Plan

Revert the single file change in `WeekView.js`:
- Remove `useMemo` and `useRef` imports
- Replace `useMemo(() => getWeekDates(today), [todayStr])` with `getWeekDates(today)`
- Remove `lastDrillDateRef` and its guard condition in the `useEffect`
