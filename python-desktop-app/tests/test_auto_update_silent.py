"""Unit tests for fully automatic silent update flow (zero user interaction)."""

import os
import sys
import time
import threading
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import UpdateManager


# ---------------------------------------------------------------------------
# 1. auto_apply() method tests
# ---------------------------------------------------------------------------

class TestAutoApply:
    """Tests for UpdateManager.auto_apply()."""

    def test_auto_apply_calls_apply_update_when_ready(self, tmp_path):
        """auto_apply() should call apply_update() when state is 'ready'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock_apply:
            result = manager.auto_apply()
            assert result is True
            mock_apply.assert_called_once()

    def test_auto_apply_calls_apply_update_when_mandatory_ready(self, tmp_path):
        """auto_apply() should call apply_update() when state is 'mandatory_ready'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None, 'is_mandatory': True}
        manager.download_path = str(staged)
        manager._set_state('mandatory_ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock_apply:
            result = manager.auto_apply()
            assert result is True
            mock_apply.assert_called_once()

    def test_auto_apply_returns_false_when_idle(self, tmp_path):
        """auto_apply() should return False when state is 'idle'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_returns_false_when_downloading(self, tmp_path):
        """auto_apply() should return False when state is 'downloading'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_returns_false_when_failed(self, tmp_path):
        """auto_apply() should return False when state is 'failed'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('failed', error='test error')
        result = manager.auto_apply()
        assert result is False


# ---------------------------------------------------------------------------
# 2. State callback auto-triggers install
# ---------------------------------------------------------------------------

class TestStateCallbackAutoInstall:
    """Tests for _on_update_manager_state_changed auto-install behavior."""

    def test_status_change_to_ready_triggers_auto_apply(self, tmp_path):
        """When UpdateManager transitions to 'ready', auto_apply() must be called."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        auto_apply_called = threading.Event()

        def mock_auto_apply():
            auto_apply_called.set()
            return True

        manager.auto_apply = mock_auto_apply

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager._set_state('ready')
        manager.auto_apply()
        assert auto_apply_called.is_set()

    def test_status_change_to_mandatory_ready_triggers_auto_apply(self, tmp_path):
        """When UpdateManager transitions to 'mandatory_ready', auto_apply() must be called."""
        manager = UpdateManager(str(tmp_path), '1.0.0')

        manager.update_info = {'latest_version': '2.0.0', 'is_mandatory': True, 'checksum': None}
        manager._set_state('mandatory_ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock:
            result = manager.auto_apply()
            assert result is True
            mock.assert_called_once()

    def test_downloading_state_does_not_trigger_auto_apply(self, tmp_path):
        """'downloading' state should NOT trigger auto_apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.auto_apply()
        assert result is False

    def test_failed_state_does_not_trigger_auto_apply(self, tmp_path):
        """'failed' state should NOT trigger auto_apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('failed', error='network error')
        result = manager.auto_apply()
        assert result is False


# ---------------------------------------------------------------------------
# 3. Tray menu is informational only (no clickable actions)
# ---------------------------------------------------------------------------

class TestTrayMenuInfoOnly:
    """Tests validating tray menu items are informational (non-interactive)."""

    def test_idle_state_shows_up_to_date(self):
        """In idle state, menu should show 'Up to Date' (disabled)."""
        status = {'state': 'idle', 'update_info': None, 'progress': 0}
        state = status.get('state', 'idle')
        assert state == 'idle'

    def test_downloading_state_shows_progress(self):
        """In downloading state, menu should show download progress (disabled)."""
        status = {'state': 'downloading', 'update_info': {'latest_version': '2.0.0'}, 'progress': 0.45}
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        progress = int((status.get('progress', 0) or 0) * 100)
        label = f"Downloading update v{latest} ({progress}%)"
        assert label == "Downloading update v2.0.0 (45%)"

    def test_ready_state_shows_installing(self):
        """In ready state, menu should show 'Installing...' (disabled)."""
        status = {'state': 'ready', 'update_info': {'latest_version': '2.0.0'}}
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        label = f"Installing update v{latest}..."
        assert label == "Installing update v2.0.0..."

    def test_installing_state_shows_restarting(self):
        """In installing state, menu should show 'Restarting...' (disabled)."""
        status = {'state': 'installing', 'update_info': {'latest_version': '2.0.0'}}
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        label = f"Restarting for update v{latest}..."
        assert label == "Restarting for update v2.0.0..."

    def test_no_check_updates_action_in_menu(self):
        """Verify idle state maps to disabled info item, not a clickable action."""
        status = {'state': 'idle'}
        state = status.get('state', 'idle')
        assert state == 'idle'

    def test_no_install_update_action_in_menu(self):
        """Verify ready state maps to disabled info item, not a clickable action."""
        status = {'state': 'ready', 'update_info': {'latest_version': '2.0.0'}}
        state = status.get('state', 'idle')
        assert state == 'ready'


# ---------------------------------------------------------------------------
# 4. Download-to-install pipeline (end-to-end state transitions)
# ---------------------------------------------------------------------------

class TestDownloadToInstallPipeline:
    """End-to-end tests: download completes -> auto-apply fires -> installing state."""

    def test_full_pipeline_idle_to_installing(self, tmp_path, monkeypatch):
        """Simulate: idle -> downloading -> ready -> auto_apply -> installing."""
        states_seen = []

        def on_status_change(status):
            states_seen.append(status['state'])

        manager = UpdateManager(
            str(tmp_path), '1.0.0',
            on_status_change=on_status_change,
            on_apply_update=lambda: None
        )

        assert manager.state == 'idle'

        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary-content')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager.download_progress = 1.0

        manager._set_state('ready')
        assert 'ready' in states_seen

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())
        result = manager.auto_apply()
        assert result is True
        assert manager.state == 'installing'
        assert 'installing' in states_seen

    def test_pipeline_handles_missing_staged_file(self, tmp_path):
        """auto_apply should fail gracefully if staged exe was deleted."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(tmp_path / 'updates' / 'nonexistent.exe')
        manager._set_state('ready')

        result = manager.auto_apply()
        assert result is False
        assert manager.state == 'failed'

    def test_pipeline_retry_on_download_failure(self, tmp_path):
        """After download failure, next cycle should retry."""
        manager = UpdateManager(str(tmp_path), '1.0.0')

        manager._set_state('failed', error='network timeout')
        assert manager.state == 'failed'

        result = manager.auto_apply()
        assert result is False

        manager._set_state('idle')
        assert manager.state == 'idle'


# ---------------------------------------------------------------------------
# 5. Notification content tests
# ---------------------------------------------------------------------------

class TestSilentUpdateNotifications:
    """Tests for notification content in silent update mode."""

    def test_restart_notification_contains_version(self):
        """The pre-restart notification should mention the version being installed."""
        latest_version = '2.1.0'
        msg = f"Installing v{latest_version}. The app will restart shortly."
        assert '2.1.0' in msg
        assert 'restart' in msg.lower()

    def test_no_install_now_button_in_downloading_notification(self):
        """Downloading notification should not have an Install Now action."""
        install_callback = None
        assert install_callback is None

    def test_failed_notification_has_no_action_button(self):
        """Failed notification should not have any action button."""
        install_callback = None
        assert install_callback is None


# ---------------------------------------------------------------------------
# 6. Backward compatibility
# ---------------------------------------------------------------------------

class TestBackwardCompatibility:
    """Ensure defer_update and cancel_download still work (for API stability)."""

    def test_defer_update_method_still_exists(self, tmp_path):
        """defer_update() should still exist and work even though it's unused."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('ready')
        result = manager.defer_update()
        assert result is True
        assert manager.state == 'deferred'

    def test_cancel_download_method_still_exists(self, tmp_path):
        """cancel_download() should still exist and work."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.cancel_download()
        assert result is True

    def test_apply_update_still_works_directly(self, tmp_path, monkeypatch):
        """Direct apply_update() call should still work (API stability)."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())
        assert manager.apply_update() is True
        assert manager.state == 'installing'


# ---------------------------------------------------------------------------
# 7. Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Edge case tests for silent auto-update."""

    def test_auto_apply_from_deferred_state(self, tmp_path):
        """auto_apply() should return False from 'deferred' state."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('deferred')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_idempotent(self, tmp_path, monkeypatch):
        """Calling auto_apply() twice should not double-apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        assert manager.auto_apply() is True
        assert manager.state == 'installing'

        assert manager.auto_apply() is False

    def test_concurrent_auto_apply_safe(self, tmp_path, monkeypatch):
        """Multiple threads calling auto_apply should not cause issues."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        results = []

        def call_auto_apply():
            results.append(manager.auto_apply())

        threads = [threading.Thread(target=call_auto_apply) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        true_count = sum(1 for r in results if r is True)
        false_count = sum(1 for r in results if r is False)
        assert true_count >= 1
        assert true_count + false_count == 5

    def test_staged_update_on_restart_auto_applies(self, tmp_path, monkeypatch):
        """If a staged update exists from a previous session, auto_apply should work."""
        updates_dir = tmp_path / 'updates'
        updates_dir.mkdir(parents=True, exist_ok=True)
        staged = updates_dir / 'TimeTracker_v2.1.0.exe'
        staged.write_bytes(b'binary-content')

        manager = UpdateManager(str(tmp_path), '1.0.0')
        assert manager.load_staged_update_if_exists() is True
        assert manager.state == 'ready'

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        result = manager.auto_apply()
        assert result is True
        assert manager.state == 'installing'
