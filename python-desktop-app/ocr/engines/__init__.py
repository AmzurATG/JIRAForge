"""
OCR Engines Package

Contains adapters for various OCR engines, all implementing BaseOCREngine.
"""
# Import engine classes for convenient access (all optional)
__all__ = []

try:
    from .paddle_engine import PaddleOCREngine
    __all__.append('PaddleOCREngine')
except ImportError:
    PaddleOCREngine = None

try:
    from .tesseract_engine import TesseractEngine
    __all__.append('TesseractEngine')
except ImportError:
    TesseractEngine = None

try:
    from .mock_engine import MockOCREngine
    __all__.append('MockOCREngine')
except ImportError:
    MockOCREngine = None
