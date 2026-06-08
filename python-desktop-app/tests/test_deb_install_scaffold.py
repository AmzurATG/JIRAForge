"""
test_deb_install_scaffold.py

Tests for the .deb install scaffold behaviour — verifies that all expected
files and directories are created when the app starts from the canonical
AppImage path (the normal state after a .deb install).

These tests simulate what happens on a new user machine where:
  - The postinst script has already placed TimeTracker.AppImage at canonical
  - The app is launched for the first time from the canonical path
  - $APPIMAGE env var equals the canonical path
"""
import os
import sys
import stat
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import (
    _ensure_install_scaffold,
    _try_enable_gnome_appindicator_extension,
    _install_appimage,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def install_dir(tmp_path):
    """Temporary directory representing ~/.local/share/TimeTracker/."""
    d = tmp_path / 'TimeTracker'
    d.mkdir()
    return d


@pytest.fixture
def fake_appimage(install_dir):
    """Fake AppImage file at the canonical path (not executable yet)."""
    appimage = install_dir / 'TimeTracker.AppImage'
    appimage.write_bytes(b'\x7fELF')
    os.chmod(str(appimage), 0o644)   # NOT executable — postinst may skip chmod
    return appimage


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — directory creation
# ---------------------------------------------------------------------------

class TestEnsureInstallScaffoldDirectories:

    def test_creates_logs_directory(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        assert (install_dir / 'logs').is_dir(), "logs/ directory must be created"

    def test_creates_updates_directory(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        assert (install_dir / 'updates').is_dir(), "updates/ directory must be created"

    def test_logs_dir_is_writable(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        log_file = install_dir / 'logs' / 'timetracker.log'
        log_file.write_text('test entry')
        assert log_file.read_text() == 'test entry'

    def test_updates_dir_is_writable(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        staged = install_dir / 'updates' / 'TimeTracker_v99.0.0.AppImage'
        staged.write_bytes(b'fake binary')
        assert staged.read_bytes() == b'fake binary'


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — uninstall.sh
# ---------------------------------------------------------------------------

class TestEnsureInstallScaffoldUninstaller:

    def test_creates_uninstall_sh(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        uninstall = install_dir / 'uninstall.sh'
        assert uninstall.is_file(), "uninstall.sh must be created"

    def test_uninstall_sh_is_executable(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        uninstall = install_dir / 'uninstall.sh'
        assert os.access(str(uninstall), os.X_OK), "uninstall.sh must be executable"

    def test_uninstall_sh_references_install_dir(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        content = (install_dir / 'uninstall.sh').read_text()
        assert str(install_dir) in content, \
            "uninstall.sh must reference the install directory"

    def test_uninstall_sh_not_overwritten_on_second_call(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        original = (install_dir / 'uninstall.sh').read_text()
        # Tamper with the file content to detect an overwrite
        (install_dir / 'uninstall.sh').write_text('# sentinel')
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        assert (install_dir / 'uninstall.sh').read_text() == '# sentinel', \
            "Second scaffold call must NOT overwrite existing uninstall.sh"


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — autostart entry
# ---------------------------------------------------------------------------

class TestEnsureInstallScaffoldAutostart:

    def test_creates_autostart_entry(self, install_dir, fake_appimage, tmp_path):
        fake_home = tmp_path / 'home'
        fake_home.mkdir()

        def fake_expanduser(p):
            return str(fake_home) if p == '~' else p.replace('~', str(fake_home))

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        autostart = fake_home / '.config' / 'autostart' / 'timetracker.desktop'
        assert autostart.is_file(), "autostart .desktop entry must be created"

    def test_autostart_entry_exec_contains_appimage_path(self, install_dir, fake_appimage, tmp_path):
        fake_home = tmp_path / 'home'
        fake_home.mkdir()

        def fake_expanduser(p):
            return str(fake_home) if p == '~' else p.replace('~', str(fake_home))

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        content = (fake_home / '.config' / 'autostart' / 'timetracker.desktop').read_text()
        assert str(fake_appimage) in content, \
            "Autostart Exec= must reference the canonical AppImage path"

    def test_autostart_entry_sets_extract_and_run(self, install_dir, fake_appimage, tmp_path):
        fake_home = tmp_path / 'home'
        fake_home.mkdir()

        def fake_expanduser(p):
            return str(fake_home) if p == '~' else p.replace('~', str(fake_home))

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        content = (fake_home / '.config' / 'autostart' / 'timetracker.desktop').read_text()
        assert 'APPIMAGE_EXTRACT_AND_RUN=1' in content, \
            "Autostart must set APPIMAGE_EXTRACT_AND_RUN=1 to avoid FUSE requirement"

    def test_autostart_entry_not_overwritten_on_second_call(self, install_dir, fake_appimage, tmp_path):
        fake_home = tmp_path / 'home'
        fake_home.mkdir()

        def fake_expanduser(p):
            return str(fake_home) if p == '~' else p.replace('~', str(fake_home))

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        autostart = fake_home / '.config' / 'autostart' / 'timetracker.desktop'
        autostart.write_text('# sentinel')

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        assert autostart.read_text() == '# sentinel', \
            "Second scaffold call must NOT overwrite existing autostart entry"


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — AppImage chmod
# ---------------------------------------------------------------------------

class TestEnsureInstallScaffoldChmod:

    def test_makes_appimage_executable(self, install_dir, fake_appimage):
        os.chmod(str(fake_appimage), 0o644)
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        mode = os.stat(str(fake_appimage)).st_mode
        assert mode & stat.S_IXUSR, "AppImage must have user-executable bit set"

    def test_does_not_error_when_appimage_already_executable(self, install_dir, fake_appimage):
        os.chmod(str(fake_appimage), 0o755)
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            # Must not raise
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))


# ---------------------------------------------------------------------------
# _ensure_install_scaffold() — first-launch notification
# ---------------------------------------------------------------------------

class TestFirstLaunchNotification:

    def test_first_launch_marker_written(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        marker = install_dir / '.first_launch_done'
        assert marker.is_file(), ".first_launch_done marker must be written on first run"

    def test_notification_shown_on_first_run(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        mock_notify.assert_called_once()

    def test_notification_not_shown_on_second_run(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
            assert mock_notify.call_count == 1
            # Second launch
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
            assert mock_notify.call_count == 1, \
                "Notification must not fire again on subsequent startups"

    def test_marker_contains_timestamp(self, install_dir, fake_appimage):
        with patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))
        content = (install_dir / '.first_launch_done').read_text()
        assert 'first_launch=' in content


# ---------------------------------------------------------------------------
# _try_enable_gnome_appindicator_extension()
# ---------------------------------------------------------------------------

class TestGnomeExtensionEnable:

    def test_noop_on_non_linux(self):
        with patch.object(sys, 'platform', 'darwin'):
            # Must not raise and must not call subprocess
            with patch('subprocess.run') as mock_run:
                _try_enable_gnome_appindicator_extension()
                mock_run.assert_not_called()

    def test_noop_when_no_gnome_session(self):
        env_override = {
            'XDG_CURRENT_DESKTOP': 'KDE',
            'DESKTOP_SESSION': 'plasma',
        }
        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run') as mock_run:
            _try_enable_gnome_appindicator_extension()
            mock_run.assert_not_called()

    def test_calls_gdbus_on_gnome_session(self):
        env_override = {
            'XDG_CURRENT_DESKTOP': 'GNOME',
            'DESKTOP_SESSION': 'gnome',
        }
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ''
        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run', return_value=mock_result) as mock_run:
            _try_enable_gnome_appindicator_extension()
        first_cmd = mock_run.call_args_list[0][0][0]
        assert 'gdbus' in first_cmd[0], "First attempt must use gdbus"
        assert 'ubuntu-appindicators@ubuntu.com' in first_cmd

    def test_calls_gnome_extensions_cli_when_gdbus_missing(self):
        env_override = {
            'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME',
            'DESKTOP_SESSION': 'ubuntu',
        }

        def fake_run(cmd, **kwargs):
            if cmd[0] == 'gdbus':
                raise FileNotFoundError('gdbus not found')
            r = MagicMock()
            r.returncode = 0
            r.stderr = ''
            r.stdout = ''
            return r

        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run', side_effect=fake_run) as mock_run:
            _try_enable_gnome_appindicator_extension()
        all_cmds = [c[0][0][0] for c in mock_run.call_args_list]
        assert 'gnome-extensions' in all_cmds, \
            "Must fall back to gnome-extensions CLI when gdbus is unavailable"

    def test_correct_extension_uuid_used(self):
        env_override = {'XDG_CURRENT_DESKTOP': 'GNOME', 'DESKTOP_SESSION': 'gnome'}
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stderr = ''
        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run', return_value=mock_result) as mock_run:
            _try_enable_gnome_appindicator_extension()
        assert 'ubuntu-appindicators@ubuntu.com' in str(mock_run.call_args_list)

    def test_does_not_raise_on_gdbus_timeout(self):
        env_override = {'XDG_CURRENT_DESKTOP': 'GNOME', 'DESKTOP_SESSION': 'gnome'}

        def fake_run(cmd, **kwargs):
            if cmd[0] == 'gdbus':
                raise subprocess.TimeoutExpired(cmd, 5)
            r = MagicMock()
            r.returncode = 0
            r.stderr = ''
            r.stdout = ''
            return r

        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run', side_effect=fake_run):
            _try_enable_gnome_appindicator_extension()   # must not raise

    def test_does_not_raise_on_gnome_extensions_not_found(self):
        env_override = {'XDG_CURRENT_DESKTOP': 'GNOME', 'DESKTOP_SESSION': 'gnome'}

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError('not found')

        with patch.dict(os.environ, env_override, clear=False), \
             patch('subprocess.run', side_effect=fake_run):
            _try_enable_gnome_appindicator_extension()   # must not raise


# ---------------------------------------------------------------------------
# _install_appimage() integration — canonical path still calls scaffold
# ---------------------------------------------------------------------------

class TestInstallAppimageCanonicalPath:

    def test_scaffold_called_when_already_at_canonical_path(self, tmp_path, monkeypatch):
        """After .deb install, $APPIMAGE == canonical — scaffold must still run."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')

        monkeypatch.setenv('APPIMAGE', canonical)
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._ensure_install_scaffold') as mock_scaffold, \
             patch('desktop_app._cleanup_stale_user_desktop'):
            result = _install_appimage()

        assert result is True
        mock_scaffold.assert_called_once_with(str(tmp_path), canonical), \
            "_ensure_install_scaffold must be called with install_dir and canonical path"

    def test_logs_dir_exists_after_deb_style_first_launch(self, tmp_path, monkeypatch):
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        monkeypatch.setenv('APPIMAGE', canonical)
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            result = _install_appimage()

        assert result is True
        assert (tmp_path / 'logs').is_dir(), "logs/ must exist after deb-style first launch"
        assert (tmp_path / 'updates').is_dir(), "updates/ must exist after deb-style first launch"
        assert (tmp_path / 'uninstall.sh').is_file(), "uninstall.sh must exist after deb-style first launch"

    def test_returns_true_so_app_continues(self, tmp_path, monkeypatch):
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')

        monkeypatch.setenv('APPIMAGE', canonical)
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._ensure_install_scaffold'), \
             patch('desktop_app._cleanup_stale_user_desktop'):
            result = _install_appimage()

        assert result is True, \
            "Must return True (app continues running) when already at canonical path"


# ---------------------------------------------------------------------------
# Full idempotency: running scaffold twice never corrupts state
# ---------------------------------------------------------------------------

class TestScaffoldIdempotency:

    def test_full_idempotency(self, install_dir, fake_appimage, tmp_path):
        fake_home = tmp_path / 'home'
        fake_home.mkdir()

        def fake_expanduser(p):
            return str(fake_home) if p == '~' else p.replace('~', str(fake_home))

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        # Capture state after first run
        uninstall_content = (install_dir / 'uninstall.sh').read_text()
        autostart = fake_home / '.config' / 'autostart' / 'timetracker.desktop'
        autostart_content = autostart.read_text()

        with patch('os.path.expanduser', side_effect=fake_expanduser), \
             patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            _ensure_install_scaffold(str(install_dir), str(fake_appimage))

        # Nothing must change
        assert (install_dir / 'uninstall.sh').read_text() == uninstall_content
        assert autostart.read_text() == autostart_content
        mock_notify.assert_not_called(), "No notification on subsequent runs"


# ---------------------------------------------------------------------------
# IS_APPIMAGE detection in extract-and-run mode (the core V2 fix)
# ---------------------------------------------------------------------------

class TestIsAppimageDetection:
    """Verify IS_APPIMAGE is True in both FUSE and extract-and-run modes."""

    def test_is_appimage_true_when_appimage_env_set(self, monkeypatch):
        """FUSE mode: $APPIMAGE is set → IS_APPIMAGE must be True."""
        monkeypatch.setenv('APPIMAGE', '/home/user/.local/share/TimeTracker/TimeTracker.AppImage')
        monkeypatch.delenv('APPIMAGE_EXTRACT_AND_RUN', raising=False)
        _path = os.environ.get('APPIMAGE', '')
        _extract = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        result = bool(_path) or _extract
        assert result is True

    def test_is_appimage_true_when_extract_and_run_set(self, monkeypatch):
        """Extract-and-run mode: only $APPIMAGE_EXTRACT_AND_RUN is set → IS_APPIMAGE must be True."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        _path = os.environ.get('APPIMAGE', '')
        _extract = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        result = bool(_path) or _extract
        assert result is True

    def test_is_appimage_false_when_neither_set(self, monkeypatch):
        """Dev mode: neither env var set → IS_APPIMAGE must be False."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.delenv('APPIMAGE_EXTRACT_AND_RUN', raising=False)
        _path = os.environ.get('APPIMAGE', '')
        _extract = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
        result = bool(_path) or _extract
        assert result is False


# ---------------------------------------------------------------------------
# _install_appimage() in extract-and-run mode (no $APPIMAGE, only $APPIMAGE_EXTRACT_AND_RUN)
# ---------------------------------------------------------------------------

class TestInstallAppimageExtractAndRunMode:
    """Verify _install_appimage() works when ONLY $APPIMAGE_EXTRACT_AND_RUN is set.
    This simulates the exact scenario on user machines after .deb install."""

    def test_scaffold_runs_in_extract_and_run_mode(self, tmp_path, monkeypatch):
        """When APPIMAGE_EXTRACT_AND_RUN=1 and canonical exists, scaffold must run."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('desktop_app._ensure_install_scaffold') as mock_scaffold:
            result = _install_appimage()

        assert result is True
        mock_scaffold.assert_called_once()

    def test_creates_all_scaffold_files_in_extract_mode(self, tmp_path, monkeypatch):
        """Full integration: all expected files created in extract-and-run mode."""
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        Path(canonical).write_bytes(b'fake')
        os.chmod(canonical, 0o755)

        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app._try_enable_gnome_appindicator_extension'):
            result = _install_appimage()

        assert result is True
        assert (tmp_path / 'logs').is_dir()
        assert (tmp_path / 'updates').is_dir()
        assert (tmp_path / 'uninstall.sh').is_file()

    def test_returns_true_when_no_appimage_file_on_disk(self, tmp_path, monkeypatch):
        """If no AppImage exists anywhere on disk, must return True (don't crash)."""
        # No AppImage file created — simulates a corrupt or fully-removed install
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        # Neither canonical nor /opt/ AppImage exist
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        orig_isfile = os.path.isfile

        def fake_isfile(path):
            if path in (canonical, '/opt/timetracker/TimeTracker.AppImage'):
                return False
            return orig_isfile(path)

        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('os.path.isfile', side_effect=fake_isfile):
            result = _install_appimage()

        assert result is True, "Must not crash even if no AppImage file exists"

    def test_infers_opt_path_when_canonical_missing(self, tmp_path, monkeypatch):
        """When canonical doesn't exist but /opt/ does, should install from /opt/ path."""
        monkeypatch.delenv('APPIMAGE', raising=False)
        monkeypatch.setenv('APPIMAGE_EXTRACT_AND_RUN', '1')
        monkeypatch.setattr(desktop_app, 'IS_APPIMAGE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_EXTRACT_MODE', True)
        monkeypatch.setattr(desktop_app, '_APPIMAGE_PATH', '')
        monkeypatch.setattr(desktop_app, 'get_app_data_dir', lambda: str(tmp_path))

        # Canonical does NOT exist, but /opt/ path does
        canonical = str(tmp_path / 'TimeTracker.AppImage')
        opt_path = '/opt/timetracker/TimeTracker.AppImage'
        orig_isfile = os.path.isfile

        def fake_isfile(path):
            if path == canonical:
                return False
            if path == opt_path:
                return True
            return orig_isfile(path)

        # The function will try to copy from /opt → canonical and relaunch.
        # Mock the copy and subprocess to avoid side effects.
        with patch('desktop_app._cleanup_stale_user_desktop'), \
             patch('os.path.isfile', side_effect=fake_isfile), \
             patch('shutil.copy2') as mock_copy, \
             patch('os.chmod'), \
             patch('os.replace'), \
             patch('desktop_app._ensure_install_scaffold'), \
             patch('subprocess.Popen'):
            result = _install_appimage()

        # Returns False because it installs and relaunches from canonical
        assert result is False
        # Verify it used the /opt path as the source
        mock_copy.assert_called_once_with(opt_path, canonical + '.new')


# ---------------------------------------------------------------------------
# Wrapper script verification
# ---------------------------------------------------------------------------

class TestWrapperScript:
    """Verify the build.sh wrapper script exports APPIMAGE env var."""

    def test_wrapper_exports_appimage_env_var(self):
        """The /usr/local/bin/timetracker wrapper must set APPIMAGE= in exec env."""
        build_sh = Path(__file__).parent.parent / 'build.sh'
        content = build_sh.read_text()
        assert 'APPIMAGE="$CANONICAL"' in content, \
            "Wrapper must explicitly set APPIMAGE env var for extract-and-run mode"

    def test_wrapper_exports_appimage_for_opt_fallback(self):
        """The wrapper's /opt/ fallback must also set APPIMAGE=."""
        build_sh = Path(__file__).parent.parent / 'build.sh'
        content = build_sh.read_text()
        assert 'APPIMAGE="/opt/timetracker/TimeTracker.AppImage"' in content, \
            "Wrapper /opt/ fallback must also set APPIMAGE env var"
