"""
Privacy Configuration Management

Centralized configuration for privacy filtering that can be loaded
from environment variables or programmatically configured.
"""
import os
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum

logger = logging.getLogger(__name__)


class RedactionStrategy(str, Enum):
    """Available redaction strategies"""
    MASK = 'mask'              # Replace with asterisks: ********
    ENTITY_TYPE = 'entity_type'  # Replace with type: [PASSWORD]
    HASH = 'hash'              # Replace with hash: a1b2c3d4
    REMOVE = 'remove'          # Remove entirely


@dataclass
class PrivacyConfig:
    """
    Privacy filtering configuration.
    
    Attributes:
        enabled: Master toggle for privacy filtering
        min_confidence: Minimum confidence threshold to trigger redaction (0.0-1.0)
        detect_pii: Enable PII detection via Presidio
        detect_secrets: Enable secrets detection via detect-secrets
        detect_custom_patterns: Enable custom regex pattern detection
        pii_types: List of PII entity types to detect
        redaction_strategy: How to redact detected sensitive data
        mask_char: Character used for masking
        mask_length: Fixed length for masked output (0 = variable based on original)
        enable_audit_log: Log redaction events for debugging
        skip_short_text: Skip filtering for text shorter than this
        max_text_length: Truncate input text longer than this for performance
    """
    
    # Master toggle
    enabled: bool = True
    
    # Detection settings
    min_confidence: float = 0.7
    detect_pii: bool = True            # Presidio PII detection - ENABLED for structured data
    detect_secrets: bool = False       # detect-secrets library - disabled (too many false positives)
    detect_custom_patterns: bool = True  # Custom patterns (passwords, API keys) - always on
    
    # PII types to detect (Presidio entity names)
    # Only high-precision entity types enabled to minimize false positives
    pii_types: List[str] = field(default_factory=lambda: [
        # Financial & Identity (High precision - Presidio)
        'CREDIT_CARD',          # Credit card numbers with Luhn validation
        'PHONE_NUMBER',         # Phone numbers in international formats
        'IP_ADDRESS',           # IPv4 and IPv6 addresses
        'US_BANK_NUMBER',       # US bank account numbers
        'US_DRIVER_LICENSE',    # US driver's license numbers
        'US_PASSPORT',          # US passport numbers
        'IBAN_CODE',            # International Bank Account Numbers
        'CRYPTO',               # Cryptocurrency wallet addresses
        'NRP',                  # National Registration Numbers
        'MEDICAL_LICENSE',      # Medical license numbers
        # Custom types added by our recognizers (in custom_patterns.py)
        'PASSWORD',
        'API_KEY',
        'PRIVATE_KEY',
        'CONNECTION_STRING',
        'BEARER_TOKEN',
        'OAUTH_SECRET',
        'INTERNAL_IP',
        'DATABASE_PASSWORD',
        'ENCRYPTION_KEY',
    ])
    
    # Redaction settings
    redaction_strategy: RedactionStrategy = RedactionStrategy.MASK
    mask_char: str = '*'
    mask_length: int = 8  # 0 = use original length
    
    # Audit settings
    enable_audit_log: bool = False
    audit_log_path: str = 'privacy_audit.log'
    
    # Performance settings
    skip_short_text: int = 10      # Skip if text < N chars
    max_text_length: int = 50000   # Truncate before processing
    
    # Graceful degradation
    fail_open: bool = False  # If True, return original text on filter errors
    
    @classmethod
    def from_env(cls) -> 'PrivacyConfig':
        """
        Load configuration from environment variables.
        
        Environment Variables:
            PRIVACY_FILTER_ENABLED: true/false (default: true)
            PRIVACY_MIN_CONFIDENCE: 0.0-1.0 (default: 0.7)
            PRIVACY_DETECT_PII: true/false (default: true) - Presidio PII detection
            PRIVACY_DETECT_SECRETS: true/false (default: false) - detect-secrets library
            PRIVACY_DETECT_CUSTOM_PATTERNS: true/false (default: true) - passwords/API keys
            PRIVACY_REDACTION_STRATEGY: mask/entity_type/hash/remove (default: mask)
            PRIVACY_MASK_CHAR: single character (default: *)
            PRIVACY_MASK_LENGTH: integer (default: 8)
            PRIVACY_ENABLE_AUDIT_LOG: true/false (default: false)
            PRIVACY_SKIP_SHORT_TEXT: integer (default: 10)
            PRIVACY_MAX_TEXT_LENGTH: integer (default: 50000)
            PRIVACY_FAIL_OPEN: true/false (default: false)
            PRIVACY_PII_TYPES: comma-separated list (optional, overrides defaults)
        """
        config = cls()
        
        # Master toggle
        config.enabled = os.getenv('PRIVACY_FILTER_ENABLED', 'true').lower() == 'true'
        
        # Detection settings
        config.min_confidence = float(os.getenv('PRIVACY_MIN_CONFIDENCE', '0.7'))
        config.detect_pii = os.getenv('PRIVACY_DETECT_PII', 'true').lower() == 'true'
        config.detect_secrets = os.getenv('PRIVACY_DETECT_SECRETS', 'false').lower() == 'true'
        config.detect_custom_patterns = os.getenv('PRIVACY_DETECT_CUSTOM_PATTERNS', 'true').lower() == 'true'
        
        # PII types (optional override)
        pii_types_env = os.getenv('PRIVACY_PII_TYPES')
        if pii_types_env:
            config.pii_types = [t.strip().upper() for t in pii_types_env.split(',') if t.strip()]
        
        # Redaction settings
        strategy_str = os.getenv('PRIVACY_REDACTION_STRATEGY', 'mask').lower()
        try:
            config.redaction_strategy = RedactionStrategy(strategy_str)
        except ValueError:
            logger.warning(f"Invalid redaction strategy '{strategy_str}', using 'mask'")
            config.redaction_strategy = RedactionStrategy.MASK
        
        config.mask_char = os.getenv('PRIVACY_MASK_CHAR', '*')[:1] or '*'
        config.mask_length = int(os.getenv('PRIVACY_MASK_LENGTH', '8'))
        
        # Audit settings
        config.enable_audit_log = os.getenv('PRIVACY_ENABLE_AUDIT_LOG', 'false').lower() == 'true'
        config.audit_log_path = os.getenv('PRIVACY_AUDIT_LOG_PATH', 'privacy_audit.log')
        
        # Performance settings
        config.skip_short_text = int(os.getenv('PRIVACY_SKIP_SHORT_TEXT', '10'))
        config.max_text_length = int(os.getenv('PRIVACY_MAX_TEXT_LENGTH', '50000'))
        
        # Graceful degradation
        config.fail_open = os.getenv('PRIVACY_FAIL_OPEN', 'false').lower() == 'true'
        
        logger.debug(f"Privacy config loaded: enabled={config.enabled}, "
                    f"min_confidence={config.min_confidence}, "
                    f"strategy={config.redaction_strategy.value}")
        
        return config
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'PrivacyConfig':
        """Load configuration from dictionary (e.g., from server config)."""
        config = cls()
        
        config.enabled = data.get('enabled', True)
        config.min_confidence = data.get('min_confidence', 0.7)
        config.detect_pii = data.get('detect_pii', True)
        config.detect_secrets = data.get('detect_secrets', True)
        config.detect_custom_patterns = data.get('detect_custom_patterns', True)
        
        if 'pii_types' in data:
            config.pii_types = data['pii_types']
        
        strategy_str = data.get('redaction_strategy', 'mask')
        try:
            config.redaction_strategy = RedactionStrategy(strategy_str)
        except ValueError:
            config.redaction_strategy = RedactionStrategy.MASK
        
        config.mask_char = data.get('mask_char', '*')
        config.mask_length = data.get('mask_length', 8)
        config.enable_audit_log = data.get('enable_audit_log', False)
        config.skip_short_text = data.get('skip_short_text', 10)
        config.max_text_length = data.get('max_text_length', 50000)
        config.fail_open = data.get('fail_open', False)
        
        return config
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert configuration to dictionary for serialization."""
        return {
            'enabled': self.enabled,
            'min_confidence': self.min_confidence,
            'detect_pii': self.detect_pii,
            'detect_secrets': self.detect_secrets,
            'detect_custom_patterns': self.detect_custom_patterns,
            'pii_types': self.pii_types,
            'redaction_strategy': self.redaction_strategy.value,
            'mask_char': self.mask_char,
            'mask_length': self.mask_length,
            'enable_audit_log': self.enable_audit_log,
            'audit_log_path': self.audit_log_path,
            'skip_short_text': self.skip_short_text,
            'max_text_length': self.max_text_length,
            'fail_open': self.fail_open,
        }
    
    def validate(self) -> List[str]:
        """
        Validate configuration and return list of warnings/errors.
        
        Returns:
            List of validation messages (empty if valid)
        """
        issues = []
        
        if self.min_confidence < 0 or self.min_confidence > 1:
            issues.append(f"min_confidence must be 0.0-1.0, got {self.min_confidence}")
        
        if self.mask_length < 0:
            issues.append(f"mask_length must be >= 0, got {self.mask_length}")
        
        if not self.mask_char:
            issues.append("mask_char cannot be empty")
        
        if self.skip_short_text < 0:
            issues.append(f"skip_short_text must be >= 0, got {self.skip_short_text}")
        
        if self.max_text_length < 100:
            issues.append(f"max_text_length should be >= 100, got {self.max_text_length}")
        
        if not self.detect_pii and not self.detect_secrets and not self.detect_custom_patterns:
            issues.append("All detection methods are disabled - filter will have no effect")
        
        return issues
