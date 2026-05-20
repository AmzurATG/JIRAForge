# Idle Records Batch Upload Field Mismatch Fix Plan

**Created:** 2026-05-19  
**Status:** ✅ IMPLEMENTED  
**Priority:** P1 — Critical  
**Component:** Python Desktop App — Batch Upload System

---

## Executive Summary

Idle records are failing to upload in batch operations due to **PostgREST PGRST102 error: "All object keys must match"**. The error occurs because work records and idle records have different field sets, and PostgREST requires all objects in a batch insert to have identical keys.

**Impact:**
- ❌ Idle time tracking records are silently lost
- ❌ Timeline displays are incomplete (missing idle periods)
- ❌ Total work-hour calculations are inaccurate
- ⚠️ Work records upload successfully, but batch fails and retries WITHOUT idle records

**Root Cause:** Idle records are missing 6 required fields that work records have:
1. `ocr_text`
2. `ocr_method`
3. `ocr_confidence`
4. `ocr_error_message`
5. `visit_count`
6. `user_assigned_issues`

---

## Error Analysis

### Error Message from Logs
```
❌ ERROR: Batch upload failed: {'code': 'PGRST102', 'details': None, 'hint': None, 'message': 'All object keys must match'}
⚠️ WARN: Batch uploaded 4 work records. Idle records failed — check DB constraints.
```

### What's Happening
1. Desktop app builds work records with full field set (including OCR fields)
2. Desktop app appends idle records with partial field set (missing OCR fields)
3. Supabase PostgREST receives mixed array and rejects the entire batch
4. Current code **recovers gracefully** by retrying work records without idle records
5. **Idle records are discarded permanently** to prevent infinite retry loops

### PostgREST PGRST102 Constraint
PostgREST's batch insert API requires:
> "All objects in a POST array must have the same keys (fields). Missing or extra fields in any object will cause a PGRST102 error."

This is a **client-side validation** — the data never reaches PostgreSQL.

---

## Field-by-Field Comparison

### Work Records (Built in `upload_activity_batch()` ~line 8520)
```python
record = {
    'user_id': self.current_user_id,
    'organization_id': self.organization_id,
    'window_title': s.get('window_title', ''),
    'application_name': s.get('application_name', ''),
    'classification': classification,
    'is_idle': is_lock_screen,
    'ocr_text': ocr_text,                         # ← HAS THIS
    'ocr_method': ocr_method,                     # ← HAS THIS
    'ocr_confidence': ocr_confidence,             # ← HAS THIS
    'ocr_error_message': ocr_error_message,       # ← HAS THIS
    'total_time_seconds': int(s.get('total_time_seconds', 0)),
    'visit_count': s.get('visit_count', 1),       # ← HAS THIS
    'start_time': s.get('first_seen'),
    'end_time': s.get('last_seen'),
    'duration_seconds': int(s.get('total_time_seconds', 0)),
    'batch_timestamp': batch_timestamp,
    'batch_start': batch_start.isoformat(),
    'batch_end': batch_end.isoformat(),
    'work_date': _utc_ts_to_local_date(s.get('first_seen')),
    'user_timezone': get_local_timezone_name(),
    'project_key': record_project_key,
    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,  # ← HAS THIS
    'status': status,
    'request_id': str(uuid.uuid4()),
    'metadata': {
        'tracking_mode': 'event_based',
        'app_version': self.app_version,
        'user_projects': list(self._get_known_project_keys()) or None
    }
}
```

### Idle Records (Built in `_record_idle_end()` ~line 9858)
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
    'metadata': {
        'tracking_mode': 'idle_detection',
        'idle_reason': reason,
        'app_version': self.app_version
    }
    # ❌ MISSING: ocr_text
    # ❌ MISSING: ocr_method
    # ❌ MISSING: ocr_confidence
    # ❌ MISSING: ocr_error_message
    # ❌ MISSING: visit_count
    # ❌ MISSING: user_assigned_issues
}
```

---

## Database Schema (Reference)

From `supabase/migrations/20260221_add_activity_records.sql`:
```sql
CREATE TABLE IF NOT EXISTS public.activity_records (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    window_title TEXT,
    application_name TEXT,
    classification TEXT CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown', 'idle')),
    ocr_text TEXT,                  -- ✅ NULLABLE
    ocr_method TEXT,                -- ✅ NULLABLE
    ocr_confidence REAL,            -- ✅ NULLABLE
    ocr_error_message TEXT,         -- ✅ NULLABLE
    total_time_seconds INTEGER,
    visit_count INTEGER DEFAULT 1, -- ✅ HAS DEFAULT
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
    user_assigned_issues TEXT,      -- ✅ NULLABLE
    status TEXT DEFAULT 'pending',
    metadata JSONB DEFAULT '{}',
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    analyzed_at TIMESTAMPTZ,
    -- Idle-specific columns (added in migration 20260325)
    is_idle BOOLEAN DEFAULT FALSE,
    idle_start_time TIMESTAMPTZ,
    idle_end_time TIMESTAMPTZ,
    -- ...
);
```

**Key Points:**
- All missing fields are **nullable or have defaults** in the database
- The database **would accept** the idle records if PostgREST allowed them through
- This is purely a **PostgREST client-side validation** issue

---

## Solution

### Fix Location
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `_record_idle_end()`  
**Line:** ~9858

### Changes Required
Add the 6 missing fields to idle record creation:

```python
# BEFORE (current — missing fields):
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
    'metadata': {
        'tracking_mode': 'idle_detection',
        'idle_reason': reason,
        'app_version': self.app_version
    }
}

# AFTER (fixed — all fields present):
record = {
    'user_id': self.current_user_id,
    'organization_id': self.organization_id,
    'window_title': f'[Idle: {reason}]',
    'application_name': 'System',
    'classification': 'idle',
    'is_idle': True,
    'idle_start_time': self.idle_start_time.isoformat(),
    'idle_end_time': idle_end.isoformat(),
    'ocr_text': None,                          # ✅ ADDED
    'ocr_method': None,                        # ✅ ADDED
    'ocr_confidence': None,                    # ✅ ADDED
    'ocr_error_message': None,                 # ✅ ADDED
    'total_time_seconds': idle_duration,
    'visit_count': 1,                          # ✅ ADDED
    'start_time': self.idle_start_time.isoformat(),
    'end_time': idle_end.isoformat(),
    'duration_seconds': idle_duration,
    'work_date': _utc_ts_to_local_date(self.idle_start_time.isoformat()),
    'user_timezone': get_local_timezone_name(),
    'project_key': project_key,
    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,  # ✅ ADDED
    'status': 'analyzed',
    'request_id': str(uuid.uuid4()),
    'metadata': {
        'tracking_mode': 'idle_detection',
        'idle_reason': reason,
        'app_version': self.app_version
    }
}
```

### Why These Values?
- **`ocr_text: None`** — Idle records don't have screen content
- **`ocr_method: None`** — No OCR was performed
- **`ocr_confidence: None`** — No confidence score available
- **`ocr_error_message: None`** — No OCR errors to report
- **`visit_count: 1`** — Single continuous idle period (matches database default)
- **`user_assigned_issues`** — Include user's assigned issues for context (AI server may use this for reclassification workflows)

---

## Implementation Steps

### Step 1: Update Idle Record Creation
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `_record_idle_end()` (line ~9858)

Add the 6 missing fields to the `record` dictionary.

### Step 2: Verify Field Order (Optional)
While not strictly required, consider matching the field order between work and idle records for maintainability. The current code adds batch metadata later, so that's fine.

### Step 3: Test with Real Idle Records
1. Trigger an idle period (lock screen or wait for inactivity timeout)
2. Resume activity
3. Wait for next batch upload
4. Verify logs show: `"Batch uploaded X work records"` (no warning about idle records failing)
5. Verify idle records appear in Supabase `activity_records` table

### Step 4: Verify Timeline Display
1. Open Forge app timeline view
2. Confirm idle blocks appear correctly
3. Verify idle duration calculations are accurate

---

## Testing Strategy

### Unit Test (Optional)
Create a test that verifies field parity:
```python
def test_idle_record_has_same_fields_as_work_record():
    """Verify idle records have all fields that work records have"""
    work_fields = set(work_record.keys())
    idle_fields = set(idle_record.keys())
    
    # Idle records can have EXTRA fields (idle_start_time, idle_end_time)
    # but must have AT LEAST all work record fields
    missing_fields = work_fields - idle_fields
    assert not missing_fields, f"Idle record missing fields: {missing_fields}"
```

### Integration Test
1. **Generate test data:**
   - Create 3 work sessions (productive apps)
   - Create 2 idle periods (lock screen)
   - Trigger batch upload

2. **Verify upload:**
   - Check logs: no PGRST102 errors
   - Check Supabase: 5 records inserted (3 work + 2 idle)
   - Verify idle records have `ocr_text = NULL`, `visit_count = 1`, etc.

3. **Verify timeline:**
   - Load timeline in Forge app
   - Confirm idle blocks display correctly
   - Verify idle duration calculations

### Regression Test
- Ensure work-only batches still upload correctly
- Ensure idle-only batches upload correctly (no work records)
- Ensure mixed batches upload correctly (work + idle)

---

## Rollout Plan

### Phase 1: Development
- ✅ Identify root cause (DONE — this document)
- ✅ Implement fix in `desktop_app.py` (DONE — added 6 missing fields)
- ✅ Update test file `test_request_id.py` (DONE — updated test structure)
- 🔄 Test locally with real idle records
- 🔄 Verify no regressions in work record uploads

### Phase 2: Testing
- 🔄 Deploy to staging/test environment
- 🔄 Monitor logs for PGRST102 errors (should be zero)
- 🔄 Verify idle records appear in database
- 🔄 Test timeline display with idle blocks

### Phase 3: Production
- 🔄 Deploy to production
- 🔄 Monitor batch upload success rate
- 🔄 Verify user feedback on timeline accuracy
- 🔄 Monitor Sentry/error logs for any new issues

---

## Validation Criteria

### Success Metrics
- ✅ Zero PGRST102 errors in logs
- ✅ Idle records successfully inserted in batch operations
- ✅ Timeline displays show idle blocks correctly
- ✅ Total work-hour calculations include idle time
- ✅ No regression in work record upload success rate

### Failure Indicators
- ❌ PGRST102 errors persist after fix
- ❌ Idle records still missing from database
- ❌ Batch upload failures increase
- ❌ Timeline displays show gaps or errors

---

## Related Documentation

### Files Changed
- ✅ `python-desktop-app/desktop_app.py` — `_record_idle_end()` function (line ~9858)
  - Added 6 missing fields: `ocr_text`, `ocr_method`, `ocr_confidence`, `ocr_error_message`, `visit_count`, `user_assigned_issues`
  - All fields set to appropriate NULL/default values for idle records
- ✅ `python-desktop-app/test_request_id.py` — Updated test structure to match new field set

### Related Migrations
- `supabase/migrations/20260221_add_activity_records.sql` — Base table schema
- `supabase/migrations/20260325_add_idle_time_support.sql` — Idle columns added

### Related Documentation
- `docs/IDLE_TIME_DURING_WORK_HOURS_IMPLEMENTATION.md` — Feature implementation guide
- `docs/TIME_TRACKER_SESSION_RESET_BUG_REPORT.md` — Related idle record issues (BUG-5)
- `docs/BATCH_PROCESS_VERIFICATION.md` — Batch upload flow documentation

### Related Code
- `python-desktop-app/desktop_app.py:8440-8850` — Batch upload logic
- `python-desktop-app/desktop_app.py:9850-9900` — Idle record creation

---

## Risk Assessment

### Risk Level: **LOW**
- ✅ Change is localized to single function
- ✅ Only adds NULL values (no behavior change)
- ✅ Database already supports these nullable fields
- ✅ No schema migrations required
- ✅ Rollback is trivial (revert commit)

### Potential Issues
1. **Performance:** Adding 6 more fields per idle record increases payload size slightly (negligible)
2. **Data quality:** NULL values are semantically correct for idle records
3. **Compatibility:** No breaking changes to database or API contracts

---

## Appendix: Current Error Recovery Logic

The desktop app already has robust error recovery for this issue (lines 8823-8838):

```python
# If idle records were in the batch, retry work sessions WITHOUT idle records
# to prevent failed idle records from poisoning all future batch uploads
if idle_records and sessions:
    print(f"[BATCH] Retrying {len(sessions)} work sessions WITHOUT {len(idle_records)} idle records...")
    try:
        retry_result = self.supabase.table('activity_records').insert(work_only_records).execute()
        if retry_result.data:
            self.session_manager.clear_all_sessions()
            print(f"[BATCH] Idle records failed separately — discarding to prevent batch poisoning")
            self._pending_idle_records.clear()  # Discard problematic idle records
            self.last_batch_upload_time = time.time()
            self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records failed — check DB constraints.')
            return
    except Exception as retry_e:
        print(f"[WARN] Work-only retry also failed: {retry_e}")
```

**Why This Exists:**
This was added as a **defensive measure** to prevent idle record failures from blocking work record uploads. It successfully uploads work records but **permanently discards idle records**.

**After This Fix:**
- The retry logic will **no longer trigger** because idle records will upload successfully
- The warning `"Idle records failed — check DB constraints"` will **disappear**
- Idle records will be **preserved and uploaded** with work records

---

## Sign-Off
✅ Code Changes Complete — Ready for Testing  
**Implementation Date:** 2026-05-19  
**Estimated Effort:** 15 minutes (single function change + testing)  
**Actual Effort:** 12 minutes (code changes complete
**Plan Date:** 2026-05-19  
**Implementation Status:** Ready for Development  
**Estimated Effort:** 15 minutes (single function change + testing)  
**Estimated Risk:** Low  

**Approvals:**
- [ ] Technical Lead
- [ ] QA Lead
- [ ] Product Owner

---

**END OF PLAN**
