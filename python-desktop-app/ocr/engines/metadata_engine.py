"""Metadata Engine - Last Resort Fallback"""

import time
from PIL import Image

from .base import BaseOCREngine, OCRResult


class MetadataOCREngine(BaseOCREngine):
    """
    Metadata-based "OCR" - uses window title and app name only.
    Used as last resort when all OCR engines fail.
    Provides some context for AI analysis even without screen text.
    """
    
    def __init__(self, window_title: str = '', app_name: str = ''):
        self._window_title = window_title
        self._app_name = app_name
    
    def set_metadata(self, window_title: str, app_name: str):
        """Update metadata for extraction"""
        self._window_title = window_title
        self._app_name = app_name
    
    @property
    def name(self) -> str:
        return 'metadata'
    
    @property
    def is_available(self) -> bool:
        return True  # Always available
    
    def extract_text(self, image: Image.Image = None) -> OCRResult:
        """Return window metadata as text"""
        start_time = time.time()
        
        # Combine metadata into text
        parts = []
        if self._app_name:
            parts.append(f"Application: {self._app_name}")
        if self._window_title:
            parts.append(f"Window: {self._window_title}")
        
        text = '\n'.join(parts)
        
        processing_time = (time.time() - start_time) * 1000
        
        return OCRResult(
            text=text,
            confidence=0.5 if text else 0.0,  # Lower confidence for metadata
            method=self.name,
            line_count=len(parts),
            word_count=len(text.split()),
            processing_time_ms=processing_time,
            error_message="OCR unavailable - using window metadata only" if not text else None
        )
