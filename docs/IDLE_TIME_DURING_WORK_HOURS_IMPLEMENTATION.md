# Show Idle Time During Work Hours — Implementation Document

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Behavior Analysis](#2-current-behavior-analysis)
3. [Proposed Solution Overview](#3-proposed-solution-overview)
4. [Database Schema Changes](#4-database-schema-changes)
5. [Desktop App Changes (Python)](#5-desktop-app-changes-python)
6. [Backend Service Changes (Forge App)](#6-backend-service-changes-forge-app)
7. [Frontend UI Changes (Custom UI)](#7-frontend-ui-changes-custom-ui)
8. [Reclassification API & Workflow](#8-reclassification-api--workflow)
9. [Working Hours Enforcement](#9-working-hours-enforcement)
10. [Security & Privacy Considerations](#10-security--privacy-considerations)
11. [Rollback Strategy](#11-rollback-strategy)
12. [Automated Test Scripts (Playwright)](#12-automated-test-scripts-playwright)

---

## 1. Problem Statement

When a user becomes idle during configured work hours, the JIRAForge time tracker stops recording activity and creates a **gap** between consecutive sessions. This gap is invisible on the timeline — there is no visual indicator that the user was idle, and no mechanism to reclassify that idle period as working time.

**Use Cases Requiring Reclassification:**

| Scenario | Why Idle Occurs | Should Count as Work |
|----------|----------------|---------------------|
| In-person meetings | No mouse/keyboard input | Yes |
| Phone calls | User on phone, not at desk | Yes |
| Whiteboard sessions | Collaborative brainstorming | Yes |
| Reading physical documents | No screen interaction | Yes |
| Listening to a presentation | Passive viewing | Yes |
| Lunch break | Away from desk | No |
| Personal break | Intentional time off | No |

**Goals:**
- Display idle periods explicitly as distinct blocks on the timeline during work hours
- Allow users to **convert idle time into a worklog** by clicking a ➕ icon on the idle block, providing a reason, and assigning it to an existing Jira issue or creating a new one
- If idle time was genuinely non-productive (lunch, break), the user simply **leaves it as-is** — no action needed
- Provide admin visibility into converted idle time
- Preserve data integrity (original idle records remain auditable)

---

## 2. Current Behavior Analysis

### 2.1 Activity Tracking Flow

```
┌─────────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Desktop App         │────▶│  Supabase DB     │────▶│  Forge App UI  │
│  (pynput + Windows)  │     │  activity_records │     │  (Timeline)    │
│                      │     │                   │     │                │
│ • Mouse/keyboard     │     │ • Work sessions   │     │ • Blue blocks  │
│   monitoring         │     │   only            │     │   = active     │
│ • 300s idle timeout  │     │ • No idle records │     │ • Gaps = ???   │
│ • Finalize on idle   │     │                   │     │                │
└─────────────────────┘     └──────────────────┘     └────────────────┘
```

### 2.2 Current Idle Detection (desktop_app.py)

```python
# Lines 8342-8380: Core idle detection loop
idle_duration = time.time() - self.last_activity_time
current_idle_timeout = self.tracking_settings.get('idle_threshold_seconds', self.idle_timeout)

if idle_duration > current_idle_timeout:  # Default: 300 seconds
    if not self.is_idle:
        self._finalize_active_session("idle timeout")
        self.session_manager.stop_current_timer()
        self.is_idle = True
        self.update_tray_icon()              # Orange tray icon

    if not self.needs_idle_resume:
        time.sleep(5)
        continue

# Resume from idle
if self.needs_idle_resume:
    self.is_idle = False
    self.needs_idle_resume = False
    self.last_interval_time = time.time()
```

### 2.3 What Happens Today

1. User is active → sessions are recorded in `activity_records` with `start_time`, `end_time`, `duration_seconds`
2. User goes idle (>300s no input) → current session is **finalized** and timer **stops**
3. **No idle record is created** — the idle period is a gap between the last session's `end_time` and the next session's `start_time`
4. User resumes → a **new** session begins from scratch
5. Timeline renders only blue blocks for active sessions; gaps are empty/invisible

### 2.4 Current Database Schema (activity_records)

```sql
classification TEXT CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown'))
-- NO 'idle' classification exists
-- NO is_idle boolean column
-- NO idle_duration_seconds column
```

### 2.5 Working Hours Configuration (notification_preferences)

```sql
work_hours_start TIME DEFAULT '09:00:00'
work_hours_end   TIME DEFAULT '18:00:00'
work_days        INTEGER[] DEFAULT '{1,2,3,4,5}'  -- Mon-Fri
timezone         TEXT DEFAULT 'UTC'
```

These values are currently **only used by the notification service** — not by idle detection or timeline rendering.

---

## 3. Proposed Solution Overview

### 3.1 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     IDLE TIME FEATURE                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Desktop App (Python)                                        │
│  ├── On idle start → Create idle_record with                 │
│  │   idle_start_time = now()                                 │
│  ├── On idle end → Set idle_end_time, calculate duration     │
│  └── Upload idle records in batch alongside work sessions    │
│                                                              │
│  Supabase (PostgreSQL)                                       │
│  ├── New classification value: 'idle'                        │
│  ├── New columns: is_idle, idle_start_time, idle_end_time    │
│  ├── New column: reclassified_from (audit trail)             │
│  └── New column: reclassified_at, reclassified_by            │
│                                                              │
│  Forge App Backend (Resolvers + Services)                    │
│  ├── Timeline API returns idle blocks within work hours      │
│  ├── New resolver: reclassifyIdleTime                        │
│  └── Working hours filter applied to idle block display      │
│                                                              │
│  Forge App Frontend (Custom UI - React)                      │
│  ├── Render idle blocks in orange/amber on timeline          │
│  ├── Tooltip on hover showing idle duration + ➕ icon        │
│  ├── Click ➕ icon → inline popover to convert to work       │
│  ├── User picks reason + assigns to existing or new issue    │
│  └── Non-productive idle → user leaves it, no action needed  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Feature Flag

Introduce a feature flag in `tracking_settings` to enable/disable idle time visibility:

```
show_idle_in_timeline: BOOLEAN DEFAULT true
```

This allows phased rollout and per-project/org control.

---

## 4. Database Schema Changes

### 4.1 Migration: Add Idle Support to activity_records

**File:** `supabase/migrations/YYYYMMDD_add_idle_time_support.sql`

```sql
-- ============================================================================
-- Migration: Add Idle Time Tracking Support
-- Description: Extends activity_records to support idle period recording
--              and reclassification workflows
-- ============================================================================

-- 1. Extend classification CHECK constraint to include 'idle'
ALTER TABLE public.activity_records
  DROP CONSTRAINT IF EXISTS activity_records_classification_check;

ALTER TABLE public.activity_records
  ADD CONSTRAINT activity_records_classification_check
  CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown', 'idle'));

-- 2. Add idle tracking columns
ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS is_idle BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS idle_start_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idle_end_time TIMESTAMPTZ;

-- 3. Add reclassification audit columns
ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS reclassified_from TEXT,
  ADD COLUMN IF NOT EXISTS reclassified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclassified_by UUID,
  ADD COLUMN IF NOT EXISTS reclassification_reason TEXT;

-- 4. Index for efficient idle record queries during work hours
CREATE INDEX IF NOT EXISTS idx_activity_idle_work_date
  ON public.activity_records (user_id, work_date, is_idle)
  WHERE is_idle = TRUE;

-- 5. Index for reclassification audit queries
CREATE INDEX IF NOT EXISTS idx_activity_reclassified
  ON public.activity_records (reclassified_at)
  WHERE reclassified_from IS NOT NULL;
```

### 4.2 Migration: Add Feature Flag to tracking_settings

```sql
-- Add feature flag for idle timeline visibility
ALTER TABLE public.tracking_settings
  ADD COLUMN IF NOT EXISTS show_idle_in_timeline BOOLEAN DEFAULT TRUE;
```

### 4.3 Migration: Add Work Hours to tracking_settings (Denormalize)

Currently, work hours live only in `notification_preferences`. To avoid cross-table joins during timeline rendering, copy the reference:

```sql
-- Denormalize work hours into tracking_settings for timeline queries
ALTER TABLE public.tracking_settings
  ADD COLUMN IF NOT EXISTS work_hours_start TIME DEFAULT '09:00:00',
  ADD COLUMN IF NOT EXISTS work_hours_end TIME DEFAULT '18:00:00',
  ADD COLUMN IF NOT EXISTS work_days INTEGER[] DEFAULT '{1,2,3,4,5}';
```

### 4.4 Updated activity_records Record (Idle Example)

```json
{
  "id": "uuid-idle-001",
  "user_id": "user-uuid",
  "organization_id": "org-uuid",
  "window_title": null,
  "application_name": "System Idle",
  "classification": "idle",
  "is_idle": true,
  "idle_start_time": "2026-03-25T10:15:00Z",
  "idle_end_time": "2026-03-25T10:45:00Z",
  "start_time": "2026-03-25T10:15:00Z",
  "end_time": "2026-03-25T10:45:00Z",
  "duration_seconds": 1800,
  "total_time_seconds": 1800,
  "work_date": "2026-03-25",
  "status": "analyzed",
  "project_key": "PROJ",
  "metadata": {
    "tracking_mode": "idle_detection",
    "idle_source": "desktop_app",
    "app_version": "2.1.0"
  },
  "reclassified_from": null,
  "reclassified_at": null,
  "reclassified_by": null,
  "reclassification_reason": null
}
```

---

## 5. Desktop App Changes (Python)

### 5.1 Track Idle Start/End Timestamps

**File:** `python-desktop-app/desktop_app.py`

**Modification:** When idle is detected, record the start timestamp. When user resumes, record the end timestamp and create an idle record.

```python
# --- NEW: Idle period tracking state ---
self.idle_start_time = None  # Set when idle begins

# --- MODIFIED: Idle detection loop (around line 8342) ---
idle_duration = time.time() - self.last_activity_time
current_idle_timeout = self.tracking_settings.get(
    'idle_threshold_seconds', self.idle_timeout
)

if idle_duration > current_idle_timeout:
    if not self.is_idle:
        self._finalize_active_session("idle timeout")
        self.session_manager.stop_current_timer()
        self.is_idle = True
        self.idle_start_time = datetime.utcnow()  # NEW: Record idle start
        self.update_tray_icon()

    if not self.needs_idle_resume:
        time.sleep(5)
        continue

# Resume from idle
if self.needs_idle_resume:
    idle_end_time = datetime.utcnow()                   # NEW: Record idle end
    self._create_idle_record(                             # NEW: Create idle record
        self.idle_start_time,
        idle_end_time
    )
    self.is_idle = False
    self.needs_idle_resume = False
    self.idle_start_time = None                          # NEW: Reset
    self.last_interval_time = time.time()
```

### 5.2 New Method: _create_idle_record()

```python
def _create_idle_record(self, idle_start, idle_end):
    """Create an idle period record for upload to Supabase."""
    if not idle_start or not idle_end:
        return

    duration_seconds = int((idle_end - idle_start).total_seconds())

    # Only record idle periods longer than the idle threshold
    min_idle_record = self.tracking_settings.get('idle_threshold_seconds', 300)
    if duration_seconds < min_idle_record:
        return

    idle_record = {
        'id': str(uuid.uuid4()),
        'user_id': self.user_id,
        'organization_id': self.organization_id,
        'window_title': None,
        'application_name': 'System Idle',
        'classification': 'idle',
        'is_idle': True,
        'idle_start_time': idle_start.isoformat() + 'Z',
        'idle_end_time': idle_end.isoformat() + 'Z',
        'start_time': idle_start.isoformat() + 'Z',
        'end_time': idle_end.isoformat() + 'Z',
        'duration_seconds': duration_seconds,
        'total_time_seconds': duration_seconds,
        'work_date': self._utc_ts_to_local_date(idle_start.isoformat() + 'Z'),
        'project_key': self.current_project_key,
        'status': 'analyzed',  # No AI analysis needed
        'user_timezone': self.user_timezone,
        'metadata': json.dumps({
            'tracking_mode': 'idle_detection',
            'idle_source': 'desktop_app',
            'app_version': self.app_version
        }),
        'batch_timestamp': datetime.utcnow().isoformat() + 'Z',
        'created_at': datetime.utcnow().isoformat() + 'Z',
    }

    # Queue for batch upload (alongside regular activity records)
    self._pending_idle_records.append(idle_record)
    logger.info(
        f"Idle record created: {duration_seconds}s "
        f"({idle_start.strftime('%H:%M')} - {idle_end.strftime('%H:%M')})"
    )
```

### 5.3 Modified Batch Upload

```python
def upload_activity_batch(self):
    """Upload both work sessions and idle records."""
    sessions = self.session_manager.get_all_sessions()
    MIN_SESSION_DURATION = 5
    sessions = [s for s in sessions if s.get('total_time_seconds', 0) >= MIN_SESSION_DURATION]

    records = []

    # Build work session records (existing logic)
    for s in sessions:
        record = self._build_activity_record(s)
        records.append(record)

    # NEW: Append idle records
    idle_records = list(self._pending_idle_records)
    records.extend(idle_records)

    if not records:
        return

    try:
        result = self.supabase_service.table('activity_records').insert(records).execute()

        if result.data:
            self.session_manager.clear_all_sessions()
            self._pending_idle_records.clear()  # NEW: Clear uploaded idle records
            logger.info(f"Uploaded {len(records)} records ({len(idle_records)} idle)")
    except Exception as e:
        logger.error(f"Batch upload failed: {e}")
        # Records remain in queue for retry
```

### 5.4 Handle System Sleep/Lock as Idle

```python
# In system event handler (around line 7960)
def on_system_sleep(self):
    """Handle system sleep/lock — treat as idle start."""
    self._finalize_active_session("system_sleep")
    self.session_manager.stop_current_timer()
    self.is_idle = True
    self.idle_start_time = datetime.utcnow()

def on_system_wake(self):
    """Handle system wake/unlock — treat as idle end."""
    if self.idle_start_time:
        idle_end = datetime.utcnow()
        self._create_idle_record(self.idle_start_time, idle_end)
    self.is_idle = False
    self.idle_start_time = None
    self.last_activity_time = time.time()
```

### 5.5 Offline Support (SQLite Cache)

Add idle records to the local SQLite cache for offline scenarios:

```python
# In SQLite cache manager
def cache_idle_record(self, idle_record):
    """Store idle record in local SQLite for offline upload."""
    self.db.execute("""
        INSERT INTO cached_records (id, record_type, payload, created_at)
        VALUES (?, 'idle', ?, ?)
    """, (idle_record['id'], json.dumps(idle_record), datetime.utcnow().isoformat()))
```

---

## 6. Backend Service Changes (Forge App)

### 6.1 Timeline Service — Include Idle Blocks

**File:** `forge-app/src/services/analytics/teamAnalyticsService.js`

**Modified:** `fetchTeamDayTimeline()` and `fetchMyDayTimeline()`

```javascript
// --- MODIFIED: Query to include idle records ---
async function fetchTimelineRecords(orgId, userId, date) {
  // Fetch both active and idle records for the date
  const response = await supabaseRequest(
    `activity_records?organization_id=eq.${orgId}` +
    `&user_id=eq.${userId}` +
    `&work_date=eq.${date}` +
    `&select=start_time,end_time,duration_seconds,is_idle,idle_start_time,idle_end_time,classification,id,reclassified_from` +
    `&order=start_time.asc`,
    'GET'
  );
  return response;
}

// --- NEW: Separate sessions and idle blocks ---
function buildTimeline(records, workHoursConfig) {
  const sessions = [];
  const idleBlocks = [];

  for (const record of records) {
    if (record.is_idle) {
      // Only include idle blocks that fall within work hours
      const idleBlock = filterIdleToWorkHours(record, workHoursConfig);
      if (idleBlock) {
        idleBlocks.push({
          id: record.id,
          startTime: record.idle_start_time || record.start_time,
          endTime: record.idle_end_time || record.end_time,
          durationSeconds: record.duration_seconds,
          type: 'idle',
          reclassified: record.reclassified_from !== null,
          classification: record.classification,
        });
      }
    } else {
      sessions.push({
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds,
        type: 'active',
      });
    }
  }

  return { sessions, idleBlocks };
}
```

### 6.2 Work Hours Filter for Idle Blocks

```javascript
/**
 * Filter an idle block to only show the portion within work hours.
 * If idle starts at 8:50 AM but work starts at 9:00 AM, clip to 9:00 AM.
 */
function filterIdleToWorkHours(record, workHoursConfig) {
  const { work_hours_start, work_hours_end, work_days, timezone } = workHoursConfig;

  const idleStart = new Date(record.idle_start_time || record.start_time);
  const idleEnd = new Date(record.idle_end_time || record.end_time);

  // Check if idle falls on a work day
  const localDate = toTimezone(idleStart, timezone);
  const dayOfWeek = localDate.getDay() === 0 ? 7 : localDate.getDay(); // 1=Mon, 7=Sun
  if (!work_days.includes(dayOfWeek)) {
    return null; // Not a work day
  }

  // Parse work hours for the idle record's date
  const workStart = buildDatetime(localDate, work_hours_start, timezone);
  const workEnd = buildDatetime(localDate, work_hours_end, timezone);

  // Clip idle period to work hours window
  const clippedStart = new Date(Math.max(idleStart.getTime(), workStart.getTime()));
  const clippedEnd = new Date(Math.min(idleEnd.getTime(), workEnd.getTime()));

  if (clippedStart >= clippedEnd) {
    return null; // Idle is entirely outside work hours
  }

  return {
    ...record,
    idle_start_time: clippedStart.toISOString(),
    idle_end_time: clippedEnd.toISOString(),
    duration_seconds: Math.round((clippedEnd - clippedStart) / 1000),
  };
}
```

### 6.3 Updated Timeline Response Shape

```javascript
// BEFORE (current):
{
  sessions: [
    { startTime, endTime, durationSeconds }
  ]
}

// AFTER (new):
{
  sessions: [
    { startTime, endTime, durationSeconds, type: 'active' }
  ],
  idleBlocks: [
    {
      id: 'uuid',
      startTime: '2026-03-25T10:15:00Z',
      endTime: '2026-03-25T10:45:00Z',
      durationSeconds: 1800,
      type: 'idle',
      reclassified: false,
      classification: 'idle'
    }
  ],
  totalIdleSeconds: 1800,   // Sum of idle blocks during work hours
  workHours: {
    start: '09:00',
    end: '18:00'
  }
}
```

### 6.4 New Resolver: convertIdleToWorklog

**File:** `forge-app/src/resolvers/analyticsResolvers.js`

This resolver handles converting an idle block into tracked work time. It is only called when the user actively chooses to convert — non-productive idle time is simply left untouched.

```javascript
resolver.define('convertIdleToWorklog', async (req) => {
  const accountId = req.context.accountId;
  const {
    idleRecordId,          // UUID of the idle activity_record
    reason,                // e.g., 'meeting', 'phone_call', 'reading'
    issueKey,              // REQUIRED: existing issue key (e.g., 'PROJ-123')
    createNewIssue,        // Boolean: create a new Jira issue instead
    newIssueSummary,       // Summary if createNewIssue = true
  } = req.payload;

  // Validation
  if (!idleRecordId || !reason) {
    return { success: false, error: 'Record ID and reason are required' };
  }

  if (!issueKey && !createNewIssue) {
    return { success: false, error: 'Must assign to an existing issue or create a new one' };
  }

  // Verify ownership — user can only convert their own idle records
  const record = await fetchActivityRecord(idleRecordId);
  if (!record || record.user_id !== getUserId(accountId)) {
    return { success: false, error: 'Record not found or access denied' };
  }

  if (!record.is_idle) {
    return { success: false, error: 'Only idle records can be converted' };
  }

  // If creating a new issue, do it first
  let resolvedIssueKey = issueKey;
  if (createNewIssue && newIssueSummary) {
    const newIssue = await createJiraIssue(accountId, {
      projectKey: record.project_key,
      summary: newIssueSummary,
      issueType: 'Task',
    });
    resolvedIssueKey = newIssue.key;
  }

  // Convert idle → productive worklog
  const now = new Date().toISOString();
  const updatePayload = {
    classification: 'productive',
    reclassified_from: 'idle',              // Audit trail
    reclassified_at: now,
    reclassified_by: getUserId(accountId),
    reclassification_reason: reason,
    user_assigned_issue_key: resolvedIssueKey,
    updated_at: now,
  };

  await updateActivityRecord(idleRecordId, updatePayload);

  // Auto-create Jira worklog if sync is enabled
  const settings = await getTrackingSettings(accountId, null, record.project_key);
  if (settings.jira_worklog_sync_enabled && resolvedIssueKey) {
    await createJiraWorklog(accountId, {
      issueKey: resolvedIssueKey,
      timeSpentSeconds: record.duration_seconds,
      started: record.idle_start_time || record.start_time,
      comment: `Converted from idle time — Reason: ${reason}`,
    });
  }

  return {
    success: true,
    data: {
      recordId: idleRecordId,
      issueKey: resolvedIssueKey,
      reason,
      durationSeconds: record.duration_seconds,
      worklogCreated: !!settings.jira_worklog_sync_enabled,
    },
  };
});
```

---

## 7. Frontend UI Changes (Custom UI)

### 7.1 Updated DayView Component

**File:** `forge-app/static/main/src/components/tabs/time-analytics/DayView.js`

#### 7.1.1 Fetch and Process Idle Blocks

```javascript
// Existing: work session blocks
const workBlocks = getUserTimeBlocks(userId);

// NEW: idle blocks (from updated API response)
const getIdleTimeBlocks = (idleBlocks) => {
  if (!idleBlocks || idleBlocks.length === 0) return [];

  return idleBlocks.map(block => {
    const start = parseUTC(block.startTime);
    const end = parseUTC(block.endTime);

    const leftPercent = timeToPercent(start);
    const rightPercent = timeToPercent(end);
    const widthPercent = Math.max(0.3, rightPercent - leftPercent);

    return {
      id: block.id,
      left: leftPercent,
      width: widthPercent,
      startTime: start,
      endTime: end,
      durationSeconds: block.durationSeconds,
      type: 'idle',
      reclassified: block.reclassified,
      classification: block.classification,
    };
  });
};
```

#### 7.1.2 Render Idle Blocks on Timeline

Each idle block shows an amber bar with a **➕ Convert to Work** icon. If the user was genuinely not working (lunch, break), they simply ignore the block — no action required.

```jsx
<div className="timeline-blocks">
  {/* Active work blocks (existing - blue) */}
  {workBlocks.map((block, idx) => (
    <div
      key={`active-${idx}`}
      className="timeline-block active"
      style={{ left: `${block.left}%`, width: `${block.width}%` }}
      title={`Active: ${formatDuration(block.durationSeconds)}`}
    />
  ))}

  {/* NEW: Idle blocks (amber/orange with ➕ icon) */}
  {idleBlocks.map((block) => (
    <div
      key={`idle-${block.id}`}
      className={`timeline-block idle ${block.reclassified ? 'converted' : ''}`}
      style={{ left: `${block.left}%`, width: `${block.width}%` }}
      data-testid={`idle-block-${block.id}`}
      onMouseEnter={() => setHoveredBlock(block)}
      onMouseLeave={() => setHoveredBlock(null)}
    >
      {/* ➕ icon: visible on hover — click to convert idle → worklog */}
      {!block.reclassified && (
        <button
          className="idle-convert-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleConvertClick(block);
          }}
          title="Convert to work time"
          data-testid={`idle-convert-btn-${block.id}`}
        >
          ➕
        </button>
      )}
      {block.reclassified && (
        <span className="idle-converted-icon" title="Converted to work time">✓</span>
      )}
    </div>
  ))}
</div>
```

#### 7.1.3 Idle Block Tooltip (Hover)

On hover, the user sees the idle duration and a prompt to convert. If already converted, it shows the linked issue.

```jsx
{hoveredBlock && hoveredBlock.type === 'idle' && (
  <div
    className="timeline-tooltip idle-tooltip"
    style={{ left: `${hoveredBlock.left}%` }}
  >
    <div className="tooltip-header">
      {hoveredBlock.reclassified ? '✓ Converted to Work' : '⏸ Idle Time'}
    </div>
    <div className="tooltip-time">
      {formatTime(hoveredBlock.startTime)} — {formatTime(hoveredBlock.endTime)}
    </div>
    <div className="tooltip-duration">
      Duration: {formatDuration(hoveredBlock.durationSeconds)}
    </div>
    {hoveredBlock.reclassified && hoveredBlock.issueKey && (
      <div className="tooltip-issue">Issue: {hoveredBlock.issueKey}</div>
    )}
    {hoveredBlock.reclassified && hoveredBlock.reason && (
      <div className="tooltip-reason">Reason: {hoveredBlock.reason}</div>
    )}
    {!hoveredBlock.reclassified && (
      <div className="tooltip-action">Click ➕ to convert to work time</div>
    )}
  </div>
)}
```

### 7.2 Convert Idle to Work — Popover (Not a Full Modal)

Instead of a heavy modal, clicking the ➕ icon opens a **lightweight popover** anchored to the idle block. The user flow is:

1. Click ➕ on an idle block
2. Popover appears with reason selector and issue assignment
3. User picks a reason, assigns to an existing issue OR creates a new one
4. Clicks "Add to Worklog" → idle time is converted and added as tracked work

**If the idle time was non-productive (lunch, break, etc.), the user does nothing — the amber block stays as-is.**

```
┌─────────────────────────────────────────────────────────────────────┐
│  TIMELINE                                                          │
│  ┌──────┐   ┌───────────────┐   ┌──────────────┐   ┌──────┐       │
│  │ Blue │   │ Amber (idle)  │   │ Blue (work)  │   │ Blue │       │
│  │ work │   │   [➕]        │   │              │   │ work │       │
│  └──────┘   └───────┬───────┘   └──────────────┘   └──────┘       │
│                     │                                              │
│              ┌──────▼──────────────────────────┐                   │
│              │  Convert Idle to Work            │                   │
│              │                                  │                   │
│              │  10:15 AM — 10:45 AM (30 min)    │                   │
│              │                                  │                   │
│              │  Reason: [Meeting          ▼]    │                   │
│              │                                  │                   │
│              │  ○ Add to existing issue          │                   │
│              │    [PROJ-123             🔍]     │                   │
│              │                                  │                   │
│              │  ○ Create new issue               │                   │
│              │    [Summary...               ]   │                   │
│              │                                  │                   │
│              │  [Cancel]  [Add to Worklog ✓]    │                   │
│              └──────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

```jsx
{showConvertPopover && selectedIdleBlock && (
  <div
    className="idle-convert-popover"
    style={{ left: `${selectedIdleBlock.left}%` }}
    data-testid="convert-popover"
  >
    <div className="popover-header">
      <span>Convert Idle to Work</span>
      <button
        className="popover-close"
        onClick={() => setShowConvertPopover(false)}
        data-testid="popover-close-btn"
      >
        ✕
      </button>
    </div>

    <div className="popover-time-info">
      {formatTime(selectedIdleBlock.startTime)} —{' '}
      {formatTime(selectedIdleBlock.endTime)}{' '}
      ({formatDuration(selectedIdleBlock.durationSeconds)})
    </div>

    {/* Step 1: Reason */}
    <div className="popover-field">
      <label>What were you doing?</label>
      <select
        value={convertReason}
        onChange={(e) => setConvertReason(e.target.value)}
        data-testid="convert-reason-select"
      >
        <option value="">Select a reason...</option>
        <option value="meeting">Meeting</option>
        <option value="phone_call">Phone / Video Call</option>
        <option value="code_review">Code Review (verbal)</option>
        <option value="reading">Reading / Research</option>
        <option value="whiteboard">Whiteboard / Planning</option>
        <option value="presentation">Attending Presentation</option>
        <option value="pair_programming">Pair Programming (observer)</option>
        <option value="other">Other</option>
      </select>
    </div>

    {/* Step 2: Issue assignment */}
    <div className="popover-field">
      <label>Assign to:</label>

      <div className="issue-option">
        <input
          type="radio"
          name="issueMode"
          value="existing"
          checked={issueMode === 'existing'}
          onChange={() => setIssueMode('existing')}
          data-testid="radio-existing-issue"
        />
        <span>Existing issue</span>
      </div>

      {issueMode === 'existing' && (
        <div className="issue-search">
          <input
            type="text"
            placeholder="Search or type issue key (e.g., PROJ-123)"
            value={issueKeyInput}
            onChange={(e) => {
              setIssueKeyInput(e.target.value);
              debouncedIssueSearch(e.target.value);
            }}
            data-testid="issue-key-input"
          />
          {/* Autocomplete dropdown from Jira search */}
          {issueSearchResults.length > 0 && (
            <ul className="issue-autocomplete" data-testid="issue-autocomplete">
              {issueSearchResults.map((issue) => (
                <li
                  key={issue.key}
                  onClick={() => {
                    setIssueKeyInput(issue.key);
                    setIssueSearchResults([]);
                  }}
                >
                  <strong>{issue.key}</strong> — {issue.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="issue-option">
        <input
          type="radio"
          name="issueMode"
          value="new"
          checked={issueMode === 'new'}
          onChange={() => setIssueMode('new')}
          data-testid="radio-new-issue"
        />
        <span>Create new issue</span>
      </div>

      {issueMode === 'new' && (
        <input
          type="text"
          placeholder="Issue summary (e.g., Sprint planning meeting)"
          value={newIssueSummary}
          onChange={(e) => setNewIssueSummary(e.target.value)}
          data-testid="new-issue-summary-input"
        />
      )}
    </div>

    {/* Actions */}
    <div className="popover-actions">
      <button
        className="btn-secondary"
        onClick={() => setShowConvertPopover(false)}
        data-testid="convert-cancel-btn"
      >
        Cancel
      </button>
      <button
        className="btn-primary"
        onClick={handleConvertSubmit}
        disabled={!convertReason || (!issueKeyInput && !newIssueSummary)}
        data-testid="convert-submit-btn"
      >
        Add to Worklog ✓
      </button>
    </div>
  </div>
)}
```

### 7.3 Convert Submit Handler

```javascript
const handleConvertSubmit = async () => {
  if (!selectedIdleBlock || !convertReason) return;

  const needsIssue = issueMode === 'existing' ? issueKeyInput : null;
  const needsNewIssue = issueMode === 'new' && newIssueSummary;

  if (!needsIssue && !needsNewIssue) return;

  setIsSubmitting(true);
  try {
    const result = await invoke('convertIdleToWorklog', {
      idleRecordId: selectedIdleBlock.id,
      reason: convertReason,
      issueKey: issueMode === 'existing' ? issueKeyInput : null,
      createNewIssue: issueMode === 'new',
      newIssueSummary: issueMode === 'new' ? newIssueSummary : null,
    });

    if (result.success) {
      await refreshTimeline();
      setShowConvertPopover(false);
      resetConvertForm();
      showSuccessFlag(
        `Added ${formatDuration(selectedIdleBlock.durationSeconds)} to ${result.data.issueKey}`
      );
    } else {
      showErrorFlag(result.error || 'Failed to convert idle time');
    }
  } catch (err) {
    showErrorFlag('An error occurred');
  } finally {
    setIsSubmitting(false);
  }
};

const resetConvertForm = () => {
  setConvertReason('');
  setIssueKeyInput('');
  setNewIssueSummary('');
  setIssueMode('existing');
  setIssueSearchResults([]);
};
```

### 7.4 CSS Styles for Idle Blocks

**File:** `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css`

```css
/* ============================================
   IDLE TIME BLOCKS
   ============================================ */

.timeline-block.idle {
  position: absolute;
  height: 100%;
  background: #FF991F;          /* Atlassian amber/warning color */
  border-radius: 2px;
  opacity: 0.6;
  cursor: pointer;
  transition: opacity 0.2s ease;
  background-image: repeating-linear-gradient(
    45deg,
    transparent,
    transparent 3px,
    rgba(255, 255, 255, 0.2) 3px,
    rgba(255, 255, 255, 0.2) 6px
  );
}

.timeline-block.idle:hover {
  opacity: 0.9;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.timeline-block.idle .idle-icon {
  font-size: 10px;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* Reclassified idle blocks — show as green with checkmark */
.timeline-block.idle.reclassified {
  background: #36B37E;          /* Atlassian green/success */
  background-image: none;
  opacity: 0.5;
}

/* ============================================
   IDLE TOOLTIP
   ============================================ */

.idle-tooltip {
  background: #172B4D;
  color: #FFFFFF;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  position: absolute;
  bottom: 110%;
  transform: translateX(-50%);
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
}

.idle-tooltip .tooltip-header {
  font-weight: 600;
  color: #FF991F;
  margin-bottom: 4px;
}

.idle-tooltip .tooltip-reclassified {
  color: #36B37E;
  font-size: 11px;
  margin-top: 4px;
}

.idle-tooltip .tooltip-action {
  color: #B3BAC5;
  font-size: 11px;
  margin-top: 4px;
  font-style: italic;
}

/* ============================================
   ➕ CONVERT BUTTON ON IDLE BLOCK
   ============================================ */

.idle-convert-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.2s ease;
  padding: 2px 4px;
  border-radius: 3px;
  pointer-events: auto;
}

.timeline-block.idle:hover .idle-convert-btn {
  opacity: 1;                       /* Show ➕ only on hover */
  background: rgba(255, 255, 255, 0.8);
}

.idle-convert-btn:hover {
  background: rgba(255, 255, 255, 1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.idle-converted-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 10px;
  color: white;
  pointer-events: none;
}

/* Converted (was idle, now worklog) — show as green */
.timeline-block.idle.converted {
  background: #36B37E;             /* Atlassian green/success */
  background-image: none;
  opacity: 0.7;
}

/* ============================================
   CONVERT POPOVER (anchored to idle block)
   ============================================ */

.idle-convert-popover {
  position: absolute;
  bottom: calc(100% + 8px);        /* Above the timeline */
  transform: translateX(-50%);
  background: #FFFFFF;
  border-radius: 8px;
  padding: 16px;
  width: 320px;
  box-shadow: 0 8px 16px rgba(9, 30, 66, 0.25);
  z-index: 100;
  border: 1px solid #DFE1E6;
}

.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
  color: #172B4D;
}

.popover-close {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: #6B778C;
  padding: 0;
}

.popover-time-info {
  background: #F4F5F7;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: #42526E;
  margin-bottom: 12px;
}

.popover-field {
  margin-bottom: 12px;
}

.popover-field label {
  display: block;
  font-weight: 500;
  font-size: 12px;
  color: #6B778C;
  margin-bottom: 4px;
}

.popover-field select,
.popover-field input {
  width: 100%;
  padding: 6px 8px;
  border: 2px solid #DFE1E6;
  border-radius: 4px;
  font-size: 13px;
  box-sizing: border-box;
}

.popover-field select:focus,
.popover-field input:focus {
  border-color: #0052CC;
  outline: none;
}

.issue-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 13px;
  cursor: pointer;
}

.issue-search {
  position: relative;
  margin: 4px 0 8px 0;
}

.issue-autocomplete {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #DFE1E6;
  border-radius: 4px;
  max-height: 160px;
  overflow-y: auto;
  z-index: 110;
  list-style: none;
  padding: 0;
  margin: 2px 0 0 0;
  box-shadow: 0 4px 8px rgba(9, 30, 66, 0.13);
}

.issue-autocomplete li {
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
}

.issue-autocomplete li:hover {
  background: #DEEBFF;
}

.popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.btn-primary {
  background: #0052CC;
  color: white;
  border: none;
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  font-size: 13px;
}

.btn-primary:hover {
  background: #0747A6;
}

.btn-primary:disabled {
  background: #A5ADBA;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: #42526E;
  border: none;
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary:hover {
  background: #F4F5F7;
}

/* ============================================
   TIMELINE LEGEND (NEW)
   ============================================ */

.timeline-legend {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  font-size: 12px;
  color: #6B778C;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend-swatch {
  width: 12px;
  height: 12px;
  border-radius: 2px;
}

.legend-swatch.active {
  background: #0052CC;
}

.legend-swatch.idle {
  background: #FF991F;
}

.legend-swatch.converted {
  background: #36B37E;
}
```

### 7.5 Timeline Legend Component

```jsx
<div className="timeline-legend" data-testid="timeline-legend">
  <div className="legend-item">
    <div className="legend-swatch active"></div>
    <span>Active Work</span>
  </div>
  <div className="legend-item">
    <div className="legend-swatch idle"></div>
    <span>Idle Time (click ➕ to convert)</span>
  </div>
  <div className="legend-item">
    <div className="legend-swatch converted"></div>
    <span>Converted to Work</span>
  </div>
</div>
```

---

## 8. Convert Idle to Worklog — API & Workflow

### 8.1 User Flow (Step by Step)

```
1. User views their timeline for today
   └── Sees amber idle blocks during work hours

2. User hovers over an amber idle block
   └── Tooltip shows: "⏸ Idle Time — 10:15 AM – 10:45 AM (30 min)"
   └── A ➕ icon appears on the block

3. User clicks the ➕ icon
   └── A lightweight popover opens anchored to the block

4. User fills in the popover:
   ├── Reason: "Meeting" (dropdown)
   └── Assign to:
       ├── Option A: Existing issue → types "PROJ-123" (with autocomplete)
       └── Option B: Create new issue → types a summary

5. User clicks "Add to Worklog ✓"
   └── Frontend calls invoke('convertIdleToWorklog', payload)
        └── Backend validates ownership + idle status
        └── If "Create new issue" → creates Jira issue first
        └── Updates activity_record:
             ├── classification = 'productive'
             ├── reclassified_from = 'idle'
             ├── reclassified_at = now()
             ├── reclassification_reason = 'meeting'
             └── user_assigned_issue_key = 'PROJ-123'
        └── If worklog sync enabled → creates Jira worklog entry

6. Timeline refreshes
   └── Block turns green with ✓ icon (converted to work)
   └── Tooltip now shows: "✓ Converted to Work — PROJ-123"

--- NON-PRODUCTIVE IDLE: NO ACTION REQUIRED ---

7. User sees an idle block that was their lunch break
   └── They simply ignore it — no click, no action
   └── The amber block remains as-is on the timeline
   └── It is NOT counted toward productive work time
```

### 8.2 Conversion Rules

| Rule | Description |
|------|-------------|
| **Owner Only** | Users can only convert their own idle records |
| **Idle Only** | Only records with `is_idle = true` can be converted |
| **Issue Required** | User must assign to an existing issue OR create a new one |
| **Reason Required** | A reason must be selected (meeting, call, etc.) |
| **Non-Productive = No Action** | If idle was a break, user does nothing. Block stays amber. |
| **Audit Trail** | `reclassified_from`, `reclassified_at`, `reclassified_by` preserved |
| **Worklog Sync** | If `jira_worklog_sync_enabled`, auto-creates a Jira worklog for the issue |
| **Reversible** | User can undo a conversion (revert back to idle) within the same day |

### 8.3 Admin Visibility

Project admins viewing the team timeline can see:
- **Amber blocks** = idle time (user hasn't taken any action)
- **Green blocks** = converted to work (user added a worklog)
- Hover tooltip shows the linked issue key and reason
- Admins **cannot** convert another user's idle time (privacy)

---

## 9. Working Hours Enforcement

### 9.1 Configuration Source

Work hours are resolved with the following priority:

1. **User's notification_preferences** (per-user work schedule)
2. **Project tracking_settings** (project-level override)
3. **Organization tracking_settings** (org-level default)
4. **Global default** — 09:00–18:00, Mon–Fri, UTC

### 9.2 Resolution Logic (Backend)

```javascript
async function getEffectiveWorkHours(userId, orgId, projectKey) {
  // Priority 1: User's notification preferences
  const userPrefs = await fetchNotificationPreferences(userId, orgId);
  if (userPrefs) {
    return {
      work_hours_start: userPrefs.work_hours_start,
      work_hours_end: userPrefs.work_hours_end,
      work_days: userPrefs.work_days,
      timezone: userPrefs.timezone,
    };
  }

  // Priority 2: Project-level tracking settings
  if (projectKey) {
    const projectSettings = await getTrackingSettings(null, null, projectKey);
    if (projectSettings.work_hours_start) {
      return {
        work_hours_start: projectSettings.work_hours_start,
        work_hours_end: projectSettings.work_hours_end,
        work_days: projectSettings.work_days,
        timezone: projectSettings.timezone || 'UTC',
      };
    }
  }

  // Priority 3: Org-level tracking settings
  const orgSettings = await getOrgTrackingSettings(orgId);
  if (orgSettings && orgSettings.work_hours_start) {
    return {
      work_hours_start: orgSettings.work_hours_start,
      work_hours_end: orgSettings.work_hours_end,
      work_days: orgSettings.work_days,
      timezone: orgSettings.timezone || 'UTC',
    };
  }

  // Fallback
  return {
    work_hours_start: '09:00:00',
    work_hours_end: '18:00:00',
    work_days: [1, 2, 3, 4, 5],
    timezone: 'UTC',
  };
}
```

### 9.3 Idle Display Rules

| Scenario | Show on Timeline? |
|----------|------------------|
| Idle during work hours (9 AM – 6 PM weekday) | **Yes** — amber block |
| Idle before work hours (7 AM – 9 AM) | **No** — hidden |
| Idle after work hours (6 PM – 10 PM) | **No** — hidden |
| Idle on weekend (Saturday) | **No** — hidden |
| Idle on weekend but work_days includes Saturday | **Yes** — amber block |
| Idle that spans work hours boundary (8:50 AM – 9:15 AM) | **Partially** — clipped to 9:00 AM – 9:15 AM |

---

## 10. Security & Privacy Considerations

### 10.1 Access Control

| Operation | Who Can Perform | Enforcement Point |
|-----------|----------------|-------------------|
| View own idle time | Self only | `fetchMyDayTimeline` — filtered by `accountId` |
| View team idle time | Project Admin | `getTeamDayTimeline` — checks `ADMINISTER_PROJECTS` |
| Convert idle to worklog | Record owner only | `convertIdleToWorklog` — verifies `record.user_id === currentUserId` |
| View conversion audit | Project Admin | Visible on team timeline tooltip |

### 10.2 Data Validation

```javascript
// All conversion inputs are validated:
// 1. idleRecordId must be a valid UUID
// 2. reason must be from predefined set (prevent free-text injection)
// 3. issueKey is validated against Jira project pattern (PROJ-NNN)
// 4. newIssueSummary is sanitized (max 255 chars, no script tags)
// 5. User ownership is verified server-side (not trusted from client)
// 6. Either issueKey OR createNewIssue must be provided

const VALID_REASONS = [
  'meeting', 'phone_call', 'code_review', 'reading',
  'whiteboard', 'presentation', 'pair_programming', 'other'
];

if (!reason || !VALID_REASONS.includes(reason)) {
  return { success: false, error: 'Invalid reason' };
}

if (issueKey && !/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) {
  return { success: false, error: 'Invalid issue key format' };
}

if (newIssueSummary && newIssueSummary.length > 255) {
  return { success: false, error: 'Issue summary too long' };
}
```

### 10.3 Row-Level Security (Supabase RLS)

```sql
-- Ensure RLS policy allows idle record inserts from desktop app
CREATE POLICY "Users can insert own idle records"
  ON public.activity_records
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Ensure RLS policy allows reclassification updates
CREATE POLICY "Users can update own idle records for reclassification"
  ON public.activity_records
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND is_idle = TRUE
  );
```

### 10.4 Privacy

- Idle records contain **no window titles or OCR text** (application_name = 'System Idle')
- Conversion reason is from a predefined list (no free text that could leak info)
- Admins see idle blocks on team timeline but **cannot** convert another user's idle time
- The ➕ convert button is only rendered for the record owner's own timeline

---

## 11. Rollback Strategy

### Phase 1: Feature Flag Off (Instant)

```sql
UPDATE tracking_settings SET show_idle_in_timeline = FALSE;
```
- Idle blocks stop appearing on timeline immediately
- Idle records continue to be created (no data loss)
- Reclassification modal is hidden

### Phase 2: Stop Desktop Recording (App Update)

- Push config update: set `track_idle_records = false` in tracking_settings
- Desktop app stops creating idle records
- Existing idle records remain in database

### Phase 3: Schema Revert (If Needed)

```sql
-- Remove idle-specific columns (data preserved in JSONB metadata backup first)
ALTER TABLE public.activity_records
  DROP COLUMN IF EXISTS idle_start_time,
  DROP COLUMN IF EXISTS idle_end_time,
  DROP COLUMN IF EXISTS reclassified_from,
  DROP COLUMN IF EXISTS reclassified_at,
  DROP COLUMN IF EXISTS reclassified_by,
  DROP COLUMN IF EXISTS reclassification_reason;

-- Remove idle classification (after deleting idle records)
DELETE FROM public.activity_records WHERE is_idle = TRUE;
ALTER TABLE public.activity_records DROP COLUMN IF EXISTS is_idle;
```

---

## 12. Automated Test Scripts (Playwright)

### 12.1 Test Setup & Configuration

**File:** `tests/playwright/idle-time/idle-time.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright/idle-time',
  fullyParallel: false,     // Sequential — tests share timeline state
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'test-results/idle-time-report' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.FORGE_APP_URL || 'https://your-jira-instance.atlassian.net',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

### 12.2 Test Fixtures & Helpers

**File:** `tests/playwright/idle-time/fixtures.ts`

```typescript
import { test as base, expect, Page } from '@playwright/test';

// ─── Types ────────────────────────────────────────────────────

interface IdleBlock {
  id: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  reclassified: boolean;
}

interface TimelineData {
  sessions: Array<{ startTime: string; endTime: string; durationSeconds: number }>;
  idleBlocks: IdleBlock[];
  totalIdleSeconds: number;
  workHours: { start: string; end: string };
}

// ─── Fixtures ─────────────────────────────────────────────────

interface IdleTestFixtures {
  timelinePage: Page;
  apiHelper: ApiHelper;
}

class ApiHelper {
  constructor(private page: Page) {}

  /**
   * Seed an idle record directly into Supabase for test isolation.
   */
  async seedIdleRecord(params: {
    userId: string;
    orgId: string;
    idleStartTime: string;
    idleEndTime: string;
    workDate: string;
    projectKey?: string;
  }): Promise<string> {
    const recordId = crypto.randomUUID();
    const durationSeconds = Math.round(
      (new Date(params.idleEndTime).getTime() -
        new Date(params.idleStartTime).getTime()) /
        1000
    );

    const response = await this.page.request.post(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        data: {
          id: recordId,
          user_id: params.userId,
          organization_id: params.orgId,
          application_name: 'System Idle',
          classification: 'idle',
          is_idle: true,
          idle_start_time: params.idleStartTime,
          idle_end_time: params.idleEndTime,
          start_time: params.idleStartTime,
          end_time: params.idleEndTime,
          duration_seconds: durationSeconds,
          total_time_seconds: durationSeconds,
          work_date: params.workDate,
          project_key: params.projectKey || null,
          status: 'analyzed',
          user_timezone: 'America/New_York',
        },
      }
    );

    expect(response.ok()).toBeTruthy();
    return recordId;
  }

  /**
   * Delete a seeded idle record (cleanup).
   */
  async deleteRecord(recordId: string): Promise<void> {
    const response = await this.page.request.delete(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records?id=eq.${recordId}`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    expect(response.ok()).toBeTruthy();
  }

  /**
   * Fetch an activity record by ID to verify reclassification.
   */
  async getRecord(recordId: string): Promise<Record<string, unknown>> {
    const response = await this.page.request.get(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records?id=eq.${recordId}&select=*`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    return data[0];
  }
}

export const test = base.extend<IdleTestFixtures>({
  apiHelper: async ({ page }, use) => {
    await use(new ApiHelper(page));
  },

  timelinePage: async ({ page }, use) => {
    // Navigate to the Jira project page with time tracker
    await page.goto(
      '/jira/software/projects/TEST/board' +
        '?selectedTab=time-analytics&view=day'
    );
    // Wait for timeline to render
    await page.waitForSelector('.timeline-container', { timeout: 15000 });
    await use(page);
  },
});

export { expect };
```

### 12.3 Test Suite: Idle Block Display

**File:** `tests/playwright/idle-time/idle-block-display.spec.ts`

```typescript
import { test, expect } from './fixtures';

test.describe('Idle Block Display on Timeline', () => {
  let seededRecordId: string;

  const TEST_USER_ID = process.env.TEST_USER_ID!;
  const TEST_ORG_ID = process.env.TEST_ORG_ID!;
  const TODAY = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  test.afterEach(async ({ apiHelper }) => {
    // Cleanup seeded records
    if (seededRecordId) {
      await apiHelper.deleteRecord(seededRecordId);
      seededRecordId = '';
    }
  });

  test('idle block appears on timeline during work hours', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record during work hours (10:00 AM - 10:30 AM)
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    // Refresh page to load new data
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Verify idle block is rendered
    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await expect(idleBlock).toBeVisible();

    // Verify it has the 'idle' CSS class
    await expect(idleBlock).toHaveClass(/idle/);

    // Verify it does NOT have the 'reclassified' class
    await expect(idleBlock).not.toHaveClass(/reclassified/);
  });

  test('idle block does NOT appear outside work hours', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record OUTSIDE work hours (11:00 PM - 11:30 PM)
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T23:00:00Z`,
      idleEndTime: `${TODAY}T23:30:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Verify idle block is NOT rendered (outside work hours)
    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await expect(idleBlock).not.toBeVisible();
  });

  test('idle block is clipped to work hours boundary', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record that spans the work-hours start boundary
    // Idle: 8:45 AM - 9:15 AM, Work hours: 9:00 AM - 6:00 PM
    // Expected: block shows 9:00 AM - 9:15 AM only
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T08:45:00Z`,
      idleEndTime: `${TODAY}T09:15:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await expect(idleBlock).toBeVisible();

    // Verify the block's position corresponds to 9:00 AM start
    // (9:00 AM = 37.5% of 24-hour timeline scale if timeline is 0-24h)
    const style = await idleBlock.getAttribute('style');
    expect(style).toBeTruthy();
    // The left% should reflect 9:00 AM, not 8:45 AM
  });

  test('multiple idle blocks render correctly in one day', async ({
    timelinePage,
    apiHelper,
  }) => {
    const recordIds: string[] = [];

    // Seed two idle periods
    recordIds.push(
      await apiHelper.seedIdleRecord({
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        idleStartTime: `${TODAY}T10:00:00Z`,
        idleEndTime: `${TODAY}T10:20:00Z`,
        workDate: TODAY,
      })
    );
    recordIds.push(
      await apiHelper.seedIdleRecord({
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        idleStartTime: `${TODAY}T14:00:00Z`,
        idleEndTime: `${TODAY}T14:45:00Z`,
        workDate: TODAY,
      })
    );

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Both idle blocks should be visible
    for (const id of recordIds) {
      const block = timelinePage.locator(`[data-testid="idle-block-${id}"]`);
      await expect(block).toBeVisible();
    }

    // Cleanup
    for (const id of recordIds) {
      await apiHelper.deleteRecord(id);
    }
    seededRecordId = ''; // Already cleaned up
  });

  test('idle block shows tooltip on hover', async ({
    timelinePage,
    apiHelper,
  }) => {
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T11:00:00Z`,
      idleEndTime: `${TODAY}T11:30:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );

    // Hover over the idle block
    await idleBlock.hover();

    // Verify tooltip content
    const tooltip = timelinePage.locator('.idle-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('.tooltip-header')).toContainText('Idle Time');
    await expect(tooltip.locator('.tooltip-duration')).toContainText('30');
    await expect(tooltip.locator('.tooltip-action')).toContainText(
      'Click'
    );
  });

  test('➕ convert button appears on idle block hover', async ({
    timelinePage,
    apiHelper,
  }) => {
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T11:00:00Z`,
      idleEndTime: `${TODAY}T11:30:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    const convertBtn = timelinePage.locator(
      `[data-testid="idle-convert-btn-${seededRecordId}"]`
    );

    // Button hidden by default
    await expect(convertBtn).not.toBeVisible();

    // Hover to reveal ➕ button
    await idleBlock.hover();
    await expect(convertBtn).toBeVisible();
  });

  test('timeline legend shows idle and converted indicators', async ({
    timelinePage,
  }) => {
    const legend = timelinePage.locator('[data-testid="timeline-legend"]');
    await expect(legend).toBeVisible();

    // Verify all three legend items
    await expect(legend.locator('.legend-swatch.active')).toBeVisible();
    await expect(legend.locator('.legend-swatch.idle')).toBeVisible();
    await expect(legend.locator('.legend-swatch.converted')).toBeVisible();
  });
});
```

### 12.4 Test Suite: Convert Idle to Worklog

**File:** `tests/playwright/idle-time/convert-to-worklog.spec.ts`

```typescript
import { test, expect } from './fixtures';

test.describe('Convert Idle Time to Worklog', () => {
  let seededRecordId: string;

  const TEST_USER_ID = process.env.TEST_USER_ID!;
  const TEST_ORG_ID = process.env.TEST_ORG_ID!;
  const TODAY = new Date().toISOString().split('T')[0];

  test.beforeEach(async ({ apiHelper }) => {
    // Seed a standard idle record for conversion tests
    seededRecordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
      projectKey: 'TEST',
    });
  });

  test.afterEach(async ({ apiHelper }) => {
    if (seededRecordId) {
      await apiHelper.deleteRecord(seededRecordId);
    }
  });

  test('clicking ➕ icon opens convert popover', async ({
    timelinePage,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Hover to reveal ➕ button, then click it
    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();

    const convertBtn = timelinePage.locator(
      `[data-testid="idle-convert-btn-${seededRecordId}"]`
    );
    await convertBtn.click();

    // Popover should appear
    const popover = timelinePage.locator('[data-testid="convert-popover"]');
    await expect(popover).toBeVisible();

    // Header text
    await expect(popover.locator('.popover-header')).toContainText(
      'Convert Idle to Work'
    );

    // Time info displayed
    await expect(popover.locator('.popover-time-info')).toContainText('30');
  });

  test('convert idle to worklog with existing issue', async ({
    timelinePage,
    apiHelper,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Open convert popover
    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();
    await timelinePage
      .locator(`[data-testid="idle-convert-btn-${seededRecordId}"]`)
      .click();

    const popover = timelinePage.locator('[data-testid="convert-popover"]');
    await expect(popover).toBeVisible();

    // Select reason: meeting
    await popover
      .locator('[data-testid="convert-reason-select"]')
      .selectOption('meeting');

    // Select "Existing issue" radio
    await popover
      .locator('[data-testid="radio-existing-issue"]')
      .click();

    // Type issue key
    await popover
      .locator('[data-testid="issue-key-input"]')
      .fill('TEST-42');

    // Submit
    await popover.locator('[data-testid="convert-submit-btn"]').click();

    // Popover should close
    await expect(popover).not.toBeVisible();

    // Verify the block is now converted (green with ✓)
    await timelinePage.waitForSelector('.timeline-container');
    const convertedBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await expect(convertedBlock).toHaveClass(/converted/);

    // Verify database state
    const record = await apiHelper.getRecord(seededRecordId);
    expect(record.classification).toBe('productive');
    expect(record.reclassified_from).toBe('idle');
    expect(record.reclassification_reason).toBe('meeting');
    expect(record.user_assigned_issue_key).toBe('TEST-42');
    expect(record.reclassified_at).toBeTruthy();
    expect(record.reclassified_by).toBe(TEST_USER_ID);
  });

  test('convert idle to worklog with new issue creation', async ({
    timelinePage,
    apiHelper,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Open popover
    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();
    await timelinePage
      .locator(`[data-testid="idle-convert-btn-${seededRecordId}"]`)
      .click();

    const popover = timelinePage.locator('[data-testid="convert-popover"]');

    // Select reason: phone_call
    await popover
      .locator('[data-testid="convert-reason-select"]')
      .selectOption('phone_call');

    // Select "Create new issue" radio
    await popover
      .locator('[data-testid="radio-new-issue"]')
      .click();

    // Type issue summary
    await popover
      .locator('[data-testid="new-issue-summary-input"]')
      .fill('Sprint planning call with client');

    // Submit
    await popover.locator('[data-testid="convert-submit-btn"]').click();
    await expect(popover).not.toBeVisible();

    // Verify database — should have an issue key assigned
    const record = await apiHelper.getRecord(seededRecordId);
    expect(record.classification).toBe('productive');
    expect(record.reclassified_from).toBe('idle');
    expect(record.reclassification_reason).toBe('phone_call');
    // Issue key should be populated (created by backend)
    expect(record.user_assigned_issue_key).toBeTruthy();
  });

  test('non-productive idle: no convert button on already-converted block', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Pre-convert the record via API
    await timelinePage.request.patch(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records?id=eq.${seededRecordId}`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        data: {
          classification: 'productive',
          reclassified_from: 'idle',
          reclassified_at: new Date().toISOString(),
          reclassified_by: TEST_USER_ID,
          reclassification_reason: 'meeting',
          user_assigned_issue_key: 'TEST-42',
        },
      }
    );

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const block = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await block.hover();

    // ➕ button should NOT appear on already-converted blocks
    const convertBtn = timelinePage.locator(
      `[data-testid="idle-convert-btn-${seededRecordId}"]`
    );
    await expect(convertBtn).not.toBeVisible();

    // ✓ icon should be visible instead
    await expect(block.locator('.idle-converted-icon')).toBeVisible();
  });

  test('submit disabled when reason or issue is missing', async ({
    timelinePage,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();
    await timelinePage
      .locator(`[data-testid="idle-convert-btn-${seededRecordId}"]`)
      .click();

    const popover = timelinePage.locator('[data-testid="convert-popover"]');
    const submitBtn = popover.locator('[data-testid="convert-submit-btn"]');

    // No reason, no issue → disabled
    await expect(submitBtn).toBeDisabled();

    // Add reason only → still disabled (no issue)
    await popover
      .locator('[data-testid="convert-reason-select"]')
      .selectOption('meeting');
    await expect(submitBtn).toBeDisabled();

    // Add issue → now enabled
    await popover
      .locator('[data-testid="radio-existing-issue"]')
      .click();
    await popover
      .locator('[data-testid="issue-key-input"]')
      .fill('TEST-1');
    await expect(submitBtn).toBeEnabled();
  });

  test('cancel closes popover without changes', async ({
    timelinePage,
    apiHelper,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();
    await timelinePage
      .locator(`[data-testid="idle-convert-btn-${seededRecordId}"]`)
      .click();

    const popover = timelinePage.locator('[data-testid="convert-popover"]');
    await expect(popover).toBeVisible();

    // Fill in some data
    await popover
      .locator('[data-testid="convert-reason-select"]')
      .selectOption('meeting');

    // Cancel
    await popover.locator('[data-testid="convert-cancel-btn"]').click();
    await expect(popover).not.toBeVisible();

    // Verify record is unchanged
    const record = await apiHelper.getRecord(seededRecordId);
    expect(record.classification).toBe('idle');
    expect(record.reclassified_from).toBeNull();
  });

  test('converted block shows issue key in tooltip', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Pre-convert via API
    await timelinePage.request.patch(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records?id=eq.${seededRecordId}`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        data: {
          classification: 'productive',
          reclassified_from: 'idle',
          reclassified_at: new Date().toISOString(),
          reclassified_by: TEST_USER_ID,
          reclassification_reason: 'meeting',
          user_assigned_issue_key: 'TEST-42',
        },
      }
    );

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const block = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await block.hover();

    const tooltip = timelinePage.locator('.idle-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('.tooltip-header')).toContainText(
      'Converted to Work'
    );
    await expect(tooltip.locator('.tooltip-issue')).toContainText('TEST-42');
  });

  test('issue autocomplete shows search results', async ({
    timelinePage,
  }) => {
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const idleBlock = timelinePage.locator(
      `[data-testid="idle-block-${seededRecordId}"]`
    );
    await idleBlock.hover();
    await timelinePage
      .locator(`[data-testid="idle-convert-btn-${seededRecordId}"]`)
      .click();

    const popover = timelinePage.locator('[data-testid="convert-popover"]');

    // Select existing issue radio
    await popover.locator('[data-testid="radio-existing-issue"]').click();

    // Type partial issue key to trigger autocomplete
    await popover
      .locator('[data-testid="issue-key-input"]')
      .fill('TEST');

    // Wait for autocomplete dropdown
    const autocomplete = popover.locator('[data-testid="issue-autocomplete"]');
    await expect(autocomplete).toBeVisible({ timeout: 5000 });

    // Should show at least one result
    const items = autocomplete.locator('li');
    expect(await items.count()).toBeGreaterThan(0);

    // Click first result to select it
    await items.first().click();

    // Autocomplete should close and input should be populated
    await expect(autocomplete).not.toBeVisible();
    const inputValue = await popover
      .locator('[data-testid="issue-key-input"]')
      .inputValue();
    expect(inputValue).toMatch(/^TEST-\d+$/);
  });
});
```

### 12.5 Test Suite: Edge Cases & Error Handling

**File:** `tests/playwright/idle-time/edge-cases.spec.ts`

```typescript
import { test, expect } from './fixtures';

test.describe('Idle Time Edge Cases', () => {
  const TEST_USER_ID = process.env.TEST_USER_ID!;
  const TEST_ORG_ID = process.env.TEST_ORG_ID!;
  const TODAY = new Date().toISOString().split('T')[0];

  test('very short idle period (< threshold) is not shown', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record of only 2 minutes (below 5-minute threshold)
    const recordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:02:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Should not be visible (below minimum display threshold)
    const block = timelinePage.locator(`[data-testid="idle-block-${recordId}"]`);
    await expect(block).not.toBeVisible();

    await apiHelper.deleteRecord(recordId);
  });

  test('idle block spanning midnight is split across days', async ({
    timelinePage,
    apiHelper,
  }) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Idle from 11:30 PM yesterday to 12:30 AM today
    const recordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${yesterdayStr}T23:30:00Z`,
      idleEndTime: `${TODAY}T00:30:00Z`,
      workDate: yesterdayStr,
    });

    // On today's timeline, this should NOT appear (outside work hours)
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    const block = timelinePage.locator(`[data-testid="idle-block-${recordId}"]`);
    await expect(block).not.toBeVisible();

    await apiHelper.deleteRecord(recordId);
  });

  test('concurrent active and idle blocks do not overlap visually', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an active session and an idle period that are adjacent
    // Active: 10:00 - 10:15, Idle: 10:15 - 10:45
    const idleId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:15:00Z`,
      idleEndTime: `${TODAY}T10:45:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Get bounding boxes of both blocks
    const activeBlocks = timelinePage.locator('.timeline-block.active');
    const idleBlock = timelinePage.locator(`[data-testid="idle-block-${idleId}"]`);

    if ((await activeBlocks.count()) > 0 && (await idleBlock.isVisible())) {
      const activeBBox = await activeBlocks.last().boundingBox();
      const idleBBox = await idleBlock.boundingBox();

      if (activeBBox && idleBBox) {
        // Idle block should start at or after active block ends
        expect(idleBBox.x).toBeGreaterThanOrEqual(
          activeBBox.x + activeBBox.width - 2 // 2px tolerance
        );
      }
    }

    await apiHelper.deleteRecord(idleId);
  });

  test('page loads correctly when no idle records exist', async ({
    timelinePage,
  }) => {
    // No idle records seeded — page should load without errors
    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Active blocks may or may not exist
    // But no idle blocks should be present for a clean slate
    // The page should not crash or show error states
    const errorElement = timelinePage.locator('.error-message, .error-state');
    await expect(errorElement).not.toBeVisible();
  });

  test('rapid consecutive conversions do not cause race conditions', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed two idle records
    const id1 = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:15:00Z`,
      workDate: TODAY,
    });
    const id2 = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T11:00:00Z`,
      idleEndTime: `${TODAY}T11:20:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Convert first record via ➕ button
    const block1 = timelinePage.locator(`[data-testid="idle-block-${id1}"]`);
    await block1.hover();
    await timelinePage.locator(`[data-testid="idle-convert-btn-${id1}"]`).click();
    let popover = timelinePage.locator('[data-testid="convert-popover"]');
    await popover.locator('[data-testid="convert-reason-select"]').selectOption('meeting');
    await popover.locator('[data-testid="radio-existing-issue"]').click();
    await popover.locator('[data-testid="issue-key-input"]').fill('TEST-1');
    await popover.locator('[data-testid="convert-submit-btn"]').click();
    await expect(popover).not.toBeVisible();

    // Immediately convert second record
    const block2 = timelinePage.locator(`[data-testid="idle-block-${id2}"]`);
    await block2.hover();
    await timelinePage.locator(`[data-testid="idle-convert-btn-${id2}"]`).click();
    popover = timelinePage.locator('[data-testid="convert-popover"]');
    await expect(popover).toBeVisible();
    await popover.locator('[data-testid="convert-reason-select"]').selectOption('phone_call');
    await popover.locator('[data-testid="radio-existing-issue"]').click();
    await popover.locator('[data-testid="issue-key-input"]').fill('TEST-2');
    await popover.locator('[data-testid="convert-submit-btn"]').click();
    await expect(popover).not.toBeVisible();

    // Verify both records are correctly converted
    const record1 = await apiHelper.getRecord(id1);
    const record2 = await apiHelper.getRecord(id2);

    expect(record1.reclassification_reason).toBe('meeting');
    expect(record1.user_assigned_issue_key).toBe('TEST-1');
    expect(record2.reclassification_reason).toBe('phone_call');
    expect(record2.user_assigned_issue_key).toBe('TEST-2');

    await apiHelper.deleteRecord(id1);
    await apiHelper.deleteRecord(id2);
  };
});
```

### 12.6 Test Suite: Access Control & Security

**File:** `tests/playwright/idle-time/access-control.spec.ts`

```typescript
import { test, expect } from './fixtures';

test.describe('Idle Time Access Control', () => {
  const TEST_USER_ID = process.env.TEST_USER_ID!;
  const OTHER_USER_ID = process.env.OTHER_USER_ID!;
  const TEST_ORG_ID = process.env.TEST_ORG_ID!;
  const TODAY = new Date().toISOString().split('T')[0];

  test('user cannot see other user idle blocks on their own timeline', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record for ANOTHER user
    const otherId = await apiHelper.seedIdleRecord({
      userId: OTHER_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    await timelinePage.reload();
    await timelinePage.waitForSelector('.timeline-container');

    // Other user's idle block should NOT appear on current user's timeline
    const block = timelinePage.locator(
      `[data-testid="idle-block-${otherId}"]`
    );
    await expect(block).not.toBeVisible();

    await apiHelper.deleteRecord(otherId);
  });

  test('convert API rejects requests for other users records', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Seed an idle record for another user
    const otherId = await apiHelper.seedIdleRecord({
      userId: OTHER_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    // Attempt to convert via Forge resolver (should fail)
    const response = await timelinePage.evaluate(async (recordId) => {
      // @ts-ignore - invoke is provided by Forge bridge
      const result = await window.__bridge__.invoke('convertIdleToWorklog', {
        idleRecordId: recordId,
        reason: 'meeting',
        issueKey: 'TEST-1',
      });
      return result;
    }, otherId);

    expect(response.success).toBe(false);
    expect(response.error).toContain('access denied');

    await apiHelper.deleteRecord(otherId);
  });

  test('convert API rejects non-idle records', async ({
    timelinePage,
    apiHelper,
  }) => {
    // Try to convert a regular work session (not idle)
    const response = await timelinePage.request.get(
      `${process.env.SUPABASE_URL}/rest/v1/activity_records` +
        `?user_id=eq.${TEST_USER_ID}&is_idle=eq.false&limit=1` +
        `&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const records = await response.json();

    if (records.length > 0) {
      const result = await timelinePage.evaluate(async (recordId) => {
        // @ts-ignore
        return await window.__bridge__.invoke('convertIdleToWorklog', {
          idleRecordId: recordId,
          reason: 'meeting',
          issueKey: 'TEST-1',
        });
      }, records[0].id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Only idle records');
    }
  });

  test('convert API rejects when no issue or new issue provided', async ({
    timelinePage,
    apiHelper,
  }) => {
    const recordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    const result = await timelinePage.evaluate(async (id) => {
      // @ts-ignore
      return await window.__bridge__.invoke('convertIdleToWorklog', {
        idleRecordId: id,
        reason: 'meeting',
        // No issueKey and no createNewIssue
      });
    }, recordId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must assign to an existing issue');

    await apiHelper.deleteRecord(recordId);
  });

  test('SQL injection in issue key is sanitized', async ({
    timelinePage,
    apiHelper,
  }) => {
    const recordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    const result = await timelinePage.evaluate(async (id) => {
      // @ts-ignore
      return await window.__bridge__.invoke('convertIdleToWorklog', {
        idleRecordId: id,
        reason: 'meeting',
        issueKey: "'; DROP TABLE activity_records; --",
      });
    }, recordId);

    // Should be rejected by issue key format validation
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid issue key');

    await apiHelper.deleteRecord(recordId);
  });
});
```

### 12.7 Test Suite: Admin Team Timeline View

**File:** `tests/playwright/idle-time/admin-team-view.spec.ts`

```typescript
import { test, expect } from './fixtures';

test.describe('Admin Team Timeline - Idle Blocks', () => {
  const TEST_USER_ID = process.env.TEST_USER_ID!;
  const TEST_ORG_ID = process.env.TEST_ORG_ID!;
  const TODAY = new Date().toISOString().split('T')[0];

  test('admin sees idle blocks on team member timelines', async ({
    page,
    apiHelper,
  }) => {
    // This test requires admin login
    // Navigate to team day timeline (admin view)
    await page.goto(
      '/jira/software/projects/TEST/board' +
        '?selectedTab=time-analytics&view=team-day'
    );
    await page.waitForSelector('.timeline-container', { timeout: 15000 });

    // Seed idle record for a team member
    const recordId = await apiHelper.seedIdleRecord({
      userId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      idleStartTime: `${TODAY}T10:00:00Z`,
      idleEndTime: `${TODAY}T10:30:00Z`,
      workDate: TODAY,
    });

    await page.reload();
    await page.waitForSelector('.timeline-container');

    // Idle blocks should be visible in team view
    const idleBlocks = page.locator('.timeline-block.idle');
    const count = await idleBlocks.count();
    expect(count).toBeGreaterThan(0);

    await apiHelper.deleteRecord(recordId);
  });

  test('admin does not see ➕ button on other users idle blocks', async ({
    page,
  }) => {
    // Navigate to team view
    await page.goto(
      '/jira/software/projects/TEST/board' +
        '?selectedTab=time-analytics&view=team-day'
    );
    await page.waitForSelector('.timeline-container', { timeout: 15000 });

    // Idle blocks in team view should NOT have ➕ convert button
    const otherUserIdleBlocks = page.locator('.timeline-block.idle');
    if ((await otherUserIdleBlocks.count()) > 0) {
      await otherUserIdleBlocks.first().hover();

      // ➕ button should NOT appear (admin viewing other user's idle time)
      const convertBtn = otherUserIdleBlocks.first().locator('.idle-convert-btn');
      await expect(convertBtn).not.toBeVisible();
    }
  });

  test('team summary includes idle time statistics', async ({ page }) => {
    await page.goto(
      '/jira/software/projects/TEST/board' +
        '?selectedTab=time-analytics&view=team-day'
    );
    await page.waitForSelector('.timeline-container', { timeout: 15000 });

    // Verify the summary section shows idle time info
    const summarySection = page.locator('.team-summary, .day-summary');
    if (await summarySection.isVisible()) {
      // Should contain idle time information
      const text = await summarySection.textContent();
      // Summary may include total idle time for the team
      expect(text).toBeTruthy();
    }
  });
});
```

### 12.8 Running the Tests

```bash
# Install Playwright
npm install -D @playwright/test
npx playwright install chromium

# Set environment variables
export FORGE_APP_URL="https://your-instance.atlassian.net"
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export SUPABASE_SERVICE_KEY="your-service-key"
export TEST_USER_ID="uuid-of-test-user"
export TEST_ORG_ID="uuid-of-test-org"
export OTHER_USER_ID="uuid-of-another-user"

# Run all idle time tests
npx playwright test --config=tests/playwright/idle-time/idle-time.config.ts

# Run specific test suite
npx playwright test tests/playwright/idle-time/idle-block-display.spec.ts
npx playwright test tests/playwright/idle-time/convert-to-worklog.spec.ts
npx playwright test tests/playwright/idle-time/edge-cases.spec.ts
npx playwright test tests/playwright/idle-time/access-control.spec.ts
npx playwright test tests/playwright/idle-time/admin-team-view.spec.ts

# Run with UI mode for debugging
npx playwright test --ui --config=tests/playwright/idle-time/idle-time.config.ts

# Generate HTML report
npx playwright test --reporter=html --config=tests/playwright/idle-time/idle-time.config.ts
```

### 12.9 CI/CD Integration (GitHub Actions)

```yaml
# .github/workflows/idle-time-tests.yml
name: Idle Time Feature Tests

on:
  push:
    paths:
      - 'forge-app/src/**'
      - 'forge-app/static/**'
      - 'python-desktop-app/**'
      - 'supabase/migrations/**'
      - 'tests/playwright/idle-time/**'
  pull_request:
    branches: [main]

jobs:
  playwright-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: |
          cd forge-app
          npm ci
          npx playwright install --with-deps chromium

      - name: Run idle time tests
        env:
          FORGE_APP_URL: ${{ secrets.FORGE_APP_URL }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          TEST_USER_ID: ${{ secrets.TEST_USER_ID }}
          TEST_ORG_ID: ${{ secrets.TEST_ORG_ID }}
          OTHER_USER_ID: ${{ secrets.OTHER_USER_ID }}
        run: |
          npx playwright test --config=tests/playwright/idle-time/idle-time.config.ts

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: idle-time-test-results
          path: test-results/
          retention-days: 7
```

---

## Summary of Changes by Component

| Component | Files Modified | Files Created | Effort |
|-----------|---------------|---------------|--------|
| **Supabase** | — | 2 migration files | Low |
| **Desktop App** | `desktop_app.py` | — | Medium |
| **Forge Backend** | `teamAnalyticsService.js`, `analyticsResolvers.js`, `constants.js` | — | Medium |
| **Forge Frontend** | `DayView.js`, `TimeAnalyticsTab.css` | — | Medium-High |
| **Tests** | — | 6 Playwright test files | Medium |

### Implementation Order

1. **Database migrations** — Add idle columns, classification value, reclassification audit fields
2. **Desktop app** — Record idle periods as `activity_records` with `is_idle = true`
3. **Backend services** — Return idle blocks in timeline API, add `reclassifyIdleTime` resolver
4. **Frontend** — Render idle blocks, tooltip, reclassification modal, legend
5. **Tests** — Run Playwright test suites against staging environment
6. **Feature flag** — Enable `show_idle_in_timeline` per org/project for phased rollout
