# plan/2026-05-18_forge-app_unassigned-work-date-filter.md

## 1. Scope & goals

### 1.1 Feature overview

Adds a **date range filter** to the Unassigned Work screen so users can quickly narrow down
groups to a specific time window instead of scrolling through all paginated records.

Components touched: `forge-app` (React UI + resolver backend).

Primary persona: Jira developer or manager reviewing unassigned work in the Time Tracker project page.

### 1.2 In scope

- Two date inputs (From / To) rendered in the Unassigned Work header, between the summary line and the existing filter tabs.
- Selecting either date triggers a reload of groups filtered to that date range (server-side).
- An "✕ Clear" button resets both dates and reloads all groups.
- `getUnassignedGroups` resolver accepts `dateFrom` and `dateTo` (YYYY-MM-DD strings) and applies `created_at >= dateFrom` / `created_at <= dateTo` filters on `unassigned_work_groups`.
- Pagination resets to `offset=0` whenever dates change.
- `getUnassignedWork` (legacy sessions) also receives dates — already supported.
- Group details / work-sessions caches are cleared on date change so stale data is not shown.

### 1.3 Out of scope

- Filtering by the actual work date of individual activity records inside a group (requires a JOIN; deferred).
- Preset shortcuts ("Today", "Last 7 days" etc.) — deferred.
- Persisting the date filter across page reloads.
- Mobile-specific date picker widget.

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- `unassigned_work_groups.created_at` is a timestamptz column indexed by default; adding a date filter on it will not require a new Supabase migration.
- The AI clustering service runs every 5 minutes, so `created_at` on a group is a reliable same-day proxy for when the work occurred.
- `isValidDate` in `forge-app/src/utils/validators.js` validates `YYYY-MM-DD` strings; it is reused without modification.
- All features depend on `plan/base_plan/jiraforge_base-skeleton.md`.

### 2.2 Dependencies

- No new Supabase migrations required.
- No changes to AI server.
- No new npm dependencies — uses native HTML `<input type="date">`.

---

## 3. UI layouts

### 3.1 User flows

1. User opens **Unassigned Work** tab — sees all groups (no date filter applied, inputs empty).
2. User sets "From" date → groups reload filtered to `created_at >= From` (To defaults to today if not set).
3. User sets "To" date → groups reload filtered to `created_at <= To 23:59:59`.
4. User clicks "✕ Clear" → both inputs reset, groups reload with no date filter.
5. Existing filter tabs (All, AI Recommended, etc.) continue to work on top of the date-filtered groups.

### 3.2 Screens and components

**UnassignedWork.js** (`static/main/src/components/UnassignedWork.js`):

```
[Unassigned Work]                           [Bulk Time Edit]
12 sessions • 10 groups • 7m 44s total time

From: [2026-05-01] To: [2026-05-18] [✕ Clear]      ← NEW row

[All (10)] [AI Recommended] [Needs Review] [Unassigned Work (10)] [Idle Sessions (0)]
```

Date filter row appears below the summary line, above the quick-filter tabs.
The "✕ Clear" button only renders when at least one date is set.

---

## 4. File and function names (physical structure)

### 4.1 Forge app (`forge-app/`)

**Modified files:**

```
forge-app/static/main/src/components/
  UnassignedWork.js           # Add dateFrom/dateTo state + date filter UI
  UnassignedWork.css          # Add .date-filter-row, .date-filter-input styles

forge-app/src/resolvers/unassigned/
  sessionResolvers.js         # getUnassignedGroups — accept + apply dateFrom/dateTo

forge-app/tests/resolvers/
  unassigned-date-filter.test.js   # New unit tests (acceptance criteria)
```

**Changes in `UnassignedWork.js`:**
- `dateFrom` / `dateTo` state (`useState('')`).
- `handleDateChange(field, value)` — updates the relevant state.
- `handleClearDates()` — resets both states to `''`.
- `loadUnassignedWork` — receives optional `{ dateFrom, dateTo }` overrides; passes them to `invoke('getUnassignedGroups', ...)` and `invoke('getUnassignedWork', ...)`.
- A `useEffect` on `[dateFrom, dateTo]` (skipping first render) that clears caches and calls `loadUnassignedWork(false)`.
- Date filter row JSX rendered between `.unassigned-work-summary` and `.quick-filter-row`.

**Changes in `sessionResolvers.js` → `getUnassignedGroups`:**
- Extract `dateFrom`, `dateTo` from `req.payload`.
- Validate with `isValidDate`.
- Append `&created_at=gte.${dateFrom}T00:00:00` / `&created_at=lte.${dateTo}T23:59:59` to both the count query and the data query.

---

## 5. API contracts

### 5.1 Forge app resolver API

**Modified resolver: `getUnassignedGroups`**

```
input:  { limit?: number, offset?: number, dateFrom?: string, dateTo?: string }
         dateFrom / dateTo: YYYY-MM-DD strings; optional; ignored if invalid
output: { success, groups[], total_groups, has_more, next_offset }  ← unchanged shape
errors: same as before
```

---

## 6. Database structure

No schema changes. The `created_at` column on `unassigned_work_groups` is already present.

---

## 7. Migration files

None required.

---

## 8. Background jobs and Edge Functions

No background jobs added or changed.

---

## 9. Test plan

### 9.1 Unit tests — `tests/resolvers/unassigned-date-filter.test.js`

**AC-1**: `getUnassignedGroups` with `dateFrom='2026-05-14'` appends `created_at=gte.2026-05-14T00:00:00` to the Supabase query.

**AC-2**: `getUnassignedGroups` with `dateTo='2026-05-14'` appends `created_at=lte.2026-05-14T23:59:59` to the Supabase query.

**AC-3**: `getUnassignedGroups` with both `dateFrom` and `dateTo` appends both filters.

**AC-4**: `getUnassignedGroups` with no dates does NOT add any `created_at` filter to the query.

**AC-5**: `getUnassignedGroups` with an invalid date string (e.g. `'not-a-date'`) ignores that parameter and does not add a filter.

---

## 10. Interaction diagrams

### 10.1 Happy path — user applies date filter

```
React UnassignedWork component
  User sets dateFrom input → handleDateChange('dateFrom', '2026-05-14')
    → setDateFrom('2026-05-14')
      → useEffect fires → clearGroupCaches() → loadUnassignedWork(false)
        → invoke('getUnassignedGroups', { limit:10, offset:0, dateFrom:'2026-05-14' })
          → sessionResolvers.getUnassignedGroups
            → validates dateFrom
            → Supabase query: unassigned_work_groups?...&created_at=gte.2026-05-14T00:00:00
            → returns { success, groups[], total_groups, has_more }
          → UI updates: setGroups(newGroups), setHasMoreGroups, setNextOffset
```

### 10.2 Failure path — Supabase rejects query

```
(same as happy path up to Supabase query)
  → Supabase returns error
    → handleResolverError returns { success: false, error: '...' }
      → loadUnassignedWork: enters retry logic (up to MAX_RETRIES=5)
        → on final failure: setError('Failed to load unassigned work')
          → UI renders error state with Retry button
```

---

## 11. Risks, edge cases, and open questions

### 11.1 Risks

- `created_at` on the group is when the AI clustered the activities, not exactly when work occurred. Groups created at midnight may cross day boundaries. Accepted trade-off for this iteration.

### 11.2 Edge cases

- `dateFrom` after `dateTo` — Supabase will return 0 rows; UI shows "No groups found for this filter."
- Single date (only `dateFrom` set, no `dateTo`) — filter is `created_at >= dateFrom` with no upper bound; all groups from that date onwards are shown.
- Pagination with date filter — `offset` resets to 0 whenever dates change; Load More continues with the active date filter.

---

## 12. Rollout and feature flagging

No feature flag required — the date inputs default to empty (no filter), so behaviour is unchanged until the user interacts with them. This is an additive UI change only.

---

## 13. Notification events

No notification events for this feature.
