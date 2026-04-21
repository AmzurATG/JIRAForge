"""Unit tests for smart auto-update manager behavior."""

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

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
