"""
Configuration Manager for Desktop App
======================================

Handles secure storage of user configuration WITHOUT packaging sensitive
credentials in the executable.

Storage Location: User's AppData folder (not in .exe)
"""

import os
import json
import keyring
from pathlib import Path
from typing import Optional, Dict, Any


class ConfigManager:
    """Manages desktop app configuration securely"""
    
    def __init__(self, app_name="JIRAForge"):
        self.app_name = app_name
        
        # Store config in user's AppData (Windows) or $XDG_CONFIG_HOME (Linux/Mac)
        if os.name == 'nt':  # Windows
            self.config_dir = Path(os.getenv('LOCALAPPDATA')) / app_name
        else:  # Linux/Mac — respect XDG Base Directory Spec
            xdg_config = os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))
            self.config_dir = Path(xdg_config) / app_name.lower()
        
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.config_dir / 'config.json'
        
        # HARDCODED PUBLIC VALUES (safe to include in .exe)
        self.PUBLIC_CONFIG = {
            'supabase_url': 'https://jvijitdewbypqbatfboi.supabase.co',
            'supabase_anon_key': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2aWppdGRld2J5cHFiYXRmYm9pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3NTU1OTAsImV4cCI6MjA3ODMzMTU5MH0.OvoIgXKqYTK_9S_bIJtUa6N2TVgtgcp94iOVjE3rdRM',
            'ai_server_url': 'http://localhost:3001',  # Or production URL
            'atlassian_client_id': 'Q8HT4Jn205AuTiAarj088oWNDrOqwvM5',  # Public client ID
        }
    
    def load_config(self) -> Dict[str, Any]:
        """Load configuration from user's AppData"""
        if self.config_file.exists():
            with open(self.config_file, 'r') as f:
                user_config = json.load(f)
        else:
            user_config = {}
        
        # Merge public config with user config
        config = {**self.PUBLIC_CONFIG, **user_config}
        return config
    
    def save_config(self, config: Dict[str, Any]):
        """Save user-specific configuration"""
        # Don't save public config (it's hardcoded)
        user_config = {k: v for k, v in config.items() 
                      if k not in self.PUBLIC_CONFIG}
        
        with open(self.config_file, 'w') as f:
            json.dump(user_config, f, indent=2)
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value"""
        config = self.load_config()
        return config.get(key, default)
    
    def set(self, key: str, value: Any):
        """Set a configuration value"""
        config = self.load_config()
        config[key] = value
        self.save_config(config)
    
    # Secure credential storage using Windows Credential Manager
    def store_credential(self, key: str, value: str):
        """Store sensitive credential using OS keyring"""
        try:
            keyring.set_password(self.app_name, key, value)
        except Exception as e:
            print(f"Warning: Could not store credential securely: {e}")
            # Fallback: store encrypted in config (implement encryption)
    
    def get_credential(self, key: str) -> Optional[str]:
        """Retrieve credential from OS keyring"""
        try:
            return keyring.get_password(self.app_name, key)
        except Exception as e:
            print(f"Warning: Could not retrieve credential: {e}")
            return None
    
    def store_oauth_tokens(self, access_token: str, refresh_token: str):
        """Store OAuth tokens securely"""
        self.store_credential('access_token', access_token)
        self.store_credential('refresh_token', refresh_token)
    
    def get_oauth_tokens(self) -> tuple:
        """Retrieve OAuth tokens"""
        access_token = self.get_credential('access_token')
        refresh_token = self.get_credential('refresh_token')
        return access_token, refresh_token
    
    def store_user_info(self, user_id: str, organization_id: str, email: str):
        """Store user information after successful login"""
        self.set('user_id', user_id)
        self.set('organization_id', organization_id)
        self.set('email', email)
    
    def get_user_info(self) -> Dict[str, Optional[str]]:
        """Get stored user information"""
        return {
            'user_id': self.get('user_id'),
            'organization_id': self.get('organization_id'),
            'email': self.get('email')
        }
    
    def is_configured(self) -> bool:
        """Check if app is configured (user has logged in)"""
        user_info = self.get_user_info()
        return all([user_info['user_id'], user_info['organization_id']])
    
    def clear_credentials(self):
        """Clear all stored credentials (logout)"""
        try:
            keyring.delete_password(self.app_name, 'access_token')
            keyring.delete_password(self.app_name, 'refresh_token')
        except:
            pass
        
        if self.config_file.exists():
            self.config_file.unlink()


# Usage Example
if __name__ == '__main__':
    config = ConfigManager()
    
    # Public values are available immediately
    print(f"Supabase URL: {config.get('supabase_url')}")
    
    # After OAuth login, store user info
    config.store_user_info(
        user_id='user-uuid',
        organization_id='org-uuid',
        email='user@example.com'
    )
    
    # Store OAuth tokens securely
    config.store_oauth_tokens('access_token_xxx', 'refresh_token_xxx')
    
    # Retrieve when needed
    user_info = config.get_user_info()
    print(f"User: {user_info}")
