"""
Tests for single instance, machine key, XDG paths and child environment.

Spec: plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 15-18)
"""

import os
import pwd
import stat
import subprocess
import sys
import textwrap
import time
from unittest.mock import patch

import pytest

from timetracker_linux import childenv, machine_key, paths
from timetracker_linux.single_instance import InstanceLock, default_lock_path

LINUX_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestSingleInstance:
    """AC 15"""

    def _hold_lock_in_child(self, lock_path):
        code = textwrap.dedent(f'''
            import sys, time
            sys.path.insert(0, {LINUX_ROOT!r})
            from timetracker_linux.single_instance import InstanceLock
            lock = InstanceLock({lock_path!r})
            print('acquired' if lock.acquire() else 'busy', flush=True)
            time.sleep(30)
        ''')
        child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
        assert child.stdout.readline().strip() == 'acquired'
        return child

    def test_second_process_blocked_then_free_after_death(self, tmp_path):
        lock_path = str(tmp_path / 'instance.lock')
        child = self._hold_lock_in_child(lock_path)
        try:
            assert InstanceLock(lock_path).acquire() is False
        finally:
            child.kill()
            child.wait()
        lock = InstanceLock(lock_path)
        assert lock.acquire() is True
        lock.release()

    def test_release_allows_reacquire(self, tmp_path):
        lock_path = str(tmp_path / 'instance.lock')
        first = InstanceLock(lock_path)
        assert first.acquire() is True
        assert InstanceLock(lock_path).acquire() is False
        first.release()
        second = InstanceLock(lock_path)
        assert second.acquire() is True
        second.release()

    def test_creates_parent_directory(self, tmp_path):
        lock_path = str(tmp_path / 'nested' / 'instance.lock')
        lock = InstanceLock(lock_path)
        assert lock.acquire() is True
        lock.release()

    def test_default_path_uses_runtime_dir(self):
        path = default_lock_path({'XDG_RUNTIME_DIR': '/run/user/1000', 'HOME': '/home/u'})
        assert path == '/run/user/1000/timetracker/instance.lock'

    def test_default_path_without_runtime_dir(self):
        path = default_lock_path({'HOME': '/home/u'})
        assert path == '/home/u/.local/share/TimeTracker/instance.lock'


class TestMachineKey:
    """AC 16"""

    def test_username_without_terminal_or_env(self):
        expected = pwd.getpwuid(os.getuid()).pw_name
        clean = {k: v for k, v in os.environ.items() if k not in ('USER', 'USERNAME', 'LOGNAME')}
        with patch.dict(os.environ, clean, clear=True), \
                patch('os.getlogin', side_effect=OSError('no controlling terminal')):
            assert machine_key.username() == expected

    def test_machine_id_first_existing(self, tmp_path):
        missing = tmp_path / 'missing'
        empty = tmp_path / 'empty'
        empty.write_text('\n')
        real = tmp_path / 'machine-id'
        real.write_text('0123456789abcdef0123456789abcdef\n')
        assert machine_key.machine_id([str(missing), str(empty), str(real)]) == \
            '0123456789abcdef0123456789abcdef'

    def test_machine_id_none(self, tmp_path):
        assert machine_key.machine_id([str(tmp_path / 'nope')]) is None

    def test_key_material_stable(self, tmp_path):
        mid = tmp_path / 'machine-id'
        mid.write_text('abc\n')
        one = machine_key.key_material(machine_id_paths=[str(mid)])
        with patch('platform.node', return_value='renamed-host'):
            two = machine_key.key_material(machine_id_paths=[str(mid)])
        assert one == two
        assert 'abc' in one


class TestPaths:
    """AC 17"""

    def test_defaults(self):
        env = {'HOME': '/home/u'}
        assert paths.data_dir(env) == '/home/u/.local/share/TimeTracker'
        assert paths.config_dir(env) == '/home/u/.config/timetracker'
        assert paths.state_dir(env) == '/home/u/.local/state/TimeTracker'
        assert paths.log_dir(env) == '/home/u/.local/state/TimeTracker/logs'
        assert paths.runtime_dir(env) is None

    def test_overrides(self):
        env = {'HOME': '/home/u', 'XDG_DATA_HOME': '/d', 'XDG_CONFIG_HOME': '/c',
               'XDG_STATE_HOME': '/s', 'XDG_RUNTIME_DIR': '/r'}
        assert paths.data_dir(env) == '/d/TimeTracker'
        assert paths.config_dir(env) == '/c/timetracker'
        assert paths.state_dir(env) == '/s/TimeTracker'
        assert paths.runtime_dir(env) == '/r/timetracker'

    def test_relative_xdg_ignored(self):
        env = {'HOME': '/home/u', 'XDG_DATA_HOME': 'relative/path'}
        assert paths.data_dir(env) == '/home/u/.local/share/TimeTracker'

    def test_ensure_dir_mode_0700(self, tmp_path):
        target = tmp_path / 'a' / 'b'
        paths.ensure_dir(str(target))
        assert stat.S_IMODE(os.stat(target).st_mode) == 0o700

    def test_ensure_dir_tightens_existing(self, tmp_path):
        target = tmp_path / 'open'
        target.mkdir(mode=0o755)
        os.chmod(target, 0o755)
        paths.ensure_dir(str(target))
        assert stat.S_IMODE(os.stat(target).st_mode) == 0o700


class TestChildEnv:
    """AC 18"""

    def test_restores_orig(self):
        env = {'LD_LIBRARY_PATH': '/opt/timetracker/_internal', 'LD_LIBRARY_PATH_ORIG': '/usr/local/lib',
               'PATH': '/usr/bin'}
        out = childenv.clean_env(env, frozen=True)
        assert out['LD_LIBRARY_PATH'] == '/usr/local/lib'
        assert 'LD_LIBRARY_PATH_ORIG' not in out
        assert out['PATH'] == '/usr/bin'

    def test_removes_without_orig_when_frozen(self):
        out = childenv.clean_env({'LD_LIBRARY_PATH': '/opt/timetracker/_internal'}, frozen=True)
        assert 'LD_LIBRARY_PATH' not in out

    def test_keeps_user_value_when_not_frozen(self):
        out = childenv.clean_env({'LD_LIBRARY_PATH': '/home/u/lib'}, frozen=False)
        assert out['LD_LIBRARY_PATH'] == '/home/u/lib'

    def test_drops_vars_pointing_into_bundle(self):
        env = {'TCL_LIBRARY': '/opt/timetracker/_internal/tcl', 'HOME': '/home/u',
               'SSL_CERT_FILE': '/etc/ssl/cert.pem'}
        out = childenv.clean_env(env, frozen=True, bundle_dir='/opt/timetracker/_internal')
        assert 'TCL_LIBRARY' not in out
        assert out['HOME'] == '/home/u'
        assert out['SSL_CERT_FILE'] == '/etc/ssl/cert.pem'

    def test_does_not_mutate_input(self):
        env = {'LD_LIBRARY_PATH': 'x', 'LD_LIBRARY_PATH_ORIG': 'y'}
        childenv.clean_env(env, frozen=True)
        assert env == {'LD_LIBRARY_PATH': 'x', 'LD_LIBRARY_PATH_ORIG': 'y'}
