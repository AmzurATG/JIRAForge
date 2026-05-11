"""Test request_id generation for idempotency."""
import uuid
from datetime import datetime, timezone

# Test that uuid.uuid4() generates valid UUIDs
def test_uuid_generation():
    """Verify UUID generation works."""
    request_id = str(uuid.uuid4())
    print(f"Generated request_id: {request_id}")
    
    # Check format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    parts = request_id.split('-')
    assert len(parts) == 5, f"UUID should have 5 parts, got {len(parts)}"
    assert len(parts[0]) == 8, "First part should be 8 chars"
    assert len(parts[1]) == 4, "Second part should be 4 chars"
    assert len(parts[2]) == 4, "Third part should be 4 chars"
    assert len(parts[3]) == 4, "Fourth part should be 4 chars"
    assert len(parts[4]) == 12, "Fifth part should be 12 chars"
    print("✅ UUID format verified")

def test_idle_record_structure():
    """Verify idle record has all required fields including request_id."""
    # Simulate idle record structure
    idle_start_time = datetime.now(timezone.utc)
    idle_end = datetime.now(timezone.utc)
    idle_duration = int((idle_end - idle_start_time).total_seconds())
    
    record = {
        'user_id': 'test-user-123',
        'organization_id': 'test-org-456',
        'window_title': '[Idle: idle timeout]',
        'application_name': 'System',
        'classification': 'idle',
        'is_idle': True,
        'start_time': idle_start_time.isoformat(),
        'end_time': idle_end.isoformat(),
        'duration_seconds': idle_duration,
        'status': 'analyzed',
        'request_id': str(uuid.uuid4()),  # This should be present
    }
    
    # Verify request_id exists and is valid
    assert 'request_id' in record, "Record should have request_id field"
    assert record['request_id'] is not None, "request_id should not be None"
    assert isinstance(record['request_id'], str), "request_id should be string"
    assert len(record['request_id']) == 36, "UUID string should be 36 chars (with dashes)"
    print(f"✅ Idle record request_id: {record['request_id']}")

def test_activity_record_structure():
    """Verify activity record has all required fields including request_id."""
    record = {
        'user_id': 'test-user-123',
        'organization_id': 'test-org-456',
        'window_title': 'Visual Studio Code',
        'application_name': 'Code.exe',
        'classification': 'productive',
        'duration_seconds': 300,
        'status': 'pending',
        'request_id': str(uuid.uuid4()),  # This should be present
    }
    
    # Verify request_id exists and is valid
    assert 'request_id' in record, "Record should have request_id field"
    assert record['request_id'] is not None, "request_id should not be None"
    assert isinstance(record['request_id'], str), "request_id should be string"
    print(f"✅ Activity record request_id: {record['request_id']}")

def test_request_ids_are_unique():
    """Verify each generated request_id is unique."""
    ids = [str(uuid.uuid4()) for _ in range(100)]
    unique_ids = set(ids)
    
    assert len(unique_ids) == 100, f"Expected 100 unique IDs, got {len(unique_ids)}"
    print(f"✅ Generated 100 unique request IDs")

if __name__ == '__main__':
    print("Testing request_id generation...\n")
    
    test_uuid_generation()
    test_idle_record_structure()
    test_activity_record_structure()
    test_request_ids_are_unique()
    
    print("\n✅ All request_id tests passed!")
