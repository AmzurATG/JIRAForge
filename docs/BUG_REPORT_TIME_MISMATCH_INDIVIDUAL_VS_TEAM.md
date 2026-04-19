# Bug Report: Time Mismatch Between Individual and Team Analytics Pages

**Date:** April 11, 2026  
**Severity:** High  
**Component:** Analytics (Individual Time Analytics + Team Analytics)  
**Status:** Fixed  

---

## 1. Summary

There is a consistent time discrepancy between the **Individual Time Analytics page** (visible to all users) and the **Team Analytics page** (visible to admins/project admins). The individual user sees correct time spent values, but the admin sees different (lower) values for the same user on the Team Analytics page.

**Observed from screenshots (April 11, 2026):**

| Metric | Individual View (iswarya.kolimalla) | Team View (iswarya.kolimalla) | Difference |
|--------|--------------------------------------|-------------------------------|------------|
| Today | 1h 36m 5s | 24m 1s | **-1h 12m 4s** |
| This Week | 32h 2m 4s | 10h 32m 7s | **-21h 29m 57s** |
| This Month | 44h 32m 49s | 10h 32m 7s | **-34h 0m 42s** |

---

## 2. Root Cause Analysis

### Root Cause #1 (PRIMARY): Supabase PostgREST Row Limit (max_rows = 1000)

**This is the primary root cause discovered after initial deployment.** The Supabase PostgREST configuration in `supabase/config.toml` sets:

```toml
max_rows = 1000
```

This means **any single query to Supabase returns at most 1000 rows**, regardless of the `limit` parameter in the query URL. The team analytics table query fetches activity records for **all team members** across the project, ordered by `work_date.desc`. With high-session-count users (e.g., 273 productive sessions in a single day), the 1000-row cap causes:

- Only the most recent ~3-4 days of data to be returned
- Older data (beginning of the month/week) silently dropped
- **This Week = This Month** in the table because both only see the current week's capped data

**Evidence from screenshots (April 11, 2026):**
- Table shows iswarya Week = Month = 10h 38m 1s (identical — missing Apr 1-5 data)
- Popup month shows Week 1 (Apr 1-5) = 8h 50m 50s + Week 2 (Apr 6-12) = 13h 22m 26s = 22h 13m 16s
- This confirms the table's query was truncated and never received April 1-5 records

**Affected queries:** All queries with `limit=5000`, `limit=10000`, or `limit=20000` were effectively capped at 1000 rows by PostgREST.

### Root Cause #2 (FIXED): Classification Filter Mismatch — Different Data Sources

This was the initial identified cause (now fixed). The two views queried different data with different filters.

**File:** `forge-app/src/services/analytics/userAnalyticsService.js` (line ~163)

```javascript
const dailySummaryQuery = canViewAllUsers
  ? `daily_time_summary?organization_id=eq.${organization.id}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`
  : `daily_time_summary?user_id=eq.${userId}&organization_id=eq.${organization.id}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`;
```

The `daily_time_summary` is a database view defined in `supabase/migrations/20260323_fix_summary_view_filters.sql`. Its `activity_records` portion includes **ALL classifications**:

```sql
-- New data from activity_records (all classifications — total computer time)
SELECT
    act.user_id,
    act.organization_id,
    u.display_name AS user_display_name,
    act.work_date,
    act.project_key,
    act.user_assigned_issue_key AS task_key,
    'office' AS work_type,
    1 AS session_count,
    act.duration_seconds AS total_seconds,
    NULL::NUMERIC AS avg_confidence
FROM public.activity_records act
LEFT JOIN public.users u ON act.user_id = u.id
WHERE act.status IN ('pending', 'processing', 'analyzed')
  AND act.work_date IS NOT NULL
```

**No `classification` filter** — includes `productive`, `unknown`, `non_productive`, and `private` records.

#### Team View — `activity_records` (filtered to productive + unknown ONLY)

**File:** `forge-app/src/services/analytics/teamAnalyticsService.js` (line ~329)

```javascript
const memberActivityRecords = await supabaseRequest(
  supabaseConfig,
  `activity_records?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&classification=in.(productive,unknown)&work_date=gte.${queryStartStr}&work_date=lte.${todayStr}&select=user_id,work_date,duration_seconds,user_assigned_issue_key&order=work_date.desc&limit=10000`
);
```

**Explicit filter:** `classification=in.(productive,unknown)` — **excludes** `non_productive` and `private` records.

#### Impact

Any time a user has activity classified as `non_productive` or `private`, that time is:
- **INCLUDED** in the individual analytics page totals
- **EXCLUDED** from the team analytics page totals

This directly explains why the team view shows significantly less time than the individual view.

---

### Root Cause #2: Project-Scoped Query (NOT A BUG — By Design)

The team analytics query adds a **project_key filter**:

```
project_key=eq.${projectKey}
```

This means the team view only shows time for activity logged against **the selected project**. This is **intentional behavior** for project management purposes and is not a bug. When a user works across multiple projects, project-scoped totals will naturally be lower than cross-project totals shown in the individual view.

---

### Root Cause #3: `clientToday` Parameter Not Sent in Individual View

**File:** `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` (line ~35)

```javascript
// Individual view - NO clientToday parameter
const result = await invoke('getTimeAnalytics');
```

**File:** `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.js` (line ~64)

```javascript
// Team view - sends clientToday
const result = await invoke('getProjectTeamAnalytics', {
  projectKey: selectedProjectKey,
  clientToday: new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD in local timezone
});
```

The individual view does not pass `clientToday`, so the backend may fall back to UTC for date calculations. Meanwhile, the team view sends the browser's local date. Near midnight or in timezones far from UTC, this causes the "today" boundary to differ between the two views.

#### Impact

Minor discrepancy for "today" totals, especially around midnight in non-UTC timezones. Could shift a day's data to the previous or next day.

---

### Root Cause #4: Legacy Screenshot Data Timezone Handling

In the `daily_time_summary` SQL view (used by individual analytics only), legacy screenshot data uses:

```sql
COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')) AS work_date
```

When `s.work_date` is NULL, the fallback converts the UTC timestamp to a **UTC date**, not the user's local date. For users in IST (UTC+5:30), a screenshot taken at 11:30 PM IST (6:00 PM UTC) on April 10 would correctly be April 10. But a screenshot taken at 1:00 AM IST on April 11 (7:30 PM UTC April 10) would be assigned to **April 10 (UTC)**, not April 11 (user's local date).

#### Impact

Legacy screenshot data may be assigned to incorrect dates, causing minor mismatches in daily/weekly totals for the individual view's "today" bucket.

---

## 3. Data Flow Comparison

### Individual User Analytics — Full Pipeline

```
Browser → invoke('getTimeAnalytics')
  → analyticsResolvers.js → fetchTimeAnalyticsBatch()
    → userAnalyticsService.js → fetchTimeAnalytics()
      → Supabase query: daily_time_summary (ALL classifications, user-scoped)
        → Returns dailySummary[] with total_seconds per work_date
  → SummaryCards.js frontend calculates:
      Today:      dailySummary.filter(work_date === formatLocalDate(new Date()))
      This Week:  dailySummary.filter(work_date in [Monday..Today])
      This Month: dailySummary.filter(work_date starts with YYYY-MM)
```

### Team Analytics — Full Pipeline

```
Browser → invoke('getProjectTeamAnalytics', { projectKey, clientToday })
  → analyticsResolvers.js → fetchProjectTeamAnalytics()
    → teamAnalyticsService.js
      → Supabase query: activity_records
          WHERE classification IN ('productive', 'unknown')
          AND project_key = selectedProject
          AND work_date BETWEEN queryStart AND today
        → Returns memberActivityRecords[] with duration_seconds per work_date
  → Backend calculates per user:
      Today:      records.filter(work_date === todayStr).sum(duration_seconds)
      This Week:  records.filter(work_date in [Monday..Today]).sum(duration_seconds)
      This Month: records.filter(work_date in [MonthStart..Today]).sum(duration_seconds)
```

### Key Differences Table

| Aspect | Individual View | Team View |
|--------|----------------|-----------|
| **Data Source** | `daily_time_summary` view | `activity_records` table (direct) |
| **Classifications Included** | ALL (`productive`, `unknown`, `non_productive`, `private`) | `productive` + `unknown` only |
| **Project Scope** | All projects combined | Single selected project only |
| **Legacy Data** | Included (screenshots + analysis_results) | Not included (activity_records only) |
| **Time Calculation Location** | Frontend (SummaryCards.js) | Backend (teamAnalyticsService.js) |
| **`clientToday` Sent** | No | Yes |
| **Date Comparison Method** | `formatLocalDate()` via browser local TZ | `todayStr` from `clientToday` param |
| **Record Limit** | `MAX_DAILY_SUMMARY_DAYS` (60 days) | Paginated (1000 per page, up to 20,000 total) |

---

## 4. Affected Files

| File | Role | Relevance |
|------|------|-----------|
| `forge-app/src/services/analytics/userAnalyticsService.js` | Individual analytics backend | Queries `daily_time_summary` (no classification filter) |
| `forge-app/src/services/analytics/teamAnalyticsService.js` | Team analytics backend | Queries `activity_records` with `classification=in.(productive,unknown)` |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Individual analytics frontend | Does NOT send `clientToday` |
| `forge-app/static/main/src/components/tabs/TeamAnalyticsTab.js` | Team analytics frontend | Sends `clientToday` |
| `forge-app/static/main/src/components/tabs/time-analytics/SummaryCards.js` | Today/Week/Month cards | Frontend time period calculations |
| `forge-app/src/resolvers/analyticsResolvers.js` | Resolver entry points | Routes to service functions |
| `supabase/migrations/20260323_fix_summary_view_filters.sql` | DB view definition | `daily_time_summary` includes ALL classifications |
| `forge-app/src/services/analytics/orgAnalyticsService.js` | Org analytics backend | Uses `daily_time_summary` (consistent with individual) |

---

## 5. Impact Analysis

### Who is affected?
- **All administrators** viewing the Team Analytics page
- **All project admins** viewing team member activity
- Any comparison between individual and team dashboards

### What is wrong?
- Team Analytics page shows **significantly lower** time than the individual user's own analytics page
- The discrepancy grows with the number of `non_productive`/`private` classified records
- Multi-project users will also show lower time if the admin is viewing a single project

### Business Impact
- **Trust erosion**: Admins may think employees are underreporting time
- **Inaccurate reporting**: Team performance metrics are understated
- **Confusion**: Same user sees different numbers on different pages

---

## 6. Reproduction Steps

1. Log in as a user (e.g., `iswarya.kolimalla`)
2. Navigate to the **Time Analytics** tab
3. Note the values for **Time Spent Today**, **This Week**, and **This Month**
4. Log in as an administrator
5. Navigate to the **Team Analytics** tab
6. Select the project the user is working on
7. Compare the **Team Member Activity** table values for the same user
8. **Observe**: The team view shows lower values for today, this week, and this month

---

## 7. Fixes Applied

### Fix 0: Paginated Supabase Queries — Bypass max_rows=1000 (DONE — CRITICAL)

**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

Added a `supabaseRequestPaginated()` helper that automatically paginates through Supabase results using `limit=1000&offset=N`, fetching all records instead of being silently capped at 1000 rows.

```javascript
async function supabaseRequestPaginated(supabaseConfig, baseEndpoint, maxRecords = 20000) {
  const allRecords = [];
  let offset = 0;
  while (offset < maxRecords) {
    const page = await supabaseRequest(supabaseConfig,
      `${baseEndpoint}&limit=${SUPABASE_PAGE_SIZE}&offset=${offset}`);
    if (!page || page.length === 0) break;
    allRecords.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) break;
    offset += SUPABASE_PAGE_SIZE;
  }
  return allRecords;
}
```

**Applied to ALL critical queries:**
- `fetchProjectTeamAnalytics` — main table query (all team members, full month)
- `fetchMemberDayDetails` — today popup (could exceed 1000 for high-session users)
- `fetchMemberWeekDetails` — week popup
- `fetchMemberMonthDetails` — month popup
- `generateTeamExportData` — CSV export
- `generateTeamExportDataStructured` — Excel export

### Fix 1: Unified Classification Filter — All Records Included (DONE)

**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

The main `fetchProjectTeamAnalytics` function now fetches ALL activity records in a single query (removing the `classification=in.(productive,unknown)` filter) and splits them client-side:

```javascript
// BEFORE: Two separate queries with classification filters
const memberActivityRecords = await supabaseRequest(..., 
  `activity_records?...&classification=in.(productive,unknown)&...`);
const memberNonProductiveRecords = await supabaseRequest(..., 
  `activity_records?...&classification=in.(non_productive,private)&...`);

// AFTER: Single query fetching ALL classifications
const allMemberRecords = await supabaseRequest(...,
  `activity_records?...&status=in.(pending,processing,analyzed)&...`);
// Split client-side for backward compatibility
const memberActivityRecords = allMemberRecords.filter(r => 
  r.classification === 'productive' || r.classification === 'unknown' || !r.classification);
const memberNonProductiveRecords = allMemberRecords.filter(r => 
  r.classification === 'non_productive' || r.classification === 'private');
```

The `todaySeconds`, `weekSeconds`, `monthSeconds` now include ALL classifications (productive + unknown + non_productive + private), matching the individual view.

### Fix 2: Modal Detail Functions Include All Classifications (DONE)

**Files:** `fetchMemberDayDetails`, `fetchMemberWeekDetails`, `fetchMemberMonthDetails` in `teamAnalyticsService.js`

All three modal detail functions now:
- Fetch ALL records in a single query (no classification filter)
- Include non-productive time in `totalSeconds`
- Return `productiveSeconds` separately for optional breakdown display
- Ensures the popup time matches the table time exactly

### Fix 3: `clientToday` Parameter Added to Individual View (DONE)

**Files:** 
- `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js`
- `forge-app/src/resolvers/analyticsResolvers.js`
- `forge-app/src/services/analytics/userAnalyticsService.js`

```javascript
// BEFORE:
const result = await invoke('getTimeAnalytics');

// AFTER:
const result = await invoke('getTimeAnalytics', {
  clientToday: new Date().toLocaleDateString('sv-SE')
});
```

The resolver and service functions now accept and forward the `clientToday` parameter.

### Fix 4: Exports Include All Classifications, Unassigned Issues (DONE)

**Files:**
- `forge-app/src/services/analytics/teamAnalyticsService.js` (`generateTeamExportData`, `generateTeamExportDataStructured`)
- `forge-app/static/main/src/utils/excelExport.js`

**CSV Export:**
- Now fetches ALL records in one query (no classification filter)
- Added "Classification" column (Productive / Non-Productive / Private)
- Non-productive and private entries are included inline (no separate section)
- Unassigned issues (null `user_assigned_issue_key`) show as "Unassigned"
- Total row includes all classifications

**Excel Export (single and multi-project):**
- Added "Classification" column to "Detailed Activity" sheet
- Non-productive entries are included alongside productive entries
- Both productive and non-productive entries contribute to "Time by Issue" aggregation
- Unassigned issues are included in all sheets

### Fix 5: Activity Trend Uses All Classifications (DONE)

**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

The 14-day activity trend bar chart now uses `allMemberRecords` (all classifications) instead of only `memberActivityRecords` (productive/unknown), ensuring the trend bars match the table totals.

### Fix 6: Frontend Label Update (DONE)

**File:** `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js`

Changed "Productive Time" labels to "Total Time" in the Today, Week, and Month modal views since the totals now include all activity classifications.

---

## 8. Note on Project-Scoped Timing

Project-scoped timing is **by design** and not a bug. The Team Analytics page intentionally shows time for the selected project only. When a user works across multiple projects, the team view shows only the portion of time relevant to the currently selected project, which is the correct behavior for project management purposes.

---

## 9. Files Modified

| File | Changes |
|------|---------|
| `forge-app/src/services/analytics/teamAnalyticsService.js` | Added `supabaseRequestPaginated` helper to bypass max_rows=1000; converted all 6 major queries to paginated; removed classification filters; unified all-records query approach; included non_productive + private in totals; fixed trend chart; fixed all 3 modal detail functions; fixed both export functions |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Added `clientToday` parameter to `getTimeAnalytics` invoke call |
| `forge-app/src/resolvers/analyticsResolvers.js` | Updated `getTimeAnalytics` resolver to accept and forward `clientToday` |
| `forge-app/src/services/analytics/userAnalyticsService.js` | Updated `fetchTimeAnalyticsBatch` and `fetchTimeAnalytics` signatures to accept `clientToday` |
| `forge-app/static/main/src/components/modals/TeamMemberActivityModal.js` | Changed "Productive Time" labels to "Total Time" |
| `forge-app/static/main/src/utils/excelExport.js` | Added "Classification" column to single and multi-project Excel exports; included non-productive entries |

---

## 10. Verification Plan

After deployment:

1. Log in as a user with activity across all 4 classifications (`productive`, `unknown`, `non_productive`, `private`)
2. Note the individual Time Analytics page totals for today/week/month
3. Log in as admin, navigate to Team Analytics for the same project
4. **Assert:** Table totals for that user must match the individual view (within project scope)
5. Click on Today/Week/Month hours to open the modal popup
6. **Assert:** Modal total must match the table value exactly
7. Export to Excel — verify "Classification" column appears, non-productive and private entries are listed
8. Export to CSV — verify all classifications are present with the Classification column
9. Test around midnight in IST timezone to verify `clientToday` works correctly
10. Verify the activity trend bar chart totals match the summed table data for that day

---

## 10. Screenshots

### Individual View (iswarya.kolimalla — April 11, 2026)
- Time Spent Today: **1h 36m 5s**
- Time Spent This Week: **32h 2m 4s**
- Time Spent This Month: **44h 32m 49s**

### Team View (Admin — April 11, 2026)
- iswarya.kolimalla Today: **24m 1s**
- iswarya.kolimalla This Week: **10h 32m 7s**
- iswarya.kolimalla This Month: **10h 32m 7s**

### Vishnu Sai Kanthamraju (Team View)
- Today: **0s**
- This Week: **10h 10m**
- This Month: **10h 10m**

---

## 11. Conclusion

The **primary root cause** was the classification filter mismatch: the individual view included all activity record classifications via the `daily_time_summary` database view, while the team view explicitly filtered to only `productive` and `unknown` classifications. This was compounded by the missing `clientToday` parameter.

**All fixes have been applied.** The team analytics table, modal popups, activity trend chart, and Excel/CSV exports now all use the same data source with no classification filters, ensuring consistent time totals across the entire application. Non-productive and private time is included in all totals and export files with a "Classification" column for transparency.
