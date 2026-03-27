"""
Custom Pattern Detector

RegEx-based detector for common sensitive data patterns.
No external dependencies required - always available.
"""
import re
import logging
from typing import List, Dict, Pattern, Tuple

from .base import BaseDetector, Detection

logger = logging.getLogger(__name__)


class CustomPatternDetector(BaseDetector):
    """
    Detect sensitive data using regex patterns.
    
    This detector is always available (no external dependencies)
    and provides baseline protection for common patterns like:
    - Passwords in URLs, config strings, environment variables
    - API keys with common prefixes
    - Private keys (PEM format)
    - Connection strings with embedded credentials
    - Bearer tokens
    - Common secrets patterns
    
    Patterns are tuned for OCR-extracted text which may have
    recognition errors, so confidence scores are adjusted accordingly.
    """
    
    # Pattern definitions: (pattern, entity_type, base_confidence)
    PATTERNS: List[Tuple[str, str, float]] = [
        # URL with embedded credentials
        # Matches: https://user:password@host.com, ftp://admin:pass123@server
        (
            r'(?:https?|ftp|ssh|mongodb|postgresql|mysql|redis)://[^:\s]+:([^@\s]+)@',
            'PASSWORD',
            0.9
        ),
        
        # Password in key=value format
        # Matches: password=secret123, PASSWORD="mypass", passwd: secret
        (
            r'(?i)(?:password|passwd|pwd|pass|secret)[\s]*[=:]+[\s]*["\']?([^\s"\',;]+)["\']?',
            'PASSWORD',
            0.75
        ),
        
        # API keys - AWS
        # Matches: AKIA... (AWS Access Key ID pattern)
        (
            r'\b(AKIA[0-9A-Z]{16})\b',
            'API_KEY',
            0.95
        ),
        
        # API keys - AWS Secret Access Key
        (
            r'(?i)(?:aws.?secret.?access.?key|secret.?key)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9/+=]{40})["\']?',
            'API_KEY',
            0.85
        ),
        
        # API keys - Generic long alphanumeric strings with common prefixes
        (
            r'(?i)(?:api[_-]?key|apikey|api[_-]?secret|access[_-]?token)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9_-]{20,})["\']?',
            'API_KEY',
            0.8
        ),
        
        # API keys - Short but explicit (API_KEY=value, api-key: value)
        # For when keys are explicitly labeled
        (
            r'(?i)(?:api[_-]?key|apikey|secret[_-]?key)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9_-]{8,})["\']?',
            'API_KEY',
            0.75
        ),
        
        # API keys - GitHub tokens
        (
            r'\b(gh[ps]_[A-Za-z0-9]{36})\b',
            'API_KEY',
            0.95
        ),
        
        # API keys - GitHub fine-grained
        (
            r'\b(github_pat_[A-Za-z0-9]{22,}_[A-Za-z0-9]{59,})\b',
            'API_KEY',
            0.95
        ),
        
        # API keys - Slack tokens
        (
            r'\b(xox[baprs]-[0-9]{10,13}-[A-Za-z0-9-]+)\b',
            'API_KEY',
            0.9
        ),
        
        # API keys - Google
        (
            r'\b(AIza[0-9A-Za-z_-]{35})\b',
            'API_KEY',
            0.95
        ),
        
        # API keys - Stripe
        (
            r'\b(sk_live_[0-9a-zA-Z]{24,})\b',
            'API_KEY',
            0.95
        ),
        (
            r'\b(pk_live_[0-9a-zA-Z]{24,})\b',
            'API_KEY',
            0.95
        ),
        
        # Bearer tokens
        (
            r'(?i)(?:bearer|authorization)[\s:]+([A-Za-z0-9_-]{20,}\.?[A-Za-z0-9_-]*\.?[A-Za-z0-9_-]*)',
            'BEARER_TOKEN',
            0.85
        ),
        
        # JWT tokens (three base64 sections with dots)
        (
            r'\b(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b',
            'BEARER_TOKEN',
            0.95
        ),
        
        # Private keys - PEM format
        (
            r'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
            'PRIVATE_KEY',
            0.99
        ),
        
        # Private keys - SSH private key content
        (
            r'-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----',
            'PRIVATE_KEY',
            0.99
        ),
        
        # Connection strings - Database URLs
        (
            r'(?i)(?:mongodb|postgresql|postgres|mysql|mssql|sqlserver|redis)://[^\s]+:[^@\s]+@[^\s]+',
            'CONNECTION_STRING',
            0.9
        ),
        
        # Connection strings - ADO.NET style with password
        (
            r'(?i)(?:server|data source)=[^;]+;.*?(?:password|pwd)=([^;]+)',
            'CONNECTION_STRING',
            0.85
        ),
        
        # High entropy strings (potential secrets) - 32+ chars alphanumeric
        # Only in context of suspicious keywords
        (
            r'(?i)(?:secret|token|key|credential|auth)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9+/]{32,}=*)["\']?',
            'API_KEY',
            0.7
        ),
        
        # Credit card numbers (basic pattern)
        # Visa, MasterCard, Amex patterns
        (
            r'\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b',
            'CREDIT_CARD',
            0.85
        ),
        
        # SSN pattern (XXX-XX-XXXX)
        (
            r'\b(?!000|666|9\d{2})[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}\b',
            'US_SSN',
            0.8
        ),
        
        # ============================================
        # OAuth & Authentication Secrets
        # ============================================
        
        # OAuth Client Secret
        (
            r'(?i)client[_-]?secret[\s]*[=:]+[\s]*["\']?([A-Za-z0-9_-]{20,})["\']?',
            'OAUTH_SECRET',
            0.9
        ),
        
        # Azure AD Tenant ID
        (
            r'(?i)(?:tenant[_-]?id|azure[_-]?tenant)[\s]*[=:]+[\s]*["\']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["\']?',
            'API_KEY',
            0.85
        ),
        
        # Azure AD Client ID
        (
            r'(?i)(?:client[_-]?id|app[_-]?id|application[_-]?id)[\s]*[=:]+[\s]*["\']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["\']?',
            'API_KEY',
            0.8
        ),
        
        # ============================================
        # Cloud Service API Keys
        # ============================================
        
        # Firebase API Key (starts with AIza - same as Google)
        # Already covered by Google API Key pattern
        
        # Firebase Config object
        (
            r'(?i)firebase[\s]*[=:]+[\s]*\{[^}]*apiKey[^}]*\}',
            'API_KEY',
            0.85
        ),
        
        # Twilio Account SID
        (
            r'\b(AC[a-f0-9]{32})\b',
            'API_KEY',
            0.95
        ),
        
        # Twilio Auth Token
        (
            r'(?i)(?:twilio[_-]?auth[_-]?token|auth[_-]?token)[\s]*[=:]+[\s]*["\']?([a-f0-9]{32})["\']?',
            'API_KEY',
            0.9
        ),
        
        # SendGrid API Key
        (
            r'\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,})\b',
            'API_KEY',
            0.95
        ),
        
        # Mailchimp API Key
        (
            r'\b([a-f0-9]{32}-us[0-9]{1,2})\b',
            'API_KEY',
            0.9
        ),
        
        # Mailgun API Key
        (
            r'(?i)(?:mailgun[_-]?api[_-]?key|mailgun[_-]?key)[\s]*[=:]+[\s]*["\']?(key-[a-f0-9]{32})["\']?',
            'API_KEY',
            0.9
        ),
        
        # Heroku API Key (UUID format with context)
        (
            r'(?i)heroku[_-]?api[_-]?key[\s]*[=:]+[\s]*["\']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["\']?',
            'API_KEY',
            0.9
        ),
        
        # ============================================
        # Package Manager Tokens
        # ============================================
        
        # NPM Token
        (
            r'\b(npm_[A-Za-z0-9]{36})\b',
            'API_KEY',
            0.95
        ),
        
        # PyPI Token
        (
            r'\b(pypi-[A-Za-z0-9_-]{50,})\b',
            'API_KEY',
            0.95
        ),
        
        # Docker Registry Auth (base64 encoded)
        (
            r'(?i)(?:docker[_-]?auth|registry[_-]?auth)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9+/]{40,}=*)["\']?',
            'API_KEY',
            0.85
        ),
        
        # ============================================
        # Database & Infrastructure Secrets
        # ============================================
        
        # Database Password (various env var names)
        (
            r'(?i)(?:db[_-]?password|db[_-]?pass|database[_-]?password|mysql[_-]?pwd|mysql[_-]?password|postgres[_-]?password|pg[_-]?password|sql[_-]?password|redis[_-]?password|mongo[_-]?password)[\s]*[=:]+[\s]*["\']?([^\s"\',;]+)["\']?',
            'DATABASE_PASSWORD',
            0.9
        ),
        
        # Encryption Key
        (
            r'(?i)(?:encryption[_-]?key|aes[_-]?key|secret[_-]?key|crypto[_-]?key|cipher[_-]?key)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9+/=]{16,})["\']?',
            'ENCRYPTION_KEY',
            0.85
        ),
        
        # SSH URLs with password (ssh://user:pass@host)
        (
            r'ssh://[^:\s]+:([^@\s]+)@[^\s]+',
            'PASSWORD',
            0.9
        ),
        
        # ============================================
        # Internal Network Information
        # ============================================
        
        # Internal IP - Class A (10.x.x.x)
        (
            r'\b(10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3})\b',
            'INTERNAL_IP',
            0.75
        ),
        
        # Internal IP - Class B (172.16-31.x.x)
        (
            r'\b(172\.(?:1[6-9]|2[0-9]|3[0-1])\.(?:[0-9]{1,3}\.)[0-9]{1,3})\b',
            'INTERNAL_IP',
            0.75
        ),
        
        # Internal IP - Class C (192.168.x.x)
        (
            r'\b(192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3})\b',
            'INTERNAL_IP',
            0.75
        ),
        
        # ============================================
        # Email Addresses (fallback when Presidio unavailable)
        # ============================================
        (
            r'\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b',
            'EMAIL_ADDRESS',
            0.9
        ),
        
        # ============================================
        # SSN without dashes (OCR may strip dashes)
        # ============================================
        (
            r'(?i)(?:ssn|social.?security)\s*[=:]+\s*["\']?(\d{9})["\']?',
            'US_SSN',
            0.85
        ),
        
        # ============================================
        # Atlassian / Platform IDs
        # ============================================
        
        # Atlassian Account IDs (format: 712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
        # Must come before UUID pattern to match the more specific format first
        (
            r'\b(\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b',
            'ATLASSIAN_ACCOUNT_ID',
            0.95
        ),
        
        # Atlassian ARIs (app IDs, installation IDs)
        # Format: ari:cloud:<product>::<resource>/<uuid>
        (
            r'(ari:cloud:[a-z]+::[a-z]+/[a-f0-9-]+)',
            'ATLASSIAN_ARI',
            0.95
        ),
        
        # UUIDs (user IDs, org IDs, cloud IDs, tenant IDs)
        # Standalone UUIDs that may appear in OCR text from admin/config screens
        (
            r'\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b',
            'UUID',
            0.75
        ),
    ]
    
    def __init__(self, config=None):
        """
        Initialize the custom pattern detector.
        
        Args:
            config: Optional PrivacyConfig (not currently used but kept for consistency)
        """
        self.config = config
        self._compiled_patterns: List[Tuple[Pattern, str, float]] = []
        self._compile_patterns()
    
    def _compile_patterns(self):
        """Pre-compile all regex patterns for performance"""
        self._compiled_patterns = []
        
        for pattern_str, entity_type, confidence in self.PATTERNS:
            try:
                compiled = re.compile(pattern_str, re.IGNORECASE | re.MULTILINE)
                self._compiled_patterns.append((compiled, entity_type, confidence))
            except re.error as e:
                logger.warning(f"Failed to compile pattern for {entity_type}: {e}")
    
    def detect(self, text: str) -> List[Detection]:
        """
        Detect sensitive data using regex patterns.
        
        Args:
            text: Text to scan
            
        Returns:
            List of Detection objects
        """
        if not text:
            return []
        
        detections = []
        
        for compiled_pattern, entity_type, base_confidence in self._compiled_patterns:
            try:
                for match in compiled_pattern.finditer(text):
                    # If there's a capturing group, use it; otherwise use full match
                    if match.groups():
                        # Find the first non-None group
                        for group_idx, group in enumerate(match.groups(), 1):
                            if group:
                                start = match.start(group_idx)
                                end = match.end(group_idx)
                                matched_text = group
                                break
                        else:
                            # Fallback to full match
                            start = match.start()
                            end = match.end()
                            matched_text = match.group()
                    else:
                        start = match.start()
                        end = match.end()
                        matched_text = match.group()
                    
                    # Adjust confidence based on match characteristics
                    confidence = self._adjust_confidence(
                        base_confidence,
                        matched_text,
                        entity_type
                    )
                    
                    detection = Detection(
                        entity_type=entity_type,
                        start=start,
                        end=end,
                        confidence=confidence,
                        text=matched_text,
                        detector=self.get_name(),
                        metadata={'pattern_type': entity_type.lower()}
                    )
                    detections.append(detection)
                    
            except Exception as e:
                logger.warning(f"Error scanning for {entity_type}: {e}")
        
        return detections
    
    def _adjust_confidence(
        self,
        base_confidence: float,
        matched_text: str,
        entity_type: str
    ) -> float:
        """
        Adjust confidence based on match characteristics.
        
        Args:
            base_confidence: Base confidence from pattern definition
            matched_text: The matched text
            entity_type: Entity type
            
        Returns:
            Adjusted confidence score
        """
        confidence = base_confidence
        
        # Increase confidence for longer matches (less likely to be false positive)
        if len(matched_text) > 30:
            confidence = min(1.0, confidence + 0.05)
        
        # Decrease confidence for very short matches, but not for credentials/passwords
        # Credentials must always be redacted regardless of length
        if len(matched_text) < 8 and entity_type not in ('PASSWORD', 'DATABASE_PASSWORD', 'API_KEY', 'OAUTH_SECRET', 'ENCRYPTION_KEY'):
            confidence = max(0.0, confidence - 0.1)
        
        # Password-specific adjustments
        if entity_type == 'PASSWORD':
            # Higher confidence if contains mixed case, numbers, special chars
            has_upper = any(c.isupper() for c in matched_text)
            has_lower = any(c.islower() for c in matched_text)
            has_digit = any(c.isdigit() for c in matched_text)
            has_special = any(not c.isalnum() for c in matched_text)
            
            complexity_score = sum([has_upper, has_lower, has_digit, has_special])
            if complexity_score >= 3:
                confidence = min(1.0, confidence + 0.1)
            # Don't penalize low-complexity passwords — they are still credentials
            # that must be redacted regardless of strength
        
        # API key specific - check for expected format
        if entity_type == 'API_KEY':
            # Higher confidence for keys with expected prefixes
            key_prefixes = ['AKIA', 'sk_', 'pk_', 'ghp_', 'ghs_', 'AIza', 'xox']
            if any(matched_text.startswith(prefix) for prefix in key_prefixes):
                confidence = min(1.0, confidence + 0.1)
        
        return round(confidence, 2)
    
    def get_name(self) -> str:
        """Get detector name"""
        return "custom_patterns"
    
    def is_available(self) -> bool:
        """Always available - no external dependencies"""
        return True
    
    def get_supported_entities(self) -> List[str]:
        """Get list of entity types this detector can find"""
        return list(set(entity for _, entity, _ in self.PATTERNS))
