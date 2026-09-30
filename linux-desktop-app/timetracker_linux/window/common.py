"""Shared helpers: common window dict, app-name resolution, monitor choice."""

import os

# Processes that host many different apps; their name says nothing about the
# app, so the window's app id / WM_CLASS is used instead (plan §6.3).
GENERIC_RUNTIMES = frozenset({
    'java', 'python', 'python3', 'node', 'nodejs', 'electron', 'bwrap', 'flatpak-bwrap',
    'snap', 'wine', 'wine64-preloader', 'wine-preloader', 'mono', 'dotnet', 'gjs', 'gjs-console',
    'sh', 'bash', 'env', 'qemu-system-x86_64',
})
_GENERIC_PREFIXES = ('python3.', 'java-')


def empty_window():
    return {
        'title': '', 'app': '', 'app_id': '', 'wm_class': '', 'pid': None, 'window_id': None,
        'monitor_name': None, 'monitor_rect': None, 'scale': 1.0, 'minimized': False,
    }


def process_name(pid, psutil_module=None):
    if not pid:
        return ''
    try:
        if psutil_module is None:
            import psutil as psutil_module
        return psutil_module.Process(int(pid)).name()
    except Exception:
        return ''


def is_generic_runtime(name):
    lowered = (name or '').lower()
    return lowered in GENERIC_RUNTIMES or lowered.startswith(_GENERIC_PREFIXES)


def resolve_app_name(window, psutil_module=None):
    """Name used as `application_name` (the Windows build uses the process name).

    Process name when it identifies the app; otherwise the app id / WM_CLASS
    (e.g. JetBrains IDEs run as `java`, WM_CLASS `jetbrains-idea`).
    """
    name = process_name(window.get('pid'), psutil_module)
    if name and not is_generic_runtime(name):
        return name
    for candidate in (window.get('app_id'), window.get('wm_class')):
        if candidate:
            # Reverse-DNS ids (org.mozilla.firefox) keep only the last part.
            short = candidate.rsplit('.', 1)[-1] if candidate.count('.') >= 2 else candidate
            return short.lower()
    return name or ''


def rect_overlap(a, b):
    """Overlap area of two (x, y, width, height) rects."""
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return max(0, right - left) * max(0, bottom - top)


def monitor_for_rect(window_rect, monitors):
    """Monitor dict with the largest overlap (same rule as the Windows build), or None."""
    best, best_area = None, 0
    for monitor in monitors:
        area = rect_overlap(window_rect, monitor['rect'])
        if area > best_area:
            best, best_area = monitor, area
    return best


def xdg_runtime_dir(environ=None):
    environ = os.environ if environ is None else environ
    return environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}'
