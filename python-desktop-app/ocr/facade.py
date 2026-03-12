"""OCR Facade - Unified interface with automatic fallback"""

import time
import threading
from typing import Optional, Dict
from datetime import datetime, timedelta
from PIL import Image

from .engines.base import OCRResult
from .engines.paddle_engine import PaddleOCREngine
from .engines.tesseract_engine import TesseractOCREngine
from .engines.metadata_engine import MetadataOCREngine
from .image_processor import preprocess_screenshot
from .privacy_filter import PrivacyFilter
from .config import OCRConfig


class OCRFacade:
    """
    Unified OCR interface with automatic engine selection and fallback.
    
    This is the main entry point for OCR in the Hybrid OCR approach.
    It handles:
    - Engine selection and fallback (PaddleOCR -> Tesseract -> Metadata)
    - Privacy filtering (redacts sensitive data before upload)
    - Image preprocessing
    - Engine health tracking (backoff after failures)
    
    Fallback chain:
    1. PaddleOCR (Primary) - Best accuracy
    2. Tesseract (Fallback 1) - Widely available
    3. Metadata (Fallback 2) - Window title/app only
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self._paddle = PaddleOCREngine.get_instance()
        self._tesseract = TesseractOCREngine()
        self._metadata = MetadataOCREngine()
        self._privacy_filter = PrivacyFilter(enabled=OCRConfig.PRIVACY_FILTER_ENABLED)
        
        # Engine backoff tracking
        self._engine_failures: Dict[str, datetime] = {}
        
        # Stats tracking
        self._stats = {
            'paddle_success': 0,
            'paddle_failure': 0,
            'tesseract_success': 0,
            'tesseract_failure': 0,
            'metadata_fallback': 0,
            'privacy_skipped': 0,
        }
    
    @classmethod
    def get_instance(cls) -> 'OCRFacade':
        """Get singleton instance"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
    
    def _is_engine_in_backoff(self, engine_name: str) -> bool:
        """Check if engine is in backoff period after failure"""
        if engine_name not in self._engine_failures:
            return False
        
        backoff_until = self._engine_failures[engine_name]
        if datetime.now() < backoff_until:
            return True
        
        # Backoff expired, reset
        del self._engine_failures[engine_name]
        return False
    
    def _record_engine_failure(self, engine_name: str):
        """Record engine failure for backoff"""
        backoff_seconds = OCRConfig.ENGINE_BACKOFF_SECONDS
        self._engine_failures[engine_name] = datetime.now() + timedelta(seconds=backoff_seconds)
        print(f"[OCR] {engine_name} engine in backoff for {backoff_seconds}s")
    
    def extract_text(
        self,
        image: Image.Image,
        window_title: str = '',
        app_name: str = '',
        apply_privacy_filter: bool = True
    ) -> OCRResult:
        """
        Extract text from image with automatic fallback.
        
        This is the main method to use for OCR extraction.
        
        Args:
            image: PIL Image to process
            window_title: Window title for metadata fallback
            app_name: Application name for metadata fallback
            apply_privacy_filter: Whether to filter sensitive data
            
        Returns:
            OCRResult with extracted text
        """
        # Check if we should skip OCR entirely for privacy
        should_skip, reason = self._privacy_filter.should_skip_ocr(window_title, app_name)
        if should_skip:
            print(f"[OCR] Skipping OCR for privacy: {reason}")
            self._stats['privacy_skipped'] += 1
            self._metadata.set_metadata(window_title, app_name)
            return self._metadata.extract_text()
        
        # Update metadata engine with current context
        self._metadata.set_metadata(window_title, app_name)
        
        # Try engines in order
        engines = [
            ('paddle', self._paddle, 'paddle'),
            ('tesseract', self._tesseract, 'tesseract'),
            ('metadata', self._metadata, None),
        ]
        
        for name, engine, preprocess_hint in engines:
            # Skip if in backoff
            if self._is_engine_in_backoff(name):
                continue
            
            # Skip if not available
            if not engine.is_available:
                continue
            
            try:
                # Preprocess image for this engine
                if preprocess_hint:
                    processed_image = preprocess_screenshot(image, preprocess_hint)
                else:
                    processed_image = image
                
                # Extract text
                result = engine.extract_text(processed_image)
                
                # Check quality
                if result.is_valid(OCRConfig.MIN_CONFIDENCE, OCRConfig.MIN_TEXT_LENGTH):
                    # Apply privacy filter
                    if apply_privacy_filter and result.text:
                        filtered_text, redactions = self._privacy_filter.filter_text(result.text)
                        if redactions:
                            print(f"[OCR] Privacy filter applied: {', '.join(redactions[:3])}")
                        result = OCRResult(
                            text=filtered_text,
                            confidence=result.confidence,
                            method=result.method,
                            line_count=result.line_count,
                            word_count=len(filtered_text.split()),
                            processing_time_ms=result.processing_time_ms,
                            bounding_boxes=result.bounding_boxes
                        )
                    
                    # Track success
                    if name == 'paddle':
                        self._stats['paddle_success'] += 1
                    elif name == 'tesseract':
                        self._stats['tesseract_success'] += 1
                    
                    print(f"[OCR] {name} succeeded: {result.line_count} lines, {result.confidence:.2f} confidence, {result.processing_time_ms:.0f}ms")
                    return result
                
                # Low quality result - try next engine
                print(f"[OCR] {name} low quality (conf={result.confidence:.2f}, len={len(result.text)})")
                
            except Exception as e:
                print(f"[OCR] {name} failed: {e}")
                if name == 'paddle':
                    self._stats['paddle_failure'] += 1
                elif name == 'tesseract':
                    self._stats['tesseract_failure'] += 1
                
                if name != 'metadata':
                    self._record_engine_failure(name)
        
        # All engines failed - return metadata result
        print("[OCR] All engines failed, returning metadata only")
        self._stats['metadata_fallback'] += 1
        return self._metadata.extract_text()
    
    def get_stats(self) -> Dict:
        """Get OCR processing statistics"""
        return self._stats.copy()
    
    def reset_stats(self):
        """Reset processing statistics"""
        for key in self._stats:
            self._stats[key] = 0
    
    def get_engine_status(self) -> Dict:
        """Get status of all OCR engines"""
        return {
            'paddle': {
                'available': self._paddle.is_available,
                'in_backoff': self._is_engine_in_backoff('paddle'),
            },
            'tesseract': {
                'available': self._tesseract.is_available,
                'in_backoff': self._is_engine_in_backoff('tesseract'),
            },
            'metadata': {
                'available': True,
                'in_backoff': False,
            },
        }


# Convenience function for direct import
def extract_text_from_image(
    image: Image.Image,
    window_title: str = '',
    app_name: str = ''
) -> OCRResult:
    """
    Extract text from screenshot image.
    
    Convenience wrapper around OCRFacade.
    
    Args:
        image: PIL Image to process
        window_title: Window title for context
        app_name: Application name for context
        
    Returns:
        OCRResult with extracted text
    """
    facade = OCRFacade.get_instance()
    return facade.extract_text(image, window_title, app_name)
