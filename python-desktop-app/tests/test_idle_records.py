"""
Test suite for Idle Records Schema Validation

Tests verify the idle record schema fix for PGRST102 batch upload errors:
- Idle records have identical keys to work records
- OCR fields are properly set to None
- visit_count is set to 1
- user_assigned_issues is populated
- Short duration idle periods are skipped
- Out-of-work-hours idle periods are skipped

Reference: plan/2026-05-14_idle_records_batch_upload_fix.md
Related: plan/2026-05-14_idle_records_fix_implementation_guide.md
"""

import os
import sys
import json
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone, timedelta

import pytest

# Add parent directory to path for desktop_app imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from desktop_app import TimeTracker


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_app():
    """
    Create a partially mocked TimeTracker instance for testing.
    
    Returns a TimeTracker with:
    - current_user_id: 'test-user-123'
    - organization_id: 'test-org-456'
    - app_version: '1.3.9'
    - user_issues: Empty list (can be overridden in tests)
    - _pending_idle_records: Empty list
    - current_project_key: 'TEST'
    """
    # Create a real instance but mock the heavy initialization
    with patch.object(TimeTracker, '__init__', return_value=None):
        app = TimeTracker()
        
        # Set required attributes
        app.current_user_id = 'test-user-123'
        app.organization_id = 'test-org-456'
        app.app_version = '1.3.9'
        app.current_project_key = 'TEST'
        app.user_issues = []
        app._pending_idle_records = []
        app.idle_start_time = None
        
        # Mock get_user_project_key method
        app.get_user_project_key = Mock(return_value='TEST')
        
        # Mock _is_within_work_hours to return True by default
        app._is_within_work_hours = Mock(return_value=True)
        
        return app


@pytest.fixture
def idle_start_time_5min_ago():
    """Return a datetime 5 minutes in the past (UTC)"""
    return datetime.now(timezone.utc) - timedelta(minutes=5)


@pytest.fixture
def idle_start_time_30sec_ago():
    """Return a datetime 30 seconds in the past (UTC)"""
    return datetime.now(timezone.utc) - timedelta(seconds=30)


# ---------------------------------------------------------------------------
# Test Cases
# ---------------------------------------------------------------------------

def test_idle_record_schema_matches_work_record(mock_app, idle_start_time_5min_ago):
    """
    AC1: Verify idle records have same keys as work records
    
    This is the core fix for PGRST102 "All object keys must match" error.
    Idle records must have all keys that work records have, even if values are None.
    
    Expected keys (must match work record schema from upload_activity_batch):
    - user_id, organization_id, window_title, application_name
    - classification, is_idle, idle_start_time, idle_end_time
    - start_time, end_time, duration_seconds, total_time_seconds
    - work_date, user_timezone, project_key, status, request_id
    - ocr_text, ocr_method, ocr_confidence, ocr_error_message (NEW - added in fix)
    - visit_count (NEW - added in fix)
    - user_assigned_issues (NEW - added in fix)
    - metadata
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="test idle")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
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
    
    # Assert: Exact match (no missing keys, no extra keys)
    missing_keys = expected_keys - actual_keys
    extra_keys = actual_keys - expected_keys
    
    assert not missing_keys, f"Missing keys in idle record: {missing_keys}"
    assert not extra_keys, f"Extra keys in idle record: {extra_keys}"
    assert actual_keys == expected_keys, "Idle record schema must exactly match work record schema"


def test_idle_record_ocr_fields_are_none(mock_app, idle_start_time_5min_ago):
    """
    AC2: Verify OCR fields are set to None (no screen to OCR during idle)
    
    OCR fields should be None because:
    - No screenshot is captured during idle periods
    - No OCR processing is performed
    - These fields exist only for schema consistency
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="lunch break")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: All OCR fields are None
    assert idle_record['ocr_text'] is None, "ocr_text should be None (no screen to OCR during idle)"
    assert idle_record['ocr_method'] is None, "ocr_method should be None"
    assert idle_record['ocr_confidence'] is None, "ocr_confidence should be None"
    assert idle_record['ocr_error_message'] is None, "ocr_error_message should be None"


def test_idle_record_visit_count_is_one(mock_app, idle_start_time_5min_ago):
    """
    AC3: Verify visit_count is set to 1
    
    Each idle period represents one contiguous block of inactivity.
    Unlike work sessions which may have multiple visits to the same window,
    idle periods are single continuous spans of time.
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="coffee break")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: visit_count is 1
    assert idle_record['visit_count'] == 1, "visit_count should be 1 (each idle period is one contiguous block)"


def test_idle_record_has_user_assigned_issues(mock_app, idle_start_time_5min_ago):
    """
    AC4: Verify user_assigned_issues is populated from app.user_issues
    
    The user_assigned_issues field should contain a JSON string of the user's
    currently assigned issues, allowing idle time to be converted to worklog
    entries later.
    """
    # Setup: Set user_issues to a test list
    test_issues = [
        {'key': 'TEST-123', 'project': 'TEST', 'summary': 'Test issue'},
        {'key': 'TEST-456', 'project': 'TEST', 'summary': 'Another issue'}
    ]
    mock_app.user_issues = test_issues
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="meeting")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: user_assigned_issues is populated
    assert idle_record['user_assigned_issues'] is not None, "user_assigned_issues should be populated"
    
    # Parse JSON and verify content
    assigned_issues = json.loads(idle_record['user_assigned_issues'])
    assert assigned_issues == test_issues, "user_assigned_issues should match app.user_issues"
    assert len(assigned_issues) == 2
    assert assigned_issues[0]['key'] == 'TEST-123'
    assert assigned_issues[1]['key'] == 'TEST-456'


def test_idle_record_user_assigned_issues_empty(mock_app, idle_start_time_5min_ago):
    """
    AC4b: Verify user_assigned_issues is None when user_issues is empty
    
    When the user has no assigned issues, the field should be None rather than
    an empty JSON array.
    """
    # Setup: Empty user_issues
    mock_app.user_issues = []
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="idle")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: user_assigned_issues is None
    assert idle_record['user_assigned_issues'] is None, "user_assigned_issues should be None when no issues assigned"


def test_idle_record_short_duration_skipped(mock_app, idle_start_time_30sec_ago):
    """
    AC5: Verify idle records shorter than 60 seconds are skipped
    
    Very short idle periods (< 1 minute) are not recorded to reduce noise.
    This prevents recording idle time for brief pauses like reading or thinking.
    """
    # Setup: Set idle start time to 30 seconds ago (< 60s threshold)
    mock_app.idle_start_time = idle_start_time_30sec_ago
    
    # Execute: Call _create_idle_record
    mock_app._create_idle_record(reason="brief pause")
    
    # Assert: No record created (duration < 60s)
    assert len(mock_app._pending_idle_records) == 0, "Idle periods < 60s should be skipped"
    
    # Assert: idle_start_time reset to None
    assert mock_app.idle_start_time is None, "idle_start_time should be reset after skipping short idle"


def test_idle_record_outside_work_hours_skipped(mock_app, idle_start_time_5min_ago):
    """
    AC6: Verify idle records outside work hours are skipped
    
    Idle time outside of configured work hours is not recorded.
    This prevents tracking idle time during non-working hours (evenings, weekends).
    """
    # Setup: Mock _is_within_work_hours to return False
    mock_app._is_within_work_hours = Mock(return_value=False)
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Call _create_idle_record
    mock_app._create_idle_record(reason="outside work hours")
    
    # Assert: No record created (outside work hours)
    assert len(mock_app._pending_idle_records) == 0, "Idle periods outside work hours should be skipped"
    
    # Assert: idle_start_time reset to None
    assert mock_app.idle_start_time is None, "idle_start_time should be reset after skipping out-of-hours idle"
    
    # Assert: _is_within_work_hours was called with idle_start_time
    mock_app._is_within_work_hours.assert_called_once_with(idle_start_time_5min_ago)


def test_idle_record_duration_calculation(mock_app):
    """
    AC7: Verify idle duration is calculated correctly
    
    The duration_seconds field should accurately reflect the time between
    idle_start_time and the current time when the record is created.
    """
    # Setup: Set idle start time to exactly 5 minutes ago
    idle_start = datetime.now(timezone.utc) - timedelta(minutes=5)
    mock_app.idle_start_time = idle_start
    
    # Execute: Create idle record
    before_create = datetime.now(timezone.utc)
    mock_app._create_idle_record(reason="duration test")
    after_create = datetime.now(timezone.utc)
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Calculate expected duration (accounting for test execution time)
    expected_duration_min = 300  # 5 minutes = 300 seconds
    expected_duration_max = expected_duration_min + 2  # Allow 2 seconds for test execution
    
    # Assert: Duration is within expected range
    actual_duration = idle_record['duration_seconds']
    assert expected_duration_min <= actual_duration <= expected_duration_max, \
        f"Duration {actual_duration}s should be between {expected_duration_min}s and {expected_duration_max}s"
    
    # Assert: total_time_seconds matches duration_seconds
    assert idle_record['total_time_seconds'] == idle_record['duration_seconds'], \
        "total_time_seconds should equal duration_seconds for idle records"


def test_idle_record_metadata_structure(mock_app, idle_start_time_5min_ago):
    """
    AC8: Verify metadata field has correct structure
    
    The metadata field should contain:
    - tracking_mode: 'idle_detection'
    - idle_reason: The reason passed to _create_idle_record
    - app_version: The app version string
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record with custom reason
    custom_reason = "user away from keyboard"
    mock_app._create_idle_record(reason=custom_reason)
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: metadata exists and is a dict
    assert 'metadata' in idle_record
    assert isinstance(idle_record['metadata'], dict)
    
    # Assert: metadata has required fields
    metadata = idle_record['metadata']
    assert metadata['tracking_mode'] == 'idle_detection'
    assert metadata['idle_reason'] == custom_reason
    assert metadata['app_version'] == mock_app.app_version


def test_idle_record_classification_is_idle(mock_app, idle_start_time_5min_ago):
    """
    AC9: Verify classification is set to 'idle'
    
    Idle records should have classification='idle' and is_idle=True
    to distinguish them from work records.
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="idle")
    
    # Verify: One record created
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Assert: classification and is_idle are set correctly
    assert idle_record['classification'] == 'idle'
    assert idle_record['is_idle'] is True
    assert idle_record['window_title'].startswith('[Idle:')
    assert idle_record['application_name'] == 'System'


def test_idle_record_none_idle_start_time(mock_app):
    """
    AC10: Verify no record created when idle_start_time is None
    
    If idle_start_time is not set, _create_idle_record should return early
    without creating a record.
    """
    # Setup: idle_start_time is None (default)
    assert mock_app.idle_start_time is None
    
    # Execute: Call _create_idle_record
    mock_app._create_idle_record(reason="should not create")
    
    # Assert: No record created
    assert len(mock_app._pending_idle_records) == 0, "No record should be created when idle_start_time is None"


def test_idle_record_clears_idle_start_time(mock_app, idle_start_time_5min_ago):
    """
    AC11: Verify idle_start_time is reset to None after creating record
    
    After successfully creating an idle record, idle_start_time should be
    reset to None to prepare for the next idle detection cycle.
    """
    # Setup: Set idle start time to 5 minutes ago
    mock_app.idle_start_time = idle_start_time_5min_ago
    assert mock_app.idle_start_time is not None
    
    # Execute: Create idle record
    mock_app._create_idle_record(reason="test")
    
    # Assert: idle_start_time is reset to None
    assert mock_app.idle_start_time is None, "idle_start_time should be reset to None after creating record"


# ---------------------------------------------------------------------------
# Integration Test: Batch Schema Consistency
# ---------------------------------------------------------------------------

def test_idle_and_work_record_schema_consistency(mock_app, idle_start_time_5min_ago):
    """
    Integration test: Verify idle and work records can be batched together
    
    This simulates the actual batch upload scenario where work records and
    idle records are combined in a single list. All records must have
    identical keys to avoid PGRST102 errors.
    
    This test creates a mock work record and compares it with an idle record.
    """
    # Setup: Create idle record
    mock_app.idle_start_time = idle_start_time_5min_ago
    mock_app._create_idle_record(reason="batch test")
    
    assert len(mock_app._pending_idle_records) == 1
    idle_record = mock_app._pending_idle_records[0]
    
    # Create a mock work record (mimicking upload_activity_batch structure)
    work_record = {
        'user_id': mock_app.current_user_id,
        'organization_id': mock_app.organization_id,
        'window_title': 'Visual Studio Code',
        'application_name': 'Code.exe',
        'classification': 'productive',
        'is_idle': False,
        'idle_start_time': None,
        'idle_end_time': None,
        'start_time': idle_start_time_5min_ago.isoformat(),
        'end_time': datetime.now(timezone.utc).isoformat(),
        'duration_seconds': 300,
        'total_time_seconds': 300,
        'work_date': '2026-05-14',
        'user_timezone': 'UTC',
        'project_key': 'TEST',
        'status': 'analyzed',
        'request_id': 'test-request-id',
        'ocr_text': 'Sample OCR text',
        'ocr_method': 'tesseract',
        'ocr_confidence': 0.95,
        'ocr_error_message': None,
        'visit_count': 3,
        'user_assigned_issues': json.dumps([{'key': 'TEST-123'}]),
        'metadata': {'tracking_mode': 'automatic'}
    }
    
    # Get keys from both records
    work_keys = set(work_record.keys())
    idle_keys = set(idle_record.keys())
    
    # Assert: Exact match (this is what PostgREST requires)
    missing_in_idle = work_keys - idle_keys
    extra_in_idle = idle_keys - work_keys
    
    assert not missing_in_idle, f"Idle record missing keys that work record has: {missing_in_idle}"
    assert not extra_in_idle, f"Idle record has extra keys that work record doesn't: {extra_in_idle}"
    assert work_keys == idle_keys, "Idle and work records must have identical keys for batch upload"


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
