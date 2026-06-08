import os
import sys
from unittest.mock import patch

# Add parent directory to path for desktop_app imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import AtlassianAuthManager


def test_get_env_var_ignores_placeholder_and_falls_back_to_embedded(monkeypatch):
    monkeypatch.setenv('ATLASSIAN_CLIENT_ID', 'your_client_id_here')

    with patch.dict(desktop_app.EMBEDDED_CONFIG, {'ATLASSIAN_CLIENT_ID': 'embedded-client-id'}, clear=False):
        value = desktop_app.get_env_var('ATLASSIAN_CLIENT_ID')

    assert value == 'embedded-client-id'


def test_get_env_var_keeps_non_placeholder_env(monkeypatch):
    monkeypatch.setenv('ATLASSIAN_CLIENT_ID', 'real-client-id-123')

    with patch.dict(desktop_app.EMBEDDED_CONFIG, {'ATLASSIAN_CLIENT_ID': 'embedded-client-id'}, clear=False):
        value = desktop_app.get_env_var('ATLASSIAN_CLIENT_ID')

    assert value == 'real-client-id-123'


def test_auth_manager_uses_embedded_client_id_when_env_is_placeholder(monkeypatch):
    monkeypatch.setenv('ATLASSIAN_CLIENT_ID', 'your_client_id_here')

    with patch.dict(desktop_app.EMBEDDED_CONFIG, {'ATLASSIAN_CLIENT_ID': 'embedded-client-id'}, clear=False), \
         patch.object(AtlassianAuthManager, '_migrate_from_plaintext', return_value=None), \
         patch.object(AtlassianAuthManager, '_load_tokens', return_value={}), \
         patch('desktop_app.SecureTokenStorage'):
        manager = AtlassianAuthManager(web_port=51777)

    assert manager.client_id == 'embedded-client-id'
