"""
Config Manager Test Suite
==========================

Tests that ConfigManager uses XDG_CONFIG_HOME on Linux.

Usage:
    python -m pytest tests/test_config_manager.py -v
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from config_manager import ConfigManager


class TestConfigManagerXDG(unittest.TestCase):
    """Test XDG-compliant config directory."""

    @unittest.skipIf(os.name == 'nt', "Linux/Mac only")
    def test_default_config_dir(self):
        """Without XDG_CONFIG_HOME, should use ~/.config/<app>."""
        env = os.environ.copy()
        env.pop('XDG_CONFIG_HOME', None)
        with patch.dict(os.environ, env, clear=True):
            # Need to also ensure HOME is set for expanduser
            with patch.dict(os.environ, {'HOME': os.path.expanduser('~')}):
                mgr = ConfigManager("TestApp")
                expected = Path.home() / '.config' / 'testapp'
                self.assertEqual(mgr.config_dir, expected)

    @unittest.skipIf(os.name == 'nt', "Linux/Mac only")
    def test_xdg_config_home_respected(self):
        """Should use $XDG_CONFIG_HOME when set."""
        tmpdir = tempfile.mkdtemp()
        try:
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': tmpdir}):
                mgr = ConfigManager("TestApp")
                expected = Path(tmpdir) / 'testapp'
                self.assertEqual(mgr.config_dir, expected)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_config_dir_created(self):
        """Config directory should be created on init."""
        tmpdir = tempfile.mkdtemp()
        import shutil
        custom_dir = os.path.join(tmpdir, 'custom_config')
        try:
            if os.name == 'nt':
                with patch.dict(os.environ, {'LOCALAPPDATA': custom_dir}):
                    mgr = ConfigManager("TestApp")
            else:
                with patch.dict(os.environ, {'XDG_CONFIG_HOME': custom_dir}):
                    mgr = ConfigManager("TestApp")
            self.assertTrue(mgr.config_dir.exists())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_save_and_load_config(self):
        """Config should round-trip through save/load."""
        tmpdir = tempfile.mkdtemp()
        try:
            if os.name == 'nt':
                env_patch = {'LOCALAPPDATA': tmpdir}
            else:
                env_patch = {'XDG_CONFIG_HOME': tmpdir}
            with patch.dict(os.environ, env_patch):
                mgr = ConfigManager("TestApp")
                mgr.save_config({'custom_key': 'test_value'})
                loaded = mgr.load_config()
                self.assertEqual(loaded['custom_key'], 'test_value')
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
