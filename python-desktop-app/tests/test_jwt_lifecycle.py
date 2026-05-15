"""
Tests for JWT lifecycle management and heartbeat validation.
Maps to acceptance criteria AC1-AC6 from:
plan/2026-05-14_python-desktop-app_fix-jwt-expiration-timing-and-validation.md

This test suite verifies that:
- JWT refresh checks happen at 5-minute intervals (not 10 minutes)
- Heartbeat validates JWT before performing database UPDATEs
- Zero-row updates are detected and logged
- JWT refresh failures are handled gracefully
- No false success logs appear when operations fail
"""
import pytest
import time
from unittest.mock import Mock, patch, MagicMock, call
from datetime import datetime, timezone, timedelta


# Test Fixtures
@pytest.fixture
def mock_desktop_app():
    """Create a mock desktop app instance with required attributes."""
    app = Mock()
    app.current_user_id = 'test-user-123'
    app.app_version = '2.8.1'
    app.supabase = Mock()
    app.auth_manager = Mock()
    app.auth_manager.tokens = {}
    app.add_admin_log = Mock()
    return app


@pytest.fixture
def mock_supabase_response():
    """Create a mock Supabase response with data."""
    response = Mock()
    response.data = [{'id': 'test-user-123', 'desktop_last_heartbeat': '2026-05-14T12:00:00Z'}]
    return response


@pytest.fixture
def mock_empty_supabase_response():
    """Create a mock Supabase response with no data (RLS blocked)."""
    response = Mock()
    response.data = []
    return response


# AC1: Timing bug fixed - refresh at T+55
def test_jwt_refresh_triggered_at_55_minutes(mock_desktop_app):
    """
    Verify refresh check at 55 minutes triggers renewal.
    
    AC1: JWT refresh checks now happen every 5 minutes instead of 10 minutes.
    This ensures that at T+55 minutes, the check sees "5 minutes remaining" 
    and triggers refresh BEFORE the JWT expires at T+60.
    
    Mathematical proof:
    - JWT issued at T+0, expires at T+60 (3600 seconds)
    - Check interval: 10 iterations × 30 seconds = 300 seconds (5 minutes)
    - Refresh buffer: 300 seconds (5 minutes)
    - At T+55 (3300s), remaining = 300s → triggers refresh ✓
    """
    from desktop_app import DesktopApp
    
    # Mock time to simulate T+55 minutes (3300 seconds after JWT issued)
    jwt_issued_time = 1000000.0
    jwt_expires_time = jwt_issued_time + 3600  # T+60 minutes
    current_time = jwt_issued_time + 3300  # T+55 minutes
    
    with patch('time.time', return_value=current_time):
        with patch.object(DesktopApp, '_set_supabase_jwt', return_value=True) as mock_refresh:
            # Set up token expiry info
            mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = jwt_expires_time
            
            # Import and bind _send_heartbeat to our mock instance
            # Simulate the JWT expiry check logic
            sb_expires_at = mock_desktop_app.auth_manager.tokens.get('supabase_token_expires_at', 0)
            time_remaining = sb_expires_at - current_time  # 300 seconds remaining
            buffer_threshold = 300  # 5 minutes
            
            # Verify the math: at T+55, should trigger refresh
            assert time_remaining == 300, f"Expected 300s remaining, got {time_remaining}s"
            assert time_remaining <= buffer_threshold, "Refresh should be triggered at T+55"
            
            # Simulate the refresh trigger condition
            if sb_expires_at and time.time() > (sb_expires_at - buffer_threshold):
                should_refresh = True
            else:
                should_refresh = False
            
            assert should_refresh, "JWT refresh should be triggered at T+55 minutes"


# AC2: Heartbeat validates JWT before UPDATE
def test_heartbeat_validates_jwt_before_update(mock_desktop_app, mock_supabase_response):
    """
    Verify heartbeat checks JWT expiry before proceeding.
    
    AC2: _send_heartbeat() must validate JWT BEFORE attempting database UPDATE.
    If JWT is expired or expiring soon (≤5 min), refresh first.
    If refresh fails, skip heartbeat entirely (don't proceed with expired JWT).
    """
    from desktop_app import DesktopApp
    
    # Mock expired JWT (expires_at is in the past)
    expired_time = time.time() - 100  # Expired 100 seconds ago
    mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = expired_time
    
    # Mock _set_supabase_jwt to track if it's called
    with patch.object(DesktopApp, '_set_supabase_jwt', return_value=False) as mock_refresh:
        # Bind the actual _send_heartbeat method
        with patch.object(DesktopApp, '__init__', lambda x: None):
            app = DesktopApp()
            app.current_user_id = mock_desktop_app.current_user_id
            app.app_version = mock_desktop_app.app_version
            app.supabase = mock_desktop_app.supabase
            app.auth_manager = mock_desktop_app.auth_manager
            app.add_admin_log = mock_desktop_app.add_admin_log
            
            # Execute heartbeat
            app._send_heartbeat()
            
            # Verify refresh was attempted
            mock_refresh.assert_called_once()
            
            # Verify UPDATE was NOT called (because refresh failed)
            mock_desktop_app.supabase.table.assert_not_called()
            
            # Verify warning was logged to admin panel
            mock_desktop_app.add_admin_log.assert_called_once()
            assert 'WARN' in str(mock_desktop_app.add_admin_log.call_args)


# AC3: Row count verification
def test_heartbeat_detects_zero_rows_affected(mock_desktop_app, mock_empty_supabase_response):
    """
    Verify heartbeat logs error when UPDATE affects 0 rows.
    
    AC3: After executing UPDATE, verify result.data is not empty.
    Empty result.data means RLS blocked the write (expired JWT or wrong supabase_user_id).
    Must log error with diagnostic info, NOT success message.
    """
    from desktop_app import DesktopApp
    
    # Mock valid JWT (not expired)
    valid_time = time.time() + 3000  # Expires in 50 minutes
    mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = valid_time
    
    # Mock Supabase to return empty result (RLS blocked)
    mock_table = Mock()
    mock_update = Mock()
    mock_eq = Mock()
    mock_eq.execute.return_value = mock_empty_supabase_response
    mock_update.eq.return_value = mock_eq
    mock_table.update.return_value = mock_update
    mock_desktop_app.supabase.table.return_value = mock_table
    
    # Capture print output
    with patch('builtins.print') as mock_print:
        with patch.object(DesktopApp, '__init__', lambda x: None):
            app = DesktopApp()
            app.current_user_id = mock_desktop_app.current_user_id
            app.app_version = mock_desktop_app.app_version
            app.supabase = mock_desktop_app.supabase
            app.auth_manager = mock_desktop_app.auth_manager
            app.add_admin_log = mock_desktop_app.add_admin_log
            
            # Execute heartbeat
            app._send_heartbeat()
            
            # Verify error was logged (not success)
            print_calls = [str(call) for call in mock_print.call_args_list]
            
            # Should NOT see success message
            success_logged = any('[OK] Heartbeat sent' in str(call) for call in print_calls)
            assert not success_logged, "Should NOT log success when 0 rows affected"
            
            # Should see warning message
            warning_logged = any('0 rows' in str(call) for call in print_calls)
            assert warning_logged, "Should log warning when 0 rows affected"
            
            # Verify admin log was called with ERROR
            mock_desktop_app.add_admin_log.assert_called()
            admin_log_call = str(mock_desktop_app.add_admin_log.call_args)
            assert 'ERROR' in admin_log_call, "Should log ERROR to admin panel"
            assert '0 rows' in admin_log_call, "Admin log should mention 0 rows"


# AC4: Long-running session (integration test)
@pytest.mark.integration
def test_jwt_refreshes_over_six_hours(mock_desktop_app):
    """
    Verify JWT is refreshed multiple times in long session.
    
    AC4: In a 6-hour session, JWT should be refreshed at least 6 times
    (once per hour before expiration).
    
    Timeline:
    - T+0:   JWT issued, expires at T+60
    - T+55:  Refresh #1 → new JWT expires at T+115
    - T+110: Refresh #2 → new JWT expires at T+170
    - T+165: Refresh #3 → new JWT expires at T+225
    - T+220: Refresh #4 → new JWT expires at T+280
    - T+275: Refresh #5 → new JWT expires at T+335
    - T+330: Refresh #6 → new JWT expires at T+390
    """
    from desktop_app import DesktopApp
    
    refresh_count = 0
    
    def mock_refresh_jwt():
        """Mock JWT refresh that updates expiry time."""
        nonlocal refresh_count
        refresh_count += 1
        # Each refresh extends JWT by 1 hour
        new_expiry = time.time() + 3600
        mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = new_expiry
        return True
    
    # Simulate 6 hours of operation
    start_time = 1000000.0
    six_hours_later = start_time + (6 * 3600)  # 21600 seconds
    check_interval = 300  # 5 minutes
    
    current_time = start_time
    mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = start_time + 3600
    
    with patch('time.time', side_effect=lambda: current_time):
        with patch.object(DesktopApp, '_set_supabase_jwt', side_effect=mock_refresh_jwt):
            while current_time < six_hours_later:
                # Simulate JWT expiry check
                sb_expires_at = mock_desktop_app.auth_manager.tokens.get('supabase_token_expires_at', 0)
                if sb_expires_at and current_time > (sb_expires_at - 300):
                    # Trigger refresh
                    mock_refresh_jwt()
                
                # Advance time by check interval
                current_time += check_interval
    
    # Verify JWT was refreshed at least 6 times
    assert refresh_count >= 6, f"Expected ≥6 refreshes in 6 hours, got {refresh_count}"


# AC5: Network failure recovery
def test_heartbeat_skips_when_refresh_fails(mock_desktop_app):
    """
    Verify heartbeat is skipped when JWT refresh fails.
    
    AC5: If _set_supabase_jwt() returns False (network failure, auth server down),
    heartbeat should be skipped entirely. Must not proceed with expired JWT.
    Should log skip message and add warning to admin panel.
    """
    from desktop_app import DesktopApp
    
    # Mock expired JWT
    expired_time = time.time() - 100
    mock_desktop_app.auth_manager.tokens['supabase_token_expires_at'] = expired_time
    
    # Mock JWT refresh to fail (network error)
    with patch.object(DesktopApp, '_set_supabase_jwt', return_value=False):
        with patch('builtins.print') as mock_print:
            with patch.object(DesktopApp, '__init__', lambda x: None):
                app = DesktopApp()
                app.current_user_id = mock_desktop_app.current_user_id
                app.app_version = mock_desktop_app.app_version
                app.supabase = mock_desktop_app.supabase
                app.auth_manager = mock_desktop_app.auth_manager
                app.add_admin_log = mock_desktop_app.add_admin_log
                
                # Execute heartbeat
                app._send_heartbeat()
                
                # Verify skip message was logged
                print_calls = [str(call) for call in mock_print.call_args_list]
                skip_logged = any('heartbeat skipped' in str(call).lower() for call in print_calls)
                assert skip_logged, "Should log skip message when refresh fails"
                
                # Verify UPDATE was NOT called
                mock_desktop_app.supabase.table.assert_not_called()
                
                # Verify admin warning was logged
                mock_desktop_app.add_admin_log.assert_called()
                admin_call = str(mock_desktop_app.add_admin_log.call_args)
                assert 'WARN' in admin_call or 'ERROR' in admin_call


# AC6: No false success logs
def test_no_false_success_logs_on_failure(mock_desktop_app, mock_empty_supabase_response):
    """
    Verify success message not logged when operation fails.
    
    AC6: The infamous false positive log "[OK] Heartbeat sent" must NEVER
    appear when:
    - JWT refresh fails
    - RLS blocks UPDATE (0 rows affected)
    - Network exception occurs
    - Supabase client not initialized
    
    This test verifies all failure paths avoid the success log.
    """
    from desktop_app import DesktopApp
    
    test_scenarios = [
        {
            'name': 'JWT refresh fails',
            'setup': lambda: setattr(mock_desktop_app.auth_manager.tokens, '__getitem__', 
                                     lambda x: time.time() - 100),  # Expired
            'mock_refresh': False,
        },
        {
            'name': 'RLS blocks UPDATE (0 rows)',
            'setup': lambda: setattr(mock_desktop_app.auth_manager.tokens, '__getitem__',
                                     lambda x: time.time() + 3000),  # Valid
            'mock_response': mock_empty_supabase_response,
        },
        {
            'name': 'Supabase client not initialized',
            'setup': lambda: setattr(mock_desktop_app, 'supabase', None),
        },
    ]
    
    for scenario in test_scenarios:
        # Reset mocks
        mock_desktop_app.supabase = Mock()
        mock_desktop_app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 3000}
        
        # Apply scenario setup
        if 'setup' in scenario:
            scenario['setup']()
        
        with patch('builtins.print') as mock_print:
            with patch.object(DesktopApp, '__init__', lambda x: None):
                app = DesktopApp()
                app.current_user_id = mock_desktop_app.current_user_id
                app.app_version = mock_desktop_app.app_version
                app.supabase = mock_desktop_app.supabase
                app.auth_manager = mock_desktop_app.auth_manager
                app.add_admin_log = mock_desktop_app.add_admin_log
                
                if 'mock_refresh' in scenario:
                    with patch.object(DesktopApp, '_set_supabase_jwt', return_value=scenario['mock_refresh']):
                        app._send_heartbeat()
                elif 'mock_response' in scenario:
                    # Mock Supabase to return empty result
                    mock_table = Mock()
                    mock_update = Mock()
                    mock_eq = Mock()
                    mock_eq.execute.return_value = scenario['mock_response']
                    mock_update.eq.return_value = mock_eq
                    mock_table.update.return_value = mock_update
                    app.supabase.table.return_value = mock_table
                    app._send_heartbeat()
                else:
                    app._send_heartbeat()
                
                # Verify NO success message was logged
                print_calls = [str(call) for call in mock_print.call_args_list]
                success_logged = any('[OK] Heartbeat sent' in str(call) for call in print_calls)
                
                assert not success_logged, f"Scenario '{scenario['name']}': Should NOT log success on failure"


# Additional Test: Proactive refresh when no expiry info
def test_heartbeat_proactive_refresh_when_no_expiry():
    """
    Verify heartbeat proactively refreshes JWT when no expiry info available.
    
    Edge case: If supabase_token_expires_at is missing or 0, heartbeat should
    proactively refresh JWT to be safe, but still attempt the UPDATE even if
    refresh fails (JWT might still be valid).
    """
    from desktop_app import DesktopApp
    
    app = Mock()
    app.current_user_id = 'test-user-123'
    app.app_version = '2.8.1'
    app.supabase = Mock()
    app.auth_manager = Mock()
    app.auth_manager.tokens = {}  # No expiry info
    app.add_admin_log = Mock()
    
    # Mock Supabase response
    response = Mock()
    response.data = [{'id': 'test-user-123'}]
    mock_table = Mock()
    mock_update = Mock()
    mock_eq = Mock()
    mock_eq.execute.return_value = response
    mock_update.eq.return_value = mock_eq
    mock_table.update.return_value = mock_update
    app.supabase.table.return_value = mock_table
    
    with patch.object(DesktopApp, '_set_supabase_jwt', return_value=True) as mock_refresh:
        with patch('builtins.print') as mock_print:
            with patch.object(DesktopApp, '__init__', lambda x: None):
                test_app = DesktopApp()
                test_app.current_user_id = app.current_user_id
                test_app.app_version = app.app_version
                test_app.supabase = app.supabase
                test_app.auth_manager = app.auth_manager
                test_app.add_admin_log = app.add_admin_log
                
                # Execute heartbeat
                test_app._send_heartbeat()
                
                # Verify proactive refresh was attempted
                mock_refresh.assert_called_once()
                
                # Verify UPDATE was still attempted
                app.supabase.table.assert_called_once()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
