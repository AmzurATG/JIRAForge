"""
Privacy Filter

Main entry point for privacy filtering.
Coordinates detection, merging, and redaction of sensitive data.
"""
import logging
import re
import time
from typing import Dict, Any, Optional, List

from .config import PrivacyConfig, RedactionStrategy
from .detectors import (
    BaseDetector,
    Detection,
    CustomPatternDetector,
    EntropyDetector,
    PRESIDIO_AVAILABLE,
    SECRETS_AVAILABLE,
)
from .redactors import TextRedactor

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Application-specific elevated PII detection rules
# ---------------------------------------------------------------------------
# When the user is working in certain applications, we lower the confidence
# threshold and add extra regex patterns to catch PII that normally lacks
# recognizable context (e.g., standalone numbers in Excel cells).
# ---------------------------------------------------------------------------
APP_ELEVATED_DETECTION: Dict[str, Dict[str, Any]] = {
    # Spreadsheet apps — tabular data likely contains structured PII
    'excel.exe': {
        'lower_confidence': 0.5,
        'extra_patterns': [
            # Standalone 9-digit numbers (possible SSN without dashes)
            (r'\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b', 'POSSIBLE_SSN', 0.55),
            # Standalone 15-16 digit numbers (possible credit card)
            (r'\b\d{15,16}\b', 'POSSIBLE_CREDIT_CARD', 0.6),
        ],
    },
    'libreofficecalc.exe': {
        'lower_confidence': 0.5,
        'extra_patterns': [
            (r'\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b', 'POSSIBLE_SSN', 0.55),
            (r'\b\d{15,16}\b', 'POSSIBLE_CREDIT_CARD', 0.6),
        ],
    },
    'soffice.bin': {
        'lower_confidence': 0.5,
        'extra_patterns': [
            (r'\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b', 'POSSIBLE_SSN', 0.55),
            (r'\b\d{15,16}\b', 'POSSIBLE_CREDIT_CARD', 0.6),
        ],
    },
    # Text editors — config / credential files often opened here
    'notepad.exe': {
        'lower_confidence': 0.6,
        'extra_patterns': [
            # Lines that look like key:value or key=value pairs
            (r'(?i)^[\w.-]+\s*[=:]\s*\S+.*$', 'POSSIBLE_CREDENTIAL', 0.55),
        ],
    },
    'notepad++.exe': {
        'lower_confidence': 0.6,
        'extra_patterns': [
            (r'(?i)^[\w.-]+\s*[=:]\s*\S+.*$', 'POSSIBLE_CREDENTIAL', 0.55),
        ],
    },
    # Code editors — source files may contain hardcoded secrets
    'code.exe': {
        'lower_confidence': 0.6,
        'extra_patterns': [],
    },
}


class PrivacyFilter:
    """
    Unified privacy filter combining multiple detection strategies.
    
    Coordinates:
    - Custom pattern detection (always available)
    - Presidio PII detection (if installed)
    - detect-secrets detection (if installed)
    
    Features:
    - Automatic detector initialization based on availability
    - Detection merging to avoid duplicate redactions
    - Configurable redaction strategies
    - Performance metrics
    - Optional audit logging
    
    Usage:
        # Simple usage (uses environment config)
        filter = PrivacyFilter()
        result = filter.redact(ocr_text)
        clean_text = result['text']
        
        # Custom configuration
        config = PrivacyConfig()
        config.min_confidence = 0.8
        filter = PrivacyFilter(config)
        result = filter.redact(ocr_text)
        
    Result format:
        {
            'text': 'redacted text...',
            'original_length': 100,
            'redacted_length': 95,
            'redactions_count': 3,
            'redactions': [
                {'entity_type': 'PASSWORD', 'start': 10, 'end': 20, ...},
                ...
            ],
            'processing_time_ms': 15.5,
            'detectors_used': ['custom_patterns', 'presidio'],
        }
    """
    
    def __init__(self, config: Optional[PrivacyConfig] = None):
        """
        Initialize privacy filter.
        
        Args:
            config: Privacy configuration (loads from environment if None)
        """
        self.config = config or PrivacyConfig.from_env()
        self._detectors: List[BaseDetector] = []
        self._redactor: Optional[TextRedactor] = None
        self._audit_logger = None
        
        self._initialize()
    
    def _initialize(self):
        """Initialize detectors and redactor based on configuration"""
        
        # Initialize redactor
        self._redactor = TextRedactor(
            strategy=self.config.redaction_strategy,
            mask_char=self.config.mask_char,
            mask_length=self.config.mask_length
        )
        
        # Initialize detectors based on config
        if self.config.detect_custom_patterns:
            try:
                detector = CustomPatternDetector(self.config)
                self._detectors.append(detector)
                logger.debug("Custom pattern detector initialized")
            except Exception as e:
                logger.warning(f"Failed to initialize custom pattern detector: {e}")
        
        if self.config.detect_pii and PRESIDIO_AVAILABLE:
            try:
                from .detectors import PresidioDetector
                detector = PresidioDetector(self.config)
                self._detectors.append(detector)
                logger.debug("Presidio detector initialized")
            except Exception as e:
                logger.warning(f"Failed to initialize Presidio detector: {e}")
        elif self.config.detect_pii:
            logger.info("Presidio not available - install with: pip install presidio-analyzer")
        
        # Entropy detector for standalone high-entropy secrets (always available)
        try:
            entropy_detector = EntropyDetector()
            self._detectors.append(entropy_detector)
            logger.debug("Entropy detector initialized")
        except Exception as e:
            logger.warning(f"Failed to initialize entropy detector: {e}")
        
        if self.config.detect_secrets and SECRETS_AVAILABLE:
            try:
                from .detectors import SecretsDetector
                detector = SecretsDetector(self.config)
                self._detectors.append(detector)
                logger.debug("detect-secrets detector initialized")
            except Exception as e:
                logger.warning(f"Failed to initialize detect-secrets detector: {e}")
        elif self.config.detect_secrets:
            logger.info("detect-secrets not available - install with: pip install detect-secrets")
        
        # Initialize audit logger if enabled
        if self.config.enable_audit_log:
            self._init_audit_logger()
        
        logger.info(f"Privacy filter initialized with {len(self._detectors)} detectors")
    
    def _init_audit_logger(self):
        """Initialize audit logger for tracking redactions"""
        try:
            self._audit_logger = logging.getLogger('privacy_audit')
            handler = logging.FileHandler(self.config.audit_log_path)
            handler.setFormatter(logging.Formatter(
                '%(asctime)s - %(message)s'
            ))
            self._audit_logger.addHandler(handler)
            self._audit_logger.setLevel(logging.INFO)
        except Exception as e:
            logger.warning(f"Failed to initialize audit logger: {e}")
    
    def redact(self, text: str, app_name: str = '') -> Dict[str, Any]:
        """
        Detect and redact sensitive information from text.
        
        Args:
            text: The text to filter
            app_name: Optional application name (e.g. 'excel.exe') for
                      app-specific elevated detection rules.
            
        Returns:
            Dict with redacted text and metadata:
            - text: Redacted text
            - original_length: Length of original text
            - redacted_length: Length after redaction
            - redactions_count: Number of redactions made
            - redactions: List of redaction details
            - processing_time_ms: Time taken to process
            - detectors_used: List of detector names used
        """
        start_time = time.perf_counter()
        
        # Return early if disabled or empty
        if not self.config.enabled:
            return self._create_result(text, [], 0)
        
        if not text:
            return self._create_result('', [], 0)
        
        # Skip very short text
        if len(text) < self.config.skip_short_text:
            return self._create_result(text, [], time.perf_counter() - start_time)
        
        # Determine effective confidence threshold (may be lowered for certain apps)
        effective_confidence = self.config.min_confidence
        app_rules = None
        if app_name:
            app_key = app_name.lower().strip()
            app_rules = APP_ELEVATED_DETECTION.get(app_key)
            if app_rules and 'lower_confidence' in app_rules:
                effective_confidence = app_rules['lower_confidence']
                logger.debug(
                    f"[PRIVACY] App-specific rules for '{app_key}': "
                    f"confidence lowered from {self.config.min_confidence} to {effective_confidence}"
                )
        
        # Truncate very long text for performance
        original_length = len(text)
        text_to_scan = text[:self.config.max_text_length] if len(text) > self.config.max_text_length else text
        
        try:
            # Collect detections from all detectors
            all_detections: List[Detection] = []
            detectors_used = []
            
            for detector in self._detectors:
                if not detector.is_available():
                    continue
                
                try:
                    detections = detector.detect(text_to_scan)
                    all_detections.extend(detections)
                    detectors_used.append(detector.get_name())
                except Exception as e:
                    logger.warning(f"Detector {detector.get_name()} failed: {e}")
            
            # Filter by confidence threshold
            filtered_detections = [
                d for d in all_detections
                if d.confidence >= effective_confidence
            ]
            
            # Run app-specific extra patterns if applicable
            if app_rules and app_rules.get('extra_patterns'):
                for pattern_str, entity_type, confidence in app_rules['extra_patterns']:
                    try:
                        for match in re.finditer(pattern_str, text_to_scan, re.MULTILINE):
                            detection = Detection(
                                entity_type=entity_type,
                                start=match.start(),
                                end=match.end(),
                                confidence=confidence,
                                text=match.group(),
                                detector='app_specific',
                            )
                            if detection.confidence >= effective_confidence:
                                filtered_detections.append(detection)
                    except re.error as e:
                        logger.warning(f"App-specific pattern error: {e}")
                if filtered_detections:
                    detectors_used.append('app_specific')
            
            # Merge overlapping detections
            merged_detections = self._merge_overlapping(filtered_detections)
            
            # Convert to dict format for redactor
            detection_dicts = [d.to_dict() for d in merged_detections]
            
            # Apply redactions
            redacted_text = self._redactor.redact(text_to_scan, detection_dicts)
            
            # If text was truncated, do NOT include the unfiltered tail — redact it entirely
            if len(text) > self.config.max_text_length:
                redacted_text += "\n[TRUNCATED - Remaining text redacted (exceeded max length for privacy filtering)]"
            
            # Audit log if enabled
            if self._audit_logger and merged_detections:
                self._log_redactions(merged_detections)
            
            processing_time = (time.perf_counter() - start_time) * 1000
            
            return {
                'text': redacted_text,
                'original_length': original_length,
                'redacted_length': len(redacted_text),
                'redactions_count': len(merged_detections),
                'redactions': detection_dicts,
                'processing_time_ms': processing_time,
                'detectors_used': detectors_used,
                'filtered_by_confidence': len(all_detections) - len(filtered_detections),
            }
            
        except Exception as e:
            logger.error(f"Privacy filter error: {e}")
            processing_time = (time.perf_counter() - start_time) * 1000
            
            if self.config.fail_open:
                # Return original text on error (less secure but more available)
                return self._create_result(text, [], processing_time, error=str(e))
            else:
                # Fail closed - return empty or masked text (more secure)
                return {
                    'text': '[PRIVACY_FILTER_ERROR - Content redacted for safety]',
                    'original_length': original_length,
                    'redacted_length': 0,
                    'redactions_count': 0,
                    'redactions': [],
                    'processing_time_ms': processing_time,
                    'detectors_used': [],
                    'error': str(e),
                }
    
    def _create_result(
        self,
        text: str,
        redactions: List[Dict],
        processing_time: float,
        error: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create standard result dict"""
        result = {
            'text': text,
            'original_length': len(text),
            'redacted_length': len(text),
            'redactions_count': len(redactions),
            'redactions': redactions,
            'processing_time_ms': processing_time * 1000 if processing_time < 1 else processing_time,
            'detectors_used': [],
        }
        if error:
            result['error'] = error
        return result
    
    def _merge_overlapping(self, detections: List[Detection]) -> List[Detection]:
        """
        Merge overlapping detections to avoid double-redaction.
        
        When multiple detectors find overlapping sensitive data,
        we keep the detection with highest confidence or longest span.
        
        Args:
            detections: List of Detection objects
            
        Returns:
            Merged list with no overlaps
        """
        if not detections:
            return []
        
        # Sort by start position, then by length (descending)
        sorted_detections = sorted(
            detections,
            key=lambda d: (d.start, -(d.end - d.start))
        )
        
        merged = []
        
        for detection in sorted_detections:
            # Check if this detection overlaps with any existing merged detection
            overlaps = False
            for i, existing in enumerate(merged):
                if detection.overlaps(existing):
                    overlaps = True
                    # Keep the one with higher confidence, or longer span if tied
                    if detection.confidence > existing.confidence or \
                       (detection.confidence == existing.confidence and detection.length > existing.length):
                        merged[i] = detection
                    break
            
            if not overlaps:
                merged.append(detection)
        
        return merged
    
    def _log_redactions(self, detections: List[Detection]):
        """Log redactions for audit purposes"""
        if not self._audit_logger:
            return
        
        for detection in detections:
            self._audit_logger.info(
                f"REDACTED: type={detection.entity_type} "
                f"detector={detection.detector} "
                f"confidence={detection.confidence:.2f} "
                f"length={detection.length}"
            )
    
    def is_sensitive(self, text: str) -> bool:
        """
        Quick check if text contains any sensitive data.
        
        Args:
            text: Text to check
            
        Returns:
            True if sensitive data detected
        """
        result = self.redact(text)
        return result['redactions_count'] > 0
    
    def get_available_detectors(self) -> List[str]:
        """Get list of available detector names"""
        return [d.get_name() for d in self._detectors if d.is_available()]
    
    def get_supported_entities(self) -> List[str]:
        """Get list of all supported entity types across all detectors"""
        entities = set()
        for detector in self._detectors:
            entities.update(detector.get_supported_entities())
        return sorted(entities)
    
    def get_config(self) -> Dict[str, Any]:
        """Get current configuration as dictionary"""
        return self.config.to_dict()


# Convenience function for simple usage
def redact_sensitive_data(text: str, config: Optional[PrivacyConfig] = None) -> str:
    """
    Simple function to redact sensitive data from text.
    
    Args:
        text: Text to filter
        config: Optional configuration
        
    Returns:
        Redacted text
    """
    filter = PrivacyFilter(config)
    result = filter.redact(text)
    return result['text']
