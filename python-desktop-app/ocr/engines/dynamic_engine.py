"""
Dynamic OCR Engine Adapter

Automatically creates engine adapters for any OCR library configured in .env
No need to manually create engine files - just configure and it works!

Supports common OCR library patterns:
- Libraries with extract_text() or recognize() methods
- Libraries that return text directly or in structured format
- Automatic confidence score detection

Usage:
    # In .env:
    OCR_PRIMARY_ENGINE=suryaocr
    OCR_SURYAOCR_PACKAGE=surya
    OCR_SURYAOCR_MODEL=vikp/surya_rec
    
    # System automatically creates adapter and uses it!
"""

import importlib
import logging
from typing import Dict, Any, Optional
import numpy as np
from PIL import Image

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


class DynamicOCREngine(BaseOCREngine):
    """
    Dynamic OCR engine that adapts to any OCR library.
    
    Automatically detects library interface and provides standardized access.
    Configured via environment variables:
        OCR_<ENGINE>_PACKAGE=package_name
        OCR_<ENGINE>_CLASS=ClassName (optional)
        OCR_<ENGINE>_METHOD=method_name (default: tries common methods)
    """
    
    # Common OCR library method names
    COMMON_METHODS = [
        'extract_text',
        'recognize',
        'ocr',
        'detect_and_recognize',
        'read',
        'readtext',
        'process',
        '__call__',  # callable class instances (e.g. RapidOCR)
        'get_ocr_df',  # WinRTocr returns pandas DataFrame
        'get_text',
        'run',
    ]
    
    def __init__(
        self,
        engine_name: str,
        package_name: str,
        class_name: Optional[str] = None,
        method_name: Optional[str] = None,
        use_gpu: bool = False,
        language: str = 'en',
        min_confidence: float = 0.5,
        **extra_params
    ):
        """
        Initialize dynamic OCR engine.
        
        Args:
            engine_name: Engine identifier (e.g., 'suryaocr')
            package_name: Python package to import (e.g., 'surya')
            class_name: Class to instantiate (if None, tries common patterns)
            method_name: OCR method to call (if None, auto-detects)
            use_gpu: Use GPU acceleration
            language: OCR language
            min_confidence: Minimum confidence threshold
            **extra_params: Engine-specific parameters
        """
        self.engine_name = engine_name
        self.package_name = package_name
        self.class_name = class_name
        self.method_name = method_name
        self.use_gpu = use_gpu
        self.language = language
        self.min_confidence = min_confidence
        self.extra_params = extra_params
        
        self._ocr_instance = None
        self._ocr_method = None
        self._initialized = False
    
    def get_name(self) -> str:
        """Return engine identifier"""
        return self.engine_name
    
    def is_available(self) -> bool:
        """Check if the OCR package is installed."""
        # Try multiple import name variants to handle hyphenated pip package names
        # e.g. 'rapidocr-onnxruntime' pip package imports as 'rapidocr'
        candidates = [
            self.package_name,
            self.package_name.replace('-', '_'),
            self.package_name.split('-')[0],
        ]
        for name in dict.fromkeys(candidates):  # deduplicate while preserving order
            try:
                importlib.import_module(name)
                return True
            except ImportError:
                continue
        logger.debug(f"Package '{self.package_name}' not installed for {self.engine_name}")
        return False
    
    def _initialize(self):
        """Lazy initialization of OCR library"""
        if self._initialized:
            return

        try:
            # Import the package — try variants to handle hyphenated pip names
            module = None
            for name in dict.fromkeys([
                self.package_name,
                self.package_name.replace('-', '_'),
                self.package_name.split('-')[0],
            ]):
                try:
                    module = importlib.import_module(name)
                    break
                except ImportError:
                    continue
            if module is None:
                raise ImportError(f"Cannot import '{self.package_name}' under any known name")
            logger.debug(f"Imported package: {self.package_name}")
            
            # Find the OCR class
            if self.class_name:
                # User specified class name
                ocr_class = getattr(module, self.class_name)
            else:
                # Try common class patterns
                ocr_class = self._find_ocr_class(module)
            
            if ocr_class:
                # Instantiate with parameters
                init_params = self._build_init_params()
                self._ocr_instance = ocr_class(**init_params)
                logger.info(f"Initialized {self.engine_name} with class {ocr_class.__name__}")
            else:
                # No class needed - module-level functions
                self._ocr_instance = module
                logger.info(f"Using {self.engine_name} module-level API")
            
            # Find the OCR method
            if self.method_name:
                if hasattr(self._ocr_instance, self.method_name):
                    self._ocr_method = getattr(self._ocr_instance, self.method_name)
                    logger.debug(f"Using specified method: {self.method_name}")
                else:
                    # Method name specified but not found - try auto-detect
                    logger.warning(
                        f"Method '{self.method_name}' not found on {self.engine_name}, "
                        f"available: {[m for m in dir(self._ocr_instance) if not m.startswith('_')][:10]}"
                    )
                    self._ocr_method = self._find_ocr_method(self._ocr_instance)
            else:
                self._ocr_method = self._find_ocr_method(self._ocr_instance)
            
            if not self._ocr_method:
                available_methods = [m for m in dir(self._ocr_instance) if not m.startswith('_')][:15]
                raise ValueError(
                    f"Could not find OCR method for {self.engine_name}. "
                    f"Available methods: {available_methods}"
                )
            
            self._initialized = True
            logger.info(f"Dynamic engine ready: {self.engine_name} (method: {getattr(self._ocr_method, '__name__', str(self._ocr_method))})")
            
        except Exception as e:
            logger.error(f"Failed to initialize {self.engine_name}: {e}")
            self._initialized = False
    
    def _find_ocr_class(self, module):
        """Try to find the OCR class in the module"""
        # Common OCR class name patterns
        common_patterns = [
            f"{self.engine_name}OCR",
            f"{self.engine_name.capitalize()}OCR",
            f"{self.engine_name.upper()}ocr",  # e.g. WinRTocr
            f"{self.engine_name.capitalize()}ocr",  # e.g. Winrtocr
            "RapidOCR",  # rapidocr_onnxruntime.RapidOCR
            "WinRTocr",  # winrtocr.WinRTocr
            "OCR",
            "Reader",
            "Recognizer",
            "Detector",
        ]
        
        for pattern in common_patterns:
            if hasattr(module, pattern):
                return getattr(module, pattern)
        
        # Look for any class with OCR/Reader/Recognizer in name
        for attr_name in dir(module):
            if any(keyword in attr_name.lower() for keyword in ['ocr', 'reader', 'recognizer']):
                attr = getattr(module, attr_name)
                if isinstance(attr, type):  # It's a class
                    return attr
        
        return None
    
    def _find_ocr_method(self, instance):
        """Auto-detect the OCR method"""
        # Try common method names
        for method_name in self.COMMON_METHODS:
            if hasattr(instance, method_name):
                return getattr(instance, method_name)
        
        return None
    
    # Keys used for engine routing — must NOT be forwarded to the OCR class constructor
    _META_KEYS = frozenset({'class', 'class_name', 'method', 'method_name', 'package', 'package_name'})

    def _build_init_params(self) -> Dict[str, Any]:
        """Build initialization parameters for the OCR class.

        Only passes parameters that are explicitly listed in extra_params AND are
        not internal routing keys (class, method, package).  This prevents crashes
        when an OCR library's __init__ does not accept those meta-keys.
        """
        params = {}

        # Language: only pass when the caller explicitly named a lang param in extra_params
        if self.language:
            for lang_param in ['lang', 'language', 'languages']:
                if lang_param in self.extra_params:
                    params[lang_param] = self.language
                    break

        # GPU: only add when explicitly mapped via extra_params
        if self.use_gpu:
            for gpu_param in ['use_gpu', 'gpu', 'device']:
                if gpu_param in self.extra_params:
                    params[gpu_param] = self.extra_params[gpu_param]
                    break

        # Add remaining extra params, filtering out meta/routing keys
        for key, value in self.extra_params.items():
            if key not in self._META_KEYS:
                params[key] = value

        return params
    
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Extract text using the dynamic OCR engine.
        
        Args:
            image: numpy array (BGR or RGB)
        
        Returns:
            Standardized result dict
        """
        if not self.is_available():
            return self._create_error_result(
                f"{self.engine_name} not available. "
                f"Install: pip install {self.package_name}"
            )
        
        # Initialize if needed
        self._initialize()
        
        if not self._initialized or not self._ocr_method:
            return self._create_error_result(
                f"Failed to initialize {self.engine_name}"
            )
        
        try:
            # Convert image to format the library expects
            img_input = self._convert_image(image)
            
            # Special handling for libraries that need file paths instead of arrays
            # (WinRTocr has a bug where numpy arrays fail with "Ran out of input")
            needs_file_path = self.package_name.lower() in ('winrtocr',) or \
                              self.engine_name.lower() in ('winrt', 'winrtocr')
            
            temp_file = None
            if needs_file_path:
                import tempfile
                import os
                # Save to temp PNG file
                pil_img = Image.fromarray(img_input) if isinstance(img_input, np.ndarray) else img_input
                temp_fd, temp_file = tempfile.mkstemp(suffix='.png')
                os.close(temp_fd)
                pil_img.save(temp_file, format='PNG')
                img_input = temp_file
                logger.debug(f"Saved temp file for {self.engine_name}: {temp_file}")
            
            try:
                # Call the OCR method
                result = self._ocr_method(img_input)
            finally:
                # Clean up temp file
                if temp_file:
                    try:
                        import os
                        os.unlink(temp_file)
                    except Exception:
                        pass
            
            # Parse the result into standardized format
            return self._parse_result(result)
            
        except Exception as e:
            logger.error(f"{self.engine_name} extraction failed: {e}")
            return self._create_error_result(str(e))
    
    def _parse_result(self, result) -> Dict[str, Any]:
        """
        Parse OCR result into standardized format.
        
        Handles various result formats:
        - String: "extracted text"
        - Dict: {'text': '...', 'confidence': 0.9}
        - List: [('text1', 0.9), ('text2', 0.8)]
        - List of dicts: [{'text': '...', 'conf': 0.9}, ...]
        """
        try:
            # Case 0: Top-level tuple (e.g. RapidOCR returns (result_list, elapsed_time))
            if isinstance(result, tuple) and len(result) >= 1:
                # RapidOCR format: (list_of_results | None, elapsed_time)
                inner_result = result[0]
                if inner_result is None:
                    # No text detected
                    return self._create_success_result(text='', confidence=0.0)
                if isinstance(inner_result, list):
                    # Recursively parse the inner list
                    return self._parse_result(inner_result)
                # If inner is something else, try parsing it directly
                return self._parse_result(inner_result)

            # Case 1: Plain string
            if isinstance(result, str):
                return self._create_success_result(
                    text=result,
                    confidence=0.95  # Assume high confidence if not provided
                )
            
            # Case 2: Dictionary with text
            if isinstance(result, dict):
                text = result.get('text', result.get('content', ''))
                confidence = result.get('confidence', result.get('conf', result.get('score', 0.95)))
                boxes = result.get('boxes', result.get('bounding_boxes'))
                
                return self._create_success_result(
                    text=text,
                    confidence=float(confidence),
                    boxes=boxes
                )
            
            # Case 3: List of results
            if isinstance(result, list) and result:
                texts = []
                confidences = []
                boxes = []
                
                for item in result:
                    if isinstance(item, (tuple, list)):
                        # (text, confidence) or (bbox, text, confidence) or [bbox, text, score]
                        if len(item) == 2:
                            texts.append(str(item[0]))
                            confidences.append(float(item[1]))
                        elif len(item) >= 3:
                            # RapidOCR format: [box, text, score]
                            boxes.append(item[0])
                            texts.append(str(item[1]))
                            confidences.append(float(item[2]))
                    
                    elif isinstance(item, dict):
                        # {'text': '...', 'confidence': 0.9}
                        texts.append(str(item.get('text', item.get('content', ''))))
                        confidences.append(float(item.get('confidence', item.get('conf', 0.95))))
                        if 'box' in item or 'bbox' in item:
                            boxes.append(item.get('box', item.get('bbox')))
                    
                    elif isinstance(item, str):
                        texts.append(item)
                        confidences.append(0.95)
                
                if texts:
                    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.95
                    return self._create_success_result(
                        text='\n'.join(texts),
                        confidence=avg_confidence,
                        boxes=boxes if boxes else None
                    )
            
            # Case 4: pandas DataFrame (e.g. winrtocr returns a DataFrame with 'text'/'conf' columns)
            try:
                import pandas as pd
                if isinstance(result, pd.DataFrame) and not result.empty:
                    text_col = next((c for c in ['text', 'Text', 'word', 'Word'] if c in result.columns), None)
                    conf_col = next((c for c in ['conf', 'confidence', 'Confidence', 'score'] if c in result.columns), None)
                    if text_col:
                        texts = result[text_col].dropna().astype(str).tolist()
                        if conf_col:
                            confs = result[conf_col].dropna().astype(float).tolist()
                            avg_conf = sum(confs) / len(confs) if confs else 0.9
                        else:
                            avg_conf = 0.9
                        return self._create_success_result(
                            text='\n'.join(t for t in texts if t.strip()),
                            confidence=avg_conf
                        )
            except ImportError:
                pass

            # Unknown format
            logger.warning(f"Unknown result format from {self.engine_name}: {type(result)}")
            return self._create_error_result(f"Unknown result format: {type(result)}")
            
        except Exception as e:
            logger.error(f"Failed to parse {self.engine_name} result: {e}")
            return self._create_error_result(f"Parse error: {e}")


def create_dynamic_engine(engine_name: str, config_params: Dict[str, Any]) -> Optional[DynamicOCREngine]:
    """
    Factory function to create a dynamic engine from configuration.
    
    Args:
        engine_name: Engine identifier
        config_params: Configuration parameters (from OCREngineConfig.extra_params)
    
    Returns:
        DynamicOCREngine instance or None if package not specified
    """
    package_name = config_params.get('package') or config_params.get('package_name')
    
    # Smart fallback: Try to guess package name from engine name
    if not package_name:
        package_name = _guess_package_name(engine_name)
        if package_name:
            logger.info(f"Auto-detected package '{package_name}' for engine '{engine_name}'")
        else:
            logger.warning(
                f"No package specified for {engine_name}. "
                f"Set OCR_{engine_name.upper()}_PACKAGE in .env or install matching package"
            )
            return None
    
    class_name = config_params.get('class') or config_params.get('class_name')
    method_name = config_params.get('method') or config_params.get('method_name')
    
    # If method not specified, use known defaults for common OCR libraries
    if not method_name:
        method_name = _get_default_method(engine_name, package_name)
        if method_name:
            logger.debug(f"Using default method '{method_name}' for {engine_name}")
    
    # If class not specified, use known defaults for common OCR libraries
    if not class_name:
        class_name = _get_default_class(engine_name, package_name)
        if class_name:
            logger.debug(f"Using default class '{class_name}' for {engine_name}")
    
    return DynamicOCREngine(
        engine_name=engine_name,
        package_name=package_name,
        class_name=class_name,
        method_name=method_name,
        **config_params
    )


def _get_default_method(engine_name: str, package_name: str) -> Optional[str]:
    """Get known default method for common OCR libraries."""
    defaults = {
        'rapidocr': '__call__',
        'rapidocr_onnxruntime': '__call__',
        'winrtocr': 'get_ocr_df',
        'winrt': 'get_ocr_df',
        'easyocr': 'readtext',
        'paddleocr': 'ocr',
        'pytesseract': 'image_to_string',
    }
    return defaults.get(engine_name.lower()) or defaults.get(package_name.lower())


def _get_default_class(engine_name: str, package_name: str) -> Optional[str]:
    """Get known default class for common OCR libraries."""
    defaults = {
        'rapidocr': 'RapidOCR',
        'rapidocr_onnxruntime': 'RapidOCR',
        'winrtocr': 'WinRTocr',
        'winrt': 'WinRTocr',
        'easyocr': 'Reader',
        'paddleocr': 'PaddleOCR',
    }
    return defaults.get(engine_name.lower()) or defaults.get(package_name.lower())


def _guess_package_name(engine_name: str) -> Optional[str]:
    """
    Try to guess the Python package name from the engine name.
    
    Tries common patterns:
    - Exact match (engine_name itself)
    - Remove 'ocr' suffix/prefix
    - Add 'ocr' suffix
    - Common mappings
    
    Args:
        engine_name: Engine identifier
    
    Returns:
        Package name (best guess), or None if no good guess
    """
    # Common known mappings (highest priority)
    known_mappings = {
        'paddle': 'paddleocr',
        'paddleocr': 'paddleocr',
        'tesseract': 'pytesseract',
        'easyocr': 'easyocr',
        'suryaocr': 'surya-ocr',
        'surya': 'surya-ocr',
        'doctr': 'python-doctr',
        'trocr': 'transformers',
        'kerasocr': 'keras_ocr',
        # RapidOCR — pip: rapidocr-onnxruntime, imports as rapidocr_onnxruntime
        'rapidocr': 'rapidocr_onnxruntime',
        'rapid': 'rapidocr_onnxruntime',
        # WinRTocr — pip: winrtocr, imports as winrtocr
        'winrtocr': 'winrtocr',
        'winrt': 'winrtocr',
    }
    
    engine_lower = engine_name.lower()
    
    # 1. Check known mappings first
    if engine_lower in known_mappings:
        return known_mappings[engine_lower]
    
    # 2. Try the engine name as-is (if installed, great; if not, still return it)
    if _can_import(engine_name):
        return engine_name
    
    # 3. Try removing 'ocr' suffix
    if engine_lower.endswith('ocr'):
        base_name = engine_name[:-3]
        if _can_import(base_name):
            return base_name
        # Even if not installed, this is a good guess
        candidates = [base_name]
    else:
        candidates = []
    
    # 4. Try adding 'ocr' suffix
    with_ocr = f"{engine_name}ocr"
    if _can_import(with_ocr):
        return with_ocr
    candidates.append(with_ocr)
    
    # 5. Try py- prefix (pytesseract pattern)
    py_prefixed = f"py{engine_name}"
    if _can_import(py_prefixed):
        return py_prefixed
    candidates.append(py_prefixed)
    
    # 6. Try with underscore
    with_underscore = engine_name.replace('-', '_')
    if _can_import(with_underscore) and with_underscore != engine_name:
        return with_underscore
    
    # 7. Try with hyphen
    with_hyphen = engine_name.replace('_', '-')
    if _can_import(with_hyphen) and with_hyphen != engine_name:
        return with_hyphen
    
    # 8. Return best guess even if not installed
    # Prefer: name with 'ocr' removed > py-prefixed > as-is
    if candidates:
        logger.debug(f"Package not installed, returning best guess from: {candidates}")
        return candidates[0] if len(candidates) > 0 else engine_name
    
    # 9. Last resort: return engine name as-is
    logger.debug(f"No good guess for '{engine_name}', using as-is")
    return engine_name


def _can_import(package_name: str) -> bool:
    """Check if a package can be imported"""
    try:
        importlib.import_module(package_name)
        return True
    except (ImportError, ModuleNotFoundError):
        return False
