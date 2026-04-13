"""
Privacy Module for JIRAForge Desktop App

Provides sensitive data detection and redaction for OCR-extracted text.
Protects user privacy by filtering passwords, API keys, PII, and other secrets.

Configure via environment variables:
    PRIVACY_FILTER_ENABLED=true
    PRIVACY_MIN_CONFIDENCE=0.7
    PRIVACY_DETECT_PII=true
    PRIVACY_DETECT_SECRETS=true
    PRIVACY_REDACTION_STRATEGY=mask

Usage (Simple):
    from privacy import PrivacyFilter
    
    filter = PrivacyFilter()
    result = filter.redact(ocr_text)
    clean_text = result['text']

Usage (Advanced):
    from privacy import PrivacyFilter, PrivacyConfig
    
    config = PrivacyConfig()
    config.min_confidence = 0.8
    config.redaction_strategy = 'entity_type'
    
    filter = PrivacyFilter(config)
    result = filter.redact(ocr_text)
"""

__version__ = '1.0.0'

# Main API
from .filter import PrivacyFilter

# Configuration
from .config import PrivacyConfig

# Detectors (for extension)
from .detectors import (
    BaseDetector,
    CustomPatternDetector,
    EntropyDetector,
)

# Redaction utilities
from .redactors import TextRedactor, RedactionStrategy

__all__ = [
    # Main API
    'PrivacyFilter',
    
    # Configuration
    'PrivacyConfig',
    
    # Detectors
    'BaseDetector',
    'CustomPatternDetector',
    
    # Redactors
    'TextRedactor',
    'RedactionStrategy',
]
