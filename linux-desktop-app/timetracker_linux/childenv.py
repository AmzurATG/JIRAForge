"""
Environment for child processes of the frozen app.

PyInstaller points LD_LIBRARY_PATH (and some toolkit variables) at the
bundled libraries and saves the original as LD_LIBRARY_PATH_ORIG. A child
such as /usr/bin/python3, xdg-open or grim would otherwise load our bundled
libssl/libstdc++ instead of the system ones and crash. Every subprocess the
Linux layer starts must use clean_env().
"""

import os
import sys

_ORIG_SUFFIX = '_ORIG'
_BUNDLE_LIBRARY_VARS = ('LD_LIBRARY_PATH',)


def current_bundle_dir():
    """Directory of the bundled libraries in a frozen build, else None."""
    return getattr(sys, '_MEIPASS', None)


def clean_env(environ=None, frozen=None, bundle_dir=None):
    """Return a copy of `environ` safe for launching system programs."""
    environ = os.environ if environ is None else environ
    frozen = getattr(sys, 'frozen', False) if frozen is None else frozen
    if bundle_dir is None and frozen:
        bundle_dir = current_bundle_dir()
    env = dict(environ)

    for key in [k for k in env if k.endswith(_ORIG_SUFFIX)]:
        target = key[:-len(_ORIG_SUFFIX)]
        env[target] = env.pop(key)

    if frozen:
        for key in _BUNDLE_LIBRARY_VARS:
            if key + _ORIG_SUFFIX not in environ:
                env.pop(key, None)
        if bundle_dir:
            for key in [k for k, v in env.items() if bundle_dir in v]:
                env.pop(key)
    return env
