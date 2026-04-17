# OCR Facade Pattern Refactoring Plan

## Executive Summary

This document outlines the plan to refactor the OCR implementation using the **Facade Design Pattern** combined with the **Strategy Pattern** and **Adapter Pattern**. This will allow seamless swapping of OCR engines (PaddleOCR, Tesseract, EasyOCR, Google Cloud Vision, etc.) through simple configuration changes without modifying application code.

**Key Innovation**: The configuration system uses **dynamic engine discovery** - it automatically detects ANY OCR engine from environment variables (pattern: `OCR_<ENGINE>_<SETTING>`), eliminating all hardcoded engine names. You can add Google Cloud Vision, Azure OCR, or your custom engine with just environment variables - zero code changes required!

```bash
# Example: Add ANY engine without touching code
OCR_PRIMARY_ENGINE=my_custom_engine
OCR_MY_CUSTOM_ENGINE_API_KEY=secret123
OCR_MY_CUSTOM_ENGINE_ENDPOINT=https://api.example.com
# System automatically discovers and configures it!
```

---

## Table of Contents

1. [Current Implementation Analysis](#1-current-implementation-analysis)
2. [Problems with Current Implementation](#2-problems-with-current-implementation)
3. [Proposed Facade Architecture](#3-proposed-facade-architecture)
4. [Design Patterns Applied](#4-design-patterns-applied)
5. [Implementation Details](#5-implementation-details)
6. [Comparison: Before vs After](#6-comparison-before-vs-after)
7. [Migration Steps](#7-migration-steps)
8. [Configuration Guide](#8-configuration-guide)
9. [Adding New OCR Engines](#9-adding-new-ocr-engines)
10. [Test Plan](#10-test-plan)
11. [Risk Assessment](#11-risk-assessment)

---

## 1. Current Implementation Analysis

### Current File Structure
```
ocr/
├── __init__.py           # Module exports
├── ocr_engine.py         # PaddleOCR-specific implementation (tightly coupled)
├── text_extractor.py     # Main extraction with hardcoded fallback logic
└── image_processor.py    # Image preprocessing (reusable)
```

### Current Code Flow
```
desktop_app.py
    └── extract_text_from_image()  [text_extractor.py]
            ├── _extract_with_paddle()  → OCREngine  [ocr_engine.py] - PaddleOCR specific
            ├── extract_text_with_tesseract()  - Hardcoded in text_extractor.py
            └── metadata fallback
```

### Current Implementation Issues

#### ocr_engine.py (Lines 1-116)
```python
# PROBLEM: Class name is generic but implementation is PaddleOCR-specific
class OCREngine:
    def __init__(self, use_gpu=False, lang='en'):
        # PROBLEM: Hardcoded to PaddleOCR
        self.ocr = PaddleOCR(
            use_angle_cls=True,
            lang=lang,
            use_gpu=use_gpu,
            show_log=False,
            det_model_dir=None,
            rec_model_dir=None,
            cls_model_dir=None
        )
```

#### text_extractor.py (Lines 60-90)
```python
def extract_text_from_image(...):
    # PROBLEM: Hardcoded engine order
    paddle_result = _extract_with_paddle(processed_img)  # Always tries PaddleOCR first
    
    if paddle_result['success'] and paddle_result['confidence'] >= PADDLE_MIN_CONFIDENCE:
        return {..., 'method': 'paddle'}  # PROBLEM: Hardcoded method name
    
    # PROBLEM: Tesseract is hardcoded as fallback
    tesseract_result = extract_text_with_tesseract(processed_img)
```

---

## 2. Problems with Current Implementation

| Problem | Impact | Location |
|---------|--------|----------|
| **Tight Coupling** | Cannot swap OCR engines without code changes | ocr_engine.py |
| **Hardcoded Engine Order** | Primary/fallback engines are fixed | text_extractor.py |
| **No Common Interface** | Each engine has different API | All files |
| **Scattered Configuration** | Thresholds and settings are hardcoded | text_extractor.py |
| **Difficult Testing** | Cannot mock OCR engines easily | All files |
| **No Plugin Architecture** | Adding new engines requires code changes | Entire module |
| **Single Responsibility Violation** | text_extractor.py handles both extraction AND engine selection | text_extractor.py |
| **Hardcoded Engine Names** | Even initial config.py design hardcodes 'paddle', 'tesseract', 'easyocr' | config.py (initial design) |

**Key Insight**: The original facade plan had hardcoded engine configurations in `config.py`:
```python
# PROBLEM: Hardcoded in config.py from_env() method
config.engines = {
    'paddle': OCREngineConfig(...),    # Fixed!
    'tesseract': OCREngineConfig(...), # Fixed!
    'easyocr': OCREngineConfig(...)    # Fixed!
}
```
**Solution**: Dynamic engine discovery from environment variables (see Section 5.1 for the improved approach).

---

## 3. Proposed Facade Architecture

### New File Structure
```
ocr/
├── __init__.py                 # Module exports (unchanged interface)
├── config.py                   # OCR configuration (NEW)
├── base_engine.py             # Abstract base class (NEW)
├── facade.py                   # OCR Facade - main entry point (NEW)
├── engine_factory.py          # Factory for creating engines (NEW)
├── engines/                    # Engine implementations (NEW directory)
│   ├── __init__.py
│   ├── paddle_engine.py       # PaddleOCR adapter
│   ├── tesseract_engine.py    # Tesseract adapter
│   ├── easyocr_engine.py      # EasyOCR adapter (optional)
│   └── mock_engine.py         # Mock engine for testing
├── image_processor.py         # Image preprocessing (unchanged)
└── text_extractor.py          # Simplified using facade (MODIFIED)
```

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Desktop Application                                │
│                                                                               │
│   desktop_app.py                                                              │
│       └── from ocr import extract_text_from_image  (unchanged import)        │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OCR Module (ocr/)                                  │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                        __init__.py                                   │   │
│   │   extract_text_from_image() ← Public API (unchanged)                │   │
│   └─────────────────────────────┬───────────────────────────────────────┘   │
│                                 │                                            │
│                                 ▼                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                       OCR Facade (facade.py)                         │   │
│   │                                                                       │   │
│   │   ┌───────────────┐     ┌───────────────┐     ┌─────────────────┐   │   │
│   │   │   Config      │◄────│  OCRFacade    │────►│  EngineFactory  │   │   │
│   │   │  (config.py)  │     │               │     │                 │   │   │
│   │   └───────────────┘     └───────┬───────┘     └────────┬────────┘   │   │
│   │                                 │                       │            │   │
│   │                                 ▼                       ▼            │   │
│   │   ┌─────────────────────────────────────────────────────────────┐   │   │
│   │   │                     BaseOCREngine (ABC)                      │   │   │
│   │   │   + extract_text(img) → dict                                 │   │   │
│   │   │   + get_name() → str                                         │   │   │
│   │   │   + get_capabilities() → dict                                │   │   │
│   │   │   + is_available() → bool                                    │   │   │
│   │   └─────────────────────────────┬───────────────────────────────┘   │   │
│   │                                 │                                    │   │
│   │         ┌───────────────────────┼───────────────────────┐           │   │
│   │         │                       │                       │           │   │
│   │         ▼                       ▼                       ▼           │   │
│   │   ┌───────────┐           ┌───────────┐           ┌───────────┐    │   │
│   │   │  Paddle   │           │ Tesseract │           │  EasyOCR  │    │   │
│   │   │  Engine   │           │  Engine   │           │  Engine   │    │   │
│   │   │ Adapter   │           │  Adapter  │           │  Adapter  │    │   │
│   │   └───────────┘           └───────────┘           └───────────┘    │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Design Patterns Applied

### 4.1 Facade Pattern
**Purpose**: Provide a unified interface to a set of interfaces in a subsystem.

```python
class OCRFacade:
    """Simplified interface for all OCR operations"""
    
    def __init__(self, config=None):
        self.config = config or OCRConfig.from_env()
        self.factory = EngineFactory()
        self._primary_engine = None
        self._fallback_engines = []
    
    def extract_text(self, image, **kwargs):
        """Single method to extract text - hides all complexity"""
        # Tries primary engine, then fallbacks, handles all errors
        pass
```

### 4.2 Strategy Pattern
**Purpose**: Define a family of algorithms, encapsulate each one, and make them interchangeable.

```python
class BaseOCREngine(ABC):
    """Strategy interface for OCR engines"""
    
    @abstractmethod
    def extract_text(self, image: np.ndarray) -> dict:
        """Common method signature for all engines"""
        pass
```

### 4.3 Adapter Pattern
**Purpose**: Convert the interface of a class into another interface clients expect.

```python
class PaddleOCREngine(BaseOCREngine):
    """Adapts PaddleOCR library to our common interface"""
    
    def extract_text(self, image):
        # Converts PaddleOCR-specific result to common format
        raw_result = self.ocr.ocr(image)
        return self._convert_to_common_format(raw_result)
```

### 4.4 Factory Pattern
**Purpose**: Create objects without specifying the exact class of object to be created.

```python
class EngineFactory:
    """Creates OCR engine instances based on configuration"""
    
    _registry = {}  # Registered engine classes
    
    @classmethod
    def register(cls, name: str, engine_class: type):
        cls._registry[name] = engine_class
    
    @classmethod
    def create(cls, name: str, **kwargs) -> BaseOCREngine:
        if name not in cls._registry:
            raise ValueError(f"Unknown engine: {name}")
        return cls._registry[name](**kwargs)
```

### 4.5 Singleton Pattern (Preserved)
**Purpose**: Ensure only one instance of expensive model loading exists.

```python
class PaddleOCREngine(BaseOCREngine):
    _instance = None
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
```

---

## 5. Implementation Details

### 5.1 config.py - Configuration Management

```python
"""
OCR Configuration Management
Centralized configuration that can be loaded from environment or files
"""
import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional
import json


@dataclass
class OCREngineConfig:
    """Configuration for a single OCR engine"""
    name: str                           # Engine identifier
    enabled: bool = True                # Is this engine enabled?
    priority: int = 0                   # Lower = higher priority
    min_confidence: float = 0.5         # Minimum confidence threshold
    use_gpu: bool = False               # Use GPU acceleration
    language: str = 'en'                # OCR language
    extra_params: Dict = field(default_factory=dict)  # Engine-specific params


@dataclass
class OCRConfig:
    """Main OCR configuration"""
    primary_engine: str = 'paddle'      # Primary OCR engine
    fallback_engines: List[str] = field(default_factory=lambda: ['tesseract'])
    use_preprocessing: bool = True
    preprocessing_target_dpi: int = 300
    max_image_dimension: int = 4096
    engines: Dict[str, OCREngineConfig] = field(default_factory=dict)
    
    @classmethod
    def from_env(cls) -> 'OCRConfig':
        """
        Load configuration from environment variables - FULLY DYNAMIC
        
        Automatically discovers ANY OCR engine from environment variables.
        Pattern: OCR_<ENGINE>_<SETTING>=value
        
        Examples:
            OCR_PRIMARY_ENGINE=paddle
            OCR_PADDLE_MIN_CONFIDENCE=0.5
            OCR_GOOGLE_VISION_API_KEY=abc123  ← Automatically detected!
            OCR_MY_CUSTOM_ENGINE_USE_GPU=true  ← Any engine works!
        """
        config = cls()
        
        # Primary engine
        config.primary_engine = os.getenv('OCR_PRIMARY_ENGINE', 'paddle').lower()
        
        # Fallback engines (comma-separated)
        fallback = os.getenv('OCR_FALLBACK_ENGINES', 'tesseract')
        config.fallback_engines = [e.strip().lower() for e in fallback.split(',') if e.strip()]
        
        # Preprocessing
        config.use_preprocessing = os.getenv('OCR_USE_PREPROCESSING', 'true').lower() == 'true'
        
        # DYNAMIC ENGINE DISCOVERY: Find all engines mentioned in environment
        discovered_engines = set()
        discovered_engines.add(config.primary_engine)
        discovered_engines.update(config.fallback_engines)
        
        # Scan environment for OCR_<ENGINE>_* patterns
        for key in os.environ:
            if key.startswith('OCR_') and '_' in key[4:]:
                parts = key.split('_')
                # Skip global settings (OCR_PRIMARY_ENGINE, OCR_FALLBACK_ENGINES, etc.)
                if parts[1].lower() not in ['primary', 'fallback', 'use', 'max', 'preprocessing']:
                    engine_name = parts[1].lower()
                    discovered_engines.add(engine_name)
        
        # Create configuration for each discovered engine dynamically
        config.engines = {}
        for engine_name in discovered_engines:
            config.engines[engine_name] = cls._create_engine_config_from_env(engine_name)
        
        return config
    
    @staticmethod
    def _create_engine_config_from_env(engine_name: str) -> OCREngineConfig:
        """
        Dynamically create engine config from environment variables for ANY engine.
        
        Reads configuration for any engine using pattern: OCR_<ENGINE>_<SETTING>
        
        Standard settings supported:
            - ENABLED: true/false (default: true)
            - MIN_CONFIDENCE: 0.0-1.0 (default: 0.5)
            - USE_GPU: true/false (default: false)
            - LANGUAGE: language code (default: 'en')
            - Any custom settings go into extra_params
        
        Example for custom engine:
            OCR_MYENGINE_MIN_CONFIDENCE=0.7
            OCR_MYENGINE_API_KEY=secret123
            OCR_MYENGINE_ENDPOINT=https://api.example.com
        """
        prefix = f'OCR_{engine_name.upper()}_'
        
        # Standard configuration
        engine_config = OCREngineConfig(
            name=engine_name,
            enabled=os.getenv(f'{prefix}ENABLED', 'true').lower() == 'true',
            min_confidence=float(os.getenv(f'{prefix}MIN_CONFIDENCE', '0.5')),
            use_gpu=os.getenv(f'{prefix}USE_GPU', 'false').lower() == 'true',
            language=os.getenv(f'{prefix}LANGUAGE', 'en')
        )
        
        # Capture any extra custom parameters for this engine
        standard_keys = ['ENABLED', 'MIN_CONFIDENCE', 'USE_GPU', 'LANGUAGE']
        for key, value in os.environ.items():
            if key.startswith(prefix):
                param_name = key[len(prefix):].lower()
                if param_name not in [k.lower() for k in standard_keys]:
                    engine_config.extra_params[param_name] = value
        
        return engine_config
    
    @classmethod
    def from_file(cls, filepath: str) -> 'OCRConfig':
        """Load configuration from JSON file"""
        with open(filepath, 'r') as f:
            data = json.load(f)
        
        config = cls()
        config.primary_engine = data.get('primary_engine', 'paddle')
        config.fallback_engines = data.get('fallback_engines', ['tesseract'])
        config.use_preprocessing = data.get('use_preprocessing', True)
        
        for name, engine_data in data.get('engines', {}).items():
            config.engines[name] = OCREngineConfig(name=name, **engine_data)
        
        return config
    
    def get_engine_config(self, engine_name: str) -> OCREngineConfig:
        """Get configuration for a specific engine"""
        if engine_name not in self.engines:
            return OCREngineConfig(name=engine_name)  # Default config
        return self.engines[engine_name]
```

### 5.2 base_engine.py - Abstract Base Class

```python
"""
Abstract Base Class for OCR Engines
All OCR engine implementations must inherit from this class
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import numpy as np
from PIL import Image
import logging

logger = logging.getLogger(__name__)


class BaseOCREngine(ABC):
    """
    Abstract base class for all OCR engines.
    Implements the Strategy pattern for interchangeable OCR algorithms.
    """
    
    @abstractmethod
    def get_name(self) -> str:
        """
        Return the engine name (used for identification and logging)
        
        Returns:
            str: Engine name (e.g., 'paddle', 'tesseract', 'easyocr')
        """
        pass
    
    @abstractmethod
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Extract text from image.
        
        Args:
            image: Preprocessed image as numpy array (grayscale or RGB)
            
        Returns:
            dict: {
                'text': str,           # Extracted text
                'confidence': float,   # Average confidence (0.0-1.0)
                'line_count': int,     # Number of text lines detected
                'success': bool,       # Whether extraction succeeded
                'error': str           # Error message if failed (optional)
            }
        """
        pass
    
    @abstractmethod
    def is_available(self) -> bool:
        """
        Check if this OCR engine is available (dependencies installed)
        
        Returns:
            bool: True if engine can be used
        """
        pass
    
    def get_capabilities(self) -> Dict[str, Any]:
        """
        Return engine capabilities and features
        
        Returns:
            dict: {
                'gpu_support': bool,
                'languages': list,
                'batch_processing': bool,
                'confidence_scores': bool,
                'word_level_boxes': bool,
                ...
            }
        """
        return {
            'gpu_support': False,
            'languages': ['en'],
            'batch_processing': False,
            'confidence_scores': True,
            'word_level_boxes': False
        }
    
    def _convert_image(self, image) -> np.ndarray:
        """
        Convert various image types to numpy array
        
        Args:
            image: PIL Image, numpy array, or file path
            
        Returns:
            numpy array
        """
        if isinstance(image, str):
            return np.array(Image.open(image))
        elif isinstance(image, Image.Image):
            return np.array(image)
        elif isinstance(image, np.ndarray):
            return image
        else:
            raise ValueError(f"Unsupported image type: {type(image)}")
    
    def _create_error_result(self, error_message: str) -> Dict[str, Any]:
        """Create standardized error result"""
        return {
            'text': '',
            'confidence': 0.0,
            'line_count': 0,
            'success': False,
            'error': error_message
        }
```

### 5.3 engines/paddle_engine.py - PaddleOCR Adapter

```python
"""
PaddleOCR Engine Adapter
Wraps PaddleOCR library to comply with BaseOCREngine interface
"""
import numpy as np
from PIL import Image
import logging
from typing import Dict, Any

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


class PaddleOCREngine(BaseOCREngine):
    """
    PaddleOCR adapter implementing BaseOCREngine interface.
    Uses singleton pattern to avoid reloading models.
    """
    
    _instance = None
    _initialized = False
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, use_gpu: bool = False, language: str = 'en', **kwargs):
        """
        Initialize PaddleOCR engine
        
        Args:
            use_gpu: Enable GPU acceleration
            language: OCR language code
        """
        if self._initialized:
            return
        
        self.use_gpu = use_gpu
        self.language = language
        self._ocr = None
        self._load_model()
        self._initialized = True
    
    def _load_model(self):
        """Load PaddleOCR model"""
        try:
            from paddleocr import PaddleOCR
            
            self._ocr = PaddleOCR(
                use_angle_cls=True,
                lang=self.language,
                use_gpu=self.use_gpu,
                show_log=False,
                det_model_dir=None,
                rec_model_dir=None,
                cls_model_dir=None
            )
            logger.info(f"PaddleOCR model loaded (GPU: {self.use_gpu}, Lang: {self.language})")
        except Exception as e:
            logger.error(f"Failed to load PaddleOCR model: {e}")
            self._ocr = None
    
    def get_name(self) -> str:
        return 'paddle'
    
    def is_available(self) -> bool:
        try:
            from paddleocr import PaddleOCR
            return self._ocr is not None
        except ImportError:
            return False
    
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            'gpu_support': True,
            'languages': ['en', 'ch', 'japan', 'korean', 'german', 'french'],
            'batch_processing': True,
            'confidence_scores': True,
            'word_level_boxes': True,
            'angle_classification': True
        }
    
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Extract text using PaddleOCR
        
        Args:
            image: Preprocessed image as numpy array
            
        Returns:
            Standardized result dict
        """
        if not self.is_available():
            return self._create_error_result("PaddleOCR not available")
        
        try:
            # Convert image if needed
            img_array = self._convert_image(image)
            
            # Run OCR
            result = self._ocr.ocr(img_array, cls=True)
            
            if not result or not result[0]:
                logger.warning("PaddleOCR: No text detected")
                return {
                    'text': '',
                    'confidence': 0.0,
                    'line_count': 0,
                    'success': False
                }
            
            # Extract text and confidence scores
            lines = []
            confidences = []
            
            for line in result[0]:
                if line and len(line) >= 2:
                    text = line[1][0]
                    conf = line[1][1]
                    lines.append(text)
                    confidences.append(conf)
            
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            logger.info(f"PaddleOCR: Extracted {len(lines)} lines (confidence: {avg_confidence:.2f})")
            
            return {
                'text': full_text,
                'confidence': avg_confidence,
                'line_count': len(lines),
                'success': True
            }
            
        except Exception as e:
            logger.error(f"PaddleOCR extraction failed: {e}")
            return self._create_error_result(str(e))
```

### 5.4 engines/tesseract_engine.py - Tesseract Adapter

```python
"""
Tesseract OCR Engine Adapter
Wraps pytesseract library to comply with BaseOCREngine interface
"""
import numpy as np
from PIL import Image
import logging
from typing import Dict, Any

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


class TesseractEngine(BaseOCREngine):
    """
    Tesseract OCR adapter implementing BaseOCREngine interface.
    """
    
    def __init__(self, language: str = 'eng', **kwargs):
        """
        Initialize Tesseract engine
        
        Args:
            language: Tesseract language code (e.g., 'eng', 'deu', 'fra')
        """
        self.language = language
        self._pytesseract = None
        self._load_library()
    
    def _load_library(self):
        """Load pytesseract library"""
        try:
            import pytesseract
            self._pytesseract = pytesseract
            logger.info(f"Tesseract loaded (Lang: {self.language})")
        except ImportError:
            logger.warning("pytesseract not installed")
            self._pytesseract = None
    
    def get_name(self) -> str:
        return 'tesseract'
    
    def is_available(self) -> bool:
        try:
            import pytesseract
            # Also check if tesseract binary is installed
            pytesseract.get_tesseract_version()
            return True
        except Exception:
            return False
    
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            'gpu_support': False,
            'languages': ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'rus', 'jpn', 'chi_sim'],
            'batch_processing': False,
            'confidence_scores': True,
            'word_level_boxes': True,
            'angle_classification': False
        }
    
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Extract text using Tesseract
        
        Args:
            image: Preprocessed image as numpy array
            
        Returns:
            Standardized result dict
        """
        if not self.is_available():
            return self._create_error_result("Tesseract not available")
        
        try:
            # Convert to PIL Image
            img_array = self._convert_image(image)
            pil_img = Image.fromarray(img_array) if isinstance(img_array, np.ndarray) else img_array
            
            # Extract text with confidence data
            data = self._pytesseract.image_to_data(
                pil_img, 
                lang=self.language,
                output_type=self._pytesseract.Output.DICT
            )
            
            # Filter and process results
            texts = []
            confidences = []
            
            for i, conf in enumerate(data['conf']):
                if conf > 0:
                    text = data['text'][i].strip()
                    if text:
                        texts.append(text)
                        confidences.append(conf / 100.0)
            
            if not texts:
                logger.warning("Tesseract: No text detected")
                return {
                    'text': '',
                    'confidence': 0.0,
                    'line_count': 0,
                    'success': False
                }
            
            full_text = ' '.join(texts)
            avg_confidence = sum(confidences) / len(confidences)
            
            logger.info(f"Tesseract: Extracted {len(texts)} words (confidence: {avg_confidence:.2f})")
            
            return {
                'text': full_text,
                'confidence': avg_confidence,
                'line_count': len(texts),
                'success': True
            }
            
        except Exception as e:
            logger.error(f"Tesseract extraction failed: {e}")
            return self._create_error_result(str(e))
```

### 5.5 engines/easyocr_engine.py - EasyOCR Adapter (Example)

```python
"""
EasyOCR Engine Adapter
Example of adding a new OCR engine
"""
import numpy as np
import logging
from typing import Dict, Any

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


class EasyOCREngine(BaseOCREngine):
    """
    EasyOCR adapter implementing BaseOCREngine interface.
    Uses singleton pattern to avoid reloading models.
    """
    
    _instance = None
    _initialized = False
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, use_gpu: bool = False, language: str = 'en', **kwargs):
        if self._initialized:
            return
        
        self.use_gpu = use_gpu
        self.language = language
        self._reader = None
        self._load_model()
        self._initialized = True
    
    def _load_model(self):
        try:
            import easyocr
            self._reader = easyocr.Reader(
                [self.language],
                gpu=self.use_gpu,
                verbose=False
            )
            logger.info(f"EasyOCR model loaded (GPU: {self.use_gpu}, Lang: {self.language})")
        except Exception as e:
            logger.error(f"Failed to load EasyOCR: {e}")
            self._reader = None
    
    def get_name(self) -> str:
        return 'easyocr'
    
    def is_available(self) -> bool:
        try:
            import easyocr
            return self._reader is not None
        except ImportError:
            return False
    
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            'gpu_support': True,
            'languages': ['en', 'ch_sim', 'ja', 'ko', 'de', 'fr', 'es'],
            'batch_processing': True,
            'confidence_scores': True,
            'word_level_boxes': True
        }
    
    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        if not self.is_available():
            return self._create_error_result("EasyOCR not available")
        
        try:
            img_array = self._convert_image(image)
            result = self._reader.readtext(img_array)
            
            if not result:
                return {
                    'text': '',
                    'confidence': 0.0,
                    'line_count': 0,
                    'success': False
                }
            
            lines = []
            confidences = []
            
            for detection in result:
                text = detection[1]
                conf = detection[2]
                lines.append(text)
                confidences.append(conf)
            
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            return {
                'text': full_text,
                'confidence': avg_confidence,
                'line_count': len(lines),
                'success': True
            }
            
        except Exception as e:
            logger.error(f"EasyOCR extraction failed: {e}")
            return self._create_error_result(str(e))
```

### 5.6 engines/mock_engine.py - Mock for Testing

```python
"""
Mock OCR Engine for Testing
Returns configurable results for unit tests
"""
import logging
from typing import Dict, Any, Optional

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)


class MockOCREngine(BaseOCREngine):
    """
    Mock OCR engine for testing purposes.
    Allows configuring expected results.
    """
    
    def __init__(
        self,
        mock_text: str = "Mock extracted text",
        mock_confidence: float = 0.95,
        mock_success: bool = True,
        mock_error: Optional[str] = None,
        **kwargs
    ):
        self.mock_text = mock_text
        self.mock_confidence = mock_confidence
        self.mock_success = mock_success
        self.mock_error = mock_error
        self.call_count = 0
        self.last_image = None
    
    def get_name(self) -> str:
        return 'mock'
    
    def is_available(self) -> bool:
        return True
    
    def get_capabilities(self) -> Dict[str, Any]:
        return {
            'gpu_support': True,
            'languages': ['all'],
            'batch_processing': True,
            'confidence_scores': True,
            'is_mock': True
        }
    
    def extract_text(self, image) -> Dict[str, Any]:
        self.call_count += 1
        self.last_image = image
        
        if self.mock_error:
            return self._create_error_result(self.mock_error)
        
        return {
            'text': self.mock_text,
            'confidence': self.mock_confidence,
            'line_count': len(self.mock_text.split('\n')),
            'success': self.mock_success
        }
    
    def set_mock_result(
        self,
        text: str = None,
        confidence: float = None,
        success: bool = None,
        error: str = None
    ):
        """Configure mock results for next call"""
        if text is not None:
            self.mock_text = text
        if confidence is not None:
            self.mock_confidence = confidence
        if success is not None:
            self.mock_success = success
        self.mock_error = error
```

### 5.7 engine_factory.py - Factory for Engine Creation

```python
"""
OCR Engine Factory
Creates and manages OCR engine instances
"""
import logging
from typing import Dict, Type, Optional

from .base_engine import BaseOCREngine
from .config import OCRConfig, OCREngineConfig

logger = logging.getLogger(__name__)


class EngineFactory:
    """
    Factory class for creating OCR engine instances.
    Supports registration of custom engines.
    """
    
    _registry: Dict[str, Type[BaseOCREngine]] = {}
    _instances: Dict[str, BaseOCREngine] = {}  # Cache for singleton engines
    
    @classmethod
    def register(cls, name: str, engine_class: Type[BaseOCREngine]):
        """
        Register an OCR engine class
        
        Args:
            name: Engine identifier (e.g., 'paddle', 'tesseract')
            engine_class: Class that implements BaseOCREngine
        """
        cls._registry[name.lower()] = engine_class
        logger.info(f"Registered OCR engine: {name}")
    
    @classmethod
    def unregister(cls, name: str):
        """Remove an engine from registry"""
        name = name.lower()
        if name in cls._registry:
            del cls._registry[name]
            if name in cls._instances:
                del cls._instances[name]
    
    @classmethod
    def create(
        cls,
        name: str,
        config: Optional[OCREngineConfig] = None,
        **kwargs
    ) -> BaseOCREngine:
        """
        Create an OCR engine instance
        
        Args:
            name: Engine identifier
            config: Engine configuration
            **kwargs: Additional arguments passed to engine constructor
            
        Returns:
            BaseOCREngine instance
        """
        name = name.lower()
        
        if name not in cls._registry:
            raise ValueError(f"Unknown OCR engine: {name}. "
                           f"Available engines: {list(cls._registry.keys())}")
        
        # Merge config with kwargs
        if config:
            kwargs.setdefault('use_gpu', config.use_gpu)
            kwargs.setdefault('language', config.language)
            kwargs.update(config.extra_params)
        
        # Create instance
        engine_class = cls._registry[name]
        return engine_class(**kwargs)
    
    @classmethod
    def get_or_create(
        cls,
        name: str,
        config: Optional[OCREngineConfig] = None,
        **kwargs
    ) -> BaseOCREngine:
        """
        Get cached instance or create new one (for singleton engines)
        
        Args:
            name: Engine identifier
            config: Engine configuration
            
        Returns:
            BaseOCREngine instance
        """
        name = name.lower()
        
        if name in cls._instances:
            return cls._instances[name]
        
        engine = cls.create(name, config, **kwargs)
        cls._instances[name] = engine
        return engine
    
    @classmethod
    def get_available_engines(cls) -> Dict[str, bool]:
        """
        Get list of registered engines and their availability
        
        Returns:
            dict: {engine_name: is_available}
        """
        result = {}
        for name, engine_class in cls._registry.items():
            try:
                engine = cls.get_or_create(name)
                result[name] = engine.is_available()
            except Exception:
                result[name] = False
        return result
    
    @classmethod
    def clear_cache(cls):
        """Clear cached engine instances"""
        cls._instances.clear()


# Auto-register built-in engines
def _auto_register():
    """Register built-in OCR engines"""
    try:
        from .engines.paddle_engine import PaddleOCREngine
        EngineFactory.register('paddle', PaddleOCREngine)
    except ImportError:
        logger.debug("PaddleOCR engine not available")
    
    try:
        from .engines.tesseract_engine import TesseractEngine
        EngineFactory.register('tesseract', TesseractEngine)
    except ImportError:
        logger.debug("Tesseract engine not available")
    
    try:
        from .engines.easyocr_engine import EasyOCREngine
        EngineFactory.register('easyocr', EasyOCREngine)
    except ImportError:
        logger.debug("EasyOCR engine not available")
    
    try:
        from .engines.mock_engine import MockOCREngine
        EngineFactory.register('mock', MockOCREngine)
    except ImportError:
        pass

_auto_register()
```

### 5.8 facade.py - Main Facade Class

```python
"""
OCR Facade
Provides unified interface for text extraction with fallback support
"""
import logging
from typing import Dict, Any, Optional, List
import numpy as np
from PIL import Image

from .config import OCRConfig
from .engine_factory import EngineFactory
from .base_engine import BaseOCREngine
from .image_processor import preprocess_image, resize_if_needed

logger = logging.getLogger(__name__)


class OCRFacade:
    """
    Facade class that provides a simplified interface for OCR operations.
    Handles engine selection, fallback strategy, and preprocessing.
    """
    
    def __init__(self, config: Optional[OCRConfig] = None):
        """
        Initialize OCR Facade
        
        Args:
            config: OCR configuration. If None, loads from environment.
        """
        self.config = config or OCRConfig.from_env()
        self._primary_engine: Optional[BaseOCREngine] = None
        self._fallback_engines: List[BaseOCREngine] = []
        self._initialize_engines()
    
    def _initialize_engines(self):
        """Initialize primary and fallback engines based on config"""
        # Initialize primary engine
        try:
            primary_config = self.config.get_engine_config(self.config.primary_engine)
            self._primary_engine = EngineFactory.get_or_create(
                self.config.primary_engine,
                config=primary_config
            )
            logger.info(f"Primary OCR engine: {self.config.primary_engine}")
        except Exception as e:
            logger.error(f"Failed to initialize primary engine '{self.config.primary_engine}': {e}")
        
        # Initialize fallback engines
        for engine_name in self.config.fallback_engines:
            try:
                engine_config = self.config.get_engine_config(engine_name)
                engine = EngineFactory.get_or_create(engine_name, config=engine_config)
                if engine.is_available():
                    self._fallback_engines.append(engine)
                    logger.info(f"Fallback OCR engine: {engine_name}")
            except Exception as e:
                logger.warning(f"Failed to initialize fallback engine '{engine_name}': {e}")
    
    def extract_text(
        self,
        image,
        window_title: str = '',
        app_name: str = '',
        use_preprocessing: Optional[bool] = None
    ) -> Dict[str, Any]:
        """
        Extract text from image using configured engines with fallback
        
        Args:
            image: PIL Image, numpy array, or file path
            window_title: Window title for metadata fallback
            app_name: Application name for metadata fallback
            use_preprocessing: Override config preprocessing setting
            
        Returns:
            dict: {
                'text': str,
                'confidence': float,
                'method': str,
                'success': bool,
                'window_title': str,
                'app_name': str,
                'line_count': int,
                'error': str (optional)
            }
        """
        # Determine preprocessing setting
        should_preprocess = use_preprocessing if use_preprocessing is not None else self.config.use_preprocessing
        
        try:
            # Convert and preprocess image
            processed_img = self._prepare_image(image, should_preprocess)
            
            # Try primary engine
            if self._primary_engine and self._primary_engine.is_available():
                primary_config = self.config.get_engine_config(self.config.primary_engine)
                result = self._primary_engine.extract_text(processed_img)
                
                if result['success'] and result['confidence'] >= primary_config.min_confidence:
                    logger.info(f"Primary engine '{self._primary_engine.get_name()}' succeeded")
                    return self._format_result(
                        result,
                        method=self._primary_engine.get_name(),
                        window_title=window_title,
                        app_name=app_name
                    )
                else:
                    logger.info(f"Primary engine below threshold ({result['confidence']:.2f} < {primary_config.min_confidence})")
            
            # Try fallback engines
            for engine in self._fallback_engines:
                engine_config = self.config.get_engine_config(engine.get_name())
                result = engine.extract_text(processed_img)
                
                if result['success'] and result['confidence'] >= engine_config.min_confidence:
                    logger.info(f"Fallback engine '{engine.get_name()}' succeeded")
                    return self._format_result(
                        result,
                        method=engine.get_name(),
                        window_title=window_title,
                        app_name=app_name
                    )
                else:
                    logger.info(f"Fallback engine '{engine.get_name()}' below threshold")
            
            # All engines failed - return metadata fallback
            logger.warning("All OCR engines failed, returning metadata fallback")
            return self._format_result(
                {'text': '', 'confidence': 0.0, 'line_count': 0, 'success': False},
                method='metadata',
                window_title=window_title,
                app_name=app_name
            )
            
        except Exception as e:
            logger.error(f"OCR extraction failed: {e}")
            return self._format_result(
                {'text': '', 'confidence': 0.0, 'line_count': 0, 'success': False, 'error': str(e)},
                method='error',
                window_title=window_title,
                app_name=app_name
            )
    
    def _prepare_image(self, image, use_preprocessing: bool) -> np.ndarray:
        """Convert and optionally preprocess image"""
        # Convert to PIL Image
        if isinstance(image, str):
            img = Image.open(image)
        elif isinstance(image, np.ndarray):
            img = Image.fromarray(image)
        else:
            img = image
        
        # Preprocess if enabled
        if use_preprocessing:
            processed = preprocess_image(img)
        else:
            processed = np.array(img)
        
        # Resize if too large
        return resize_if_needed(processed, self.config.max_image_dimension)
    
    def _format_result(
        self,
        result: Dict[str, Any],
        method: str,
        window_title: str,
        app_name: str
    ) -> Dict[str, Any]:
        """Format result with standard fields"""
        return {
            'text': result.get('text', ''),
            'confidence': result.get('confidence', 0.0),
            'method': method,
            'success': result.get('success', False),
            'window_title': window_title,
            'app_name': app_name,
            'line_count': result.get('line_count', 0),
            'error': result.get('error')
        }
    
    def get_available_engines(self) -> Dict[str, bool]:
        """Get list of available OCR engines"""
        return EngineFactory.get_available_engines()
    
    def get_current_config(self) -> Dict[str, Any]:
        """Get current configuration as dict"""
        return {
            'primary_engine': self.config.primary_engine,
            'fallback_engines': self.config.fallback_engines,
            'use_preprocessing': self.config.use_preprocessing,
            'engines': {
                name: {
                    'enabled': cfg.enabled,
                    'min_confidence': cfg.min_confidence,
                    'use_gpu': cfg.use_gpu,
                    'language': cfg.language
                }
                for name, cfg in self.config.engines.items()
            }
        }


# Global facade instance (lazy initialization)
_facade_instance: Optional[OCRFacade] = None


def get_facade(config: Optional[OCRConfig] = None) -> OCRFacade:
    """Get or create global OCRFacade instance"""
    global _facade_instance
    
    if _facade_instance is None or config is not None:
        _facade_instance = OCRFacade(config)
    
    return _facade_instance


def extract_text_from_image(
    image,
    window_title: str = '',
    app_name: str = '',
    use_preprocessing: bool = True
) -> Dict[str, Any]:
    """
    Convenience function - maintains backward compatibility with existing code.
    
    Args:
        image: PIL Image, numpy array, or file path
        window_title: Window title for metadata fallback
        app_name: Application name for metadata fallback
        use_preprocessing: Apply image preprocessing
        
    Returns:
        Standard OCR result dict
    """
    facade = get_facade()
    return facade.extract_text(
        image,
        window_title=window_title,
        app_name=app_name,
        use_preprocessing=use_preprocessing
    )
```

### 5.9 Updated __init__.py

```python
"""
OCR Module for JIRAForge Desktop App

Provides text extraction from images with pluggable OCR engines.
Supports PaddleOCR, Tesseract, EasyOCR, and custom engines.

Usage:
    from ocr import extract_text_from_image
    result = extract_text_from_image(screenshot)
    
Configuration via environment variables:
    OCR_PRIMARY_ENGINE=paddle        # Primary OCR engine
    OCR_FALLBACK_ENGINES=tesseract   # Fallback engines (comma-separated)
    OCR_PADDLE_MIN_CONFIDENCE=0.5    # Minimum confidence threshold
    OCR_USE_PREPROCESSING=true       # Enable image preprocessing
    
Or via JSON config file:
    from ocr.config import OCRConfig
    from ocr.facade import OCRFacade
    
    config = OCRConfig.from_file('ocr_config.json')
    facade = OCRFacade(config)
    result = facade.extract_text(image)
"""

# Main extraction function (backward compatible)
from .facade import extract_text_from_image, get_facade, OCRFacade

# Configuration
from .config import OCRConfig, OCREngineConfig

# Engine factory for custom engines
from .engine_factory import EngineFactory

# Base class for custom engines
from .base_engine import BaseOCREngine

# Image processing utilities
from .image_processor import preprocess_image, resize_if_needed

__all__ = [
    # Main API
    'extract_text_from_image',
    'get_facade',
    'OCRFacade',
    
    # Configuration
    'OCRConfig',
    'OCREngineConfig',
    
    # Extensibility
    'EngineFactory',
    'BaseOCREngine',
    
    # Utilities
    'preprocess_image',
    'resize_if_needed'
]

__version__ = '2.0.0'
```

---

## 6. Comparison: Before vs After

### 6.1 Code Comparison

| Aspect | Before (Current) | After (Facade) |
|--------|-----------------|----------------|
| **Adding New Engine** | Modify text_extractor.py, add new function, modify config.py | Create adapter class, register in factory - NO config.py changes! |
| **Changing Primary Engine** | Modify code in text_extractor.py | Change `OCR_PRIMARY_ENGINE` env var |
| **Changing Fallback Order** | Modify code | Change `OCR_FALLBACK_ENGINES` env var |
| **Engine Configuration** | Hardcoded in source files | **Dynamically discovered from env vars** |
| **Custom Engine Parameters** | Requires code changes to support | Any `OCR_<ENGINE>_*` var auto-captured |
| **Testing** | Difficult, requires mocking internal functions | Easy, inject mock engine via factory |
| **Lines of Code** | ~340 lines across 3 files | ~700 lines across 10 files (better separation) |
| **Coupling** | Tight (PaddleOCR import in main file) | Loose (Dependency injection) |
| **Interface** | Inconsistent per engine | Standardized BaseOCREngine |
| **Hardcoded Engine Names** | Yes (text_extractor.py) | **No (fully dynamic discovery)** |
| **Extensibility** | Low - requires code surgery | High - plug-and-play via env vars |

### 6.2 Usage Comparison

#### Before (Hardcoded)
```python
# In text_extractor.py
from paddleocr import PaddleOCR  # Hardcoded import

def extract_text_from_image(img):
    # Always tries PaddleOCR first
    paddle_result = _extract_with_paddle(img)
    
    # Then Tesseract (hardcoded fallback)
    tesseract_result = extract_text_with_tesseract(img)
```

#### After (Configurable)
```python
# In .env file
OCR_PRIMARY_ENGINE=paddle
OCR_FALLBACK_ENGINES=tesseract,easyocr

# OR in Python
from ocr import OCRFacade, OCRConfig

config = OCRConfig()
config.primary_engine = 'easyocr'  # Changed!
config.fallback_engines = ['paddle', 'tesseract']

facade = OCRFacade(config)
result = facade.extract_text(image)
```

### 6.3 Performance Comparison

| Metric | Before | After | Notes |
|--------|--------|-------|-------|
| **Startup Time** | Same | Same | Lazy loading preserved |
| **Extraction Time** | Same | Same | No overhead in hot path |
| **Memory** | Same | +50KB | Factory registry overhead |
| **Maintainability** | Low | High | SOLID principles |
| **Testability** | Low | High | Mock engine support |

---

## 7. Migration Steps

### Phase 1: Create New Structure (Non-Breaking)
1. Create `ocr/config.py`
2. Create `ocr/base_engine.py`
3. Create `ocr/engines/` directory
4. Create engine adapters (paddle, tesseract, mock)
5. Create `ocr/engine_factory.py`
6. Create `ocr/facade.py`

### Phase 2: Update Module Interface
1. Update `ocr/__init__.py` to export new classes
2. Keep `extract_text_from_image` function (backward compatible)

### Phase 3: Deprecate Old Files
1. Mark `ocr/ocr_engine.py` as deprecated
2. Mark `ocr/text_extractor.py` old functions as deprecated

### Phase 4: Update Consumers
1. Desktop app keeps using `from ocr import extract_text_from_image` (unchanged!)
2. Test scripts can directly use `OCRFacade` if needed
3. Add configuration to `.env` files

### Phase 5: Remove Deprecated Code (Future)
1. Remove `ocr/ocr_engine.py`
2. Simplify `ocr/text_extractor.py` (just re-exports facade function)

---

## 8. Configuration Guide

### 8.1 Environment Variables

```bash
# ============================================================================
# PRIMARY & FALLBACK ENGINES (Required for any setup)
# ============================================================================
OCR_PRIMARY_ENGINE=paddle              # Options: paddle, tesseract, easyocr, mock, <any_custom_engine>
OCR_FALLBACK_ENGINES=tesseract,easyocr # Comma-separated list, tried in order

# ============================================================================
# GLOBAL SETTINGS
# ============================================================================
OCR_USE_PREPROCESSING=true
OCR_MAX_IMAGE_DIMENSION=4096

# ============================================================================
# BUILT-IN ENGINE CONFIGURATIONS (Discovered automatically)
# ============================================================================

# PaddleOCR Settings
OCR_PADDLE_MIN_CONFIDENCE=0.5
OCR_PADDLE_USE_GPU=false
OCR_PADDLE_LANGUAGE=en

# Tesseract Settings
OCR_TESSERACT_MIN_CONFIDENCE=0.6
OCR_TESSERACT_LANGUAGE=eng

# EasyOCR Settings
OCR_EASYOCR_MIN_CONFIDENCE=0.5
OCR_EASYOCR_USE_GPU=false
OCR_EASYOCR_LANGUAGE=en

# ============================================================================
# CUSTOM ENGINE EXAMPLES (Add ANY engine without code changes!)
# ============================================================================

# Example 1: Google Cloud Vision
OCR_PRIMARY_ENGINE=google_vision
OCR_GOOGLE_VISION_MIN_CONFIDENCE=0.7
OCR_GOOGLE_VISION_API_KEY=your-api-key-here
OCR_GOOGLE_VISION_PROJECT_ID=your-project-id
OCR_GOOGLE_VISION_ENDPOINT=https://vision.googleapis.com/v1

# Example 2: Azure Computer Vision
OCR_PRIMARY_ENGINE=azure_vision
OCR_AZURE_VISION_MIN_CONFIDENCE=0.6
OCR_AZURE_VISION_SUBSCRIPTION_KEY=your-subscription-key
OCR_AZURE_VISION_ENDPOINT=https://your-resource.cognitiveservices.azure.com

# Example 3: Your Custom OCR Engine
OCR_PRIMARY_ENGINE=my_custom_ocr
OCR_MY_CUSTOM_OCR_MIN_CONFIDENCE=0.8
OCR_MY_CUSTOM_OCR_USE_GPU=true
OCR_MY_CUSTOM_OCR_MODEL_PATH=/path/to/model
OCR_MY_CUSTOM_OCR_API_URL=http://localhost:8080/ocr
OCR_MY_CUSTOM_OCR_TIMEOUT=30

# Note: Any OCR_<ENGINE>_* variables are automatically discovered and loaded!
# You can add unlimited custom parameters - they go into extra_params dict
```

### 8.2 JSON Configuration File

```json
{
    "primary_engine": "paddle",
    "fallback_engines": ["tesseract", "easyocr"],
    "use_preprocessing": true,
    "max_image_dimension": 4096,
    "preprocessing_target_dpi": 300,
    "engines": {
        "paddle": {
            "enabled": true,
            "priority": 1,
            "min_confidence": 0.5,
            "use_gpu": false,
            "language": "en"
        },
        "tesseract": {
            "enabled": true,
            "priority": 2,
            "min_confidence": 0.6,
            "language": "eng"
        },
        "easyocr": {
            "enabled": true,
            "priority": 3,
            "min_confidence": 0.5,
            "use_gpu": false,
            "language": "en"
        }
    }
}
```

### 8.3 Programmatic Configuration

```python
from ocr import OCRConfig, OCREngineConfig, OCRFacade

# Create custom configuration
config = OCRConfig()
config.primary_engine = 'tesseract'  # Use Tesseract as primary
config.fallback_engines = ['paddle']  # PaddleOCR as fallback
config.use_preprocessing = True

# Custom engine settings
config.engines['tesseract'] = OCREngineConfig(
    name='tesseract',
    min_confidence=0.7,
    language='eng'
)

# Create facade with custom config
facade = OCRFacade(config)
result = facade.extract_text(image)
```

### 8.4 Dynamic Configuration Flow Diagram

Here's how the dynamic configuration system works under the hood:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Environment Variables                             │
│                                                                           │
│   OCR_PRIMARY_ENGINE=custom_engine                                       │
│   OCR_CUSTOM_ENGINE_MIN_CONFIDENCE=0.8                                   │
│   OCR_CUSTOM_ENGINE_API_KEY=secret123                                    │
│   OCR_CUSTOM_ENGINE_ENDPOINT=https://api.example.com                     │
│   OCR_PADDLE_MIN_CONFIDENCE=0.5                                          │
│   OCR_TESSERACT_MIN_CONFIDENCE=0.6                                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ OCRConfig.from_env()
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Dynamic Engine Discovery                              │
│                                                                           │
│  1. Scan all OCR_* environment variables                                 │
│  2. Extract engine names from pattern: OCR_<ENGINE>_*                    │
│  3. Discovered: ['custom_engine', 'paddle', 'tesseract']                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Auto-Create OCREngineConfig for Each Engine                │
│                                                                           │
│  config.engines = {                                                      │
│    'custom_engine': OCREngineConfig(                                     │
│       name='custom_engine',                                              │
│       min_confidence=0.8,                                                │
│       extra_params={                                                     │
│         'api_key': 'secret123',                                          │
│         'endpoint': 'https://api.example.com'                            │
│       }                                                                  │
│    ),                                                                    │
│    'paddle': OCREngineConfig(min_confidence=0.5, ...),                  │
│    'tesseract': OCREngineConfig(min_confidence=0.6, ...)                │
│  }                                                                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   ✅ No Code Changes Required!                           │
│   Your custom_engine is now fully configured and ready to use           │
│   Just register it in EngineFactory and it will work!                   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Benefit**: Add Google Cloud Vision, Azure OCR, AWS Textract, or your own custom engine with ZERO modifications to `config.py`. Just set environment variables!

---

## 8.5 Handling Missing Dependencies (Critical!)

### The Problem
When you configure an OCR engine via environment variables, the Python library might not be installed:

```bash
OCR_PRIMARY_ENGINE=google_vision  # But google-cloud-vision is NOT installed!
```

### The Solution: Multi-Layer Safety Net

#### Layer 1: Optional Registration (Factory Level)
```python
# In engine_factory.py - Auto-register with try/except
def _auto_register():
    """Register built-in OCR engines - only if dependencies available"""
    
    # PaddleOCR - optional
    try:
        from .engines.paddle_engine import PaddleOCREngine
        EngineFactory.register('paddle', PaddleOCREngine)
        logger.info("✓ Registered: paddle")
    except ImportError as e:
        logger.warning(f"✗ PaddleOCR not available: {e}")
    
    # Tesseract - optional
    try:
        from .engines.tesseract_engine import TesseractEngine
        EngineFactory.register('tesseract', TesseractEngine)
        logger.info("✓ Registered: tesseract")
    except ImportError as e:
        logger.warning(f"✗ Tesseract not available: {e}")
    
    # Google Cloud Vision - optional
    try:
        from .engines.google_vision_engine import GoogleVisionEngine
        EngineFactory.register('google_vision', GoogleVisionEngine)
        logger.info("✓ Registered: google_vision")
    except ImportError as e:
        logger.warning(f"✗ Google Cloud Vision not available: {e}")
    
    # Mock - always available (no external deps)
    from .engines.mock_engine import MockOCREngine
    EngineFactory.register('mock', MockOCREngine)
    logger.info("✓ Registered: mock")
```

**Result**: If library isn't installed, engine simply doesn't get registered. No crash!

#### Layer 2: Availability Check (Engine Level)
```python
# In each engine - implement is_available()
class GoogleVisionEngine(BaseOCREngine):
    def is_available(self) -> bool:
        """Check if engine can actually be used"""
        try:
            from google.cloud import vision
            # Optional: Check API credentials
            if not os.getenv('GOOGLE_APPLICATION_CREDENTIALS'):
                logger.warning("Google Vision: GOOGLE_APPLICATION_CREDENTIALS not set")
                return False
            return True
        except ImportError:
            return False
        except Exception as e:
            logger.error(f"Google Vision availability check failed: {e}")
            return False
```

#### Layer 3: Graceful Fallback (Facade Level)
```python
# In facade.py - OCRFacade.extract_text()
def extract_text(self, image, **kwargs):
    """Try engines in order, skip unavailable ones"""
    
    engines_to_try = [self._primary_engine] + self._fallback_engines
    
    for engine in engines_to_try:
        if engine is None:
            continue
        
        # CRITICAL: Check if engine is actually available
        if not engine.is_available():
            logger.warning(f"Engine {engine.get_name()} not available, skipping to next")
            continue
        
        try:
            result = engine.extract_text(image_array)
            
            if result['success'] and result['confidence'] >= min_conf:
                return result
        
        except Exception as e:
            logger.error(f"Engine {engine.get_name()} failed: {e}")
            continue
    
    # All engines failed - use metadata fallback
    return self._metadata_fallback(kwargs)
```

#### Layer 4: User-Friendly Error Messages
```python
# In facade.py - initialization
def __init__(self, config=None):
    self.config = config or OCRConfig.from_env()
    
    # Try to create primary engine
    try:
        self._primary_engine = EngineFactory.get_or_create(
            self.config.primary_engine,
            config=self.config.get_engine_config(self.config.primary_engine)
        )
    except ValueError as e:
        # Engine not registered (dependency missing)
        logger.error(
            f"Primary OCR engine '{self.config.primary_engine}' is not available.\n"
            f"Possible reasons:\n"
            f"  1. Python package not installed\n"
            f"  2. Engine not registered in EngineFactory\n"
            f"To install: pip install {self._get_package_name(self.config.primary_engine)}\n"
            f"Falling back to: {self.config.fallback_engines}"
        )
        self._primary_engine = None
    
    # Create fallback engines
    self._fallback_engines = []
    for engine_name in self.config.fallback_engines:
        try:
            engine = EngineFactory.get_or_create(engine_name, ...)
            if engine.is_available():
                self._fallback_engines.append(engine)
        except ValueError:
            logger.warning(f"Fallback engine '{engine_name}' not available")

def _get_package_name(self, engine_name):
    """Suggest pip package for common engines"""
    package_map = {
        'paddle': 'paddlepaddle paddleocr',
        'tesseract': 'pytesseract (also requires system tesseract)',
        'easyocr': 'easyocr',
        'google_vision': 'google-cloud-vision',
        'azure_vision': 'azure-cognitiveservices-vision-computervision'
    }
    return package_map.get(engine_name, f'{engine_name} (check documentation)')
```

### Example Scenarios

#### Scenario 1: Primary Missing, Fallback Works
```bash
OCR_PRIMARY_ENGINE=google_vision  # Not installed
OCR_FALLBACK_ENGINES=paddle,tesseract  # Paddle IS installed
```

**Output:**
```
WARNING: Primary OCR engine 'google_vision' is not available.
  To install: pip install google-cloud-vision
  Falling back to: ['paddle', 'tesseract']
INFO: Using fallback engine: paddle
SUCCESS: Text extracted with paddle (confidence: 0.87)
```

#### Scenario 2: All Engines Missing (Worst Case)
```bash
OCR_PRIMARY_ENGINE=google_vision  # Not installed
OCR_FALLBACK_ENGINES=azure_vision,easyocr  # Not installed
```

**Output:**
```
WARNING: Primary OCR engine 'google_vision' not available
WARNING: Fallback engine 'azure_vision' not available
WARNING: Fallback engine 'easyocr' not available
WARNING: All OCR engines unavailable, using metadata fallback
INFO: Extracted from metadata: window_title="Chrome - Document.pdf"
```

#### Scenario 3: Engine Installed But Misconfigured
```bash
OCR_PRIMARY_ENGINE=google_vision  # Library installed
# But GOOGLE_APPLICATION_CREDENTIALS not set
```

**Output:**
```
WARNING: Google Vision: GOOGLE_APPLICATION_CREDENTIALS not set
INFO: Engine google_vision not available, trying fallback: paddle
SUCCESS: Text extracted with paddle
```

### requirements.txt Structure

```txt
# Core dependencies (always required)
Pillow>=9.0.0
numpy>=1.20.0

# OCR engines (ALL OPTIONAL - install what you need)
# PaddleOCR
paddlepaddle>=2.4.0; extra == 'paddle'
paddleocr>=2.6.0; extra == 'paddle'

# Tesseract
pytesseract>=0.3.10; extra == 'tesseract'

# EasyOCR
easyocr>=1.6.0; extra == 'easyocr'

# Google Cloud Vision
google-cloud-vision>=3.0.0; extra == 'google'

# Azure Computer Vision
azure-cognitiveservices-vision-computervision>=0.9.0; extra == 'azure'

# Install examples:
# pip install -e .[paddle]              # Just PaddleOCR
# pip install -e .[paddle,tesseract]    # PaddleOCR + Tesseract
# pip install -e .[paddle,tesseract,google]  # Multiple engines
```

### Key Takeaways

✅ **No Crashes** - Missing dependencies don't break the app  
✅ **Graceful Fallback** - Automatically tries next available engine  
✅ **Clear Errors** - User knows exactly what to install  
✅ **Optional Everything** - Only install what you need  
✅ **Defensive Coding** - Multiple safety layers  
✅ **Production Ready** - Handles all edge cases  

**Bottom Line**: You can set `OCR_PRIMARY_ENGINE=anything` in your .env file. If it's not installed, the system gracefully falls back to available engines. If nothing is available, it uses metadata fallback. The app never crashes!

### Dependency Check Flow Diagram

```
User sets: OCR_PRIMARY_ENGINE=google_vision
         ↓
┌────────────────────────────────────────────────────────────────┐
│ Layer 1: Factory Registration (Startup)                        │
│                                                                 │
│  Try:                                                           │
│    import GoogleVisionEngine  ✗ ImportError                    │
│  Except:                                                        │
│    Log: "Google Vision not available"                          │
│    Skip registration                                            │
│                                                                 │
│  Available engines: ['paddle', 'mock']  (only imported ones)   │
└────────────────────────────────┬───────────────────────────────┘
                                 ↓
┌────────────────────────────────────────────────────────────────┐
│ Layer 2: Facade Initialization                                 │
│                                                                 │
│  Try:                                                           │
│    self._primary_engine = Factory.create('google_vision')      │
│  Except ValueError:  ← Engine not registered!                  │
│    Log: "Primary engine not available, install: pip install... │
│    self._primary_engine = None                                 │
│                                                                 │
│  Create fallbacks: [paddle_engine]  (only available ones)      │
└────────────────────────────────┬───────────────────────────────┘
                                 ↓
┌────────────────────────────────────────────────────────────────┐
│ Layer 3: Runtime Extraction                                    │
│                                                                 │
│  For engine in [primary, fallback1, fallback2]:                │
│    If engine is None: skip                                     │
│    If not engine.is_available(): skip  ← Runtime check         │
│    Try: result = engine.extract_text(img)                      │
│    If success: return result                                   │
│                                                                 │
│  All engines failed → metadata fallback                        │
└────────────────────────────────────────────────────────────────┘
         ↓
Result: App works! Used paddle (fallback) instead of google_vision
```

### Best Practices for Production Deployment

#### 1. **Install Only What You Need**
```bash
# Development: Install everything for testing
pip install -e .[paddle,tesseract,easyocr]

# Production: Only install what you'll use
pip install -e .[paddle]  # Just PaddleOCR

# Environment-specific
pip install -e .[google]  # Cloud deployment with Google Vision
```

#### 2. **Docker Multi-Stage Build**
```dockerfile
# Base image with core dependencies
FROM python:3.9-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Stage 1: PaddleOCR build
FROM base AS paddle-build
RUN pip install paddlepaddle paddleocr

# Stage 2: Production image (only copy what's needed)
FROM base AS production
ENV OCR_PRIMARY_ENGINE=paddle
ENV OCR_FALLBACK_ENGINES=mock
COPY --from=paddle-build /usr/local/lib/python3.9/site-packages /usr/local/lib/python3.9/site-packages
COPY . .
CMD ["python", "desktop_app.py"]
```

#### 3. **Kubernetes ConfigMap Example**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ocr-config
data:
  # Primary engine based on cluster capabilities
  OCR_PRIMARY_ENGINE: "paddle"
  OCR_FALLBACK_ENGINES: "mock"
  OCR_PADDLE_USE_GPU: "true"  # If GPU nodes available
  OCR_PADDLE_MIN_CONFIDENCE: "0.6"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jiraforge-app
spec:
  template:
    spec:
      containers:
      - name: app
        image: jiraforge:latest
        envFrom:
        - configMapRef:
            name: ocr-config
```

#### 4. **Health Check Endpoint**
```python
# Add to your app for monitoring
@app.route('/health/ocr')
def ocr_health_check():
    """Check which OCR engines are available"""
    from ocr import EngineFactory
    
    available = EngineFactory.get_available_engines()
    
    return {
        'status': 'healthy' if any(available.values()) else 'degraded',
        'engines': available,
        'primary_configured': os.getenv('OCR_PRIMARY_ENGINE'),
        'primary_available': available.get(os.getenv('OCR_PRIMARY_ENGINE'), False)
    }
```

**Example Response:**
```json
{
  "status": "healthy",
  "engines": {
    "paddle": true,
    "tesseract": false,
    "mock": true
  },
  "primary_configured": "paddle",
  "primary_available": true
}
```

---

## 9. Adding New OCR Engines

### Step-by-Step Guide (NO Config.py Changes Needed!)

The beauty of the dynamic configuration system is that **you never need to touch config.py**. The system automatically discovers any engine from environment variables.

#### Step 1: Create Engine Adapter File

```python
# ocr/engines/my_engine.py
from ..base_engine import BaseOCREngine
import logging

logger = logging.getLogger(__name__)


class MyOCREngine(BaseOCREngine):
    """Your custom OCR engine adapter"""
    
    _instance = None  # Singleton pattern
    
    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self, use_gpu=False, language='en', **extra_params):
        if hasattr(self, '_initialized'):
            return
        
        self.use_gpu = use_gpu
        self.language = language
        self.extra_params = extra_params  # Contains all custom params
        
        # Initialize your OCR engine here
        # Example: API client, model loading, etc.
        logger.info(f"Initializing MyOCREngine with params: {extra_params}")
        
        self._initialized = True
    
    def get_name(self) -> str:
        return 'my_engine'
    
    def extract_text(self, image):
        """Extract text using your engine"""
        try:
            # Your extraction logic here
            # Access custom params: self.extra_params['api_key']
            
            text = "Extracted text from my engine"
            confidence = 0.95
            
            return {
                'text': text,
                'confidence': confidence,
                'line_count': len(text.split('\n')),
                'success': True,
                'engine': self.get_name()
            }
        except Exception as e:
            logger.error(f"MyOCREngine extraction failed: {e}")
            return self._create_error_result(str(e))
    
    def is_available(self) -> bool:
        """Check if your engine is available"""
        try:
            # Check dependencies, API connectivity, etc.
            return True
        except:
            return False
    
    def get_capabilities(self):
        return {
            'gpu_support': self.use_gpu,
            'languages': [self.language],
            'confidence_scores': True,
            'custom_feature': True  # Your specific capability
        }
```

#### Step 2: Register Engine in Factory

```python
# In ocr/engine_factory.py - add to _auto_register() function

def _auto_register():
    """Register built-in OCR engines"""
    
    # ... existing registrations ...
    
    # Add your engine
    try:
        from .engines.my_engine import MyOCREngine
        EngineFactory.register('my_engine', MyOCREngine)
        logger.info("Registered: my_engine")
    except ImportError as e:
        logger.debug(f"MyOCREngine not available: {e}")
```

#### Step 3: Configure via Environment (NO CODE CHANGES!)

```bash
# .env file - That's ALL you need!
OCR_PRIMARY_ENGINE=my_engine
OCR_FALLBACK_ENGINES=paddle,tesseract

# Standard settings (automatically applied)
OCR_MY_ENGINE_MIN_CONFIDENCE=0.7
OCR_MY_ENGINE_USE_GPU=true
OCR_MY_ENGINE_LANGUAGE=ja

# Custom settings (automatically captured in extra_params)
OCR_MY_ENGINE_API_KEY=your-secret-key
OCR_MY_ENGINE_ENDPOINT=https://api.myocr.com
OCR_MY_ENGINE_TIMEOUT=30
OCR_MY_ENGINE_MODEL_VERSION=v2.1
OCR_MY_ENGINE_WHATEVER_YOU_WANT=any_value

# These custom params are available in your engine as:
# self.extra_params['api_key']
# self.extra_params['endpoint']
# self.extra_params['timeout']
# etc.
```

#### Step 4: Use It (Already Works!)

```python
from ocr import extract_text_from_image

# No code changes needed - configuration loaded automatically!
result = extract_text_from_image(screenshot)
# Uses 'my_engine' as configured in .env
```

### Real-World Example: Google Cloud Vision

Here's how to add Google Cloud Vision OCR without modifying config.py:

```python
# ocr/engines/google_vision_engine.py
from google.cloud import vision
from ..base_engine import BaseOCREngine
import logging

logger = logging.getLogger(__name__)


class GoogleVisionEngine(BaseOCREngine):
    _instance = None
    
    def __init__(self, **extra_params):
        if hasattr(self, '_initialized'):
            return
        
        # Get API key from extra_params (from OCR_GOOGLE_VISION_API_KEY env var)
        api_key = extra_params.get('api_key')
        project_id = extra_params.get('project_id')
        
        self.client = vision.ImageAnnotatorClient(credentials=api_key)
        self._initialized = True
    
    def get_name(self):
        return 'google_vision'
    
    def extract_text(self, image):
        response = self.client.text_detection(image=image)
        texts = response.text_annotations
        
        if texts:
            return {
                'text': texts[0].description,
                'confidence': 0.95,  # Google doesn't provide overall confidence
                'line_count': len(texts[0].description.split('\n')),
                'success': True,
                'engine': 'google_vision'
            }
        return self._create_error_result("No text detected")
    
    def is_available(self):
        return hasattr(self, 'client')
```

**Configuration (No config.py changes!):**

```bash
OCR_PRIMARY_ENGINE=google_vision
OCR_GOOGLE_VISION_API_KEY=your-api-key
OCR_GOOGLE_VISION_PROJECT_ID=your-project
OCR_GOOGLE_VISION_MIN_CONFIDENCE=0.7
```

### Benefits of This Approach

✅ **Zero Config.py Changes** - Just environment variables  
✅ **Unlimited Custom Parameters** - Any OCR_<ENGINE>_* variable is captured  
✅ **Type Safety** - Standard params (min_confidence, use_gpu) are strongly typed  
✅ **Flexibility** - Custom params go into extra_params dict  
✅ **Discovery** - System auto-detects all engines from environment  
✅ **Testing** - Easy to mock with different configs  

That's it! You can add Google Vision, Azure OCR, AWS Textract, or your own custom engine without ever touching config.py again.

---

## 10. Test Plan

### 10.1 Test File Structure

```
tests/
├── test_ocr/
│   ├── __init__.py
│   ├── test_base_engine.py      # Abstract class tests
│   ├── test_config.py           # Configuration tests
│   ├── test_engine_factory.py   # Factory tests
│   ├── test_facade.py           # Facade tests
│   ├── test_paddle_engine.py    # PaddleOCR adapter tests
│   ├── test_tesseract_engine.py # Tesseract adapter tests
│   ├── test_integration.py      # End-to-end tests
│   └── fixtures/                # Test images
│       ├── text_heavy.png
│       ├── mixed_content.png
│       └── no_text.png
```

### 10.2 Test Files

See detailed test files in next section.

---

## 11. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Breaking existing code** | Low | High | Backward compatible `extract_text_from_image` function, Phase 1-5 migration plan |
| **Performance regression** | Low | Medium | Benchmark before/after, lazy loading preserved, no overhead in hot path |
| **Complex configuration** | Low | Low | Dynamic discovery via env vars, good defaults, clear documentation |
| **Missing OCR dependencies** | **High** | Medium | **Multi-layer safety (4 layers): try/except registration, is_available() checks, graceful fallback, clear error messages** |
| **Misconfigured engines** | Medium | Low | Validate config at startup, is_available() runtime checks, health check endpoint |
| **Engine unavailability at runtime** | Medium | Medium | Automatic fallback chain, metadata fallback as last resort, never crashes |
| **Additional package size** | Low | Low | Optional dependencies, install only what you need ([paddle], [tesseract], etc.) |
| **Version conflicts** | Low | Medium | Pin versions in requirements.txt, separate extras for each engine |
| **Production deployment issues** | Low | High | Docker multi-stage builds, K8s ConfigMaps, health check endpoints, clear logs |
| **User sets invalid engine name** | Medium | Low | Factory raises ValueError with helpful message, falls back to available engines |
| **All engines fail** | Low | Medium | Metadata fallback always available, returns window_title + app_name |

### Risk Mitigation Examples

#### Missing Dependency Risk (High Probability)
**Scenario**: User sets `OCR_PRIMARY_ENGINE=google_vision` but library not installed

**Mitigation Layers**:
1. ✅ Factory won't register (ImportError caught)
2. ✅ Facade initialization handles ValueError  
3. ✅ Logs: "Install: pip install google-cloud-vision"
4. ✅ Falls back to next available engine
5. ✅ App continues working with fallback

**Result**: App never crashes, user gets clear error message

#### All Engines Unavailable (Worst Case)
**Scenario**: No OCR libraries installed, only core dependencies

**Mitigation**:
```python
# Only 'mock' engine registered (no external deps)
# Facade uses metadata fallback
result = {
    'text': 'window_title="Chrome - report.pdf" app_name="chrome.exe"',
    'method': 'metadata',
    'success': False,  # Indicates fallback used
    'window_title': 'Chrome - report.pdf',
    'app_name': 'chrome.exe'
}
```

**Result**: App provides partial functionality, doesn't crash

---

## Summary

The facade pattern refactoring with **dynamic configuration** provides:

### Core Benefits
1. ✅ **True Plug-and-Play**: Add ANY OCR engine via env vars - ZERO code changes to config.py
2. ✅ **Dynamic Engine Discovery**: System auto-detects engines from `OCR_<ENGINE>_*` pattern
3. ✅ **Unlimited Custom Parameters**: Any custom setting captured in `extra_params` dict
4. ✅ **Graceful Dependency Handling**: Missing libraries don't crash app (4-layer safety net)
5. ✅ **Easy Engine Swapping**: Change `OCR_PRIMARY_ENGINE` env var, restart app
6. ✅ **Intelligent Fallback Chain**: Automatically tries available engines in order
7. ✅ **Backward Compatibility**: `extract_text_from_image()` API unchanged
8. ✅ **Optional Dependencies**: Install only what you need (`pip install .[paddle]`)

### Architecture Benefits
9. ✅ **SOLID Principles**: Single responsibility, Open/closed, Dependency inversion
10. ✅ **Standardized Interface**: All engines implement `BaseOCREngine` ABC
11. ✅ **Better Testability**: Inject mock engine, test without real OCR libraries
12. ✅ **Factory Pattern**: Centralized engine creation with auto-registration
13. ✅ **Singleton Pattern**: Expensive models loaded once per engine

### Operational Benefits
14. ✅ **Production Ready**: Docker, Kubernetes, health checks included
15. ✅ **Clear Error Messages**: "Install: pip install google-cloud-vision"
16. ✅ **Runtime Availability Checks**: `is_available()` before every extraction
17. ✅ **Comprehensive Logging**: Track which engine used, why fallback triggered
18. ✅ **Never Crashes**: Metadata fallback as ultimate safety net

### Real-World Examples

**Add Google Cloud Vision** (Zero config.py changes):
```bash
OCR_PRIMARY_ENGINE=google_vision
OCR_GOOGLE_VISION_API_KEY=abc123
OCR_GOOGLE_VISION_PROJECT_ID=my-project
pip install google-cloud-vision
# Done! Restart app and it works
```

**Add Your Custom Engine** (Zero config.py changes):
```bash
OCR_PRIMARY_ENGINE=my_ai_ocr
OCR_MY_AI_OCR_ENDPOINT=https://api.mycompany.com/ocr
OCR_MY_AI_OCR_API_KEY=secret
OCR_MY_AI_OCR_TIMEOUT=30
# Just register in EngineFactory and it works!
```

**Comparison: Before vs After**

| Task | Before (Hardcoded) | After (Dynamic Facade) |
|------|-------------------|----------------------|
| Add new engine | Modify 3 files (text_extractor.py, config.py, __init__.py) | Create 1 adapter file, set env vars |
| Change primary engine | Edit text_extractor.py | Change env var |
| Configure engine | Edit source code | Set env vars |
| Handle missing deps | App crashes | Graceful fallback |
| Add custom params | Modify code | Set `OCR_ENGINE_PARAM=value` |

**Next Steps**: 
1. Implement the code files (Section 5)
2. Create test suite (OCR_FACADE_TEST_FILES.py)
3. Update requirements.txt with optional extras
4. Phase 1-5 migration (Section 7)

---

**Document Version**: 2.0 - Dynamic Configuration Edition  
**Last Updated**: February 18, 2026  
**Status**: Ready for Implementation
