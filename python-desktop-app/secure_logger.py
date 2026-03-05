"""
Secure Logger for Desktop App

Provides PII-sanitized logging for the desktop application.
Uses the same patterns as the privacy filter to redact sensitive
information from log output.

Usage:
    from secure_logger import secure_log, SecureLogger
    
    # Simple function usage
    secure_log("[OK] User authenticated", user_id="abc-123", email="user@test.com")
    # Output: [OK] User authenticated | user_id=[UUID] | email=[EMAIL]
    
    # Class usage for more control
    logger = SecureLogger(level="INFO")
    logger.info("User login", user_id=user_id)
"""

import os
import re
import sys
from datetime import datetime
from typing import Any, Dict, Optional

# Configuration from environment
SECURE_LOG_ENABLED = os.environ.get('SECURE_LOG_ENABLED', 'true').lower() == 'true'
SECURE_LOG_LEVEL = os.environ.get('SECURE_LOG_LEVEL', 'standard')  # minimal, standard, strict


# Sanitization patterns (matching ai-server patterns)
SANITIZATION_PATTERNS = [
    # Email addresses (HIGH PRIORITY - always sanitize)
    {
        'pattern': re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', re.IGNORECASE),
        'replacement': '[EMAIL]',
        'type': 'EMAIL',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # Credit card numbers
    {
        'pattern': re.compile(r'\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b'),
        'replacement': '[CREDIT_CARD]',
        'type': 'CREDIT_CARD',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # Phone numbers
    {
        'pattern': re.compile(r'\b(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b'),
        'replacement': '[PHONE]',
        'type': 'PHONE',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # JWT Tokens
    {
        'pattern': re.compile(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
        'replacement': '[JWT]',
        'type': 'JWT',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # Atlassian Account IDs (format: 712020:uuid) - Must come before UUID
    {
        'pattern': re.compile(r'\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE),
        'replacement': '[ATLASSIAN_ACCOUNT]',
        'type': 'ATLASSIAN_ACCOUNT',
        'levels': ['standard', 'strict']
    },
    
    # UUIDs (user IDs, organization IDs, cloud IDs)
    {
        'pattern': re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE),
        'replacement': '[UUID]',
        'type': 'UUID',
        'levels': ['standard', 'strict']
    },
    
    # IP Addresses
    {
        'pattern': re.compile(r'\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b'),
        'replacement': '[IP]',
        'type': 'IP_ADDRESS',
        'levels': ['standard', 'strict']
    },
    
    # API Keys with labels
    {
        'pattern': re.compile(r'(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9_-]{16,})["\']?', re.IGNORECASE),
        'replacement': '[API_KEY]',
        'type': 'API_KEY',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # AWS Keys
    {
        'pattern': re.compile(r'\b(AKIA[0-9A-Z]{16})\b'),
        'replacement': '[AWS_KEY]',
        'type': 'AWS_KEY',
        'levels': ['minimal', 'standard', 'strict']
    },
    
    # GitHub tokens
    {
        'pattern': re.compile(r'\b(gh[ps]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+)\b'),
        'replacement': '[GITHUB_TOKEN]',
        'type': 'GITHUB_TOKEN',
        'levels': ['minimal', 'standard', 'strict']
    },
]

# Track redaction stats for audit
_redaction_stats: Dict[str, int] = {}


def _should_apply_pattern(pattern_config: dict, level: str) -> bool:
    """Check if pattern should be applied at current level"""
    return level in pattern_config.get('levels', [])


def sanitize_value(value: Any, level: str = None) -> str:
    """
    Sanitize a single value.
    
    Args:
        value: Value to sanitize (will be converted to string)
        level: Sanitization level (minimal, standard, strict)
        
    Returns:
        Sanitized string
    """
    if level is None:
        level = SECURE_LOG_LEVEL
        
    if not SECURE_LOG_ENABLED:
        return str(value)
    
    text = str(value)
    
    for config in SANITIZATION_PATTERNS:
        if not _should_apply_pattern(config, level):
            continue
            
        matches = config['pattern'].findall(text)
        if matches:
            text = config['pattern'].sub(config['replacement'], text)
            _redaction_stats[config['type']] = _redaction_stats.get(config['type'], 0) + len(matches)
    
    return text


def sanitize_dict(data: dict, level: str = None) -> dict:
    """
    Sanitize all values in a dictionary.
    
    Args:
        data: Dictionary to sanitize
        level: Sanitization level
        
    Returns:
        New dictionary with sanitized values
    """
    if level is None:
        level = SECURE_LOG_LEVEL
        
    result = {}
    for key, value in data.items():
        if isinstance(value, dict):
            result[key] = sanitize_dict(value, level)
        elif isinstance(value, list):
            result[key] = [sanitize_value(v, level) for v in value]
        else:
            result[key] = sanitize_value(value, level)
    return result


def secure_log(message: str, level: str = "INFO", **kwargs) -> None:
    """
    Print a sanitized log message.
    
    Args:
        message: Log message (will be sanitized)
        level: Log level (DEBUG, INFO, WARN, ERROR)
        **kwargs: Additional key=value pairs to log (will be sanitized)
        
    Example:
        secure_log("[OK] User authenticated", user_id="abc-123-def", email="user@test.com")
        # Output: [OK] User authenticated | user_id=[UUID] | email=[EMAIL]
    """
    # Sanitize the main message
    sanitized_message = sanitize_value(message)
    
    # Build the full log line
    if kwargs:
        sanitized_kwargs = sanitize_dict(kwargs)
        kwargs_str = " | ".join(f"{k}={v}" for k, v in sanitized_kwargs.items())
        log_line = f"{sanitized_message} | {kwargs_str}"
    else:
        log_line = sanitized_message
    
    # Print with timestamp in debug mode
    if os.environ.get('LOG_TIMESTAMPS', 'false').lower() == 'true':
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp}] [{level}] {log_line}")
    else:
        print(log_line)


class SecureLogger:
    """
    Class-based logger with PII sanitization.
    
    Usage:
        logger = SecureLogger()
        logger.info("User login", user_id=user_id, email=email)
        logger.error("Authentication failed", error=str(e))
    """
    
    def __init__(self, level: str = None, timestamps: bool = False):
        """
        Initialize secure logger.
        
        Args:
            level: Sanitization level (minimal, standard, strict)
            timestamps: Whether to include timestamps in output
        """
        self.level = level or SECURE_LOG_LEVEL
        self.timestamps = timestamps or os.environ.get('LOG_TIMESTAMPS', 'false').lower() == 'true'
    
    def _log(self, log_level: str, message: str, **kwargs):
        """Internal log method"""
        sanitized_message = sanitize_value(message, self.level)
        
        if kwargs:
            sanitized_kwargs = sanitize_dict(kwargs, self.level)
            kwargs_str = " | ".join(f"{k}={v}" for k, v in sanitized_kwargs.items())
            log_line = f"{sanitized_message} | {kwargs_str}"
        else:
            log_line = sanitized_message
        
        if self.timestamps:
            timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{timestamp}] [{log_level}] {log_line}")
        else:
            print(log_line)
    
    def debug(self, message: str, **kwargs):
        """Log debug message"""
        self._log("DEBUG", message, **kwargs)
    
    def info(self, message: str, **kwargs):
        """Log info message"""
        self._log("INFO", message, **kwargs)
    
    def warn(self, message: str, **kwargs):
        """Log warning message"""
        self._log("WARN", message, **kwargs)
    
    def warning(self, message: str, **kwargs):
        """Log warning message (alias)"""
        self.warn(message, **kwargs)
    
    def error(self, message: str, **kwargs):
        """Log error message"""
        self._log("ERROR", message, **kwargs)


def get_redaction_stats() -> Dict[str, int]:
    """Get current redaction statistics"""
    return _redaction_stats.copy()


def reset_redaction_stats() -> None:
    """Reset redaction statistics"""
    global _redaction_stats
    _redaction_stats = {}


# Module-level logger instance
logger = SecureLogger()


# For backwards compatibility - wrap print for easy migration
def secure_print(*args, **kwargs):
    """
    Drop-in replacement for print() with PII sanitization.
    
    Usage:
        # Instead of: print(f"[OK] User: {user_id}")
        # Use: secure_print(f"[OK] User: {user_id}")
    """
    # Convert all args to strings and concatenate
    message = ' '.join(str(arg) for arg in args)
    sanitized = sanitize_value(message)
    print(sanitized, **kwargs)


if __name__ == '__main__':
    # Test the logger
    print("Testing SecureLogger...")
    print()
    
    # Test various patterns
    test_cases = [
        ("Email test", {"email": "user@example.com"}),
        ("UUID test", {"user_id": "fa23333e-9e8f-4b13-bda9-833ca4f7c3cc"}),
        ("Atlassian account", {"account": "712020:2e67c2ea-92ca-451d-9686-bb830a8da0af"}),
        ("IP address", {"ip": "192.168.1.100"}),
        ("JWT token", {"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Gfx6FrV_QzVpwpLw8pHmUkHRlNh9VVp8xkJ0Z_0YtYI"}),
        ("Mixed message", {"msg": "User user@test.com logged in from 10.0.0.1 with id 39b6eab6-88fd-45b6-8bbc-dad801bac3bd"}),
    ]
    
    for desc, data in test_cases:
        print(f"Test: {desc}")
        secure_log(f"[TEST] {desc}", **data)
        print()
    
    # Test secure_print
    print("Testing secure_print():")
    secure_print(f"[OK] User fa23333e-9e8f-4b13-bda9-833ca4f7c3cc authenticated from 192.168.1.1")
    
    # Show stats
    print()
    print(f"Redaction stats: {get_redaction_stats()}")
