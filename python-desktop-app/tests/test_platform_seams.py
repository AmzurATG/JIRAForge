"""
Tests for the platform provider seams in desktop_app, db_connection and
auth/secure_storage.

Spec: linux-desktop-app/plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 1-8)

TimeTracker is built with __new__ and only the attributes each seam touches,
so no database, network or UI is created.
"""

import os
import sys
import threading
import time
from unittest.mock import MagicMock, Mock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import platform_hooks
import desktop_app as da
from desktop_app import TimeTracker


class Provider:
    """Provider with every optional seam; tests override what they need."""

    update_platform = 'linux'

    def __init__(self, **values):
        self.values = values
        self.calls = []

    def _get(self, name, default=None):
        self.calls.append(name)
        return self.values.get(name, default)

    def get_focused_window(self):
        return self._get('window')

    def is_screen_locked(self):
        return self._get('locked', False)

    def get_system_idle_seconds(self):
        return self._get('idle')

    def use_input_hooks(self):
        return self._get('input_hooks', False)

    def start_session_events(self, app):
        self.calls.append(('start_session_events', app))
        return True

    def acquire_single_instance(self):
        return self._get('instance', True)

    def release_single_instance(self):
        self.calls.append('release_single_instance')

    def autostart_enable(self):
        return self._get('autostart_enable', True)

    def autostart_disable(self):
        return self._get('autostart_disable', True)

    def autostart_is_enabled(self):
        return self._get('autostart_is_enabled', True)

    def install_application(self):
        return self._get('install', True)

    def handle_update_available(self, app, info):
        self.calls.append(('update', info.get('latest_version')))
        return self.values.get('handles_update', True)

    def get_wifi_ssid(self):
        return self._get('ssid')

    def get_local_ip(self):
        return self._get('local_ip')

    def lower_current_thread_priority(self):
        self.calls.append('lower_priority')

    def machine_key_material(self):
        return self._get('key_material', 'alice@0123abcd')

    def config_dir(self):
        return self._get('config_dir')


@pytest.fixture
def provider():
    p = Provider()
    platform_hooks.register(p)
    yield p
    platform_hooks.clear()


@pytest.fixture(autouse=True)
def _no_provider_leak():
    yield
    platform_hooks.clear()


def _tracker(**attrs):
    tracker = TimeTracker.__new__(TimeTracker)
    tracker.current_window_key = None
    tracker.current_window_start_time = None
    tracker.current_window_db_start_time = None
    tracker.current_window_screenshot_id = None
    tracker.current_window_record_created_at = None
    tracker.add_admin_log = Mock()
    for name, value in attrs.items():
        setattr(tracker, name, value)
    return tracker


# --------------------------------------------------------------------- AC 2

class TestActiveWindow:

    def test_provider_window_and_switch_detection(self, provider):
        tracker = _tracker()
        provider.values['window'] = {'title': 'PROJ-1 - VS Code', 'app': 'code'}
        first = tracker.get_active_window()
        assert first['title'] == 'PROJ-1 - VS Code'
        assert first['app'] == 'code'
        assert first['window_key'] == 'code|||PROJ-1 - VS Code'
        assert first['is_new_window'] is True

        again = tracker.get_active_window()
        assert again['is_new_window'] is False

        provider.values['window'] = {'title': 'Inbox', 'app': 'thunderbird'}
        switched = tracker.get_active_window()
        assert switched['is_new_window'] is True
        assert tracker.previous_window_info['app'] == 'code'

    def test_provider_none_is_unknown_without_switch(self, provider):
        tracker = _tracker()
        provider.values['window'] = {'title': 'A', 'app': 'a'}
        tracker.get_active_window()
        provider.values['window'] = None
        result = tracker.get_active_window()
        assert result['window_key'] == 'unknown'
        assert result['is_new_window'] is False
        assert tracker.current_window_key == 'a|||A'

    def test_no_provider_no_win32_is_unknown(self):
        with patch.object(da, 'WIN32_AVAILABLE', False):
            result = _tracker().get_active_window()
        assert result['window_key'] == 'unknown'


# --------------------------------------------------------------------- AC 3

class TestLockAndIdle:

    def test_locked_from_provider(self, provider):
        provider.values['locked'] = True
        assert _tracker()._is_screen_locked() is True

    def test_idle_from_provider(self, provider):
        provider.values['idle'] = 42.5
        assert _tracker().get_system_idle_seconds() == 42.5

    def test_idle_none_from_provider(self, provider):
        provider.values['idle'] = None
        assert _tracker().get_system_idle_seconds() is None


# --------------------------------------------------------------------- AC 4

def test_no_input_hooks_keeps_heartbeat_without_pynput(provider):
    provider.values['input_hooks'] = False
    tracker = _tracker(running=True, _activity_monitor_failed=False, _activity_monitor_heartbeat=0)
    with patch.dict(sys.modules, {'pynput': None}):
        worker = threading.Thread(target=tracker.monitor_user_activity, daemon=True)
        worker.start()
        time.sleep(0.3)
        tracker.running = False
        worker.join(3)
    assert not worker.is_alive()
    assert tracker._activity_monitor_failed is False
    assert time.time() - tracker._activity_monitor_heartbeat < 3


# --------------------------------------------------------------------- AC 5

class TestSessionEventActions:

    def _tracker(self):
        return _tracker(enter_idle=Mock(), _create_idle_record=Mock(),
                        idle_resume_event=threading.Event(),
                        _finalize_active_session=Mock(), session_manager=Mock(),
                        upload_activity_batch=Mock())

    def test_lock(self):
        t = self._tracker()
        t._on_screen_lock()
        t.enter_idle.assert_called_once_with('screen lock')

    def test_unlock(self):
        t = self._tracker()
        t._on_screen_unlock()
        t._create_idle_record.assert_called_once_with('screen lock')
        assert t.idle_resume_event.is_set()

    def test_sleep(self):
        t = self._tracker()
        t._on_system_sleep()
        t.enter_idle.assert_called_once_with('system sleep')

    def test_wake(self):
        t = self._tracker()
        t._on_system_wake()
        t._create_idle_record.assert_called_once_with('system sleep')
        assert t.idle_resume_event.is_set()

    def test_shutdown(self):
        t = self._tracker()
        t._on_system_shutdown()
        t._finalize_active_session.assert_called_once_with('system shutdown')
        t.session_manager.emergency_save.assert_called_once()
        t.upload_activity_batch.assert_called_once()

    def test_provider_session_events_started(self, provider):
        t = _tracker(_system_event_thread=None)
        with patch.object(da, 'WIN32_AVAILABLE', False):
            t._start_system_event_monitor()
        assert ('start_session_events', t) in provider.calls


# --------------------------------------------------------------------- AC 6

class TestUpdates:

    def _response(self):
        response = Mock(status_code=200)
        response.json.return_value = {'success': True, 'data': {'updateAvailable': False}}
        return response

    def test_platform_linux_in_query(self, provider):
        with patch.object(da.requests, 'get', return_value=self._response()) as get:
            da.check_for_updates('https://server')
        assert 'platform=linux' in get.call_args[0][0]

    def test_platform_windows_without_provider(self):
        with patch.object(da.requests, 'get', return_value=self._response()) as get:
            da.check_for_updates('https://server')
        assert 'platform=windows' in get.call_args[0][0]

    def test_provider_handles_update_instead_of_downloader(self, provider):
        info = {'update_available': True, 'latest_version': '99.0.0', 'is_mandatory': False}
        tracker = _tracker(offline_manager=Mock(), update_manager=Mock(), last_version_check_time=0,
                           version_check_interval=0, latest_version_info=None, app_version='1.0.0',
                           _last_notified_update_version=None, update_notification_shown=False)
        tracker.offline_manager.check_connectivity.return_value = True
        with patch.object(da, 'check_for_updates', return_value=info):
            tracker.check_for_app_updates(force=True)
        tracker.update_manager.check_and_download.assert_not_called()
        assert ('update', '99.0.0') in provider.calls


# --------------------------------------------------------------------- AC 7

def test_process_tables_merge_keeps_windows_entries():
    browsers = {'chrome.exe'}
    redacted = {'outlook.exe'}
    aliases = {'code': 'vscode'}
    keys = {'chrome'}
    da.merge_process_tables(
        {'browser_processes': {'google-chrome'}, 'redacted_body_processes': {'thunderbird'},
         'process_identifier_aliases': {'googlechromestable': 'chrome'},
         'browser_process_normalized_keys': {'chromium'}},
        browsers, redacted, aliases, keys)
    assert browsers == {'chrome.exe', 'google-chrome'}
    assert redacted == {'outlook.exe', 'thunderbird'}
    assert aliases == {'code': 'vscode', 'googlechromestable': 'chrome'}
    assert keys == {'chrome', 'chromium'}


def test_process_tables_merge_does_not_override_existing_alias():
    aliases = {'code': 'vscode'}
    da.merge_process_tables({'process_identifier_aliases': {'code': 'other'}}, set(), set(), aliases, set())
    assert aliases['code'] == 'vscode'


# --------------------------------------------------------------------- AC 8

class TestKeyMaterial:

    def test_db_key_uses_provider_material(self, provider):
        from db_connection import DatabaseConnectionManager
        manager = DatabaseConnectionManager.__new__(DatabaseConnectionManager)
        with patch('platform.node', return_value='host-a'):
            key_a = manager._derive_machine_key()
        with patch('platform.node', return_value='host-b'):
            key_b = manager._derive_machine_key()
        assert key_a == key_b
        assert len(key_a) == 64

    def test_db_key_without_provider_uses_hostname(self):
        from db_connection import DatabaseConnectionManager
        manager = DatabaseConnectionManager.__new__(DatabaseConnectionManager)
        with patch('platform.node', return_value='host-a'):
            key_a = manager._derive_machine_key()
        with patch('platform.node', return_value='host-b'):
            key_b = manager._derive_machine_key()
        assert key_a != key_b

    def test_secure_storage_uses_provider_material(self, provider):
        from auth.secure_storage import SecureTokenStorage
        storage = SecureTokenStorage.__new__(SecureTokenStorage)
        with patch('platform.node', return_value='host-a'):
            salt_a, password_a = storage._get_machine_salt(), storage._get_machine_password()
        with patch('platform.node', return_value='host-b'):
            salt_b, password_b = storage._get_machine_salt(), storage._get_machine_password()
        assert salt_a == salt_b
        assert password_a == password_b
        assert 'alice@0123abcd' in password_a


# ------------------------------------------------------------ AC 1: plumbing

class TestPlumbingSeams:

    def test_single_instance(self, provider):
        provider.values['instance'] = False
        assert da.acquire_single_instance_lock() is False

    def test_autostart(self, provider):
        provider.values['autostart_is_enabled'] = True
        assert da.add_to_startup() is True
        assert da.remove_from_startup() is True
        assert da.is_in_startup() is True

    def test_install(self, provider):
        with patch.object(da.sys, 'frozen', True, create=True):
            assert da.install_application() is True
        assert 'install' in provider.calls

    def test_location(self, provider):
        provider.values.update(ssid='Office-5G', local_ip='10.1.2.3')
        detector = da.LocationDetector()
        assert detector._get_current_ssid() == 'Office-5G'
        assert detector._get_local_ip() == '10.1.2.3'

    def test_pause_settings_in_config_dir(self, provider, tmp_path):
        provider.values['config_dir'] = str(tmp_path / 'cfg')
        path = _tracker().get_pause_settings_file_path()
        assert path == str(tmp_path / 'cfg' / 'pause_settings.json')

    def test_no_provider_autostart_non_windows_unchanged(self):
        with patch.object(da.sys, 'platform', 'linux'):
            assert da.add_to_startup() is False
            assert da.is_in_startup() is False


# ------------------------------------------------ platform web UI and actions

class UIProvider(Provider):
    def __init__(self):
        super().__init__()
        self.removed = False

    def is_local_origin(self, origin, web_port):
        return origin == f'http://localhost:{web_port}'

    def consent_section_html(self):
        return '<div id="linux-consent">Linux</div>'

    def settings_section_html(self):
        return '<div id="linux-settings">status</div>'

    def request_screen_access(self):
        return 'asked'

    def remove_user_data(self, app, sensitive_keys=()):
        self.removed = True
        self.keys = sensitive_keys
        return ['signed out']


def _web_tracker():
    from flask import Flask
    tracker = _tracker(web_port=51778, current_user=None, quit_app=Mock())
    tracker.app = Flask('seam-test')
    tracker.setup_routes()
    return tracker


class TestPlatformWebUI:

    def test_settings_page_unchanged_without_provider(self):
        html = _tracker().render_settings_page()
        assert 'PLATFORM_SETTINGS_SECTION' not in html
        assert 'linux-settings' not in html

    def test_sections_rendered_with_provider(self):
        platform_hooks.register(UIProvider())
        tracker = _tracker(current_user={'email': 'a@b.c'})
        assert '<div id="linux-settings">status</div>' in tracker.render_settings_page()
        assert '<div id="linux-consent">Linux</div>' in tracker.render_consent_page()

    def test_remove_data_rejects_foreign_origin(self):
        provider = UIProvider()
        platform_hooks.register(provider)
        client = _web_tracker().app.test_client()
        response = client.post('/api/platform/remove-my-data', json={'confirm': True},
                               headers={'Origin': 'https://evil.example'})
        assert response.status_code == 403
        response = client.post('/api/platform/remove-my-data', json={'confirm': True})
        assert response.status_code == 403            # no Origin header at all
        assert provider.removed is False

    def test_remove_data_requires_confirmation(self):
        platform_hooks.register(UIProvider())
        client = _web_tracker().app.test_client()
        response = client.post('/api/platform/remove-my-data', json={},
                               headers={'Origin': 'http://localhost:51778'})
        assert response.status_code == 400

    def test_remove_data_from_own_page(self):
        provider = UIProvider()
        platform_hooks.register(provider)
        tracker = _web_tracker()
        with patch.object(da.threading, 'Timer') as timer:
            response = tracker.app.test_client().post(
                '/api/platform/remove-my-data', json={'confirm': True},
                headers={'Origin': 'http://localhost:51778'})
        assert response.status_code == 200
        assert provider.removed is True
        assert 'access_token' in provider.keys
        timer.assert_called_once()

    def test_actions_404_style_without_provider(self):
        client = _web_tracker().app.test_client()
        response = client.post('/api/platform/allow-screen-access', headers={'Origin': 'http://localhost:51778'})
        assert response.status_code == 403
