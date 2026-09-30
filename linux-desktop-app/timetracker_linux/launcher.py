"""
Start TimeTracker on Linux.

Order matters: the platform provider, the `winotify` adapter and the tray
class must be in place BEFORE `desktop_app` is imported, because the core
reads them at import time (process tables, notification availability).
"""

import logging
import os
import signal
import sys

from . import paths

logger = logging.getLogger(__name__)

EXIT_ALREADY_RUNNING = 1


def core_path():
    """Directory of the shared core in a source checkout (bundled when frozen)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, '..', '..', 'python-desktop-app'))


def ensure_core_importable():
    if getattr(sys, 'frozen', False):
        return
    path = core_path()
    if os.path.isdir(path) and path not in sys.path:
        sys.path.insert(0, path)


def install_fontconfig():
    """Keep colour fonts away from the bundled libXft (see fontconfig/fonts.conf).
    Must run before Tk opens its first window."""
    bundle = getattr(sys, '_MEIPASS', None)
    if not getattr(sys, 'frozen', False) or not bundle or 'FONTCONFIG_FILE' in os.environ:
        return
    conf = os.path.join(bundle, 'fontconfig', 'fonts.conf')
    if os.path.isfile(conf):
        os.environ['FONTCONFIG_FILE'] = conf


def install_notifications():
    from .compat import winotify
    sys.modules['winotify'] = winotify


def install_browser():
    """Route the core's webbrowser.open() through xdg-open with the system libraries;
    a browser started with the bundled LD_LIBRARY_PATH crashes on launch."""
    import webbrowser
    from .compat.winotify import open_url

    def open_with_system(url, new=0, autoraise=True):
        open_url(url)
        return True

    webbrowser.open = open_with_system
    webbrowser.open_new = lambda url: open_with_system(url, 1)
    webbrowser.open_new_tab = lambda url: open_with_system(url, 2)


def install_tray(provider):
    """Point pystray.Icon at the best tray for this session. Returns its name."""
    os.environ.setdefault('PYSTRAY_BACKEND', 'dummy')
    import pystray
    if provider.session_bus is not None:
        from .compat import tray_sni
        pystray.Icon = tray_sni.Icon
        return 'sni'
    if provider.environment.session_type == 'x11':
        try:
            import pystray._xorg as xorg
            pystray.Icon = xorg.Icon
            return 'xembed'
        except Exception as e:
            logger.info(f'[LINUX] XEmbed tray unavailable: {e}')
    from .compat.tray_none import Icon as NoTrayIcon
    pystray.Icon = NoTrayIcon
    return 'none'


def install_signal_handlers():
    """SIGTERM/SIGHUP (logout, systemctl, package upgrade) → normal exit so atexit
    flushes the session. Python's default SIGTERM action skips atexit."""
    def handler(signum, _frame):
        logger.info(f'[LINUX] signal {signum} received, shutting down')
        raise SystemExit(0)

    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, handler)


def prepare_directories():
    # Logs live in data_dir()/logs (the shared core's app_logger).
    for directory in (paths.data_dir(), paths.config_dir()):
        paths.ensure_dir(directory)
    runtime = paths.runtime_dir()
    if runtime:
        paths.ensure_dir(runtime)


def warn_if_untrackable(provider):
    if provider.has_window_source():
        return
    reason = (f'Window tracking is not available on this desktop '
              f'({provider.environment.session_type}/{provider.environment.desktop_raw or provider.environment.desktop}). '
              'No activity will be recorded. Run "timetracker --doctor" for details.')
    logger.warning(f'[LINUX] {reason}')
    try:
        from .compat.winotify import get_notifier
        get_notifier().notify('TimeTracker cannot track this desktop', reason, duration='long')
    except Exception:
        pass


def setup_desktop_integration(provider):
    """Per-desktop one-time setup the package manager cannot do (no user session)."""
    env = provider.environment
    if env.desktop == 'gnome' and env.session_type == 'wayland' and provider.session_bus is not None:
        try:
            from .compat.winotify import get_notifier
            from .gnome.setup import ExtensionSetup
            state = ExtensionSetup(provider.session_bus, notifier=get_notifier()).ensure_enabled()
            logger.info(f'[LINUX] GNOME extension state: {state}')
        except Exception as e:
            logger.warning(f'[LINUX] GNOME extension setup failed: {e}')
    if env.desktop == 'kde' and env.session_type == 'wayland' and provider.session_bus is not None:
        try:
            provider.kwin_focus.ensure_loaded()
        except Exception as e:
            logger.warning(f'[LINUX] KWin script setup failed: {e}')


def run_app(provider_factory=None):
    ensure_core_importable()
    install_fontconfig()
    prepare_directories()
    install_notifications()
    install_browser()
    from .provider import LinuxPlatformProvider, install
    provider = install(provider_factory() if provider_factory else LinuxPlatformProvider())
    tray = install_tray(provider)
    install_signal_handlers()
    provider.tray_kind = tray
    setup_desktop_integration(provider)
    warn_if_untrackable(provider)

    import desktop_app
    desktop_app.main()
    return 0
