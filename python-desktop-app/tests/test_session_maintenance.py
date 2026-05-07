"""
Test suite for Session Maintenance Bug Fix

Tests verify the authentication and database write integrity fixes:
- AC1: initialize_supabase() fails fast on JWT setup failure
- AC2: JWT exchange implements retry logic with exponential backoff
- AC3-4: _update_desktop_status() returns boolean and detects RLS blocks
- AC5: OAuth callback handles status write failures
- AC6-7: OAuth callback sets desktop_logged_in flag on success
- AC8: Structured diagnostic logging on authentication failures

Reference: plan/2026-05-06_python-desktop-app_fix-session-maintenance.md
Related: plan/SESSION_BUG_ROOT_CAUSE_ANALYSIS.md
"""

import os
import sys
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone

import pytest

# Add parent directory to path for desktop_app imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
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
    - app_version: '1.3.9'
    - supabase: None (will be mocked in individual tests)
    """
    # Create a real instance but mock the heavy initialization
    with patch.object(TimeTracker, '__init__', return_value=None):
        app = TimeTracker()
        
        # Set required attributes
        app.current_user_id = 'test-user-123'
        app.app_version = '1.3.9'
        app.supabase = None
        app.supabase_initialized = False
        app.current_user = None
        
        # Mock auth_manager
        app.auth_manager = MagicMock()
        
        return app


# ---------------------------------------------------------------------------
# Test Cases - AC1: Fail-Fast on JWT Setup Failure
# ---------------------------------------------------------------------------

def test_initialize_supabase_fails_on_jwt_error(mock_app, caplog):
    """
    AC1: When _set_supabase_jwt() returns False, initialize_supabase() 
    should return False and stop execution.
    
    Current bug: Logs warning but continues, leaving client unauthenticated.
    Expected fix: Return False immediately, marking initialization as failed.
    """
    # Setup: Mock all dependencies for initialize_supabase
    mock_app.supabase_initialized = False
    mock_app.supabase_url = 'https://test.supabase.co'
    
    # Mock auth_manager methods to return success
    mock_app.auth_manager.get_supabase_config.return_value = True
    mock_app.auth_manager.get_ocr_config.return_value = True
    
    # Mock OCR setup and processor creation
    with patch.object(mock_app, '_setup_ocr_engines'), \
         patch('desktop_app.LocalOCRProcessor'), \
         patch('desktop_app.create_client') as mock_create_client, \
         patch('desktop_app.get_env_var') as mock_get_env:
        
        # Configure environment variables
        def get_env_side_effect(key, default=None):
            if key == 'SUPABASE_URL':
                return 'https://test.supabase.co'
            elif key == 'SUPABASE_ANON_KEY':
                return 'test-anon-key'
            return default
        mock_get_env.side_effect = get_env_side_effect
        
        # Mock Supabase client creation
        mock_supabase_client = MagicMock()
        mock_create_client.return_value = mock_supabase_client
        
        # Mock _set_supabase_jwt to return False (JWT setup failure)
        with patch.object(mock_app, '_set_supabase_jwt', return_value=False):
            # Mock add_admin_log to avoid AttributeError
            with patch.object(mock_app, 'add_admin_log'):
                # Execute the method under test
                with caplog.at_level('INFO'):
                    result = mock_app.initialize_supabase()
        
        # Assertions - AC1 requirements
        # 1. Method should return False when JWT setup fails
        assert result is False, (
            f"Expected initialize_supabase() to return False when JWT setup fails, "
            f"but got {result}. Bug: method continues execution despite JWT failure."
        )
        
        # 2. supabase_initialized should remain False
        assert mock_app.supabase_initialized is False, (
            "Expected supabase_initialized to remain False when JWT setup fails"
        )
        
        # 3. ERROR should be logged (not just WARN)
        log_messages = caplog.text
        assert "ERROR" in log_messages or "error" in log_messages.lower(), (
            f"Expected ERROR in logs when JWT setup fails. Log output:\n{log_messages}"
        )


# ---------------------------------------------------------------------------
# Test Cases - AC2: Retry Logic with Exponential Backoff
# ---------------------------------------------------------------------------

def test_jwt_exchange_retries_on_network_error(caplog):
    """
    AC2: When get_supabase_token() fails with transient network errors,
    the system should retry up to 3 times with exponential backoff (3s, 6s).
    
    Current bug: No retry logic exists - single failure causes permanent auth failure.
    Expected fix: Retry 3 times with backoff, then succeed on third attempt.
    """
    import requests
    from desktop_app import AtlassianAuthManager
    
    # Create a real AtlassianAuthManager instance (but don't initialize fully)
    with patch.object(AtlassianAuthManager, '__init__', return_value=None):
        auth_mgr = AtlassianAuthManager()
        
        # Set required attributes
        auth_mgr.tokens = {
            'supabase_token': None,  # No existing token
            'supabase_token_expires_at': 0  # Expired, will trigger get_supabase_token()
        }
        auth_mgr.ai_server_url = 'https://test-server.com'
    
    # Mock get_supabase_token() to fail twice, then succeed
    # Currently it will fail on first call because there's no retry logic
    mock_get_supabase_token = MagicMock()
    mock_get_supabase_token.side_effect = [
        requests.exceptions.ConnectionError("Network unreachable"),
        requests.exceptions.Timeout("Request timed out"),
        "valid-jwt-token-abc123"  # Success on third attempt
    ]
    
    # Replace the real method with our mock
    auth_mgr.get_supabase_token = mock_get_supabase_token
    
    # Mock time.sleep to verify exponential backoff
    with patch('time.sleep') as mock_sleep:
        # Execute the method under test - call the REAL get_valid_supabase_token
        # Currently this will raise the exception because no retry logic exists
        with caplog.at_level('INFO'):
            try:
                result = auth_mgr.get_valid_supabase_token()
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
                # Current behavior: exception propagates, no retry
                result = None
    
    # Assertions - AC2 requirements
    # 1. Method should have been called exactly 3 times (2 failures + 1 success)
    # Currently will be called only 1 time because no retry logic exists
    assert mock_get_supabase_token.call_count == 3, (
        f"Expected get_supabase_token() to be called 3 times (with retries), "
        f"but was called {mock_get_supabase_token.call_count} times. "
        f"Bug: No retry logic implemented - fails on first error."
    )
    
    # 2. Final return value should be the valid token
    assert result == "valid-jwt-token-abc123", (
        f"Expected final result to be 'valid-jwt-token-abc123' after retries, "
        f"but got {result}. Bug: No retry logic, so never gets to successful token."
    )
    
    # 3. Sleep should have been called with exponential backoff (3s, 6s)
    expected_sleep_calls = [3, 6]  # First retry waits 3s, second retry waits 6s
    if mock_sleep.call_count > 0:
        actual_sleep_calls = [call[0][0] for call in mock_sleep.call_args_list]
        assert actual_sleep_calls == expected_sleep_calls, (
            f"Expected sleep calls with backoff {expected_sleep_calls}, "
            f"but got {actual_sleep_calls}"
        )
    else:
        # This assertion will fail in RED state - no sleep calls means no retry logic
        assert False, (
            "Expected retry logic with exponential backoff (sleep(3), sleep(6)), "
            "but sleep was never called. Bug: No retry logic implemented."
        )


def test_jwt_exchange_fails_after_max_retries(caplog):
    """
    AC2: When get_supabase_token() fails on all retry attempts,
    should return None and log error with diagnostic data.
    
    Current bug: No retry logic - fails immediately.
    Expected fix: Retry 3 times with backoff, return None after exhaustion.
    """
    import requests
    from desktop_app import AtlassianAuthManager
    
    # Create a real AtlassianAuthManager instance (but don't initialize fully)
    with patch.object(AtlassianAuthManager, '__init__', return_value=None):
        auth_mgr = AtlassianAuthManager()
        
        # Set required attributes
        auth_mgr.tokens = {
            'supabase_token': None,  # No existing token
            'supabase_token_expires_at': 0  # Expired, will trigger get_supabase_token()
        }
        auth_mgr.ai_server_url = 'https://test-server.com'
    
    # Mock get_supabase_token() to ALWAYS fail with Timeout
    # Create a generator that yields Timeout exceptions indefinitely
    def always_timeout(*args, **kwargs):
        raise requests.exceptions.Timeout("Request timed out")
    
    mock_get_supabase_token = MagicMock(side_effect=always_timeout)
    
    # Replace the real method with our mock
    auth_mgr.get_supabase_token = mock_get_supabase_token
    
    # Mock time.sleep to verify exponential backoff
    with patch('time.sleep') as mock_sleep:
        # Execute the method under test - should retry 3 times then return None
        with caplog.at_level('INFO'):
            try:
                result = auth_mgr.get_valid_supabase_token()
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
                # Current behavior: exception propagates after first attempt, no retry
                result = None
    
    # Assertions - AC2 requirements
    # 1. Method should have been called exactly 3 times (max retries)
    # Currently will be called only 1 time because no retry logic exists
    assert mock_get_supabase_token.call_count == 3, (
        f"Expected get_supabase_token() to be called 3 times (max retries), "
        f"but was called {mock_get_supabase_token.call_count} times. "
        f"Bug: No retry logic - should attempt 3 times before giving up."
    )
    
    # 2. Final return value should be None (all retries exhausted)
    assert result is None, (
        f"Expected final result to be None after all retries fail, "
        f"but got {result}"
    )
    
    # 3. Sleep should have been called with exponential backoff (3s, 6s)
    # First retry waits 3s, second retry waits 6s
    expected_sleep_calls = [3, 6]
    if mock_sleep.call_count > 0:
        actual_sleep_calls = [call[0][0] for call in mock_sleep.call_args_list]
        assert actual_sleep_calls == expected_sleep_calls, (
            f"Expected sleep calls with backoff {expected_sleep_calls}, "
            f"but got {actual_sleep_calls}"
        )
    else:
        # This assertion will fail in RED state - no sleep calls means no retry logic
        assert False, (
            "Expected retry logic with exponential backoff (sleep(3), sleep(6)), "
            "but sleep was never called. Bug: No retry logic implemented."
        )
    
    # 4. Error log should mention retry exhaustion
    log_messages = caplog.text.lower()
    assert "error" in log_messages and "3 attempts" in log_messages, (
        f"Expected ERROR log mentioning '3 attempts' after retry exhaustion. "
        f"Log output:\n{caplog.text}"
    )


# ---------------------------------------------------------------------------
# Test Cases - AC3-4: Database Write Integrity
# ---------------------------------------------------------------------------

def test_update_desktop_status_returns_false_on_rls_block(mock_app):
    """
    AC3-4: When _update_desktop_status() is blocked by RLS (empty result.data),
    should return False and log RLS block warning.
    
    Current bug: Returns None (no return value), silently fails.
    Expected fix: Return False when result.data is empty, log RLS warning.
    """
    # Mock Supabase update chain returning no rows (RLS-block-like behavior)
    mock_result = Mock(data=[])
    mock_eq = MagicMock()
    mock_eq.execute.return_value = mock_result
    mock_update = MagicMock()
    mock_update.eq.return_value = mock_eq
    mock_table = MagicMock()
    mock_table.update.return_value = mock_update
    mock_supabase = MagicMock()
    mock_supabase.table.return_value = mock_table
    mock_app.supabase = mock_supabase

    with patch('builtins.print') as mock_print:
        result = mock_app._update_desktop_status(logged_in=True)

    # RED-state expectation: current implementation returns None, should be False
    assert result is False, (
        f"Expected _update_desktop_status(logged_in=True) to return False when no rows are updated, "
        f"but got {result}. Bug: method does not return boolean failure state."
    )

    # Verify update payload still attempts to write required fields
    mock_supabase.table.assert_called_once_with('users')
    update_payload = mock_table.update.call_args[0][0]
    assert update_payload['desktop_logged_in'] is True
    assert 'desktop_last_heartbeat' in update_payload
    assert update_payload['desktop_app_version'] == '1.3.9'

    # Verify user filter was applied
    mock_update.eq.assert_called_once_with('id', 'test-user-123')

    # RED-state expectation: specific RLS warning should be logged after fix
    printed_output = ' '.join(str(args[0]) for args, _ in mock_print.call_args_list if args)
    assert 'RLS may be blocking' in printed_output, (
        "Expected warning containing 'RLS may be blocking' when update returns empty data."
    )


def test_update_desktop_status_returns_true_on_success(mock_app):
    """
    AC3: When _update_desktop_status() successfully writes to database,
    should return True.
    
    Current bug: Returns None (no return value).
    Expected fix: Return True when result.data contains rows.
    """
    # Mock Supabase update chain: table().update().eq().execute()
    mock_result = Mock(data=[{'id': 'test-user-123', 'desktop_logged_in': True}])
    mock_eq = MagicMock()
    mock_eq.execute.return_value = mock_result
    mock_update = MagicMock()
    mock_update.eq.return_value = mock_eq
    mock_table = MagicMock()
    mock_table.update.return_value = mock_update
    mock_supabase = MagicMock()
    mock_supabase.table.return_value = mock_table
    mock_app.supabase = mock_supabase

    with patch('builtins.print') as mock_print:
        result = mock_app._update_desktop_status(logged_in=True)

    # This should fail in RED state because current code returns None, not True
    assert result is True, (
        f"Expected _update_desktop_status(logged_in=True) to return True, but got {result}. "
        "Bug: method does not return boolean success/failure."
    )

    # Validate update payload shape
    mock_supabase.table.assert_called_once_with('users')
    update_payload = mock_table.update.call_args[0][0]
    assert update_payload['desktop_logged_in'] is True
    assert 'desktop_last_heartbeat' in update_payload
    assert update_payload['desktop_app_version'] == '1.3.9'

    # Validate filter by current user id
    mock_update.eq.assert_called_once_with('id', 'test-user-123')

    # Validate success message output
    printed_output = ' '.join(str(args[0]) for args, _ in mock_print.call_args_list if args)
    assert 'Desktop status updated: logged in' in printed_output


# ---------------------------------------------------------------------------
# Test Cases - AC5-7: OAuth Callback Error Handling
# ---------------------------------------------------------------------------

def test_oauth_callback_shows_error_on_status_write_failure(mock_app):
    """
    AC5: When OAuth callback completes but _update_desktop_status() returns False,
    should log error, call send_login_diagnostics(), and return error response.
    
    Current bug: Doesn't check return value of _update_desktop_status().
    Expected fix: Check return value, log error, send diagnostics on failure.
    """
    from flask import Flask

    # Build a minimal Flask app and register routes on the mocked tracker
    mock_app.app = Flask(__name__)
    mock_app.app.secret_key = 'test-secret'

    # Set attributes consumed by the callback success path
    mock_app.current_user_id = None
    mock_app.organization_id = 'org-123'
    mock_app.current_project_key = 'BRD-1'
    mock_app.supabase = MagicMock()
    mock_app.running = True
    mock_app._reauth_notification_last_shown = 0
    mock_app._login_reminder_last_shown = 0

    # Mock collaborators and route-dependent calls
    mock_app.auth_manager.handle_callback.return_value = {'access_token': 'token'}
    mock_app.auth_manager.get_user_info.return_value = {
        'email': 'test@example.com',
        'account_id': 'acct-123'
    }
    mock_app.initialize_supabase = MagicMock(return_value=True)
    mock_app.ensure_user_exists = MagicMock(return_value='test-user-123')
    mock_app._update_desktop_status = MagicMock(return_value=False)
    mock_app._get_known_project_keys = MagicMock(return_value={'BRD-1'})
    mock_app._associate_offline_records = MagicMock()
    mock_app.update_tray_icon = MagicMock()
    mock_app.update_tray_menu = MagicMock()
    mock_app.start_tracking = MagicMock()

    mock_app.classification_manager = MagicMock()
    mock_app.consent_manager = MagicMock()
    mock_app.consent_manager.has_valid_consent.return_value = True

    # Register routes with all external/global collaborators patched
    with patch.object(mock_app, 'setup_routes', wraps=mock_app.setup_routes) as _wrapped_setup, \
         patch('desktop_app.secure_log'), \
         patch('desktop_app.send_ocr_diagnostics'), \
         patch('desktop_app.send_login_diagnostics') as mock_send_login_diag:

        mock_app.setup_routes()
        client = mock_app.app.test_client()

        with patch('builtins.print') as mock_print:
            response = client.get('/auth/callback?code=fake-code&state=fake-state')

    # Route should complete (currently bug continues despite failed status write)
    assert response.status_code in (302, 500)

    # AC5 assertion: expected failure diagnostic call (should fail in RED state)
    expected_call_found = False
    for call_args in mock_send_login_diag.call_args_list:
        args = call_args[0]
        if len(args) >= 3 and args[1] == 'failed' and args[2] == 'desktop_status_write':
            expected_call_found = True
            break

    assert expected_call_found, (
        "Expected send_login_diagnostics(...) to be called with status='failed' "
        "and step='desktop_status_write' when _update_desktop_status returns False."
    )

    # AC5 assertion: expected user-facing error message (should fail in RED state)
    printed_output = ' '.join(str(args[0]) for args, _ in mock_print.call_args_list if args)
    assert 'Failed to complete authentication' in printed_output, (
        "Expected error message 'Failed to complete authentication' to be logged "
        "when desktop status write fails."
    )


def test_oauth_callback_success_sets_desktop_logged_in(mock_app):
    """
    AC6-7: When OAuth callback completes successfully and _update_desktop_status()
    returns True, should set desktop_logged_in flag and start tracking.
    
    Current bug: Status write may fail silently, leaving flag as NULL.
    Expected fix: Verify status write succeeded before continuing.
    """
    from flask import Flask

    # Build a minimal Flask app and register routes on the mocked tracker
    mock_app.app = Flask(__name__)
    mock_app.app.secret_key = 'test-secret'

    # Set attributes consumed by callback success path
    mock_app.current_user_id = None
    mock_app.organization_id = 'org-123'
    mock_app.current_project_key = 'BRD-1'
    mock_app.supabase = MagicMock()
    mock_app.running = False
    mock_app._reauth_notification_last_shown = 0
    mock_app._login_reminder_last_shown = 0

    user_info = {
        'email': 'test@example.com',
        'account_id': 'acct-123'
    }

    # OAuth + DB-related success mocks
    mock_app.auth_manager.handle_callback.return_value = {'access_token': 'token'}
    mock_app.auth_manager.get_user_info.return_value = user_info
    mock_app.initialize_supabase = MagicMock(return_value=True)
    mock_app.ensure_user_exists = MagicMock(return_value='test-user-123')
    mock_app._get_known_project_keys = MagicMock(return_value={'BRD-1'})
    mock_app._associate_offline_records = MagicMock()
    mock_app.update_tray_icon = MagicMock()
    mock_app.update_tray_menu = MagicMock()
    mock_app.start_tracking = MagicMock()

    mock_app.classification_manager = MagicMock()
    mock_app.consent_manager = MagicMock()
    mock_app.consent_manager.has_valid_consent.return_value = True

    # Capture order between success diagnostics and status update verification
    call_order = []

    def status_update_side_effect(*args, **kwargs):
        call_order.append('status_update')
        return True

    mock_app._update_desktop_status = MagicMock(side_effect=status_update_side_effect)

    def login_diag_side_effect(auth_mgr, status, step, **kwargs):
        call_order.append(f'diag_{status}_{step}')

    with patch('desktop_app.secure_log'), \
         patch('desktop_app.send_ocr_diagnostics'), \
         patch('desktop_app.send_login_diagnostics', side_effect=login_diag_side_effect), \
         patch('builtins.print') as mock_print:

        mock_app.setup_routes()
        client = mock_app.app.test_client()
        response = client.get('/auth/callback?code=fake-code&state=fake-state')

    # Simulate OAuth callback completion (success redirect)
    assert response.status_code == 302

    # AC6: status update call + current user set
    mock_app._update_desktop_status.assert_called_once_with(logged_in=True)
    assert mock_app.current_user == user_info

    # AC7: tracking started in success flow
    mock_app.start_tracking.assert_called_once()

    # Additional success-path sanity: no error logs expected
    printed_output = ' '.join(str(args[0]) for args, _ in mock_print.call_args_list if args)
    assert '[ERROR]' not in printed_output

    # RED-state expectation: success diagnostics should occur only AFTER status update
    # Current code logs success diagnostics before calling _update_desktop_status.
    success_diag = 'diag_success_complete'
    assert success_diag in call_order and 'status_update' in call_order, (
        f"Expected both status update and success diagnostic calls. call_order={call_order}"
    )
    assert call_order.index('status_update') < call_order.index(success_diag), (
        "Expected status update verification before success diagnostics. "
        f"Observed order: {call_order}. Bug: callback does not verify status write before proceeding."
    )
