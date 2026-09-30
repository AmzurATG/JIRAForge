"""
Tests for the Linux web-UI additions and "Remove my data and sign out".

Spec: implementation plan §6.11 (data removal), §6.15 (status), §8.2 (consent text).
"""

import os
from types import SimpleNamespace
from unittest.mock import Mock

from timetracker_linux import ui


def test_only_local_origins_allowed():
    assert ui.is_local_origin('http://localhost:51778', 51778)
    assert ui.is_local_origin('http://127.0.0.1:51778', 51778)
    assert not ui.is_local_origin('https://evil.example', 51778)
    assert not ui.is_local_origin('', 51778)
    assert not ui.is_local_origin('http://localhost:9999', 51778)
    assert not ui.is_local_origin('null', 51778)


def test_consent_section_mentions_prompt_and_indicator():
    text = ui.consent_section_html()
    assert 'never saved or uploaded' in text
    assert 'Remember' in text
    assert 'screen is being shared' in text


class _Provider:
    def __init__(self, backends, last=None):
        self.capture_service = SimpleNamespace(_backends=backends)
        self._last = last

    def diagnostics(self):
        return {'desktop_raw': 'ubuntu:GNOME', 'desktop': 'gnome', 'session_type': 'wayland',
                'window_backend': 'gnome_extension', 'idle_backend': 'mutter'}

    def get_capture_status(self):
        return {'active_backend': 'portal_screencast', 'last': self._last}

    def has_window_source(self):
        return True


def test_settings_section_status_and_buttons():
    portal = SimpleNamespace(name='portal_screencast')
    html = ui.settings_section_html(_Provider([portal], last={'status': 'DENIED', 'detail': '<no grant>'}))
    assert 'gnome_extension' in html and 'mutter' in html
    assert '&lt;no grant&gt;' in html and '<no grant>' not in html      # escaped
    assert 'Allow screen access' in html
    assert 'Remove my data and sign out' in html


def test_no_allow_button_without_portal():
    html = ui.settings_section_html(_Provider([SimpleNamespace(name='gnome_extension')]))
    assert 'Allow screen access' not in html


def test_remove_user_data_deletes_only_our_dirs(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    data = home / '.local/share/TimeTracker'
    config = home / '.config/timetracker'
    state = home / '.local/state/TimeTracker'
    other = home / '.local/share/SomethingElse'
    for directory in (data, config, state, other):
        directory.mkdir(parents=True)
        (directory / 'f').write_text('x')
    monkeypatch.setenv('HOME', str(home))
    for var in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(ui.autostart, 'disable', Mock())
    keyring_module = Mock()
    app = Mock()
    done = ui.remove_user_data(app, keyring_module=keyring_module, sensitive_keys=('access_token',))
    assert not data.exists() and not config.exists() and not state.exists()
    assert other.exists()
    app.auth_manager.logout.assert_called_once()
    deleted = {call.args[1] for call in keyring_module.delete_password.call_args_list}
    assert {'access_token', 'db_encryption_key', 'screencast_restore_token'} <= deleted
    assert 'local data deleted' in done


def test_safe_rmtree_refuses_unexpected_paths(tmp_path):
    victim = tmp_path / 'Documents'
    victim.mkdir()
    ui._safe_rmtree(str(victim), 'TimeTracker')
    assert victim.exists()
