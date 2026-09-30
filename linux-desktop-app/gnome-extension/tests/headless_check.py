"""
Checks run inside run_headless_test.sh against a real headless GNOME Shell.

Maps to plan AC 13 (caller authentication, locked session) and exercises the
real extension + Python client end to end: focused window and a non-black
capture of the focused monitor through a memfd.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.environ['TT_LINUX_ROOT'])

from timetracker_linux.capture.result import CaptureStatus               # noqa: E402
from timetracker_linux.capture.validator import FrameValidator           # noqa: E402
from timetracker_linux.dbus_bus import Bus, DBusCallError                # noqa: E402
from timetracker_linux.gnome.extension_client import (GnomeExtensionCapture,  # noqa: E402
                                                      GnomeExtensionClient, GnomeExtensionWindow)
from timetracker_linux.gnome.setup import ExtensionSetup                 # noqa: E402

RESULTS = []


def check(name, condition, detail=''):
    RESULTS.append((name, bool(condition)))
    print(f"[{'PASS' if condition else 'FAIL'}] {name}{': ' + str(detail) if detail else ''}", flush=True)


def wait_for(predicate, timeout, interval=0.25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception:
            pass
        time.sleep(interval)
    return None


def main():
    bus = wait_for(lambda: Bus('SESSION'), 20)
    check('session bus', bus is not None)
    check('gnome-shell started', wait_for(lambda: bus.name_has_owner('org.gnome.Shell'), 60))

    setup = ExtensionSetup(bus, config_dir=os.environ['XDG_CONFIG_HOME'])
    state = wait_for(lambda: setup.state() == 'ENABLED' and 'ENABLED', 30)
    check('extension enabled', state == 'ENABLED', setup.state())

    client = GnomeExtensionClient(bus)
    version = wait_for(client.version, 10)
    check('GetVersion protocol 1', version and version[0] == 1, version)

    window_backend = GnomeExtensionWindow(client)
    check('no window focused at start', window_backend.focused_window() is None)

    env = dict(os.environ, WAYLAND_DISPLAY=os.environ['TT_WAYLAND_DISPLAY'], GDK_BACKEND='wayland')
    dialog = subprocess.Popen(['zenity', '--info', '--title', 'PROJ-42 headless check',
                               '--text', 'TimeTracker headless capture test ' * 3, '--width', '900'],
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        window = wait_for(window_backend.focused_window, 20)
        check('focused window reported', window is not None, window and window.get('title'))
        check('title from the real window', window and 'PROJ-42' in window['title'], window and window['title'])
        check('pid of the real window', window and window['pid'] == dialog.pid, window and window['pid'])
        check('monitor geometry', window and window['monitor_rect'] == (0, 0, 1280, 800),
              window and window['monitor_rect'])

        def read_window():
            # Like WindowService in the app: an unavailable extension means "no window".
            try:
                return window_backend.focused_window()
            except DBusCallError:
                return None

        capture = GnomeExtensionCapture(client, read_window)
        time.sleep(0.5)
        result = capture.capture()
        check('capture ok', result.status == CaptureStatus.OK, f'{result.status} {result.detail}')
        if result.image is not None:
            check('capture is the focused monitor size', result.image.size == (1280, 800), result.image.size)
            check('capture is not black/blank', FrameValidator().check(result.image) == CaptureStatus.OK)
            check('window id matches focus', result.window_id == window['window_id'],
                  (result.window_id, window['window_id']))

        second = capture.capture()
        check('rate limited within 2 s', second.status == CaptureStatus.SKIPPED_RATE_LIMITED, second.status)

        # Caller authentication: a new connection from a non-allowed executable.
        os.remove(os.environ['TT_ALLOW_FILE'])
        other = GnomeExtensionClient(Bus('SESSION'))
        try:
            other._bus.call('org.gnome.Shell', '/com/amzur/TimeTracker/Shell',
                            'com.amzur.TimeTracker.Shell1', 'GetFocusedWindow')
            denied = False
        except DBusCallError as e:
            denied = bool(e.name and e.name.endswith('AccessDenied'))
        check('unauthorized caller rejected', denied)
        check('GetVersion stays public', other.version() is not None)

        # Locked session: GNOME unloads extensions while locked, so nothing can be
        # captured; after unlock the extension is back and capture works again.
        with open(os.environ['TT_ALLOW_FILE'], 'w') as f:
            f.write(os.path.realpath(sys.executable) + '\n')
        bus.call('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver',
                 'SetActive', 'b', (True,), timeout=5)
        active = wait_for(lambda: bus.call('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver',
                                           'org.gnome.ScreenSaver', 'GetActive')[0], 10)
        check('screen locked', active is True)
        time.sleep(2.1)
        locked_result = capture.capture()
        check('no capture while locked', locked_result.status != CaptureStatus.OK, locked_result.status)
        bus.call('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver',
                 'SetActive', 'b', (False,), timeout=5)
        client.forget()             # what the provider does on unlock
        back = wait_for(lambda: client.available() and capture.capture().status == CaptureStatus.OK, 20, 1.0)
        check('capture works again after unlock', back)
    finally:
        dialog.kill()

    failed = [name for name, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
