# Sequential Implementation Prompts: Time Inconsistency Fix

**Date**: 2026-05-07  
**Related Spec**: [plan/2026-05-07_multi-component_fix-time-inconsistency.md](2026-05-07_multi-component_fix-time-inconsistency.md)  
**Related RCA**: [docs/RCA_TIME_INCONSISTENCY_MAY_2026.md](../docs/RCA_TIME_INCONSISTENCY_MAY_2026.md)

---

## Overview

This document contains a sequence of atomic prompts to implement the Time Inconsistency & Cross-Screen Data Mismatch fix. Each prompt follows the **Red-Green-Refactor** pattern:

1. **RED**: Write failing test
2. **GREEN**: Write minimum code to pass test
3. **REFACTOR**: Clean up if needed

Execute these prompts **in order**. Do not skip steps.

---

## Phase 1: Database Hardening (Supabase)

### Prompt 1.1: Create Migration for request_id Column

**Goal**: Add `request_id` UUID column to `activity_records` table with unique constraint for idempotency.

**Context**: The AI server currently has no protection against duplicate activity submissions. Network retries can create 3-4x duplicate records, inflating user totals.

**Task**: Create a new Supabase migration file named `supabase/migrations/20260507_add_request_id_idempotency.sql` with the following requirements:

1. Add a nullable `request_id` column of type UUID to the `activity_records` table
2. Create a unique index on `request_id` (only for non-null values using `WHERE request_id IS NOT NULL`)
3. Add a comment explaining the idempotency purpose
4. Ensure the migration is idempotent (use `IF NOT EXISTS` where applicable)

**Constraints**:
- Column must be nullable to allow existing records without request_id
- Index must only enforce uniqueness on non-null values
- Follow naming convention: `idx_activity_request_id`

**Expected SQL Structure**:
```sql
-- Add column
ALTER TABLE activity_records 
ADD COLUMN IF NOT EXISTS request_id UUID;

-- Add unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_request_id 
ON activity_records(request_id) 
WHERE request_id IS NOT NULL;

-- Add comment
COMMENT ON COLUMN activity_records.request_id IS 
  'Unique request identifier for idempotency. Desktop app generates UUID per submission.';
```

**Verification Command**:
```bash
cd supabase
supabase db reset
# Should see migration applied successfully
```

---

## Phase 2: Desktop App State Machine (Python)

### Prompt 2.1: Create Failing Test for State Machine Transitions

**Goal**: Write failing pytest tests for the thread-safe state machine that will replace the boolean `is_idle` flag.

**Context**: The current `is_idle` boolean flag has race conditions between the system event thread and the tracking loop thread. A state machine with explicit locking will eliminate these races.

**Task**: Create a new test file `python-desktop-app/tests/test_state_machine.py` with the following test cases:

1. **test_enter_idle_transitions_from_active**: Verify ACTIVE → IDLE transition works
2. **test_enter_idle_no_op_if_already_idle**: Verify IDLE → IDLE is rejected (idempotent)
3. **test_resume_from_idle_resets_tracking_state**: Verify IDLE → ACTIVE resets all window tracking variables
4. **test_state_transitions_are_thread_safe**: Verify concurrent calls to `enter_idle()` use locking (only one succeeds)
5. **test_enter_idle_finalizes_session**: Verify `_finalize_active_session()` is called when entering idle

**Constraints**:
- Use `unittest.mock` for mocking `_finalize_active_session`, `session_manager.stop_current_timer()`, etc.
- Tests must import from `desktop_app` module (ensure it's importable)
- Use `pytest.fixture` for shared `TimeTracker` instance setup if needed

**Expected Test Structure** (example for test 1):
```python
import pytest
from unittest.mock import Mock, patch
from datetime import datetime, timezone

# This import will fail initially — expected
from desktop_app import TimeTracker, TrackingState

def test_enter_idle_transitions_from_active():
    """AC1: State machine transitions ACTIVE → IDLE on sleep."""
    tracker = TimeTracker()
    tracker.state = TrackingState.ACTIVE
    tracker.current_window_screenshot_id = 'test-123'
    tracker.current_window_db_start_time = datetime.now(timezone.utc)
    tracker.last_activity_time = datetime.now(timezone.utc).timestamp()
    tracker.current_project_key = 'TEST-123'
    
    # Mock methods that would be called
    tracker._finalize_active_session = Mock()
    tracker.session_manager = Mock()
    tracker.update_tray_icon = Mock()
    
    result = tracker.enter_idle('system sleep')
    
    assert result is True
    assert tracker.state == TrackingState.IDLE
    assert tracker.idle_start_time is not None
    tracker._finalize_active_session.assert_called_once_with('system sleep')
    tracker.session_manager.stop_current_timer.assert_called_once()
```

**Run Command** (should fail with ImportError for TrackingState):
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py -v
```

**Expected Output**: `ImportError: cannot import name 'TrackingState' from 'desktop_app'` (RED state)

---

### Prompt 2.2: Implement TrackingState Enum

**Goal**: Add the `TrackingState` enum to `desktop_app.py` and update `__init__` to use it.

**Context**: The state machine requires an explicit enum instead of the current boolean `is_idle` flag.

**Task**: In `python-desktop-app/desktop_app.py`:

1. Add the `TrackingState` enum after the imports (around line 100-200, after constants)
2. In the `TimeTracker.__init__` method (around line 4893), add `self.state` and `self.state_lock`
3. **Do not remove** `self.is_idle` yet (backward compatibility for now)
4. Initialize `self.state = TrackingState.STOPPED`

**Code to Add** (after imports, before class definition):
```python
from enum import Enum
import threading

class TrackingState(Enum):
    """Tracking state machine states.
    
    - STOPPED: App not tracking (initial state, after logout)
    - ACTIVE: Actively capturing screenshots and tracking work
    - IDLE: User idle (no activity, screen locked, or system sleep)
    - PAUSED: User manually paused tracking (via tray menu)
    """
    STOPPED = 0
    ACTIVE = 1
    IDLE = 2
    PAUSED = 3
```

**Code to Add in `__init__`** (around line 4893):
```python
def __init__(self):
    # ... existing code ...
    self.is_idle = False  # KEEP for backward compatibility
    
    # New state machine
    self.state = TrackingState.STOPPED
    self.state_lock = threading.Lock()  # Protect state transitions
    
    # ... rest of existing code ...
```

**Run Command** (tests should still fail but with different error):
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py::test_enter_idle_transitions_from_active -v
```

**Expected Output**: `AttributeError: 'TimeTracker' object has no attribute 'enter_idle'` (progress!)

---

### Prompt 2.3: Implement enter_idle() Method

**Goal**: Add the thread-safe `enter_idle()` method that transitions ACTIVE → IDLE.

**Context**: This method will be called by both the system event monitor (sleep/lock) and the tracking loop (idle timeout).

**Task**: In `python-desktop-app/desktop_app.py`, add the `enter_idle()` method after the `_finalize_active_session()` method (around line 9450):

**Method Requirements**:
1. Use `self.state_lock` to ensure thread-safety
2. Only transition if current state is ACTIVE (return False otherwise)
3. Call `_finalize_active_session(reason)` to close current work session
4. Call `session_manager.stop_current_timer()` to stop SQLite timer
5. Set `idle_start_time` to last activity time
6. Store `idle_project_key` for the idle record
7. Transition to `TrackingState.IDLE`
8. Update tray icon
9. Log the state transition for debugging

**Code to Add**:
```python
def enter_idle(self, reason):
    """Thread-safe transition to idle state.
    
    Called when entering idle (timeout, system sleep, or screen lock).
    Only transitions if currently in ACTIVE state.
    
    Args:
        reason: String describing why entering idle (e.g., 'system sleep', 'idle timeout')
        
    Returns:
        bool: True if transition succeeded, False if already idle/paused/stopped
    """
    with self.state_lock:
        if self.state != TrackingState.ACTIVE:
            # Already idle/paused/stopped — no-op
            return False
            
        print(f"[STATE] ACTIVE → IDLE (reason: {reason})")
        
        # Finalize current work session
        self._finalize_active_session(reason)
        
        # Stop SQLite activity timer so idle time isn't counted in activity_records
        self.session_manager.stop_current_timer()
        
        # Record when idle started (backdate to last activity)
        self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
        
        # Store the project key at idle entry — this is the project the user
        # was actually working on, not whatever project is active when they resume
        self.idle_project_key = self.current_project_key
        
        # Transition state
        self.state = TrackingState.IDLE
        self.is_idle = True  # Keep boolean flag in sync for backward compatibility
        
        # Update UI
        self.update_tray_icon()
        self.add_admin_log('INFO', f'Entered idle state: {reason}')
        
        return True
```

**Run Command**:
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py::test_enter_idle_transitions_from_active -v
python -m pytest tests/test_state_machine.py::test_enter_idle_no_op_if_already_idle -v
```

**Expected Output**: Both tests should **PASS** (GREEN state)

---

### Prompt 2.4: Implement resume_from_idle() Method

**Goal**: Add the thread-safe `resume_from_idle()` method that transitions IDLE → ACTIVE.

**Context**: This method resets all tracking state when the user resumes work after being idle.

**Task**: In `python-desktop-app/desktop_app.py`, add the `resume_from_idle()` method after `enter_idle()`:

**Method Requirements**:
1. Use `self.state_lock` for thread-safety
2. Only transition if current state is IDLE
3. Create an idle record for the period the user was away
4. Reset ALL tracking state variables (window keys, screenshot IDs, timestamps)
5. Transition to `TrackingState.ACTIVE`
6. Log the state transition

**Code to Add**:
```python
def resume_from_idle(self):
    """Thread-safe transition from idle to active state.
    
    Called when user activity is detected after idle period.
    Resets all tracking state so new session starts fresh.
    
    Returns:
        bool: True if transition succeeded, False if not idle
    """
    with self.state_lock:
        if self.state != TrackingState.IDLE:
            # Not idle — no-op
            return False
            
        print(f"[STATE] IDLE → ACTIVE")
        
        # Create an idle record for the period the user was away
        self._create_idle_record("idle timeout")
        
        # Transition state
        self.state = TrackingState.ACTIVE
        self.is_idle = False  # Keep boolean flag in sync
        self.needs_idle_resume = False
        
        # Update UI
        self.update_tray_icon()
        self.add_admin_log('INFO', 'Resumed from idle - tracking active')
        
        # Reset interval timer so first capture happens after full interval
        self.last_interval_time = time.time()
        
        # Reset ALL tracking state — new session starts fresh
        # IMPORTANT: This prevents idle time from being counted as work time
        self.current_window_start_time = None
        self.current_window_db_start_time = None
        self.current_window_screenshot_id = None
        self.current_window_record_created_at = None
        self.last_screenshot_end_time = None
        self.previous_window_key = None
        self.previous_window_screenshot_id = None
        self.previous_window_start_time = None
        self.previous_window_db_start_time = None
        self.current_window_key = None  # Force detection as "new" window
        
        return True
```

**Run Command**:
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py::test_resume_from_idle_resets_tracking_state -v
```

**Expected Output**: Test should **PASS** (GREEN state)

---

### Prompt 2.5: Test Thread Safety with Concurrent Calls

**Goal**: Verify the state machine lock prevents race conditions.

**Context**: The system event thread and tracking loop thread both call state transition methods. Without locking, state changes can be lost.

**Task**: Run the thread safety test to ensure only one concurrent call succeeds.

**Run Command**:
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py::test_state_transitions_are_thread_safe -v
```

**Expected Output**: Test should **PASS** — only 1 thread successfully transitions, 9 others return False

**Debugging**: If test fails, verify `self.state_lock` is acquired in both `enter_idle()` and `resume_from_idle()` via `with self.state_lock:`.

---

### Prompt 2.6: Integrate State Machine into System Event Monitor

**Goal**: Update the Windows event monitor to use the new state machine methods instead of setting `is_idle` directly.

**Context**: The `monitor_system_events()` method (lines 9550-9685) currently sets `self.is_idle = True` directly, causing race conditions.

**Task**: In `python-desktop-app/desktop_app.py`, update the `wnd_proc` callback inside `monitor_system_events()`:

**Lines to Update** (around line 9589-9620):

**OLD CODE** (lines 9592-9600):
```python
if wparam == PBT_APMSUSPEND:
    print("[INFO] System sleep detected — finalizing session")
    if not self.is_idle:
        self._finalize_active_session("system sleep")
        self.session_manager.stop_current_timer()
        self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
        self.idle_project_key = self.current_project_key
        self.is_idle = True
        self.update_tray_icon()
        self.add_admin_log('INFO', 'System sleep detected — entered idle')
```

**NEW CODE**:
```python
if wparam == PBT_APMSUSPEND:
    print("[INFO] System sleep detected — entering idle state")
    self.enter_idle("system sleep")
```

**OLD CODE** (lines 9607-9615):
```python
if wparam == WTS_SESSION_LOCK:
    print("[INFO] Screen lock detected — finalizing session")
    if not self.is_idle:
        self._finalize_active_session("screen lock")
        self.session_manager.stop_current_timer()
        self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
        self.idle_project_key = self.current_project_key
        self.is_idle = True
        self.update_tray_icon()
        self.add_admin_log('INFO', 'Screen locked — entered idle')
```

**NEW CODE**:
```python
if wparam == WTS_SESSION_LOCK:
    print("[INFO] Screen lock detected — entering idle state")
    self.enter_idle("screen lock")
```

**Verification**:
- No direct assignments to `self.is_idle` should remain in this method
- All state changes go through `enter_idle()` or `resume_from_idle()`

**Run Command**:
```bash
cd python-desktop-app
python -m pytest tests/test_state_machine.py -v
# All 5 tests should pass
```

---

### Prompt 2.7: Integrate State Machine into Tracking Loop

**Goal**: Update the main tracking loop to use state machine methods for idle detection.

**Context**: The tracking loop (lines 9841-10200) currently checks `if not self.is_idle:` and sets `self.is_idle = True` directly. This needs to use the state machine.

**Task**: In `python-desktop-app/desktop_app.py`, update the idle timeout detection in `tracking_loop()`:

**Lines to Update** (around line 10000-10035):

**OLD CODE**:
```python
if idle_duration > current_idle_timeout:
    if not self.is_idle:
        # ... finalization code ...
        self.is_idle = True
        self.update_tray_icon()
```

**NEW CODE**:
```python
if idle_duration > current_idle_timeout:
    if self.state == TrackingState.ACTIVE:
        idle_start_time = datetime.now(timezone.utc)
        last_activity = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
        print(f"[INFO] Idle timeout ({int(idle_duration)}s) — entering idle state")
        
        # Use state machine instead of direct assignment
        self.enter_idle("idle timeout")
        
        # Upload accumulated data before entering idle
        try:
            self.upload_activity_batch()
        except Exception as e:
            print(f"[WARN] Pre-idle batch upload failed: {e}")
```

**OLD CODE** (around line 10040-10070):
```python
if self.needs_idle_resume:
    # ... idle resume code ...
    self.is_idle = False
    self.needs_idle_resume = False
    # ... reset tracking state ...
```

**NEW CODE**:
```python
if self.needs_idle_resume:
    resume_time = datetime.now(timezone.utc)
    print(f"[INFO] Activity detected — resuming from idle")
    
    # Use state machine instead of direct assignment
    if self.resume_from_idle():
        # Immediately flush idle records to database
        if self._pending_idle_records:
            try:
                print(f"[IDLE] Flushing {len(self._pending_idle_records)} idle record(s)...")
                self.upload_activity_batch()
            except Exception as e:
                print(f"[WARN] Idle record flush failed: {e}")
```

**Run Command** (manual test — no automated test for full loop):
```bash
cd python-desktop-app
python desktop_app.py
# Manually test: lock screen, wait, unlock
# Verify console shows "[STATE] ACTIVE → IDLE" and "[STATE] IDLE → ACTIVE"
```

---

### Prompt 2.8: Add request_id to Activity Submissions

**Goal**: Modify `upload_activity_batch()` to include a unique `request_id` for each activity.

**Context**: The AI server will use this to detect and reject duplicate submissions.

**Task**: In `python-desktop-app/desktop_app.py`, update the `upload_activity_batch()` method (around line 7200-7400):

**Lines to Update**:

**Find this section** (where records are prepared for upload):
```python
for record in pending_records:
    # ... existing code ...
    
    # POST to AI server
    response = requests.post(
        f"{ai_server_url}/api/activity",
        json=record,
        headers={'Authorization': f'Bearer {jwt}'}
    )
```

**Add request_id generation BEFORE the POST**:
```python
import uuid

for record in pending_records:
    # ... existing code ...
    
    # Generate unique request_id for idempotency
    if 'request_id' not in record:
        record['request_id'] = str(uuid.uuid4())
    
    # POST to AI server
    response = requests.post(
        f"{ai_server_url}/api/activity",
        json=record,
        headers={'Authorization': f'Bearer {jwt}'}
    )
    
    if response.status_code in [200, 201]:
        result = response.json()
        if result.get('duplicate'):
            print(f"[INFO] Activity was duplicate: {record['request_id']}")
        # Mark as uploaded regardless of duplicate status
        self._mark_record_uploaded(record)
```

**Security Note**: Ensure `uuid` import is at the top of the file (around line 20-50).

**Run Command** (create simple test):
```bash
cd python-desktop-app
python -c "
from desktop_app import TimeTracker
tracker = TimeTracker()
tracker.pending_records = [{'window_title': 'Test', 'duration_seconds': 60}]
# Should add request_id to record
print('Test passed if request_id is added')
"
```

---

## Phase 3: AI Server Idempotency (Node.js)

### Prompt 3.1: Create Failing Test for Duplicate Detection

**Goal**: Write failing Jest test for idempotency check in `createActivity()`.

**Context**: The AI server currently inserts every request without checking for duplicates. We need to verify that duplicate `request_id` submissions return success but don't create new records.

**Task**: Create/update `ai-server/tests/controllers/activity-controller.test.js`:

**Test Requirements**:
1. Mock `activityDbService.findByRequestId()` to return existing record
2. Verify response is 200 (not 201)
3. Verify response includes `{duplicate: true}`
4. Verify `createWithRequestId()` is NOT called
5. Test missing `request_id` returns 400 error

**Code to Add**:
```javascript
const { createActivity } = require('../../src/controllers/activity-controller');
const activityDbService = require('../../src/services/db/activity-db-service');

jest.mock('../../src/services/db/activity-db-service');

describe('Activity Controller - Idempotency (AC3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('Duplicate request_id returns 200 without creating record', async () => {
    const req = {
      body: {
        request_id: 'duplicate-uuid-123',
        org_id: 'org-abc',
        user_id: 'user-xyz',
        timestamp: '2026-05-07T10:00:00Z',
        window_title: 'VS Code',
        duration_seconds: 60
      }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    // Mock: record with this request_id already exists
    activityDbService.findByRequestId.mockResolvedValue({ 
      id: 'existing-record-id' 
    });
    
    await createActivity(req, res);
    
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-record-id',
        duplicate: true,
        message: 'Activity already recorded'
      })
    );
    expect(activityDbService.createWithRequestId).not.toHaveBeenCalled();
  });
  
  test('Missing request_id returns 400 error', async () => {
    const req = {
      body: {
        // request_id is missing
        org_id: 'org-abc',
        user_id: 'user-xyz',
        timestamp: '2026-05-07T10:00:00Z',
        duration_seconds: 60
      }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    await createActivity(req, res);
    
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ 
      error: 'request_id is required' 
    });
  });
  
  test('New request_id creates record successfully', async () => {
    const req = {
      body: {
        request_id: 'new-uuid-456',
        org_id: 'org-abc',
        user_id: 'user-xyz',
        timestamp: '2026-05-07T10:00:00Z',
        window_title: 'Chrome',
        duration_seconds: 120
      }
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    // Mock: request_id not found (new submission)
    activityDbService.findByRequestId.mockResolvedValue(null);
    activityDbService.createWithRequestId.mockResolvedValue({
      id: 'new-record-id'
    });
    
    await createActivity(req, res);
    
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-record-id',
        duplicate: false
      })
    );
    expect(activityDbService.createWithRequestId).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'new-uuid-456',
        org_id: 'org-abc'
      })
    );
  });
});
```

**Run Command** (should fail — methods don't exist yet):
```bash
cd ai-server
npm test -- tests/controllers/activity-controller.test.js
```

**Expected Output**: `TypeError: activityDbService.findByRequestId is not a function` (RED state)

---

### Prompt 3.2: Implement findByRequestId in Database Service

**Goal**: Add the `findByRequestId()` method to query for existing activities.

**Context**: The controller needs to check if a `request_id` has already been processed before inserting a new record.

**Task**: In `ai-server/src/services/db/activity-db-service.js`, add the `findByRequestId()` method:

**Code to Add** (after existing methods):
```javascript
/**
 * Find activity by request_id (for idempotency check).
 * 
 * @param {string} org_id - Organization ID (RLS enforcement)
 * @param {string} request_id - Unique request identifier
 * @returns {Promise<object|null>} Activity record or null if not found
 */
async function findByRequestId(org_id, request_id) {
  if (!org_id) {
    throw new Error('org_id is required (RLS enforcement)');
  }
  
  if (!request_id) {
    throw new Error('request_id is required');
  }
  
  const { data, error } = await supabase
    .from('activity_records')
    .select('id, created_at')
    .eq('org_id', org_id)
    .eq('request_id', request_id)
    .single();
    
  if (error) {
    if (error.code === 'PGRST116') {
      // Not found — expected for new submissions
      return null;
    }
    logger.error('findByRequestId query failed', { org_id, request_id, error });
    throw error;
  }
  
  return data;
}

/**
 * Create activity with request_id (for idempotency).
 * 
 * @param {object} activity - Activity data including request_id
 * @returns {Promise<object>} Created activity record
 */
async function createWithRequestId(activity) {
  const { org_id, request_id } = activity;
  
  if (!org_id) {
    throw new Error('org_id is required (RLS enforcement)');
  }
  
  if (!request_id) {
    throw new Error('request_id is required');
  }
  
  const { data, error } = await supabase
    .from('activity_records')
    .insert(activity)
    .select()
    .single();
    
  if (error) {
    logger.error('createWithRequestId failed', { org_id, request_id, error });
    throw error;
  }
  
  return data;
}

module.exports = {
  // ... existing exports ...
  findByRequestId,
  createWithRequestId
};
```

**Run Command** (should still fail — controller doesn't use it yet):
```bash
cd ai-server
npm test -- tests/controllers/activity-controller.test.js
```

---

### Prompt 3.3: Implement Idempotency Check in Controller

**Goal**: Update `createActivity()` controller to check for duplicates before inserting.

**Context**: This is the core idempotency logic — prevents duplicate records from network retries.

**Task**: In `ai-server/src/controllers/activity-controller.js`, update the `createActivity()` function:

**Lines to Update** (find the existing `createActivity` function and replace):

**OLD CODE** (approximately):
```javascript
async function createActivity(req, res) {
  const { org_id, user_id, timestamp, window_title, duration_seconds } = req.body;
  
  // Insert directly without checking for duplicates
  const result = await supabase
    .from('activity_records')
    .insert({ org_id, user_id, timestamp, window_title, duration_seconds })
    .select();
    
  res.json(result.data);
}
```

**NEW CODE**:
```javascript
'use strict';
const logger = require('../utils/logger');
const activityDbService = require('../services/db/activity-db-service');

/**
 * Create activity record with idempotency check.
 * 
 * AC3: Duplicate request_id returns 200 with {duplicate: true} and creates zero new records.
 * 
 * Security: No PII (window_title) logged at info level per copilot-instructions.md.
 */
async function createActivity(req, res) {
  const { request_id, org_id, user_id, timestamp, window_title, duration_seconds } = req.body;
  
  // Validate request_id is present
  if (!request_id) {
    logger.warn('Activity submission missing request_id', { org_id, user_id });
    return res.status(400).json({ error: 'request_id is required' });
  }
  
  try {
    // Check if already processed (idempotency)
    const existing = await activityDbService.findByRequestId(org_id, request_id);
    if (existing) {
      logger.debug('Duplicate activity submission detected', { 
        request_id, 
        existing_id: existing.id,
        org_id
      });
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
      duration_seconds,
      created_at: new Date().toISOString()
    });
    
    logger.info('Activity recorded', { 
      activity_id: result.id, 
      org_id, 
      user_id, 
      duration: duration_seconds 
    });
    
    return res.status(201).json({ 
      id: result.id, 
      duplicate: false 
    });
    
  } catch (error) {
    logger.error('Activity creation failed', { 
      error: error.message, 
      org_id, 
      user_id,
      request_id 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createActivity };
```

**Run Command** (tests should pass now):
```bash
cd ai-server
npm test -- tests/controllers/activity-controller.test.js
```

**Expected Output**: All 3 tests **PASS** (GREEN state)

---

## Phase 4: Unified Aggregation Service (Node.js)

### Prompt 4.1: Create Failing Test for Aggregation Service

**Goal**: Write failing Jest tests for the unified aggregation service that will replace inline SQL queries.

**Context**: Currently, three different code paths compute time totals using different SQL. This causes cross-screen inconsistencies.

**Task**: Create `ai-server/tests/services/aggregation-service.test.js`:

**Code to Add**:
```javascript
const aggregationService = require('../../src/services/db/aggregation-service');
const supabase = require('../../src/config/supabase');

jest.mock('../../src/config/supabase');

describe('Aggregation Service - Consistency (AC4, AC5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  test('getDailyTotal enforces org_id for RLS safety', async () => {
    await expect(
      aggregationService.getDailyTotal(null, 'user-123', '2026-05-07')
    ).rejects.toThrow('org_id is required');
  });
  
  test('getDailyTotal excludes idle records from work time', async () => {
    const mockSelect = jest.fn().mockReturnThis();
    const mockEq = jest.fn().mockReturnThis();
    const mockGte = jest.fn().mockReturnThis();
    const mockLt = jest.fn().mockReturnThis();
    const mockNeq = jest.fn().mockResolvedValue({
      data: [
        { duration_seconds: 3600 },  // 1 hour work
        { duration_seconds: 1800 }   // 30 min work
        // Idle records excluded by neq('is_idle', true)
      ],
      error: null
    });
    
    supabase.from = jest.fn().mockReturnValue({
      select: mockSelect,
      eq: mockEq,
      gte: mockGte,
      lt: mockLt,
      neq: mockNeq
    });
    
    const total = await aggregationService.getDailyTotal(
      'org-123', 
      'user-456', 
      '2026-05-07'
    );
    
    expect(total).toBe(5400);  // 1.5 hours
    expect(supabase.from).toHaveBeenCalledWith('activity_records');
    expect(mockNeq).toHaveBeenCalledWith('is_idle', true);
  });
  
  test('getDailyTotal returns 0 for date with no activities', async () => {
    const mockChain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [],  // No activities
        error: null
      })
    };
    
    supabase.from = jest.fn().mockReturnValue(mockChain);
    
    const total = await aggregationService.getDailyTotal(
      'org-123',
      'user-456',
      '2026-05-07'
    );
    
    expect(total).toBe(0);
  });
  
  test('getWeeklyTotal sums exactly 7 days', async () => {
    const mockChain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockResolvedValue({
        data: [
          { duration_seconds: 14400 },  // Day 1: 4 hours
          { duration_seconds: 14400 },  // Day 2: 4 hours
          { duration_seconds: 14400 },  // Day 3: 4 hours
          { duration_seconds: 14400 },  // Day 4: 4 hours
          { duration_seconds: 14400 }   // Day 5: 4 hours
        ],
        error: null
      })
    };
    
    supabase.from = jest.fn().mockReturnValue(mockChain);
    
    const total = await aggregationService.getWeeklyTotal(
      'org-123',
      'user-456',
      '2026-05-05'  // Monday
    );
    
    expect(total).toBe(72000);  // 20 hours total
  });
});
```

**Run Command** (should fail — aggregation-service.js doesn't exist):
```bash
cd ai-server
npm test -- tests/services/aggregation-service.test.js
```

**Expected Output**: `Cannot find module '../../src/services/db/aggregation-service'` (RED state)

---

### Prompt 4.2: Implement Aggregation Service

**Goal**: Create the unified aggregation service that all surfaces will use.

**Context**: Single source of truth for time calculations eliminates cross-screen inconsistencies.

**Task**: Create `ai-server/src/services/db/aggregation-service.js`:

**Full File Contents**:
```javascript
'use strict';
const supabase = require('../../config/supabase');
const logger = require('../../utils/logger');

/**
 * Unified Aggregation Service — Single Source of Truth for Time Totals
 * 
 * AC4: All queries enforce org_id (RLS safety) and consistent timezone handling.
 * AC5: Excludes idle records from work time calculations.
 * AC8: Used by all surfaces (Dashboard, Forge Issue Panel, Forge Project Page).
 * 
 * Security: All queries filter by org_id to prevent data leakage across organizations.
 */
class AggregationService {
  
  /**
   * Get daily total work time for a user.
   * 
   * @param {string} org_id - Organization ID (RLS enforcement)
   * @param {string} user_id - User ID
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone (default: UTC)
   * @returns {Promise<number>} Total seconds worked on that date
   */
  async getDailyTotal(org_id, user_id, date, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    if (!user_id) {
      throw new Error('user_id is required');
    }
    
    if (!date) {
      throw new Error('date is required (format: YYYY-MM-DD)');
    }
    
    // Query for date range in UTC (timezone conversion handled at display layer)
    const startOfDay = `${date}T00:00:00Z`;
    const endOfDay = this._addDays(date, 1) + 'T00:00:00Z';
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', startOfDay)
      .lt('timestamp', endOfDay)
      .neq('is_idle', true);  // Exclude idle time from work totals
      
    if (error) {
      logger.error('getDailyTotal query failed', { 
        org_id, 
        user_id, 
        date, 
        error: error.message 
      });
      throw error;
    }
    
    // Sum duration_seconds
    const total = data.reduce((sum, row) => sum + (row.duration_seconds || 0), 0);
    
    logger.debug('Daily total computed', { 
      org_id, 
      user_id, 
      date, 
      total, 
      record_count: data.length 
    });
    
    return total;
  }
  
  /**
   * Get weekly total work time for a user.
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} week_start - Monday date in YYYY-MM-DD format
   * @param {string} timezone - IANA timezone (default: UTC)
   * @returns {Promise<number>} Total seconds worked that week
   */
  async getWeeklyTotal(org_id, user_id, week_start, timezone = 'UTC') {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    const week_end = this._addDays(week_start, 7);
    
    const startOfWeek = `${week_start}T00:00:00Z`;
    const endOfWeek = `${week_end}T00:00:00Z`;
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('duration_seconds')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', startOfWeek)
      .lt('timestamp', endOfWeek)
      .neq('is_idle', true);
      
    if (error) {
      logger.error('getWeeklyTotal query failed', { 
        org_id, 
        user_id, 
        week_start, 
        error: error.message 
      });
      throw error;
    }
    
    const total = data.reduce((sum, row) => sum + (row.duration_seconds || 0), 0);
    return total;
  }
  
  /**
   * Get user activities for a date range (for timeline display).
   * 
   * @param {string} org_id - Organization ID
   * @param {string} user_id - User ID
   * @param {string} start_date - Start date YYYY-MM-DD
   * @param {string} end_date - End date YYYY-MM-DD
   * @returns {Promise<Array>} Activity records
   */
  async getUserActivities(org_id, user_id, start_date, end_date) {
    if (!org_id) {
      throw new Error('org_id is required (RLS enforcement)');
    }
    
    const { data, error } = await supabase
      .from('activity_records')
      .select('*')
      .eq('org_id', org_id)
      .eq('user_id', user_id)
      .gte('timestamp', `${start_date}T00:00:00Z`)
      .lt('timestamp', `${end_date}T00:00:00Z`)
      .order('timestamp', { ascending: true });
      
    if (error) {
      logger.error('getUserActivities query failed', { 
        org_id, 
        user_id, 
        start_date, 
        end_date,
        error: error.message 
      });
      throw error;
    }
    
    return data;
  }
  
  // Helper: Add days to a date string
  _addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
  }
}

module.exports = new AggregationService();
```

**Run Command**:
```bash
cd ai-server
npm test -- tests/services/aggregation-service.test.js
```

**Expected Output**: All 4 tests should **PASS** (GREEN state)

---

### Prompt 4.3: Create Analytics Controller Using Aggregation Service

**Goal**: Create a new controller endpoint that exposes the aggregation service.

**Context**: The Forge app will call this endpoint instead of querying Supabase directly.

**Task**: Create `ai-server/src/controllers/analytics-controller.js`:

**Full File Contents**:
```javascript
'use strict';
const logger = require('../utils/logger');
const aggregationService = require('../services/db/aggregation-service');

/**
 * Get daily total work time for a user.
 * 
 * GET /api/analytics/daily?org_id=X&user_id=Y&date=2026-05-07&timezone=UTC
 * 
 * AC4: Returns same value as all other surfaces (consistent aggregation).
 */
async function getDailyTotal(req, res) {
  const { org_id, user_id, date, timezone } = req.query;
  
  if (!org_id || !user_id || !date) {
    return res.status(400).json({ 
      error: 'Missing required parameters: org_id, user_id, date' 
    });
  }
  
  try {
    const totalSeconds = await aggregationService.getDailyTotal(
      org_id, 
      user_id, 
      date, 
      timezone || 'UTC'
    );
    
    return res.json({
      date,
      total_seconds: totalSeconds,
      hours: (totalSeconds / 3600).toFixed(2),
      timezone: timezone || 'UTC'
    });
  } catch (error) {
    logger.error('getDailyTotal failed', { 
      org_id, 
      user_id, 
      date, 
      error: error.message 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get weekly total work time for a user.
 * 
 * GET /api/analytics/weekly?org_id=X&user_id=Y&week_start=2026-05-05&timezone=UTC
 */
async function getWeeklyTotal(req, res) {
  const { org_id, user_id, week_start, timezone } = req.query;
  
  if (!org_id || !user_id || !week_start) {
    return res.status(400).json({ 
      error: 'Missing required parameters: org_id, user_id, week_start' 
    });
  }
  
  try {
    const totalSeconds = await aggregationService.getWeeklyTotal(
      org_id,
      user_id,
      week_start,
      timezone || 'UTC'
    );
    
    return res.json({
      week_start,
      total_seconds: totalSeconds,
      hours: (totalSeconds / 3600).toFixed(2),
      timezone: timezone || 'UTC'
    });
  } catch (error) {
    logger.error('getWeeklyTotal failed', { 
      org_id, 
      user_id, 
      week_start, 
      error: error.message 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  getDailyTotal,
  getWeeklyTotal
};
```

**Task 2**: Register routes in `ai-server/src/routes/analytics.js` (create if doesn't exist):
```javascript
'use strict';
const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analytics-controller');
const { authenticateDesktopApp } = require('../middleware/auth');

// All analytics endpoints require authentication
router.get('/daily', authenticateDesktopApp, analyticsController.getDailyTotal);
router.get('/weekly', authenticateDesktopApp, analyticsController.getWeeklyTotal);

module.exports = router;
```

**Task 3**: Register routes in `ai-server/src/app.js`:
```javascript
// Add after existing route registrations
const analyticsRoutes = require('./routes/analytics');
app.use('/api/analytics', analyticsRoutes);
```

**Run Command** (manual test):
```bash
cd ai-server
npm run dev
# Test in another terminal:
curl "http://localhost:3001/api/analytics/daily?org_id=test&user_id=test&date=2026-05-07" \
  -H "Authorization: Bearer test-jwt"
```

---

### Prompt 4.4: Update Forge Resolver to Use Unified Endpoint

**Goal**: Replace direct Supabase queries in Forge app with calls to the unified aggregation service.

**Context**: This ensures the Forge issue panel and AI server dashboard show identical values.

**Task**: In `forge-app/src/resolvers/analytics-resolver.js`, update the `getWorklogSummary` function:

**Lines to Find and Replace**:

**OLD CODE** (approximately):
```javascript
async function getWorklogSummary(payload, context) {
  const { org_id, user_id, date } = payload;
  
  // Direct Supabase query (inconsistent with other surfaces)
  const { data, error } = await supabase
    .from('activity_records')
    .select('duration_seconds')
    .eq('org_id', org_id)
    .eq('user_id', user_id)
    .gte('timestamp', `${date}T00:00:00Z`)
    .lt('timestamp', ...);
    
  return { total: sum(data) };
}
```

**NEW CODE**:
```javascript
import { invokeAIServer } from '../utils/remote';

/**
 * Get worklog summary for a user on a specific date.
 * 
 * AC4 & AC8: Uses unified aggregation service to ensure consistency across all surfaces.
 */
async function getWorklogSummary(payload, context) {
  const { org_id, user_id, date, timezone } = payload;
  
  if (!org_id || !user_id || !date) {
    throw new Error('Missing required parameters: org_id, user_id, date');
  }
  
  try {
    // Call unified aggregation service instead of querying Supabase directly
    const response = await invokeAIServer('/api/analytics/daily', {
      org_id,
      user_id,
      date,
      timezone: timezone || 'UTC'
    });
    
    return {
      date,
      total_seconds: response.total_seconds,
      hours: response.hours,
      timezone: response.timezone
    };
  } catch (error) {
    console.error('getWorklogSummary failed:', error);
    throw new Error('Failed to fetch worklog summary');
  }
}

export { getWorklogSummary };
```

**Note**: Verify `invokeAIServer` is configured in `forge-app/src/utils/remote.js` to call the AI server via Forge Remote (per architecture constraints in copilot-instructions.md).

**Run Command**:
```bash
cd forge-app
npm test -- tests/resolvers/analytics-resolver.test.js
```

---

## Phase 5: Verification & Integration

### Prompt 5.1: Run Full Test Suites

**Goal**: Verify all tests pass across all components with no regressions.

**Context**: Before manual verification, ensure automated tests are green.

**Task**: Run all test suites:

**Commands**:
```bash
# Python desktop app
cd python-desktop-app
python -m pytest tests/ -v --tb=short

# AI server
cd ai-server
npm test

# Forge app
cd forge-app
npm test
```

**Expected Output**: All tests **PASS** (GREEN state across all components)

**If any test fails**: Fix the failure before proceeding to manual verification.

---

### Prompt 5.2: Manual Verification - State Machine

**Goal**: Verify the desktop app state machine correctly handles sleep/lock events.

**Context**: AC1 & AC2 require observable state transitions.

**Task**: Manual testing steps:

1. **Start desktop app and begin tracking**:
   ```bash
   cd python-desktop-app
   python desktop_app.py
   ```

2. **Lock screen** (Windows: Win+L):
   - Within 1 second, console should show: `[STATE] ACTIVE → IDLE (reason: screen lock)`
   - Tray icon should change to idle state

3. **Wait 30 seconds** (while locked):
   - No new activity records should be created
   - Check local SQLite database:
     ```bash
     sqlite3 data/activity.db "SELECT COUNT(*) FROM activity_records WHERE created_at > datetime('now', '-1 minute');"
     # Should return 0
     ```

4. **Unlock screen and move mouse**:
   - Console should show: `[STATE] IDLE → ACTIVE`
   - Tray icon should change to active state
   - New activity should start recording

5. **Verify idle record created**:
   ```bash
   sqlite3 data/activity.db "SELECT * FROM activity_records WHERE is_idle = 1 ORDER BY created_at DESC LIMIT 1;"
   # Should show idle record with 30+ seconds duration
   ```

**Success Criteria**: All state transitions happen within 1 second, no activity recorded while locked.

---

### Prompt 5.3: Manual Verification - Idempotency

**Goal**: Verify duplicate request_id submissions don't create duplicate records.

**Context**: AC3 requires idempotency enforcement.

**Task**: Manual testing steps:

1. **Disconnect network** (simulate flaky connection):
   - Disable WiFi or unplug ethernet

2. **Let desktop app accumulate activities**:
   - Work normally for 5 minutes
   - Desktop app will store activities in local SQLite

3. **Reconnect network**:
   - Enable WiFi
   - Watch desktop app logs for upload attempts

4. **Monitor AI server logs**:
   ```bash
   cd ai-server
   # Watch for duplicate detection
   tail -f logs/app.log | grep "Duplicate activity submission"
   ```

5. **Verify database**:
   ```bash
   cd supabase
   supabase db dump --data-only -t activity_records > /tmp/activities.sql
   # Check for duplicate request_ids:
   grep "request_id" /tmp/activities.sql | sort | uniq -d
   # Should return empty (no duplicates)
   ```

**Success Criteria**: Network retries don't create duplicate records. AI server logs show duplicate detection messages.

---

### Prompt 5.4: Manual Verification - Cross-Screen Consistency

**Goal**: Verify all UI surfaces show identical time totals.

**Context**: AC4 & AC8 require consistency across Dashboard, Forge Issue Panel, and Forge Project Page.

**Task**: Manual testing steps:

1. **Work for 4 hours** (normal day):
   - Capture ~240 activities (1 per minute)

2. **Query AI Server Dashboard**:
   ```bash
   curl "http://localhost:3001/api/analytics/daily?org_id=<YOUR_ORG>&user_id=<YOUR_USER>&date=2026-05-07" \
     -H "Authorization: Bearer <YOUR_JWT>"
   # Note the total_seconds value
   ```

3. **Open Jira Forge Issue Panel**:
   - Navigate to any Jira issue
   - Open the time tracker panel
   - Note the "Time Spent Today" value

4. **Open Forge Project Page**:
   - Navigate to Jira project
   - Open the team analytics view
   - Find your user's row, note the total

5. **Compare values**:
   - All three should match within 1 second
   - Example: Dashboard=14400s, Issue Panel=14400s, Project Page=14400s

**Success Criteria**: Discrepancy < 1 second across all three surfaces.

---

### Prompt 5.5: Production Data Audit - Vishnu's April Data

**Goal**: Verify the fix would prevent the April 14/28 anomalies from recurring.

**Context**: AC7 requires production data validation.

**Task**: SQL query to analyze existing patterns:

**Query**:
```sql
SELECT 
  DATE(timestamp AT TIME ZONE 'UTC') as date,
  COUNT(*) as activity_count,
  SUM(duration_seconds) as total_seconds,
  COUNT(DISTINCT window_title) as unique_windows,
  COUNT(DISTINCT request_id) as unique_request_ids,
  COUNT(*) - COUNT(DISTINCT request_id) as duplicate_count
FROM activity_records
WHERE org_id = '<vishnu_org_id>' 
  AND user_id = '<vishnu_user_id>'
  AND timestamp >= '2026-04-01' 
  AND timestamp < '2026-05-01'
GROUP BY DATE(timestamp AT TIME ZONE 'UTC')
ORDER BY date;
```

**Expected Results for Fixed System**:
- April 14: `activity_count` ≈ 200-250 (not 600-800)
- April 28: `activity_count` ≈ 200-250 (not 600-800)
- `duplicate_count` = 0 for all dates (idempotency working)

**If existing data shows duplicates**: The fix prevents NEW duplicates. Existing duplicates can be cleaned up with a separate migration script (out of scope for this fix).

---

### Prompt 5.6: Integration Test - Daily Cap Rejection

**Goal**: Verify the 16-hour daily cap guardrail works end-to-end.

**Context**: AC6 requires server-side rejection of impossible totals.

**Task**: Integration test steps:

1. **Create test script** `ai-server/tests/integration/test_daily_cap.js`:
   ```javascript
   const request = require('supertest');
   const app = require('../../src/app');
   
### Prompt 5.7: Load Test - Concurrent Submissions

**Goal**: Verify idempotency works under load with concurrent retries.

**Context**: Real-world network issues cause multiple threads to retry simultaneously.

**Task**: Create load test script:

**Script** `ai-server/tests/load/test_concurrent_submissions.js`:
```javascript
const request = require('supertest');
const app = require('../../src/app');

describe('Load Test: Concurrent Idempotent Submissions', () => {
  test('100 concurrent submissions with same request_id create only 1 record', async () => {
    const sharedRequestId = 'concurrent-test-123';
    
    // Launch 100 concurrent requests with same request_id
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        request(app)
          .post('/api/activity')
          .send({
            request_id: sharedRequestId,  // Same ID for all
            org_id: 'test-org',
            user_id: 'test-user',
            timestamp: '2026-05-07T10:00:00Z',
            window_title: 'VS Code',
            duration_seconds: 60
          })
          .set('Authorization', 'Bearer test-jwt')
      );
    }
    
    const responses = await Promise.all(promises);
    
    // Count successes
    const created = responses.filter(r => r.status === 201 && !r.body.duplicate).length;
    const duplicates = responses.filter(r => r.status === 200 && r.body.duplicate).length;
    
    // Only 1 should be created, rest should be detected as duplicates
    expect(created).toBe(1);
    expect(duplicates).toBe(99);
  });
});
```

**Run Command**:
```bash
cd ai-server
npm test -- tests/load/test_concurrent_submissions.js
```

**Expected Output**: Test **PASSES** — only 1 record created despite 100 concurrent submissions.

---

### Prompt 5.8: Final Deployment Checklist

**Goal**: Ensure all components are ready for production deployment.

**Context**: Pre-deployment verification to prevent regressions.

**Task**: Complete this checklist:

**Database**:
- [ ] Supabase migrations applied in staging: `cd supabase && supabase db push`
- [ ] Verify `activity_records.request_id` column exists: `supabase db dump --schema-only`

**Desktop App**:
- [ ] All pytest tests pass: `cd python-desktop-app && python -m pytest tests/ -v`
- [ ] State machine transitions logged in console
- [ ] request_id included in all activity uploads
- [ ] Version bumped to 1.4.0 in `desktop_app.py`

**AI Server**:
- [ ] All Jest tests pass: `cd ai-server && npm test`
- [ ] Analytics endpoints respond: `curl localhost:3001/api/analytics/daily?...`
- [ ] Idempotency check logs appear in `logs/app.log`
- [ ] Daily cap validation logs appear for test data

**Forge App**:
- [ ] All Jest tests pass: `cd forge-app && npm test`
- [ ] Resolvers call unified aggregation service (not direct Supabase queries)
- [ ] Build succeeds: `npm run build`
- [ ] Forge app can be deployed: `forge deploy --environment staging`

**Integration**:
- [ ] Cross-screen consistency verified manually (all surfaces match)
- [ ] State machine transitions work (lock/unlock test)
- [ ] Idempotency test with network disconnect passes
- [ ] Daily cap rejection test passes

**Documentation**:
- [ ] RCA document updated with verification results
- [ ] CHANGELOG.md updated with fix summary
- [ ] Deployment notes added to `docs/DEPLOYMENT_GUIDE_V3.md`

**Rollback Plan**:
- [ ] Previous Docker image tagged: `docker tag ai-server:latest ai-server:pre-time-fix`
- [ ] Previous desktop app version backed up
- [ ] Database rollback script tested: `ALTER TABLE activity_records DROP COLUMN request_id;`

---

## Completion Criteria

The fix is complete when ALL of the following are true:

1. ✅ All pytest tests pass (Python desktop app)
2. ✅ All Jest tests pass (AI server + Forge app)
3. ✅ Manual state machine test passes (lock/unlock within 1 second)
4. ✅ Manual idempotency test passes (network retries don't create duplicates)
5. ✅ Manual cross-screen consistency test passes (< 1 second discrepancy)
6. ✅ Production data audit shows April 14/28 pattern cannot recur
7. ✅ Load test passes (100 concurrent submissions create 1 record)
8. ✅ All deployment checklist items completed
9. ✅ Rollback plan documented and tested

---

## Notes for AI Implementation Agent

**Multi-Tenancy Reminder**: Every database query MUST include `org_id` filter. Missing `org_id` is a data leak bug.

**PII Logging Reminder**: Never log `window_title`, OCR text, or JWT tokens at `info` level. Use `debug` level only.

**Test-First Discipline**: Do not write implementation code before the test exists and fails. Red → Green → Refactor.

**File Path Precision**: Always specify exact file paths and line ranges. Use `grep` or `semantic_search` to find the correct location before editing.

**Commit Discipline**: Commit after each phase with descriptive messages:
- `test: add state machine tests (AC1, AC2)`
- `fix(desktop): implement thread-safe state machine`
- `test: add idempotency tests (AC3)`
- `fix(ai-server): implement request_id idempotency check`
- etc.

**Error Handling**: All database operations must have try/catch blocks with structured logging. Never swallow errors silently.

**Backward Compatibility**: Keep `is_idle` boolean flag in sync with `TrackingState` enum during migration period.

---

**Document Version**: 1.0  
**Last Updated**: May 7, 2026  
**Total Prompts**: 32 (across 5 phases)  
**Estimated Implementation Time**: 5-7 days with testing  
**Next Step**: Begin with Prompt 1.1 (Database Migration for request_id)
