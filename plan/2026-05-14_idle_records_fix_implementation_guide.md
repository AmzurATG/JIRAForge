# Idle Records Fix — Quick Implementation Guide

**Date:** 2026-05-14  
**For:** Developers implementing the idle records batch upload fix  
**Related Document:** [2026-05-14_idle_records_batch_upload_fix.md](./2026-05-14_idle_records_batch_upload_fix.md)

---

## Quick Start

This guide provides ready-to-use prompts for fixing the PGRST102 "All object keys must match" error in idle records batch upload.

**Estimated time:** 2-3 hours  
**Risk level:** Low  
**Components affected:** python-desktop-app only

---

## Prerequisites

1. Read the [full root cause analysis](./2026-05-14_idle_records_batch_upload_fix.md)
2. Ensure you have the codebase checked out
3. Python 3.9+ environment set up
4. Access to test Supabase instance

---

## Implementation Steps

### Step 1: Core Fix — Normalize Idle Record Schema

**File to edit:** `python-desktop-app/desktop_app.py`  
**Function:** `_create_idle_record()` (around line 9605)  
**Time:** 15 minutes

**Prompt for AI Assistant:**
```
Fix the idle record schema mismatch in python-desktop-app/desktop_app.py, _create_idle_record() method.

The issue: Idle records are missing these keys that work records have:
- ocr_text
- ocr_method
- ocr_confidence
- ocr_error_message
- visit_count
- user_assigned_issues

This causes PGRST102 "All object keys must match" errors when uploading batches with both work and idle records.

Implementation requirements:
1. Locate the record dictionary creation in _create_idle_record() (around line 9617-9645)
2. Add these keys to the record dictionary:
   - 'ocr_text': None (no screen to OCR during idle)
   - 'ocr_method': None
   - 'ocr_confidence': None
   - 'ocr_error_message': None
   - 'visit_count': 1 (each idle period is one contiguous block)
   - 'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None
3. Place these new keys after 'request_id' and before 'metadata'
4. Do NOT modify any other logic in the function
5. Do NOT change existing field values
6. Preserve all comments and structure

The resulting idle record must have the exact same set of keys as work records created in upload_activity_batch() (lines 8286-8343).
```

**Expected code change:**
```python
# Around line 9617-9645
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
    # NEW: Add missing keys to match work record schema
    'ocr_text': None,
    'ocr_method': None,
    'ocr_confidence': None,
    'ocr_error_message': None,
    'visit_count': 1,
    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,
    # End of new keys
    'metadata': {
        'tracking_mode': 'idle_detection',
        'idle_reason': reason,
        'app_version': self.app_version
    }
}
```

**Verification:**
```python
# In Python console
from desktop_app import TimeTrackerApp
app = TimeTrackerApp()
app.current_user_id = 'test'
app.organization_id = 'test'
app.idle_start_time = datetime.now(timezone.utc)
app._create_idle_record("test")
idle_rec = app._pending_idle_records[0]

# Should have all these keys
expected_keys = {
    'user_id', 'organization_id', 'window_title', 'application_name',
    'classification', 'is_idle', 'idle_start_time', 'idle_end_time',
    'start_time', 'end_time', 'duration_seconds', 'total_time_seconds',
    'work_date', 'user_timezone', 'project_key', 'status', 'request_id',
    'ocr_text', 'ocr_method', 'ocr_confidence', 'ocr_error_message',
    'visit_count', 'user_assigned_issues', 'metadata'
}
assert set(idle_rec.keys()) == expected_keys
```

---

### Step 2: Update Warning Message (Optional)

**File to edit:** `python-desktop-app/desktop_app.py`  
**Line:** 8601  
**Time:** 2 minutes

**Prompt for AI Assistant:**
```
Update the misleading warning message in python-desktop-app/desktop_app.py at line 8601.

Find this line:
self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records failed — check DB constraints.')

Replace with:
self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records schema mismatch — discarded to prevent batch poisoning.')

Rationale: With the schema fix applied, this code path should never execute. If it does, the message should accurately describe the issue (schema mismatch, not DB constraints).

Do not modify any other code in this exception handler.
```

---

### Step 3: Add Schema Validation (Optional Defense-in-Depth)

**File to edit:** `python-desktop-app/desktop_app.py`  
**Location:** After line 8355 (after idle records are added to batch)  
**Time:** 10 minutes

**Prompt for AI Assistant:**
```
Add defensive schema validation in python-desktop-app/desktop_app.py after line 8355.

Current code at line 8355:
if idle_records:
    print(f"[BATCH] Including {len(idle_records)} idle records in batch")

Add validation immediately after this:

1. Check if records list is not empty
2. Get the set of keys from the first record (work record)
3. For each idle record in the recently-added idle records:
   - Get the set of keys from the idle record
   - Compare with work record keys
   - If mismatch found:
     - Log detailed error (missing keys, extra keys)
     - Remove all idle records from the batch
     - Log admin error message
     - Break out of validation loop
4. Do NOT raise an exception (allow work records to upload)

This is defense-in-depth and should never trigger if Step 1 is implemented correctly.

Code template:
```python
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
```

---

### Step 4: Add Unit Tests

**File to create:** `python-desktop-app/tests/test_idle_records.py`  
**Time:** 30 minutes

**Prompt for AI Assistant:**
```
Create comprehensive unit tests for idle record schema validation in python-desktop-app/tests/test_idle_records.py (new file).

The test file should import pytest and mock the TimeTrackerApp class appropriately.

Required test cases:

1. test_idle_record_schema_matches_work_record:
   - Create an idle record using _create_idle_record()
   - Verify it has all required keys (user_id, org_id, window_title, app_name, classification, is_idle, idle times, start/end times, durations, work_date, timezone, project_key, status, request_id, OCR fields, visit_count, user_assigned_issues, metadata)
   - Assert no missing keys, no extra keys

2. test_idle_record_ocr_fields_are_none:
   - Create an idle record
   - Verify ocr_text, ocr_method, ocr_confidence, ocr_error_message are all None

3. test_idle_record_visit_count_is_one:
   - Create an idle record
   - Verify visit_count == 1

4. test_idle_record_has_user_assigned_issues:
   - Set app.user_issues to a test list
   - Create an idle record
   - Verify user_assigned_issues is populated (JSON string)

5. test_idle_record_short_duration_skipped:
   - Set idle_start_time to 30 seconds ago
   - Call _create_idle_record()
   - Verify _pending_idle_records is empty (< 60s skipped)

6. test_idle_record_outside_work_hours_skipped:
   - Mock _is_within_work_hours to return False
   - Create an idle record
   - Verify it's not added to _pending_idle_records

Mock any dependencies:
- Supabase client
- Auth manager
- User info
- System time (where needed)

Use pytest fixtures for common setup (app instance, user IDs, etc.).
```

**Example test structure:**
```python
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch
from desktop_app import TimeTrackerApp

@pytest.fixture
def app():
    """Create a mock TimeTrackerApp instance"""
    app = TimeTrackerApp()
    app.current_user_id = 'test-user-id'
    app.organization_id = 'test-org-id'
    app.user_issues = [{'key': 'TEST-123', 'project': 'TEST'}]
    return app

def test_idle_record_schema_matches_work_record(app):
    """Verify idle records have same keys as work records"""
    # Set idle start time to 5 minutes ago
    app.idle_start_time = datetime.now(timezone.utc) - timedelta(minutes=5)
    
    # Create idle record
    app._create_idle_record(reason="test idle")
    
    assert len(app._pending_idle_records) == 1
    idle_record = app._pending_idle_records[0]
    
    # Expected keys (must match work record schema)
    expected_keys = {
        'user_id', 'organization_id', 'window_title', 'application_name',
        'classification', 'is_idle', 'idle_start_time', 'idle_end_time',
        'start_time', 'end_time', 'duration_seconds', 'total_time_seconds',
        'work_date', 'user_timezone', 'project_key', 'status', 'request_id',
        'ocr_text', 'ocr_method', 'ocr_confidence', 'ocr_error_message',
        'visit_count', 'user_assigned_issues', 'metadata'
    }
    
    actual_keys = set(idle_record.keys())
    
    # Assert exact match
    missing_keys = expected_keys - actual_keys
    extra_keys = actual_keys - expected_keys
    
    assert not missing_keys, f"Missing keys: {missing_keys}"
    assert not extra_keys, f"Extra keys: {extra_keys}"
    assert actual_keys == expected_keys

# ... more tests
```

---

### Step 5: Integration Testing

**File to extend:** `python-desktop-app/test_existing_data_upload.py`  
**Time:** 20 minutes

**Prompt for AI Assistant:**
```
Add an integration test for mixed batch uploads (work + idle records) in python-desktop-app/test_existing_data_upload.py.

Add this test method to the ExistingDataBatchTester class:

def test_batch_with_idle_records(self):
    """Test uploading a batch containing both work and idle records"""
    print("\n" + "="*80)
    print("  TEST: BATCH UPLOAD WITH IDLE RECORDS")
    print("="*80)
    
    # Get existing work sessions
    sessions = self.session_manager.get_all_sessions()
    if not sessions:
        print("\n  No work sessions available - creating mock session")
        # Create a mock work session
        sessions = [{
            'window_title': 'Test',
            'application_name': 'Test App',
            'classification': 'productive',
            'total_time_seconds': 300,
            'visit_count': 1,
            'first_seen': datetime.now(timezone.utc).isoformat(),
            'last_seen': datetime.now(timezone.utc).isoformat(),
            'ocr_text': 'Test OCR',
            'ocr_method': 'test',
            'ocr_confidence': 0.9
        }]
    
    # Take only first 2 sessions
    work_sessions = sessions[:2]
    
    # Build work records
    work_records = self.build_activity_records(work_sessions)
    
    # Create idle records
    app = TimeTrackerApp()
    app.current_user_id = self.user_id
    app.organization_id = self.org_id
    app.user_issues = []
    app.idle_start_time = datetime.now(timezone.utc) - timedelta(minutes=10)
    app._create_idle_record(reason="test break")
    
    idle_records = app._pending_idle_records
    
    # Combine records
    all_records = work_records + idle_records
    
    print(f"\n  Work records: {len(work_records)}")
    print(f"  Idle records: {len(idle_records)}")
    print(f"  Total batch size: {len(all_records)}")
    
    # Verify schema consistency
    if work_records and idle_records:
        work_keys = set(work_records[0].keys())
        idle_keys = set(idle_records[0].keys())
        if work_keys != idle_keys:
            print(f"\n  ✗ SCHEMA MISMATCH DETECTED")
            print(f"    Missing in idle: {work_keys - idle_keys}")
            print(f"    Extra in idle: {idle_keys - work_keys}")
            return False
        print(f"\n  ✓ Schema consistency verified")
    
    # Upload batch
    success = self.upload_to_supabase(all_records)
    
    if success:
        print(f"\n  ✓ Mixed batch upload successful")
        return True
    else:
        print(f"\n  ✗ Mixed batch upload failed")
        return False

Then add this test to the test runner's test list.
```

---

### Step 6: Manual Testing

**Time:** 30 minutes

**Testing checklist:**

1. **Idle detection test:**
   ```bash
   # Run desktop app
   cd python-desktop-app
   python desktop_app.py
   
   # Wait 5 minutes without mouse/keyboard activity
   # Check logs for "Created idle record" message
   # Verify _pending_idle_records is populated
   ```

2. **Batch upload test:**
   ```bash
   # Continue from step 1
   # Wait for next batch cycle (5 min) or trigger manually
   # Check logs for "Batch uploaded X records" (no PGRST102 error)
   # Verify no "Idle records failed" warning
   ```

3. **Database verification:**
   ```sql
   -- Query Supabase
   SELECT 
       id, 
       window_title, 
       classification, 
       is_idle, 
       visit_count,
       ocr_text,
       user_assigned_issues
   FROM activity_records 
   WHERE is_idle = TRUE
   ORDER BY created_at DESC 
   LIMIT 5;
   
   -- Expected: Records with all fields populated (OCR fields = null)
   ```

4. **Timeline view test:**
   - Open Forge app
   - Navigate to Timeline view
   - Verify idle periods appear as gaps or separate blocks
   - Test "Convert idle to worklog" feature

---

## Verification Checklist

After implementation, verify:

- [ ] No PGRST102 errors in logs
- [ ] Idle records successfully uploaded to database
- [ ] Work records still upload correctly
- [ ] Mixed batches (work + idle) succeed
- [ ] All unit tests pass
- [ ] Integration test passes
- [ ] Timeline view shows idle periods
- [ ] "Convert idle to worklog" works
- [ ] No data loss during batch uploads
- [ ] Monitoring shows > 0 idle records per user per day

---

## Troubleshooting

### Issue: Still getting PGRST102 errors

**Diagnosis:**
```python
# Add debug logging before upload
print("[DEBUG] Work record keys:", set(records[0].keys()) if records else "empty")
if idle_records:
    print("[DEBUG] Idle record keys:", set(idle_records[0].keys()))
    print("[DEBUG] Missing in idle:", set(records[0].keys()) - set(idle_records[0].keys()))
```

**Fix:** Ensure Step 1 was implemented correctly and all 6 new keys are added

### Issue: Idle records still discarded

**Diagnosis:** Check if validation code (Step 3) is triggering

**Fix:** Review validation logs and fix schema mismatch

### Issue: Tests failing

**Diagnosis:** Check if mock setup is correct

**Fix:** Ensure all dependencies are mocked (Supabase, auth manager, user info)

---

## Rollback Procedure

If issues arise in production:

1. **Immediate rollback:**
   ```bash
   git revert <commit-hash>
   git push origin main
   # Redeploy desktop app
   ```

2. **Clear pending idle records:**
   ```python
   # In affected desktop app instances
   app._pending_idle_records.clear()
   ```

3. **Monitor logs:**
   - Verify PGRST102 errors stop
   - Check batch upload success rate returns to normal

4. **Data cleanup:**
   - Idle records from the problematic version are lost (acceptable)
   - No cleanup needed in database (no malformed data persisted)

---

## Success Criteria

The fix is successful when:

1. ✅ Zero PGRST102 errors in logs (24 hour window)
2. ✅ Idle records visible in database (> 0 per user per day)
3. ✅ Batch upload success rate > 99.5%
4. ✅ Timeline view shows idle periods
5. ✅ "Convert idle to worklog" feature functional
6. ✅ All tests pass (unit + integration)

---

## Summary

**Total estimated time:** 2-3 hours

| Step | Time | Risk | Required |
|------|------|------|----------|
| 1. Core fix | 15 min | Low | ✅ Yes |
| 2. Update warning | 2 min | None | Optional |
| 3. Add validation | 10 min | Low | Optional |
| 4. Unit tests | 30 min | None | ✅ Yes |
| 5. Integration test | 20 min | None | ✅ Yes |
| 6. Manual testing | 30 min | None | ✅ Yes |

**Minimum viable fix:** Step 1 + Step 4 + Step 6 (1 hour 15 min)  
**Complete fix:** All steps (2-3 hours)

---

## Related Documents

- [Full Root Cause Analysis](./2026-05-14_idle_records_batch_upload_fix.md)
- [Copilot Instructions](../.github/copilot-instructions.md) — Follow spec-driven workflow
- [IDLE_TIME_DURING_WORK_HOURS_IMPLEMENTATION.md](../docs/IDLE_TIME_DURING_WORK_HOURS_IMPLEMENTATION.md) — Original feature spec

---

## Questions?

If you encounter issues not covered in this guide:
1. Review the [full root cause analysis](./2026-05-14_idle_records_batch_upload_fix.md)
2. Check the [TIME_TRACKER_SESSION_RESET_BUG_REPORT.md](../docs/TIME_TRACKER_SESSION_RESET_BUG_REPORT.md) for related issues
3. Review PostgREST documentation on batch inserts
