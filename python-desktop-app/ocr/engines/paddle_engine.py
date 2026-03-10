"""
PaddleOCR Engine Adapter

Wraps PaddleOCR library to comply with BaseOCREngine interface.
Implements singleton pattern to avoid reloading expensive models.

Supports both PaddleOCR 2.x (legacy) and 3.x (new) APIs.
"""
import os
import sys
import numpy as np
from PIL import Image
import logging
from typing import Dict, Any, Optional

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


def _apply_platform_safe_runtime_defaults():
    """Apply OS-aware Paddle runtime stability defaults.

    These defaults are intentionally conservative and only applied when the
    user/environment has not explicitly set a value.

    - Windows: known to hit intermittent oneDNN/MKL primitive execution issues
      in some CPU environments. Disable MKLDNN but allow multi-threading.
    - Linux/macOS: keep defaults unless user configured values.
    """
    import os
    cpu_count = os.cpu_count() or 4
    # Use quarter of available cores, min 1, max 2 — OCR runs on a low-priority
    # background thread now, so fewer inference threads reduces CPU saturation.
    default_threads = str(min(2, max(1, cpu_count // 4)))
    
    def _detect_paddle_gpu_support():
        """Best-effort GPU capability check without hard failing startup."""
        try:
            import paddle  # type: ignore
            if not paddle.is_compiled_with_cuda():
                return False
            try:
                return paddle.device.cuda.device_count() > 0
            except Exception:
                # If device count probe fails, still allow CUDA build as signal.
                return True
        except Exception:
            return False

    if sys.platform == 'win32':
        # Auto-enable GPU on supported systems unless explicitly overridden.
        default_use_gpu = 'true' if _detect_paddle_gpu_support() else 'false'
        os.environ.setdefault('OCR_PADDLE_USE_GPU', default_use_gpu)
        os.environ.setdefault('FLAGS_use_mkldnn', '0')
        # Limit both OpenMP and MKL thread pools to prevent CPU saturation during inference.
        # MKL_NUM_THREADS is needed separately because Intel MKL has its own thread pool
        # that does not always honour OMP_NUM_THREADS on Windows.
        os.environ.setdefault('OMP_NUM_THREADS', default_threads)
        os.environ.setdefault('MKL_NUM_THREADS', default_threads)
        # OpenBLAS thread pool — needed if PaddlePaddle was built against OpenBLAS
        # instead of MKL (build-dependent; safe to set both).
        os.environ.setdefault('OPENBLAS_NUM_THREADS', default_threads)
        logger.info(
            f"Applied Windows Paddle defaults "
            f"(OCR_PADDLE_USE_GPU={os.environ.get('OCR_PADDLE_USE_GPU')}, "
            f"FLAGS_use_mkldnn=0, OMP/MKL/OPENBLAS_NUM_THREADS={default_threads})"
        )
    elif sys.platform == 'darwin':
        # Keep compatible threading on macOS.
        os.environ.setdefault('OMP_NUM_THREADS', default_threads)
    else:
        # Linux and other platforms: no forced MKLDNN/GPU overrides.
        pass


_apply_platform_safe_runtime_defaults()

# Check if PaddleOCR is available and detect version
_PADDLEOCR_AVAILABLE = False
_PADDLEOCR_VERSION = None
try:
    from paddleocr import PaddleOCR
    import paddleocr
    _PADDLEOCR_AVAILABLE = True
    _PADDLEOCR_VERSION = getattr(paddleocr, '__version__', '2.0.0')
    logger.debug(f"PaddleOCR version: {_PADDLEOCR_VERSION}")
except ImportError:
    logger.debug("PaddleOCR not installed. Install with: pip install paddlepaddle paddleocr")


class PaddleOCREngine(BaseOCREngine):
    """
    PaddleOCR engine adapter implementing BaseOCREngine interface.
    
    Uses singleton pattern to avoid reloading models on every instantiation.
    Wraps PaddleOCR's PP-OCRv5 models for text detection and recognition.
    
    Configuration via environment variables:
        OCR_PADDLE_USE_GPU: true/false (default: false)
        OCR_PADDLE_LANGUAGE: en, ch, etc. (default: en)
        OCR_PADDLE_MIN_CONFIDENCE: 0.0-1.0 (default: 0.5)
    
    Or via OCREngineConfig:
        config.engines['paddle'] = OCREngineConfig(
            name='paddle',
            use_gpu=True,
            language='ch'
        )
    """
    
    _instance: Optional['PaddleOCREngine'] = None
    _ocr = None  # PaddleOCR instance
    
    def __new__(cls, *args, **kwargs):
        """Singleton pattern - reuse model instance"""
        if cls._instance is None:
            cls._instance = super(PaddleOCREngine, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(
        self,
        use_gpu: bool = False,
        language: str = 'en',
        min_confidence: float = 0.5,
        **extra_params
    ):
        """
        Initialize PaddleOCR engine.
        
        Args:
            use_gpu: Use GPU acceleration
            language: OCR language ('en', 'ch', 'ja', etc.)
            min_confidence: Minimum confidence threshold (for filtering)
            **extra_params: Additional PaddleOCR parameters
        """
        if getattr(self, '_initialized', False):
            return
        
        self.use_gpu = use_gpu
        self.language = language
        self.min_confidence = min_confidence
        self.extra_params = extra_params
        
        if _PADDLEOCR_AVAILABLE:
            try:
                # Detect PaddleOCR version and use appropriate parameters
                major_version = int(_PADDLEOCR_VERSION.split('.')[0]) if _PADDLEOCR_VERSION else 2
                init_kwargs = {'lang': language}

                if major_version >= 3:
                    # PaddleOCR 3.x: uses use_textline_orientation
                    # For screenshots, text is horizontal. Disabling saves memory/time.
                    init_kwargs['use_textline_orientation'] = False
                else:
                    # PaddleOCR 2.x: uses use_angle_cls
                    init_kwargs['use_angle_cls'] = False
                    init_kwargs['show_log'] = False

                # Stability fix: disable MKLDNN on Windows to prevent "primitive" errors
                if sys.platform == 'win32':
                    init_kwargs['enable_mkldnn'] = False

                # Limit Paddle's internal inference thread pool to prevent CPU saturation.
                # OMP_NUM_THREADS controls OpenMP; cpu_threads controls Paddle's own pool.
                # Without this, PaddleOCR claims all CPU cores even on a low-priority thread,
                # causing system-wide keyboard/UI lag during inference.
                cpu_count = os.cpu_count() or 4
                paddle_threads = min(2, max(1, cpu_count // 4))
                init_kwargs['cpu_threads'] = paddle_threads
                logger.info(f"PaddleOCR will use {paddle_threads} CPU inference thread(s)")

                # Respect configuration: GPU can significantly reduce inference time.
                # Some PaddleOCR versions may not accept use_gpu, so retry safely.
                if use_gpu:
                    init_kwargs['use_gpu'] = True

                try:
                    self._ocr = PaddleOCR(**init_kwargs)
                except TypeError as param_error:
                    if 'use_gpu' in init_kwargs:
                        logger.warning(
                            f"PaddleOCR init does not accept use_gpu on this version "
                            f"({_PADDLEOCR_VERSION}); retrying on CPU. Error: {param_error}"
                        )
                        init_kwargs.pop('use_gpu', None)
                        self._ocr = PaddleOCR(**init_kwargs)
                    else:
                        raise

                logger.info(
                    f"PaddleOCR initialized (Lang: {language}, GPU: {use_gpu}, "
                    f"Version: {_PADDLEOCR_VERSION})"
                )
            except Exception as e:
                logger.error(f"Failed to initialize PaddleOCR: {e}")
                self._ocr = None
        
        self._initialized = True
    
    def get_name(self) -> str:
        """Return engine identifier"""
        return 'paddle'
    
    def is_available(self) -> bool:
        """Check if PaddleOCR is installed and working"""
        if not _PADDLEOCR_AVAILABLE:
            return False
        return self._ocr is not None
    
    def get_capabilities(self) -> Dict[str, Any]:
        """Return PaddleOCR capabilities"""
        return {
            'gpu_support': True,
            'languages': ['en', 'ch', 'japan', 'korean', 'french', 'german'],
            'confidence_scores': True,
            'bounding_boxes': True,
            'batch_processing': False,
            'async_processing': False,
            'angle_detection': True,
            'multi_line': True
        }
    
    def extract_text(self, image: np.ndarray, skip_angle_cls: bool = False) -> Dict[str, Any]:
        """
        Extract text from image using PaddleOCR.
        
        Args:
            image: numpy array (BGR or RGB)
            skip_angle_cls: Skip angle classification (saves ~10ms/line).
                Safe for screen captures where text is always horizontal.
        
        Returns:
            Standardized result dict
        """
        if not self.is_available():
            return self._create_error_result("PaddleOCR not available. Install: pip install paddlepaddle paddleocr")
        
        try:
            img_array = self._convert_image(image)
            
            major_version = int(_PADDLEOCR_VERSION.split('.')[0]) if _PADDLEOCR_VERSION else 2
            
            lines = []
            confidences = []
            boxes = []
            
            if major_version >= 3:
                try:
                    result_gen = self._ocr.predict(img_array)
                    result_list = list(result_gen)
                    
                    for res in result_list:
                        if hasattr(res, 'rec_texts'):
                            texts = res.rec_texts or []
                            scores = res.rec_scores or []
                            det_boxes = getattr(res, 'dt_polys', []) or []
                            
                            for i, text in enumerate(texts):
                                if text:
                                    lines.append(str(text))
                                    if i < len(scores):
                                        confidences.append(float(scores[i]))
                                    if i < len(det_boxes):
                                        boxes.append(det_boxes[i])
                except Exception as e:
                    logger.debug(f"PaddleOCR 3.x predict() failed: {e}, trying legacy ocr()")
                    major_version = 2
            
            if major_version < 3 or not lines:
                # cls=False skips the angle classifier (~10ms per line saved)
                use_cls = not skip_angle_cls
                result = self._ocr.ocr(img_array, cls=use_cls)
                
                if result and result[0]:
                    for line in result[0]:
                        if line and len(line) >= 2:
                            text = line[1][0]
                            conf = line[1][1]
                            box = line[0]
                            
                            lines.append(str(text))
                            confidences.append(float(conf))
                            boxes.append(box)
            
            if not lines:
                logger.debug("PaddleOCR: No text extracted")
                return {
                    'text': '',
                    'confidence': 0.0,
                    'line_count': 0,
                    'success': False,
                    'engine': self.get_name()
                }
            
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            logger.debug(f"PaddleOCR: Extracted {len(lines)} lines (confidence: {avg_confidence:.2f})")
            
            return {
                'text': full_text,
                'confidence': avg_confidence,
                'line_count': len(lines),
                'success': True,
                'engine': self.get_name(),
                'boxes': boxes
            }
            
        except Exception as e:
            logger.error(f"PaddleOCR extraction failed: {e}")
            return self._create_error_result(str(e))
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton instance (useful for testing)"""
        cls._instance = None
        cls._ocr = None
