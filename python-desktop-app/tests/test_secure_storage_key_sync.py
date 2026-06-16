"""
Regression guard for the two SENSITIVE_TOKEN_KEYS lists.

desktop_app.py and auth/secure_storage.py each declare SENSITIVE_TOKEN_KEYS and
they MUST be identical. save_tokens() persists whatever dict it is handed, but the
LOAD/DELETE paths (_load_from_keyring / _load_encrypted / delete_tokens) iterate
secure_storage's list — so a key present in one list but absent from the other is
written to the vault yet never read back, silently dropping that credential on
every restart.

This exact drift shipped on 2026-06-16: 'device_token' was in desktop_app's list
(so it SAVED) but missing from secure_storage's (so it never LOADED). Server-side
token custody therefore reverted to the legacy refresh path — and the forced
re-login it was built to eliminate — on every restart / auto-update.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from auth import secure_storage as ss  # noqa: E402
import desktop_app  # noqa: E402


def test_sensitive_token_key_lists_are_identical():
    """Bidirectional: any divergence between the two lists is a save-but-never-load
    bug. (The older google guard only checked subset in one direction.)"""
    assert set(desktop_app.SENSITIVE_TOKEN_KEYS) == set(ss.SENSITIVE_TOKEN_KEYS), (
        "desktop_app.py and auth/secure_storage.py SENSITIVE_TOKEN_KEYS drifted: "
        f"desktop_app={sorted(desktop_app.SENSITIVE_TOKEN_KEYS)} "
        f"secure_storage={sorted(ss.SENSITIVE_TOKEN_KEYS)}. A key in one but not the "
        "other is saved to the vault but never loaded back on restart."
    )


def test_device_token_is_a_loadable_sensitive_key():
    """The custody session token specifically must be in the loaded list."""
    assert 'device_token' in ss.SENSITIVE_TOKEN_KEYS


def test_device_token_round_trips_through_storage(tmp_path, monkeypatch):
    """End-to-end: a saved device_token must come back on load. Exercises the
    encrypted-file path (no real Windows Credential Manager needed); it filters by
    the same SENSITIVE_TOKEN_KEYS list, so it fails if device_token is missing."""
    monkeypatch.setattr(ss, 'KEYRING_AVAILABLE', False)
    store = ss.SecureTokenStorage(str(tmp_path))
    store.save_tokens({
        'access_token': 'a-tok',
        'refresh_token': 'r-tok',
        'supabase_token': 's-tok',
        'device_token': 'DEV-SESSION-TOKEN-xyz',
    })

    # Fresh instance to prove it survives a "restart" (no in-memory carryover).
    reloaded = ss.SecureTokenStorage(str(tmp_path)).load_tokens()
    assert reloaded is not None
    assert reloaded.get('device_token') == 'DEV-SESSION-TOKEN-xyz', (
        "device_token was saved but not loaded back — custody would be forgotten "
        "on restart."
    )
