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

# Recognition costs ~0.1-0.3 s per text box on a laptop CPU and dominates OCR time.
# The facade keeps only the first MAX_OCR_LINES (40) lines, so boxes beyond this
# (a little headroom for low-confidence drops) were recognised and then discarded.
DEFAULT_MAX_TEXT_BOXES = 48

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
        max_text_boxes: int = DEFAULT_MAX_TEXT_BOXES,
        **kwargs,
    ):
        self.min_confidence = min_confidence
        self.max_text_boxes = max_text_boxes
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
            self._cap_text_boxes(self._ocr)
            logger.info("RapidOCR engine initialized")
        return self._ocr

    def _cap_text_boxes(self, ocr) -> None:
        """Recognise only the first max_text_boxes detected boxes (reading order).

        auto_text_det() returns boxes sorted top-to-bottom, left-to-right, so the
        kept boxes are exactly the lines the facade would keep. Skipped if the
        installed rapidocr_onnxruntime has no auto_text_det (unpinned dependency).
        """
        limit = self.max_text_boxes
        detect = getattr(ocr, 'auto_text_det', None)
        if not limit or limit <= 0 or detect is None:
            return

        def capped_detect(img):
            boxes, elapse = detect(img)
            if boxes is not None and len(boxes) > limit:
                boxes = boxes[:limit]
            return boxes, elapse

        ocr.auto_text_det = capped_detect

    @staticmethod
    def _to_bgr(image: np.ndarray) -> np.ndarray:
        """RapidOCR follows the OpenCV convention (BGR); PIL-based callers pass RGB/RGBA."""
        import cv2
        if image.ndim == 2:
            return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        if image.ndim == 3 and image.shape[2] == 4:
            return cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
        if image.ndim == 3 and image.shape[2] == 3:
            return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        return image

    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        if not self.is_available():
            return self._create_error_result('RapidOCR not available')

        try:
            ocr = self._get_ocr()
            if ocr is None:
                return self._create_error_result('Failed to initialize RapidOCR')

            if isinstance(image, np.ndarray):
                image = self._to_bgr(image)
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
