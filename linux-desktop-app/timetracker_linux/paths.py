"""
XDG base directories for TimeTracker.

Data stays in ~/.local/share/TimeTracker, which is what the shared core's
get_app_data_dir() already uses on non-Windows, so existing data is found.
"""

import os

APP_DIR_NAME = 'TimeTracker'
CONFIG_DIR_NAME = 'timetracker'
RUNTIME_DIR_NAME = 'timetracker'


def _home(environ):
    return environ.get('HOME') or os.path.expanduser('~')


def _xdg(environ, var, default_relative):
    value = environ.get(var, '')
    # The XDG spec says relative paths are invalid and must be ignored.
    if value and os.path.isabs(value):
        return value
    return os.path.join(_home(environ), default_relative)


def data_dir(environ=None):
    environ = os.environ if environ is None else environ
    return os.path.join(_xdg(environ, 'XDG_DATA_HOME', '.local/share'), APP_DIR_NAME)


def config_dir(environ=None):
    environ = os.environ if environ is None else environ
    return os.path.join(_xdg(environ, 'XDG_CONFIG_HOME', '.config'), CONFIG_DIR_NAME)


def state_dir(environ=None):
    environ = os.environ if environ is None else environ
    return os.path.join(_xdg(environ, 'XDG_STATE_HOME', '.local/state'), APP_DIR_NAME)


def log_dir(environ=None):
    return os.path.join(state_dir(environ), 'logs')


def runtime_dir(environ=None):
    """Per-user tmpfs dir, cleared at logout. None when the session has none."""
    environ = os.environ if environ is None else environ
    base = environ.get('XDG_RUNTIME_DIR', '')
    if not base or not os.path.isabs(base):
        return None
    return os.path.join(base, RUNTIME_DIR_NAME)


def ensure_dir(path):
    """Create `path` (and parents) and make sure it is private (0700)."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path
