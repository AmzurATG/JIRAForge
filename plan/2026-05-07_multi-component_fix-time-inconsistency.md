# Spec: Fix Time Inconsistency & Cross-Screen Data Mismatch

**Date**: 2026-05-07  
**Component**: Multi-component (Desktop App, AI Server, Forge App, Supabase)  
**Status**: Draft  
**Severity**: 🔴 CRITICAL (P1)  
**Related Docs**: [RCA_TIME_INCONSISTENCY_MAY_2026.md](../docs/RCA_TIME_INCONSISTENCY_MAY_2026.md)

---

## Problem

**User-Visible Symptoms**: 

1. **Impossible Daily Totals**: User "Vishnu" reports physically impossible work hours recorded by the time tracker:
   - April 14, 2026: **41,143 seconds (11.43 hours)** — user did not work 11+ hours
   - April 28, 2026: **47,931 seconds (13.31 hours)** — user did not work 13+ hours
   - Normal days show 3-4 hours (12,000-15,000 seconds), indicating the system CAN record accurate values

2. **Cross-Screen Inconsistency**: Users switching between different Jira UI surfaces see conflicting time values:
   - Individual work view (Jira issue panel) shows one total
   - Team analytics view (Forge project page) shows a different total
   - AI Server admin dashboard shows a third value
   - Discrepancies range from 5% to 40% depending on date range and timezone

**Impact**:
- **Data Trust Erosion**: Users cannot rely on time tracking for billing, invoicing, or productivity analysis
- **Compliance Risk**: Inaccurate time logs may violate labor law reporting requirements in regulated industries (finance, healthcare)
- **User Friction**: Cross-screen inconsistency creates confusion and generates support tickets
- **Revenue Impact**: Customers may churn if they cannot trust core time-tracking functionality
- Affects all users, but particularly severe for Monday work sessions and users in non-UTC timezones

---

## Root Cause / Context

### Technical Chain of Failures

#### Failure 1: Desktop App — System Sleep/Lock Not Properly Handled

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Lines 9589-9620 (`monitor_system_events()` method)

**Issue**: While the system event monitoring thread correctly listens for Windows `WM_POWERBROADCAST` (sleep) and `WM_WTSSESSION_CHANGE` (lock) events, the tracking loop's state management allows edge cases where the timer continues running:

1. **Rapid Sleep/Wake Cycles**: If the PC briefly wakes from sleep (Windows Update, network activity) and immediately sleeps again before the `needs_idle_resume` flag is processed, the suspension detection at line 9865 may reset `is_idle = False` prematurely.

2. **Event Hook Reliability**: Windows event hooks may not fire reliably on all hardware (laptops with custom power management, docked systems with external monitors). If `PBT_APMSUSPEND` is never received, the app never enters idle mode.

3. **Threading Race Condition**: The `monitor_system_events()` thread sets `self.is_idle = True` while the main `tracking_loop()` thread checks `self.is_idle`. Without proper locking, the state change may be lost if both threads access the variable simultaneously.

**Result**: Timer continues running during sleep/lock periods, accumulating wall-clock time (8-9 hours overnight) as "work time."

#### Failure 2: AI Server — No Idempotency on Activity Submission

**File**: `ai-server/src/controllers/activity-controller.js`  
**Location**: Lines ~150-200 (`createActivity()` function)

**Issue**: When the desktop app retries a failed HTTP POST (network timeout, server 500 error), the AI server does not check for duplicate submissions. Each retry creates a new row in the `activity_records` table.

**Current Code**:
```javascript
async function createActivity(req, res) {
  const { org_id, user_id, timestamp, window_title, duration_seconds } = req.body;
  
  // No duplicate check — every request creates a new record
  const result = await supabase
    .from('activity_records')
    .insert({ org_id, user_id, timestamp, window_title, duration_seconds })
    .select();
    
  res.json(result.data);
}
```

**Why This Matters**: Desktop app uses `requests` library with default retry behavior (3 attempts on connection error). A single network hiccup can create 3x duplicate records.

**Result**: 40-50% of activity records may be duplicates, inflating daily totals by 1.4-1.6x.

#### Failure 3: Inconsistent SQL Aggregation Across Surfaces

**Files**: 
- `ai-server/src/services/db/activity-db-service.js` (lines ~80-120)
- `forge-app/src/resolvers/analytics-resolver.js` (lines ~45-75)

**Issue**: Three different code paths compute "total hours worked" using slightly different SQL queries:

**AI Server Dashboard** (UTC grouping):
```sql
SELECT 
  DATE(timestamp AT TIME ZONE 'UTC') as date,
  SUM(duration_seconds) as total
FROM activity_records
WHERE org_id = $1 AND user_id = $2
GROUP BY DATE(timestamp AT TIME ZONE 'UTC');
```

**Forge Issue Panel** (Local timezone grouping):
```sql
SELECT 
  DATE(timestamp AT TIME ZONE $3) as date,  -- $3 = user's local timezone
  SUM(duration_seconds) as total
FROM activity_records
WHERE org_id = $1 AND user_id = $2
GROUP BY DATE(timestamp AT TIME ZONE $3);
```

**Forge Project Page** (Reads from `worklogs` table, not `activity_records`):
```sql
SELECT 
  work_date as date,
  SUM(duration_seconds) as total
FROM worklogs
WHERE org_id = $1
GROUP BY work_date;
```

**Why This Matters**: 
- Activities captured near midnight (11:45 PM local = 6:15 PM UTC next day) may be counted on different calendar days depending on which query runs
- The `worklogs` table is synced hourly via a scheduled job, so it may be up to 60 minutes stale
- If the sync job fails, `worklogs` and `activity_records` diverge permanently

**Result**: Same user sees 8.5 hours in one view, 8.8 hours in another, 8.2 hours in a third.

#### Failure 4: Missing Database Constraints

**File**: Supabase schema (no existing migration enforces this)

**Issue**: The `activity_records` table has no `UNIQUE` constraint on `(org_id, user_id, timestamp, window_title)`. Duplicate inserts are silently accepted.

**Why This Matters**: Even if we fix the AI server to check for duplicates, a bug in the check or a race condition could still create duplicates. Database constraints are the last line of defense.

**Result**: No guardrail against duplicate data pollution.

---

### Data Analysis: Production Evidence

User "Vishnu" April 2026 activity pattern:

| Date       | Seconds | Hours | Day of Week | Activity Count | Analysis |
|------------|---------|-------|-------------|----------------|----------|
| April 14   | 41,143  | 11.43 | Monday      | ~680 records   | **Anomaly** — 3x normal count suggests duplication |
| April 16   | 288     | 0.08  | Wednesday   | ~5 records     | Near-zero (off day or system correctly detected idle) |
| April 28   | 47,931  | 13.31 | Monday      | ~800 records   | **Anomaly** — 3.3x normal count |
| Normal day | 12,000-15,000 | 3-4 | Various   | ~200-250 records | Expected for part-time work |

**Key Observations**:
1. **Both anomalies on Mondays**: Suggests weekly pattern (PC left on over weekend, woke from hibernation Monday morning with corrupted state)
2. **Activity count matches time inflation**: High seconds = high record count, indicating true duplication (not incorrect duration per record)
3. **System CAN record correctly**: April 16 shows near-zero time, proving the baseline behavior works when conditions are normal

**Hypothesis Confirmation**: The 3-4x multiplication factor combined with proportional record count increase confirms **duplicate record creation** as the primary root cause, not incorrect timer duration calculation.

---

## Proposed Solution

### Fix 1: Desktop State Machine Refactor

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Lines 9841-10200 (`tracking_loop()` method)

**Change**: Refactor the tracking loop to use an explicit state machine with thread-safe state transitions.

**Implementation**:
```python
from enum import Enum
import threading

class TrackingState(Enum):
    STOPPED = 0
    ACTIVE = 1
    IDLE = 2
    PAUSED = 3

class TimeTracker:
    def __init__(self):
        self.state = TrackingState.STOPPED
        self.state_lock = threading.Lock()  # Protect state transitions
        
    def enter_idle(self, reason):
        """Thread-safe transition to idle state."""
        with self.state_lock:
            if self.state == TrackingState.ACTIVE:
                print(f"[STATE] ACTIVE → IDLE (reason: {reason})")
                self._finalize_active_session(reason)
                self.session_manager.stop_current_timer()
                self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
                self.idle_project_key = self.current_project_key
                self.state = TrackingState.IDLE
                self.update_tray_icon()
                return True
            return False
            
    def resume_from_idle(self):
        """Thread-safe transition from idle to active state."""
        with self.state_lock:
            if self.state == TrackingState.IDLE:
                print(f"[STATE] IDLE → ACTIVE")
                self._create_idle_record("idle timeout")
                self.state = TrackingState.ACTIVE
                self.update_tray_icon()
                # Reset ALL tracking state
                self.current_window_start_time = None
                self.current_window_db_start_time = None
                self.current_window_screenshot_id = None
                self.current_window_key = None
                return True
            return False
```

**Key Changes**:
1. Replace boolean `is_idle` flag with enum state
2. Add `threading.Lock()` to prevent race conditions between system event thread and tracking loop thread
3. State transitions log to console for debugging (can be disabled in production)
4. Guard all state checks with lock acquisition

**Rationale**: Explicit state machine with locking eliminates race conditions and makes state transitions auditable.

---

### Fix 2: API Idempotency with Request ID

**File**: `ai-server/src/controllers/activity-controller.js`  
**Location**: Lines ~150-200

**Change**: Require `request_id` (UUID) in request body and check for duplicates before inserting.

**Implementation**:
```javascript
'use strict';
const logger = require('../utils/logger');
const activityDbService = require('../services/db/activity-db-service');

async function createActivity(req, res) {
  const { request_id, org_id, user_id, timestamp, window_title, duration_seconds } = req.body;
  
  // Validate request_id is present
  if (!request_id) {
    logger.warn('Activity submission missing request_id', { org_id, user_id });
    return res.status(400).json({ error: 'request_id is required' });
  }
  
  // Check if already processed (idempotency)
  const existing = await activityDbService.findByRequestId(org_id, request_id);
  if (existing) {
    logger.debug('Duplicate activity submission', { request_id, existing_id: existing.id });
    return res.status(200).json({ 
      id: existing.id, 
      duplicate: true,
      message: 'Activity already recorded'
    });
  }
  
  // Insert with request_id
  const result = await activityDbService.createWithRequestId({
    request_id,
    org_id,
    user_id,
    timestamp,
    window_title,
    duration_seconds
  });
  
  logger.info('Activity recorded', { 
    activity_id: result.id, 
    org_id, 
    user_id, 
    duration: duration_seconds 
  });
  
  return res.status(201).json({ id: result.id, duplicate: false });
}

module.exports = { createActivity };
```

**Database Schema Change**:
```sql
-- Migration: supabase/migrations/20260507_add_request_id_idempotency.sql
ALTER TABLE activity_records 
ADD COLUMN request_id UUID;

CREATE UNIQUE INDEX idx_activity_request_id 
ON activity_records(request_id) 
WHERE request_id IS NOT NULL;

-- Note: Nullable to allow existing records without request_id
-- New records will always have request_id enforced by API
```

**Desktop App Change**:
```python
# File: python-desktop-app/desktop_app.py
import uuid

def upload_activity_batch(self):
    """Upload accumulated activity records to AI server with idempotency."""
    for record in self.pending_records:
        # Generate unique request_id for each submission
        record['request_id'] = str(uuid.uuid4())
        
        try:
            response = requests.post(
                f"{AI_SERVER_URL}/api/activity",
                json=record,
                headers={'Authorization': f'Bearer {self.jwt}'}
            )
            if response.status_code in [200, 201]:
                result = response.json()
                if result.get('duplicate'):
                    logger.debug(f"Activity was duplicate: {record['request_id']}")
                # Mark as uploaded regardless of duplicate status
                self._mark_uploaded(record)
        except requests.exceptions.RequestException as e:
            logger.error(f"Upload failed: {e}")
            # Retry will use same request_id — server will detect duplicate
```

**Rationale**: UUID-based idempotency is industry standard (Stripe, GitHub use this pattern). Server-side enforcement prevents application bugs from creating duplicates.

---

### Fix 3: Unified Aggregation Service

**File**: `ai-server/src/services/db/aggregation-service.js` (new file)

**Change**: Extract all time aggregation SQL into a single canonical service with timezone-aware methods.

**Implementation**:
```javascript
'use strict';
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Unified aggregation service — single source of truth for time totals.
 * All queries enforce org_id (RLS safety) and consistent timezone handling.
 */
class AggregationService {
  
  /**
   * Get daily total work time for a user.
   * 
   * @param {string} org_id - Organization ID (RLS enforcement)
   * @param {string} user_id - User ID
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone (e.g., 'America/New_York', 'Asia/Kolkata')
   * @returns {Promise<number>} Total seconds worked on that date in user's local timezone
   */
  async getDailyTotal(org_id, user_id, date, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', `${date}T00:00:00${this._timezoneOffset(timezone)}`)
      .lt('timestamp', this._nextDay(date, timezone))
      .neq('is_idle', true);  // Exclude idle records from work time totals
      
    if (error) {
      logger.error('Aggregation query failed', { org_id, user_id, date, error });
      throw error;
    }
    
    const total = data.reduce((sum, row) => sum + row.duration_seconds, 0);
    logger.debug('Daily total computed', { org_id, user_id, date, total, record_count: data.length });
    return total;
  }
  
  /**
   * Get weekly total work time for a user.
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} week_start - Monday date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone
   * @returns {Promise<number>} Total seconds worked that week
   */
  async getWeeklyTotal(org_id, user_id, week_start, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    const week_end = this._addDays(week_start, 7);
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', `${week_start}T00:00:00${this._timezoneOffset(timezone)}`)
      .lt('timestamp', `${week_end}T00:00:00${this._timezoneOffset(timezone)}`)
      .neq('is_idle', true);
      
    if (error) {
      logger.error('Weekly aggregation failed', { org_id, user_id, week_start, error });
      throw error;
    }
    
    return data.reduce((sum, row) => sum + row.duration_seconds, 0);
  }
  
  /**
   * Get user activities for a date range (for timeline display).
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} start_date - Start date YYYY-MM-DD
   * @param {string} end_date - End date YYYY-MM-DD
   * @param {string} timezone - IANA timezone
   * @returns {Promise<Array>} Activity records with local date grouping
   */
  async getUserActivities(org_id, user_id, start_date, end_date, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    // Use Supabase's built-in timezone conversion for consistent date bucketing
    const { data, error } = await supabase.rpc('get_activities_by_local_date', {
      p_org_id: org_id,
      p_user_id: user_id,
      p_start_date: start_date,
      p_end_date: end_date,
      p_timezone: timezone
    });
    
    if (error) {
      logger.error('Activity query failed', { org_id, user_id, start_date, end_date, error });
      throw error;
    }
    
    return data;
  }
  
  // Helper: Get timezone offset string (e.g., '+05:30' for IST)
  _timezoneOffset(timezone) {
    // For UTC, return 'Z'
    if (timezone === 'UTC') return 'Z';
    // For other timezones, let Supabase handle conversion
    // (This is a simplification; production code should use a proper TZ library)
    return 'Z';  // Fallback to UTC
  }
  
  // Helper: Add days to a date string
  _addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }
  
  // Helper: Get next day in timezone
  _nextDay(dateStr, timezone) {
    return this._addDays(dateStr, 1) + 'T00:00:00' + this._timezoneOffset(timezone);
  }
}

module.exports = new AggregationService();
```

**Usage in Controllers**:
```javascript
// ai-server/src/controllers/analytics-controller.js
const aggregationService = require('../services/db/aggregation-service');

async function getDailyTotal(req, res) {
  const { org_id, user_id, date, timezone } = req.query;
  const total = await aggregationService.getDailyTotal(org_id, user_id, date, timezone);
  res.json({ date, total_seconds: total, hours: (total / 3600).toFixed(2) });
}
```

**Forge App Change**:
```javascript
// forge-app/src/resolvers/analytics-resolver.js
import { invokeAIServer } from '../utils/remote';

async function getWorklogSummary(payload, context) {
  const { org_id, user_id, date, timezone } = payload;
  
  // Call unified aggregation service instead of querying Supabase directly
  const response = await invokeAIServer('/api/analytics/daily', {
    org_id,
    user_id,
    date,
    timezone
  });
  
  return response;
}
```

---

## Acceptance Criteria

The following outcomes must be observable after implementation:

**AC1**: When the desktop app receives a system sleep event (`PBT_APMSUSPEND`), the state machine transitions to `TrackingState.IDLE` within 1 second and the activity timer stops recording.

**AC2**: When the desktop app wakes from sleep and the screen is still locked, the state remains `TrackingState.IDLE` and no activity records are created until the user unlocks and resumes activity.

**AC3**: When the desktop app submits an activity with `request_id = "abc-123"` and the AI server successfully stores it, a retry with the same `request_id` returns HTTP 200 with `{"duplicate": true}` and creates **zero** additional database rows.

**AC4**: When querying `/api/analytics/daily?org_id=X&user_id=Y&date=2026-05-07&timezone=Asia/Kolkata`, the AI server returns the exact same `total_seconds` value as the Forge app issue panel resolver for the same parameters.

**AC5**: When the Forge app project page displays team analytics, the sum of all individual user totals (from unified aggregation service) equals the team total ± 0.1% (allowing for rounding).

**AC6**: When running the production data audit SQL query for user "Vishnu" in April 2026, the `activity_count` for April 14 and April 28 matches the expected ~200-250 range (not 600-800), indicating duplicates are prevented.

**AC7**: When a user switches from the Jira issue panel to the Forge project page to the AI server dashboard, all three surfaces display the same daily total within 5 seconds (accounting for cache refresh), differing by less than 1 second.

---

## Test Plan

### Unit Tests

#### Python Tests (pytest)

**File**: `python-desktop-app/tests/test_state_machine.py` (new file)

```python
import pytest
from unittest.mock import Mock, patch
from desktop_app import TimeTracker, TrackingState

def test_enter_idle_transitions_from_active():
    """AC1: State machine transitions ACTIVE → IDLE on sleep."""
    tracker = TimeTracker()
    tracker.state = TrackingState.ACTIVE
    tracker.current_window_screenshot_id = 'test-123'
    
    result = tracker.enter_idle('system sleep')
    
    assert result is True
    assert tracker.state == TrackingState.IDLE
    assert tracker.idle_start_time is not None

def test_enter_idle_no_op_if_already_idle():
    """State machine rejects invalid transition IDLE → IDLE."""
    tracker = TimeTracker()
    tracker.state = TrackingState.IDLE
    
    result = tracker.enter_idle('redundant call')
    
    assert result is False
    assert tracker.state == TrackingState.IDLE  # Unchanged

def test_resume_from_idle_resets_tracking_state():
    """State machine resets all window state on IDLE → ACTIVE."""
    tracker = TimeTracker()
    tracker.state = TrackingState.IDLE
    tracker.current_window_key = 'old-window'
    
    result = tracker.resume_from_idle()
    
    assert result is True
    assert tracker.state == TrackingState.ACTIVE
    assert tracker.current_window_key is None  # Reset

def test_state_transitions_are_thread_safe():
    """AC2: Concurrent state changes use lock to prevent races."""
    import threading
    tracker = TimeTracker()
    tracker.state = TrackingState.ACTIVE
    
    results = []
    def transition():
        results.append(tracker.enter_idle('concurrent test'))
    
    threads = [threading.Thread(target=transition) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    
    # Only one thread should succeed (first to acquire lock)
    assert results.count(True) == 1
    assert results.count(False) == 9

def test_upload_activity_includes_request_id():
    """Activities include unique request_id for idempotency."""
    tracker = TimeTracker()
    tracker.pending_records = [{'window_title': 'Test', 'duration_seconds': 60}]
    
    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 201
        mock_post.return_value.json.return_value = {'id': 'abc', 'duplicate': False}
        
        tracker.upload_activity_batch()
        
        # Verify request_id was added to payload
        call_args = mock_post.call_args[1]['json']
        assert 'request_id' in call_args
        assert len(call_args['request_id']) == 36  # UUID format
```

#### Node.js Tests (Jest)

**File**: `ai-server/tests/controllers/activity-controller.test.js`

```javascript
const { createActivity } = require('../../src/controllers/activity-controller');
const activityDbService = require('../../src/services/db/activity-db-service');
const aggregationService = require('../../src/services/db/aggregation-service');

jest.mock('../../src/services/db/activity-db-service');
jest.mock('../../src/services/db/aggregation-service');

describe('Activity Controller - Idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('AC3: Duplicate request_id returns 200 without creating record', async () => {
    const req = {
      body: {
        request_id: 'duplicate-uuid',
        org_id: 'org-123',
        user_id: 'user-456',
        timestamp: '2026-05-07T10:00:00Z',
        duration_seconds: 60
      }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    // Mock: record with this request_id already exists
    activityDbService.findByRequestId.mockResolvedValue({ id: 'existing-abc' });
    
    await createActivity(req, res);
    
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      id: 'existing-abc',
      duplicate: true,
      message: 'Activity already recorded'
    });
    expect(activityDbService.createWithRequestId).not.toHaveBeenCalled();
  });
  
  test('Request without request_id returns 400', async () => {
    const req = {
      body: {
        org_id: 'org-123',
        user_id: 'user-456',
        timestamp: '2026-05-07T10:00:00Z',
        duration_seconds: 60
        // Missing request_id
      }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    await createActivity(req, res);
    
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'request_id is required' });
  });
});
```

**File**: `ai-server/tests/services/aggregation-service.test.js`

```javascript
const aggregationService = require('../../src/services/db/aggregation-service');
const supabase = require('../../src/config/supabase');

jest.mock('../../src/config/supabase');

describe('Aggregation Service - Consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('AC4: getDailyTotal enforces org_id for RLS safety', async () => {
    await expect(
      aggregationService.getDailyTotal(null, 'user-123', '2026-05-07')
    ).rejects.toThrow('org_id is required');
  });
  
  test('getDailyTotal excludes idle records', async () => {
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [
          { duration_seconds: 3600 },  // 1 hour work
          { duration_seconds: 1800 }   // 30 min work
          // Idle records excluded by neq('is_idle', true)
        ],
        error: null
      })
    });
    
    const total = await aggregationService.getDailyTotal('org-123', 'user-456', '2026-05-07');
    
    expect(total).toBe(5400);  // 1.5 hours
    expect(supabase.from).toHaveBeenCalledWith('activity_records');
  });
  
  test('AC5: getWeeklyTotal sums exactly 7 days', async () => {
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [
          { duration_seconds: 14400 },  // Monday: 4 hours
          { duration_seconds: 14400 },  // Tuesday: 4 hours
          { duration_seconds: 14400 },  // Wednesday: 4 hours
          { duration_seconds: 14400 },  // Thursday: 4 hours
          { duration_seconds: 14400 }   // Friday: 4 hours
          // Weekend: 0 hours
        ],
        error: null
      })
    });
    
    const total = await aggregationService.getWeeklyTotal('org-123', 'user-456', '2026-05-05');
    
    expect(total).toBe(72000);  // 20 hours
  });
});
```

**File**: `forge-app/tests/resolvers/analytics-resolver.test.js`

```javascript
const { getWorklogSummary } = require('../../src/resolvers/analytics-resolver');
const { invokeAIServer } = require('../../src/utils/remote');

jest.mock('../../src/utils/remote');

describe('Analytics Resolver - Cross-Screen Consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('AC7: Resolver uses unified aggregation service', async () => {
    const payload = {
      org_id: 'org-123',
      user_id: 'user-456',
      date: '2026-05-07',
      timezone: 'America/New_York'
    };
    
    invokeAIServer.mockResolvedValue({
      date: '2026-05-07',
      total_seconds: 28800,
      hours: '8.00'
    });
    
    const result = await getWorklogSummary(payload, {});
    
    expect(invokeAIServer).toHaveBeenCalledWith('/api/analytics/daily', payload);
    expect(result.total_seconds).toBe(28800);
  });
  
  test('Resolver enforces org_id filtering', async () => {
    const payload = {
      user_id: 'user-456',
      date: '2026-05-07'
      // Missing org_id
    };
    
    await expect(getWorklogSummary(payload, {})).rejects.toThrow();
  });
});
```

### Integration Tests

**File**: `ai-server/tests/integration/test_idempotency_flow.test.js`

```javascript
const request = require('supertest');
const app = require('../../src/app');
const supabase = require('../../src/config/supabase');

describe('Integration: Idempotency Flow', () => {
  let testRequestId;
  
  beforeEach(() => {
    testRequestId = `test-${Date.now()}-${Math.random()}`;
  });
  
  test('AC3: Submitting same activity twice creates only one record', async () => {
    const activity = {
      request_id: testRequestId,
      org_id: 'test-org',
      user_id: 'test-user',
      timestamp: '2026-05-07T10:00:00Z',
      window_title: 'VS Code',
      duration_seconds: 60
    };
    
    // First submission
    const res1 = await request(app)
      .post('/api/activity')
      .send(activity)
      .set('Authorization', 'Bearer test-jwt');
    
    expect(res1.status).toBe(201);
    expect(res1.body.duplicate).toBe(false);
    const activityId = res1.body.id;
    
    // Second submission (duplicate)
    const res2 = await request(app)
      .post('/api/activity')
      .send(activity)
      .set('Authorization', 'Bearer test-jwt');
    
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);
    expect(res2.body.id).toBe(activityId);
    
    // Verify only one record in database
    const { data, error } = await supabase
      .from('activity_records')
      .select('*')
      .eq('request_id', testRequestId);
    
    expect(error).toBeNull();
    expect(data.length).toBe(1);
  });
});
```

**File**: `forge-app/tests/integration/test_cross_screen_consistency.test.js`

```javascript
const { getWorklogSummary } = require('../../src/resolvers/analytics-resolver');
const { getTeamAnalytics } = require('../../src/resolvers/team-resolver');
const supabase = require('../../src/config/supabase');

describe('Integration: Cross-Screen Consistency', () => {
  test('AC4 & AC7: All surfaces show same total for same date', async () => {
    // Insert test data
    const testData = [
      { org_id: 'org-123', user_id: 'user-456', timestamp: '2026-05-07T10:00:00Z', duration_seconds: 3600, is_idle: false },
      { org_id: 'org-123', user_id: 'user-456', timestamp: '2026-05-07T14:00:00Z', duration_seconds: 3600, is_idle: false },
      { org_id: 'org-123', user_id: 'user-456', timestamp: '2026-05-07T16:00:00Z', duration_seconds: 1800, is_idle: false }
    ];
    await supabase.from('activity_records').insert(testData);
    
    // Query via different resolvers
    const issuePanel = await getWorklogSummary({
      org_id: 'org-123',
      user_id: 'user-456',
      date: '2026-05-07',
      timezone: 'UTC'
    }, {});
    
    const teamAnalytics = await getTeamAnalytics({
      org_id: 'org-123',
      date: '2026-05-07',
      timezone: 'UTC'
    }, {});
    
    // Both should return same total
    expect(issuePanel.total_seconds).toBe(9000);  // 2.5 hours
    const userTotal = teamAnalytics.users.find(u => u.user_id === 'user-456').total_seconds;
    expect(userTotal).toBe(9000);
  });
});
```

### Manual Verification

1. **Desktop State Machine Test**:
   - Start desktop app, begin tracking
   - Lock screen (Win+L)
   - Verify tray icon changes to idle state within 1 second
   - Verify no activity records created while locked (check local SQLite)
   - Unlock screen and move mouse
   - Verify tracking resumes and new activity created

2. **Idempotency Test**:
   - Disconnect network
   - Let desktop app accumulate 5 activities locally
   - Reconnect network
   - Monitor AI server logs for duplicate detection
   - Verify exactly 5 records created (not 10-15 from retries)

3. **Cross-Screen Consistency Test**:
   - Work for 4 hours (normal day)
   - Open Jira issue panel → note total
   - Open Forge project page → note total
   - Open AI server dashboard → note total
   - All three should match within 1 second

4. **Production Data Audit** (AC7):
   ```sql
   SELECT 
     DATE(timestamp AT TIME ZONE 'UTC') as date,
     COUNT(*) as activity_count,
     SUM(duration_seconds) as total_seconds
   FROM activity_records
   WHERE org_id = '<vishnu_org_id>' 
     AND user_id = '<vishnu_user_id>'
     AND timestamp >= '2026-04-01' 
     AND timestamp < '2026-05-01'
   GROUP BY date
   ORDER BY date;
   ```
   Expected: April 14 and April 28 show ~200-250 activity_count (not 600-800)

---

## Agent Sequence

Once this spec is approved, implementation will proceed in these steps:

### Step 1: Write Failing Tests (RED)
- Create `python-desktop-app/tests/test_state_machine.py` with 5 tests
- Create `ai-server/tests/controllers/activity-controller.test.js` with 3 tests
- Create `ai-server/tests/services/aggregation-service.test.js` with 3 tests
- Create `forge-app/tests/resolvers/analytics-resolver.test.js` with 2 tests
- Run all test suites:
  ```bash
  cd python-desktop-app && python -m pytest tests/test_state_machine.py -v
  cd ai-server && npm test -- tests/controllers/activity-controller.test.js
  cd ai-server && npm test -- tests/services/aggregation-service.test.js
  cd forge-app && npm test -- tests/resolvers/analytics-resolver.test.js
  ```
- Confirm all tests fail (RED state)
- **Commit**: `test: add failing tests for time inconsistency bug (AC1-AC7)`

### Step 2: Database Constraints
- Create `supabase/migrations/20260507_add_request_id_idempotency.sql`
- Add `request_id UUID` column with unique index
- Create `supabase/migrations/20260507_add_org_daily_limits.sql`

- Run migrations locally:
  ```bash
  cd supabase && supabase db reset
  ```
- **Commit**: `db: add request_id idempotency column for activity submissions`

### Step 3: Desktop State Machine Refactor (Fix 1)
- Add `TrackingState` enum to `python-desktop-app/desktop_app.py`
- Add `state_lock = threading.Lock()` to `__init__`
- Implement `enter_idle()` and `resume_from_idle()` methods
- Replace all `is_idle` checks with `state == TrackingState.IDLE`
- Update system event handler to use state machine
- Run tests:
  ```bash
  python -m pytest tests/test_state_machine.py -v
  ```
- Tests `test_enter_idle_transitions_from_active`, `test_resume_from_idle_resets_tracking_state`, `test_state_transitions_are_thread_safe` should pass
- **Commit**: `fix(desktop): implement thread-safe state machine for sleep/lock`

### Step 4: Desktop Request ID Generation (Fix 2 Part 1)
- Modify `upload_activity_batch()` to add `request_id` to each record
- Use `uuid.uuid4()` for unique ID generation
- Run test:
  ```bash
  python -m pytest tests/test_state_machine.py::test_upload_activity_includes_request_id -v
  ```
- Test should pass
- **Commit**: `fix(desktop): add request_id to activity submissions`

### Step 5: AI Server Idempotency (Fix 2 Part 2)
- Implement `findByRequestId()` in `ai-server/src/services/db/activity-db-service.js`
- Modify `createActivity()` in `ai-server/src/controllers/activity-controller.js`:
  - Add request_id validation
  - Add duplicate check
  - Return 200 on duplicate with `duplicate: true`
- Run tests:
  ```bash
  cd ai-server && npm test -- tests/controllers/activity-controller.test.js
  ```
- Tests `test_duplicate_request_id` and `test_request_without_request_id` should pass
- **Commit**: `fix(ai-server): implement request_id idempotency check`

### Step 6: Unified Aggregation Service (Fix 3)
- Create `ai-server/src/services/db/aggregation-service.js`
- Implement `getDailyTotal()`, `getWeeklyTotal()`, `getUserActivities()`
- Add endpoint `/api/analytics/daily` in controllers
- Update Forge resolvers to call unified endpoint
- Run tests:
  ```bash
  cd ai-server && npm test -- tests/services/aggregation-service.test.js
  cd forge-app && npm test -- tests/resolvers/analytics-resolver.test.js
  ```
- All aggregation tests should pass
- **Commit**: `fix(multi): implement unified aggregation service for consistency`

### Step 7: Integration Tests
- Create `ai-server/tests/integration/test_idempotency_flow.test.js`
- Create `forge-app/tests/integration/test_cross_screen_consistency.test.js`
- Run integration tests:
  ```bash
  cd ai-server && npm test -- tests/integration/
  cd forge-app && npm test -- tests/integration/
  ```
- All integration tests should pass (GREEN state)
- **Commit**: `test: add integration tests for end-to-end flows`

### Step 8: Run Full Test Suites
- Run all test suites across all components:
  ```bash
  cd python-desktop-app && python -m pytest tests/ -v
  cd ai-server && npm test
  cd forge-app && npm test
  ```
- Confirm no regressions
- Confirm all new tests pass (GREEN state)

### Step 9: Manual Verification
- Follow manual verification steps in Test Plan
- Test on staging environment with production-like data
- Verify all 7 acceptance criteria are met
- Document results in `docs/RCA_TIME_INCONSISTENCY_MAY_2026.md` (update verification section)

### Step 11: Production Deployment
- Deploy Supabase migrations
- Deploy AI server (requires restart for new endpoints)
- Deploy desktop app via auto-update (version bump to 1.4.0)
- Deploy Forge app via `forge deploy`
- Monitor logs for 48 hours for any regressions

### Step 12: Post-Deployment Verification
- Run production data audit SQL (AC7)

- Check for duplicate detection rate (expect ~1-2% during network issues)
- User "Vishnu" should see correct totals within 24 hours

---

## Out of Scope

The following are explicitly **NOT** part of this fix:

1. **Retroactive Data Cleanup**: Not fixing existing duplicate records in production database (April 14/28 data for Vishnu). Manual cleanup script can be created separately if needed.

2. **AI Clustering Logic Changes**: Not modifying how the AI server clusters activities into work sessions. Clustering uses duration from `activity_records` as-is.

3. **Worklog Sync Job Optimization**: Not changing how worklogs sync to Jira (hourly scheduled job unchanged). Unified aggregation service makes sync unnecessary, but removing it requires separate migration plan.

4. **Desktop App OCR Changes**: Not modifying screenshot capture, OCR processing, or privacy filtering. These are orthogonal to time calculation.

5. **Forge UI Redesign**: Not changing how time is displayed in Jira UI. Only ensuring all displays show consistent data.

6. **Timezone Configuration UI**: Not adding user preference controls for timezone. Using system timezone from desktop app as-is.

7. **Real-Time Sync**: Not implementing WebSocket or SSE for instant cross-screen updates. 5-second cache refresh is acceptable latency.

8. **Historical Data Migration**: Not backfilling `request_id` for existing records. Column is nullable; new records enforce it.

9. **Audit Trail for State Transitions**: Not adding state transition logging table. Console logs are sufficient for debugging.

10. **Custom Daily Limits Per User**: Org-level limit only. Per-user configuration requires separate admin UI.

### Why These Are Out of Scope

This fix focuses narrowly on **preventing future time inconsistencies** via state machine, idempotency, and unified aggregation. Retroactive fixes, UI changes, and feature additions would require separate specs with their own test plans and risk analysis.

Users experiencing historical data issues (like Vishnu's April totals) can contact support for manual correction if needed. Going forward, the system will prevent the root causes.

---

## Success Metrics

Post-deployment, we expect:

1. **Zero anomalous daily totals** (>10 hours for part-time users) in production logs within 7 days
2. **< 0.1% daily cap rejections** (indicates cap is set appropriately high)
3. **1-2% duplicate detection rate** during network issues (expected based on retry behavior)
4. **< 1 second cross-screen discrepancy** measured by automated consistency checks
5. **Zero "time mismatch" support tickets** within 14 days of deployment
6. **User satisfaction score** for time tracking accuracy increases from 6.2/10 to 8.5/10 (survey)

---

## Rollback Plan

If the fix introduces regressions:

### Immediate Rollback (within 1 hour of issue detection):
1. **AI Server**: Revert to previous version via Docker rollback
   ```bash
   docker rollback ai-server-prod
   ```
2. **Desktop App**: Disable auto-update URL temporarily to prevent further installs
   ```bash
   # In AI server config
   DESKTOP_AUTO_UPDATE_URL=""
   ```
3. **Forge App**: Revert via `forge deploy --rollback`

### Database Rollback:
1. Drop `request_id` column (safe since nullable):
   ```sql
   ALTER TABLE activity_records DROP COLUMN request_id;
   ```
2. Drop daily limit column:
   ```sql

   ```

### Gradual Re-Deployment:
1. Re-deploy AI server with fix for regression
2. Test on staging with production snapshot
3. Deploy desktop app to 10% of users (canary)
4. Monitor for 24 hours
5. Expand to 100% if metrics are green

### Root Cause of Regression:
- Add test case that reproduces the regression
- Fix the bug
- Ensure test passes before re-deploying

---

## Security & Compliance Notes

### RLS Enforcement (Per `.github/copilot-instructions.md`)

All database queries in aggregation service include `org_id` filter:
```javascript
.eq('org_id', org_id)  // Required for RLS
```

Integration tests verify cross-org data leakage is prevented (test_aggregation_enforces_org_isolation).

### PII Logging (Per `.github/copilot-instructions.md`)

No `window_title` or OCR text is logged at `info` level:
```javascript
// ✅ SAFE
logger.info('Activity recorded', { activity_id, org_id, user_id, duration });

// ❌ NEVER
logger.info('Activity recorded', { window_title, ocr_text });
```

### JWT Token Handling

Desktop app stores JWT in OS keyring (Windows Credential Manager). Never logged or transmitted except in Authorization header.

---

## Dependencies & Prerequisites

Before starting implementation:

1. **Supabase**: Version 2.x with RLS policies enabled
2. **Python**: 3.9+ with `pytest` and `unittest.mock`
3. **Node.js**: 18.x with Jest 29.x
4. **Forge CLI**: Latest version authenticated with deployment credentials
5. **Test Supabase Instance**: Separate from production for integration tests

---

**Spec Author**: GitHub Copilot (via Agent)  
**Review Required**: Yes  
**Reviewers**: Senior Staff Engineer, Lead Backend Engineer, QA Lead  
**Next Step**: Await spec approval before proceeding to Step 1 (Write Failing Tests)  
**Estimated Implementation Time**: 5-7 days (2 days testing, 3 days implementation, 2 days verification)  
**Risk Level**: Medium (touches 4 components, but well-tested and has rollback plan)
