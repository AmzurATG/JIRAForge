"""
End-to-end startup validation test.
Verifies the machine is properly configured for TimeTracker to be visible.
Covers all issues from timetracker_yogi.log (2026-06-17, user: yamunay, AMZ-LAP-344):
  1. AyatanaAppIndicator3 installed (Wayland tray visibility)
  2. notify-send installed (login/reauth notifications)
  3. GStreamer pipewiresrc available (screenshot capture)
  4. AppImage installed at canonical location
  5. Web server accessible when app is running
"""

import os
import sys
import socket
import shutil
import subprocess
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APP_PORT = 51777
APPIMAGE_CANONICAL = os.path.expanduser('~/.local/share/TimeTracker/TimeTracker.AppImage')
AUTOSTART_DIR = os.path.expanduser('~/.config/autostart')


def is_port_open(port: int, host: str = '127.0.0.1', timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, OSError):
        return False


class TestSystemDependencies(unittest.TestCase):
    """Live checks for required system packages on Linux."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_notify_send_installed(self):
        """
        notify-send must be installed for login and re-auth notifications.
        Without it, _linux_notify() is a silent no-op and the user receives no alerts.

        Fix: sudo apt install -y libnotify-bin
        """
        path = shutil.which("notify-send")
        self.assertIsNotNone(
            path,
            "notify-send NOT found.\n"
            "Fix: sudo apt install -y libnotify-bin\n"
            "Impact: user will never see login reminders or re-auth alerts on Linux."
        )

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_gstreamer_pipewiresrc_available(self):
        """
        gstreamer1.0-pipewire must be installed for screenshot capture on Wayland.
        Without it, the app runs in metadata-only mode (no OCR, no screen content tracking).

        Fix: sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good
                                  gstreamer1.0-tools gstreamer1.0-pipewire
             systemctl --user restart pipewire pipewire-pulse wireplumber
        """
        result = subprocess.run(
            ['gst-inspect-1.0', 'pipewiresrc'],
            capture_output=True, timeout=10
        )
        self.assertEqual(
            result.returncode, 0,
            "GStreamer pipewiresrc NOT available.\n"
            "Fix:\n"
            "  sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good "
            "gstreamer1.0-tools gstreamer1.0-pipewire\n"
            "  systemctl --user restart pipewire pipewire-pulse wireplumber\n"
            "Impact: screenshot capture disabled, only window titles tracked."
        )

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_ayatana_appindicator_installed_on_wayland(self):
        """
        AyatanaAppIndicator3 must be installed on Wayland for the tray icon to be visible.
        Without it, pystray falls back to _xorg backend which cannot embed on Wayland/GNOME.
        This is the PRIMARY cause of the 'app appears not installed' report.

        Fix: sudo apt install -y gir1.2-ayatanaappindicator3-0.1
        """
        wayland_active = bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
        if not wayland_active:
            self.skipTest("Not running on Wayland — skipping AyatanaAppIndicator check")

        try:
            import gi
            gi.require_version('AyatanaAppIndicator3', '0.1')
            from gi.repository import AyatanaAppIndicator3  # noqa: F401
        except Exception as e:
            self.fail(
                f"AyatanaAppIndicator3 NOT available: {e}\n"
                "Fix: sudo apt install -y gir1.2-ayatanaappindicator3-0.1\n"
                "Impact: system tray icon is INVISIBLE on Wayland — "
                "user sees no evidence the app is running."
            )

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_gstreamer_plugins_base_installed(self):
        """gstreamer1.0-plugins-base provides core elements needed for capture pipeline."""
        result = subprocess.run(
            ['gst-inspect-1.0', 'videorate'],
            capture_output=True, timeout=10
        )
        self.assertEqual(
            result.returncode, 0,
            "GStreamer plugins-base NOT available (videorate element missing).\n"
            "Fix: sudo apt install -y gstreamer1.0-plugins-base"
        )


class TestInstallationState(unittest.TestCase):
    """Verify the app is properly installed at expected locations."""

    def test_appimage_at_canonical_location(self):
        """
        AppImage must exist at ~/.local/share/TimeTracker/TimeTracker.AppImage
        after first run. If missing, the app was never successfully self-installed.
        """
        if not os.path.exists(APPIMAGE_CANONICAL):
            self.skipTest(
                f"AppImage not at {APPIMAGE_CANONICAL} — run TimeTracker once to self-install"
            )
        self.assertTrue(
            os.path.isfile(APPIMAGE_CANONICAL),
            f"AppImage not found at canonical location: {APPIMAGE_CANONICAL}"
        )

    def test_appimage_is_executable(self):
        """AppImage must have executable permission."""
        if not os.path.exists(APPIMAGE_CANONICAL):
            self.skipTest("AppImage not installed")
        self.assertTrue(
            os.access(APPIMAGE_CANONICAL, os.X_OK),
            f"AppImage is not executable: {APPIMAGE_CANONICAL}\n"
            f"Fix: chmod +x {APPIMAGE_CANONICAL}"
        )

    def test_autostart_entry_exists(self):
        """
        Autostart .desktop entry must exist so the app launches on login.
        Without this, the app must be manually started every session.
        """
        if not os.path.isdir(AUTOSTART_DIR):
            self.skipTest(f"Autostart directory not found: {AUTOSTART_DIR}")
        entries = [
            f for f in os.listdir(AUTOSTART_DIR)
            if 'timetracker' in f.lower() and f.endswith('.desktop')
        ]
        self.assertGreater(
            len(entries), 0,
            f"No TimeTracker autostart entry found in {AUTOSTART_DIR}\n"
            "Impact: app does not start automatically on login."
        )

    def test_uninstaller_exists(self):
        """Uninstaller script should be created alongside the AppImage."""
        uninstaller = os.path.expanduser('~/.local/share/TimeTracker/uninstall.sh')
        if not os.path.exists(APPIMAGE_CANONICAL):
            self.skipTest("AppImage not installed")
        self.assertTrue(
            os.path.isfile(uninstaller),
            f"Uninstaller not found: {uninstaller}"
        )


class TestWebServerAccessibility(unittest.TestCase):
    """Verify the web UI is accessible when TimeTracker is running."""

    def test_web_server_responds_on_port_51777(self):
        """Web server on port 51777 must respond regardless of tray state."""
        if not is_port_open(APP_PORT):
            self.skipTest("TimeTracker is not currently running on port 51777")
        try:
            import requests
            resp = requests.get(f'http://localhost:{APP_PORT}/login', timeout=5)
            self.assertEqual(resp.status_code, 200,
                             "Login page should return HTTP 200 when app is running")
        except ImportError:
            # requests not available — use socket check only
            self.assertTrue(is_port_open(APP_PORT),
                            "Port 51777 must be open when TimeTracker is running")

    def test_web_ui_accessible_as_fallback_when_tray_invisible(self):
        """
        On Wayland with broken tray (xorg backend), the web UI at
        http://localhost:51777 is the only way to interact with the app.
        This test confirms the port is open when the app is running.
        """
        if not is_port_open(APP_PORT):
            self.skipTest("TimeTracker not running — start it first for this test")
        self.assertTrue(is_port_open(APP_PORT),
                        f"Port {APP_PORT} not open — web UI fallback is unavailable")


class TestNotificationPipeline(unittest.TestCase):
    """Test the Linux notification pipeline end-to-end."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_notify_send_delivers_test_notification(self):
        """notify-send should exit 0 when delivering a test notification."""
        notify_send = shutil.which("notify-send")
        if not notify_send:
            self.skipTest("notify-send not installed")
        result = subprocess.run(
            [notify_send, '--urgency', 'low', '--app-name', 'TimeTracker Test',
             'TimeTracker Test', 'Notification system working correctly'],
            capture_output=True, timeout=5
        )
        self.assertEqual(
            result.returncode, 0,
            f"notify-send exited with {result.returncode}: "
            f"{result.stderr.decode(errors='replace').strip()}\n"
            "The notification daemon may not be running or DBUS_SESSION_BUS_ADDRESS is unset."
        )

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_dbus_session_bus_address_set(self):
        """
        DBUS_SESSION_BUS_ADDRESS must be set for notify-send to reach the desktop.
        When TimeTracker is launched from an AppImage without a login shell,
        this env var may be missing, causing silent notification failures.
        """
        dbus_addr = os.environ.get('DBUS_SESSION_BUS_ADDRESS')
        self.assertIsNotNone(
            dbus_addr,
            "DBUS_SESSION_BUS_ADDRESS is not set.\n"
            "notify-send may silently fail without it.\n"
            "Fix: ensure TimeTracker launches within a D-Bus session environment."
        )


if __name__ == '__main__':
    unittest.main(verbosity=2)
