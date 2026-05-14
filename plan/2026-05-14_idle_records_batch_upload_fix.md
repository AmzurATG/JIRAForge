# Idle Records Batch Upload Failure — Root Cause Analysis & Fix Plan

**Date:** 2026-05-14  
**Component:** python-desktop-app  
**Severity:** HIGH — Data loss (idle records discarded on every batch)  
**Error Code:** PGRST102  
**Error Message:** "All object keys must match"

---

## 1. Problem Statement

The desktop application is failing to upload idle time records (breaks, lunch, inactivity periods) to the database. Every batch upload succeeds for work records but fails for idle records, with the following error pattern:

```
❌ ERROR: Batch upload failed: {'code': 'PGRST102', 'details': None, 'hint': None, 'message': 'All object keys must match'}
⚠️ WARN: Batch uploaded 4 work records. Idle records failed — check DB constraints.
```

**User Impact:**
- Idle time tracking records are permanently lost
- Total work hour calculations are inaccurate
- Timeline views missing idle periods
- Users cannot convert idle time to worklogs (feature broken)

---

## 2. Root Cause Analysis

### 2.1 PostgREST Batch Insert Constraint

PostgreSQL via PostgREST requires **all records in a batch insert to have identical keys**. When inserting multiple records:
- Record 1: `{a: 1, b: 2, c: 3}`
- Record 2: `{a: 4, b: 5}` ← Missing key `c`

PostgREST rejects the batch with `PGRST102: "All object keys must match"`.

### 2.2 Schema Mismatch Between Work and Idle Records

The desktop app creates two types of records with different schemas:

#### Work Records (created in batch upload loop, lines 8286-8343)
```python
record = {
    'user_id': self.current_user_id,
    'organization_id': self.organization_id,
    'window_title': s.get('window_title', ''),
    'application_name': s.get('application_name', ''),
    'classification': classification,
    'is_idle': is_lock_screen,
    'ocr_text': ocr_text,                    # ← Present
    'ocr_method': ocr_method,                # ← Present
    'ocr_confidence': ocr_confidence,        # ← Present
    'ocr_error_message': ocr_error_message,  # ← Present
    'total_time_seconds': int(s.get('total_time_seconds', 0)),
    'visit_count': s.get('visit_count', 1),  # ← Present
    'start_time': s.get('first_seen'),
    'end_time': s.get('last_seen'),
    'duration_seconds': int(s.get('total_time_seconds', 0)),
    'batch_timestamp': batch_timestamp,
    'batch_start': batch_start.isoformat(),
    'batch_end': batch_end.isoformat(),
    'work_date': _utc_ts_to_local_date(s.get('first_seen')),
    'user_timezone': get_local_timezone_name(),
    'project_key': record_project_key,
    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,  # ← Present
    'status': status,
    'request_id': str(uuid.uuid4()),
    'metadata': {...}
}
```

#### Idle Records (created in `_create_idle_record()`, lines 9617-9645)
```python
record = {
    'user_id': self.current_user_id,
    'organization_id': self.organization_id,
    'window_title': f'[Idle: {reason}]',
    'application_name': 'System',
    'classification': 'idle',
    'is_idle': True,
    'idle_start_time': self.idle_start_time.isoformat(),
    'idle_end_time': idle_end.isoformat(),
    'start_time': self.idle_start_time.isoformat(),
    'end_time': idle_end.isoformat(),
    'duration_seconds': idle_duration,
    'total_time_seconds': idle_duration,
    'work_date': _utc_ts_to_local_date(self.idle_start_time.isoformat()),
    'user_timezone': get_local_timezone_name(),
    'project_key': project_key,
    'status': 'analyzed',
    'request_id': str(uuid.uuid4()),
    'metadata': {...}
    # ❌ MISSING:
    # - ocr_text
    # - ocr_method
    # - ocr_confidence
    # - ocr_error_message
    # - visit_count
    # - user_assigned_issues
    # - batch_timestamp (added later, but inconsistently)
    # - batch_start (added later, but inconsistently)
    # - batch_end (added later, but inconsistently)
}
```

### 2.3 Critical Code Path

**File:** `python-desktop-app/desktop_app.py`

1. **Lines 8286-8343**: Work records built from SQLite sessions with full schema
2. **Lines 8346-8355**: Idle records appended to same batch
   ```python
   idle_records = list(self._pending_idle_records)
   for idle_rec in idle_records:
       # Add batch metadata (but missing other required fields)
       idle_rec['batch_timestamp'] = batch_timestamp
       idle_rec['batch_start'] = batch_start.isoformat()
       idle_rec['batch_end'] = batch_end.isoformat()
       records.append(idle_rec)  # ← Mixed schema records in same batch
   ```
3. **Line 8359**: Combined batch insert fails with PGRST102
   ```python
   result = self.supabase.table('activity_records').insert(records).execute()
   ```
4. **Lines 8592-8607**: Recovery attempt (work-only retry) also fails because `work_only_records` still filters the already-mixed-schema `records` list

### 2.4 Database Schema (Confirmed)

From `supabase/migrations/20260221_add_activity_records.sql`:

```sql
CREATE TABLE public.activity_records (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL,
    organization_id UUID,
    window_title TEXT,
    application_name TEXT,
    classification TEXT,
    ocr_text TEXT,              -- Nullable but must be present in ALL batch records
    ocr_method TEXT,            -- Nullable but must be present in ALL batch records
    ocr_confidence REAL,        -- Nullable but must be present in ALL batch records
    ocr_error_message TEXT,     -- Nullable but must be present in ALL batch records
    total_time_seconds INTEGER,
    visit_count INTEGER DEFAULT 1,  -- Has default, but must be in ALL batch records
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER,
    batch_timestamp TIMESTAMPTZ,
    batch_start TIMESTAMPTZ,
    batch_end TIMESTAMPTZ,
    work_date DATE,
    user_timezone TEXT,
    project_key TEXT,
    user_assigned_issue_key TEXT,
    user_assigned_issues TEXT,  -- Nullable but must be present in ALL batch records
    status TEXT DEFAULT 'pending',
    metadata JSONB DEFAULT '{}',
    -- Idle-specific columns (from 20260325_add_idle_time_support.sql)
    is_idle BOOLEAN DEFAULT FALSE,
    idle_start_time TIMESTAMPTZ,
    idle_end_time TIMESTAMPTZ,
    ...
);
```

**Key Finding:** Even though these columns are nullable, **PostgREST requires all records in a batch to have the same set of keys**, regardless of nullability.

---

## 3. Why Work Records Succeed But Idle Records Fail

The error message "Batch uploaded 4 work records. Idle records failed" is slightly misleading. What actually happens:

1. **Batch contains:** 4 work records + 2 idle records (different schemas)
2. **First insert attempt fails:** PGRST102 error (schema mismatch)
3. **Recovery code activates** (lines 8592-8607): Attempts work-only retry
4. **Work-only retry succeeds:** Filters `records` by `is_idle=False`, uploads successfully
5. **Idle records discarded:** Line 8601 clears `_pending_idle_records` to "prevent batch poisoning"
6. **Result:** Work records saved, idle records permanently lost

---

## 4. Secondary Issues

### 4.1 Batch Metadata Added Too Late
Idle records have `batch_timestamp`, `batch_start`, and `batch_end` added in the upload loop (lines 8348-8351), but this happens AFTER the record is already created with missing OCR and visit_count fields.

### 4.2 No Retry for Idle Records
Once idle records are discarded (line 8601), they are never retried. The app logs "check DB constraints" but provides no mechanism to recover the lost data.

### 4.3 Silent Data Loss
The warning message implies a transient database issue, but the root cause is a schema mismatch in the application code. Users have no visibility that their idle time is not being tracked.

---

## 5. Fix Plan

### Acceptance Criteria
1. ✅ Idle records successfully upload in the same batch as work records
2. ✅ No PGRST102 errors during batch upload
3. ✅ All idle records have identical schema keys as work records (with null/default values where appropriate)
4. ✅ Existing tests pass without modification
5. ✅ Idle time visible on timeline views
6. ✅ No data loss during batch upload failures

### Fix Implementation

#### Change 1: Normalize Idle Record Schema at Creation
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `_create_idle_record()` (lines 9605-9645)

Add missing keys to match work record schema:

```python
def _create_idle_record(self, reason="idle timeout"):
    """Create an idle record from idle_start_time to now and queue it for upload."""
    if self.idle_start_time is None:
        return
    idle_end = datetime.now(timezone.utc)
    idle_duration = int((idle_end - self.idle_start_time).total_seconds())
    if idle_duration < 60:
        # Skip very short idle periods (< 1 minute)
        self.idle_start_time = None
        return

    # Only record idle within configured working hours
    if not self._is_within_work_hours(self.idle_start_time):
        print(f"[IDLE] Skipping idle record outside work hours: {self.idle_start_time.strftime('%H:%M:%S')} ({reason})")
        self.idle_start_time = None
        return

    project_key = getattr(self, 'idle_project_key', None) or self.current_project_key or self.get_user_project_key()
    
    # CHANGE: Match work record schema exactly
    record = {
        'user_id': self.current_user_id,
        'organization_id': self.organization_id,
        'window_title': f'[Idle: {reason}]',
        'application_name': 'System',
        'classification': 'idle',
        'is_idle': True,
        'idle_start_time': self.idle_start_time.isoformat(),
        'idle_end_time': idle_end.isoformat(),
        'start_time': self.idle_start_time.isoformat(),
        'end_time': idle_end.isoformat(),
        'duration_seconds': idle_duration,
        'total_time_seconds': idle_duration,
        'work_date': _utc_ts_to_local_date(self.idle_start_time.isoformat()),
        'user_timezone': get_local_timezone_name(),
        'project_key': project_key,
        'status': 'analyzed',  # No AI analysis needed for idle records
        'request_id': str(uuid.uuid4()),
        
        # NEW: Add missing keys to match work record schema
        'ocr_text': None,           # No OCR for idle periods
        'ocr_method': None,         # No OCR for idle periods
        'ocr_confidence': None,     # No OCR for idle periods
        'ocr_error_message': None,  # No OCR for idle periods
        'visit_count': 1,           # Single idle block = 1 visit
        'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,  # Include for consistency
        
        # Batch metadata will be added during upload (lines 8348-8351)
        'metadata': {
            'tracking_mode': 'idle_detection',
            'idle_reason': reason,
            'app_version': self.app_version
        }
    }
    self._pending_idle_records.append(record)
    print(f"[IDLE] Created idle record: {self.idle_start_time.strftime('%H:%M:%S')} → {idle_end.strftime('%H:%M:%S')} ({idle_duration}s, reason: {reason})")
    self.idle_start_time = None
```

**Rationale:**
- Ensures idle records have identical keys as work records
- Uses `None` for OCR fields (semantically correct — no screen to capture during idle)
- Uses `visit_count=1` (each idle period is one contiguous block)
- Includes `user_assigned_issues` for consistency with work records

#### Change 2: Update Batch Upload Warning Message
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `upload_activity_batch()` (line 8601)

Replace misleading warning:

```python
# BEFORE:
self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records failed — check DB constraints.')

# AFTER:
self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records schema mismatch — discarded to prevent batch poisoning.')
```

**Rationale:**
- With Fix 1 applied, this code path should never execute
- If it does, the message should accurately describe the issue (schema mismatch, not DB constraints)

#### Change 3: Add Schema Validation Before Upload (Optional Defense-in-Depth)
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `upload_activity_batch()` (after line 8355)

Add validation to catch schema mismatches before upload:

```python
# After line 8355 (after adding idle records to batch)
if idle_records:
    print(f"[BATCH] Including {len(idle_records)} idle records in batch")
    
    # NEW: Validate schema consistency (defense-in-depth)
    if records:
        work_keys = set(records[0].keys())
        for i, idle_rec in enumerate(idle_records):
            idle_keys = set(idle_rec.keys())
            if work_keys != idle_keys:
                missing_in_idle = work_keys - idle_keys
                extra_in_idle = idle_keys - work_keys
                print(f"[ERROR] Schema mismatch detected in idle record {i}:")
                print(f"        Missing keys: {missing_in_idle}")
                print(f"        Extra keys: {extra_in_idle}")
                print(f"[ERROR] Discarding {len(idle_records)} idle records to prevent batch failure")
                self.add_admin_log('ERROR', f'Idle record schema mismatch detected. {len(idle_records)} records discarded.')
                # Remove idle records from batch
                records = [r for r in records if not r.get('is_idle')]
                break
```

**Rationale:**
- Catches schema mismatches before they cause PGRST102 errors
- Provides detailed diagnostic output for debugging
- Prevents entire batch from failing due to malformed idle records
- This should never trigger if Fix 1 is implemented correctly

---

## 6. Testing Plan

### 6.1 Unit Tests
**File:** `python-desktop-app/tests/test_idle_records.py` (new file)

```python
import pytest
from datetime import datetime, timezone
from desktop_app import TimeTrackerApp

def test_idle_record_schema_matches_work_record():
    """Verify idle records have same keys as work records"""
    app = TimeTrackerApp()
    app.current_user_id = 'test-user-id'
    app.organization_id = 'test-org-id'
    app.user_issues = [{'key': 'TEST-123', 'project': 'TEST'}]
    
    # Create an idle record
    app.idle_start_time = datetime.now(timezone.utc)
    app._create_idle_record(reason="test idle")
    
    assert len(app._pending_idle_records) == 1
    idle_record = app._pending_idle_records[0]
    
    # Expected keys (matches work record schema)
    expected_keys = {
        'user_id', 'organization_id', 'window_title', 'application_name',
        'classification', 'is_idle', 'idle_start_time', 'idle_end_time',
        'start_time', 'end_time', 'duration_seconds', 'total_time_seconds',
        'work_date', 'user_timezone', 'project_key', 'status', 'request_id',
        'ocr_text', 'ocr_method', 'ocr_confidence', 'ocr_error_message',
        'visit_count', 'user_assigned_issues', 'metadata'
    }
    
    actual_keys = set(idle_record.keys())
    assert actual_keys == expected_keys, f"Missing keys: {expected_keys - actual_keys}, Extra keys: {actual_keys - expected_keys}"
    
    # Verify OCR fields are None
    assert idle_record['ocr_text'] is None
    assert idle_record['ocr_method'] is None
    assert idle_record['ocr_confidence'] is None
    assert idle_record['ocr_error_message'] is None
    
    # Verify visit_count is set
    assert idle_record['visit_count'] == 1
    
    # Verify user_assigned_issues is populated
    assert idle_record['user_assigned_issues'] is not None


def test_batch_upload_mixed_records():
    """Verify batch upload succeeds with both work and idle records"""
    app = TimeTrackerApp()
    # ... (full integration test with mock Supabase client)
```

### 6.2 Integration Tests
**File:** `python-desktop-app/test_existing_data_upload.py` (extend existing)

Add test case for mixed batch uploads:

```python
def test_batch_with_idle_records(self):
    """Test uploading a batch containing both work and idle records"""
    # Create work sessions
    work_sessions = self.session_manager.get_all_sessions()[:2]
    
    # Create idle records
    app = TimeTrackerApp()
    app.current_user_id = self.user_id
    app.organization_id = self.org_id
    app.idle_start_time = datetime.now(timezone.utc)
    app._create_idle_record(reason="test")
    
    # Build combined batch
    records = self.build_activity_records(work_sessions)
    records.extend(app._pending_idle_records)
    
    # Upload should succeed
    success = self.upload_to_supabase(records)
    assert success, "Batch upload with mixed records failed"
```

### 6.3 Manual Testing Checklist
1. ✅ Run desktop app with idle detection enabled
2. ✅ Trigger idle timeout (5 min of inactivity)
3. ✅ Verify idle record appears in `_pending_idle_records`
4. ✅ Wait for batch upload cycle (5 min interval)
5. ✅ Check logs for "Batch uploaded X records" (no errors)
6. ✅ Query Supabase to verify idle record persisted
7. ✅ Check timeline view in Forge app shows idle period
8. ✅ Test "Convert idle to worklog" feature

---

## 7. Rollout Plan

### Phase 1: Development
- Implement Fix 1 (normalize idle record schema)
- Add unit tests
- Run local integration tests

### Phase 2: Testing
- Deploy to test environment
- Run full manual test checklist
- Monitor logs for PGRST102 errors (should be zero)
- Verify idle records in database

### Phase 3: Production
- Deploy to production
- Monitor error logs for 24 hours
- Check idle record count in analytics
- Verify no increase in batch upload failures

### Rollback Plan
If issues arise:
1. Revert to previous version
2. Clear `_pending_idle_records` to prevent schema mismatches
3. Idle records from the problematic version will be lost (acceptable trade-off)

---

## 8. Implementation Prompts

Use these prompts to guide implementation without breaking existing functionality.

### Prompt 1: Implement Fix 1 (Normalize Idle Record Schema)
```
Implement the schema normalization fix for idle records in python-desktop-app/desktop_app.py.

Context:
- Idle records are created in _create_idle_record() method (around line 9605)
- They are currently missing keys that work records have: ocr_text, ocr_method, ocr_confidence, ocr_error_message, visit_count, user_assigned_issues
- This causes PGRST102 errors when uploading mixed batches

Requirements:
1. Add the missing keys to the idle record dictionary
2. Set OCR fields to None (no screen to capture during idle)
3. Set visit_count to 1 (each idle period is one contiguous block)
4. Include user_assigned_issues from self.user_issues (same as work records)
5. DO NOT modify any other logic in the function
6. DO NOT change the metadata structure
7. Preserve all existing fields and their values

The resulting idle record must have the exact same set of keys as work records created in upload_activity_batch() (lines 8286-8343).
```

### Prompt 2: Update Warning Message
```
Update the warning message in python-desktop-app/desktop_app.py at line 8601.

Current message:
"Batch uploaded {len(retry_result.data)} work records. Idle records failed — check DB constraints."

New message:
"Batch uploaded {len(retry_result.data)} work records. Idle records schema mismatch — discarded to prevent batch poisoning."

Rationale: With the schema fix applied, this code path should never execute. If it does, the message should accurately describe the issue.

Do not modify any other code in this exception handler.
```

### Prompt 3: Add Schema Validation (Optional)
```
Add defensive schema validation in python-desktop-app/desktop_app.py after line 8355 (after idle records are added to the batch).

The validation should:
1. Compare the keys of the first work record with the keys of each idle record
2. If any mismatch is found, log detailed error information (missing keys, extra keys)
3. Remove idle records from the batch to prevent upload failure
4. Log an admin error message
5. DO NOT raise an exception (allow work records to upload)

This is a defense-in-depth measure and should never trigger if the idle record schema fix is implemented correctly.
```

### Prompt 4: Add Unit Tests
```
Create comprehensive unit tests for idle record schema validation in python-desktop-app/tests/test_idle_records.py (new file).

Test cases:
1. test_idle_record_schema_matches_work_record: Verify idle records have all required keys
2. test_idle_record_ocr_fields_are_none: Verify OCR fields are set to None
3. test_idle_record_visit_count_is_one: Verify visit_count is set to 1
4. test_idle_record_has_user_assigned_issues: Verify user_assigned_issues is populated
5. test_idle_record_short_duration_skipped: Verify idle periods < 60s are not recorded
6. test_idle_record_outside_work_hours_skipped: Verify idle outside work hours is not recorded

Use pytest framework and mock any dependencies (Supabase client, auth manager, etc.).
```

---

## 9. Related Documentation

- [IDLE_TIME_DURING_WORK_HOURS_IMPLEMENTATION.md](../docs/IDLE_TIME_DURING_WORK_HOURS_IMPLEMENTATION.md) — Original idle time feature spec
- [TIME_TRACKER_SESSION_RESET_BUG_REPORT.md](../docs/TIME_TRACKER_SESSION_RESET_BUG_REPORT.md) — Related bug report (BUG-5: idle records lost on early return)
- [BATCH_PROCESS_VERIFICATION.md](../docs/BATCH_PROCESS_VERIFICATION.md) — Batch upload flow documentation
- [20260221_add_activity_records.sql](../supabase/migrations/20260221_add_activity_records.sql) — Database schema
- [20260325_add_idle_time_support.sql](../supabase/migrations/20260325_add_idle_time_support.sql) — Idle columns migration

---

## 10. Success Metrics

After deploying the fix, monitor these metrics for 7 days:

| Metric | Target |
|--------|--------|
| PGRST102 errors in logs | 0 |
| Idle records in database | > 0 (currently 0) |
| Batch upload success rate | > 99.5% |
| Idle records per user per day | 2-5 (lunch, breaks) |
| Timeline view idle gaps | Visible in UI |
| "Convert idle to worklog" success rate | > 95% |

---

## 11. Known Limitations

1. **Historical idle records lost:** Idle records created before this fix are permanently lost (no recovery possible)
2. **No backfill mechanism:** Users who were idle during the bug period will see gaps in their timeline
3. **Batch upload retry logic unchanged:** If the schema validation fails, idle records are still discarded (acceptable trade-off)

---

## 12. Conclusion

The PGRST102 error is caused by a schema mismatch between work records and idle records in the batch upload process. The fix is straightforward: normalize the idle record schema to match work records by adding the missing keys with appropriate null/default values.

This is a **high-severity** bug causing **permanent data loss**, but the fix is **low-risk** (adding keys with null values does not affect database constraints or business logic).

**Estimated effort:** 2-3 hours (implementation + testing)  
**Risk level:** Low (additive change, no breaking modifications)  
**Priority:** HIGH (data loss affecting core feature)
