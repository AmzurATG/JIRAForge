# Working Hours in Tracking Settings — Implementation Plan

## 1. Overview

Add **admin-configurable working hours** to the Timesheet Tracker settings so that idle time is only captured and displayed during work hours. This ensures the timeline doesn't show irrelevant idle blocks (e.g., overnight sleep, weekends) — only gaps within the employee's defined work window.

### Why `tracking_settings` and Not `notification_preferences`?

| Aspect | `notification_preferences` (existing) | `tracking_settings` (proposed) |
|--------|---------------------------------------|-------------------------------|
| **Scope** | Per-user | Org-wide → project-specific (3-tier fallback) |
| **Controlled by** | Individual user | Admin / Project Admin |
| **Current purpose** | Control notification delivery windows | Control tracking behavior (screenshots, idle, intervals) |
| **Consumers** | AI server notification service only | Desktop app + Forge UI (both need work hours) |
| **Multi-level** | No (flat per-user) | Yes (project → org → global) |
| **Already fetched by desktop app** | No | Yes — `fetch_tracking_settings()` with 5-min cache |

**Decision**: Add to `tracking_settings`. This is an admin policy setting ("our work day is 9am–6pm") that applies uniformly per org/project, not a user preference. The desktop app already fetches `tracking_settings` every 5 minutes — zero new API calls needed.

The existing `notification_preferences.work_hours_*` columns remain **untouched** and continue to serve their purpose (notification delivery windows per user).

---

## 2. Current Architecture Context

### 2.1 `tracking_settings` Table (Current Schema)

```sql
CREATE TABLE public.tracking_settings (
    id UUID PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id),
    project_key TEXT,                          -- NULL = org-wide default
    screenshot_monitoring_enabled BOOLEAN DEFAULT true,
    screenshot_interval_seconds INTEGER DEFAULT 900,
    tracking_mode TEXT DEFAULT 'interval',
    event_tracking_enabled BOOLEAN DEFAULT false,
    track_window_changes BOOLEAN DEFAULT true,
    track_idle_time BOOLEAN DEFAULT true,
    idle_threshold_seconds INTEGER DEFAULT 300,
    whitelist_enabled BOOLEAN,
    whitelisted_apps TEXT[],
    blacklist_enabled BOOLEAN,
    blacklisted_apps TEXT[],
    non_work_threshold_percent INTEGER,
    flag_excessive_non_work BOOLEAN,
    private_sites_enabled BOOLEAN,
    private_sites TEXT[],
    jira_worklog_sync_enabled BOOLEAN DEFAULT false,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
```

**Unique constraints**: One row per `(organization_id, project_key)` pair. NULL `project_key` = org-wide default.

### 2.2 3-Tier Fallback Hierarchy

Settings are resolved in this order:

1. **Project-specific**: `organization_id = X AND project_key = 'PROJ'`
2. **Organization-wide**: `organization_id = X AND project_key IS NULL`
3. **Global defaults**: `organization_id IS NULL AND project_key IS NULL`

Both the Forge backend (`settingsService.js → fetchTrackingSettingsWithFallback()`) and the desktop app (`desktop_app.py → fetch_tracking_settings()`) implement this exact fallback.

### 2.3 Settings Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  Admin UI (TimesheetSettings.js)                             │
│  ┌──────────────┐                                            │
│  │ Working Hours │ ← NEW SECTION                             │
│  │ Start: 09:00  │                                           │
│  │ End:   18:00  │                                           │
│  │ Days: M-F     │                                           │
│  └──────┬───────┘                                            │
│         │ invoke('saveTrackingSettings', { settings })        │
│         ▼                                                    │
│  settingsResolvers.js → settingsService.js                   │
│         │ PATCH/INSERT tracking_settings                     │
│         ▼                                                    │
│  ┌─────────────────────┐                                     │
│  │   Supabase:          │                                    │
│  │   tracking_settings  │                                    │
│  │   + work_hours_start │ ← NEW COLUMNS                     │
│  │   + work_hours_end   │                                    │
│  │   + work_days        │                                    │
│  └──────┬──────────────┘                                     │
│         │                                                    │
│    ┌────┴────────┐    ┌────────────────┐                     │
│    ▼             ▼    ▼                                       │
│  Desktop App   Forge Timeline API                            │
│  (every 5min)  (on DayView load)                             │
│                                                              │
│  Filters idle  Filters idle blocks                           │
│  records at    at query time or                              │
│  creation time post-processing                               │
└──────────────────────────────────────────────────────────────┘
```

### 2.4 Files Involved

| File | Role | Change Type |
|------|------|-------------|
| `supabase/migrations/20260326_add_work_hours_to_tracking_settings.sql` | Add columns | **NEW** |
| `forge-app/src/config/constants.js` | Add defaults | **MODIFY** |
| `forge-app/src/services/settingsService.js` | Map new columns in get/save | **MODIFY** |
| `forge-app/src/resolvers/settingsResolvers.js` | No change (already passes through all settings) | **NO CHANGE** |
| `forge-app/static/main/src/shared/components/TimesheetSettings.js` | Add Working Hours UI section | **MODIFY** |
| `forge-app/static/main/src/shared/components/TimesheetSettings.css` | Styles for time pickers, day checkboxes | **MODIFY** |
| `python-desktop-app/desktop_app.py` | Read work hours, filter idle records | **MODIFY** |
| `forge-app/src/services/analytics/teamAnalyticsService.js` | Filter idle blocks by work hours | **MODIFY** |
| `forge-app/static/main/src/components/tabs/time-analytics/DayView.js` | Use work hours for timeline display | **MODIFY** |

---

## 3. Database Migration

**File**: `supabase/migrations/20260326_add_work_hours_to_tracking_settings.sql`

```sql
-- ============================================================================
-- Migration: Add working hours columns to tracking_settings
-- Date: 2026-03-26
--
-- Adds work_hours_start, work_hours_end, and work_days to tracking_settings
-- so admins can define the work window per org/project.
-- Idle blocks outside these hours are excluded from the timeline.
-- ============================================================================

ALTER TABLE public.tracking_settings
  ADD COLUMN IF NOT EXISTS work_hours_start TIME DEFAULT '09:00:00',
  ADD COLUMN IF NOT EXISTS work_hours_end TIME DEFAULT '18:00:00',
  ADD COLUMN IF NOT EXISTS work_days INTEGER[] DEFAULT '{1,2,3,4,5}';
  -- work_days: 1=Monday, 2=Tuesday, ..., 7=Sunday (ISO 8601)

COMMENT ON COLUMN public.tracking_settings.work_hours_start
  IS 'Start of work day (local time). Idle outside this window is excluded from timeline.';
COMMENT ON COLUMN public.tracking_settings.work_hours_end
  IS 'End of work day (local time). Idle outside this window is excluded from timeline.';
COMMENT ON COLUMN public.tracking_settings.work_days
  IS 'Active work days (ISO: 1=Mon..7=Sun). Idle on non-work days is excluded.';
```

### Why These Defaults?

- `09:00 – 18:00` Mon–Fri matches the existing `notification_preferences` defaults, so behavior is consistent.
- The desktop app records idle only within these bounds. The Forge UI filters timeline idle blocks to the same bounds.
- A night-shift project can override to `22:00 – 06:00` at the project level.

### Cross-Midnight Work Hours

If `work_hours_start > work_hours_end` (e.g., `22:00 – 06:00`), the logic treats it as spanning midnight. Both the desktop app and timeline service handle this with:
```
if start > end:
    is_within = (current_time >= start) OR (current_time <= end)
else:
    is_within = (start <= current_time <= end)
```

---

## 4. Backend Constants

**File**: `forge-app/src/config/constants.js`

Add to `DEFAULT_TRACKING_SETTINGS`:

```javascript
export const DEFAULT_TRACKING_SETTINGS = {
  // ... existing fields ...
  jiraWorklogSyncEnabled: false,
  showIdleInTimeline: true,
  // Working Hours (admin-defined work window for idle filtering)
  workHoursStart: '09:00',    // HH:MM format (local time)
  workHoursEnd: '18:00',      // HH:MM format (local time)
  workDays: [1, 2, 3, 4, 5]   // ISO: 1=Mon..7=Sun
};
```

---

## 5. Settings Service Changes

**File**: `forge-app/src/services/settingsService.js`

### 5.1 `transformSettingsToApiFormat()` — Add Work Hours Mapping

```javascript
function transformSettingsToApiFormat(settings, settingsSource) {
  return {
    // ... existing fields ...
    jiraWorklogSyncEnabled: settings.jira_worklog_sync_enabled ?? false,
    // NEW: Working hours
    workHoursStart: settings.work_hours_start ?? '09:00:00',
    workHoursEnd: settings.work_hours_end ?? '18:00:00',
    workDays: settings.work_days ?? [1, 2, 3, 4, 5],
    projectKey: settings.project_key || null,
    settingsSource: settingsSource
  };
}
```

### 5.2 `saveTrackingSettings()` — Add Work Hours to Save Payload

In the `trackingData` object:

```javascript
const trackingData = {
  // ... existing fields ...
  jira_worklog_sync_enabled: settings.jiraWorklogSyncEnabled ?? false,
  // NEW: Working hours
  work_hours_start: settings.workHoursStart || '09:00:00',
  work_hours_end: settings.workHoursEnd || '18:00:00',
  work_days: settings.workDays || [1, 2, 3, 4, 5],
  updated_by: userId,
  updated_at: new Date().toISOString()
};
```

### 5.3 Validation

Add to `validateTrackingSettings()`:

```javascript
// Validate work hours format (HH:MM or HH:MM:SS)
if (settings.workHoursStart && !/^\d{2}:\d{2}(:\d{2})?$/.test(settings.workHoursStart)) {
  throw new Error('Invalid work hours start format. Use HH:MM');
}
if (settings.workHoursEnd && !/^\d{2}:\d{2}(:\d{2})?$/.test(settings.workHoursEnd)) {
  throw new Error('Invalid work hours end format. Use HH:MM');
}
if (settings.workDays && (!Array.isArray(settings.workDays) || 
    settings.workDays.some(d => d < 1 || d > 7))) {
  throw new Error('Invalid work days. Use 1-7 (1=Monday, 7=Sunday)');
}
```

---

## 6. Admin UI Changes

**File**: `forge-app/static/main/src/shared/components/TimesheetSettings.js`

### 6.1 New State Fields

Add to the default `settings` state:

```javascript
const [settings, setSettings] = useState({
  // ... existing fields ...
  jiraWorklogSyncEnabled: false,
  // Working Hours
  workHoursStart: '09:00',
  workHoursEnd: '18:00',
  workDays: [1, 2, 3, 4, 5]
});
```

### 6.2 New "Working Hours" Section (JSX)

Insert **after** the Screenshot Monitoring section and **before** the Jira Worklog Auto-Sync section:

```
┌─────────────────────────────────────────────────────────────┐
│  🕐  Working Hours                                         │
│                                                             │
│  Define the work day window for your organization.          │
│  Idle time outside these hours will not appear on the       │
│  timeline.                                                  │
│                                                             │
│  ┌───────────────────────────────────────────┐              │
│  │  Start Time:  [09:00 ▾]                   │              │
│  │  End Time:    [18:00 ▾]                   │              │
│  └───────────────────────────────────────────┘              │
│                                                             │
│  Work Days:                                                 │
│  [✓] Mon  [✓] Tue  [✓] Wed  [✓] Thu  [✓] Fri              │
│  [ ] Sat  [ ] Sun                                           │
│                                                             │
│  ℹ  These hours are in the employee's local timezone.       │
│     Night shifts: set start > end (e.g. 22:00 – 06:00).    │
│                                                             │
│  ⚠  Changing these hours does NOT retroactively modify      │
│     existing idle records — only new ones going forward.    │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Time Input Component

Use native `<input type="time">` for consistent cross-browser support:

```jsx
<div className="time-range-group">
  <div className="time-input-wrapper">
    <label>Start Time</label>
    <input
      type="time"
      value={settings.workHoursStart}
      onChange={(e) => handleChange('workHoursStart', e.target.value)}
      className="time-input"
    />
  </div>
  <span className="time-separator">to</span>
  <div className="time-input-wrapper">
    <label>End Time</label>
    <input
      type="time"
      value={settings.workHoursEnd}
      onChange={(e) => handleChange('workHoursEnd', e.target.value)}
      className="time-input"
    />
  </div>
</div>
```

### 6.4 Work Days Checkboxes

```jsx
const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

<div className="work-days-group">
  <label>Work Days</label>
  <div className="day-checkboxes">
    {WEEKDAYS.map(day => (
      <label key={day.value} className="day-checkbox">
        <input
          type="checkbox"
          checked={settings.workDays.includes(day.value)}
          onChange={() => {
            const newDays = settings.workDays.includes(day.value)
              ? settings.workDays.filter(d => d !== day.value)
              : [...settings.workDays, day.value].sort();
            handleChange('workDays', newDays);
          }}
        />
        <span>{day.label}</span>
      </label>
    ))}
  </div>
</div>
```

### 6.5 CSS Additions

**File**: `forge-app/static/main/src/shared/components/TimesheetSettings.css`

```css
/* Working Hours Section */
.time-range-group {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 16px;
}

.time-input-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-input-wrapper label {
  font-size: 12px;
  font-weight: 500;
  color: #6B778C;
}

.time-input {
  padding: 6px 10px;
  border: 1px solid #DFE1E6;
  border-radius: 4px;
  font-size: 14px;
  color: #172B4D;
  background: white;
  width: 130px;
}

.time-input:focus {
  border-color: #0052CC;
  outline: none;
  box-shadow: 0 0 0 2px rgba(0, 82, 204, 0.2);
}

.time-separator {
  font-size: 14px;
  color: #6B778C;
  padding-bottom: 8px;
}

.work-days-group {
  margin-top: 12px;
}

.work-days-group > label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #172B4D;
  margin-bottom: 8px;
}

.day-checkboxes {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.day-checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid #DFE1E6;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #42526E;
  background: white;
  user-select: none;
  transition: all 0.15s ease;
}

.day-checkbox:hover {
  border-color: #0052CC;
}

.day-checkbox input:checked + span {
  color: #0052CC;
  font-weight: 600;
}

.day-checkbox:has(input:checked) {
  border-color: #0052CC;
  background: #DEEBFF;
}

.day-checkbox input {
  display: none;
}
```

---

## 7. Desktop App Changes

**File**: `python-desktop-app/desktop_app.py`

### 7.1 Add Work Hours to Settings Fetch

In `fetch_tracking_settings()`, inside the `fetched_settings` dictionary (line ~6555):

```python
fetched_settings = {
    # ... existing fields ...
    'idle_threshold_seconds': _nvl(settings.get('idle_threshold_seconds'), 300),
    # NEW: Working hours
    'work_hours_start': _nvl(settings.get('work_hours_start'), '09:00:00'),
    'work_hours_end': _nvl(settings.get('work_hours_end'), '18:00:00'),
    'work_days': _nvl(settings.get('work_days'), [1, 2, 3, 4, 5]),
}
```

### 7.2 Add Work Hours Check to `_create_idle_record()`

Before queuing an idle record, check if the idle period falls within work hours:

```python
def _is_within_work_hours(self, dt_utc):
    """Check if a UTC datetime falls within configured work hours (in user's local time)."""
    try:
        import zoneinfo
        local_tz_name = get_local_timezone_name()
        local_tz = zoneinfo.ZoneInfo(local_tz_name)
        local_dt = dt_utc.astimezone(local_tz)
    except Exception:
        # Fallback: use system local time
        local_dt = dt_utc.astimezone()

    # Check if it's a work day (ISO: 1=Mon..7=Sun = Python's isoweekday())
    work_days = self.tracking_settings.get('work_days', [1, 2, 3, 4, 5])
    if local_dt.isoweekday() not in work_days:
        return False

    # Parse work hours
    start_str = self.tracking_settings.get('work_hours_start', '09:00:00')
    end_str = self.tracking_settings.get('work_hours_end', '18:00:00')
    
    from datetime import time as dt_time
    def parse_time(s):
        parts = s.split(':')
        return dt_time(int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else 0)
    
    work_start = parse_time(start_str)
    work_end = parse_time(end_str)
    current_time = local_dt.time()

    # Handle cross-midnight shifts (e.g., 22:00 – 06:00)
    if work_start > work_end:
        return current_time >= work_start or current_time <= work_end
    else:
        return work_start <= current_time <= work_end
```

### 7.3 Update `_create_idle_record()` to Use Work Hours Filter

In the existing `_create_idle_record()` method, add the work hours check at the top:

```python
def _create_idle_record(self, reason="idle timeout"):
    """Create an idle record from idle_start_time to now and queue it for upload."""
    if self.idle_start_time is None:
        return
    idle_end = datetime.now(timezone.utc)
    idle_duration = int((idle_end - self.idle_start_time).total_seconds())
    if idle_duration < 60:
        self.idle_start_time = None
        return

    # NEW: Skip idle records outside work hours
    if not self._is_within_work_hours(self.idle_start_time):
        print(f"[IDLE] Skipping idle record — outside work hours ({self.idle_start_time.strftime('%H:%M')} UTC)")
        self.idle_start_time = None
        return

    # ... rest of existing method (create record, append to pending) ...
```

### 7.4 How It Integrates

```
 Tracking Loop (every 2-5s)
       │
       ├── idle_duration > threshold?
       │     └── Yes → set self.idle_start_time, enter idle
       │
       ├── needs_idle_resume?
       │     └── Yes → _create_idle_record("idle timeout")
       │              └── _is_within_work_hours(idle_start_time)?
       │                    ├── No  → skip (print log, clear state)
       │                    └── Yes → queue record in _pending_idle_records
       │
       └── upload_activity_batch (every 5 min)
             └── includes pending idle records in batch INSERT
```

---

## 8. Forge Timeline Service Changes

**File**: `forge-app/src/services/analytics/teamAnalyticsService.js`

### 8.1 Fetch Work Hours Along with Timeline Data

In both `fetchTeamDayTimeline()` and `fetchMyDayTimeline()`, after getting the organization, fetch the tracking settings to get work hours:

```javascript
// Fetch tracking settings to get work hours for idle filtering
const trackingSettingsResult = await supabaseRequest(
  supabaseConfig,
  `tracking_settings?organization_id=eq.${organization.id}&project_key=is.null&select=work_hours_start,work_hours_end,work_days&limit=1`
);
const workHoursConfig = trackingSettingsResult?.[0] || {
  work_hours_start: '09:00:00',
  work_hours_end: '18:00:00',
  work_days: [1, 2, 3, 4, 5]
};
```

### 8.2 Filter Idle Blocks by Work Hours

Add a helper function:

```javascript
/**
 * Filter idle blocks to only include those within work hours.
 * @param {Array} idleBlocks - Raw idle blocks with startTime/endTime
 * @param {Object} workHoursConfig - { work_hours_start, work_hours_end, work_days }
 * @param {string} date - Date string YYYY-MM-DD
 * @returns {Array} Filtered idle blocks
 */
function filterIdleBlocksByWorkHours(idleBlocks, workHoursConfig, date) {
  if (!idleBlocks || idleBlocks.length === 0) return [];

  const { work_hours_start, work_hours_end, work_days } = workHoursConfig;
  
  // Check if the target date is a work day
  const targetDate = new Date(`${date}T12:00:00Z`); // noon to avoid timezone edge
  const dayOfWeek = targetDate.getUTCDay(); // 0=Sun..6=Sat
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek; // Convert to ISO: 1=Mon..7=Sun
  
  if (!work_days.includes(isoDay)) {
    return []; // Not a work day — no idle blocks shown
  }

  // Parse work hours to minutes-from-midnight for comparison
  const parseTime = (str) => {
    const [h, m] = (str || '09:00:00').split(':').map(Number);
    return h * 60 + m;
  };
  const startMinutes = parseTime(work_hours_start);
  const endMinutes = parseTime(work_hours_end);
  const crossesMidnight = startMinutes > endMinutes;

  return idleBlocks.filter(block => {
    const blockStart = new Date(block.startTime || block.idle_start_time);
    const blockMinutes = blockStart.getUTCHours() * 60 + blockStart.getUTCMinutes();
    // Note: For accurate local-time filtering, the user's timezone should be
    // applied. Since the desktop app already filters at creation time, this is
    // a secondary safety net. For V1, UTC comparison is acceptable.
    
    if (crossesMidnight) {
      return blockMinutes >= startMinutes || blockMinutes <= endMinutes;
    }
    return blockMinutes >= startMinutes && blockMinutes <= endMinutes;
  });
}
```

### 8.3 Apply Filter in Response Building

After separating idle blocks, apply the work-hours filter before returning:

```javascript
// In fetchMyDayTimeline, before returning:
const filteredIdleBlocks = filterIdleBlocksByWorkHours(idleBlocks, workHoursConfig, date);

return {
  date,
  userId,
  displayName,
  sessions,
  idleBlocks: filteredIdleBlocks,
  workHours: workHoursConfig, // Pass to frontend for timeline display
  totalHours,
  // ...
};
```

### 8.4 Include Work Hours in Response

Add `workHours` to both `fetchTeamDayTimeline` and `fetchMyDayTimeline` return values so the frontend can render work-hour boundary lines on the timeline:

```javascript
return {
  // ... existing fields ...
  workHours: {
    start: workHoursConfig.work_hours_start,
    end: workHoursConfig.work_hours_end,
    days: workHoursConfig.work_days
  }
};
```

---

## 9. Frontend DayView Changes

**File**: `forge-app/static/main/src/components/tabs/time-analytics/DayView.js`

### 9.1 Render Work-Hour Boundary Lines (Optional Visual Enhancement)

On the timeline ruler, show subtle vertical dotted lines at work-start and work-end:

```jsx
{/* Work hour boundary lines */}
{workHoursConfig && (
  <>
    <div
      className="work-hour-boundary start"
      style={{ left: `${timeToPercent(workStartDate)}%` }}
      title={`Work starts: ${workHoursConfig.start}`}
    />
    <div
      className="work-hour-boundary end"
      style={{ left: `${timeToPercent(workEndDate)}%` }}
      title={`Work ends: ${workHoursConfig.end}`}
    />
  </>
)}
```

```css
.work-hour-boundary {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  border-left: 2px dashed #DFE1E6;
  z-index: 0;
  pointer-events: none;
}

.work-hour-boundary.start {
  border-color: #36B37E;
}

.work-hour-boundary.end {
  border-color: #FF5630;
}
```

### 9.2 No Frontend Idle Filtering Needed

Since both the desktop app (at creation time) and the backend service (at query time) filter idle blocks by work hours, the frontend receives only work-hour idle blocks. No additional filtering needed in DayView.

---

## 10. Data Flow Summary

```
Step 1: Admin configures working hours in Timesheet Settings
        ────────────────────────────────────────────────────
        TimesheetSettings.js
          → invoke('saveTrackingSettings', {
              workHoursStart: '09:00',
              workHoursEnd: '18:00',
              workDays: [1,2,3,4,5]
            })
          → settingsResolvers.js → settingsService.js
          → INSERT/PATCH tracking_settings
               work_hours_start = '09:00:00'
               work_hours_end = '18:00:00'
               work_days = '{1,2,3,4,5}'

Step 2: Desktop app fetches settings (every 5 min)
        ────────────────────────────────────────────
        fetch_tracking_settings()
          → SELECT * FROM tracking_settings WHERE org_id = ? AND project_key = ?
          → self.tracking_settings['work_hours_start'] = '09:00:00'
          → self.tracking_settings['work_hours_end'] = '18:00:00'
          → self.tracking_settings['work_days'] = [1,2,3,4,5]

Step 3: User goes idle at 20:30 (outside work hours)
        ─────────────────────────────────────────────
        _create_idle_record("idle timeout")
          → _is_within_work_hours(idle_start_time) → False
          → SKIP — no record created
          → Print: "[IDLE] Skipping — outside work hours"

Step 4: User goes idle at 11:45 (within work hours)
        ────────────────────────────────────────────
        _create_idle_record("idle timeout")
          → _is_within_work_hours(idle_start_time) → True
          → Record queued in _pending_idle_records
          → Uploaded in next batch to activity_records (is_idle=true)

Step 5: Timeline loads in Forge UI
        ──────────────────────────
        fetchMyDayTimeline(date)
          → Fetch tracking_settings for work hours
          → Fetch activity_records (includig idle)
          → filterIdleBlocksByWorkHours(idleBlocks, workHoursConfig)
          → Return filtered idle blocks + workHours config

Step 6: DayView renders
        ────────────────
        — Work blocks: green solid bars
        — Idle blocks: amber striped bars (only within work hours)
        — Work-hour boundaries: dashed lines at 9:00 and 18:00
```

---

## 11. Edge Cases

| Scenario | Behavior |
|----------|----------|
| **No work hours configured** (NULL columns) | Default to 09:00–18:00 Mon–Fri |
| **Night shift** (start > end, e.g., 22:00–06:00) | Cross-midnight logic: idle is captured if `time >= 22:00 OR time <= 06:00` |
| **Weekend idle** (Sat/Sun with default work_days) | Skipped — `isoweekday()` not in `[1,2,3,4,5]` |
| **Project overrides org** | A project with `work_hours_start=10:00` overrides the org default of `09:00` |
| **Idle spans work-hour boundary** | e.g., idle starts at 17:30, user resumes at 19:00. The idle record starts within work hours → is captured. The block extends past 18:00 on the timeline (acceptable — partial-overlap is shown). |
| **Admin changes hours midday** | Desktop app picks up new settings within 5 minutes. New idle records use new hours. Existing records are NOT retroactively changed. |
| **Timezone handling** | Desktop app converts UTC idle_start_time to user's local timezone (via `zoneinfo`) before comparing to work hours. Backend uses UTC approximation for V1. |

---

## 12. Testing Plan

### 12.1 Unit Tests

| Test | Location | Description |
|------|----------|-------------|
| `_is_within_work_hours()` — standard hours | Desktop app | 10:30 within 09:00–18:00 → True |
| `_is_within_work_hours()` — outside hours | Desktop app | 20:30 within 09:00–18:00 → False |
| `_is_within_work_hours()` — night shift | Desktop app | 23:00 within 22:00–06:00 → True |
| `_is_within_work_hours()` — night shift boundary | Desktop app | 07:00 within 22:00–06:00 → False |
| `_is_within_work_hours()` — weekend | Desktop app | Monday hours on Saturday → False |
| `filterIdleBlocksByWorkHours()` — filters correctly | teamAnalyticsService | 3 idle blocks, 1 outside → returns 2 |
| `transformSettingsToApiFormat()` — includes work hours | settingsService | Verify `workHoursStart`, `workHoursEnd`, `workDays` in output |
| `saveTrackingSettings()` — persists work hours | settingsService | Saves `work_hours_start`, `work_hours_end`, `work_days` to DB |

### 12.2 Playwright E2E Tests

| Test | Description |
|------|-------------|
| Settings UI renders time inputs | Verify `<input type="time">` elements appear |
| Settings UI renders day checkboxes | Verify 7 day checkboxes with Mon–Fri checked by default |
| Save persists work hours | Save → reload → values preserved |
| Changing days toggle updates state | Uncheck Wednesday → save → reload → Wednesday unchecked |
| Night shift saves correctly | Set 22:00–06:00 → save → reload → values correct |
| Timeline shows only work-hour idle blocks | Seed idle at 3am and 10am → only 10am block visible |
| Work-hour boundary lines appear | Verify `.work-hour-boundary.start` and `.end` elements exist |

---

## 13. Security Considerations

| Risk | Mitigation |
|------|------------|
| **Non-admin changes work hours** | `saveTrackingSettings` already checks `isJiraAdmin()` or `isProjectAdmin` — no change needed |
| **SQL injection via time string** | Parameterized queries via Supabase client. TIME column type rejects malformed input |
| **Invalid work_days array** | Validation in `validateTrackingSettings()` checks each value is 1–7 |
| **XSS via time input** | Native `<input type="time">` constrains values. No innerHTML usage |

---

## 14. Rollback Plan

1. **Migration**: `ALTER TABLE tracking_settings DROP COLUMN work_hours_start, DROP COLUMN work_hours_end, DROP COLUMN work_days;`
2. **Desktop app**: Remove `_is_within_work_hours()` check from `_create_idle_record()` — idle records will be created regardless of time.
3. **Backend**: Remove `filterIdleBlocksByWorkHours()` call — all idle blocks returned unfiltered.
4. **Frontend**: Remove working hours section from TimesheetSettings.js. Remove boundary lines from DayView.
5. **Constants**: Remove `workHoursStart`, `workHoursEnd`, `workDays` from `DEFAULT_TRACKING_SETTINGS`.

All changes are additive (new columns, new fields, new UI section). No existing functionality is modified. Rollback is safe.

---

## 15. Implementation Order

| Step | File(s) | Effort |
|------|---------|--------|
| 1 | `supabase/migrations/20260326_add_work_hours_to_tracking_settings.sql` | Small |
| 2 | `forge-app/src/config/constants.js` | Trivial |
| 3 | `forge-app/src/services/settingsService.js` (transform + save + validate) | Small |
| 4 | `forge-app/static/main/src/shared/components/TimesheetSettings.js` + CSS | Medium |
| 5 | `python-desktop-app/desktop_app.py` (fetch + filter) | Small |
| 6 | `forge-app/src/services/analytics/teamAnalyticsService.js` (filter + response) | Small |
| 7 | `forge-app/static/main/src/components/tabs/time-analytics/DayView.js` (boundary lines) | Small |
| 8 | Playwright tests | Medium |
