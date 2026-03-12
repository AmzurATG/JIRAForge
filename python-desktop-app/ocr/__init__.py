"""
OCR Module for JIRAForge Time Tracker - Linux Hybrid OCR Approach

Provides local text extraction from screenshots using multiple OCR engines
with automatic fallback:
1. PaddleOCR (Primary) - Best accuracy for screen text
2. Tesseract (Fallback) - Widely available, good fallback
3. Metadata (Last Resort) - Window title/app name only

This module enables the Hybrid OCR approach which:
- Extracts text locally (no image upload to cloud)
- Reduces bandwidth by 96-99%
- Reduces AI costs by 85-96%
- Improves privacy (screenshots never leave device)
"""

from .facade import OCRFacade, extract_text_from_image
from .config import OCRConfig

__all__ = ['OCRFacade', 'extract_text_from_image', 'OCRConfig']
