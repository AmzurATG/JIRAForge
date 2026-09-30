"""
Presidio Detector

Wrapper around Microsoft Presidio for PII detection.
Requires: pip install presidio-analyzer presidio-anonymizer
"""
import logging
from typing import List, Optional

from .base import BaseDetector, Detection

logger = logging.getLogger(__name__)

# Check if Presidio is available
# Note: We catch (ImportError, OSError) because on Windows, DLL loading failures
# raise OSError (e.g., WinError 127) when PyTorch/spaCy dependencies are broken
PRESIDIO_AVAILABLE = False
try:
    from presidio_analyzer import AnalyzerEngine, RecognizerResult
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    PRESIDIO_AVAILABLE = True
except ImportError:
    logger.debug("Presidio not available - install with: pip install presidio-analyzer")
except OSError as e:
    # This catches Windows DLL loading errors (WinError 127, etc.)
    logger.warning(f"Presidio dependencies failed to load (DLL error): {e}")
    logger.info("Presidio PII detection disabled - custom patterns still active")


class PresidioDetector(BaseDetector):
    """
    Detect PII using Microsoft Presidio Analyzer.
    
    Presidio provides robust detection for:
    - Credit card numbers
    - Email addresses
    - Phone numbers
    - Social Security Numbers (US)
    - Bank account numbers
    - Driver's license numbers
    - Passport numbers
    - IP addresses
    - IBAN codes
    - Crypto wallet addresses
    - And more...
    
    Requires:
        pip install presidio-analyzer
        python -m spacy download en_core_web_sm  (for NLP features)
    """
    
    def __init__(self, config=None):
        """
        Initialize Presidio detector.
        
        Args:
            config: Optional PrivacyConfig for entity type filtering
        """
        self.config = config
        self._analyzer: Optional['AnalyzerEngine'] = None
        self._available = PRESIDIO_AVAILABLE
        
        if self._available:
            self._initialize_analyzer()
    
    def _initialize_analyzer(self):
        """Initialize the Presidio analyzer engine"""
        try:
            # Try to use spacy for better NLP-based detection
            try:
                configuration = {
                    "nlp_engine_name": "spacy",
                    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]
                }
                provider = NlpEngineProvider(nlp_configuration=configuration)
                nlp_engine = provider.create_engine()
                self._analyzer = AnalyzerEngine(nlp_engine=nlp_engine)
                logger.debug("Presidio initialized with spacy NLP engine")
            except Exception as e:
                # Fall back to stanza or basic engine
                logger.debug(f"Spacy not available, using basic analyzer: {e}")
                self._analyzer = AnalyzerEngine()
                logger.debug("Presidio initialized with default engine")
                
        except Exception as e:
            logger.warning(f"Failed to initialize Presidio: {e}")
            self._available = False
    
    def detect(self, text: str) -> List[Detection]:
        """
        Detect PII in text using Presidio.
        
        Args:
            text: Text to analyze
            
        Returns:
            List of Detection objects
        """
        if not self._available or not self._analyzer:
            return []
        
        if not text:
            return []
        
        try:
            # Get entity types to detect
            entities = None  # None means all
            if self.config and self.config.pii_types:
                # Presidio logs a warning per call for every entity it has no
                # recognizer for; custom types are handled by other detectors.
                supported = self._get_supported_entity_set()
                entities = [e for e in self.config.pii_types if e in supported] if supported else self.config.pii_types
                if not entities:
                    return []
            
            # Run analysis
            results: List['RecognizerResult'] = self._analyzer.analyze(
                text=text,
                entities=entities,
                language='en'
            )
            
            # Convert to Detection objects
            detections = []
            for result in results:
                detection = Detection(
                    entity_type=result.entity_type,
                    start=result.start,
                    end=result.end,
                    confidence=result.score,
                    text=text[result.start:result.end],
                    detector=self.get_name(),
                    metadata={
                        'recognition_metadata': result.recognition_metadata
                        if hasattr(result, 'recognition_metadata') else {}
                    }
                )
                detections.append(detection)
            
            return detections
            
        except Exception as e:
            logger.warning(f"Presidio analysis failed: {e}")
            return []
    
    def get_name(self) -> str:
        """Get detector name"""
        return "presidio"
    
    def is_available(self) -> bool:
        """Check if Presidio is available"""
        return self._available and self._analyzer is not None
    
    def _get_supported_entity_set(self) -> set:
        """Entities the analyzer can actually recognize (cached). Empty set if unknown."""
        cached = getattr(self, '_supported_entities', None)
        if cached is None:
            try:
                cached = set(self._analyzer.get_supported_entities(language='en'))
            except Exception:
                cached = set()
            self._supported_entities = cached
        return cached

    def get_supported_entities(self) -> List[str]:
        """Get list of entity types Presidio can detect"""
        if not self._available or not self._analyzer:
            return []
        
        try:
            return self._analyzer.get_supported_entities()
        except Exception:
            # Return common entities if we can't query
            return [
                'CREDIT_CARD',
                'CRYPTO',
                'EMAIL_ADDRESS',
                'IBAN_CODE',
                'IP_ADDRESS',
                'NRP',
                'PHONE_NUMBER',
                'MEDICAL_LICENSE',
                'URL',
                'US_BANK_NUMBER',
                'US_DRIVER_LICENSE',
                'US_ITIN',
                'US_PASSPORT',
                'US_SSN',
            ]
