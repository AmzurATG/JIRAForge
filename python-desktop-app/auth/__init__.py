"""
Auth Module - Secure Token Storage

This module provides secure token storage with automatic fallback
from Windows Credential Manager to encrypted file storage.

Main class:
    SecureTokenStorage - Manages secure token storage with silent fallback

Exceptions:
    SecurityError - Raised when secure storage is not available

Usage:
    from auth import SecureTokenStorage
    
    storage = SecureTokenStorage(app_data_dir)
    storage.save_tokens({'access_token': '...', 'refresh_token': '...'})
    tokens = storage.load_tokens()
"""

from auth.secure_storage import SecureTokenStorage, SecurityError, KEYRING_AVAILABLE

__all__ = ['SecureTokenStorage', 'SecurityError', 'KEYRING_AVAILABLE']
__version__ = '1.0.0'
