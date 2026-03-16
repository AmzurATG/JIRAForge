"""
RapidOCR Engine — lightweight ONNX-based OCR via rapidocr_onnxruntime.

This provides a first-class engine for RapidOCR so it is auto-discovered
by the engine factory (via *_engine.py scanning) instead of relying on
the dynamic engine path and AI-server env vars.
"""

import logging
from typing import Dict, Any, Optional

import numpy as np

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)

_RAPIDOCR_AVAILABLE = False
_IMPORT_ERROR: Optional[str] = None

try:
    from rapidocr_onnxruntime import RapidOCR as _RapidOCR
    _RAPIDOCR_AVAILABLE = True
except ImportError as e:
    _IMPORT_ERROR = str(e)


class RapidOCREngine(BaseOCREngine):
    """
    RapidOCR engine using rapidocr_onnxruntime.

    Lightweight, CPU-friendly OCR with no external binary requirements.
    Works well as a fallback engine alongside WinRT OCR.
    """

    def __init__(
        self,
        use_gpu: bool = False,
        language: str = 'en',
        min_confidence: float = 0.5,
        **kwargs,
    ):
        self.min_confidence = min_confidence
        self._ocr: Optional[object] = None
        self._init_error: Optional[str] = _IMPORT_ERROR

    def get_name(self) -> str:
        return 'rapidocr'

    def is_available(self) -> bool:
        if _RAPIDOCR_AVAILABLE:
            return True
        self._init_error = (
            f"rapidocr_onnxruntime not installed. "
            f"Install with: pip install rapidocr-onnxruntime"
        )
        return False

    def _get_ocr(self):
        """Lazily create and cache the RapidOCR instance."""
        if self._ocr is None and _RAPIDOCR_AVAILABLE:
            self._ocr = _RapidOCR()
            logger.info("RapidOCR engine initialized")
        return self._ocr

    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        if not self.is_available():
            return self._create_error_result('RapidOCR not available')

        try:
            ocr = self._get_ocr()
            if ocr is None:
                return self._create_error_result('Failed to initialize RapidOCR')

            result = ocr(image)

            if not result or not result[0]:
                return self._create_success_result(text='', confidence=0.0)

            lines = result[0]
            texts = []
            confidences = []

            for line in lines:
                # Each line is (bbox, text, confidence)
                text = line[1]
                conf = float(line[2])
                if conf >= self.min_confidence:
                    texts.append(text)
                    confidences.append(conf)

            full_text = '\n'.join(texts)
            avg_conf = sum(confidences) / len(confidences) if confidences else 0.0

            return self._create_success_result(text=full_text, confidence=avg_conf)

        except Exception as e:
            logger.error(f"RapidOCR extraction failed: {e}")
            return self._create_error_result(str(e))

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            'gpu_support': False,
            'languages': ['en', 'ch'],
            'confidence_scores': True,
            'bounding_boxes': True,
            'batch_processing': False,
            'async_processing': False,
        }
