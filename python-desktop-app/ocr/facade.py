"""
OCR Facade

Provides unified interface for text extraction with fallback support.
Implements the Facade pattern to hide complexity of multiple OCR engines.

This is the main entry point for OCR operations in the application.
Maintains backward compatibility with existing extract_text_from_image() function.
"""
import logging
import time
from typing import Dict, Any, Optional, List
import numpy as np
from PIL import Image

from .config import OCRConfig, OCREngineConfig
from .engine_factory import EngineFactory
from .base_engine import BaseOCREngine
from .image_processor import preprocess_image, preprocess_screenshot, resize_if_needed

logger = logging.getLogger(__name__)


class OCRFacade:
    """
    Unified facade for OCR operations.
    
    Features:
        - Automatic engine selection based on configuration
        - Graceful fallback when engines fail
        - Preprocessing pipeline integration
        - Metadata fallback as last resort
    
    Usage:
        # Simple usage (uses environment config)
        facade = OCRFacade()
        result = facade.extract_text(image)
        
        # Custom configuration
        config = OCRConfig()
        config.primary_engine = 'rapidocr'
        facade = OCRFacade(config)
        result = facade.extract_text(image)

    Configuration via environment:
        OCR_PRIMARY_ENGINE=rapidocr
        OCR_FALLBACK_ENGINES=winrtocr
        OCR_RAPIDOCR_MIN_CONFIDENCE=0.6
    """
    
    def __init__(self, config: Optional[OCRConfig] = None):
        """
        Initialize OCR Facade.
        
        Args:
            config: OCR configuration (loads from environment if None)
        """
        self.config = config or OCRConfig.from_env()
        self._primary_engine: Optional[BaseOCREngine] = None
        self._fallback_engines: List[BaseOCREngine] = []
        # Auto-heal guardrails for unstable engines.
        self._engine_failure_counts: Dict[str, int] = {}
        self._engine_backoff_until: Dict[str, float] = {}
        self._engine_backoff_seconds: float = 120.0
        
        # Track initialization errors for detailed diagnostics
        self._engine_init_errors: Dict[str, str] = {}
        
        # Privacy filter for redacting sensitive information
        self._privacy_filter = None
        
        # Initialize engines
        self._initialize_engines()
        
        # Initialize privacy filter
        self._initialize_privacy_filter()
    
    def _initialize_engines(self):
        """Initialize primary and fallback engines"""
        
        # Try to create primary engine
        try:
            engine_config = self.config.get_engine_config(self.config.primary_engine)
            self._primary_engine = EngineFactory.get_or_create(
                self.config.primary_engine,
                config=engine_config
            )
            if self._primary_engine.is_available():
                logger.info(f"Primary OCR engine: {self.config.primary_engine}")
            else:
                # Capture detailed initialization error if available
                init_error = getattr(self._primary_engine, '_init_error', None)
                init_tb = getattr(self._primary_engine, '_init_traceback', '')
                
                error_detail = f"Engine registered but not available"
                if init_error:
                    error_detail = f"{init_error}"
                    if init_tb:
                        # Store first 500 chars of traceback for diagnostics
                        error_detail += f"; Traceback: {init_tb[:500]}"
                
                self._engine_init_errors[self.config.primary_engine] = error_detail
                
                logger.warning(
                    f"Primary engine '{self.config.primary_engine}' registered but not available. "
                    f"Error: {init_error or 'Unknown'}. "
                    f"Install: {EngineFactory.get_package_suggestion(self.config.primary_engine)}"
                )
                self._primary_engine = None
        except ValueError as e:
            self._engine_init_errors[self.config.primary_engine] = f"Not registered: {str(e)}"
            logger.warning(
                f"Primary OCR engine '{self.config.primary_engine}' not registered. "
                f"Install: {EngineFactory.get_package_suggestion(self.config.primary_engine)}. "
                f"Will use fallback engines."
            )
            self._primary_engine = None
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            self._engine_init_errors[self.config.primary_engine] = f"Init exception: {str(e)}; Traceback: {tb[:500]}"
            logger.error(f"Failed to initialize primary engine '{self.config.primary_engine}': {e}")
            self._primary_engine = None
        
        # Create fallback engines
        self._fallback_engines = []
        for engine_name in self.config.fallback_engines:
            try:
                engine_config = self.config.get_engine_config(engine_name)
                engine = EngineFactory.get_or_create(engine_name, config=engine_config)
                if engine.is_available():
                    self._fallback_engines.append(engine)
                    logger.debug(f"Fallback engine available: {engine_name}")
                else:
                    # Capture detailed initialization error
                    init_error = getattr(engine, '_init_error', None)
                    error_detail = init_error or 'Engine not available'
                    self._engine_init_errors[engine_name] = error_detail
                    logger.debug(f"Fallback engine {engine_name} not available: {error_detail}")
            except ValueError as e:
                self._engine_init_errors[engine_name] = f"Not registered: {str(e)}"
                logger.debug(f"Fallback engine {engine_name} not registered: {e}")
            except Exception as e:
                self._engine_init_errors[engine_name] = f"Init exception: {str(e)}"
                logger.debug(f"Fallback engine {engine_name} init failed: {e}")
        
        # Log final configuration with details
        if not self._primary_engine and not self._fallback_engines:
            init_errors_summary = "; ".join([f"{eng}: {err}" for eng, err in self._engine_init_errors.items()])
            logger.warning(
                f"No OCR engines available! Text extraction will use metadata fallback only. "
                f"Initialization errors: {init_errors_summary}. "
                f"Install an OCR engine: pip install rapidocr_onnxruntime"
            )
    
    def _initialize_privacy_filter(self):
        """
        Initialize the privacy filter for redacting sensitive data from OCR text.
        
        The privacy filter detects and redacts:
        - Passwords in URLs and config strings
        - API keys (AWS, GitHub, Stripe, etc.)
        - Private keys and certificates
        - PII (credit cards, SSN, phone numbers) if Presidio is installed
        - High-entropy secrets if detect-secrets is installed
        
        Configure via environment variables:
            PRIVACY_FILTER_ENABLED=true (default)
            PRIVACY_DETECT_PII=true (default - Presidio credit card/SSN/phone detection)
            PRIVACY_MIN_CONFIDENCE=0.7
            PRIVACY_REDACTION_STRATEGY=mask|entity_type|hash|remove
        """
        try:
            from privacy import PrivacyFilter, PrivacyConfig
            
            privacy_config = PrivacyConfig.from_env()
            
            if privacy_config.enabled:
                self._privacy_filter = PrivacyFilter(privacy_config)
                available_detectors = self._privacy_filter.get_available_detectors()
                logger.info(
                    f"Privacy filter initialized with detectors: {available_detectors}"
                )
            else:
                self._privacy_filter = None
                logger.info("Privacy filter disabled by configuration (PRIVACY_FILTER_ENABLED=false)")
                
        except ImportError as e:
            self._privacy_filter = None
            logger.warning(
                f"Privacy module not available: {e}. "
                "Sensitive data in OCR text will NOT be redacted. "
                "Check that privacy/ module exists."
            )
        except Exception as e:
            self._privacy_filter = None
            logger.error(f"Failed to initialize privacy filter: {e}")
    
    def _apply_privacy_filter(self, text: str, engine_name: str) -> Dict[str, Any]:
        """
        Apply privacy filtering to extracted text and log results.
        
        Args:
            text: OCR-extracted text
            engine_name: Name of OCR engine used (for logging context)
            
        Returns:
            Dict with:
                - text: Redacted text
                - privacy_applied: Whether filtering was applied
                - privacy_redactions: Number of redactions made
                - privacy_ms: Processing time in milliseconds
                - privacy_detectors: List of detectors used
        """
        if not self._privacy_filter or not text:
            return {
                'text': text,
                'privacy_applied': False,
                'privacy_redactions': 0,
                'privacy_ms': 0.0,
                'privacy_detectors': []
            }
        
        try:
            result = self._privacy_filter.redact(text)
            
            redactions = result.get('redactions', [])
            redaction_count = result.get('redactions_count', 0)
            processing_ms = result.get('processing_time_ms', 0.0)
            detectors_used = result.get('detectors_used', [])
            
            # Detailed logging for privacy redactions
            if redaction_count > 0:
                logger.warning(
                    f"[PRIVACY] Detected {redaction_count} sensitive item(s) in OCR text from {engine_name}"
                )
                
                # Log each redaction type (without revealing actual content)
                redaction_summary = {}
                for detection in redactions:
                    entity_type = detection.get('entity_type', 'UNKNOWN')
                    redaction_summary[entity_type] = redaction_summary.get(entity_type, 0) + 1
                
                for entity_type, count in redaction_summary.items():
                    logger.warning(
                        f"[PRIVACY]   - {entity_type}: {count} occurrence(s) REDACTED"
                    )
                
                logger.info(
                    f"[PRIVACY] Redaction complete: {redaction_count} items masked "
                    f"(detectors: {detectors_used}, time: {processing_ms:.1f}ms)"
                )
            else:
                logger.debug(
                    f"[PRIVACY] No sensitive data detected in OCR text "
                    f"(checked with: {detectors_used}, time: {processing_ms:.1f}ms)"
                )
            
            return {
                'text': result.get('text', text),
                'privacy_applied': True,
                'privacy_redactions': redaction_count,
                'privacy_ms': processing_ms,
                'privacy_detectors': detectors_used
            }
            
        except Exception as e:
            logger.error(f"[PRIVACY] Privacy filter error: {e}. Returning original text.")
            return {
                'text': text,
                'privacy_applied': False,
                'privacy_redactions': 0,
                'privacy_ms': 0.0,
                'privacy_detectors': [],
                'privacy_error': str(e)
            }
    
    def get_ocr_diagnostics(self) -> Dict[str, Any]:
        """
        Get detailed OCR system diagnostics for debugging deployment issues.
        
        Returns a comprehensive status report including:
        - Available engines and their status
        - Bundled paths (for PyInstaller exe)
        - Configuration details
        - Error messages if engines are unavailable
        - Initialization logs for remote debugging
        
        Useful for debugging OCR failures in deployed applications.
        """
        import sys
        import platform
        from datetime import datetime
        
        diagnostics = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'is_frozen_exe': getattr(sys, 'frozen', False),
            'bundled_path': getattr(sys, '_MEIPASS', None),
            'executable_path': sys.executable if getattr(sys, 'frozen', False) else None,
            'system_info': {
                'platform': platform.system(),
                'platform_version': platform.version(),
                'machine': platform.machine(),
                'python_version': platform.python_version(),
                'hostname': platform.node(),
            },
            'config': {
                'primary_engine': self.config.primary_engine,
                'fallback_engines': self.config.fallback_engines,
                'use_preprocessing': self.config.use_preprocessing,
            },
            'engines': {},
            'privacy_filter': {
                'available': self._privacy_filter is not None,
                'detectors': self._privacy_filter.get_available_detectors() if self._privacy_filter else []
            },
            'initialization_logs': [],
            'recommendations': []
        }
        
        # Check primary engine
        if self._primary_engine:
            diagnostics['engines']['primary'] = {
                'name': self.config.primary_engine,
                'available': self._primary_engine.is_available(),
                'capabilities': self._primary_engine.get_capabilities(),
                'status': 'ready' if self._primary_engine.is_available() else 'unavailable'
            }
        else:
            diagnostics['engines']['primary'] = {
                'name': self.config.primary_engine,
                'available': False,
                'status': 'not_initialized',
                'error': f"Engine '{self.config.primary_engine}' could not be created"
            }
            diagnostics['recommendations'].append(
                f"Install {self.config.primary_engine}: pip install rapidocr_onnxruntime"
            )
        
        # Check fallback engines
        diagnostics['engines']['fallbacks'] = []
        for engine in self._fallback_engines:
            diagnostics['engines']['fallbacks'].append({
                'name': engine.get_name(),
                'available': engine.is_available(),
                'status': 'ready' if engine.is_available() else 'unavailable'
            })
        
        # Check for common deployment issues
        if diagnostics['is_frozen_exe']:
            diagnostics['bundled_dependencies'] = {}
        
        # Collect engine-specific initialization details
        diagnostics['engine_init_details'] = self._get_engine_init_details()
        
        # Include initialization errors (captured during facade setup)
        diagnostics['engine_init_errors'] = dict(self._engine_init_errors) if self._engine_init_errors else {}
        
        # Overall status
        any_engine_available = (
            (self._primary_engine and self._primary_engine.is_available()) or
            any(e.is_available() for e in self._fallback_engines)
        )
        diagnostics['ocr_available'] = any_engine_available
        diagnostics['status'] = 'ready' if any_engine_available else 'no_engines_available'
        
        if not any_engine_available:
            init_error_summary = "; ".join([f"{eng}: {err}" for eng, err in self._engine_init_errors.items()]) if self._engine_init_errors else "Unknown"
            diagnostics['recommendations'].append(
                f"No OCR engines are available. OCR will fall back to metadata-only extraction. "
                f"Text from screenshots will NOT be extracted. "
                f"Initialization errors: {init_error_summary}"
            )
        
        return diagnostics
    
    def _get_engine_init_details(self) -> Dict[str, Any]:
        """
        Get detailed initialization info for each OCR engine.
        Useful for diagnosing why engines are not available.
        """
        details = {}

        # Collect availability details for each active engine
        for engine in [self._primary_engine] + self._fallback_engines:
            if not engine:
                continue
            name = engine.get_name()
            details[name] = {
                'engine_available': engine.is_available(),
                'initialization_error': getattr(engine, '_init_error', None),
            }

        return details
    
    def get_diagnostics_json(self) -> str:
        """
        Get diagnostics as a JSON string for sending to AI server.
        """
        import json
        diag = self.get_ocr_diagnostics()
        return json.dumps(diag, default=str, indent=2)
    
    def log_diagnostics(self):
        """Log OCR diagnostics at INFO level for debugging."""
        diag = self.get_ocr_diagnostics()
        
        logger.info("=" * 60)
        logger.info("OCR DIAGNOSTICS REPORT")
        logger.info("=" * 60)
        logger.info(f"Timestamp: {diag.get('timestamp', 'N/A')}")
        logger.info(f"Running as frozen exe: {diag['is_frozen_exe']}")
        if diag['bundled_path']:
            logger.info(f"Bundled path (_MEIPASS): {diag['bundled_path']}")
        
        # System info
        sys_info = diag.get('system_info', {})
        logger.info(f"System: {sys_info.get('platform')} {sys_info.get('platform_version')}")
        logger.info(f"Machine: {sys_info.get('machine')} | Python: {sys_info.get('python_version')}")
        logger.info(f"Hostname: {sys_info.get('hostname')}")
        
        logger.info(f"Primary engine: {diag['config']['primary_engine']}")
        logger.info(f"Fallback engines: {diag['config']['fallback_engines']}")
        
        # Engine status
        if 'primary' in diag['engines']:
            pe = diag['engines']['primary']
            status = "READY" if pe.get('available') else "UNAVAILABLE"
            logger.info(f"Primary engine ({pe['name']}): {status}")
            if pe.get('error'):
                logger.warning(f"  Error: {pe['error']}")
        
        for fe in diag['engines'].get('fallbacks', []):
            status = "READY" if fe.get('available') else "UNAVAILABLE"
            logger.info(f"Fallback engine ({fe['name']}): {status}")
        
        # Engine initialization details
        if 'engine_init_details' in diag:
            logger.info("-" * 40)
            logger.info("ENGINE INITIALIZATION DETAILS:")
            for eng_name, eng_details in diag['engine_init_details'].items():
                logger.info(f"  [{eng_name.upper()}]")
                logger.info(f"    Engine ready: {eng_details.get('engine_available', 'N/A')}")
                if eng_details.get('initialization_error'):
                    logger.error(f"    Init error: {eng_details.get('initialization_error')}")
        
        # Overall
        logger.info("-" * 40)
        logger.info(f"OCR Status: {diag['status'].upper()}")
        
        # Recommendations
        if diag['recommendations']:
            logger.warning("RECOMMENDATIONS:")
            for rec in diag['recommendations']:
                logger.warning(f"  - {rec}")
        
        logger.info("=" * 60)
        
        return diag

    # For productivity classification, we don't need every line from a code editor.
    # The first N lines are enough to determine what the user is working on.
    MAX_OCR_LINES = 40

    def extract_text(
        self,
        image,
        window_title: str = '',
        app_name: str = '',
        use_preprocessing: bool = True,
        screenshot_mode: bool = False,
        max_lines: int = 0
    ) -> Dict[str, Any]:
        """
        Extract text from image using configured engines with fallback.
        
        Args:
            image: PIL Image, numpy array, or file path
            window_title: Window title (for metadata fallback)
            app_name: Application name (for metadata fallback)
            use_preprocessing: Apply image preprocessing (full pipeline)
            screenshot_mode: Use lightweight preprocessing optimized for screen captures.
                Skips expensive denoising/CLAHE/sharpening and downscales instead.
            max_lines: Maximum text lines to return (0 = unlimited).
                Helps cap processing time for text-heavy screenshots.
        
        Returns:
            Standardized result dict
        """
        effective_max_lines = max_lines or self.MAX_OCR_LINES
        
        # Track all engine failure reasons for detailed error reporting
        engine_failures: Dict[str, str] = {}

        try:
            total_start = time.perf_counter()
            # Convert image to PIL once; preprocessing is done per-engine
            # because different engines need different formats
            pil_image = self._load_image(image)

            engines_to_try = []
            if self._primary_engine and self._primary_engine.is_available():
                engines_to_try.append(self._primary_engine)
            engines_to_try.extend([e for e in self._fallback_engines if e.is_available()])
            
            for engine in engines_to_try:
                engine_name = engine.get_name()
                backoff_until = self._engine_backoff_until.get(engine_name, 0.0)
                if backoff_until > time.time():
                    remaining_seconds = int(backoff_until - time.time())
                    skip_reason = f"Temporary backoff ({remaining_seconds}s remaining due to previous failure)"
                    logger.warning(
                        f"Skipping OCR engine '{engine_name}': {skip_reason}"
                    )
                    engine_failures[engine_name] = skip_reason
                    continue
                engine_config = self.config.get_engine_config(engine_name)
                min_confidence = engine_config.min_confidence
                
                logger.debug(f"Trying OCR engine: {engine_name}")

                prep_start = time.perf_counter()
                img_array = self._prepare_image(
                    pil_image, use_preprocessing, screenshot_mode,
                    engine_hint=engine_name
                )
                prep_ms = (time.perf_counter() - prep_start) * 1000.0
                
                try:
                    infer_start = time.perf_counter()
                    result = engine.extract_text(img_array)
                    infer_ms = (time.perf_counter() - infer_start) * 1000.0
                    
                    if result.get('success') and result.get('confidence', 0) >= min_confidence:
                        text = result.get('text', '')
                        line_count = result.get('line_count', 0)

                        if effective_max_lines and line_count > effective_max_lines:
                            text_lines = text.split('\n')[:effective_max_lines]
                            text = '\n'.join(text_lines)
                            line_count = len(text_lines)

                        self._engine_failure_counts[engine_name] = 0
                        self._engine_backoff_until.pop(engine_name, None)
                        
                        # Apply privacy filter to redact sensitive information
                        privacy_result = self._apply_privacy_filter(text, engine_name)
                        filtered_text = privacy_result['text']
                        
                        logger.info(
                            f"OCR succeeded with {engine_name} "
                            f"(confidence: {result['confidence']:.2f}, lines: {line_count}, "
                            f"prep: {prep_ms:.1f}ms, infer: {infer_ms:.1f}ms, "
                            f"privacy: {privacy_result['privacy_ms']:.1f}ms, "
                            f"total: {(time.perf_counter() - total_start) * 1000.0:.1f}ms)"
                        )
                        return {
                            'text': filtered_text,
                            'confidence': result.get('confidence', 0.0),
                            'method': engine_name,
                            'success': True,
                            'prep_ms': prep_ms,
                            'infer_ms': infer_ms,
                            'privacy_ms': privacy_result['privacy_ms'],
                            'privacy_applied': privacy_result['privacy_applied'],
                            'privacy_redactions': privacy_result['privacy_redactions'],
                            'privacy_detectors': privacy_result.get('privacy_detectors', []),
                            'total_ms': (time.perf_counter() - total_start) * 1000.0,
                            'window_title': window_title,
                            'app_name': app_name,
                            'line_count': line_count,
                            'boxes': result.get('boxes')
                        }
                    else:
                        conf = result.get('confidence', 0)
                        fail_reason = f"Confidence too low ({conf:.2f} < {min_confidence} threshold)"
                        logger.debug(
                            f"{engine_name}: {fail_reason} "
                            f"(prep: {prep_ms:.1f}ms, infer: {infer_ms:.1f}ms)"
                        )
                        engine_failures[engine_name] = fail_reason
                        
                except Exception as e:
                    error_str = str(e)
                    logger.warning(f"Engine {engine_name} failed: {error_str}")
                    engine_failures[engine_name] = f"Exception: {error_str}"
                    self._engine_failure_counts[engine_name] = self._engine_failure_counts.get(engine_name, 0) + 1
                    continue
            
            # Build detailed error message for metadata fallback
            if engine_failures:
                error_details = "; ".join([f"{eng}: {reason}" for eng, reason in engine_failures.items()])
                logger.warning(f"All OCR engines failed. Details: {error_details}")
            else:
                # Include initialization errors for detailed diagnostics
                if self._engine_init_errors:
                    init_errors = "; ".join([f"{eng}: {err}" for eng, err in self._engine_init_errors.items()])
                    error_details = f"No OCR engines available. Initialization errors: {init_errors}"
                else:
                    error_details = "No OCR engines available or configured"
                logger.warning(f"All OCR engines failed or below threshold, using metadata fallback. {error_details}")
            
            fallback = self._create_metadata_fallback(window_title, app_name, error_details)
            fallback['total_ms'] = (time.perf_counter() - total_start) * 1000.0
            return fallback
            
        except Exception as e:
            import traceback
            error_tb = traceback.format_exc()
            logger.error(f"Text extraction failed: {e}")
            logger.error(f"Full traceback:\n{error_tb}")
            return {
                'text': '',
                'confidence': 0.0,
                'method': 'error',
                'success': False,
                'error_message': f"{str(e)}; Traceback: {error_tb[:500]}",
                'total_ms': (time.perf_counter() - total_start) * 1000.0 if 'total_start' in locals() else None,
                'window_title': window_title,
                'app_name': app_name,
                'line_count': 0,
                'privacy_applied': False,
                'privacy_redactions': 0,
                'privacy_ms': 0.0,
                'privacy_detectors': []
            }

    def _load_image(self, image) -> Image.Image:
        """Convert any image input to PIL Image."""
        if isinstance(image, str):
            return Image.open(image)
        elif isinstance(image, np.ndarray):
            return Image.fromarray(image)
        return image
    
    def _prepare_image(
        self, image: Image.Image, use_preprocessing: bool,
        screenshot_mode: bool = False, engine_hint: str = ''
    ) -> np.ndarray:
        """
        Preprocess image for a specific OCR engine.

        In screenshot_mode, applies lightweight preprocessing (downscale only).
        
        In document mode (use_preprocessing=True), runs the full heavy pipeline
        regardless of engine (grayscale, CLAHE, denoise, sharpen).

        Args:
            image: PIL Image
            use_preprocessing: Apply full preprocessing (for scanned docs)
            screenshot_mode: Use lightweight screenshot preprocessing
            engine_hint: Engine name for engine-specific preprocessing
        
        Returns:
            Preprocessed numpy array
        """
        if screenshot_mode:
            return preprocess_screenshot(image, engine_hint=engine_hint)
        elif use_preprocessing and self.config.use_preprocessing:
            processed = preprocess_image(image)
        else:
            processed = np.array(image)
        
        processed = resize_if_needed(processed, max_dimension=self.config.max_image_dimension)
        
        return processed
    
    def _create_metadata_fallback(
        self,
        window_title: str,
        app_name: str,
        error_message: str = ''
    ) -> Dict[str, Any]:
        """
        Create metadata fallback result when OCR fails.
        
        Args:
            window_title: Window title
            app_name: Application name
            error_message: Detailed reason why OCR failed
        
        Returns:
            Fallback result dict
        """
        return {
            'text': '',
            'confidence': 0.0,
            'method': 'metadata',
            'success': False,
            'error_message': error_message or 'OCR engines unavailable',
            'window_title': window_title,
            'app_name': app_name,
            'line_count': 0,
            'privacy_applied': False,
            'privacy_redactions': 0,
            'privacy_ms': 0.0,
            'privacy_detectors': []
        }
    
    def get_available_engines(self) -> Dict[str, bool]:
        """
        Get available OCR engines and their status.
        
        Returns:
            Dict mapping engine name to availability
        """
        return EngineFactory.get_available_engines()
    
    def get_current_config(self) -> Dict[str, Any]:
        """
        Get current configuration as dictionary.
        
        Returns:
            Configuration dict
        """
        return self.config.to_dict()


# Global facade instance (lazy initialization)
_facade_instance: Optional[OCRFacade] = None


def reset_facade() -> None:
    """
    Reset the global OCRFacade singleton and engine cache.

    Call this after updating OCR environment variables at runtime (e.g. after
    fetching fresh config from the AI server) so that the next OCR call picks
    up the new configuration instead of reusing the stale startup singleton.
    """
    global _facade_instance
    _facade_instance = None
    EngineFactory.clear_cache()
    logger.info("OCR facade and engine cache reset — will reinitialise on next OCR call")


def get_facade(config: Optional[OCRConfig] = None) -> OCRFacade:
    """
    Get or create global OCRFacade instance.
    
    Args:
        config: Optional configuration (uses env if None)
    
    Returns:
        OCRFacade singleton instance
    """
    global _facade_instance
    
    if _facade_instance is None or config is not None:
        _facade_instance = OCRFacade(config)
        # Log diagnostics on first initialization to help debug OCR issues
        _facade_instance.log_diagnostics()
    
    return _facade_instance


def extract_text_from_image(
    image,
    window_title: str = '',
    app_name: str = '',
    use_preprocessing: bool = True,
    screenshot_mode: bool = False,
    max_lines: int = 0
) -> Dict[str, Any]:
    """
    Extract text from image - BACKWARD COMPATIBLE function.
    
    This is the main entry point that maintains compatibility with
    existing code while using the new facade architecture.
    
    Args:
        image: PIL Image, numpy array, or file path
        window_title: Window title for metadata fallback
        app_name: Application name for metadata fallback
        use_preprocessing: Apply full image preprocessing (for scanned docs)
        screenshot_mode: Use lightweight preprocessing for screen captures.
            Skips expensive denoising/CLAHE/sharpening (~300-800ms savings).
        max_lines: Maximum text lines to return (0 = use default cap of 40)
    
    Returns:
        dict with text, confidence, method, success, line_count, etc.
    
    Example:
        from ocr import extract_text_from_image
        
        # For live screen captures (fast):
        result = extract_text_from_image(screenshot, screenshot_mode=True)
        
        # For scanned documents (thorough):
        result = extract_text_from_image(document_scan, use_preprocessing=True)
    """
    facade = get_facade()
    return facade.extract_text(
        image,
        window_title=window_title,
        app_name=app_name,
        use_preprocessing=use_preprocessing,
        screenshot_mode=screenshot_mode,
        max_lines=max_lines
    )


# NOTE: reset_facade() is defined earlier in this file (around line 907) and properly
# clears both _facade_instance AND the EngineFactory cache. Do NOT redefine it here.
