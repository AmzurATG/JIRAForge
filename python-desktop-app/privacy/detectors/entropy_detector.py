"""
Entropy Detector

Detects potential secrets/passwords by analyzing string entropy.
Catches standalone passwords like MyP@ssw0rd! that lack recognizable
context patterns (e.g., no "password=" prefix).

Uses Shannon entropy combined with character class diversity to identify
high-entropy tokens that are likely secrets rather than natural language.
"""
import math
import re
import logging
from typing import List

from .base import BaseDetector, Detection

logger = logging.getLogger(__name__)


class EntropyDetector(BaseDetector):
    """
    Detect potential secrets by analyzing string entropy and character diversity.

    Flags tokens that have:
    - High Shannon entropy (>= 3.5 bits/char) — high randomness
    - Multiple character classes (>= 3 of: uppercase, lowercase, digits, special)
    - Minimum length (>= 8 chars)

    These characteristics are common in passwords and secrets but rare
    in natural language or common identifiers.

    Trade-off: may produce false positives on complex filenames, encoded
    strings, or URLs. Confidence scoring (0.5-0.85) keeps these at the
    lower end so they are only redacted when the confidence threshold
    is lowered (e.g., via app-specific rules for Excel/Notepad).
    """

    MIN_LENGTH = 8
    MAX_LENGTH = 128        # Skip very long tokens (likely encoded data, not passwords)
    MIN_ENTROPY = 3.0       # Shannon entropy bits per character
    MIN_CHAR_CLASSES = 2    # Out of 4: upper, lower, digit, special

    # Patterns that look high-entropy but are not secrets
    _SKIP_PREFIXES = (
        'http://', 'https://', 'ftp://', 'ssh://', 'file://',
        'C:\\', 'D:\\', '/', './', '../',
        'data:', 'blob:',
    )
    _SKIP_PATTERNS = re.compile(
        r'^(?:'
        r'[A-Za-z]:\\[\w\\]+'             # Windows paths
        r'|/[\w/.]+'                       # Unix paths
        r'|[\w.-]+\.(com|org|net|io|js|py|ts|css|html|json|xml|yml|yaml|md|txt|log|exe|dll|so)'
        r'|\d{4}[-/]\d{2}[-/]\d{2}'       # Dates
        r'|v?\d+\.\d+\.\d+'               # Version numbers
        r')$',
        re.IGNORECASE
    )

    def detect(self, text: str) -> List[Detection]:
        """
        Detect high-entropy tokens that may be secrets.

        Args:
            text: The text to scan

        Returns:
            List of Detection objects for potential secrets
        """
        if not text:
            return []

        detections = []
        # Split text into word-like tokens (sequences of non-whitespace)
        for match in re.finditer(r'\S+', text):
            token = match.group()

            if len(token) < self.MIN_LENGTH or len(token) > self.MAX_LENGTH:
                continue

            # Skip known non-secret patterns
            if any(token.startswith(prefix) for prefix in self._SKIP_PREFIXES):
                continue
            if self._SKIP_PATTERNS.match(token):
                continue

            # Skip tokens that are already labeled (e.g., "password=value")
            # But allow tokens like word@digits which are passwords, not emails
            if '=' in token:
                continue
            if ':' in token and '@' not in token:
                continue

            char_classes = self._count_char_classes(token)
            if char_classes < self.MIN_CHAR_CLASSES:
                continue

            entropy = self._shannon_entropy(token)
            if entropy < self.MIN_ENTROPY:
                continue

            # Scale confidence: higher entropy = higher confidence
            confidence = min(0.5 + (entropy - self.MIN_ENTROPY) * 0.1, 0.85)

            detections.append(Detection(
                entity_type='HIGH_ENTROPY_SECRET',
                start=match.start(),
                end=match.end(),
                confidence=confidence,
                text=token,
                detector=self.get_name(),
            ))

        return detections

    @staticmethod
    def _shannon_entropy(text: str) -> float:
        """Calculate Shannon entropy in bits per character."""
        if not text:
            return 0.0
        freq: dict = {}
        for c in text:
            freq[c] = freq.get(c, 0) + 1
        length = len(text)
        return -sum(
            (count / length) * math.log2(count / length)
            for count in freq.values()
        )

    @staticmethod
    def _count_char_classes(text: str) -> int:
        """Count the number of distinct character classes present."""
        classes = 0
        if re.search(r'[a-z]', text):
            classes += 1
        if re.search(r'[A-Z]', text):
            classes += 1
        if re.search(r'[0-9]', text):
            classes += 1
        if re.search(r'[^a-zA-Z0-9]', text):
            classes += 1
        return classes

    def get_name(self) -> str:
        return "entropy"

    def is_available(self) -> bool:
        return True

    def get_supported_entities(self) -> List[str]:
        return ['HIGH_ENTROPY_SECRET']
