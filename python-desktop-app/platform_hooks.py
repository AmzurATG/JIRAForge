"""
Platform provider registry.

A non-Windows build (see linux-desktop-app/) registers a provider object
before desktop_app starts. Core code asks `get()` at each platform-specific
call site: when a provider is registered it handles the call, otherwise the
existing Windows code path runs unchanged.

Nothing is registered on Windows.
"""

import threading

_lock = threading.Lock()
_provider = None


def register(provider):
    """Install the platform provider for this process."""
    global _provider
    with _lock:
        _provider = provider


def get():
    """Return the registered provider, or None."""
    return _provider


def clear():
    """Remove the registered provider (used by tests)."""
    global _provider
    with _lock:
        _provider = None
