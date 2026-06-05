"""
Tests for Linux keyring availability diagnostics.

AC-Keyring: On startup, the app must log whether a functional keyring backend
is available so ops can identify systems where token persistence is degraded.

Reference: plan/2026-06-04_python-desktop-app_linux-session-expiry-fix.md (Fix 6)
"""
import os
import sys
from unittest.mock import patch, MagicMock
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


class TestKeyringStartupDiagnostic:

    def test_no_keyring_package_logs_warning(self, capsys):
        """
        AC-K1: When the 'keyring' Python package is not installed, startup must
        print a [WARN] message indicating encrypted-file fallback.
        """
        from desktop_app import AtlassianAuthManager
        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)

        with patch('desktop_app.KEYRING_AVAILABLE', False):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
        assert 'keyring' in captured.out.lower()

    def test_functional_keyring_logs_info(self, capsys):
        """
        AC-K2: When a real keyring backend is available, startup must print [INFO]
        with the backend class name.
        """
        from desktop_app import AtlassianAuthManager
        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)

        mock_backend = MagicMock()
        mock_backend.__class__.__name__ = 'SecretServiceKeyring'

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', return_value=mock_backend):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[INFO]' in captured.out
        assert 'SecretServiceKeyring' in captured.out

    def test_null_keyring_backend_logs_warning(self, capsys):
        """
        AC-K3: When keyring is installed but the backend is 'NullKeyring' (a
        no-op used on headless systems), startup must log a [WARN] with helpful
        instructions.
        """
        from desktop_app import AtlassianAuthManager
        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)

        mock_backend = MagicMock()
        mock_backend.__class__.__name__ = 'NullKeyring'

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', return_value=mock_backend):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
        assert 'NullKeyring' in captured.out

    def test_fail_keyring_backend_logs_warning(self, capsys):
        """
        AC-K3b: 'FailKeyring' (another no-op variant) must also produce a [WARN].
        """
        from desktop_app import AtlassianAuthManager
        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)

        mock_backend = MagicMock()
        mock_backend.__class__.__name__ = 'FailKeyring'

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', return_value=mock_backend):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out

    def test_keyring_query_exception_logs_warning_no_crash(self, capsys):
        """
        AC-K4: If querying the keyring backend raises an exception (e.g. D-Bus
        error on headless Linux), a [WARN] must be printed and no exception raised.
        """
        from desktop_app import AtlassianAuthManager
        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', side_effect=Exception('D-Bus error: connection refused')):
            mgr._log_keyring_availability()  # Must not raise

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
