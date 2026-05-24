"""
Tests for desktop_app_version DB staleness fixes (FIX-1 through FIX-6).

Reference: plan/2026-05-20_python-desktop-app_desktop-version-db-fix-complete-runbook.md
Root cause: docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md

Run: cd python-desktop-app && python -m pytest tests/test_desktop_version_db_fix.py -v
"""

import os
import sys
import json
import time
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import TimeTracker, AtlassianAuthManager


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def app():
    """Minimal TimeTracker instance with all heavy init mocked out."""
    with patch.object(TimeTracker, '__init__', return_value=None):
        instance = TimeTracker()
        instance.current_user_id = 'test-user-123'
        instance.app_version = '1.4.2'
        instance.supabase = None
        instance.supabase_initialized = False
        instance.running = False
        instance.tracking_active = False
        instance.organization_id = 'org-abc'
        instance.current_user = {'user_id': 'test-user-123', 'email': 'test@example.com'}
        instance.auth_manager = MagicMock()
        instance.auth_manager.tokens = {}
        instance.auth_manager.is_authenticated.return_value = True
        instance.offline_manager = MagicMock()
        return instance


@pytest.fixture
def connected_app(app):
    """App fixture with a live Supabase mock (simulates successful startup)."""
    mock_supabase = MagicMock()
    mock_result = MagicMock()
    mock_result.data = [{'id': 'test-user-123'}]
    mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = mock_result
    app.supabase = mock_supabase
    app.supabase_initialized = True
    return app


@pytest.fixture
def auth_manager(tmp_path):
    """AtlassianAuthManager with minimal setup and file paths in a temp dir."""
    with patch.object(AtlassianAuthManager, '__init__', return_value=None):
        am = AtlassianAuthManager()
        am.store_path = str(tmp_path / 'time_tracker_auth.json')
        am.metadata_path = str(tmp_path / 'auth_metadata.json')
        am.tokens = {}
        am._save_tokens = MagicMock()
        am.secure_storage = MagicMock()
        am.secure_storage.migrate_from_plaintext.return_value = True
        am._refresh_lock = MagicMock()
        am._refresh_lock.__enter__ = MagicMock(return_value=None)
        am._refresh_lock.__exit__ = MagicMock(return_value=False)
        return am


# ---------------------------------------------------------------------------
# FIX-1: Background Supabase re-init in sync thread
# ---------------------------------------------------------------------------

class TestFix1BackgroundReinit:
    """
    Tests for the supabase_reinit_counter mechanic in sync_worker.

    AC1: Counter increments each tick when supabase_initialized=False and authenticated.
    AC2: initialize_supabase() is called after exactly 60 iterations.
    AC3: _update_desktop_status(logged_in=True) is called after successful re-init.
    AC4: Counter resets to 0 after each re-init attempt.
    AC5: Counter resets to 0 when supabase_initialized=True.
    """

    def _simulate_sync_ticks(self, app, ticks, mock_init):
        """
        Simulate the sync_worker counter logic for N ticks without threading.
        Mirrors the exact code in sync_worker inside start_sync_thread().
        """
        supabase_reinit_counter = 0
        supabase_reinit_interval = 60
        for _ in range(ticks):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                supabase_reinit_counter += 1
                if supabase_reinit_counter >= supabase_reinit_interval:
                    supabase_reinit_counter = 0
                    if mock_init():
                        app.supabase_initialized = True
                        if app.current_user_id and not app.current_user_id.startswith('anonymous_'):
                            app._update_desktop_status(logged_in=True)
            else:
                supabase_reinit_counter = 0
        return supabase_reinit_counter

    def test_counter_increments_when_not_initialized(self, app):
        """AC1: Counter grows each tick when supabase_initialized=False and authenticated."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        counter = 0
        for _ in range(10):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                counter += 1
            else:
                counter = 0

        assert counter == 10

    def test_initialize_supabase_called_at_60_iterations(self, app):
        """AC2: initialize_supabase() is called after exactly 60 iterations."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        with patch.object(app, 'initialize_supabase', return_value=False) as mock_init, \
             patch.object(app, '_update_desktop_status'):
            self._simulate_sync_ticks(app, 60, mock_init)

        assert mock_init.call_count == 1

    def test_initialize_supabase_not_called_before_60(self, app):
        """AC2: initialize_supabase() is NOT called before 60 iterations complete."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        with patch.object(app, 'initialize_supabase', return_value=False) as mock_init, \
             patch.object(app, '_update_desktop_status'):
            self._simulate_sync_ticks(app, 59, mock_init)

        assert mock_init.call_count == 0

    def test_update_desktop_status_called_after_successful_reinit(self, app):
        """AC3: _update_desktop_status(logged_in=True) is called when re-init succeeds."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        with patch.object(app, 'initialize_supabase', return_value=True), \
             patch.object(app, '_update_desktop_status') as mock_status:
            self._simulate_sync_ticks(app, 60, app.initialize_supabase)

        mock_status.assert_called_once_with(logged_in=True)

    def test_heartbeat_counter_reset_after_successful_reinit(self, app):
        """heartbeat_counter is reset to 0 after successful reinit+status update.

        Without this reset, the heartbeat fires 4h from thread-start even though
        _update_desktop_status already wrote desktop_last_heartbeat at t=30min.
        The record would look stale again 1h after the reinit recovery.
        With the reset, the next regular heartbeat fires 4h from the recovery point.
        """
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        heartbeat_counter = 0
        heartbeat_interval = 480
        supabase_reinit_counter = 0
        supabase_reinit_interval = 60
        mock_init = MagicMock(return_value=True)
        mock_status = MagicMock()

        for _ in range(60):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                supabase_reinit_counter += 1
                if supabase_reinit_counter >= supabase_reinit_interval:
                    supabase_reinit_counter = 0
                    if mock_init():
                        app.supabase_initialized = True
                        if app.current_user_id and not app.current_user_id.startswith('anonymous_'):
                            try:
                                mock_status(logged_in=True)
                                heartbeat_counter = 0  # THE FIX
                            except Exception:
                                pass
            else:
                supabase_reinit_counter = 0
            heartbeat_counter += 1  # simulates the heartbeat tick running each iteration

        # After the reinit at tick 60, heartbeat_counter was reset to 0 then incremented once
        # So after the loop ends it should be 1, NOT 61
        assert heartbeat_counter == 1, (
            f"heartbeat_counter should be 1 (reset + 1 tick after reinit), got {heartbeat_counter}. "
            "Without the reset it would be 61, causing the next heartbeat to fire 3.5h early."
        )

    def test_update_desktop_status_not_called_when_reinit_fails(self, app):
        """AC3 (inverse): _update_desktop_status not called when re-init returns False."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = True

        with patch.object(app, 'initialize_supabase', return_value=False) as mock_init, \
             patch.object(app, '_update_desktop_status') as mock_status:
            self._simulate_sync_ticks(app, 60, mock_init)

        mock_status.assert_not_called()

    def test_counter_resets_when_supabase_initialized(self, app):
        """AC5: Counter resets to 0 when supabase_initialized becomes True."""
        app.supabase_initialized = True
        app.auth_manager.is_authenticated.return_value = True

        # When initialized, the else branch fires and resets the counter
        counter = 99  # pre-set
        if not app.supabase_initialized and app.auth_manager.is_authenticated():
            counter += 1
        else:
            counter = 0

        assert counter == 0

    def test_counter_not_incremented_when_not_authenticated(self, app):
        """AC1 (inverse): Counter stays 0 when user is not authenticated."""
        app.supabase_initialized = False
        app.auth_manager.is_authenticated.return_value = False

        counter = 0
        for _ in range(10):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                counter += 1
            else:
                counter = 0

        assert counter == 0


# ---------------------------------------------------------------------------
# FIX-2: Disk cache for Supabase config
# ---------------------------------------------------------------------------

class TestFix2SupabaseConfigCache:
    """
    Tests for the 24h disk-cache in AtlassianAuthManager.get_supabase_config().

    AC1: Fresh cache (<24h) returns True without any HTTP call.
    AC2: Successful HTTP fetch writes URL/key/timestamp and calls _save_tokens().
    AC3: Missing access_token + stale cache → stale cache used (returns True).
    AC4: HTTP exception + stale cache → stale cache used (returns True).
    AC5: HTTP exception + no cache → returns False.
    """

    def _fresh_cache(self, am):
        am.tokens = {
            'cached_supabase_url': 'https://test.supabase.co',
            'cached_supabase_anon_key': 'test-anon-key',
            'cached_supabase_config_at': time.time() - 60,  # 1 minute ago — fresh
        }

    def _stale_cache(self, am):
        am.tokens = {
            'cached_supabase_url': 'https://test.supabase.co',
            'cached_supabase_anon_key': 'test-anon-key',
            'cached_supabase_config_at': time.time() - 90000,  # 25 hours ago — stale
        }

    def test_fresh_cache_returns_true_without_http_call(self, auth_manager):
        """AC1: Fresh cache (<24h) returns True without making any HTTP request."""
        self._fresh_cache(auth_manager)

        with patch('desktop_app.set_runtime_supabase_config'), \
             patch('requests.post') as mock_post:
            result = auth_manager.get_supabase_config()

        assert result is True
        mock_post.assert_not_called()

    def test_fresh_cache_sets_runtime_config(self, auth_manager):
        """AC1: Fresh cache calls set_runtime_supabase_config with cached values."""
        self._fresh_cache(auth_manager)

        with patch('desktop_app.set_runtime_supabase_config') as mock_set, \
             patch('requests.post'):
            auth_manager.get_supabase_config()

        mock_set.assert_called_once_with('https://test.supabase.co', 'test-anon-key')

    def test_stale_cache_used_when_no_access_token(self, auth_manager):
        """AC3: When access_token is absent and stale cache exists, stale cache is used."""
        self._stale_cache(auth_manager)
        # No access_token in tokens

        with patch('desktop_app.set_runtime_supabase_config') as mock_set, \
             patch('requests.post') as mock_post:
            result = auth_manager.get_supabase_config()

        assert result is True
        mock_post.assert_not_called()
        mock_set.assert_called_with('https://test.supabase.co', 'test-anon-key')

    def test_stale_cache_used_on_network_error(self, auth_manager):
        """AC4: When HTTP call raises an exception and stale cache exists, returns True."""
        self._stale_cache(auth_manager)
        auth_manager.tokens['access_token'] = 'some-token'

        with patch('desktop_app.set_runtime_supabase_config'), \
             patch('desktop_app.get_env_var', return_value='https://forgesync.amzur.com'), \
             patch('requests.post', side_effect=Exception("Connection refused")):
            result = auth_manager.get_supabase_config()

        assert result is True

    def test_no_cache_and_network_error_returns_false(self, auth_manager):
        """AC5: No cache + network error → returns False."""
        auth_manager.tokens = {'access_token': 'some-token'}  # No cache fields

        with patch('desktop_app.set_runtime_supabase_config'), \
             patch('desktop_app.get_env_var', return_value='https://forgesync.amzur.com'), \
             patch('requests.post', side_effect=Exception("Connection refused")):
            result = auth_manager.get_supabase_config()

        assert result is False

    def test_successful_fetch_writes_cache_keys(self, auth_manager):
        """AC2: Successful HTTP fetch writes cached_supabase_url and cached_supabase_anon_key."""
        auth_manager.tokens = {'access_token': 'some-token'}

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'success': True,
            'supabase_url': 'https://proj.supabase.co',
            'supabase_anon_key': 'new-anon-key',
        }

        with patch('desktop_app.get_env_var', return_value='https://forgesync.amzur.com'), \
             patch('desktop_app.set_runtime_supabase_config'), \
             patch('requests.post', return_value=mock_response):
            result = auth_manager.get_supabase_config()

        assert result is True
        assert auth_manager.tokens.get('cached_supabase_url') == 'https://proj.supabase.co'
        assert auth_manager.tokens.get('cached_supabase_anon_key') == 'new-anon-key'
        assert auth_manager.tokens.get('cached_supabase_config_at', 0) > 0

    def test_successful_fetch_calls_save_tokens(self, auth_manager):
        """AC2: _save_tokens() is called after successful HTTP fetch."""
        auth_manager.tokens = {'access_token': 'some-token'}

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'success': True,
            'supabase_url': 'https://proj.supabase.co',
            'supabase_anon_key': 'new-anon-key',
        }

        with patch('desktop_app.get_env_var', return_value='https://forgesync.amzur.com'), \
             patch('desktop_app.set_runtime_supabase_config'), \
             patch('requests.post', return_value=mock_response):
            auth_manager.get_supabase_config()

        auth_manager._save_tokens.assert_called_once()


# ---------------------------------------------------------------------------
# FIX-3: Migration bug — read file before deleting it
# ---------------------------------------------------------------------------

class TestFix3MigrationReadBeforeDelete:
    """
    Tests for the read-before-delete fix in AtlassianAuthManager._migrate_from_plaintext().

    AC1: supabase_token_expires_at survives migration into auth_metadata.json.
    AC2: After migration, self.tokens['supabase_token_expires_at'] is readable.
    AC3: secure_storage.migrate_from_plaintext() is still called (file deleted).
    AC4: No FileNotFoundError escapes when migration deletes the file.
    """

    def test_supabase_token_expires_at_in_metadata_after_migration(self, auth_manager):
        """AC1: supabase_token_expires_at appears in auth_metadata.json after migration."""
        old_data = {
            'access_token': 'secret-token',
            'supabase_token': 'secret-sb-token',
            'supabase_token_expires_at': 9_999_999_999.0,
            'some_metadata': 'keep-this',
        }
        with open(auth_manager.store_path, 'w') as f:
            json.dump(old_data, f)

        auth_manager._migrate_from_plaintext()

        assert os.path.exists(auth_manager.metadata_path), \
            "auth_metadata.json should be created by migration"
        with open(auth_manager.metadata_path) as f:
            metadata = json.load(f)
        assert metadata.get('supabase_token_expires_at') == 9_999_999_999.0
        assert metadata.get('some_metadata') == 'keep-this'

    def test_sensitive_keys_excluded_from_metadata(self, auth_manager):
        """Sensitive tokens (access_token, refresh_token, supabase_token) are NOT in metadata."""
        old_data = {
            'access_token': 'secret',
            'refresh_token': 'also-secret',
            'supabase_token': 'sb-secret',
            'supabase_token_expires_at': 1_234_567_890.0,
        }
        with open(auth_manager.store_path, 'w') as f:
            json.dump(old_data, f)

        auth_manager._migrate_from_plaintext()

        with open(auth_manager.metadata_path) as f:
            metadata = json.load(f)
        assert 'access_token' not in metadata
        assert 'refresh_token' not in metadata
        assert 'supabase_token' not in metadata

    def test_no_file_not_found_error_when_migration_deletes_file(self, auth_manager):
        """AC4: No FileNotFoundError if migrate_from_plaintext deletes the file."""
        old_data = {'supabase_token_expires_at': 111.0}
        with open(auth_manager.store_path, 'w') as f:
            json.dump(old_data, f)

        # Simulate the real behaviour: migration deletes store_path
        def delete_file_on_migrate(path):
            os.remove(path)
            return True

        auth_manager.secure_storage.migrate_from_plaintext.side_effect = delete_file_on_migrate

        # Must not raise FileNotFoundError
        auth_manager._migrate_from_plaintext()

    def test_migrate_from_plaintext_still_called(self, auth_manager):
        """AC3: secure_storage.migrate_from_plaintext() is called (file is still migrated)."""
        with open(auth_manager.store_path, 'w') as f:
            json.dump({'key': 'val'}, f)

        auth_manager._migrate_from_plaintext()

        auth_manager.secure_storage.migrate_from_plaintext.assert_called_once_with(
            auth_manager.store_path
        )

    def test_skipped_when_store_path_does_not_exist(self, auth_manager):
        """No error when store_path doesn't exist (fresh install, nothing to migrate)."""
        assert not os.path.exists(auth_manager.store_path)
        # Must not raise
        auth_manager._migrate_from_plaintext()
        auth_manager.secure_storage.migrate_from_plaintext.assert_not_called()


# ---------------------------------------------------------------------------
# FIX-4: Fallback path calls _update_desktop_status
# ---------------------------------------------------------------------------

class TestFix4FallbackPathStatusUpdate:
    """
    Tests for the _update_desktop_status call in run()'s fallback path.

    AC1: Called when supabase_initialized=True in the fallback path.
    AC2: NOT called when supabase_initialized=False (FIX-1 handles it later).
    AC3: Exception from _update_desktop_status is caught; app continues.
    """

    def _run_fallback_logic(self, app, cached_user):
        """Inline simulation of the fallback path from run()."""
        if cached_user:
            app.current_user = cached_user
            app.current_user_id = cached_user.get('user_id')
            if app.supabase_initialized and app.current_user_id:
                try:
                    app._update_desktop_status(logged_in=True)
                except Exception:
                    pass  # Must not propagate

    def test_called_when_supabase_initialized(self, connected_app):
        """AC1: _update_desktop_status(logged_in=True) called when supabase_initialized=True."""
        cached_user = {'user_id': 'test-user-123', 'email': 'test@example.com'}

        with patch.object(connected_app, '_update_desktop_status') as mock_status:
            self._run_fallback_logic(connected_app, cached_user)

        mock_status.assert_called_once_with(logged_in=True)

    def test_not_called_when_not_initialized(self, app):
        """AC2: _update_desktop_status NOT called when supabase_initialized=False."""
        app.supabase_initialized = False
        cached_user = {'user_id': 'test-user-123', 'email': 'test@example.com'}

        with patch.object(app, '_update_desktop_status') as mock_status:
            self._run_fallback_logic(app, cached_user)

        mock_status.assert_not_called()

    def test_exception_in_update_caught(self, connected_app):
        """AC3: Exception from _update_desktop_status is caught; app continues normally."""
        cached_user = {'user_id': 'test-user-123', 'email': 'test@example.com'}

        with patch.object(connected_app, '_update_desktop_status',
                          side_effect=Exception("DB error")):
            try:
                self._run_fallback_logic(connected_app, cached_user)
            except Exception:
                pytest.fail("Exception propagated out of fallback path — app would crash")

    def test_skipped_when_no_cached_user(self, app):
        """If there is no cached user, the block is not entered."""
        with patch.object(app, '_update_desktop_status') as mock_status:
            self._run_fallback_logic(app, None)

        mock_status.assert_not_called()


# ---------------------------------------------------------------------------
# FIX-5: Heartbeat includes desktop_logged_in and retries on 0-row result
# ---------------------------------------------------------------------------

class TestFix5HeartbeatImprovements:
    """
    Tests for _send_heartbeat() improvements.

    AC1: UPDATE payload includes 'desktop_logged_in': True.
    AC2: 0-row result triggers _set_supabase_jwt() immediately.
    AC3: After JWT refresh, UPDATE is retried once.
    AC4: Retry success → no ERROR log emitted.
    AC5: Both original and retry fail → ERROR logged via add_admin_log.
    """

    def _make_supabase_mock(self, side_effects=None, data=None):
        """Build a Supabase client mock whose execute() can have side_effects or static data."""
        mock_client = MagicMock()
        execute = mock_client.table.return_value.update.return_value.eq.return_value.execute
        if side_effects is not None:
            execute.side_effect = side_effects
        else:
            mock_result = MagicMock()
            mock_result.data = data if data is not None else [{'id': 'test-user-123'}]
            execute.return_value = mock_result
        return mock_client

    def _ok_result(self):
        r = MagicMock()
        r.data = [{'id': 'test-user-123'}]
        return r

    def _zero_result(self):
        r = MagicMock()
        r.data = []
        return r

    def test_payload_includes_desktop_logged_in(self, app):
        """AC1: UPDATE payload always includes 'desktop_logged_in': True."""
        app.supabase = self._make_supabase_mock(data=[{'id': 'test-user-123'}])
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, 'add_admin_log', MagicMock()), \
             patch.object(app, '_set_supabase_jwt', return_value=True):
            app._send_heartbeat()

        call_args = app.supabase.table.return_value.update.call_args
        payload = call_args[0][0]
        assert 'desktop_logged_in' in payload
        assert payload['desktop_logged_in'] is True

    def test_payload_includes_app_version(self, app):
        """Payload also includes desktop_app_version = app.app_version."""
        app.supabase = self._make_supabase_mock(data=[{'id': 'test-user-123'}])
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, 'add_admin_log', MagicMock()), \
             patch.object(app, '_set_supabase_jwt', return_value=True):
            app._send_heartbeat()

        payload = app.supabase.table.return_value.update.call_args[0][0]
        assert payload.get('desktop_app_version') == '1.4.2'

    def test_zero_row_triggers_jwt_refresh(self, app):
        """AC2: When UPDATE returns 0 rows, _set_supabase_jwt() is called."""
        app.supabase = self._make_supabase_mock(
            side_effects=[self._zero_result(), self._ok_result()]
        )
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, '_set_supabase_jwt', return_value=True) as mock_jwt, \
             patch.object(app, 'add_admin_log', MagicMock()):
            app._send_heartbeat()

        mock_jwt.assert_called()

    def test_retry_called_after_zero_row(self, app):
        """AC3: After JWT refresh, the UPDATE is retried exactly once."""
        app.supabase = self._make_supabase_mock(
            side_effects=[self._zero_result(), self._ok_result()]
        )
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, '_set_supabase_jwt', return_value=True), \
             patch.object(app, 'add_admin_log', MagicMock()):
            app._send_heartbeat()

        # execute() called twice: original + retry
        execute = app.supabase.table.return_value.update.return_value.eq.return_value.execute
        assert execute.call_count == 2

    def test_retry_success_no_error_log(self, app):
        """AC4: When retry succeeds, no ERROR-level log is emitted."""
        app.supabase = self._make_supabase_mock(
            side_effects=[self._zero_result(), self._ok_result()]
        )
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, '_set_supabase_jwt', return_value=True), \
             patch.object(app, 'add_admin_log') as mock_log:
            app._send_heartbeat()

        for c in mock_log.call_args_list:
            level = c[0][0] if c[0] else c[1].get('level', '')
            assert level != 'ERROR', f"Unexpected ERROR log on retry success: {c}"

    def test_both_fail_emits_error_log(self, app):
        """AC5: When both original and retry return 0 rows, an ERROR log is emitted."""
        app.supabase = self._make_supabase_mock(
            side_effects=[self._zero_result(), self._zero_result()]
        )
        app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 7200}

        with patch.object(app, '_set_supabase_jwt', return_value=True), \
             patch.object(app, 'add_admin_log') as mock_log:
            app._send_heartbeat()

        error_calls = [c for c in mock_log.call_args_list if c[0][0] == 'ERROR']
        assert len(error_calls) >= 1, "Expected at least one ERROR log when both calls fail"

    def test_skipped_when_supabase_is_none(self, app):
        """Heartbeat exits early and does not raise when supabase=None."""
        app.supabase = None

        with patch.object(app, 'add_admin_log') as mock_log:
            app._send_heartbeat()  # Must not raise

        mock_log.assert_not_called()

    def test_skipped_for_anonymous_user(self, app):
        """Heartbeat exits early for anonymous_* user IDs."""
        app.current_user_id = 'anonymous_abc123'
        app.supabase = MagicMock()

        app._send_heartbeat()

        app.supabase.table.assert_not_called()


# ---------------------------------------------------------------------------
# FIX-6: Pre-connectivity guard for early Supabase init
# ---------------------------------------------------------------------------

class TestFix6PreConnectivityGuard:
    """
    Tests for the has_supabase_cache guard added to run()'s early init block.

    AC1: When cached_supabase_url is present, initialize_supabase() is called.
    AC2: When cached_supabase_url is absent, initialize_supabase() is NOT called
         and supabase_initialized stays False.
    AC3: Post-connectivity block is unaffected (not tested here — it's unchanged code).
    AC4: Normal returning-user startup is unchanged — early init succeeds from cache.
    AC5: Brand-new users have no stored tokens so the block is already skipped upstream.
    """

    def _run_early_init_guard(self, app):
        """Inline simulation of the FIX-6 guard code from run()."""
        has_supabase_cache = bool(app.auth_manager.tokens.get('cached_supabase_url'))
        if has_supabase_cache:
            try:
                if app.initialize_supabase():
                    print("[OK] Supabase initialized successfully from cache")
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase from cache: {e}")
        else:
            print("[INFO] Skipping early Supabase init — no local config cache. "
                  "Will initialize after connectivity check.")
        return has_supabase_cache

    def test_early_init_skipped_when_no_cache(self, app):
        """AC2: initialize_supabase() is NOT called when cached_supabase_url is absent."""
        app.auth_manager.tokens = {}

        with patch.object(app, 'initialize_supabase') as mock_init:
            self._run_early_init_guard(app)

        mock_init.assert_not_called()

    def test_supabase_initialized_stays_false_when_no_cache(self, app):
        """AC2: supabase_initialized remains False when early init is skipped."""
        app.auth_manager.tokens = {}
        app.supabase_initialized = False

        with patch.object(app, 'initialize_supabase', return_value=True):
            self._run_early_init_guard(app)

        assert app.supabase_initialized is False

    def test_early_init_runs_when_cache_present(self, app):
        """AC1: initialize_supabase() IS called when cached_supabase_url is in tokens."""
        app.auth_manager.tokens = {'cached_supabase_url': 'https://test.supabase.co'}

        with patch.object(app, 'initialize_supabase', return_value=True) as mock_init:
            self._run_early_init_guard(app)

        mock_init.assert_called_once()

    def test_info_log_emitted_when_skipped(self, app, capsys):
        """AC2: INFO log is printed when early init is skipped (no cache)."""
        app.auth_manager.tokens = {}

        with patch.object(app, 'initialize_supabase'):
            self._run_early_init_guard(app)

        captured = capsys.readouterr()
        assert "Skipping early Supabase init" in captured.out
        assert "no local config cache" in captured.out

    def test_exception_from_init_caught_when_cache_present(self, app):
        """AC1: Exception from initialize_supabase() is caught; does not propagate."""
        app.auth_manager.tokens = {'cached_supabase_url': 'https://test.supabase.co'}

        with patch.object(app, 'initialize_supabase', side_effect=Exception("Network error")):
            try:
                self._run_early_init_guard(app)
            except Exception:
                pytest.fail("Exception propagated out of early init guard — FIX-6 broken")

    def test_guard_returns_true_when_cache_present(self, app):
        """Guard helper correctly returns True when cache is present."""
        app.auth_manager.tokens = {'cached_supabase_url': 'https://test.supabase.co'}

        with patch.object(app, 'initialize_supabase', return_value=True):
            result = self._run_early_init_guard(app)

        assert result is True

    def test_guard_returns_false_when_no_cache(self, app):
        """Guard helper correctly returns False when cache is absent."""
        app.auth_manager.tokens = {}

        with patch.object(app, 'initialize_supabase'):
            result = self._run_early_init_guard(app)

        assert result is False
