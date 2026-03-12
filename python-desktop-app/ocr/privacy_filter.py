"""Privacy Filter - Redact sensitive information from OCR text"""

import re
from typing import List, Tuple, Set


class PrivacyFilter:
    """
    Filters sensitive information from OCR-extracted text.
    Runs locally before any data is sent to the cloud.
    
    This is a critical component for privacy - it ensures that
    sensitive data like credit cards, passwords, etc. never
    leave the user's device.
    """
    
    # Compiled regex patterns for performance
    PATTERNS = [
        # Credit card numbers (13-19 digits, optionally with spaces/dashes)
        (re.compile(r'\b(?:\d[ -]*?){13,19}\b'), '[CARD_REDACTED]'),
        
        # SSN (XXX-XX-XXXX)
        (re.compile(r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b'), '[SSN_REDACTED]'),
        
        # Phone numbers (various formats)
        (re.compile(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'), '[PHONE_REDACTED]'),
        
        # Email addresses
        (re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'), '[EMAIL_REDACTED]'),
        
        # API keys / tokens (long alphanumeric strings - 32+ chars)
        (re.compile(r'\b[A-Za-z0-9_-]{32,}\b'), '[TOKEN_REDACTED]'),
        
        # AWS access keys
        (re.compile(r'\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b'), '[AWS_KEY_REDACTED]'),
        
        # Password fields (common patterns in forms)
        (re.compile(r'(?i)password\s*[:=]\s*\S+'), '[PASSWORD_REDACTED]'),
        
        # Secret/private key patterns
        (re.compile(r'(?i)(?:secret|private)[-_]?key\s*[:=]\s*\S+'), '[SECRET_REDACTED]'),
        
        # Bearer tokens
        (re.compile(r'(?i)bearer\s+[A-Za-z0-9._-]+'), '[BEARER_REDACTED]'),
        
        # IP addresses (could be internal/sensitive)
        (re.compile(r'\b(?:10|172\.(?:1[6-9]|2[0-9]|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b'), '[INTERNAL_IP_REDACTED]'),
    ]
    
    # Keywords that indicate sensitive context
    SENSITIVE_KEYWORDS: Set[str] = {
        'password', 'secret', 'token', 'api_key', 'apikey', 'api-key',
        'private_key', 'privatekey', 'private-key', 'credential',
        'ssn', 'social security', 'credit card', 'bank account',
        'routing number', 'cvv', 'pin', 'otp', 'bearer',
        'access_token', 'refresh_token', 'auth_token'
    }
    
    # Apps/sites that are inherently sensitive
    SENSITIVE_APPS: Set[str] = {
        'keepass', 'lastpass', '1password', 'bitwarden', 'dashlane',  # Password managers
        'bank', 'chase', 'wells fargo', 'citi', 'bofa', 'capital one',  # Banking
        'payroll', 'salary', 'adp', 'workday',  # HR/Payroll
        'medical', 'health', 'hipaa', 'patient', 'healthcare',  # Healthcare
        'tax', 'turbotax', 'hrblock',  # Tax software
    }
    
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
    
    def filter_text(self, text: str) -> Tuple[str, List[str]]:
        """
        Filter sensitive information from text.
        
        Args:
            text: Raw OCR-extracted text
            
        Returns:
            Tuple of (filtered_text, list of redaction types applied)
        """
        if not self.enabled or not text:
            return text, []
        
        redactions = []
        filtered = text
        
        # Apply regex patterns
        for pattern, replacement in self.PATTERNS:
            matches = pattern.findall(filtered)
            if matches:
                redactions.append(replacement.strip('[]'))
                filtered = pattern.sub(replacement, filtered)
        
        # Check for sensitive keyword context
        text_lower = text.lower()
        for keyword in self.SENSITIVE_KEYWORDS:
            if keyword in text_lower:
                redactions.append(f'CONTEXT_{keyword.upper()}')
        
        return filtered, list(set(redactions))
    
    def is_sensitive_context(self, window_title: str, app_name: str) -> bool:
        """
        Check if the current context is sensitive.
        If sensitive, we should skip OCR entirely and only use metadata.
        
        Args:
            window_title: Current window title
            app_name: Application name
            
        Returns:
            True if context appears sensitive
        """
        combined = f"{window_title} {app_name}".lower()
        
        for keyword in self.SENSITIVE_APPS:
            if keyword in combined:
                return True
        
        # Check for banking URLs in browser titles
        banking_patterns = [
            r'bank.*(?:login|account|balance)',
            r'(?:login|sign.*in).*(?:bank|financial)',
            r'(?:credit|debit).*card',
        ]
        for pattern in banking_patterns:
            if re.search(pattern, combined, re.IGNORECASE):
                return True
        
        return False
    
    def should_skip_ocr(self, window_title: str, app_name: str) -> Tuple[bool, str]:
        """
        Determine if OCR should be skipped entirely.
        
        Args:
            window_title: Current window title
            app_name: Application name
            
        Returns:
            Tuple of (should_skip, reason)
        """
        if self.is_sensitive_context(window_title, app_name):
            return True, "sensitive_context"
        
        # Check for password manager windows
        password_indicators = ['password', 'vault', 'keychain', 'credential']
        combined_lower = f"{window_title} {app_name}".lower()
        for indicator in password_indicators:
            if indicator in combined_lower:
                return True, f"password_indicator_{indicator}"
        
        return False, ""
