"""
Start on login via XDG Autostart (GNOME, KDE, Cinnamon, Xfce, MATE, LXQt).

Replaces the Windows HKCU\\...\\Run key. Sway/Hyprland users need an `exec`
line or the optional systemd user unit (documented in the admin guide).
"""

import os
import sys

from . import paths

DESKTOP_ID = 'com.amzur.timetracker'
SYSTEM_AUTOSTART_DIRS = ('/etc/xdg/autostart',)


def user_autostart_file(environ=None):
    environ = os.environ if environ is None else environ
    config_home = environ.get('XDG_CONFIG_HOME', '')
    if not config_home or not os.path.isabs(config_home):
        config_home = os.path.join(environ.get('HOME') or os.path.expanduser('~'), '.config')
    return os.path.join(config_home, 'autostart', f'{DESKTOP_ID}.desktop')


def _system_file(system_dirs):
    for directory in system_dirs:
        path = os.path.join(directory, f'{DESKTOP_ID}.desktop')
        if os.path.exists(path):
            return path
    return None


def quote_exec_arg(arg):
    """Quote per the Desktop Entry spec (Exec key)."""
    if not any(c in arg for c in ' \t\n"\'\\><~|&;$*?#()`'):
        return arg
    escaped = arg.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
    return f'"{escaped}"'


def default_exec():
    """Command line for the installed binary (frozen) or the dev module."""
    if getattr(sys, 'frozen', False):
        return f'{quote_exec_arg(sys.executable)} --autostart'
    return f'{quote_exec_arg(sys.executable)} -m timetracker_linux --autostart'


def _parse(path):
    values = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    key, _, value = line.partition('=')
                    values[key.strip()] = value.strip()
    except OSError:
        pass
    return values


def enable(exec_command=None, environ=None):
    path = user_autostart_file(environ)
    paths.ensure_dir(os.path.dirname(path))
    content = '\n'.join([
        '[Desktop Entry]',
        'Type=Application',
        'Name=TimeTracker',
        'Comment=Jira time tracking',
        f'Exec={exec_command or default_exec()}',
        f'Icon={DESKTOP_ID}',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        # Give the portal / PipeWire / tray host time to start (old build C-6).
        'X-GNOME-Autostart-Delay=5',
        'X-KDE-autostart-after=panel',
        '',
    ])
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'[OK] Added to autostart: {path}')
    return True


def disable(environ=None, system_dirs=SYSTEM_AUTOSTART_DIRS):
    path = user_autostart_file(environ)
    if _system_file(system_dirs):
        # A system-wide entry can only be turned off per user with Hidden=true.
        paths.ensure_dir(os.path.dirname(path))
        with open(path, 'w', encoding='utf-8') as f:
            f.write('[Desktop Entry]\nType=Application\nName=TimeTracker\nHidden=true\n')
        return True
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    return True


def is_enabled(environ=None, system_dirs=SYSTEM_AUTOSTART_DIRS):
    user = _parse(user_autostart_file(environ))
    if user:
        return user.get('Hidden', 'false').lower() != 'true' and \
            user.get('X-GNOME-Autostart-enabled', 'true').lower() != 'false'
    return _system_file(system_dirs) is not None
