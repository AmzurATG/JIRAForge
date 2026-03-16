"""
Tesseract OCR Engine Adapter

Wraps pytesseract library to comply with BaseOCREngine interface.
Requires Tesseract binary to be installed on the system or bundled with PyInstaller.
"""
import numpy as np
from PIL import Image
import logging
from typing import Dict, Any, Optional, Tuple
import os
import sys

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


def _get_bundled_tesseract_paths() -> Tuple[Optional[str], Optional[str]]:
    """
    Detect bundled Tesseract paths when running as a frozen PyInstaller exe.
    
    PyInstaller bundles files to sys._MEIPASS (for onefile) or next to the exe.
    The spec file bundles Tesseract to 'tesseract/' subfolder.
    
    Returns:
        Tuple of (tesseract_exe_path, tessdata_prefix) or (None, None) if not found
    """
    # Check if running as frozen exe
    if not getattr(sys, 'frozen', False):
        return None, None
    
    # Get the base path for bundled files
    # For onefile: sys._MEIPASS is the temp extraction folder
    # For onedir: it's the folder containing the exe
    if hasattr(sys, '_MEIPASS'):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(sys.executable)
    
    # Check for bundled tesseract in the 'tesseract' subfolder
    tesseract_exe = os.path.join(base_path, 'tesseract', 'tesseract.exe')
    tessdata_dir = os.path.join(base_path, 'tesseract', 'tessdata')
    
    tesseract_path = None
    tessdata_prefix = None
    
    if os.path.exists(tesseract_exe):
        tesseract_path = tesseract_exe
        logger.info(f"Found bundled Tesseract at: {tesseract_path}")
    else:
        # Also check in the same directory as exe (alternative bundling)
        alt_tesseract = os.path.join(os.path.dirname(sys.executable), 'tesseract', 'tesseract.exe')
        if os.path.exists(alt_tesseract):
            tesseract_path = alt_tesseract
            tessdata_dir = os.path.join(os.path.dirname(sys.executable), 'tesseract', 'tessdata')
            logger.info(f"Found bundled Tesseract at alternate path: {tesseract_path}")
    
    if tesseract_path and os.path.isdir(tessdata_dir):
        tessdata_prefix = tessdata_dir
        logger.info(f"Found bundled tessdata at: {tessdata_prefix}")
    
    return tesseract_path, tessdata_prefix


# Check if pytesseract is available
_TESSERACT_AVAILABLE = False
_tesseract = None
try:
    import pytesseract
    _tesseract = pytesseract
    _TESSERACT_AVAILABLE = True
except ImportError:
    logger.debug("pytesseract not installed. Install with: pip install pytesseract")


class TesseractEngine(BaseOCREngine):
    """
    Tesseract OCR engine adapter implementing BaseOCREngine interface.
    
    Requires:
        - pytesseract Python package: pip install pytesseract
        - Tesseract binary installed on system:
            - Windows: Download from https://github.com/UB-Mannheim/tesseract/wiki
            - Linux: apt install tesseract-ocr
            - macOS: brew install tesseract
    
    Configuration via environment variables:
        OCR_TESSERACT_LANGUAGE: eng, deu, fra, etc. (default: eng)
        OCR_TESSERACT_MIN_CONFIDENCE: 0.0-1.0 (default: 0.6)
        OCR_TESSERACT_PATH: Path to tesseract binary (optional)
    
    Or via OCREngineConfig:
        config.engines['tesseract'] = OCREngineConfig(
            name='tesseract',
            language='eng',
            extra_params={'tesseract_path': 'C:/Program Files/Tesseract-OCR/tesseract.exe'}
        )
    """
    
    _instance: Optional['TesseractEngine'] = None
    
    def __new__(cls, *args, **kwargs):
        """Singleton pattern"""
        if cls._instance is None:
            cls._instance = super(TesseractEngine, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(
        self,
        use_gpu: bool = False,  # Tesseract doesn't support GPU
        language: str = 'eng',
        min_confidence: float = 0.6,
        **extra_params
    ):
        """
        Initialize Tesseract engine.
        
        Args:
            use_gpu: Ignored (Tesseract doesn't support GPU)
            language: OCR language ('eng', 'deu', 'fra', etc.)
            min_confidence: Minimum confidence threshold
            **extra_params: Additional params (tesseract_path, config, etc.)
        """
        if getattr(self, '_initialized', False):
            return
        
        self.language = language
        self.min_confidence = min_confidence
        self.extra_params = extra_params
        
        # PRIORITY ORDER for finding Tesseract:
        # 1. Explicit parameter (tesseract_path)
        # 2. Environment variables (TESSERACT_CMD, OCR_TESSERACT_PATH)
        # 3. Bundled with PyInstaller (sys._MEIPASS/tesseract/)
        # 4. System PATH (default pytesseract behavior)
        
        tesseract_path = extra_params.get('tesseract_path') or os.getenv('TESSERACT_CMD') or os.getenv('OCR_TESSERACT_PATH')
        tessdata_prefix = os.getenv('TESSDATA_PREFIX')
        
        # If no explicit path, check for bundled tesseract (PyInstaller exe)
        if not tesseract_path:
            bundled_tesseract, bundled_tessdata = _get_bundled_tesseract_paths()
            if bundled_tesseract:
                tesseract_path = bundled_tesseract
                logger.info(f"Using bundled Tesseract: {tesseract_path}")
            if bundled_tessdata and not tessdata_prefix:
                tessdata_prefix = bundled_tessdata
                logger.info(f"Using bundled tessdata: {tessdata_prefix}")
        
        # Set Tesseract path
        if tesseract_path and _TESSERACT_AVAILABLE:
            _tesseract.pytesseract.tesseract_cmd = tesseract_path
            logger.debug(f"Tesseract path set to: {tesseract_path}")
        
        # Set TESSDATA_PREFIX (for language data files)
        if tessdata_prefix:
            os.environ['TESSDATA_PREFIX'] = tessdata_prefix
            logger.debug(f"TESSDATA_PREFIX set to: {tessdata_prefix}")
        
        self._initialized = True
        logger.info(f"Tesseract engine initialized (Lang: {language})")
    
    def get_name(self) -> str:
        """Return engine identifier"""
        return 'tesseract'
    
    def is_available(self) -> bool:
        """Check if Tesseract is installed and working"""
        if not _TESSERACT_AVAILABLE:
            return False
        
        try:
            # Try to get tesseract version to verify binary is accessible
            _tesseract.get_tesseract_version()
            return True
        except Exception as e:
            logger.debug(f"Tesseract not available: {e}")
            return False
    
    def get_capabilities(self) -> Dict[str, Any]:
        """Return Tesseract capabilities"""
        return {
            'gpu_support': False,
            'languages': ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'rus', 'chi_sim', 'chi_tra', 'jpn', 'kor'],
            'confidence_scores': True,
            'bounding_boxes': True,
            'batch_processing': False,
            'async_processing': False,
            'page_segmentation_modes': True,
            'oem_modes': True
        }

    def _get_language_candidates(self) -> list:
        """Return language candidates with compatibility fallbacks.

        Tesseract commonly expects 3-letter ISO codes (e.g., eng), but many
        configs still use 2-letter values (e.g., en). Try both to auto-heal
        language-data mismatch issues.
        """
        configured = (self.language or 'eng').strip()
        candidates = [configured]

        # Single-language fallback mapping.
        if '+' not in configured:
            if configured == 'en':
                # Prefer 'eng' over 'en' as standard Tesseract uses 'eng'
                candidates.insert(0, 'eng')
            elif configured == 'eng':
                candidates.append('en')

        # Deduplicate while preserving order.
        deduped = []
        seen = set()
        for lang in candidates:
            if lang and lang not in seen:
                seen.add(lang)
                deduped.append(lang)
        return deduped
    
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Extract text from image using Tesseract.
        
        Args:
            image: numpy array
        
        Returns:
            Standardized result dict
        """
        if not self.is_available():
            return self._create_error_result(
                "Tesseract not available. Install pytesseract and Tesseract binary."
            )
        
        try:
            # Convert to PIL Image for pytesseract
            if isinstance(image, np.ndarray):
                pil_image = Image.fromarray(image)
            else:
                pil_image = image
            
            # Build tesseract config
            custom_config = self.extra_params.get('config', '--oem 3 --psm 3')
            
            # Get detailed data with confidence scores.
            # Auto-fallback between configured language and compatible aliases
            # (e.g., en <-> eng) to avoid hard failures on tessdata naming.
            data = None
            used_language = None
            last_lang_error = None
            for lang_candidate in self._get_language_candidates():
                try:
                    data = _tesseract.image_to_data(
                        pil_image,
                        lang=lang_candidate,
                        config=custom_config,
                        output_type=_tesseract.Output.DICT
                    )
                    used_language = lang_candidate
                    break
                except Exception as lang_err:
                    last_lang_error = lang_err
                    err_text = str(lang_err).lower()
                    is_language_data_error = (
                        'error opening data file' in err_text or
                        'failed loading language' in err_text or
                        "couldn't load any languages" in err_text
                    )
                    if is_language_data_error:
                        logger.warning(
                            f"Tesseract language '{lang_candidate}' failed; trying next fallback. "
                            f"Error: {lang_err}"
                        )
                        continue
                    raise

            if data is None:
                raise RuntimeError(
                    f"Tesseract could not run with any language candidate "
                    f"{self._get_language_candidates()}: {last_lang_error}"
                )

            if used_language and used_language != self.language:
                logger.info(
                    f"Tesseract language fallback applied: configured='{self.language}', "
                    f"used='{used_language}'"
                )
            
            # Extract text and confidence
            lines = []
            confidences = []
            boxes = []
            
            current_line = []
            current_line_conf = []
            last_line_num = -1
            
            for i, text in enumerate(data['text']):
                conf = int(data['conf'][i])
                line_num = data['line_num'][i]
                
                # Skip empty or low confidence
                if not text.strip() or conf < 0:
                    continue
                
                # New line detected
                if line_num != last_line_num and current_line:
                    lines.append(' '.join(current_line))
                    if current_line_conf:
                        confidences.append(sum(current_line_conf) / len(current_line_conf) / 100.0)
                    current_line = []
                    current_line_conf = []
                
                current_line.append(text)
                current_line_conf.append(conf)
                last_line_num = line_num
                
                # Store bounding box
                x, y, w, h = data['left'][i], data['top'][i], data['width'][i], data['height'][i]
                boxes.append([[x, y], [x+w, y], [x+w, y+h], [x, y+h]])
            
            # Don't forget last line
            if current_line:
                lines.append(' '.join(current_line))
                if current_line_conf:
                    confidences.append(sum(current_line_conf) / len(current_line_conf) / 100.0)
            
            # Calculate overall confidence
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            if not full_text.strip():
                return {
                    'text': '',
                    'confidence': 0.0,
                    'line_count': 0,
                    'success': False,
                    'engine': self.get_name()
                }
            
            logger.debug(f"Tesseract: Extracted {len(lines)} lines (confidence: {avg_confidence:.2f})")
            
            return {
                'text': full_text,
                'confidence': avg_confidence,
                'line_count': len(lines),
                'success': True,
                'engine': self.get_name(),
                'boxes': boxes
            }
            
        except Exception as e:
            logger.error(f"Tesseract extraction failed: {e}")
            return self._create_error_result(str(e))
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton instance (useful for testing)"""
        cls._instance = None
