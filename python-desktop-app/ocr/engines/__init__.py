"""
OCR Engines Package

Contains adapters for various OCR engines, all implementing BaseOCREngine.
"""
# Import engine classes for convenient access (all optional)
__all__ = []

try:
    from .mock_engine import MockOCREngine
    __all__.append('MockOCREngine')
except ImportError:
    MockOCREngine = None
