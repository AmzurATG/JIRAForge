"""
OCR Module for JIRAForge Desktop App v2.0

Engine-agnostic text extraction with swappable OCR backends.
Implements Facade pattern for unified interface with fallback support.

Configure via environment variables:
    OCR_PRIMARY_ENGINE=rapidocr
    OCR_FALLBACK_ENGINES=winrtocr
    OCR_RAPIDOCR_MIN_CONFIDENCE=0.6
    OCR_WINRT_MIN_CONFIDENCE=0.5

Usage (Simple):
    from ocr import extract_text_from_image
    result = extract_text_from_image(screenshot)

Usage (Advanced):
    from ocr import get_facade, OCRConfig
    
    config = OCRConfig()
    config.primary_engine = 'rapidocr'
    facade = get_facade(config)
    result = facade.extract_text(image)
"""

__version__ = '2.0.0'

# Main API - backward compatible
from .facade import extract_text_from_image, get_facade, reset_facade, OCRFacade

# Configuration classes
from .config import OCRConfig, OCREngineConfig

# Engine infrastructure (for extensions)
from .engine_factory import EngineFactory
from .base_engine import BaseOCREngine

# Image processing utilities
from .image_processor import preprocess_image, preprocess_screenshot, resize_if_needed

# Available engines (for direct access if needed — all optional)
from .engines import MockOCREngine

__all__ = [
    # Main API
    'extract_text_from_image',
    'get_facade',
    'reset_facade',
    'OCRFacade',
    
    # Configuration
    'OCRConfig',
    'OCREngineConfig',
    
    # Engine infrastructure
    'EngineFactory',
    'BaseOCREngine',
    
    # Image processing
    'preprocess_image',
    'preprocess_screenshot',
    'resize_if_needed',
    
    # Version
    '__version__',
]

if globals().get('MockOCREngine') is not None:
    __all__.append('MockOCREngine')
