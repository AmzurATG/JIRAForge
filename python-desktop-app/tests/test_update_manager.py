"""Unit tests for smart auto-update manager behavior."""

import os
import sys
import tempfile
from datetime import datetime

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import UpdateManager, create_update_script


def test_update_manager_initial_state_is_idle(tmp_path):
    manager = UpdateManager(str(tmp_path), "1.0.0")

    status = manager.get_status()
    assert status['state'] == 'idle'
    assert status['progress'] == 0.0
    assert status['download_path'] is None


def test_create_update_script_contains_rollback(tmp_path):
    app_data_dir = str(tmp_path)
    staged_exe = os.path.join(app_data_dir, 'updates', 'TimeTracker_v2.0.0.exe')
    installed_exe = os.path.join(app_data_dir, 'TimeTracker.exe')

    os.makedirs(os.path.dirname(staged_exe), exist_ok=True)
    script_path = create_update_script(app_data_dir, 99999, staged_exe, installed_exe)

    assert os.path.exists(script_path)
    content = open(script_path, 'r', encoding='utf-8').read()
    assert 'tasklist /FI "PID eq 99999"' in content
    assert '.bak' in content
    assert 'copy /Y' in content


def test_create_update_script_contains_wait_timeout_and_logs(tmp_path):
    app_data_dir = str(tmp_path)
    staged_exe = os.path.join(app_data_dir, 'updates', 'TimeTracker_v2.2.0.exe')
    installed_exe = os.path.join(app_data_dir, 'TimeTracker.exe')

    os.makedirs(os.path.dirname(staged_exe), exist_ok=True)
    script_path = create_update_script(app_data_dir, 12345, staged_exe, installed_exe)

    content = open(script_path, 'r', encoding='utf-8').read()
    # Wait loop with 5s timeout then force-kill
    assert 'WAIT_COUNT' in content
    assert 'GEQ 5' in content
    assert 'taskkill /F /PID 12345' in content
    assert 'taskkill /F /IM TimeTracker.exe' in content
    assert 'update_install.log' in content
    # Phase labels
    assert ':pid_gone' in content
    assert ':force_kill' in content
    assert ':launch_new' in content
    assert ':cleanup' in content


def test_load_staged_update_if_exists(tmp_path):
    updates_dir = tmp_path / 'updates'
    updates_dir.mkdir(parents=True, exist_ok=True)
    staged = updates_dir / 'TimeTracker_v2.1.0.exe'
    staged.write_bytes(b'binary-content')

    manager = UpdateManager(str(tmp_path), '1.0.0')
    assert manager.load_staged_update_if_exists() is True

    status = manager.get_status()
    assert status['state'] == 'ready'
    assert status['update_info']['latest_version'] == '2.1.0'
    assert status['download_path'].endswith('TimeTracker_v2.1.0.exe')


def test_defer_update_from_ready_state(tmp_path):
    manager = UpdateManager(str(tmp_path), '1.0.0')
    manager.update_info = {'latest_version': '2.0.0'}
    manager.download_path = os.path.join(str(tmp_path), 'updates', 'TimeTracker_v2.0.0.exe')
    manager._set_state('ready')

    assert manager.defer_update() is True
    assert manager.get_status()['state'] == 'deferred'


def test_apply_update_requires_staged_file(tmp_path):
    manager = UpdateManager(str(tmp_path), '1.0.0')
    manager.update_info = {'latest_version': '2.0.0'}
    manager.download_path = os.path.join(str(tmp_path), 'updates', 'missing.exe')
    manager._set_state('ready')

    assert manager.apply_update() is False
    assert manager.get_status()['state'] == 'failed'


def test_apply_update_writes_launcher_log_and_spawns_updater(tmp_path, monkeypatch):
    manager = UpdateManager(str(tmp_path), '1.0.0')
    staged_exe = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
    staged_exe.parent.mkdir(parents=True, exist_ok=True)
    staged_exe.write_bytes(b'binary-content')

    manager.update_info = {
        'latest_version': '2.0.0',
        'checksum': None,
        'download_url': 'https://example.com/TimeTracker_v2.0.0.exe'
    }
    manager.download_path = str(staged_exe)
    manager._set_state('ready')

    popen_calls = []

    class DummyProcess:
        pass

    def fake_popen(args, creationflags=None, cwd=None, stdin=None, stdout=None, stderr=None):
        popen_calls.append({'args': args, 'creationflags': creationflags, 'cwd': cwd})
        return DummyProcess()

    monkeypatch.setattr(desktop_app.subprocess, 'Popen', fake_popen)

    assert manager.apply_update() is True
    assert manager.get_status()['state'] == 'installing'
    assert len(popen_calls) == 1
    assert popen_calls[0]['args'][:3] == ['cmd.exe', '/d', '/c']

    launcher_log = tmp_path / 'updates' / 'update_launcher.log'
    assert launcher_log.exists()
    launcher_content = launcher_log.read_text(encoding='utf-8')
    assert 'apply_update called' in launcher_content
    assert 'updater_build_marker=apply_update_r4' in launcher_content
    assert 'app_version=' in launcher_content
    assert 'script=' in launcher_content
