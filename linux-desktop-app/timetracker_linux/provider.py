"""
LinuxPlatformProvider: the object registered with the shared core's
platform_hooks (see python-desktop-app/platform_hooks.py and the seam table
in plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md).
"""

import ctypes
import logging
import os
import platform
import sys
import threading
import time

from . import app_identity, autostart, location, machine_key, paths, updates
from .capture.backends.null import NullBackend
from .capture.service import CaptureService
from .environment import detect
from .idle import (FreedesktopScreenSaverIdle, IdleService, LogindIdleHint, MutterIdle,
                   XScreenSaverIdle)
from .selection import plan_for
from .session_events import SessionEvents
from .single_instance import InstanceLock
from .window.service import WindowService

logger = logging.getLogger(__name__)

FRAME_REUSE_S = 10.0       # the core's OCR throttle; a newer frame would not be used
DEFAULT_WEB_PORT = '51778'  # desktop_app.EMBEDDED_CONFIG['WEB_PORT']


def _safe_bus(kind):
    try:
        from .dbus_bus import get_bus
        return get_bus(kind)
    except Exception as e:
        logger.info(f'[LINUX] {kind.lower()} bus unavailable: {e}')
        return None


class Backends:
    """Factories for every backend name used in selection.plan_for()."""

    def __init__(self, provider):
        self.p = provider

    # --- window ---------------------------------------------------------
    def window(self, name):
        env = self.p.environment
        if name == 'x11_ewmh':
            from .window.x11_ewmh import X11EwmhWindow
            return X11EwmhWindow(self.p.x11)
        if name == 'sway':
            from .window.wlroots_ipc import SwayWindow
            return SwayWindow()
        if name == 'hyprland':
            from .window.wlroots_ipc import HyprlandWindow
            return HyprlandWindow()
        if name == 'gnome_extension' and self.p.session_bus is not None:
            from .gnome.extension_client import GnomeExtensionWindow
            return GnomeExtensionWindow(self.p.gnome_extension)
        if name == 'kwin_script' and self.p.session_bus is not None:
            from .kde.kwin_script import KWinScriptWindow
            return KWinScriptWindow(self.p.kwin_focus)
        if name == 'atspi':
            from .helper_client import AtspiWindow
            return AtspiWindow(self.p.helper)
        return None

    # --- capture --------------------------------------------------------
    def capture(self, name):
        reader = self.p.read_window_fresh
        if name == 'x11':
            from .capture.backends.x11 import X11Capture
            return X11Capture(reader, self.p.x11)
        if name == 'wlroots':
            from .capture.backends.wlroots import WlrootsCapture
            return WlrootsCapture(reader, output_reader=self.p.focused_output)
        if name == 'gnome_extension' and self.p.session_bus is not None:
            from .gnome.extension_client import GnomeExtensionCapture
            return GnomeExtensionCapture(self.p.gnome_extension, reader)
        if name == 'kwin' and self.p.session_bus is not None:
            from .kde.kwin_screenshot import KWinCapture
            return KWinCapture(self.p.session_bus, reader)
        if name == 'portal_screencast':
            from .compat.winotify import get_notifier
            from .helper_client import PermissionPrompter, PortalScreenCastCapture
            return PortalScreenCastCapture(self.p.helper, reader, monitor_count_reader=self.p.monitor_count,
                                           on_permission_needed=PermissionPrompter(get_notifier))
        return None

    # --- idle -----------------------------------------------------------
    def idle(self, name):
        bus, system = self.p.session_bus, self.p.system_bus
        if name == 'mutter' and bus is not None:
            return MutterIdle(bus)
        if name == 'freedesktop_screensaver' and bus is not None:
            return FreedesktopScreenSaverIdle(
                bus, milliseconds=self.p.environment.desktop == 'kde')
        if name == 'xss':
            return XScreenSaverIdle(display_factory=lambda: self.p.x11.display)
        if name == 'wayland_idle_notify':
            from .wayland_idle import WaylandIdleNotify
            return WaylandIdleNotify.create_or_none()
        if name == 'logind_idlehint' and system is not None:
            return LogindIdleHint(system, lambda: self.p.session_events._session_path)
        return None


class LinuxPlatformProvider:

    update_platform = 'linux'

    def __init__(self, environment=None, session_bus=None, system_bus=None,
                 capture_service=None, window_service=None, idle_service=None,
                 session_events=None, instance_lock=None, connect_buses=True):
        self.environment = environment or detect()
        self.plan = plan_for(self.environment)
        self.session_bus = session_bus if session_bus is not None or not connect_buses \
            else _safe_bus('SESSION')
        self.system_bus = system_bus if system_bus is not None or not connect_buses \
            else _safe_bus('SYSTEM')
        self._x11 = None
        self._helper = None
        self._gnome_extension = None
        self._kwin_focus = None
        self._backends = Backends(self)
        self.window_service = window_service or WindowService(
            self._build(self._backends.window, self.plan['window']))
        self.idle_service = idle_service or IdleService(
            self._build(self._backends.idle, self.plan['idle']))
        self.session_events = session_events or SessionEvents(self.system_bus, self.session_bus)
        self.capture_service = capture_service or CaptureService(self._capture_backends())
        self._instance_lock = instance_lock or InstanceLock()
        self._updates = updates.UpdateNotifier()
        self._expected_window_id = None
        self._frame_cache = None            # (window_id, monotonic time, image)
        self._app = None

    # ---------------------------------------------------------- construction

    @staticmethod
    def _build(factory, names):
        built = []
        for name in names:
            if name == 'null':
                continue
            try:
                backend = factory(name)
            except Exception as e:
                logger.info(f"[LINUX] backend '{name}' not available: {e}")
                backend = None
            if backend is not None:
                built.append(backend)
        return built

    def _capture_backends(self):
        backends = self._build(self._backends.capture, self.plan['capture'])
        names = [b.name for b in backends]
        reason = (f"no screen capture method for {self.environment.session_type}/"
                  f"{self.environment.desktop}" + (f" (tried: {', '.join(names)})" if names else ''))
        return backends + [NullBackend(reason)]

    @property
    def x11(self):
        if self._x11 is None:
            from .window.x11_ewmh import X11Display
            self._x11 = X11Display()
        return self._x11

    @property
    def helper(self):
        if self._helper is None:
            from .helper_client import HelperClient
            self._helper = HelperClient()
        return self._helper

    @property
    def gnome_extension(self):
        if self._gnome_extension is None:
            from .gnome.extension_client import GnomeExtensionClient
            self._gnome_extension = GnomeExtensionClient(self.session_bus)
        return self._gnome_extension

    @property
    def kwin_focus(self):
        if self._kwin_focus is None:
            from .kde.kwin_script import KWinFocusService
            self._kwin_focus = KWinFocusService(self.session_bus)
        return self._kwin_focus

    # ------------------------------------------------------------ windows

    def get_focused_window(self):
        window = self.window_service.get_focused_window()
        self._expected_window_id = window.get('window_id') if window else None
        return window

    def read_window_fresh(self):
        """Window read by capture backends right before grabbing (for the stale check)."""
        return self.window_service.get_focused_window()

    def focused_output(self):
        for backend in self.window_service._backends:
            reader = getattr(backend, 'focused_output', None)
            if reader is not None:
                try:
                    return reader()
                except Exception:
                    continue
        return None

    def has_window_source(self):
        return self.window_service.has_backend()

    def monitor_count(self):
        """Number of logical monitors, or 0 if unknown (used by the portal backend)."""
        if self.environment.desktop == 'gnome' and self.session_bus is not None:
            try:
                reply = self.session_bus.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                                              'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', timeout=1.0)
                return len(reply[2])
            except Exception:
                return 0
        if self.environment.session_type == 'x11':
            try:
                return len(self.x11.monitors())
            except Exception:
                return 0
        return 0

    # ------------------------------------------------------------ capture

    def capture_focused_monitor(self):
        if self.is_screen_locked():
            return None     # never capture the lock screen (GNOME also unloads extensions then)
        expected = self._expected_window_id
        cached = self._frame_cache
        if cached and expected is not None and cached[0] == expected \
                and time.monotonic() - cached[1] < FRAME_REUSE_S:
            return cached[2].copy()
        result = self.capture_service.capture(expected_window_id=expected)
        if result.image is not None:
            self._frame_cache = (result.window_id or expected, time.monotonic(), result.image)
        elif result.status.value.startswith('SKIPPED') or result.status.is_failure:
            self._frame_cache = None
        return result.image

    def get_capture_status(self):
        return self.capture_service.stats()

    # ------------------------------------------------- idle / lock / events

    def get_system_idle_seconds(self):
        return self.idle_service.get_idle_seconds()

    def use_input_hooks(self):
        # pynput sees global input only on X11; on Wayland the idle clock is authoritative.
        return self.environment.session_type == 'x11'

    def is_screen_locked(self):
        return self.session_events.is_locked()

    def start_session_events(self, app):
        self._app = app
        return self.session_events.start(_EventRelay(app, self))

    def on_suspend(self):
        """Lock / sleep: stop screen sharing so the indicator is not shown while away."""
        for backend in getattr(self.capture_service, '_backends', []):
            stop = getattr(backend, 'stop', None)
            if stop is not None:
                try:
                    stop()
                except Exception:
                    pass
        self._frame_cache = None

    def on_resume(self):
        """After unlock / wake: re-probe backends that may have become available."""
        if self._gnome_extension is not None:
            self._gnome_extension.forget()
        self.capture_service.reprobe()
        self.window_service.reset()
        self.idle_service.reset()
        self._frame_cache = None

    # ------------------------------------------------------- plumbing seams

    def acquire_single_instance(self):
        if self._instance_lock.acquire():
            return True
        self._show_running_instance()
        return False

    @staticmethod
    def _show_running_instance():
        """A second launch from the app menu should bring up the running instance's
        page (login or dashboard) instead of exiting with nothing visible."""
        from .compat.winotify import open_url
        core = sys.modules.get('desktop_app')
        if core is not None:
            port = core.get_env_var('WEB_PORT', 51777)
        else:
            # The launcher checks before the core is imported; mirror its EMBEDDED_CONFIG default.
            port = os.environ.get('WEB_PORT') or DEFAULT_WEB_PORT
        open_url(f'http://localhost:{port}/')

    def release_single_instance(self):
        self._instance_lock.release()

    def autostart_enable(self):
        return autostart.enable()

    def autostart_disable(self):
        return autostart.disable()

    def autostart_is_enabled(self):
        return autostart.is_enabled()

    def install_application(self):
        return True     # the package manager owns install / uninstall

    def handle_update_available(self, app, info):
        return self._updates.handle(app, info)

    def get_wifi_ssid(self):
        return location.get_wifi_ssid(self.system_bus)

    def get_local_ip(self):
        return location.get_local_ip()

    def process_tables(self):
        return app_identity.process_tables()

    def search_running_apps(self, term):
        return app_identity.search_running_apps(term)

    def lower_current_thread_priority(self):
        lower_thread_priority()

    def machine_key_material(self):
        return machine_key.key_material()

    def config_dir(self):
        return paths.ensure_dir(paths.config_dir())

    # ----------------------------------------------------------- web UI

    def consent_section_html(self):
        from . import ui
        return ui.consent_section_html()

    def settings_section_html(self):
        from . import ui
        return ui.settings_section_html(self)

    def is_local_origin(self, origin, web_port):
        from . import ui
        return ui.is_local_origin(origin, web_port)

    def request_screen_access(self):
        """Start the one-time portal grant (user clicked "Allow screen access")."""
        for backend in getattr(self.capture_service, '_backends', []):
            if getattr(backend, 'name', '') == 'portal_screencast':
                threading.Thread(target=backend.request_permission, name='screencast-grant', daemon=True).start()
                self.capture_service.reprobe()
                return 'Your desktop will now ask which screens TimeTracker may read. Choose "Remember".'
        return 'Screen access is already handled by your desktop; nothing to allow.'

    def remove_user_data(self, app, sensitive_keys=()):
        from . import ui
        self.on_suspend()
        return ui.remove_user_data(app, sensitive_keys=sensitive_keys)

    # ---------------------------------------------------------- diagnostics

    def diagnostics(self):
        env = self.environment
        capture = self.capture_service.stats()
        return {
            'distro': env.distro_pretty,
            'session_type': env.session_type,
            'desktop': env.desktop,
            'desktop_raw': env.desktop_raw,
            'kernel': platform.release(),
            'window_backend': self.window_service.active_backend_name,
            'window_backends': self.window_service.backend_names,
            'idle_backend': self.idle_service.active_backend_name,
            'capture_backend': capture.get('active_backend'),
            'capture_backends': capture.get('backends'),
            'capture_by_status': capture.get('by_status'),
            'install_mode': updates.install_mode(),
        }

    def log_display_environment(self):
        d = self.diagnostics()
        logger.info(f"[LINUX] {d['distro'] or 'unknown distro'} | session={d['session_type']} "
                    f"desktop={d['desktop_raw'] or d['desktop']} | install={d['install_mode']}")
        logger.info(f"[LINUX] window={' -> '.join(d['window_backends']) or 'none'} "
                    f"capture={' -> '.join(d['capture_backends'] or [])} "
                    f"idle={' -> '.join(self.plan['idle'])}")


class _EventRelay:
    """Passes session events to the app, re-probing backends after resume."""

    def __init__(self, app, provider):
        self._app = app
        self._provider = provider

    def _on_system_sleep(self):
        self._provider.on_suspend()
        self._app._on_system_sleep()

    def _on_system_wake(self):
        self._provider.on_resume()
        self._app._on_system_wake()

    def _on_screen_lock(self):
        self._provider.on_suspend()
        self._app._on_screen_lock()

    def _on_screen_unlock(self):
        self._provider.on_resume()
        self._app._on_screen_unlock()

    def _on_system_shutdown(self):
        self._app._on_system_shutdown()


_IOPRIO_SET = {'x86_64': 251, 'aarch64': 30}
_IOPRIO_CLASS_IDLE = 3


def lower_thread_priority():
    """nice 10 and idle I/O class for the calling thread (Linux sets both per thread)."""
    tid = threading.get_native_id()
    try:
        os.setpriority(os.PRIO_PROCESS, tid, 10)
    except OSError as e:
        logger.debug(f'setpriority failed: {e}')
    number = _IOPRIO_SET.get(platform.machine())
    if number is not None:
        try:
            ctypes.CDLL(None, use_errno=True).syscall(number, 1, tid, _IOPRIO_CLASS_IDLE << 13)
        except Exception as e:
            logger.debug(f'ioprio_set failed: {e}')


def install(provider=None):
    """Create (if needed) and register the provider with the shared core."""
    import platform_hooks
    provider = provider or LinuxPlatformProvider()
    platform_hooks.register(provider)
    logger.info(f"[LINUX] platform provider registered for "
                f"{provider.environment.session_type}/{provider.environment.desktop}")
    return provider
