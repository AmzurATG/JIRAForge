"""
PaddleOCR Engine Adapter

Wraps PaddleOCR library to comply with BaseOCREngine interface.
Implements singleton pattern to avoid reloading expensive models.

Supports both PaddleOCR 2.x (legacy) and 3.x (new) APIs.
"""
import os
import sys
import shutil
import numpy as np
from PIL import Image
import logging
from typing import Dict, Any, Optional

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


def _setup_bundled_paddleocr_models():
    """
    Setup bundled PaddleOCR models for PyInstaller exe deployment.
    
    When running as a frozen exe, PaddleOCR models are bundled in sys._MEIPASS/.paddleocr
    but PaddleOCR expects them in the user's home directory (~/.paddleocr/).
    
    This function copies the bundled models to the user's home if they don't exist,
    ensuring PaddleOCR can find and use the models without downloading.
    
    If bundled models don't exist, PaddleOCR will attempt to download them
    automatically when initialized (requires internet connection).
    
    MUST be called BEFORE importing paddleocr.
    """
    user_paddleocr = os.path.join(os.path.expanduser('~'), '.paddleocr')
    user_whl = os.path.join(user_paddleocr, 'whl')
    
    # Check if models already exist in user's home
    if os.path.isdir(user_whl):
        logger.info(f"PaddleOCR models already exist at: {user_paddleocr}")
        return
    
    # Only try to copy bundled models if running as frozen exe
    if not getattr(sys, 'frozen', False):
        logger.info(
            f"PaddleOCR models not found at: {user_paddleocr}. "
            "Will be downloaded automatically on first use."
        )
        return
    
    # Get the bundled path
    if hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(sys.executable)
    
    bundled_path = os.path.join(base_path, '.paddleocr')
    bundled_whl = os.path.join(bundled_path, 'whl')
    
    # Check if bundled models exist
    if not os.path.isdir(bundled_whl):
        logger.warning(
            f"PaddleOCR models not found in bundled exe at: {bundled_path}. "
            f"Models also not present at: {user_paddleocr}. "
            "PaddleOCR will attempt to DOWNLOAD models (requires internet connection). "
            "If download fails, PaddleOCR will be unavailable."
        )
        return
    
    # Copy bundled models to user's home
    try:
        logger.info(f"Copying bundled PaddleOCR models from {bundled_path} to {user_paddleocr}")
        
        # Create target directory
        os.makedirs(user_paddleocr, exist_ok=True)
        
        # Copy the whl directory with all models
        shutil.copytree(bundled_whl, user_whl, dirs_exist_ok=True)
        logger.info(f"Successfully copied PaddleOCR models to: {user_whl}")
            
    except Exception as e:
        logger.error(f"Failed to copy bundled PaddleOCR models: {e}")
        logger.warning("PaddleOCR may attempt to download models (requires internet).")


# Setup bundled models BEFORE importing paddleocr
_setup_bundled_paddleocr_models()


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
_PADDLEOCR_IMPORT_ERROR = None  # Store import error for diagnostics
_PADDLE_AVAILABLE = False
_PADDLE_VERSION = None
_PADDLE_IMPORT_ERROR = None

# First check if paddle (the core library) is available
try:
    import paddle
    _PADDLE_AVAILABLE = True
    _PADDLE_VERSION = getattr(paddle, '__version__', 'unknown')
    logger.info(f"Paddle core library loaded: version {_PADDLE_VERSION}")
except ImportError as e:
    _PADDLE_IMPORT_ERROR = str(e)
    logger.error(f"Paddle core library not available: {e}")
except Exception as e:
    _PADDLE_IMPORT_ERROR = f"Unexpected error: {str(e)}"
    logger.error(f"Paddle core library failed to load: {e}")

# Then check PaddleOCR
try:
    from paddleocr import PaddleOCR
    import paddleocr
    _PADDLEOCR_AVAILABLE = True
    _PADDLEOCR_VERSION = getattr(paddleocr, '__version__', '2.0.0')
    logger.info(f"PaddleOCR loaded: version {_PADDLEOCR_VERSION}")
except ImportError as e:
    _PADDLEOCR_IMPORT_ERROR = str(e)
    logger.error(f"PaddleOCR not available: {e}. Install with: pip install paddlepaddle paddleocr")
except Exception as e:
    _PADDLEOCR_IMPORT_ERROR = f"Unexpected error: {str(e)}"
    logger.error(f"PaddleOCR failed to load: {e}")


def get_paddle_diagnostics() -> dict:
    """Get diagnostic information about paddle/paddleocr availability."""
    import sys
    import os
    
    diagnostics = {
        'paddle_available': _PADDLE_AVAILABLE,
        'paddle_version': _PADDLE_VERSION,
        'paddle_import_error': _PADDLE_IMPORT_ERROR,
        'paddleocr_available': _PADDLEOCR_AVAILABLE,
        'paddleocr_version': _PADDLEOCR_VERSION,
        'paddleocr_import_error': _PADDLEOCR_IMPORT_ERROR,
        'is_frozen': getattr(sys, 'frozen', False),
        'meipass': getattr(sys, '_MEIPASS', None),
    }
    
    # Check model paths
    user_paddleocr = os.path.join(os.path.expanduser('~'), '.paddleocr')
    user_whl = os.path.join(user_paddleocr, 'whl')
    diagnostics['user_models_path'] = user_paddleocr
    diagnostics['user_models_exist'] = os.path.isdir(user_whl)
    
    if diagnostics['is_frozen']:
        base_path = diagnostics['meipass'] or os.path.dirname(sys.executable)
        bundled_path = os.path.join(base_path, '.paddleocr')
        bundled_whl = os.path.join(bundled_path, 'whl')
        diagnostics['bundled_models_path'] = bundled_path
        diagnostics['bundled_models_exist'] = os.path.isdir(bundled_whl)
        
        # Check paddle libs
        paddle_libs = os.path.join(base_path, 'paddle', 'libs')
        diagnostics['bundled_paddle_libs'] = paddle_libs
        diagnostics['bundled_paddle_libs_exist'] = os.path.isdir(paddle_libs)
    
    return diagnostics


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
                
                # Note: Bundled models are already copied to ~/.paddleocr/ by
                # _setup_bundled_paddleocr_models() which runs at module import time.
                # PaddleOCR will find them automatically in the standard location.

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
                    logger.info("Initializing PaddleOCR (may download models if not present)...")
                    self._ocr = PaddleOCR(**init_kwargs)
                    logger.info("PaddleOCR instance created successfully")
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
                import traceback
                error_msg = str(e)
                tb = traceback.format_exc()
                
                # Store initialization error for diagnostics
                self._init_error = error_msg
                self._init_traceback = tb
                
                logger.error(f"Failed to initialize PaddleOCR: {error_msg}")
                logger.error(f"Full traceback:\n{tb}")
                
                # Provide helpful diagnostics based on error type
                if 'SSL' in error_msg or 'certificate' in error_msg.lower():
                    logger.error(
                        "SSL/Certificate error detected. PaddleOCR cannot download models. "
                        "This may be a proxy or firewall issue."
                    )
                elif 'connection' in error_msg.lower() or 'timeout' in error_msg.lower():
                    logger.error(
                        "Network connection error. PaddleOCR cannot download models. "
                        "Check internet connectivity or firewall settings."
                    )
                elif 'permission' in error_msg.lower() or 'access' in error_msg.lower():
                    logger.error(
                        f"Permission error. PaddleOCR cannot write to model directory. "
                        f"Check write permissions for: {os.path.expanduser('~/.paddleocr/')}"
                    )
                elif 'No module' in error_msg or 'ImportError' in error_msg:
                    logger.error(
                        "Missing dependency. Some PaddlePaddle components may not be properly bundled."
                    )
                else:
                    # Check if models exist
                    models_path = os.path.join(os.path.expanduser('~'), '.paddleocr', 'whl')
                    if not os.path.isdir(models_path):
                        logger.error(
                            f"PaddleOCR models not found at {models_path}. "
                            f"Auto-download may have failed. Try running the app with internet access."
                        )
                    else:
                        logger.error(
                            f"Models exist at {models_path} but PaddleOCR still failed to load. "
                            f"The models may be corrupted or incompatible."
                        )
                
                self._ocr = None
        
        self._initialized = True
    
    def get_name(self) -> str:
        """Return engine identifier"""
        return 'paddle'
    
    def is_available(self) -> bool:
        """Check if PaddleOCR is installed and working"""
        if not _PADDLEOCR_AVAILABLE:
            # Store import error for diagnostics if not already set
            if not hasattr(self, '_init_error') or not self._init_error:
                if _PADDLEOCR_IMPORT_ERROR:
                    self._init_error = f"PaddleOCR import failed: {_PADDLEOCR_IMPORT_ERROR}"
                elif _PADDLE_IMPORT_ERROR:
                    self._init_error = f"Paddle core import failed: {_PADDLE_IMPORT_ERROR}"
                else:
                    self._init_error = "PaddleOCR module not available (unknown reason)"
            return False
        return self._ocr is not None
    
    def get_import_diagnostics(self) -> Dict[str, Any]:
        """Get detailed import diagnostics for debugging."""
        return get_paddle_diagnostics()
    
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
    
    # Maximum image dimensions to prevent ONNX runtime memory issues
    MAX_IMAGE_WIDTH = 4096
    MAX_IMAGE_HEIGHT = 4096
    
    def _validate_and_resize_image(self, img_array: np.ndarray) -> np.ndarray:
        """
        Validate image dimensions and resize if too large.
        
        Large images can cause ONNX runtime "could not execute a primitive" errors
        due to memory pressure. This safeguard prevents such failures.
        
        Args:
            img_array: Input image as numpy array
            
        Returns:
            Possibly resized numpy array
        """
        height, width = img_array.shape[:2]
        
        if width <= self.MAX_IMAGE_WIDTH and height <= self.MAX_IMAGE_HEIGHT:
            return img_array
        
        # Calculate scale factor to fit within limits
        scale_w = self.MAX_IMAGE_WIDTH / width if width > self.MAX_IMAGE_WIDTH else 1.0
        scale_h = self.MAX_IMAGE_HEIGHT / height if height > self.MAX_IMAGE_HEIGHT else 1.0
        scale = min(scale_w, scale_h)
        
        new_width = int(width * scale)
        new_height = int(height * scale)
        
        logger.warning(
            f"Image too large ({width}x{height}), resizing to {new_width}x{new_height} "
            f"to prevent ONNX runtime memory issues"
        )
        
        # Use cv2 if available, else PIL
        try:
            import cv2
            return cv2.resize(img_array, (new_width, new_height), interpolation=cv2.INTER_AREA)
        except ImportError:
            from PIL import Image as PILImage
            pil_img = PILImage.fromarray(img_array)
            pil_img = pil_img.resize((new_width, new_height), PILImage.Resampling.LANCZOS)
            return np.array(pil_img)
    
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
            
            # Validate and resize if needed to prevent ONNX runtime errors
            img_array = self._validate_and_resize_image(img_array)
            
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
            error_str = str(e).lower()
            detailed_error = str(e)
            
            # Provide specific diagnostics for known error types
            if 'could not execute a primitive' in error_str:
                detailed_error = (
                    f"ONNX runtime primitive execution failed: {e}. "
                    "This typically occurs due to: (1) Memory pressure from large images, "
                    "(2) ONNX operator incompatibility, or (3) Corrupted model state. "
                    "The image may have been resized but the error persists."
                )
            elif 'out of memory' in error_str or 'oom' in error_str:
                detailed_error = f"GPU/CPU memory exhausted during OCR inference: {e}"
            elif 'model' in error_str and ('not found' in error_str or 'missing' in error_str):
                detailed_error = f"PaddleOCR model files not found or corrupted: {e}"
            
            logger.error(f"PaddleOCR extraction failed: {detailed_error}")
            return self._create_error_result(detailed_error)
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton instance (useful for testing)"""
        cls._instance = None
        cls._ocr = None
