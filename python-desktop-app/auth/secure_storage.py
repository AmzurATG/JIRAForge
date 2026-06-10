"""
Secure Token Storage with Silent Fallback
Hierarchy: Keyring (preferred) → Encryption (automatic fallback) → Fail (rare)

This module provides secure token storage with automatic fallback from Windows Credential
Manager to encrypted file storage when keyring is unavailable.

GDPR Compliance:
- No user consent required (security measure, not data processing)
- Transparency via settings page and privacy policy
- Encryption is "appropriate technical measure" per Article 32

Security Features:
- Primary: Windows Credential Manager (OS-level encryption)
- Fallback: AES-128-CBC with PBKDF2 key derivation (600K iterations)
- Machine-specific encryption keys (prevents token copying between machines)
- Token chunking for Windows Credential Manager 2560-byte limit
- Base64 encoding to prevent special character issues

Version: 1.0.0
"""

import os
import json
import base64
import hashlib
import platform
import threading
from typing import Dict, Optional, List
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import logging

logger = logging.getLogger(__name__)

# Try to import keyring
try:
    import keyring
    KEYRING_AVAILABLE = True
except ImportError:
    KEYRING_AVAILABLE = False
    logger.warning("Keyring not available - will use encrypted storage")


# =============================================================================
# KEYRING CONFIGURATION
# =============================================================================

# Windows Credential Manager limits CredentialBlob to CRED_MAX_CREDENTIAL_BLOB_SIZE
# = 5*512 = 2560 BYTES, and stores the password as UTF-16 (2 bytes/char) -> a hard
# ceiling of ~1280 CHARACTERS. Exceeding it makes CredWrite fail with error 1783
# "The stub received bad data", so the value never persists.
#
# BUG FIXED: this was 2000, calibrated as if the limit were 2560 *characters*. At
# 2000 chars a value is ~4000 bytes in UTF-16 -- well over 2560 -- so large Atlassian
# access/refresh tokens failed to save to keyring and were lost on restart (small
# tokens that fit one sub-1280 entry survived). Use 1000 chars (~2000 bytes) for a
# safe margin under the 2560-byte limit.
KEYRING_CHUNK_SIZE = 1000  # characters; ~2000 bytes UTF-16, safely under the 2560-byte limit

# Token keys that are security-sensitive.
# MUST stay in sync with desktop_app.py's SENSITIVE_TOKEN_KEYS: save_tokens() stores
# whatever dict it's given, but _load_from_keyring()/_load_encrypted()/delete_tokens()
# iterate THIS list — so a key missing here is saved but never loaded back on restart.
# (test_google_auth.py::test_secure_storage_persists_google_refresh_token guards this.)
SENSITIVE_TOKEN_KEYS = ['access_token', 'refresh_token', 'supabase_token', 'google_refresh_token']


# =============================================================================
# KEYRING HELPER FUNCTIONS (with chunking and base64 encoding)
# =============================================================================

def _keyring_set(service: str, key: str, value: str):
    """
    Save a value to keyring, base64-encoding and chunking if needed.
    
    Base64 encoding prevents Windows Credential Manager issues with special chars
    in JWT tokens that can cause error 1783 'The stub received bad data'.
    
    Args:
        service: Service name for keyring (e.g., 'TimeTracker')
        key: Key name (e.g., 'access_token')
        value: Value to save
    """
    # Base64 encode to avoid special character issues
    encoded = base64.b64encode(value.encode('utf-8')).decode('ascii')
    encoded_with_marker = f"__b64__:{encoded}"
    
    if len(encoded_with_marker) <= KEYRING_CHUNK_SIZE:
        # Single value - no chunking needed
        keyring.set_password(service, key, encoded_with_marker)
        # Clean up any leftover chunks from previous saves
        for i in range(1, 10):
            try:
                keyring.delete_password(service, f"{key}_chunk{i}")
            except Exception:
                break
    else:
        # Value is too large - chunk it
        chunks = []
        for i in range(0, len(encoded), KEYRING_CHUNK_SIZE - 20):  # Leave room for marker
            chunks.append(encoded[i:i + KEYRING_CHUNK_SIZE - 20])
        
        # Store chunk count in the main key
        keyring.set_password(service, key, f"__b64_chunked__:{len(chunks)}")
        for i, chunk in enumerate(chunks):
            keyring.set_password(service, f"{key}_chunk{i+1}", chunk)
        
        # Clean up extra old chunks beyond current count
        for i in range(len(chunks) + 1, len(chunks) + 10):
            try:
                keyring.delete_password(service, f"{key}_chunk{i}")
            except Exception:
                break


def _keyring_get(service: str, key: str) -> Optional[str]:
    """
    Load a value from keyring, decoding base64 and reassembling chunks if needed.
    
    Args:
        service: Service name for keyring
        key: Key name
        
    Returns:
        Decoded value or None if not found
    """
    value = keyring.get_password(service, key)
    if value is None:
        return None
    
    # Handle base64-encoded chunked values
    if value.startswith("__b64_chunked__:"):
        try:
            num_chunks = int(value.split(":")[1])
        except (ValueError, IndexError):
            # Corrupted chunk marker - clean up and return None
            try:
                keyring.delete_password(service, key)
            except Exception:
                pass
            return None
        
        parts = []
        for i in range(1, num_chunks + 1):
            chunk = keyring.get_password(service, f"{key}_chunk{i}")
            if chunk is None:
                return None  # Corrupted, missing chunk
            parts.append(chunk)
        
        encoded = "".join(parts)
        try:
            return base64.b64decode(encoded.encode('ascii')).decode('utf-8')
        except Exception:
            return None
    
    # Handle base64-encoded single values
    if value.startswith("__b64__:"):
        encoded = value[8:]  # Skip "__b64__:" prefix
        try:
            return base64.b64decode(encoded.encode('ascii')).decode('utf-8')
        except Exception:
            return None
    
    # Legacy: handle old chunked format (non-base64)
    if value.startswith("__chunked__:"):
        try:
            num_chunks = int(value.split(":")[1])
        except (ValueError, IndexError):
            try:
                keyring.delete_password(service, key)
            except Exception:
                pass
            return None
        
        parts = []
        for i in range(1, num_chunks + 1):
            chunk = keyring.get_password(service, f"{key}_chunk{i}")
            if chunk is None:
                return None
            parts.append(chunk)
        return "".join(parts)
    
    # Legacy: plain value (will be re-encoded on next save)
    return value


def _keyring_delete(service: str, key: str):
    """
    Delete a value from keyring, including any chunks.
    
    Args:
        service: Service name
        key: Key name
    """
    try:
        value = keyring.get_password(service, key)
        if value and (value.startswith("__chunked__:") or value.startswith("__b64_chunked__:")):
            try:
                num_chunks = int(value.split(":")[1])
            except (ValueError, IndexError):
                num_chunks = 0
            for i in range(1, num_chunks + 1):
                try:
                    keyring.delete_password(service, f"{key}_chunk{i}")
                except Exception:
                    pass
        keyring.delete_password(service, key)
    except Exception:
        pass


# =============================================================================
# SECURE TOKEN STORAGE CLASS
# =============================================================================

class SecureTokenStorage:
    """
    Manages secure token storage with automatic fallback.
    
    Security Hierarchy:
    1. Windows Credential Manager (keyring) - 85-90% of users (preferred)
    2. Encrypted file storage - 10-15% of users (automatic fallback)
    3. Fail securely - <1% (extremely rare, no storage available)
    
    Features:
    - Silent automatic fallback (no blocking user consent dialogs)
    - Non-blocking notifications when fallback is used
    - Machine-specific encryption (tokens can't be copied between machines)
    - Token chunking for Windows Credential Manager limits
    - Base64 encoding to prevent special character issues
    - Thread-safe operations
    
    GDPR Compliance:
    - No user consent required (security measure, not data processing)
    - Transparency via settings page, privacy policy, and optional notifications
    - Encryption is "appropriate technical measure" per Article 32
    """
    
    SERVICE_NAME = 'TimeTracker'
    ENCRYPTION_VERSION = 1
    
    def __init__(self, app_data_dir: str):
        """
        Initialize secure token storage.
        
        Args:
            app_data_dir: Application data directory (e.g., %LOCALAPPDATA%\\TimeTracker)
        """
        self.app_data_dir = app_data_dir
        self.storage_method = None  # Will be set during save/load
        self.notification_shown = False
        self._lock = threading.Lock()  # Thread safety for concurrent access
        
        # Ensure directory exists
        os.makedirs(app_data_dir, exist_ok=True)
        
        # Check notification status
        self._load_notification_status()
        
        logger.info(f"SecureTokenStorage initialized (keyring_available={KEYRING_AVAILABLE})")
    
    # =========================================================================
    # PUBLIC API
    # =========================================================================
    
    def save_tokens(self, tokens: Dict[str, str], user_email: str = 'default') -> bool:
        """
        Save tokens securely with automatic fallback.
        
        Priority:
        1. Try keyring (Windows Credential Manager)
        2. Auto-fallback to encrypted file (if keyring unavailable)
        3. Never fall back to plaintext
        
        Args:
            tokens: Dictionary with token keys (e.g., 'access_token', 'refresh_token')
            user_email: User's email (used as storage key, default='default')
        
        Returns:
            True if saved successfully
            
        Raises:
            SecurityError: If no secure storage method available
        """
        with self._lock:
            # Try keyring first (preferred)
            if KEYRING_AVAILABLE:
                try:
                    success = self._save_to_keyring(tokens, user_email)
                    if success:
                        self.storage_method = 'keyring'
                        logger.info(f"Tokens saved to keyring for {user_email}")
                        return True
                except Exception as e:
                    logger.warning(f"Keyring save failed: {e}, falling back to encryption")
            else:
                logger.info("Keyring not available, using encrypted storage")
            
            # Auto-fallback to encrypted storage (NO CONSENT DIALOG)
            try:
                success = self._save_encrypted(tokens, user_email)
                if success:
                    self.storage_method = 'encrypted'
                    logger.info(f"Tokens saved to encrypted file for {user_email}")
                    
                    # Show non-blocking notification (first time only)
                    if not self.notification_shown:
                        self._show_fallback_notification()
                        self._mark_notification_shown()
                    
                    return True
            except Exception as e:
                logger.error(f"Encrypted save failed: {e}")
                raise SecurityError(
                    "Cannot save tokens securely. Please contact support."
                ) from e
    
    def load_tokens(self, user_email: str = 'default') -> Optional[Dict[str, str]]:
        """
        Load tokens from secure storage.
        
        Tries both keyring and encrypted file automatically.
        
        Args:
            user_email: User's email (default='default')
            
        Returns:
            Dictionary with tokens, or None if not found
        """
        with self._lock:
            keyring_tokens = self._load_from_keyring(user_email) if KEYRING_AVAILABLE else None
            encrypted_tokens = self._load_encrypted(user_email)

            # MERGE both sources instead of preferring keyring outright. Large tokens
            # (Atlassian access/refresh) can fail to save to Windows Credential Manager
            # (2560-byte / ~1280-char blob limit) and therefore live ONLY in the
            # encrypted fallback, while small tokens are in keyring. Returning keyring
            # alone dropped the big tokens -> users had to re-login on every restart.
            # keyring wins on conflicts (it's the freshest, most secure store); the
            # encrypted file fills any gaps. This recovers already-affected users with
            # no re-login.
            if keyring_tokens and encrypted_tokens:
                merged = {**encrypted_tokens, **keyring_tokens}
                self.storage_method = 'keyring+encrypted'
                return merged
            if keyring_tokens:
                self.storage_method = 'keyring'
                return keyring_tokens
            if encrypted_tokens:
                self.storage_method = 'encrypted'
                return encrypted_tokens

            return None
    
    def delete_tokens(self, user_email: str = 'default') -> bool:
        """
        Delete tokens from all storage locations.
        
        Args:
            user_email: User's email
            
        Returns:
            True if deleted successfully
        """
        with self._lock:
            deleted = False
            
            # Delete from keyring
            if KEYRING_AVAILABLE:
                try:
                    # Delete all known sensitive token keys
                    for key in SENSITIVE_TOKEN_KEYS:
                        _keyring_delete(self.SERVICE_NAME, f"{user_email}_{key}")
                    deleted = True
                except Exception as e:
                    logger.debug(f"Keyring delete error (non-critical): {e}")
            
            # Delete encrypted file
            try:
                enc_file = self._get_encrypted_file_path(user_email)
                if os.path.exists(enc_file):
                    os.remove(enc_file)
                    deleted = True
            except Exception as e:
                logger.debug(f"Encrypted file delete error (non-critical): {e}")
            
            logger.info(f"Tokens deleted for {user_email}")
            return deleted
    
    def get_storage_status(self) -> Dict[str, any]:
        """
        Get current storage method and security status.
        
        Used for settings page and admin dashboards.
        
        Returns:
            Dictionary with status information
        """
        if self.storage_method == 'keyring':
            return {
                'method': 'Windows Credential Manager',
                'security_level': 'Most Secure',
                'icon': '🟢',
                'description': 'Tokens stored in Windows Credential Manager',
                'encryption': 'OS-level encryption',
                'recommendation': None
            }
        elif self.storage_method == 'encrypted':
            return {
                'method': 'Encrypted File Storage',
                'security_level': 'Secure',
                'icon': '🟡',
                'description': 'Tokens stored in encrypted file (Windows Credential Manager unavailable)',
                'encryption': 'AES-128-CBC with machine-specific key',
                'recommendation': 'For best security, enable Windows Credential Manager in system settings'
            }
        else:
            return {
                'method': 'Unknown',
                'security_level': 'Not Initialized',
                'icon': '⚪',
                'description': 'No tokens saved yet',
                'encryption': None,
                'recommendation': None
            }
    
    def migrate_from_plaintext(self, plaintext_file: str, user_email: str = 'default') -> bool:
        """
        Migrate tokens from plaintext JSON file to secure storage.
        
        Args:
            plaintext_file: Path to existing plaintext token file
            user_email: User email for storage key
            
        Returns:
            True if migration successful, False if nothing to migrate
        """
        if not os.path.exists(plaintext_file):
            logger.info("No plaintext file to migrate")
            return False
        
        try:
            with open(plaintext_file, 'r') as f:
                tokens = json.load(f)
            
            if not tokens:
                logger.info("Plaintext file is empty")
                return False
            
            # Save to secure storage
            self.save_tokens(tokens, user_email)
            
            # Delete plaintext file for security
            try:
                os.remove(plaintext_file)
                logger.info(f"Migrated tokens from plaintext and deleted {plaintext_file}")
            except Exception as e:
                logger.warning(f"Could not delete plaintext file: {e}")
            
            return True
            
        except Exception as e:
            logger.error(f"Migration failed: {e}")
            return False
    
    # =========================================================================
    # KEYRING STORAGE (PREFERRED)
    # =========================================================================
    
    def _save_to_keyring(self, tokens: Dict[str, str], user_email: str) -> bool:
        """Save tokens to Windows Credential Manager via keyring."""
        for key, value in tokens.items():
            if value:  # Only save non-empty values
                storage_key = f"{user_email}_{key}"
                _keyring_set(self.SERVICE_NAME, storage_key, value)
        return True
    
    def _load_from_keyring(self, user_email: str) -> Optional[Dict[str, str]]:
        """Load tokens from Windows Credential Manager."""
        try:
            tokens = {}
            for key in SENSITIVE_TOKEN_KEYS:
                storage_key = f"{user_email}_{key}"
                value = _keyring_get(self.SERVICE_NAME, storage_key)
                if value:
                    tokens[key] = value
            
            # Return tokens if we found at least one
            return tokens if tokens else None
            
        except Exception as e:
            logger.debug(f"Keyring load failed: {e}")
            return None
    
    # =========================================================================
    # ENCRYPTED FILE STORAGE (FALLBACK)
    # =========================================================================
    
    def _save_encrypted(self, tokens: Dict[str, str], user_email: str) -> bool:
        """
        Save tokens to encrypted file.
        
        Encryption details:
        - Algorithm: AES-128-CBC (via Fernet)
        - Key derivation: PBKDF2-HMAC-SHA256 (600,000 iterations)
        - Salt: Machine-specific (Windows GUID + username)
        - File permissions: User-only (0600 on Unix, ACLs on Windows)
        """
        # Generate encryption key
        cipher = self._get_cipher()
        
        # Prepare token data
        token_data = {
            'version': self.ENCRYPTION_VERSION,
            'user_email': user_email,
            'tokens': tokens
        }
        
        # Encrypt
        plaintext = json.dumps(token_data).encode('utf-8')
        encrypted = cipher.encrypt(plaintext)
        
        # Save to file
        enc_file = self._get_encrypted_file_path(user_email)
        with open(enc_file, 'wb') as f:
            f.write(encrypted)
        
        # Set file permissions (Windows ACL or Unix permissions)
        self._set_file_permissions(enc_file)
        
        return True
    
    def _load_encrypted(self, user_email: str) -> Optional[Dict[str, str]]:
        """Load tokens from encrypted file."""
        enc_file = self._get_encrypted_file_path(user_email)
        
        if not os.path.exists(enc_file):
            return None
        
        try:
            # Read encrypted file
            with open(enc_file, 'rb') as f:
                encrypted = f.read()
            
            # Decrypt
            cipher = self._get_cipher()
            plaintext = cipher.decrypt(encrypted)
            token_data = json.loads(plaintext.decode('utf-8'))
            
            # Verify user
            if token_data.get('user_email') != user_email:
                logger.warning("Email mismatch in encrypted token file")
                return None
            
            return token_data.get('tokens', {})
            
        except Exception as e:
            logger.error(f"Failed to decrypt tokens: {e}")
            return None
    
    # =========================================================================
    # ENCRYPTION UTILITIES
    # =========================================================================
    
    def _get_cipher(self) -> Fernet:
        """
        Generate encryption cipher with machine-specific key.
        
        Key derivation:
        - Salt: Windows Machine GUID + Windows Username
        - Algorithm: PBKDF2-HMAC-SHA256
        - Iterations: 600,000 (OWASP 2023 recommendation)
        - Output: 32 bytes (Fernet key)
        """
        salt = self._get_machine_salt()
        
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=600000,  # OWASP 2023 recommendation
        )
        
        # Derive key (password is also machine-specific)
        password = self._get_machine_password()
        key = base64.urlsafe_b64encode(kdf.derive(password.encode('utf-8')))
        
        return Fernet(key)
    
    def _get_machine_salt(self) -> bytes:
        """
        Generate machine-specific salt.
        
        On Windows: Uses MachineGuid from registry
        On other OS: Uses hostname + username
        """
        if platform.system() == 'Windows':
            try:
                import winreg
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r'SOFTWARE\Microsoft\Cryptography',
                    0,
                    winreg.KEY_READ | winreg.KEY_WOW64_64KEY
                )
                machine_guid, _ = winreg.QueryValueEx(key, 'MachineGuid')
                winreg.CloseKey(key)
                
                username = os.getenv('USERNAME', 'default')
                salt_str = f"{machine_guid}_{username}"
                
            except Exception as e:
                logger.warning(f"Could not read MachineGuid: {e}, using fallback")
                salt_str = f"{platform.node()}_{os.getenv('USERNAME', 'default')}"
        else:
            salt_str = f"{platform.node()}_{os.getenv('USER', 'default')}"
        
        # Hash to get fixed-length salt
        return hashlib.sha256(salt_str.encode('utf-8')).digest()
    
    def _get_machine_password(self) -> str:
        """Generate machine-specific password component."""
        components = [
            platform.node(),
            platform.system(),
            os.getenv('USERNAME') or os.getenv('USER') or 'default'
        ]
        return '_'.join(components)
    
    def _get_encrypted_file_path(self, user_email: str) -> str:
        """Get path to encrypted token file."""
        # Hash email for filename (privacy)
        email_hash = hashlib.sha256(user_email.encode('utf-8')).hexdigest()[:16]
        return os.path.join(self.app_data_dir, f'tokens_{email_hash}.enc')
    
    def _set_file_permissions(self, file_path: str):
        """Set restrictive file permissions (user-only access)."""
        if platform.system() != 'Windows':
            # Unix: Set to 0600 (read/write for owner only)
            os.chmod(file_path, 0o600)
        else:
            # Windows: ACLs are handled by user profile directory permissions
            pass
    
    # =========================================================================
    # NOTIFICATION & TRANSPARENCY
    # =========================================================================
    
    def _show_fallback_notification(self):
        """
        Log encrypted storage usage (no user-facing notification).
        """
        logger.info("Using encrypted storage (system credential manager unavailable)")
    
    def _load_notification_status(self):
        """Load whether notification has been shown."""
        status_file = os.path.join(self.app_data_dir, 'notification_status.json')
        if os.path.exists(status_file):
            try:
                with open(status_file, 'r') as f:
                    data = json.load(f)
                    self.notification_shown = data.get('fallback_notification_shown', False)
            except:
                self.notification_shown = False
        else:
            self.notification_shown = False
    
    def _mark_notification_shown(self):
        """Mark notification as shown."""
        status_file = os.path.join(self.app_data_dir, 'notification_status.json')
        data = {
            'fallback_notification_shown': True,
            'timestamp': str(os.times())
        }
        try:
            with open(status_file, 'w') as f:
                json.dump(data, f)
            self.notification_shown = True
        except Exception as e:
            logger.debug(f"Could not save notification status: {e}")


# =============================================================================
# EXCEPTIONS
# =============================================================================

class SecurityError(Exception):
    """Raised when secure storage is not available."""
    pass
