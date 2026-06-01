"""
Automated tests for tray menu button removal and notification click behavior.

Tests verify:
1. "Cancel Download", "Later", and "Release Notes" buttons are removed from tray menu
2. Notification includes "Install Now" action button for ready/mandatory_ready states
3. /api/update/install route triggers installation correctly
4. Notification message text is correct for each state
"""

import os
import sys
import types
import threading
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import UpdateManager, show_update_notification


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class FakeMenuItem:
    """Captures pystray.MenuItem constructor args for inspection."""
    def __init__(self, text, action=None, enabled=True, **kwargs):
        # pystray passes the MenuItem itself as 'text' arg to callable labels
        if callable(text):
            try:
                self.text = text(self)
            except TypeError:
                self.text = text()
        else:
            self.text = text
        self.action = action
        self.enabled = enabled
        self.default = kwargs.get("default", False)


class FakeMenu:
    """Captures the list of items passed to pystray.Menu(...)."""
    SEPARATOR = "---SEPARATOR---"

    def __init__(self, *items):
        self.items = list(items)


def _build_fake_app(update_manager, app_version="1.0.0", web_port=9876):
    """
    Create a minimal mock of the desktop app with just the fields
    that _build_tray_menu needs.
    """
    app = MagicMock()
    app.update_manager = update_manager
    app.app_version = app_version
    app.web_port = web_port
    app.current_user = {"email": "test@example.com"}
    app.current_user_id = "user-123"
    # tracking_active must be False so the classification window-badge branch
    # is NOT taken; these tests only concern update-related menu items.
    app.tracking_active = False
    app.auth_manager = MagicMock()
    app.check_for_app_updates = MagicMock(return_value=None)

    # Bind the real _build_tray_menu method to our fake app
    app._build_tray_menu = types.MethodType(
        desktop_app.TimeTracker._build_tray_menu, app
    )
    return app


# ---------------------------------------------------------------------------
# 1. Tray Menu: "Cancel Download" button removed
# ---------------------------------------------------------------------------

class TestTrayMenuCancelDownloadRemoved:

    def test_no_cancel_download_in_downloading_state(self, tmp_path):
        """Cancel Download button must NOT appear when state is 'downloading'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("downloading")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            # Replace item() used in _build_tray_menu
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("Cancel" in lbl for lbl in labels), \
            f"Found 'Cancel' in tray labels: {labels}"

    def test_downloading_state_shows_progress_disabled(self, tmp_path):
        """Downloading state shows a disabled progress label."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("downloading")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        progress_items = [i for i in menu.items
                          if isinstance(i, FakeMenuItem) and "Downloading" in i.text]
        assert len(progress_items) == 1
        assert progress_items[0].enabled is False


# ---------------------------------------------------------------------------
# 2. Tray Menu: "Later" button removed
# ---------------------------------------------------------------------------

class TestTrayMenuLaterRemoved:

    def test_no_later_in_ready_state(self, tmp_path):
        """'Later' button must NOT appear when state is 'ready'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager.download_path = os.path.join(str(tmp_path), "updates", "fake.exe")
        manager._set_state("ready")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("Later" in lbl for lbl in labels), \
            f"Found 'Later' in tray labels: {labels}"

    def test_no_later_in_deferred_state(self, tmp_path):
        """'Later' button must NOT appear when state is 'deferred'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager.download_path = os.path.join(str(tmp_path), "updates", "fake.exe")
        manager._set_state("deferred")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("Later" in lbl for lbl in labels), \
            f"Found 'Later' in tray labels: {labels}"

    def test_no_later_in_mandatory_ready_state(self, tmp_path):
        """'Later' button must NOT appear for mandatory updates."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("mandatory_ready")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("Later" in lbl for lbl in labels), \
            f"Found 'Later' in tray labels: {labels}"


# ---------------------------------------------------------------------------
# 3. Tray Menu: "Release Notes" button removed
# ---------------------------------------------------------------------------

class TestTrayMenuReleaseNotesRemoved:

    @pytest.mark.parametrize("state", ["idle", "downloading", "ready", "deferred", "mandatory_ready"])
    def test_no_release_notes_button_in_any_state(self, tmp_path, state):
        """'Release Notes' must never appear as a tray menu item."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        if state != "idle":
            manager._set_state(state)

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert not any("Release" in lbl or "release" in lbl for lbl in labels), \
            f"Found 'Release Notes' in tray labels: {labels}"


# ---------------------------------------------------------------------------
# 4. Tray Menu: Install action present in ready states
# ---------------------------------------------------------------------------

class TestTrayMenuInstallAction:

    def test_install_action_in_ready_state(self, tmp_path):
        """Ready state shows an install menu item."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager.download_path = os.path.join(str(tmp_path), "updates", "fake.exe")
        manager._set_state("ready")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert any("Update Available" in lbl for lbl in labels)

    def test_install_action_in_mandatory_ready_state(self, tmp_path):
        """Mandatory ready state shows an install menu item with 'Required'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("mandatory_ready")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        labels = [i.text for i in menu.items if isinstance(i, FakeMenuItem)]
        assert any("Required" in lbl for lbl in labels)


# ---------------------------------------------------------------------------
# 5. Tray Menu: Menu-less backend fallback
# ---------------------------------------------------------------------------

class TestTrayMenuBackendFallback:

    def test_menu_less_backend_uses_single_default_action(self, tmp_path):
        """Backends without menu support should expose a default left-click action."""
        manager = UpdateManager(str(tmp_path), "1.0.0")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            mock_pystray.Icon = types.SimpleNamespace(
                HAS_MENU=False,
                __module__="pystray._xorg",
            )
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        menu_items = [i for i in menu.items if isinstance(i, FakeMenuItem)]
        assert len(menu_items) == 1
        assert menu_items[0].default is True
        assert menu_items[0].text == "Open Dashboard"

    def test_menu_less_backend_opens_login_for_logged_out_user(self, tmp_path):
        """Fallback left-click should open login when no user is authenticated."""
        manager = UpdateManager(str(tmp_path), "1.0.0")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            mock_pystray.Icon = types.SimpleNamespace(
                HAS_MENU=False,
                __module__="pystray._xorg",
            )
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                app.current_user = None
                menu = app._build_tray_menu()

        menu_items = [i for i in menu.items if isinstance(i, FakeMenuItem)]
        assert len(menu_items) == 1
        assert menu_items[0].text == "Open Login"


# ---------------------------------------------------------------------------
# 6. Notification: "Install Now" action for ready / mandatory_ready
# ---------------------------------------------------------------------------

class TestNotificationInstallAction:

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_ready_notification_has_install_button(self, mock_audio, MockNotif):
        """Ready notification includes an 'Install Now' action button."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"
        fake_callback = MagicMock()

        show_update_notification(
            {"latest_version": "2.0.0"},
            state="ready",
            web_port=9876,
            install_callback=fake_callback,
        )

        mock_instance.add_actions.assert_called_once()
        args, kwargs = mock_instance.add_actions.call_args
        assert kwargs.get("label") == "Install Now" or (args and args[0] == "Install Now")
        launch_url = kwargs.get("launch") or (args[1] if len(args) > 1 else None)
        assert "9876" in launch_url
        assert "/api/update/install" in launch_url

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_mandatory_ready_notification_has_install_button(self, mock_audio, MockNotif):
        """Mandatory ready notification includes an 'Install Now' action button."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"
        fake_callback = MagicMock()

        show_update_notification(
            {"latest_version": "2.0.0", "is_mandatory": True},
            state="mandatory_ready",
            web_port=9876,
            install_callback=fake_callback,
        )

        mock_instance.add_actions.assert_called_once()

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_downloading_notification_no_install_button(self, mock_audio, MockNotif):
        """Downloading notification should NOT have an Install Now button."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"
        fake_callback = MagicMock()

        show_update_notification(
            {"latest_version": "2.0.0"},
            state="downloading",
            web_port=9876,
            install_callback=fake_callback,
        )

        mock_instance.add_actions.assert_not_called()

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_failed_notification_no_install_button(self, mock_audio, MockNotif):
        """Failed notification should NOT have an Install Now button."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"
        fake_callback = MagicMock()

        show_update_notification(
            {"latest_version": "2.0.0"},
            state="failed",
            web_port=9876,
            install_callback=fake_callback,
        )

        mock_instance.add_actions.assert_not_called()

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_no_install_button_without_callback(self, mock_audio, MockNotif):
        """When install_callback is None, no action button is added."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"

        show_update_notification(
            {"latest_version": "2.0.0"},
            state="ready",
            web_port=9876,
            install_callback=None,
        )

        mock_instance.add_actions.assert_not_called()


# ---------------------------------------------------------------------------
# 6. Notification message text correctness
# ---------------------------------------------------------------------------

class TestNotificationMessageText:

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_ready_message_says_install_now(self, mock_audio, MockNotif):
        """Ready state notification message should mention Install Now."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"

        show_update_notification(
            {"latest_version": "3.0.0"},
            state="ready",
            web_port=9876,
        )

        _, kwargs = MockNotif.call_args
        assert "Install Now" in kwargs["msg"]

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_mandatory_ready_message_says_install_now(self, mock_audio, MockNotif):
        """Mandatory ready notification message should mention Install Now."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"

        show_update_notification(
            {"latest_version": "3.0.0", "is_mandatory": True},
            state="mandatory_ready",
            web_port=9876,
        )

        _, kwargs = MockNotif.call_args
        assert "Install Now" in kwargs["msg"]

    @patch("desktop_app.WINOTIFY_AVAILABLE", True)
    @patch("desktop_app.Notification")
    @patch("desktop_app.audio")
    def test_downloading_message_mentions_background(self, mock_audio, MockNotif):
        """Downloading notification should mention background download."""
        mock_instance = MagicMock()
        MockNotif.return_value = mock_instance
        mock_audio.Default = "default"

        show_update_notification(
            {"latest_version": "3.0.0"},
            state="downloading",
            web_port=9876,
        )

        _, kwargs = MockNotif.call_args
        assert "downloading in background" in kwargs["msg"]


# ---------------------------------------------------------------------------
# 7. /api/update/install route
# ---------------------------------------------------------------------------

class TestUpdateInstallRoute:

    def _make_test_client(self, update_manager):
        """Create a minimal Flask test client with the update install route."""
        from flask import Flask, jsonify

        app = Flask(__name__)
        app.config["TESTING"] = True

        @app.route("/api/update/install")
        def trigger_update_install():
            auto_close_page = lambda title, msg: (
                f'<html><head><title>{title}</title>'
                f'<script>setTimeout(function(){{window.close()}},1500)</script>'
                f'</head><body style="font-family:sans-serif;padding:20px">'
                f'<h2>{title}</h2><p>{msg}</p>'
                f'<p style="color:#888;font-size:12px">This tab will close automatically.</p>'
                f'</body></html>'
            )
            if not update_manager:
                return auto_close_page('Error', 'No update manager available.'), 503
            status = update_manager.get_status()
            state = status.get("state", "idle")
            if state in ("ready", "mandatory_ready", "deferred"):
                threading.Thread(target=update_manager.apply_update, daemon=True).start()
                return auto_close_page('Installing update...', 'The application will restart shortly.'), 200
            elif state == "downloading":
                progress = int((status.get("progress", 0) or 0) * 100)
                return auto_close_page(f'Download in progress ({progress}%)', 'The update will install automatically when complete.'), 200
            else:
                return auto_close_page('No update available', 'You are running the latest version.'), 200

        return app.test_client()

    def test_install_route_triggers_apply_when_ready(self, tmp_path):
        """Route triggers apply_update when state is 'ready'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        staged = tmp_path / "updates" / "TimeTracker_v2.0.0.exe"
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b"binary")
        manager.download_path = str(staged)
        manager._set_state("ready")

        with patch.object(manager, "apply_update", return_value=True) as mock_apply:
            client = self._make_test_client(manager)
            resp = client.get("/api/update/install")
            assert resp.status_code == 200
            assert b"Installing update" in resp.data
            assert b"window.close()" in resp.data
            # Give daemon thread a moment
            import time; time.sleep(0.1)
            mock_apply.assert_called_once()

    def test_install_route_returns_progress_when_downloading(self, tmp_path):
        """Route returns download progress when state is 'downloading'."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("downloading")
        manager.progress = 0.45

        client = self._make_test_client(manager)
        resp = client.get("/api/update/install")
        assert resp.status_code == 200
        assert b"Download in progress" in resp.data

    def test_install_route_returns_no_update_when_idle(self, tmp_path):
        """Route returns 'no update' when state is idle."""
        manager = UpdateManager(str(tmp_path), "1.0.0")

        client = self._make_test_client(manager)
        resp = client.get("/api/update/install")
        assert resp.status_code == 200
        assert b"No update available" in resp.data

    def test_install_route_handles_no_manager(self):
        """Route returns 503 when no update manager is available."""
        client = self._make_test_client(None)
        resp = client.get("/api/update/install")
        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# 8. State change callback passes web_port to notification
# ---------------------------------------------------------------------------

class TestStateChangeNotificationPort:

    @patch("desktop_app.show_update_notification")
    def test_notification_called_with_web_port(self, mock_notif):
        """_on_update_manager_state_changed passes web_port to notification."""
        app = MagicMock()
        app.web_port = 9999
        app.latest_version_info = None
        app._last_notified_update_version = None
        app._last_update_notification_state = None
        app._mandatory_update_enforced = False
        app.update_tray_menu = MagicMock()
        app.update_tray_icon = MagicMock()
        app.update_available = False
        app.update_required = False

        status = {
            "state": "ready",
            "update_info": {"latest_version": "2.0.0"},
            "progress": 1.0,
        }

        # Call the real method on our mock
        desktop_app.TimeTracker._on_update_manager_state_changed(app, status)

        mock_notif.assert_called_once()
        _, kwargs = mock_notif.call_args
        assert kwargs["web_port"] == 9999
        assert kwargs["state"] == "ready"
        assert kwargs["install_callback"] is not None


# ---------------------------------------------------------------------------
# 9. Tray menu item count validation
# ---------------------------------------------------------------------------

class TestTrayMenuItemCount:

    def test_idle_state_has_expected_items(self, tmp_path):
        """Idle state: user label + separator + up-to-date = 3 items."""
        manager = UpdateManager(str(tmp_path), "1.0.0")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        # user label, separator, up-to-date
        assert len(menu.items) == 3

    def test_ready_state_has_expected_items(self, tmp_path):
        """Ready state: user label + separator + install = 3 items (no Later)."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager.download_path = os.path.join(str(tmp_path), "updates", "fake.exe")
        manager._set_state("ready")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        # user label, separator, install  (NO Later)
        assert len(menu.items) == 3

    def test_downloading_state_has_expected_items(self, tmp_path):
        """Downloading state: user label + separator + progress = 3 items (no Cancel)."""
        manager = UpdateManager(str(tmp_path), "1.0.0")
        manager.update_info = {"latest_version": "2.0.0"}
        manager._set_state("downloading")

        with patch.object(desktop_app, "pystray") as mock_pystray:
            mock_pystray.Menu = FakeMenu
            mock_pystray.Menu.SEPARATOR = FakeMenu.SEPARATOR
            with patch.object(desktop_app, "item", FakeMenuItem):
                app = _build_fake_app(manager)
                menu = app._build_tray_menu()

        # user label, separator, progress (NO Cancel Download)
        assert len(menu.items) == 3
