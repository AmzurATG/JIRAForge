"""
Regression tests for the keyring token-loss bug.

Root cause: Windows Credential Manager limits CredentialBlob to 2560 BYTES, stored
as UTF-16 (2 bytes/char) => ~1280 chars max. The chunk size was 2000 chars (~4000
bytes), so large Atlassian access/refresh tokens failed to save to keyring and were
lost on restart. load_tokens() also returned the partial keyring set instead of
falling back to / merging the complete encrypted file.

Fix A: KEYRING_CHUNK_SIZE small enough that every stored value fits the limit.
Fix B: load_tokens() merges keyring + encrypted (keyring wins, encrypted fills gaps).
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from auth import secure_storage as ss


class _FakeKeyring:
    """In-memory stand-in for the OS keyring backend."""
    def __init__(self):
        self.store = {}

    def set_password(self, service, key, value):
        self.store[(service, key)] = value

    def get_password(self, service, key):
        return self.store.get((service, key))

    def delete_password(self, service, key):
        if (service, key) in self.store:
            del self.store[(service, key)]
        else:
            raise Exception('not found')  # mirrors keyring's PasswordDeleteError


# ---------------------------------------------------------------------------
# Fix A: chunking must keep every stored value under the Windows limit.
# ---------------------------------------------------------------------------
def test_keyring_chunk_size_under_windows_limit():
    # 2560-byte UTF-16 blob => ~1280 chars. Must be at or below that.
    assert ss.KEYRING_CHUNK_SIZE <= 1280, "chunk size exceeds Windows Credential Manager limit"


def test_large_token_round_trips_and_chunks_fit_limit(monkeypatch):
    fake = _FakeKeyring()
    monkeypatch.setattr(ss, 'keyring', fake)

    big = 'A' * 3000  # a JWT-sized token, well over the 1280-char limit
    ss._keyring_set('TimeTracker', 'default_refresh_token', big)

    # 1) It round-trips exactly.
    assert ss._keyring_get('TimeTracker', 'default_refresh_token') == big

    # 2) Every individual keyring entry fits the ~1280-char (2560-byte UTF-16) ceiling.
    #    With the old size (2000) the chunks were ~1980 chars and this fails.
    for (service, key), value in fake.store.items():
        assert len(value) <= 1280, f"{key} stored {len(value)} chars, exceeds Windows limit"


def test_small_token_round_trips(monkeypatch):
    fake = _FakeKeyring()
    monkeypatch.setattr(ss, 'keyring', fake)
    ss._keyring_set('TimeTracker', 'default_supabase_token', 'small-token-value')
    assert ss._keyring_get('TimeTracker', 'default_supabase_token') == 'small-token-value'


# ---------------------------------------------------------------------------
# Fix B: load_tokens() merges keyring + encrypted so big tokens that only made it
# to the encrypted fallback are recovered (no re-login).
# ---------------------------------------------------------------------------
def test_load_merges_recovers_tokens_from_encrypted(tmp_path, monkeypatch):
    s = ss.SecureTokenStorage(str(tmp_path))
    monkeypatch.setattr(ss, 'KEYRING_AVAILABLE', True)
    # keyring has only the small tokens (the bug); encrypted has everything.
    monkeypatch.setattr(s, '_load_from_keyring',
                        lambda u: {'supabase_token': 'sb', 'google_refresh_token': 'gr'})
    monkeypatch.setattr(s, '_load_encrypted',
                        lambda u: {'access_token': 'at', 'refresh_token': 'rt',
                                   'supabase_token': 'sb', 'google_refresh_token': 'gr'})

    toks = s.load_tokens('default')
    assert toks.get('access_token') == 'at', "access_token must be recovered from encrypted"
    assert toks.get('refresh_token') == 'rt', "refresh_token must be recovered from encrypted"
    assert toks.get('supabase_token') == 'sb'
    assert s.storage_method == 'keyring+encrypted'


def test_load_merge_keyring_wins_on_conflict(tmp_path, monkeypatch):
    s = ss.SecureTokenStorage(str(tmp_path))
    monkeypatch.setattr(ss, 'KEYRING_AVAILABLE', True)
    # After the chunk fix, keyring holds the fresh tokens; a stale encrypted file
    # must NOT override them.
    monkeypatch.setattr(s, '_load_from_keyring', lambda u: {'access_token': 'fresh'})
    monkeypatch.setattr(s, '_load_encrypted',
                        lambda u: {'access_token': 'stale', 'refresh_token': 'rt'})

    toks = s.load_tokens('default')
    assert toks['access_token'] == 'fresh', "keyring must win on conflict"
    assert toks['refresh_token'] == 'rt', "missing token filled from encrypted"
    assert s.storage_method == 'keyring+encrypted'
