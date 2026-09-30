"""
`timetracker --doctor`: what this desktop supports and what the app will use.

Read-only: it queries the session and system bus and never shows anything
on screen, never captures, and never asks for permissions.
"""

import json
import shutil

from . import __version__
from .childenv import clean_env
from .environment import detect, probe_dbus
from .selection import plan_for

TOOLS = ('grim', 'swaymsg', 'hyprctl', 'nmcli', 'gnome-extensions', 'python3')


def _live_checks(environment):
    """Build the real provider (no app attached) and read its live state."""
    from .provider import LinuxPlatformProvider
    live = {}
    try:
        provider = LinuxPlatformProvider(environment=environment)
    except Exception as e:
        return {'error': f'{type(e).__name__}: {e}'}
    live['window_backends_loaded'] = provider.window_service.backend_names
    live['window_source'] = provider.has_window_source()
    focused = provider.window_service.get_focused_window() if live['window_source'] else None
    live['focused_app'] = focused.get('app') if focused else None
    live['capture_backends_loaded'] = provider.capture_service.stats()['backends']
    idle = provider.get_system_idle_seconds()
    live['idle_seconds'] = round(idle, 1) if idle is not None else None
    live['idle_backend'] = provider.idle_service.active_backend_name
    live['screen_locked'] = provider.is_screen_locked()
    bus = provider.session_bus
    if bus is not None:
        try:
            (caps,) = bus.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
                               'org.freedesktop.Notifications', 'GetCapabilities', timeout=1.0)
            live['notifications'] = sorted(caps)
        except Exception as e:
            live['notifications'] = f'unavailable ({e})'
        try:
            live['tray_host'] = bus.name_has_owner('org.kde.StatusNotifierWatcher')
        except Exception:
            live['tray_host'] = None
    return live


def collect(live=True):
    environment = detect()
    path = clean_env().get('PATH', '')
    report = {
        'version': __version__,
        'environment': environment.to_dict(),
        'dbus': probe_dbus(),
        'tools': {tool: shutil.which(tool, path=path) for tool in TOOLS},
        'plan': plan_for(environment),
    }
    if live:
        report['live'] = _live_checks(environment)
    return report


def format_report(report):
    env = report['environment']
    dbus = report['dbus']
    lines = [
        f"TimeTracker Linux doctor (platform layer {report['version']})",
        f"  distro      : {env['distro_pretty'] or 'unknown'}",
        f"  session     : {env['session_type']}",
        f"  desktop     : {env['desktop']} (XDG_CURRENT_DESKTOP={env['desktop_raw'] or '-'})",
        f"  session bus : {'yes' if dbus['bus'] else 'NO - ' + str(dbus['error'])}",
        f"  GNOME Shell : {dbus['gnome_shell_version'] or '-'}",
        f"  extension   : {dbus['gnome_extension_state'] or '-'}",
        f"  KWin        : {_yes_no(dbus['kwin'])}",
        f"  ScreenCast  : portal v{dbus['portal_screencast_version']}"
        if dbus['portal_screencast_version'] is not None else "  ScreenCast  : -",
        "  tools       : " + ', '.join(
            f"{name}={'yes' if found else 'no'}" for name, found in report['tools'].items()),
        "  backend order:",
    ]
    for subsystem, chain in report['plan'].items():
        lines.append(f"    {subsystem:<8}: {' -> '.join(chain)}")
    live = report.get('live')
    if live:
        lines.append('  live:')
        if 'error' in live:
            lines.append(f"    error: {live['error']}")
        else:
            window = 'YES' if live['window_source'] else 'NO - no activity will be recorded on this desktop'
            lines += [
                f"    window source : {window} (loaded: {', '.join(live['window_backends_loaded']) or 'none'})",
                f"    focused app   : {live['focused_app'] or '-'}",
                f"    capture       : {' -> '.join(live['capture_backends_loaded'])}",
                f"    idle clock    : {live['idle_seconds']} s via {live['idle_backend'] or '-'}",
                f"    screen locked : {_yes_no(live['screen_locked'])}",
                f"    notifications : {live.get('notifications', '-')}",
                f"    tray host     : {_yes_no(live.get('tray_host'))}",
            ]
    return '\n'.join(lines)


def _yes_no(value):
    if value is None:
        return '-'
    return 'yes' if value else 'no'


def main(as_json=False):
    report = collect()
    print(json.dumps(report, indent=2, default=str) if as_json else format_report(report))
    return 0
