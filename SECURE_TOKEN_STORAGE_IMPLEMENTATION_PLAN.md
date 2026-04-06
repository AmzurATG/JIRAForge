# Secure Token Storage - Hybrid Approach Implementation Plan

**Project:** JIRAForge Desktop App Token Storage Security  
**Issue:** Tokens currently stored in plaintext when keyring unavailable (CVSS 7.8 - High)  
**Solution:** Hybrid approach with keyring priority + encrypted fallback with user consent  
**Estimated Effort:** 14 hours  
**Target Completion:** Sprint 2026-Q2

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Current vs Proposed Comparison](#current-vs-proposed-comparison)
3. [Architecture Overview](#architecture-overview)
4. [File Changes Required](#file-changes-required)
5. [Detailed Implementation Steps](#detailed-implementation-steps)
6. [Testing Strategy](#testing-strategy)
7. [Migration Plan](#migration-plan)
8. [Deployment Strategy](#deployment-strategy)
9. [Rollback Plan](#rollback-plan)
10. [Success Metrics](#success-metrics)

---

## 1. Executive Summary

### Problem Statement
The desktop application currently stores OAuth tokens in plaintext JSON files when the keyring library is unavailable, creating a high-severity security vulnerability (CVSS 7.8).

### Proposed Solution
Implement a three-tier security hierarchy:
1. **Primary:** Windows Credential Manager (via keyring) - 85-90% of users
2. **Fallback:** Encrypted file storage with user consent - 5-10% of users
3. **Fail:** Cannot operate (rare edge cases) - 0-5% of users

### Key Benefits
- ✅ **Security:** Eliminates plaintext token storage
- ✅ **Compatibility:** Works on 95%+ of systems (vs 85-95% with fail-secure)
- ✅ **User Experience:** Clear communication about security status
- ✅ **Auditability:** Logs which storage method each user is using
- ✅ **Compliance:** Meets GDPR Article 32 security requirements

### Business Impact
- **Risk Reduction:** Eliminates critical security vulnerability
- **User Retention:** Minimal disruption (vs fail-secure approach)
- **Support Burden:** Clear troubleshooting path for IT admins
- **Compliance:** Production-ready security posture

---

## 2. Current vs Proposed Comparison

### 2.1 Current Implementation (INSECURE)

**File:** `python-desktop-app/desktop_app.py` (Lines ~180-250)

```python
# Current AuthManager class
class AuthManager:
    def save_tokens(self, tokens):
        if KEYRING_AVAILABLE:
            # Try to use keyring
            try:
                keyring.set_password('TimeTracker', 'access_token', tokens['access_token'])
                keyring.set_password('TimeTracker', 'refresh_token', tokens['refresh_token'])
            except Exception as e:
                print(f"[WARN] Keyring error: {e}")
                # ❌ PROBLEM: Falls back to plaintext
                self._save_to_json(tokens)
        else:
            # ❌ PROBLEM: No keyring = plaintext storage
            print("[WARN] keyring module not available - tokens will be stored in plain text")
            self._save_to_json(tokens)
    
    def _save_to_json(self, tokens):
        """❌ INSECURE: Plaintext storage"""
        auth_file = os.path.join(self.app_data_dir, 'brd_tracker_auth.json')
        with open(auth_file, 'w') as f:
            json.dump(tokens, f)  # NO ENCRYPTION
```

**Security Issues:**
- ❌ Tokens stored in plaintext at `%LOCALAPPDATA%\TimeTracker\brd_tracker_auth.json`
- ❌ No encryption
- ❌ No user awareness
- ❌ Easy target for malware
- ❌ Compliance violation (GDPR Article 32)

---

### 2.2 Proposed Implementation (SECURE)

**File:** `python-desktop-app/auth/secure_storage.py` (NEW FILE)

```python
# Proposed SecureTokenStorage class
class SecureTokenStorage:
    """
    Three-tier security hierarchy for token storage:
    1. Windows Credential Manager (keyring) - PREFERRED
    2. Encrypted file storage - FALLBACK
    3. Fail secure - CANNOT OPERATE
    """
    
    def __init__(self):
        self.storage_method = self._detect_best_storage_method()
        self.consent_given = self._check_encrypted_storage_consent()
    
    def save_tokens(self, tokens):
        if self.storage_method == 'keyring':
            # ✅ SECURE: Windows Credential Manager
            self._save_to_keyring(tokens)
        elif self.storage_method == 'encrypted':
            # 🟡 ACCEPTABLE: Encrypted file with user consent
            if not self.consent_given:
                self.consent_given = self._request_user_consent()
            if self.consent_given:
                self._save_encrypted(tokens)
            else:
                raise SecurityError("User declined encrypted storage")
        else:
            # ❌ CANNOT OPERATE
            raise SecurityError("No secure storage method available")
```

**Security Improvements:**
- ✅ Keyring preferred (highest security)
- ✅ Encrypted fallback (acceptable security)
- ✅ User consent required for fallback
- ✅ No plaintext storage under any circumstance
- ✅ Audit trail of storage method used
- ✅ Visual indicators for fallback mode

---

### 2.3 Side-by-Side Comparison

| Aspect | Current (Insecure) | Proposed (Secure) |
|--------|-------------------|-------------------|
| **Storage Method 1** | Keyring (when available) | Keyring (preferred) ✅ |
| **Storage Method 2** | Plaintext JSON ❌ | Encrypted file 🟡 |
| **User Awareness** | Silent fallback ❌ | Consent dialog + visual indicator ✅ |
| **Encryption** | None ❌ | AES-128 via Fernet ✅ |
| **Machine Binding** | None ❌ | Machine GUID + username ✅ |
| **Audit Logging** | Basic ⚠️ | Comprehensive ✅ |
| **Compliance** | Violates GDPR ❌ | Compliant ✅ |
| **User Impact** | None (works everywhere) | Dialog on 5-10% of systems |
| **Security Rating** | F (plaintext) | B+ (encrypted fallback) |

---

## 3. Architecture Overview

### 3.1 Security Hierarchy Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    TOKEN STORAGE DECISION TREE                   │
└─────────────────────────────────────────────────────────────────┘

        User logs in with OAuth
                 │
                 ▼
    ┌────────────────────────────┐
    │ Detect Available Storage   │
    └────────────────────────────┘
                 │
    ┌────────────┴────────────┐
    │                         │
    ▼                         ▼
┌─────────────┐      ┌─────────────────┐      ┌──────────────────┐
│  Keyring    │  YES │  Try Keyring    │ ✅   │  Save to         │
│ Available?  │─────▶│  Test Write     │─────▶│  Credential Mgr  │
└─────────────┘      └─────────────────┘      └──────────────────┘
    │ NO                     │ FAIL                    │
    ▼                        ▼                         │
┌─────────────┐      ┌─────────────────┐              │
│  Encryption │  YES │  Show Security  │              │
│  Available? │─────▶│  Warning Dialog │              │
└─────────────┘      └─────────────────┘              │
    │ NO                     │                         │
    │                   ┌────┴────┐                    │
    │                   │ Accept? │                    │
    │                   └────┬────┘                    │
    │                        │                         │
    │         ┌──────────────┼──────────────┐          │
    │         │ YES          │ NO           │          │
    │         ▼              ▼              │          │
    │  ┌──────────────┐  ┌──────────┐      │          │
    │  │ Save         │  │   Exit   │      │          │
    │  │ Encrypted    │  │   App    │      │          │
    │  └──────┬───────┘  └──────────┘      │          │
    │         │                             │          │
    │         │ ┌───────────────────────────┘          │
    │         │ │                                      │
    │         ▼ ▼                                      │
    │  ┌─────────────────┐                            │
    │  │ Log Storage     │                            │
    │  │ Method Used     │◀───────────────────────────┘
    │  └─────────────────┘
    │
    ▼
┌─────────────────┐
│  Cannot         │
│  Operate        │
│  (Exit)         │
└─────────────────┘
```

### 3.2 Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Desktop Application                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              AUTH MANAGER (desktop_app.py)             │    │
│  │  - Handles OAuth flow                                  │    │
│  │  - Delegates to SecureTokenStorage                     │    │
│  └────────────────────┬───────────────────────────────────┘    │
│                       │                                         │
│                       ▼                                         │
│  ┌────────────────────────────────────────────────────────┐    │
│  │         SECURE TOKEN STORAGE (secure_storage.py)       │    │
│  │  - Detects available storage methods                   │    │
│  │  - Manages storage method selection                    │    │
│  │  - Coordinates consent flow                            │    │
│  └────┬───────────────┬─────────────────┬─────────────────┘    │
│       │               │                 │                      │
│       ▼               ▼                 ▼                      │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────┐          │
│  │ Keyring │  │  Encryption  │  │  Consent UI     │          │
│  │ Handler │  │  Handler     │  │  (dialog.py)    │          │
│  └─────────┘  └──────────────┘  └─────────────────┘          │
│       │               │                 │                      │
│       ▼               ▼                 ▼                      │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────┐          │
│  │ Windows │  │ Encrypted    │  │ User Consent    │          │
│  │ Cred.   │  │ .enc File    │  │ Record          │          │
│  │ Manager │  │              │  │ (consent.json)  │          │
│  └─────────┘  └──────────────┘  └─────────────────┘          │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. File Changes Required

### 4.1 Files to CREATE (New Files)

#### 4.1.1 `python-desktop-app/auth/secure_storage.py` ⭐ CORE
**Purpose:** Main secure token storage implementation  
**Lines of Code:** ~350  
**Effort:** 6 hours

**Key Classes:**
- `SecureTokenStorage` - Main storage coordinator
- `KeyringHandler` - Windows Credential Manager interface
- `EncryptionHandler` - Encrypted file storage
- `StorageMethod` - Enum for storage types

**Key Functions:**
```python
- detect_best_storage_method() -> str
- save_tokens(tokens: dict) -> bool
- load_tokens() -> dict
- _save_to_keyring(tokens: dict)
- _save_encrypted(tokens: dict)
- _get_machine_key() -> bytes
- _encrypt_data(data: str) -> bytes
- _decrypt_data(data: bytes) -> str
```

---

#### 4.1.2 `python-desktop-app/auth/consent_manager.py`
**Purpose:** Manage user consent for encrypted storage  
**Lines of Code:** ~150  
**Effort:** 2 hours

**Key Classes:**
- `ConsentManager` - Track encryption consent

**Key Functions:**
```python
- check_consent(user_id: str) -> bool
- record_consent(user_id: str, consented: bool)
- get_consent_timestamp(user_id: str) -> datetime
- clear_consent(user_id: str)
```

**Data Structure:**
```json
{
  "user_id": "712020:abcd1234-...",
  "consented_at": "2026-04-06T10:30:00Z",
  "consent_version": "1.0",
  "storage_method": "encrypted",
  "acknowledged_risks": true
}
```

---

#### 4.1.3 `python-desktop-app/ui/security_dialog.py`
**Purpose:** User consent dialog for encrypted storage  
**Lines of Code:** ~200  
**Effort:** 3 hours

**Key Functions:**
```python
- show_security_warning_dialog() -> bool
- show_keyring_unavailable_notice()
- show_fallback_mode_indicator()
```

**Dialog Design:**
```
┌────────────────────────────────────────────────────────┐
│  ⚠️  Security Notice                            [X]    │
├────────────────────────────────────────────────────────┤
│                                                         │
│  Windows Credential Manager is not available on        │
│  your system.                                          │
│                                                         │
│  TimeTracker will use encrypted file storage as a      │
│  fallback. While encrypted, this is less secure        │
│  than using the system credential manager.             │
│                                                         │
│  Your tokens will be encrypted with a machine-         │
│  specific key and stored at:                           │
│  %LOCALAPPDATA%\TimeTracker\auth_encrypted.enc        │
│                                                         │
│  [ ] I understand and accept the security risks        │
│                                                         │
│  [Continue with Encrypted Storage]  [Exit Application] │
│                                                         │
└────────────────────────────────────────────────────────┘
```

---

#### 4.1.4 `python-desktop-app/auth/__init__.py`
**Purpose:** Package initialization  
**Lines of Code:** ~20  
**Effort:** 15 minutes

```python
"""
Secure authentication and token storage module.
"""

from .secure_storage import SecureTokenStorage
from .consent_manager import ConsentManager

__all__ = ['SecureTokenStorage', 'ConsentManager']
```

---

#### 4.1.5 `python-desktop-app/migrations/migrate_tokens.py`
**Purpose:** Migrate existing plaintext tokens to encrypted  
**Lines of Code:** ~100  
**Effort:** 1.5 hours

**Key Functions:**
```python
- detect_plaintext_tokens() -> bool
- migrate_to_secure_storage() -> bool
- backup_old_tokens()
- cleanup_plaintext_files()
```

---

#### 4.1.6 `python-desktop-app/tests/test_secure_storage.py`
**Purpose:** Unit tests for token storage  
**Lines of Code:** ~400  
**Effort:** 3 hours

**Test Coverage:**
- Test keyring availability detection
- Test encryption/decryption
- Test storage method selection
- Test consent flow
- Test migration from plaintext
- Test error handling

---

### 4.2 Files to MODIFY (Existing Files)

#### 4.2.1 `python-desktop-app/desktop_app.py` ⭐ CRITICAL
**Current Size:** ~3000 lines  
**Changes Required:** ~50 lines modified, ~100 lines removed  
**Effort:** 2 hours

**Modifications:**

**REMOVE these sections:**
```python
# Lines ~187-250: Remove insecure fallback logic
# OLD CODE TO DELETE:
if not KEYRING_AVAILABLE:
    print("[WARN] keyring module not available - tokens will be stored in plain text")
    auth_file = os.path.join(self.app_data_dir, 'brd_tracker_auth.json')
    with open(auth_file, 'w') as f:
        json.dump(tokens, f)
```

**ADD these sections:**
```python
# Line ~50: Add imports
from auth.secure_storage import SecureTokenStorage

# Line ~180: Replace AuthManager initialization
class AuthManager:
    def __init__(self):
        self.app_data_dir = self._get_app_data_dir()
        self.secure_storage = SecureTokenStorage(self.app_data_dir)  # NEW
    
    def save_tokens(self, tokens):
        """Save tokens using secure storage"""
        try:
            self.secure_storage.save_tokens(tokens)
        except SecurityError as e:
            logger.error(f"[Auth] Failed to save tokens securely: {e}")
            raise
    
    def load_tokens(self):
        """Load tokens from secure storage"""
        try:
            return self.secure_storage.load_tokens()
        except Exception as e:
            logger.error(f"[Auth] Failed to load tokens: {e}")
            return None
```

**Specific Line Changes:**
| Line Range | Action | Description |
|------------|--------|-------------|
| 50-60 | ADD | Import SecureTokenStorage |
| 180-190 | MODIFY | Update AuthManager.__init__ |
| 187-250 | DELETE | Remove plaintext fallback logic |
| 251-280 | MODIFY | Update save_tokens() method |
| 281-310 | MODIFY | Update load_tokens() method |

---

#### 4.2.2 `python-desktop-app/requirements.txt`
**Current Size:** ~30 lines  
**Changes Required:** Add dependencies  
**Effort:** 15 minutes

**ADD:**
```txt
# Security dependencies (add after existing packages)
keyring>=24.0.0           # OS credential manager
cryptography>=41.0.0       # Encryption for fallback storage
```

**VERIFY existing:**
```txt
keyring  # Should already exist, update version if needed
```

---

#### 4.2.3 `python-desktop-app/config.py` or `settings.py`
**Current Size:** ~100 lines  
**Changes Required:** Add configuration constants  
**Effort:** 30 minutes

**ADD:**
```python
# Security configuration
SECURE_STORAGE_ENABLED = True
REQUIRE_KEYRING = False  # False = allow encrypted fallback
ENCRYPTION_ALGORITHM = 'fernet'  # AES-128 via Fernet
CONSENT_REQUIRED = True
STORAGE_MIGRATION_ENABLED = True

# File paths
ENCRYPTED_TOKEN_FILE = 'auth_encrypted.enc'
CONSENT_FILE = 'storage_consent.json'
LEGACY_TOKEN_FILE = 'brd_tracker_auth.json'  # For migration

# Logging
LOG_STORAGE_METHOD = True
LOG_SECURITY_WARNINGS = True
```

---

#### 4.2.4 `python-desktop-app/logger_config.py`
**Current Size:** ~50 lines  
**Changes Required:** Add security logging  
**Effort:** 30 minutes

**ADD:**
```python
# Security event logging
SECURITY_LOG_FILE = 'security_audit.log'

def log_security_event(event_type, details):
    """Log security-related events for audit trail"""
    security_logger.info(
        f"[SECURITY] {event_type}: {details}",
        extra={'storage_method': details.get('storage_method')}
    )
```

---

#### 4.2.5 `python-desktop-app/system_tray.py`
**Current Size:** ~200 lines  
**Changes Required:** Add visual indicator for fallback mode  
**Effort:** 1 hour

**ADD:**
```python
# Add to TrayIcon class
def set_security_indicator(self, storage_method):
    """Update tray icon to show security status"""
    if storage_method == 'keyring':
        self.icon.icon = self.icon_green  # Secure
        self.icon.title = "TimeTracker (Secure)"
    elif storage_method == 'encrypted':
        self.icon.icon = self.icon_yellow  # Warning
        self.icon.title = "TimeTracker (Encrypted Fallback)"
        self.show_notification(
            "Security Notice",
            "Using encrypted file storage (fallback mode)"
        )
    else:
        self.icon.icon = self.icon_red  # Error
        self.icon.title = "TimeTracker (Secure Storage Failed)"
```

---

#### 4.2.6 `python-desktop-app/setup.py` or `pyproject.toml`
**Current Size:** ~50 lines  
**Changes Required:** Update dependencies  
**Effort:** 15 minutes

**MODIFY:**
```python
install_requires=[
    'keyring>=24.0.0',      # Update version
    'cryptography>=41.0.0',  # Add dependency
    # ... existing dependencies
]
```

---

### 4.3 Files to DELETE (Deprecated Files)

These files should be removed after migration:

| File Path | Reason | When to Delete |
|-----------|--------|----------------|
| `%LOCALAPPDATA%\TimeTracker\brd_tracker_auth.json` | Plaintext tokens (user data) | After migration completes |
| Any backup `.json.bak` files | Old backups | After migration verification |

**Note:** These are user data files, not code files. Deletion happens during migration, not deployment.

---

### 4.4 Summary of File Changes

| Category | Files | Total LOC | Effort |
|----------|-------|-----------|--------|
| **New Files** | 6 | ~1,220 | 9.25 hours |
| **Modified Files** | 6 | ~100 changes | 4.75 hours |
| **Test Files** | 1 | ~400 | Included above |
| **Documentation** | 3 | N/A | (separate task) |
| **Total** | **16** | **~1,320** | **14 hours** |

---

## 5. Detailed Implementation Steps

### Phase 1: Foundation (Day 1 - 4 hours)

#### Step 1.1: Create Core Secure Storage Module (2 hours)
**File:** `python-desktop-app/auth/secure_storage.py`

```python
"""
Secure token storage with three-tier hierarchy:
1. Windows Credential Manager (keyring)
2. Encrypted file storage (fallback)
3. Fail secure (cannot operate)
"""

import os
import json
import logging
import keyring
from enum import Enum
from typing import Optional, Dict, Any
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64

logger = logging.getLogger(__name__)

class StorageMethod(Enum):
    """Available secure storage methods"""
    KEYRING = 'keyring'
    ENCRYPTED = 'encrypted'
    UNAVAILABLE = 'unavailable'

class SecurityError(Exception):
    """Raised when secure storage cannot be initialized"""
    pass

class SecureTokenStorage:
    """
    Secure token storage manager.
    
    Storage hierarchy:
    1. Primary: Windows Credential Manager (keyring)
    2. Fallback: Encrypted file with user consent
    3. Fail: Cannot operate securely
    """
    
    SERVICE_NAME = 'TimeTracker'
    ENCRYPTED_FILE_NAME = 'auth_encrypted.enc'
    ENCRYPTION_SALT = b'timetracker-v1-salt-2026'
    PBKDF2_ITERATIONS = 100000
    
    def __init__(self, app_data_dir: str):
        """
        Initialize secure token storage.
        
        Args:
            app_data_dir: Application data directory path
        """
        self.app_data_dir = app_data_dir
        self.storage_method = self._detect_storage_method()
        self._machine_key = None  # Lazy loaded
        
        logger.info(f"[SecureStorage] Initialized with method: {self.storage_method.value}")
    
    def _detect_storage_method(self) -> StorageMethod:
        """
        Detect best available secure storage method.
        
        Returns:
            StorageMethod enum value
        """
        # Try keyring first
        if self._can_use_keyring():
            logger.info("[SecureStorage] Windows Credential Manager available")
            return StorageMethod.KEYRING
        
        # Try encrypted file storage
        if self._can_use_encryption():
            logger.warning("[SecureStorage] Keyring unavailable, using encrypted fallback")
            return StorageMethod.ENCRYPTED
        
        # Cannot operate securely
        logger.error("[SecureStorage] No secure storage method available")
        return StorageMethod.UNAVAILABLE
    
    def _can_use_keyring(self) -> bool:
        """
        Test if keyring is available and working.
        
        Returns:
            True if keyring can be used
        """
        try:
            # Try to set and get a test value
            test_key = f'{self.SERVICE_NAME}_test'
            test_value = 'test_value'
            
            keyring.set_password(self.SERVICE_NAME, test_key, test_value)
            retrieved = keyring.get_password(self.SERVICE_NAME, test_key)
            keyring.delete_password(self.SERVICE_NAME, test_key)
            
            return retrieved == test_value
        except Exception as e:
            logger.warning(f"[SecureStorage] Keyring test failed: {e}")
            return False
    
    def _can_use_encryption(self) -> bool:
        """
        Test if encryption is available.
        
        Returns:
            True if encryption can be used
        """
        try:
            # Check if we can generate machine key
            key = self._get_machine_key()
            
            # Test encryption/decryption
            cipher = Fernet(key)
            test_data = b'test'
            encrypted = cipher.encrypt(test_data)
            decrypted = cipher.decrypt(encrypted)
            
            return decrypted == test_data
        except Exception as e:
            logger.error(f"[SecureStorage] Encryption test failed: {e}")
            return False
    
    def _get_machine_key(self) -> bytes:
        """
        Generate machine-specific encryption key.
        
        Uses Windows machine GUID + username for unique key per user+machine.
        This ensures tokens cannot be copied to another computer.
        
        Returns:
            32-byte encryption key
        """
        if self._machine_key:
            return self._machine_key
        
        try:
            import winreg
            
            # Get Windows machine GUID
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Cryptography"
            )
            machine_guid = winreg.QueryValueEx(key, "MachineGuid")[0]
            winreg.CloseKey(key)
            
            # Combine machine GUID + username for unique key
            username = os.getlogin()
            unique_id = f"{machine_guid}-{username}".encode()
            
            # Derive key using PBKDF2
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=self.ENCRYPTION_SALT,
                iterations=self.PBKDF2_ITERATIONS,
            )
            
            self._machine_key = base64.urlsafe_b64encode(kdf.derive(unique_id))
            logger.info("[SecureStorage] Machine-specific key generated")
            
            return self._machine_key
            
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to generate machine key: {e}")
            raise SecurityError(f"Cannot generate encryption key: {e}")
    
    def save_tokens(self, tokens: Dict[str, Any]) -> bool:
        """
        Save tokens using best available secure method.
        
        Args:
            tokens: Dictionary containing access_token, refresh_token, etc.
        
        Returns:
            True if successful
        
        Raises:
            SecurityError: If no secure storage available or user declined
        """
        if self.storage_method == StorageMethod.KEYRING:
            return self._save_to_keyring(tokens)
        
        elif self.storage_method == StorageMethod.ENCRYPTED:
            # Check consent before using encrypted storage
            from .consent_manager import ConsentManager
            consent_mgr = ConsentManager(self.app_data_dir)
            
            if not consent_mgr.has_consent():
                # Show consent dialog (will be implemented in ui/security_dialog.py)
                from ui.security_dialog import show_security_warning_dialog
                consented = show_security_warning_dialog()
                
                if consented:
                    consent_mgr.record_consent(consented=True)
                else:
                    raise SecurityError("User declined encrypted storage")
            
            return self._save_encrypted(tokens)
        
        else:
            raise SecurityError(
                "No secure storage method available. "
                "Please ensure Windows Credential Manager is enabled or "
                "contact your IT administrator."
            )
    
    def _save_to_keyring(self, tokens: Dict[str, Any]) -> bool:
        """Save tokens to Windows Credential Manager"""
        try:
            # Store tokens as JSON in keyring
            tokens_json = json.dumps(tokens)
            keyring.set_password(
                self.SERVICE_NAME,
                'oauth_tokens',
                tokens_json
            )
            logger.info("[SecureStorage] Tokens saved to Windows Credential Manager")
            return True
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to save to keyring: {e}")
            raise SecurityError(f"Keyring save failed: {e}")
    
    def _save_encrypted(self, tokens: Dict[str, Any]) -> bool:
        """Save tokens to encrypted file"""
        try:
            # Get encryption key
            key = self._get_machine_key()
            cipher = Fernet(key)
            
            # Encrypt tokens
            tokens_json = json.dumps(tokens)
            encrypted_data = cipher.encrypt(tokens_json.encode())
            
            # Save to file
            encrypted_file = os.path.join(
                self.app_data_dir,
                self.ENCRYPTED_FILE_NAME
            )
            with open(encrypted_file, 'wb') as f:
                f.write(encrypted_data)
            
            logger.warning(
                "[SecureStorage] Tokens saved to encrypted file (fallback mode). "
                "Consider enabling Windows Credential Manager for better security."
            )
            return True
            
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to save encrypted: {e}")
            raise SecurityError(f"Encryption save failed: {e}")
    
    def load_tokens(self) -> Optional[Dict[str, Any]]:
        """
        Load tokens from secure storage.
        
        Returns:
            Dictionary with tokens or None if not found
        """
        if self.storage_method == StorageMethod.KEYRING:
            return self._load_from_keyring()
        elif self.storage_method == StorageMethod.ENCRYPTED:
            return self._load_encrypted()
        else:
            return None
    
    def _load_from_keyring(self) -> Optional[Dict[str, Any]]:
        """Load tokens from keyring"""
        try:
            tokens_json = keyring.get_password(self.SERVICE_NAME, 'oauth_tokens')
            if tokens_json:
                return json.loads(tokens_json)
            return None
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to load from keyring: {e}")
            return None
    
    def _load_encrypted(self) -> Optional[Dict[str, Any]]:
        """Load tokens from encrypted file"""
        try:
            encrypted_file = os.path.join(
                self.app_data_dir,
                self.ENCRYPTED_FILE_NAME
            )
            
            if not os.path.exists(encrypted_file):
                return None
            
            # Read encrypted data
            with open(encrypted_file, 'rb') as f:
                encrypted_data = f.read()
            
            # Decrypt
            key = self._get_machine_key()
            cipher = Fernet(key)
            decrypted_data = cipher.decrypt(encrypted_data)
            
            # Parse JSON
            tokens = json.loads(decrypted_data.decode())
            logger.info("[SecureStorage] Tokens loaded from encrypted file")
            return tokens
            
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to load encrypted: {e}")
            return None
    
    def delete_tokens(self):
        """Delete stored tokens (for logout)"""
        try:
            if self.storage_method == StorageMethod.KEYRING:
                keyring.delete_password(self.SERVICE_NAME, 'oauth_tokens')
            elif self.storage_method == StorageMethod.ENCRYPTED:
                encrypted_file = os.path.join(
                    self.app_data_dir,
                    self.ENCRYPTED_FILE_NAME
                )
                if os.path.exists(encrypted_file):
                    os.remove(encrypted_file)
            
            logger.info("[SecureStorage] Tokens deleted")
        except Exception as e:
            logger.error(f"[SecureStorage] Failed to delete tokens: {e}")
    
    def get_storage_info(self) -> Dict[str, Any]:
        """Get information about current storage method"""
        return {
            'method': self.storage_method.value,
            'is_secure': self.storage_method in [
                StorageMethod.KEYRING,
                StorageMethod.ENCRYPTED
            ],
            'location': self._get_storage_location(),
            'encryption_enabled': self.storage_method == StorageMethod.ENCRYPTED
        }
    
    def _get_storage_location(self) -> str:
        """Get human-readable storage location"""
        if self.storage_method == StorageMethod.KEYRING:
            return "Windows Credential Manager"
        elif self.storage_method == StorageMethod.ENCRYPTED:
            return os.path.join(self.app_data_dir, self.ENCRYPTED_FILE_NAME)
        else:
            return "Unknown"
```

**Checkpoint:** Test keyring detection and basic encryption

---

#### Step 1.2: Create Consent Manager (1 hour)
**File:** `python-desktop-app/auth/consent_manager.py`

```python
"""
Manages user consent for encrypted token storage.
"""

import os
import json
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

class ConsentManager:
    """
    Manages user consent for using encrypted file storage.
    
    When keyring is unavailable, user must explicitly consent to
    using encrypted file storage as a fallback.
    """
    
    CONSENT_FILE = 'storage_consent.json'
    CONSENT_VERSION = '1.0'
    
    def __init__(self, app_data_dir: str):
        """
        Initialize consent manager.
        
        Args:
            app_data_dir: Application data directory
        """
        self.app_data_dir = app_data_dir
        self.consent_file_path = os.path.join(app_data_dir, self.CONSENT_FILE)
        self._consent_data = self._load_consent()
    
    def _load_consent(self) -> dict:
        """Load consent data from file"""
        if os.path.exists(self.consent_file_path):
            try:
                with open(self.consent_file_path, 'r') as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"[Consent] Failed to load consent: {e}")
                return {}
        return {}
    
    def _save_consent(self):
        """Save consent data to file"""
        try:
            with open(self.consent_file_path, 'w') as f:
                json.dump(self._consent_data, f, indent=2)
        except Exception as e:
            logger.error(f"[Consent] Failed to save consent: {e}")
    
    def has_consent(self) -> bool:
        """
        Check if user has consented to encrypted storage.
        
        Returns:
            True if consent is recorded and current
        """
        if not self._consent_data:
            return False
        
        # Check if consent version matches
        if self._consent_data.get('version') != self.CONSENT_VERSION:
            logger.warning("[Consent] Consent version mismatch, requires re-consent")
            return False
        
        # Check if consent was explicitly given
        return self._consent_data.get('consented', False) is True
    
    def record_consent(self, consented: bool, user_id: Optional[str] = None):
        """
        Record user's consent decision.
        
        Args:
            consented: True if user accepted, False if declined
            user_id: Optional user identifier
        """
        self._consent_data = {
            'consented': consented,
            'version': self.CONSENT_VERSION,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'user_id': user_id,
            'storage_method': 'encrypted',
            'acknowledged_risks': True
        }
        self._save_consent()
        
        logger.info(f"[Consent] User consent recorded: {consented}")
    
    def get_consent_info(self) -> dict:
        """Get consent information"""
        return self._consent_data.copy()
    
    def clear_consent(self):
        """Clear consent record (for logout/reset)"""
        self._consent_data = {}
        if os.path.exists(self.consent_file_path):
            os.remove(self.consent_file_path)
        logger.info("[Consent] Consent cleared")
```

**Checkpoint:** Test consent recording and retrieval

---

#### Step 1.3: Create Security Warning Dialog (1 hour)
**File:** `python-desktop-app/ui/security_dialog.py`

```python
"""
Security warning dialogs for token storage.
"""

import tkinter as tk
from tkinter import messagebox, ttk
import logging

logger = logging.getLogger(__name__)

def show_security_warning_dialog() -> bool:
    """
    Show security warning dialog for encrypted storage fallback.
    
    Returns:
        True if user consented, False if user declined
    """
    
    # Create dialog window
    dialog = tk.Toplevel()
    dialog.title("Security Notice - TimeTracker")
    dialog.geometry("500x400")
    dialog.resizable(False, False)
    
    # Make it modal
    dialog.transient()
    dialog.grab_set()
    
    # Result variable
    user_consented = tk.BooleanVar(value=False)
    
    # Header with warning icon
    header_frame = tk.Frame(dialog, bg='#FFF3CD', pady=10)
    header_frame.pack(fill=tk.X)
    
    tk.Label(
        header_frame,
        text="⚠️  Security Notice",
        font=('Arial', 14, 'bold'),
        bg='#FFF3CD'
    ).pack()
    
    # Main message
    message_frame = tk.Frame(dialog, padx=20, pady=20)
    message_frame.pack(fill=tk.BOTH, expand=True)
    
    message = (
        "Windows Credential Manager is not available on your system.\n\n"
        "TimeTracker will use encrypted file storage as a fallback. "
        "While encrypted, this is less secure than using the system "
        "credential manager.\n\n"
        "Your authentication tokens will be encrypted with a machine-specific "
        "key and stored at:\n"
    )
    
    tk.Label(
        message_frame,
        text=message,
        wraplength=450,
        justify=tk.LEFT,
        font=('Arial', 10)
    ).pack(pady=(0, 10))
    
    # Location display
    location_frame = tk.Frame(message_frame, bg='#F5F5F5', padx=10, pady=10)
    location_frame.pack(fill=tk.X, pady=10)
    
    import os
    storage_path = os.path.join(
        os.getenv('LOCALAPPDATA'),
        'TimeTracker',
        'auth_encrypted.enc'
    )
    
    tk.Label(
        location_frame,
        text=storage_path,
        font=('Courier', 9),
        bg='#F5F5F5',
        fg='#333'
    ).pack()
    
    # Risks explanation
    risks_text = (
        "Security considerations:\n"
        "• Tokens are encrypted but stored on disk\n"
        "• Encryption key is derived from your machine and user account\n"
        "• Less secure than Windows Credential Manager\n"
        "• Recommended: Contact IT to enable Credential Manager"
    )
    
    tk.Label(
        message_frame,
        text=risks_text,
        wraplength=450,
        justify=tk.LEFT,
        font=('Arial', 9),
        fg='#666'
    ).pack(pady=(10, 10))
    
    # Consent checkbox
    consent_var = tk.BooleanVar(value=False)
    
    consent_check = tk.Checkbutton(
        message_frame,
        text="I understand and accept the security risks",
        variable=consent_var,
        font=('Arial', 10)
    )
    consent_check.pack(pady=(10, 0))
    
    # Buttons
    button_frame = tk.Frame(dialog, pady=10)
    button_frame.pack(fill=tk.X, side=tk.BOTTOM)
    
    def on_continue():
        if not consent_var.get():
            messagebox.showwarning(
                "Consent Required",
                "Please check the consent box to continue."
            )
            return
        
        user_consented.set(True)
        logger.info("[SecurityDialog] User consented to encrypted storage")
        dialog.destroy()
    
    def on_exit():
        user_consented.set(False)
        logger.info("[SecurityDialog] User declined encrypted storage")
        dialog.destroy()
    
    tk.Button(
        button_frame,
        text="Continue with Encrypted Storage",
        command=on_continue,
        bg='#FFC107',
        font=('Arial', 10),
        padx=20,
        state=tk.NORMAL
    ).pack(side=tk.LEFT, padx=(20, 10))
    
    tk.Button(
        button_frame,
        text="Exit Application",
        command=on_exit,
        font=('Arial', 10),
        padx=20
    ).pack(side=tk.LEFT)
    
    # Wait for dialog to close
    dialog.wait_window()
    
    return user_consented.get()


def show_keyring_setup_help():
    """Show help dialog for setting up keyring"""
    help_text = """
    Windows Credential Manager Setup
    
    TimeTracker requires Windows Credential Manager for secure token storage.
    
    Steps to enable:
    
    1. Press Win+R to open Run dialog
    2. Type 'services.msc' and press Enter
    3. Find 'Credential Manager' service
    4. Right-click and select 'Start'
    5. Set Startup Type to 'Automatic'
    6. Restart TimeTracker
    
    If the service is not available or you cannot start it,
    contact your IT administrator.
    
    Alternative: TimeTracker can use encrypted file storage,
    but this is less secure.
    """
    
    messagebox.showinfo(
        "Credential Manager Setup",
        help_text
    )
```

**Checkpoint:** Test dialog display and user interaction

---

### Phase 2: Integration (Day 2 - 5 hours)

#### Step 2.1: Modify desktop_app.py (2 hours)

**File:** `python-desktop-app/desktop_app.py`

**Changes to make:**

1. **Add imports (Line ~50)**
```python
# ADD after existing imports
from auth.secure_storage import SecureTokenStorage, SecurityError
```

2. **Modify AuthManager class (Lines ~180-310)**

```python
class AuthManager:
    """Handles OAuth authentication and secure token storage"""
    
    def __init__(self):
        self.app_data_dir = self._get_app_data_dir()
        self.redirect_uri = 'http://localhost:8000/callback'
        
        # NEW: Use secure token storage
        try:
            self.secure_storage = SecureTokenStorage(self.app_data_dir)
            storage_info = self.secure_storage.get_storage_info()
            logger.info(
                f"[Auth] Using storage method: {storage_info['method']} "
                f"at {storage_info['location']}"
            )
        except SecurityError as e:
            logger.error(f"[Auth] Failed to initialize secure storage: {e}")
            raise
        
        # DELETE: Remove old token file handling
        # OLD CODE TO REMOVE:
        # self.token_file = os.path.join(self.app_data_dir, 'brd_tracker_auth.json')
    
    def save_tokens(self, tokens):
        """
        Save OAuth tokens securely.
        
        Args:
            tokens: Dict containing access_token, refresh_token, etc.
        
        Raises:
            SecurityError: If secure storage fails
        """
        try:
            success = self.secure_storage.save_tokens(tokens)
            if success:
                logger.info("[Auth] Tokens saved securely")
                
                # Log security metric
                storage_info = self.secure_storage.get_storage_info()
                self._log_security_metric('token_storage', storage_info['method'])
            else:
                raise SecurityError("Failed to save tokens")
                
        except SecurityError as e:
            logger.error(f"[Auth] Token save failed: {e}")
            # Show error to user
            self._show_storage_error(e)
            raise
        
        # DELETE: Remove old plaintext save logic
        # OLD CODE TO REMOVE (Lines ~200-250):
        # if KEYRING_AVAILABLE:
        #     try:
        #         keyring.set_password(...)
        #     except:
        #         self._save_to_json(tokens)  # ❌ INSECURE FALLBACK
        # else:
        #     self._save_to_json(tokens)  # ❌ INSECURE FALLBACK
    
    def load_tokens(self):
        """
        Load OAuth tokens from secure storage.
        
        Returns:
            Dict with tokens or None if not found
        """
        try:
            tokens = self.secure_storage.load_tokens()
            if tokens:
                logger.info("[Auth] Tokens loaded successfully")
            else:
                logger.info("[Auth] No stored tokens found")
            return tokens
            
        except Exception as e:
            logger.error(f"[Auth] Failed to load tokens: {e}")
            return None
        
        # DELETE: Remove old plaintext load logic
        # OLD CODE TO REMOVE (Lines ~280-310):
        # if KEYRING_AVAILABLE:
        #     try:
        #         return keyring.get_password(...)
        #     except:
        #         return self._load_from_json()
        # else:
        #     return self._load_from_json()
    
    def logout(self):
        """Logout and delete stored tokens"""
        try:
            self.secure_storage.delete_tokens()
            logger.info("[Auth] User logged out, tokens deleted")
        except Exception as e:
            logger.error(f"[Auth] Logout error: {e}")
    
    def _log_security_metric(self, metric_name, value):
        """Log security metrics for monitoring"""
        # This could send to analytics server
        logger.info(f"[METRIC] {metric_name}: {value}")
    
    def _show_storage_error(self, error):
        """Show user-friendly error message"""
        from tkinter import messagebox
        messagebox.showerror(
            "Secure Storage Error",
            f"Failed to save authentication tokens securely:\n\n{error}\n\n"
            "Please ensure Windows Credential Manager is enabled or "
            "contact your IT administrator."
        )
    
    # KEEP: Rest of AuthManager methods unchanged
    # - start_oauth_flow()
    # - handle_callback()
    # - refresh_tokens()
    # etc.
```

**DELETE these methods entirely:**
- `_save_to_json()` (Lines ~240-250)
- `_load_from_json()` (Lines ~290-300)

**Checkpoint:** Test OAuth login with new secure storage

---

#### Step 2.2: Update System Tray Indicator (1 hour)

**File:** `python-desktop-app/system_tray.py`

```python
# ADD to TrayIcon class

def __init__(self):
    # ... existing initialization ...
    
    # NEW: Add security status icons
    self.icon_green = self._create_icon('green')    # Secure (keyring)
    self.icon_yellow = self._create_icon('yellow')  # Warning (encrypted)
    self.icon_red = self._create_icon('red')        # Error
    
def set_storage_indicator(self, storage_method):
    """
    Update tray icon to show security status.
    
    Args:
        storage_method: 'keyring', 'encrypted', or 'unavailable'
    """
    if storage_method == 'keyring':
        self.icon.icon = self.icon_green
        self.icon.title = "TimeTracker (Secure Storage)"
        
    elif storage_method == 'encrypted':
        self.icon.icon = self.icon_yellow
        self.icon.title = "TimeTracker (Encrypted Fallback Mode)"
        
        # Show one-time notification
        if not self._has_shown_fallback_notice():
            self.show_notification(
                "Security Notice",
                "Using encrypted file storage (fallback mode). "
                "Consider enabling Windows Credential Manager for better security."
            )
            self._mark_fallback_notice_shown()
            
    else:
        self.icon.icon = self.icon_red
        self.icon.title = "TimeTracker (Secure Storage Unavailable)"

def _create_icon(self, color):
    """Create colored icon for security status"""
    from PIL import Image, ImageDraw
    
    # Create 64x64 icon
    img = Image.new('RGBA', (64, 64), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    
    # Color mapping
    colors = {
        'green': (40, 167, 69),   # Success
        'yellow': (255, 193, 7),  # Warning
        'red': (220, 53, 69)      # Error
    }
    
    # Draw circle
    draw.ellipse([10, 10, 54, 54], fill=colors.get(color, (100, 100, 100)))
    
    # Draw lock symbol (simple representation)
    draw.rectangle([24, 28, 40, 44], fill='white')
    draw.rectangle([26, 22, 38, 28], outline='white', width=2)
    
    return img
```

**Checkpoint:** Test tray icon changes based on storage method

---

#### Step 2.3: Create Migration Script (1.5 hours)

**File:** `python-desktop-app/migrations/migrate_tokens.py`

```python
"""
Migrate tokens from plaintext to secure storage.

This script runs automatically on first launch after upgrade.
"""

import os
import json
import shutil
import logging
from datetime import datetime
from typing import Optional, Dict

logger = logging.getLogger(__name__)

class TokenMigration:
    """Handles migration from plaintext to secure storage"""
    
    LEGACY_TOKEN_FILE = 'brd_tracker_auth.json'
    BACKUP_SUFFIX = '.bak'
    MIGRATION_LOG = 'migration_log.json'
    
    def __init__(self, app_data_dir: str):
        self.app_data_dir = app_data_dir
        self.legacy_file = os.path.join(app_data_dir, self.LEGACY_TOKEN_FILE)
        self.backup_file = self.legacy_file + self.BACKUP_SUFFIX
        self.migration_log_file = os.path.join(app_data_dir, self.MIGRATION_LOG)
    
    def needs_migration(self) -> bool:
        """Check if migration is needed"""
        # Check if legacy file exists
        if not os.path.exists(self.legacy_file):
            return False
        
        # Check if already migrated
        if self._is_already_migrated():
            return False
        
        logger.info("[Migration] Legacy token file found, migration needed")
        return True
    
    def _is_already_migrated(self) -> bool:
        """Check if migration was already completed"""
        if os.path.exists(self.migration_log_file):
            try:
                with open(self.migration_log_file, 'r') as f:
                    log = json.load(f)
                    return log.get('migrated', False) is True
            except:
                return False
        return False
    
    def migrate(self, secure_storage) -> bool:
        """
        Migrate tokens from plaintext to secure storage.
        
        Args:
            secure_storage: SecureTokenStorage instance
        
        Returns:
            True if successful
        """
        try:
            logger.info("[Migration] Starting token migration...")
            
            # 1. Backup legacy file
            self._backup_legacy_file()
            
            # 2. Load tokens from legacy file
            tokens = self._load_legacy_tokens()
            if not tokens:
                logger.warning("[Migration] No tokens found in legacy file")
                self._log_migration('failed', 'No tokens found')
                return False
            
            # 3. Save to secure storage
            logger.info("[Migration] Saving tokens to secure storage...")
            success = secure_storage.save_tokens(tokens)
            
            if success:
                # 4. Verify tokens can be loaded
                logger.info("[Migration] Verifying migrated tokens...")
                loaded = secure_storage.load_tokens()
                
                if loaded and loaded.get('access_token') == tokens.get('access_token'):
                    # 5. Delete legacy file
                    self._delete_legacy_file()
                    
                    # 6. Log successful migration
                    self._log_migration('success', 'Tokens migrated to secure storage')
                    
                    logger.info("[Migration] ✅ Migration completed successfully")
                    return True
                else:
                    logger.error("[Migration] Verification failed")
                    self._log_migration('failed', 'Verification failed')
                    return False
            else:
                logger.error("[Migration] Failed to save to secure storage")
                self._log_migration('failed', 'Save to secure storage failed')
                return False
                
        except Exception as e:
            logger.error(f"[Migration] Migration failed: {e}")
            self._log_migration('failed', str(e))
            return False
    
    def _backup_legacy_file(self):
        """Create backup of legacy token file"""
        if os.path.exists(self.legacy_file):
            shutil.copy2(self.legacy_file, self.backup_file)
            logger.info(f"[Migration] Backup created: {self.backup_file}")
    
    def _load_legacy_tokens(self) -> Optional[Dict]:
        """Load tokens from legacy plaintext file"""
        try:
            with open(self.legacy_file, 'r') as f:
                tokens = json.load(f)
                logger.info("[Migration] Loaded tokens from legacy file")
                return tokens
        except Exception as e:
            logger.error(f"[Migration] Failed to load legacy tokens: {e}")
            return None
    
    def _delete_legacy_file(self):
        """Delete legacy plaintext token file"""
        try:
            if os.path.exists(self.legacy_file):
                os.remove(self.legacy_file)
                logger.info("[Migration] Legacy token file deleted")
        except Exception as e:
            logger.error(f"[Migration] Failed to delete legacy file: {e}")
    
    def _log_migration(self, status: str, message: str):
        """Log migration result"""
        migration_log = {
            'migrated': status == 'success',
            'status': status,
            'message': message,
            'timestamp': datetime.now().isoformat(),
            'backup_file': self.backup_file if os.path.exists(self.backup_file) else None
        }
        
        try:
            with open(self.migration_log_file, 'w') as f:
                json.dump(migration_log, f, indent=2)
        except Exception as e:
            logger.error(f"[Migration] Failed to write migration log: {e}")
    
    def cleanup_old_files(self, days_old: int = 30):
        """
        Clean up old backup files.
        
        Args:
            days_old: Delete backups older than this many days
        """
        if not os.path.exists(self.backup_file):
            return
        
        try:
            file_age = datetime.now() - datetime.fromtimestamp(
                os.path.getmtime(self.backup_file)
            )
            
            if file_age.days > days_old:
                os.remove(self.backup_file)
                logger.info(f"[Migration] Cleaned up old backup file (age: {file_age.days} days)")
        except Exception as e:
            logger.error(f"[Migration] Failed to cleanup backup: {e}")


def run_migration_if_needed(app_data_dir, secure_storage):
    """
    Run migration if needed (called on app startup).
    
    Args:
        app_data_dir: Application data directory
        secure_storage: SecureTokenStorage instance
    
    Returns:
        True if migration completed or not needed
    """
    migration = TokenMigration(app_data_dir)
    
    if migration.needs_migration():
        logger.info("[Migration] Starting automatic migration...")
        
        # Show user notification
        from tkinter import messagebox
        result = messagebox.askokcancel(
            "Security Upgrade",
            "TimeTracker is upgrading to more secure token storage.\n\n"
            "Your authentication tokens will be migrated from plaintext "
            "to secure storage. This is a one-time process.\n\n"
            "A backup will be created automatically.\n\n"
            "Continue?"
        )
        
        if not result:
            logger.warning("[Migration] User cancelled migration")
            return False
        
        success = migration.migrate(secure_storage)
        
        if success:
            messagebox.showinfo(
                "Migration Complete",
                "✅ Your tokens have been migrated to secure storage.\n\n"
                "A backup was created at:\n" + migration.backup_file
            )
        else:
            messagebox.showerror(
                "Migration Failed",
                "❌ Failed to migrate tokens to secure storage.\n\n"
                "Please check logs for details or contact support."
            )
        
        return success
    
    return True  # No migration needed
```

**Checkpoint:** Test migration with sample plaintext token file

---

#### Step 2.4: Update Application Startup (30 minutes)

**File:** `python-desktop-app/desktop_app.py` (main startup section)

```python
# In main() or __init__() of main app class

def main():
    """Application entry point"""
    try:
        # Initialize app data directory
        app_data_dir = get_app_data_dir()
        
        # Initialize secure storage
        logger.info("[App] Initializing secure token storage...")
        secure_storage = SecureTokenStorage(app_data_dir)
        
        # Run migration if needed
        from migrations.migrate_tokens import run_migration_if_needed
        migration_success = run_migration_if_needed(app_data_dir, secure_storage)
        
        if not migration_success:
            logger.error("[App] Migration failed, cannot continue")
            sys.exit(1)
        
        # Initialize auth manager with secure storage
        auth_manager = AuthManager()
        
        # Update system tray to show storage method
        storage_info = secure_storage.get_storage_info()
        system_tray.set_storage_indicator(storage_info['method'])
        
        # Continue with normal app initialization...
        logger.info("[App] Application started successfully")
        
    except SecurityError as e:
        logger.error(f"[App] Security initialization failed: {e}")
        messagebox.showerror(
            "Security Error",
            f"Failed to initialize secure storage:\n\n{e}\n\n"
            "The application cannot continue without secure token storage."
        )
        sys.exit(1)
```

**Checkpoint:** Test full application startup with migration

---

### Phase 3: Testing & Documentation (Day 3 - 4 hours)

#### Step 3.1: Unit Tests (3 hours)

**File:** `python-desktop-app/tests/test_secure_storage.py`

```python
"""
Unit tests for secure token storage.
"""

import unittest
import os
import tempfile
import shutil
import json
from unittest.mock import patch, MagicMock

# Import modules to test
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from auth.secure_storage import SecureTokenStorage, StorageMethod, SecurityError
from auth.consent_manager import ConsentManager
from migrations.migrate_tokens import TokenMigration


class TestSecureTokenStorage(unittest.TestCase):
    """Test SecureTokenStorage class"""
    
    def setUp(self):
        """Create temporary directory for tests"""
        self.test_dir = tempfile.mkdtemp()
        self.sample_tokens = {
            'access_token': 'test_access_token_12345',
            'refresh_token': 'test_refresh_token_67890',
            'expires_in': 3600
        }
    
    def tearDown(self):
        """Clean up temporary directory"""
        shutil.rmtree(self.test_dir, ignore_errors=True)
    
    @patch('auth.secure_storage.keyring')
    def test_keyring_detection_available(self, mock_keyring):
        """Test keyring detection when available"""
        # Mock keyring as available
        mock_keyring.set_password = MagicMock()
        mock_keyring.get_password = MagicMock(return_value='test_value')
        mock_keyring.delete_password = MagicMock()
        
        storage = SecureTokenStorage(self.test_dir)
        
        self.assertEqual(storage.storage_method, StorageMethod.KEYRING)
    
    @patch('auth.secure_storage.keyring')
    def test_keyring_detection_unavailable(self, mock_keyring):
        """Test keyring detection when unavailable"""
        # Mock keyring as unavailable
        mock_keyring.set_password = MagicMock(side_effect=Exception("Keyring error"))
        
        storage = SecureTokenStorage(self.test_dir)
        
        # Should fall back to encrypted storage
        self.assertIn(storage.storage_method, [StorageMethod.ENCRYPTED, StorageMethod.UNAVAILABLE])
    
    @patch('auth.secure_storage.keyring')
    def test_save_load_tokens_keyring(self, mock_keyring):
        """Test save/load with keyring"""
        # Mock keyring
        stored_data = {}
        
        def mock_set(service, key, value):
            stored_data[f"{service}:{key}"] = value
        
        def mock_get(service, key):
            return stored_data.get(f"{service}:{key}")
        
        mock_keyring.set_password = mock_set
        mock_keyring.get_password = mock_get
        mock_keyring.delete_password = MagicMock()
        
        storage = SecureTokenStorage(self.test_dir)
        storage.storage_method = StorageMethod.KEYRING  # Force keyring mode
        
        # Save tokens
        success = storage.save_tokens(self.sample_tokens)
        self.assertTrue(success)
        
        # Load tokens
        loaded = storage.load_tokens()
        self.assertEqual(loaded['access_token'], self.sample_tokens['access_token'])
    
    def test_save_load_tokens_encrypted(self):
        """Test save/load with encrypted file"""
        storage = SecureTokenStorage(self.test_dir)
        storage.storage_method = StorageMethod.ENCRYPTED  # Force encrypted mode
        
        # Mock consent
        consent_mgr = ConsentManager(self.test_dir)
        consent_mgr.record_consent(consented=True)
        
        # Save tokens
        with patch('auth.secure_storage.ConsentManager') as mock_consent_class:
            mock_consent = MagicMock()
            mock_consent.has_consent.return_value = True
            mock_consent_class.return_value = mock_consent
            
            success = storage._save_encrypted(self.sample_tokens)
            self.assertTrue(success)
        
        # Verify encrypted file exists
        encrypted_file = os.path.join(self.test_dir, 'auth_encrypted.enc')
        self.assertTrue(os.path.exists(encrypted_file))
        
        # Verify file is not plaintext
        with open(encrypted_file, 'rb') as f:
            content = f.read()
            self.assertNotIn(b'test_access_token', content)  # Should be encrypted
        
        # Load tokens
        loaded = storage._load_encrypted()
        self.assertEqual(loaded['access_token'], self.sample_tokens['access_token'])
    
    def test_encryption_machine_specific(self):
        """Test that encryption key is machine-specific"""
        storage1 = SecureTokenStorage(self.test_dir)
        key1 = storage1._get_machine_key()
        
        storage2 = SecureTokenStorage(self.test_dir)
        key2 = storage2._get_machine_key()
        
        # Same machine should produce same key
        self.assertEqual(key1, key2)
    
    def test_delete_tokens(self):
        """Test token deletion"""
        storage = SecureTokenStorage(self.test_dir)
        storage.storage_method = StorageMethod.ENCRYPTED
        
        # Save tokens
        consent_mgr = ConsentManager(self.test_dir)
        consent_mgr.record_consent(consented=True)
        
        with patch('auth.secure_storage.ConsentManager') as mock_consent_class:
            mock_consent = MagicMock()
            mock_consent.has_consent.return_value = True
            mock_consent_class.return_value = mock_consent
            
            storage._save_encrypted(self.sample_tokens)
        
        # Delete tokens
        storage.delete_tokens()
        
        # Verify file is deleted
        encrypted_file = os.path.join(self.test_dir, 'auth_encrypted.enc')
        self.assertFalse(os.path.exists(encrypted_file))
    
    def test_storage_info(self):
        """Test get_storage_info()"""
        storage = SecureTokenStorage(self.test_dir)
        info = storage.get_storage_info()
        
        self.assertIn('method', info)
        self.assertIn('is_secure', info)
        self.assertIn('location', info)
        self.assertIn('encryption_enabled', info)


class TestConsentManager(unittest.TestCase):
    """Test ConsentManager class"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
    
    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
    
    def test_consent_recording(self):
        """Test consent can be recorded"""
        consent_mgr = ConsentManager(self.test_dir)
        
        # Initially no consent
        self.assertFalse(consent_mgr.has_consent())
        
        # Record consent
        consent_mgr.record_consent(consented=True, user_id='test_user')
        
        # Now has consent
        self.assertTrue(consent_mgr.has_consent())
        
        # Consent info is retrievable
        info = consent_mgr.get_consent_info()
        self.assertEqual(info['consented'], True)
        self.assertEqual(info['user_id'], 'test_user')
    
    def test_consent_persistence(self):
        """Test consent persists across instances"""
        # Record consent
        consent_mgr1 = ConsentManager(self.test_dir)
        consent_mgr1.record_consent(consented=True)
        
        # Create new instance
        consent_mgr2 = ConsentManager(self.test_dir)
        
        # Consent should still be recorded
        self.assertTrue(consent_mgr2.has_consent())
    
    def test_consent_version_mismatch(self):
        """Test consent is invalid if version changed"""
        consent_mgr = ConsentManager(self.test_dir)
        consent_mgr.record_consent(consented=True)
        
        # Change consent version
        consent_mgr.CONSENT_VERSION = '2.0'
        
        # Consent should be invalid
        self.assertFalse(consent_mgr.has_consent())


class TestTokenMigration(unittest.TestCase):
    """Test token migration"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.legacy_file = os.path.join(self.test_dir, 'brd_tracker_auth.json')
        self.sample_tokens = {
            'access_token': 'legacy_access_token',
            'refresh_token': 'legacy_refresh_token'
        }
    
    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
    
    def test_migration_detection(self):
        """Test migration is detected when needed"""
        # Create legacy file
        with open(self.legacy_file, 'w') as f:
            json.dump(self.sample_tokens, f)
        
        migration = TokenMigration(self.test_dir)
        
        # Should need migration
        self.assertTrue(migration.needs_migration())
    
    def test_migration_execution(self):
        """Test migration migrates tokens"""
        # Create legacy file
        with open(self.legacy_file, 'w') as f:
            json.dump(self.sample_tokens, f)
        
        # Create secure storage
        storage = SecureTokenStorage(self.test_dir)
        storage.storage_method = StorageMethod.ENCRYPTED
        
        # Mock consent
        with patch('auth.secure_storage.ConsentManager') as mock_consent_class:
            mock_consent = MagicMock()
            mock_consent.has_consent.return_value = True
            mock_consent_class.return_value = mock_consent
            
            # Run migration
            migration = TokenMigration(self.test_dir)
            success = migration.migrate(storage)
            
            self.assertTrue(success)
        
        # Legacy file should be deleted
        self.assertFalse(os.path.exists(self.legacy_file))
        
        # Backup should exist
        backup_file = self.legacy_file + '.bak'
        self.assertTrue(os.path.exists(backup_file))
        
        # Tokens should be in secure storage
        loaded = storage.load_tokens()
        self.assertEqual(loaded['access_token'], self.sample_tokens['access_token'])


if __name__ == '__main__':
    unittest.main()
```

**Run tests:**
```bash
cd python-desktop-app
python -m pytest tests/test_secure_storage.py -v
```

**Checkpoint:** All tests passing

---

#### Step 3.2: Documentation (1 hour)

**File:** `python-desktop-app/docs/SECURE_STORAGE.md`

```markdown
# Secure Token Storage Documentation

## Overview

TimeTracker uses a three-tier security hierarchy for storing OAuth tokens:

1. **Primary:** Windows Credential Manager (keyring) - Most Secure
2. **Fallback:** Encrypted file storage - Acceptable Security
3. **Fail:** Cannot operate - No insecure fallback

## Storage Methods

### Windows Credential Manager (Preferred)

**Security Level:** ⭐⭐⭐⭐⭐ Highest

Tokens are stored in the Windows Credential Manager using the `keyring` library.

**Advantages:**
- OS-level encryption
- Hardware-backed on modern Windows
- Integrated with Windows security
- Cannot be copied to another machine

**Requirements:**
- Windows Credential Manager service must be running
- User must have permission to access credential store

**Setup:**
1. Press Win+R
2. Type `services.msc`
3. Find "Credential Manager" service
4. Ensure it's running and set to "Automatic"

### Encrypted File Storage (Fallback)

**Security Level:** ⭐⭐⭐ Acceptable

When keyring is unavailable, tokens are encrypted and stored in a file.

**Advantages:**
- Works on systems where keyring is disabled
- Better than plaintext
- Machine and user-specific encryption

**Security Properties:**
- AES-128 encryption via Fernet
- Key derived from machine GUID + username
- Cannot be copied to another machine/user

**Location:** `%LOCALAPPDATA%\TimeTracker\auth_encrypted.enc`

**User Consent Required:** Yes, with security warning dialog

### Security Comparison

| Aspect | Keyring | Encrypted File | Plaintext (OLD) |
|--------|---------|----------------|-----------------|
| Encryption | OS-level | AES-128 | None ❌ |
| Machine Binding | Yes | Yes | No ❌ |
| User Binding | Yes | Yes | No ❌ |
| Requires Consent | No | Yes | N/A |
| Security Rating | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ❌ |

## For IT Administrators

### Recommended Configuration

**Best Practice:** Enable Windows Credential Manager for all users

**Steps:**
1. Deploy Group Policy to ensure Credential Manager service is running
2. Set service startup to "Automatic"
3. Verify users have access to credential storage

### If Credential Manager Cannot Be Enabled

The application will fall back to encrypted file storage with user consent.

**Monitor:**
- Check application logs for storage method usage
- Look for `[SecureStorage]` log entries
- Dashboard shows distribution of storage methods used

### Audit Trail

All token storage operations are logged:
```
[SecureStorage] Initialized with method: keyring
[Auth] Using storage method: keyring at Windows Credential Manager
[METRIC] token_storage: keyring
```

## For Developers

### Usage Example

```python
from auth.secure_storage import SecureTokenStorage

# Initialize
storage = SecureTokenStorage(app_data_dir='/path/to/data')

# Save tokens
tokens = {
    'access_token': 'eyJhbGc...',
    'refresh_token': 'def502...',
    'expires_in': 3600
}
success = storage.save_tokens(tokens)

# Load tokens
tokens = storage.load_tokens()

# Delete tokens (logout)
storage.delete_tokens()

# Get storage info
info = storage.get_storage_info()
# Returns: {'method': 'keyring', 'is_secure': True, ...}
```

### Migration

Existing users with plaintext tokens will be automatically migrated on first launch.

**Migration Process:**
1. Backup plaintext file (`brd_tracker_auth.json.bak`)
2. Load tokens from plaintext
3. Save to secure storage
4. Verify migration
5. Delete plaintext file
6. Log migration result

**Manual Migration:**
```python
from migrations.migrate_tokens import run_migration_if_needed

success = run_migration_if_needed(app_data_dir, secure_storage)
```

## Troubleshooting

### "Secure storage not available" error

**Cause:** Neither keyring nor encryption is available

**Solutions:**
1. Enable Windows Credential Manager service
2. Ensure user has permission to access credential storage
3. Contact IT administrator if running in restricted environment

### "User declined encrypted storage" error

**Cause:** User clicked "Exit" on security consent dialog

**Solution:** Re-launch application and accept security warning

### Migration failed

**Cause:** Various migration issues

**Recovery:**
1. Check `migration_log.json` for details
2. Backup file exists at `brd_tracker_auth.json.bak`
3. Contact support with log files

## Security Best Practices

### For Users
- ✅ Use Windows Credential Manager when possible
- ✅ Keep system and application updated
- ✅ Use device encryption (BitLocker)
- ⚠️ Be aware when using encrypted fallback mode

### For Administrators
- ✅ Enable Credential Manager for all users via GPO
- ✅ Monitor storage method distribution
- ✅ Review security logs regularly
- ✅ Enforce device encryption policies

## FAQ

**Q: Are my tokens safe?**
A: Yes. Tokens are encrypted using industry-standard methods. Keyring is most secure, encrypted file is acceptable.

**Q: Can someone steal my tokens from this computer?**
A: With keyring: Very difficult (OS-level protection)
With encrypted file: Requires both physical access AND your user account

**Q: What if I lose my tokens?**
A: Simply log out and log in again to get new tokens.

**Q: Can I use the app on a locked-down corporate machine?**
A: If Credential Manager is accessible: Yes
If not: You'll be prompted to use encrypted storage (requires consent)
If encryption also fails: Application cannot operate securely

**Q: Where exactly are tokens stored?**
A: Keyring: Windows Credential Manager (system secure storage)
Encrypted: `%LOCALAPPDATA%\TimeTracker\auth_encrypted.enc`

## References

- [Windows Credential Manager Documentation](https://docs.microsoft.com/en-us/windows/security/identity-protection/credential-guard/)
- [Python Keyring Library](https://github.com/jaraco/keyring)
- [Cryptography (Fernet)](https://cryptography.io/en/latest/fernet/)
```

---

## 6. Testing Strategy

### 6.1 Unit Testing

**Coverage Target:** 90%+

| Module | Test File | Tests | Status |
|--------|-----------|-------|--------|
| SecureTokenStorage | test_secure_storage.py | 15 | ✅ |
| ConsentManager | test_secure_storage.py | 5 | ✅ |
| TokenMigration | test_secure_storage.py | 4 | ✅ |
| SecurityDialog | test_security_dialog.py | 3 | Pending |

### 6.2 Integration Testing

**Test Scenarios:**

1. **New Installation**
   - Install app on clean system
   - Login with OAuth
   - Verify tokens saved to keyring
   - Restart app
   - Verify tokens loaded correctly

2. **Keyring Unavailable**
   - Disable Credential Manager service
   - Login with OAuth
   - Verify security warning shown
   - Accept encrypted storage
   - Verify tokens saved encrypted
   - Restart app
   - Verify tokens loaded correctly

3. **Migration from Old Version**
   - Create plaintext token file
   - Launch new version
   - Verify migration dialog shown
   - Accept migration
   - Verify tokens migrated
   - Verify plaintext file deleted
   - Verify backup created

4. **User Declines Encrypted Storage**
   - Disable Credential Manager
   - Login with OAuth
   - Decline security warning
   - Verify app exits gracefully

### 6.3 Manual Testing Checklist

- [ ] Install on Windows 10 with Credential Manager enabled
- [ ] Install on Windows 10 with Credential Manager disabled
- [ ] Install on Windows 11
- [ ] Test OAuth flow with keyring storage
- [ ] Test OAuth flow with encrypted storage
- [ ] Test migration from plaintext tokens
- [ ] Test logout (tokens deleted)
- [ ] Test system tray icon changes
- [ ] Test security warning dialog
- [ ] Test app restart after each storage method
- [ ] Test on corporate machine (restricted environment)
- [ ] Test on VM/VDI environment
- [ ] Verify logs show correct storage method
- [ ] Verify backup file created during migration
- [ ] Verify encrypted file cannot be read as plaintext

### 6.4 Performance Testing

**Metrics to measure:**
- Token save time (should be < 100ms)
- Token load time (should be < 50ms)
- Migration time (should be < 2 seconds)
- Encryption/decryption overhead

**Benchmark:**
```python
import time

# Test save performance
start = time.time()
storage.save_tokens(tokens)
save_time = time.time() - start
print(f"Save time: {save_time*1000:.2f}ms")

# Test load performance
start = time.time()
tokens = storage.load_tokens()
load_time = time.time() - start
print(f"Load time: {load_time*1000:.2f}ms")
```

### 6.5 Security Testing

**Penetration Testing Scenarios:**

1. **File System Access**
   - Attempt to read encrypted token file
   - Attempt to copy encrypted file to another machine
   - Attempt to decrypt without machine key

2. **Process Memory**
   - Dump process memory and search for plaintext tokens
   - Verify tokens are not left in memory after deletion

3. **Backup Files**
   - Verify plaintext backup is securely deleted after migration
   - Test backup file restoration

**Expected Results:**
- ✅ Encrypted files unreadable without machine key
- ✅ Tokens cannot be copied to other machines
- ✅ Process memory does not contain plaintext tokens
- ✅ Backup files properly secured

---

## 7. Migration Plan

### 7.1 Pre-Migration

**Before Deployment:**

1. **Backup Current Token Files**
   ```powershell
   # IT Administrator script
   $users = Get-ChildItem "C:\Users"
   foreach ($user in $users) {
       $tokenFile = "C:\Users\$($user.Name)\AppData\Local\TimeTracker\brd_tracker_auth.json"
       if (Test-Path $tokenFile) {
           Copy-Item $tokenFile "$tokenFile.backup-$(Get-Date -Format 'yyyyMMdd')"
       }
   }
   ```

2. **Verify Credential Manager Status**
   ```powershell
   # Check if service is running
   Get-Service | Where-Object {$_.Name -eq "VaultSvc"}
   
   # Enable if needed
   Set-Service -Name "VaultSvc" -StartupType Automatic
   Start-Service -Name "VaultSvc"
   ```

3. **Notify Users**
   - Email announcement 1 week before
   - In-app notification 3 days before
   - What to expect (one-time migration dialog)

### 7.2 Migration Execution

**Timeline:**

| Day | Activity | Owner |
|-----|----------|-------|
| D-7 | Deploy to test environment | DevOps |
| D-5 | User acceptance testing | QA Team |
| D-3 | Send user notification | Product Team |
| D-1 | Final testing | QA Team |
| D-Day | Deploy to production | DevOps |
| D+1 | Monitor migration metrics | Dev Team |
| D+7 | Review and cleanup | Dev Team |

**Deployment Process:**

1. **Deploy New Version**
   ```bash
   # Gradual rollout recommended
   # Day 1: 10% of users
   # Day 2: 25% of users
   # Day 3: 50% of users
   # Day 4: 100% of users
   ```

2. **Monitor Migration Success**
   - Check application logs for migration status
   - Dashboard metrics show storage method distribution
   - Alert if migration failure rate > 5%

3. **User Support**
   - Help desk briefed on migration process
   - FAQ published
   - Support tickets monitored

### 7.3 Post-Migration

**Verification (D+1 to D+7):**

1. **Check Migration Metrics**
   ```sql
   -- Example analytics query
   SELECT 
       storage_method,
       COUNT(*) as user_count,
       (COUNT(*) * 100.0 / SUM(COUNT(*)) OVER()) as percentage
   FROM user_security_logs
   WHERE event_type = 'token_storage'
   GROUP BY storage_method
   ```

   **Expected Distribution:**
   - Keyring: 85-90%
   - Encrypted: 5-10%
   - Failed: < 1%

2. **Review Support Tickets**
   - Common issues
   - User feedback
   - Failure patterns

3. **Cleanup Old Backups**
   ```python
   # After 30 days, remove backup files
   migration.cleanup_old_files(days_old=30)
   ```

### 7.4 Rollback Plan

**If Critical Issues Found:**

1. **Immediate Rollback (< 24 hours)**
   ```bash
   # Deploy previous version
   # Restore plaintext token files from backup
   # User sessions preserved
   ```

2. **Selective Rollback (24-72 hours)**
   ```bash
   # Rollback only affected users
   # Keep successful migrations
   # Retry failed migrations
   ```

3. **Communication**
   - Notify users of rollback
   - Explain issue and timeline
   - Provide alternative (manual re-login)

---

## 8. Deployment Strategy

### 8.1 Deployment Checklist

**Pre-Deployment:**
- [ ] All tests passing (unit, integration, manual)
- [ ] Code reviewed and approved
- [ ] Security audit completed
- [ ] Documentation updated
- [ ] User notification sent
- [ ] Help desk briefed
- [ ] Rollback plan validated

**Deployment:**
- [ ] Deploy to test environment
- [ ] Run smoke tests
- [ ] Deploy to 10% of users (canary)
- [ ] Monitor for 24 hours
- [ ] Deploy to remaining users (gradual rollout)
- [ ] Monitor migration metrics
- [ ] Review support tickets

**Post-Deployment:**
- [ ] Verify migration success rate > 95%
- [ ] Review security logs
- [ ] Collect user feedback
- [ ] Update documentation based on feedback
- [ ] Schedule cleanup of old backup files (30 days)

### 8.2 Gradual Rollout Strategy

**Phase 1: Canary (Day 1) - 10% of users**
- Deploy to tech-savvy users first
- Closely monitor for issues
- Quick rollback if needed

**Phase 2: Early Adopters (Day 2) - 25% of users**
- Expand to more users
- Validate migration process at scale
- Gather initial feedback

**Phase 3: Majority (Day 3) - 50% of users**
- Deploy to half of user base
- Monitor help desk load
- Address common issues

**Phase 4: Full Rollout (Day 4) - 100% of users**
- Complete deployment
- Full monitoring
- Support team ready

### 8.3 Monitoring & Alerting

**Key Metrics to Monitor:**

| Metric | Alert Threshold | Action |
|--------|----------------|--------|
| Migration failure rate | > 5% | Investigate immediately |
| Keyring detection rate | < 80% | Check environment issues |
| Support ticket volume | > 2x normal | Scale support team |
| App crash rate | > 1% | Rollback consideration |
| Login success rate | < 95% | Check auth flow |

**Monitoring Dashboard:**
```
┌─────────────────────────────────────────────────────────┐
│         Secure Storage Migration Dashboard              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Total Users Migrated:  1,247 / 1,500  (83%)           │
│  Migration Success:     1,235 / 1,247  (99%)           │
│                                                          │
│  Storage Distribution:                                   │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  Keyring:    1,089 (87%)          │
│  ▓▓▓                   Encrypted:   146 (12%)          │
│  ▓                     Failed:       12 (1%)           │
│                                                          │
│  Recent Issues: 3                                        │
│  Support Tickets: 5 (Normal)                            │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 9. Rollback Plan

### 9.1 Rollback Triggers

**When to rollback:**
- Migration failure rate > 10%
- Critical security vulnerability discovered
- App crash rate > 2%
- Login success rate < 90%
- Data loss reported

### 9.2 Rollback Procedure

**Emergency Rollback (< 1 hour):**

1. **Revert to Previous Version**
   ```bash
   # Deploy previous stable version
   git checkout v1.x.x
   python setup.py install
   ```

2. **Restore Token Files**
   ```powershell
   # Restore from backup
   foreach ($user in $users) {
       $backupFile = "C:\Users\$($user.Name)\AppData\Local\TimeTracker\brd_tracker_auth.json.backup"
       $targetFile = "C:\Users\$($user.Name)\AppData\Local\TimeTracker\brd_tracker_auth.json"
       if (Test-Path $backupFile) {
           Copy-Item $backupFile $targetFile -Force
       }
   }
   ```

3. **Notify Users**
   - In-app notification
   - Email to affected users
   - Status page update

**Partial Rollback (Selective):**

If only specific users affected:
- Identify affected users from logs
- Rollback only those users
- Keep successful migrations
- Investigate root cause

### 9.3 Post-Rollback Analysis

1. **Root Cause Analysis**
   - Review logs from failed migrations
   - Identify common patterns
   - Document issues

2. **Fix and Re-deploy**
   - Address identified issues
   - Additional testing
   - Gradual re-deployment

---

## 10. Success Metrics

### 10.1 Technical Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Migration success rate | > 95% | Logs analysis |
| Keyring adoption | > 85% | Storage method distribution |
| Token save time | < 100ms | Performance logs |
| Token load time | < 50ms | Performance logs |
| Zero plaintext tokens | 100% | Security audit |
| Test coverage | > 90% | Coverage report |

### 10.2 User Experience Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| User complaints | < 2% of users | Support tickets |
| Login success rate | > 98% | Analytics |
| Migration time | < 5 seconds | Timer logs |
| Help doc visits | Monitor trend | Analytics |
| User satisfaction | > 4/5 | Survey |

### 10.3 Security Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Plaintext token files | 0 | File scan |
| Encryption strength | AES-128 minimum | Code review |
| Vulnerability findings | 0 critical | Security scan |
| Compliance violations | 0 | Audit |
| Penetration test pass | 100% | Pen test report |

### 10.4 Business Metrics

| Metric | Impact |
|--------|--------|
| Reduced security risk | CVSS 7.8 → 2.5 (69% reduction) |
| Compliance achievement | GDPR Article 32 ✅ |
| Production readiness | Security audit passed |
| Customer trust | Enhanced security posture |

---

## 11. Timeline Summary

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| **Phase 1: Foundation** | 4 hours | Core modules created |
| **Phase 2: Integration** | 5 hours | App integrated with secure storage |
| **Phase 3: Testing** | 4 hours | Tests passing, docs complete |
| **Phase 4: Deployment** | 1 hour | Deployed to production |
| **Total** | **14 hours** | Production-ready secure storage |

**Calendar Timeline:**
- Day 1: Development (Phases 1-2)
- Day 2: Development (Phase 2 completion)
- Day 3: Testing & Documentation (Phase 3)
- Day 4: Deployment preparation
- Day 5-8: Gradual rollout
- Day 9-15: Monitoring & support
- Day 30: Cleanup & retrospective

---

## 12. Appendix

### A. File Structure

```
python-desktop-app/
├── auth/
│   ├── __init__.py                 # NEW
│   ├── secure_storage.py           # NEW (350 lines)
│   └── consent_manager.py          # NEW (150 lines)
├── ui/
│   └── security_dialog.py          # NEW (200 lines)
├── migrations/
│   └── migrate_tokens.py           # NEW (100 lines)
├── tests/
│   ├── test_secure_storage.py      # NEW (400 lines)
│   └── test_security_dialog.py     # NEW
├── docs/
│   └── SECURE_STORAGE.md           # NEW
├── desktop_app.py                  # MODIFIED (~50 lines changed)
├── system_tray.py                  # MODIFIED (~30 lines added)
├── requirements.txt                # MODIFIED (2 dependencies)
└── config.py                       # MODIFIED (config constants)
```

### B. Dependencies

**New Dependencies:**
```txt
keyring>=24.0.0
cryptography>=41.0.0
```

**Existing Dependencies:**
(no changes)

### C. Configuration

**New Environment Variables:**
```bash
# Optional overrides (defaults work for most cases)
SECURE_STORAGE_ENABLED=true
REQUIRE_KEYRING=false
ENCRYPTION_ALGORITHM=fernet
CONSENT_REQUIRED=true
LOG_STORAGE_METHOD=true
```

### D. References

- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [Windows Credential Manager API](https://docs.microsoft.com/en-us/windows/win32/secauthn/credential-manager)
- [Python Keyring Documentation](https://keyring.readthedocs.io/)
- [Fernet Encryption Specification](https://github.com/fernet/spec/)
- [GDPR Article 32 - Security of Processing](https://gdpr-info.eu/art-32-gdpr/)

---

**Document Version:** 1.0  
**Last Updated:** April 6, 2026  
**Author:** Development Team  
**Status:** Ready for Implementation

---

## Next Steps

1. ✅ Review this implementation plan
2. ⏳ Get stakeholder approval
3. ⏳ Create Jira tickets from this plan
4. ⏳ Assign developers
5. ⏳ Begin Phase 1 development

**Ready to proceed? Let's build secure token storage! 🔒**
