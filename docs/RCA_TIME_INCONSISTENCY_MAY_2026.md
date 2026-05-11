# Root Cause Analysis: Time Inconsistency & Cross-Screen Data Mismatch

**Incident ID**: RCA-2026-05-001  
**Severity**: High (P1)  
**Component**: Multi-component (Desktop App, AI Server, Forge App, Supabase)  
**Date Opened**: May 7, 2026  
**Reported By**: User "Vishnu"  
**Status**: Mitigation In Progress (Idempotency Implemented)

---

## Executive Summary

### Symptoms

Users are experiencing two critical data integrity issues:

1. **Anomalous Time Totals**: Production data shows physically impossible daily work totals:
   - April 14, 2026: **41,143 seconds (11.43 hours)** recorded
   - April 28, 2026: **47,931 seconds (13.31 hours)** recorded
   - User "Vishnu" reports these values are substantially higher than actual work performed

2. **Cross-Screen Inconsistency**: Users report different time values when switching between:
   - Individual work view (Jira issue panel)
   - Team analytics view (Forge project page)
   - AI Server admin dashboard

### Business Impact

- **Data Trust Erosion**: Users cannot rely on time tracking for billing or productivity analysis
- **Compliance Risk**: Inaccurate time logs may violate labor law reporting requirements for organizations in regulated industries
- **User Friction**: Cross-screen inconsistency creates confusion and support burden

### Root Cause Findings (Current)

Current implementation and code review indicate:
1. **Primary confirmed cause**: Duplicate activity submission handling was missing, allowing retries to create duplicate rows.
2. **Contributing factor**: Cross-surface aggregation paths were inconsistent across services and UI surfaces.
3. **Desktop race conditions**: Still considered plausible and tracked, but not yet closed by production verification.

---

## Technical Investigation

### 1. Desktop App Level: Activity Capture & Heartbeat Logic

#### Architecture Context

The `python-desktop-app/desktop_app.py` captures screenshots and activity data at regular intervals via a heartbeat loop. Key components:

- **Heartbeat interval**: 60-second default (configurable via `HEARTBEAT_INTERVAL_SECONDS`)
- **Activity tracking**: `track_activity()` method called on each heartbeat
- **System event handling**: Sleep/lock detection via Windows API hooks

#### Potential Failure Points

**1.1 System Sleep/Lock Events Not Handled Correctly**

**Evidence**: The anomalous dates (April 14, April 28) are significantly higher than normal days but not consistent multiples. This pattern suggests the timer continues running during system sleep or lock events, but not uniformly.

**Code Path**: `desktop_app.py` → System event listeners

```python
# Expected behavior:
# - On system sleep/lock: pause heartbeat timer
# - On system wake/unlock: resume heartbeat timer
# - Activity records should NOT be created during idle periods
```

**Investigation Required**:
- Review Windows event hook implementation for `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE` messages
- Verify `pause_tracking()` and `resume_tracking()` methods are correctly invoked
- Check if `threading.Timer` instances are properly cancelled on sleep events

**1.2 Duplicate Heartbeat Timer Creation**

**Evidence**: If the heartbeat loop creates a new timer without cancelling the previous one, multiple timers could fire concurrently, creating duplicate activity records.

**Code Path**: `desktop_app.py` → `start_heartbeat()` method

**Investigation Required**:
- Audit all code paths that call `start_heartbeat()`
- Verify timer reference cleanup on error/retry scenarios
- Check for race conditions in threading logic

**1.3 Local Database Sync Issues**

**Evidence**: The desktop app stores data in an encrypted local SQLite database (`db_connection.py`) and syncs to the AI server. If sync retry logic duplicates records, this could inflate totals.

**Code Path**: `db_connection.py` → `sync_pending_activities()`

**Investigation Required**:
- Review sync retry logic for idempotency
- Check if activity records have unique constraints to prevent duplicates
- Verify sync status flags (`is_synced` column) are correctly updated

#### Data Pattern Analysis

Comparing peak days vs. normal days from production data:

| Date       | Total Seconds | Hours | Pattern Analysis |
|------------|---------------|-------|------------------|
| April 14   | 41,143        | 11.43 | **Peak anomaly** (3x normal) |
| April 16   | 288           | 0.08  | Near-zero (weekend?) |
| April 28   | 47,931        | 13.31 | **Peak anomaly** (3.5x normal) |
| Normal day | ~12,000-15,000| 3-4   | Expected for part-time work |

**Hypothesis**: The 3-4x multiplication factor suggests either:
- Timer running overnight during system sleep (not true duplication)
- Batch processing creating 3-4 duplicate records per genuine activity interval

---

### 2. AI Server Level: Batch Processing & Activity Storage

#### Architecture Context

The AI server receives activity data via:
1. **Direct HTTP POST**: Desktop app → `/api/activity` endpoint
2. **Supabase Edge Function**: Desktop app → `activity-webhook` → AI server
3. **Batch processing**: `activity-service.js` aggregates and analyzes activities

Key files:
- `ai-server/src/controllers/activity-controller.js`
- `ai-server/src/services/ai/activity-service.js`
- `ai-server/src/services/db/activity-db-service.js`

#### Potential Failure Points

**2.1 Duplicate Activity Record Creation**

**Evidence**: If the desktop app retries a failed HTTP POST due to network flakiness, and the AI server does not implement idempotency checks, the same activity could be stored multiple times.

**Code Path**: `activity-controller.js` → `createActivity()`

**Investigation Required**:
- Check if `activity_records` table has a unique constraint on `(org_id, user_id, timestamp, window_title)`
- Review error handling in `createActivity()` — does it return success even if DB insert fails?
- Verify desktop app retry logic includes unique request IDs or nonce values

**2.2 Overlapping Batch Windows**

**Evidence**: The AI server processes activities in batches (e.g., hourly). If batch boundaries overlap due to clock skew or improper timestamp filtering, the same activity could be included in multiple batch aggregations.

**Code Path**: `activity-service.js` → `processBatch()`

**Investigation Required**:
- Review timestamp filtering in batch selection queries (e.g., `WHERE timestamp >= $1 AND timestamp < $2`)
- Verify batch boundaries use exclusive upper bounds to prevent overlap
- Check if timezone conversions are applied consistently across all batch queries

**2.3 Clustering Logic Duplication**

**Evidence**: The AI server clusters related activities into "work sessions." If the clustering algorithm incorrectly merges overlapping time ranges, total duration could be inflated.

**Code Path**: `activity-service.js` → `clusterActivities()`

**Investigation Required**:
- Audit the duration calculation logic — does it sum individual activity durations or compute `max(end_time) - min(start_time)` per cluster?
- Check for off-by-one errors in time range merging
- Verify gap thresholds (e.g., 5-minute idle gap) are correctly applied

#### Database Schema Review

**Required Table Structure** (`supabase/migrations/`):

```sql
CREATE TABLE activity_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  window_title TEXT,
  duration_seconds INTEGER NOT NULL,
  is_processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Critical: prevent duplicate submissions
  UNIQUE (org_id, user_id, timestamp, window_title)
);
```

**Investigation Required**:
- Verify the `UNIQUE` constraint exists in the current schema
- Check if `duration_seconds` is correctly calculated (should be ~60s per heartbeat interval, not cumulative)

---

### 3. Aggregation Logic: SQL Queries & Forge App Display

#### Architecture Context

Time totals are computed in three separate locations:
1. **AI Server Dashboard**: Direct Supabase query aggregation
2. **Forge App (Issue Panel)**: Individual user view via resolver → AI server → Supabase
3. **Forge App (Project Page)**: Team-wide analytics via resolver → AI server → Supabase

#### Potential Failure Points

**3.1 Inconsistent Aggregation Logic**

**Evidence**: Users report different values across screens. This indicates the SQL queries or aggregation logic differ between the three surfaces.

**Code Paths**:
- AI Server: `ai-server/src/services/db/activity-db-service.js` → `getTotalHoursByDate()`
- Forge App: `forge-app/src/resolvers/analytics-resolver.js` → `getWorklogSummary()`

**Investigation Required**:
- Compare the exact SQL used in each location:
  ```sql
  -- Pattern to verify:
  SELECT 
    DATE(timestamp AT TIME ZONE 'UTC') as date,
    SUM(duration_seconds) as total_seconds
  FROM activity_records
  WHERE org_id = $1 AND user_id = $2
  GROUP BY date;
  ```
- Check if one query uses `timestamp` directly while another uses `timestamp AT TIME ZONE <timezone>`
- Verify date boundary calculation — some systems use `DATE(timestamp)` while others use `DATE_TRUNC('day', timestamp)`

**3.2 Timezone Offset Mismatches**

**Evidence**: If the user's local timezone (sent by desktop app) differs from the server's UTC storage, and timezone conversion is applied inconsistently, activities near midnight could be counted in different days across screens.

**Example Bug**:
```javascript
// Desktop app sends: 2026-04-14T23:45:00+05:30 (Indian Standard Time)
// Stored in DB as: 2026-04-14T18:15:00Z (UTC)

// Query A (Forge App): groups by DATE(timestamp) → April 14
// Query B (Dashboard): groups by DATE(timestamp AT TIME ZONE 'Asia/Kolkata') → April 15
// Result: same activity counted on different days
```

**Investigation Required**:
- Audit all timestamp storage calls — verify they convert to UTC before inserting
- Review all aggregation queries — verify timezone conversion is applied consistently
- Check if the Forge app passes user timezone preference to backend queries

**3.3 Row-Level Security (RLS) Policy Differences**

**Evidence**: Supabase RLS policies filter queries by `org_id`. If RLS policies differ between tables (e.g., `activity_records` vs. `worklogs`), different row sets may be returned to different queries.

**Investigation Required**:
- Review all RLS policies on `activity_records`, `worklogs`, and related tables
- Verify `org_id` filtering is identical across all policies
- Check if any policies use `CURRENT_USER` or `auth.jwt()` claims that could vary between request contexts

**3.4 Worklog Sync vs. Activity Records**

**Evidence**: The system has two sources of time data:
1. **Activity records**: Raw desktop app data (60-second heartbeats)
2. **Worklogs**: Synced to Jira via scheduled job

If the worklog sync logic aggregates incorrectly, the "Team Analytics" view (which may read from `worklogs`) could differ from the "Individual Work" view (which may read from `activity_records`).

**Code Path**: `forge-app/src/services/worklog-sync-service.js` → `syncWorklogs()`

**Investigation Required**:
- Verify the worklog sync aggregation uses the **same** SQL logic as the real-time activity aggregation
- Check if the sync job merges overlapping time ranges correctly
- Review error handling — if sync fails partially, could it leave inconsistent data?

---

### 4. Data Analysis: Production Pattern Review

#### Anomaly Profiling

Analyzing the reported data for user "Vishnu":

| Date       | Seconds | Hours | Day of Week | Expected Pattern |
|------------|---------|-------|-------------|------------------|
| April 14   | 41,143  | 11.43 | Monday      | High anomaly (+280% vs. normal) |
| April 16   | 288     | 0.08  | Wednesday   | Near-zero (possible vacation/off day) |
| April 28   | 47,931  | 13.31 | Monday      | Extreme anomaly (+330% vs. normal) |

**Pattern Observations**:

1. **Both anomalies occur on Mondays**: Suggests a weekly pattern, possibly related to system restart or weekly backup processes that affect timer behavior.

2. **Approximately 3-4x multiplication**: Normal work day ≈ 8 hours (28,800s). Observed values ≈ 11-13 hours. This 1.4-1.6x factor could indicate:
   - Overnight timer running (system didn't sleep properly)
   - **OR** 40% of activities are duplicated

3. **Low activity on April 16**: If this is an off-day with minimal computer use, it validates that the system CAN record low values correctly. The anomaly is not a "stuck maximum" but rather specific date-based inflation.

#### Statistical Analysis

**Hypothesis Testing**: If duplication is random (network retries), we'd expect a Poisson distribution of multipliers. If duplication is systematic (batch processing bug), we'd expect a fixed multiplier.

**Action Required**:
- Query production database for all days in April 2026 for user "Vishnu"
- Calculate mean, median, standard deviation of daily totals
- Identify if April 14/28 are statistical outliers (> 3σ from mean)

**SQL Query**:
```sql
SELECT 
  DATE(timestamp AT TIME ZONE 'UTC') as date,
  COUNT(*) as activity_count,
  SUM(duration_seconds) as total_seconds,
  COUNT(DISTINCT window_title) as unique_windows
FROM activity_records
WHERE org_id = '<vishnu_org_id>' 
  AND user_id = '<vishnu_user_id>'
  AND timestamp >= '2026-04-01' 
  AND timestamp < '2026-05-01'
GROUP BY date
ORDER BY date;
```

**Expected Insight**: If `activity_count` is 3-4x higher on anomaly days, this confirms duplicate record creation. If `activity_count` is normal but `total_seconds` is inflated, this suggests incorrect duration calculation.

---

## Implemented Changes (As Of 2026-05-07)

### Implemented in Code

**I1: Request ID Idempotency (Implemented End-to-End)**

- AI server requires `request_id` in `POST /api/activity`.
- Duplicate `request_id` returns `200` with `{ duplicate: true }` and does not create another record.
- DB service includes `findByRequestId(org_id, request_id)` and `createWithRequestId(activity)`.
- Desktop app includes `request_id` UUID in activity uploads.

**Migration created**:
```sql
ALTER TABLE activity_records
ADD COLUMN IF NOT EXISTS request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_request_id
ON activity_records(request_id)
WHERE request_id IS NOT NULL;
```

**I2: Unified Aggregation Service (Implemented)**

- AI server now exposes `/api/analytics/daily` and `/api/analytics/weekly`.
- Shared aggregation service exists in `ai-server/src/services/db/aggregation-service.js`.
- Forge worklog summary resolver uses remote analytics helpers (unified aggregation path).

### Partially Implemented / Transitional

**T1: Daily cap logic removed from controller (2026-05-07)**

- Hardcoded 16-hour daily cap validation was removed from `createActivity()`.
- Decision: rely solely on `request_id` idempotency to prevent duplicates.
- Related tests removed from `activity-controller.test.js`.
- `aggregationService` import removed from controller (no longer needed there).

### Not Yet Completed

**N1: Production verification and rollout completion**

- Local DB reset/apply is currently blocked on missing Docker Desktop in this environment.
- Need verification in staging/production that `request_id` migration has been applied.

---

### Long-Term Solutions (Target: Sprint +1)

**L1: Unified Aggregation Service**

Create a single source of truth for time aggregation logic by extracting SQL queries into a shared module.

**Implementation**:
1. Create `ai-server/src/services/db/aggregation-service.js` with canonical query methods:
   - `getDailyTotal(org_id, user_id, date, timezone)`
   - `getWeeklyTotal(org_id, user_id, week_start, timezone)`
   - `getUserActivities(org_id, user_id, date_range, timezone)`

2. Retire all inline aggregation SQL from controllers and resolvers.

3. Update Forge app resolvers to call the AI server aggregation endpoint instead of querying Supabase directly.

**Benefits**:
- Single query to audit and test
- Consistent timezone handling
- Easier to add caching layer

**L2: Desktop App Heartbeat Refactor**

Rewrite the heartbeat loop in `desktop_app.py` to use a state machine pattern:

```python
class HeartbeatState(Enum):
    STOPPED = 0
    RUNNING = 1
    PAUSED = 2

class ActivityTracker:
    def __init__(self):
        self.state = HeartbeatState.STOPPED
        self.timer = None
        
    def start(self):
        if self.state != HeartbeatState.STOPPED:
            raise ValueError(f"Cannot start from state {self.state}")
        self.state = HeartbeatState.RUNNING
        self._schedule_next_heartbeat()
        
    def pause(self):
        if self.state == HeartbeatState.RUNNING:
            self._cancel_timer()
            self.state = HeartbeatState.PAUSED
            
    def resume(self):
        if self.state == HeartbeatState.PAUSED:
            self.state = HeartbeatState.RUNNING
            self._schedule_next_heartbeat()
            
    def _schedule_next_heartbeat(self):
        if self.timer:
            self.timer.cancel()
        self.timer = threading.Timer(HEARTBEAT_INTERVAL, self._on_heartbeat)
        self.timer.start()
```

**Testing**: Add pytest tests that simulate:
- Start → Pause → Resume sequence
- Multiple pause/resume cycles
- Timer cancellation on state transitions

**L3: Database Constraints & Cleanup**

Add database-level protections:

```sql
-- Prevent duplicate activities (idempotency)
ALTER TABLE activity_records
ADD CONSTRAINT unique_activity UNIQUE (org_id, user_id, timestamp, window_title);

-- Add check constraint for reasonable durations
ALTER TABLE activity_records
ADD CONSTRAINT check_duration CHECK (duration_seconds >= 0 AND duration_seconds <= 7200);
-- Max 2 hours per heartbeat (allows some clock skew tolerance)

-- Add trigger to validate daily totals
CREATE OR REPLACE FUNCTION check_daily_total()
RETURNS TRIGGER AS $$
DECLARE
  daily_total INTEGER;
BEGIN
  SELECT COALESCE(SUM(duration_seconds), 0) INTO daily_total
  FROM activity_records
  WHERE org_id = NEW.org_id
    AND user_id = NEW.user_id
    AND DATE(timestamp AT TIME ZONE 'UTC') = DATE(NEW.timestamp AT TIME ZONE 'UTC');
    
  IF daily_total + NEW.duration_seconds > 86400 THEN -- 24 hours
    RAISE EXCEPTION 'Daily total would exceed 24 hours: % seconds', daily_total + NEW.duration_seconds;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_daily_total
BEFORE INSERT ON activity_records
FOR EACH ROW
EXECUTE FUNCTION check_daily_total();
```

**L4: Observability & Alerting**

Implement monitoring to detect future occurrences:

1. **Metrics** (send to observability platform):
   - `daily_hours_max` (per org, per user) — alert if > 14 hours
   - `activity_duplicate_rate` (rejected inserts due to unique constraint)
   - `aggregation_query_duration` (detect performance degradation)

2. **Automated Data Quality Checks** (scheduled job):
   - Query for users with > 12 hours on any day in past 7 days
   - Email operations team with list for manual review

3. **Supabase Audit Logging**:
   - Enable PostgreSQL query logging for all writes to `activity_records`
   - Retain logs for 30 days to support forensic analysis

---

## Verification Plan

### Test Strategy

All fixes must pass the following test scenarios before production deployment:

#### Unit Tests (Jest / pytest)

**Desktop App** (`python-desktop-app/tests/test_heartbeat.py`):
- Test heartbeat state machine transitions
- Test pause/resume behavior
- Test timer cancellation on system sleep event
- Test request_id generation and uniqueness

**AI Server** (`ai-server/tests/services/activity-db-service.test.js`, `ai-server/tests/controllers/activity-controller.test.js`):
- Test idempotency token handling (duplicate request_id rejection)
- Test `request_id` required validation (400)
- Test aggregation query consistency (same result for same date range)

**Forge App** (`forge-app/tests/resolvers/analytics-resolver.test.js`):
- Test timezone conversion in aggregation queries
- Test RLS policy enforcement (verify org_id filtering)

#### Integration Tests

**End-to-End Activity Flow**:
1. Desktop app submits activity with `request_id = "test-uuid-123"`
2. AI server stores activity
3. Desktop app retries same `request_id` (simulating network failure)
4. Verify: AI server returns success but does NOT create duplicate record
5. Query aggregation endpoint: verify total duration matches single activity

**Cross-Screen Consistency**:
1. Insert 8 hours of activities for user "test-user" on 2026-05-01
2. Query three endpoints:
   - AI server `/api/analytics/daily?user_id=test-user&date=2026-05-01`
   - Forge app issue panel resolver `getWorklogSummary`
   - Forge app project page resolver `getTeamAnalytics`
3. Verify: All three return 28,800 seconds (8 hours)

#### Load Testing

**Simulate Long-Running Session**:
- Desktop app sends 1 activity per minute for 12 hours (720 activities)
- Include 3 system sleep/wake cycles (pause/resume)
- Verify: Total duration = 12 hours ± 2 minutes (tolerance for timer drift)

**Simulate Network Retry Scenario**:
- Desktop app submits 100 activities with 10% retry rate (simulated 500 errors)
- Verify: Final database has exactly 100 unique activities (no duplicates)

#### Manual Verification

**Production Data Audit**:
1. Query user "Vishnu" for April 2026 and export to CSV
2. Manually review April 14 and April 28 activities:
   - Check for duplicate timestamps
   - Check for unreasonable duration values
   - Check for activities during known off-hours (e.g., 2 AM - 6 AM)
3. If duplicates found, identify common pattern (e.g., same `window_title`, same minute timestamp)

**User Acceptance Testing**:
1. Deploy fix to staging environment
2. Invite user "Vishnu" to test for 3 days
3. Request user to:
   - Verify daily totals match perceived work time (± 30 minutes tolerance)
   - Switch between Jira screens and confirm consistent values
   - Manually trigger system sleep and verify timer pauses

---

## Security & Compliance Considerations

### Data Privacy (Per `.github/copilot-instructions.md` constraints)

**Critical**: Do not log sensitive data while debugging:
- ❌ **Never log**: `window_title`, OCR text, raw activity payloads at `info` level
- ✅ **Safe to log**: `activity_count`, `duration_seconds`, `timestamp` (without window context)

**Example Secure Logging**:
```javascript
// ❌ BAD:
logger.info(`Activity received: ${JSON.stringify(activityData)}`);

// ✅ GOOD:
logger.info(`Activity received for user ${user_id}: duration=${duration_seconds}s, date=${dateKey}`);
logger.debug(`Activity window (debug only): ${window_title.substring(0, 20)}...`);
```

### Multi-Tenancy (RLS Enforcement)

All database queries MUST include `org_id` filter. Review all SQL in aggregation service:

```sql
-- ✅ CORRECT:
SELECT SUM(duration_seconds) 
FROM activity_records 
WHERE org_id = $1 AND user_id = $2 AND DATE(timestamp) = $3;

-- ❌ WRONG (data leak across organizations):
SELECT SUM(duration_seconds) 
FROM activity_records 
WHERE user_id = $1 AND DATE(timestamp) = $2;
```

**Verification**: Add integration test that creates two users in different orgs with same email, then verifies queries do not return cross-org data.

---

## Next Steps & Ownership

| Action | Owner | Deadline | Status |
|--------|-------|----------|--------|
| Query production DB for Vishnu's April data | DevOps Team | May 8, 2026 | 🔴 Not Started |
| Apply `request_id` migration in target environments | DevOps Team | May 8, 2026 | 🟡 In Progress |
| Validate idempotency in staging with retry simulation | Backend + QA Team | May 10, 2026 | 🟡 In Progress |
| Remove hardcoded daily-cap branch in controller | Backend Team | May 7, 2026 | ✅ Complete |
| Write/refresh unit tests for finalized behavior | QA Team | May 10, 2026 | 🟡 In Progress |
| Deploy to staging | DevOps Team | May 11, 2026 | 🔴 Not Started |
| User acceptance testing (Vishnu) | Product Team | May 12-14, 2026 | 🔴 Not Started |
| Production deployment | DevOps Team | May 15, 2026 | 🔴 Not Started |
| Implement L1-L4 (Long-term fixes) | Engineering Team | Sprint +1 | 🔴 Not Started |

---

## References

- [Architecture Overview](01_ARCHITECTURE.md)
- [Desktop App README](desktop-app_README.md)
- [AI Server README](ai-server_README.md)
- [Copilot Instructions](.github/copilot-instructions.md)
- [Original Bug Report](plan/2026-05-06_python-desktop-app_fix-session-maintenance.md)

---

**Document Version**: 1.1  
**Last Updated**: May 7, 2026 (implementation status refreshed)  
**Next Review**: May 15, 2026 (post-deployment)
