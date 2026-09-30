"""
Linux session / desktop detection and capability probe.

`detect()` is a pure function over environment variables and os-release text,
so backend selection can be tested for any distro and desktop. `probe_dbus()`
adds live facts from the session bus; every fact is optional and a failure
only leaves that fact empty.

Rule: the session is X11 only when XDG_SESSION_TYPE says so. XWayland sets
DISPLAY under Wayland too, and choosing X11 capture there is exactly how the
black-image bug happens.
"""

import logging
import os
import shlex
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

EXTENSION_UUID = 'timetracker@amzur.com'

# XDG_CURRENT_DESKTOP token → family. Checked in this order, so specific
# desktops win over generic tokens (e.g. "GNOME-Classic:GNOME").
_DESKTOP_TOKENS = (
    ('kde', 'kde'),
    ('sway', 'sway'),
    ('hyprland', 'hyprland'),
    ('labwc', 'wlroots'),
    ('river', 'wlroots'),
    ('wayfire', 'wlroots'),
    ('wlroots', 'wlroots'),
    ('x-cinnamon', 'cinnamon'),
    ('cinnamon', 'cinnamon'),
    ('xfce', 'xfce'),
    ('mate', 'mate'),
    ('gnome', 'gnome'),
)

# gnome-shell js/misc/extensionUtils.js ExtensionState
_EXTENSION_STATES = {
    1: 'ENABLED',
    2: 'DISABLED',
    3: 'ERROR',
    4: 'OUT_OF_DATE',
    5: 'DOWNLOADING',
    6: 'INITIALIZED',
    7: 'DISABLING',
    8: 'ENABLING',
    99: 'UNINSTALLED',
}


@dataclass(frozen=True)
class Environment:
    session_type: str       # 'x11' | 'wayland' | 'unknown'
    desktop: str            # family, see _DESKTOP_TOKENS, or 'other'
    desktop_raw: str
    distro_id: str
    distro_version: str
    distro_pretty: str

    def to_dict(self):
        return asdict(self)


def detect(environ=None, os_release_text=None):
    """Detect session type, desktop family and distribution."""
    environ = os.environ if environ is None else environ
    if os_release_text is None and environ is os.environ:
        os_release_text = read_os_release()
    os_release = parse_os_release(os_release_text or '')
    desktop_raw = environ.get('XDG_CURRENT_DESKTOP', '')
    return Environment(
        session_type=_session_type(environ),
        desktop=_desktop_family(desktop_raw, environ),
        desktop_raw=desktop_raw,
        distro_id=os_release.get('ID', ''),
        distro_version=os_release.get('VERSION_ID', ''),
        distro_pretty=os_release.get('PRETTY_NAME', ''),
    )


def _session_type(environ):
    declared = environ.get('XDG_SESSION_TYPE', '').strip().lower()
    if declared in ('x11', 'wayland'):
        return declared
    # Missing or 'tty' (e.g. launched from a terminal multiplexer): infer.
    if environ.get('WAYLAND_DISPLAY'):
        return 'wayland'
    if environ.get('DISPLAY'):
        return 'x11'
    return 'unknown'


def _desktop_family(desktop_raw, environ):
    tokens = [t.strip().lower() for t in desktop_raw.split(':') if t.strip()]
    for token_prefix, family in _DESKTOP_TOKENS:
        if any(t == token_prefix or t.startswith(token_prefix + '-') for t in tokens):
            return family
    if environ.get('SWAYSOCK'):
        return 'sway'
    if environ.get('HYPRLAND_INSTANCE_SIGNATURE'):
        return 'hyprland'
    return 'other'


def read_os_release(paths=('/etc/os-release', '/usr/lib/os-release')):
    for path in paths:
        try:
            with open(path, encoding='utf-8') as f:
                return f.read()
        except OSError:
            continue
    return ''


def parse_os_release(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, raw = line.partition('=')
        try:
            parts = shlex.split(raw)
            values[key.strip()] = parts[0] if parts else ''
        except ValueError:
            values[key.strip()] = raw.strip().strip('"\'')
    return values


def extension_state_name(state):
    try:
        state = int(state)
    except (TypeError, ValueError):
        return f'UNKNOWN({state})'
    return _EXTENSION_STATES.get(state, f'UNKNOWN({state})')


def _default_client_factory():
    from .dbus_util import DBusClient
    return DBusClient()


def probe_dbus(client_factory=None):
    """Collect live desktop facts from the session bus. Never raises."""
    result = {
        'bus': False,
        'error': None,
        'gnome_shell_version': None,
        'gnome_extension_state': None,
        'kwin': None,
        'portal_screencast_version': None,
    }
    factory = client_factory or _default_client_factory
    try:
        client = factory()
    except Exception as e:
        result['error'] = str(e)
        return result
    result['bus'] = True

    def attempt(fact, fn):
        try:
            return fn()
        except Exception as e:
            logger.debug(f"D-Bus probe '{fact}' unavailable: {e}")
            return None

    result['gnome_shell_version'] = attempt('gnome_shell_version', lambda: client.get_property(
        'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'ShellVersion'))
    result['kwin'] = attempt('kwin', lambda: client.name_has_owner('org.kde.KWin'))
    result['portal_screencast_version'] = attempt('portal', lambda: client.get_property(
        'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
        'org.freedesktop.portal.ScreenCast', 'version'))

    info = attempt('gnome_extension', lambda: client.call(
        'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
        'GetExtensionInfo', 's', (EXTENSION_UUID,)))
    if info is not None:
        result['gnome_extension_state'] = _extension_state_from_info(info)

    close = getattr(client, 'close', None)
    if close:
        close()
    return result


def _extension_state_from_info(info):
    # Real replies are a 1-tuple holding a{sv}; fakes may pass the dict itself.
    if isinstance(info, tuple) and len(info) == 1:
        info = info[0]
    if not info:
        return 'NOT_INSTALLED'
    state = info.get('state')
    if isinstance(state, tuple) and len(state) == 2:   # jeepney variant (sig, value)
        state = state[1]
    return extension_state_name(state)
