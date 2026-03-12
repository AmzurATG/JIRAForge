"""OCR Engine implementations"""

from .base import BaseOCREngine, OCRResult
from .paddle_engine import PaddleOCREngine
from .tesseract_engine import TesseractOCREngine
from .metadata_engine import MetadataOCREngine

__all__ = [
    'BaseOCREngine',
    'OCRResult',
    'PaddleOCREngine',
    'TesseractOCREngine',
    'MetadataOCREngine'
]
