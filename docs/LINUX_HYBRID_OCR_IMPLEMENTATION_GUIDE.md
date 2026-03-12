# Linux Hybrid OCR Implementation Guide

## Converting Screenshot-Based Approach to Hybrid OCR on Linux

| Property | Value |
|----------|-------|
| **Version** | 1.0 |
| **Created** | March 12, 2026 |
| **Project** | JIRAForge Time Tracker - Linux Edition |
| **Purpose** | Step-by-step implementation guide for converting Linux screenshot upload to Hybrid OCR approach |
| **Reference Docs** | HYBRID_OCR_WORKFLOW_DETAILED.md, LINUX_SCREENSHOT_AI_WORKFLOW.md |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Comparison](#2-architecture-comparison)
3. [Implementation Overview](#3-implementation-overview)
4. [Phase 1: OCR Module Implementation](#4-phase-1-ocr-module-implementation)
5. [Phase 2: Local Storage Layer](#5-phase-2-local-storage-layer)
6. [Phase 3: Desktop App Integration](#6-phase-3-desktop-app-integration)
7. [Phase 4: Batch Upload Service](#7-phase-4-batch-upload-service)
8. [Phase 5: AI Server Modifications](#8-phase-5-ai-server-modifications)
9. [Phase 6: Database Schema Updates](#9-phase-6-database-schema-updates)
10. [Testing Strategy](#10-testing-strategy)
11. [Migration & Rollback Plan](#11-migration--rollback-plan)
12. [Appendix: Code Templates](#appendix-code-templates)

---

## 1. Executive Summary

### Current State (Linux Screenshot Approach)

The existing Linux implementation:
1. Captures screenshots via Wayland/PipeWire ScreenCast Portal
2. Uploads full JPEG images (~500KB each) to Supabase Storage
3. Creates database records with `status='pending'`
4. AI Server polls, downloads images, runs Vision AI analysis

### Target State (Hybrid OCR Approach)

The new approach will:
1. **Keep** screenshot capture via Wayland/PipeWire (unchanged)
2. **Add** local OCR text extraction using PaddleOCR + Tesseract fallback
3. **Add** local classification (productive/non-productive/private)
4. **Add** local SQLite storage with accumulated session time
5. **Replace** image upload with text-only batch upload (5-20KB vs 500KB)
6. **Modify** AI Server to process text with LLM instead of Vision AI

### Expected Benefits

| Metric | Current | After Migration |
|--------|---------|-----------------|
| **Data Transfer** | ~500KB/screenshot | ~5-20KB/batch |
| **Bandwidth Reduction** | - | 96-99% |
| **AI API Costs** | Vision API (expensive) | Text LLM (85-96% cheaper) |
| **Processing Speed** | 3-5s/screenshot | <1s/screenshot |
| **Privacy** | Images sent to cloud | Only text sent to cloud |
| **Offline Support** | Limited | Full local processing |

---

## 2. Architecture Comparison

### Before: Screenshot-Based Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CURRENT LINUX ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  LINUX DESKTOP APP                    │           CLOUD                         │
│  ────────────────────                 │           ─────                         │
│                                       │                                         │
│  ┌─────────────────┐                  │                                         │
│  │ 1. Screenshot   │                  │                                         │
│  │    Capture      │                  │                                         │
│  │ (PipeWire/      │                  │                                         │
│  │  Wayland)       │                  │                                         │
│  └───────┬─────────┘                  │                                         │
│          │                            │                                         │
│          ▼                            │                                         │
│  ┌─────────────────┐    ~500KB/img    │    ┌─────────────────────────────────┐ │
│  │ 2. Upload JPEG  │─────────────────────▶│  3. Supabase Storage            │ │
│  │    to Storage   │                  │    │     + screenshots table          │ │
│  └─────────────────┘                  │    │     (status='pending')           │ │
│                                       │    └─────────────┬───────────────────┘ │
│                                       │                  │                      │
│                                       │                  ▼                      │
│                                       │    ┌─────────────────────────────────┐ │
│                                       │    │  4. AI Server Downloads Image   │ │
│                                       │    │     + Runs Vision AI            │ │
│                                       │    │     (GPT-4 Vision / Gemini)     │ │
│                                       │    └─────────────────────────────────┘ │
│                                       │                                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### After: Hybrid OCR Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         TARGET HYBRID OCR ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  LINUX DESKTOP APP (Local Processing)  │           CLOUD                        │
│  ────────────────────────────────────  │           ─────                        │
│                                        │                                        │
│  ┌─────────────────┐                   │                                        │
│  │ 1. Screenshot   │                   │                                        │
│  │    Capture      │                   │                                        │
│  │ (PipeWire)      │                   │                                        │
│  └───────┬─────────┘                   │                                        │
│          │                             │                                        │
│          ▼                             │                                        │
│  ┌─────────────────┐                   │                                        │
│  │ 2. OCR Module   │ ◄── NEW           │                                        │
│  │  ├─ PaddleOCR   │                   │                                        │
│  │  ├─ Tesseract   │                   │                                        │
│  │  └─ Privacy     │                   │                                        │
│  │      Filter     │                   │                                        │
│  └───────┬─────────┘                   │                                        │
│          │                             │                                        │
│          ▼                             │                                        │
│  ┌─────────────────┐                   │                                        │
│  │ 3. Local        │ ◄── NEW           │                                        │
│  │    Classify     │                   │                                        │
│  │  (work/non-work)│                   │                                        │
│  └───────┬─────────┘                   │                                        │
│          │                             │                                        │
│          ▼                             │                                        │
│  ┌─────────────────┐    5 min batch    │    ┌─────────────────────────────────┐│
│  │ 4. SQLite       │────(5-20KB)──────────▶│  5. Supabase                     ││
│  │    Storage      │                   │    │     activity_records table       ││
│  │  + Sessions     │                   │    │     (status='pending')           ││
│  └─────────────────┘                   │    └─────────────┬───────────────────┘│
│                                        │                  │                     │
│                                        │                  ▼                     │
│                                        │    ┌─────────────────────────────────┐│
│                                        │    │  6. AI Server (Text Analysis)   ││
│                                        │    │     + LLM (GPT-4o-mini/Gemini)  ││
│                                        │    │     + Jira Issue Matching       ││
│                                        │    └─────────────────────────────────┘│
│                                        │                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Implementation Overview

### Directory Structure Changes

```
python-desktop-app/
├── desktop_app.py              # Modify: Add OCR integration
├── desktop_app_linux.py        # Modify: Keep screenshot capture, add OCR hook
├── wayland_screenshot.py       # Keep: No changes needed
├── requirements.txt            # Modify: Add OCR dependencies
├── install_linux.sh            # Modify: Add OCR package installation
│
├── ocr/                        # NEW DIRECTORY
│   ├── __init__.py             # OCR module exports
│   ├── facade.py               # OCR facade (engine selection + fallback)
│   ├── engines/
│   │   ├── __init__.py
│   │   ├── base.py             # Base OCR engine interface
│   │   ├── paddle_engine.py    # PaddleOCR implementation
│   │   ├── tesseract_engine.py # Tesseract implementation
│   │   └── metadata_engine.py  # Window metadata fallback
│   ├── image_processor.py      # Image preprocessing for OCR
│   ├── privacy_filter.py       # Sensitive data redaction
│   └── config.py               # OCR configuration
│
├── local_storage/              # NEW DIRECTORY
│   ├── __init__.py
│   ├── sqlite_manager.py       # SQLite database management
│   ├── session_tracker.py      # Active session tracking
│   └── batch_uploader.py       # Batch upload to Supabase
│
└── classifiers/                # NEW DIRECTORY
    ├── __init__.py
    ├── local_classifier.py     # Rule-based classification
    └── classification_cache.py # Classification cache sync
```

### Implementation Phases

| Phase | Component | Duration | Dependencies |
|-------|-----------|----------|--------------|
| **Phase 1** | OCR Module | 3-4 days | None |
| **Phase 2** | Local Storage Layer | 2-3 days | Phase 1 |
| **Phase 3** | Desktop App Integration | 3-4 days | Phase 1, 2 |
| **Phase 4** | Batch Upload Service | 2 days | Phase 2, 3 |
| **Phase 5** | AI Server Modifications | 2-3 days | Phase 4 |
| **Phase 6** | Database Schema Updates | 1 day | None (can run parallel) |

**Total Estimated Duration: 13-17 days**

---

## 4. Phase 1: OCR Module Implementation

### 4.1 Linux-Specific Dependencies

#### System Packages (Ubuntu/Fedora)

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    libtesseract-dev \
    libleptonica-dev \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1

# Fedora/RHEL
sudo dnf install -y \
    tesseract \
    tesseract-langpack-eng \
    tesseract-devel \
    leptonica-devel \
    mesa-libGL \
    glib2
```

#### Python Dependencies

Add to `requirements.txt`:

```txt
# OCR Dependencies
paddlepaddle==2.6.0           # PaddleOCR backend (CPU version for broad compatibility)
paddleocr==2.7.0.3            # Primary OCR engine
pytesseract==0.3.10           # Tesseract fallback
opencv-python-headless==4.9.0.80  # Image processing (headless for Linux servers)
numpy>=1.21.0,<2.0.0          # Required by PaddleOCR
Pillow>=9.0.0                 # Image manipulation (already present)
```

### 4.2 OCR Module Implementation

#### File: `python-desktop-app/ocr/__init__.py`

```python
"""
OCR Module for JIRAForge Time Tracker

Provides local text extraction from screenshots using multiple OCR engines
with automatic fallback:
1. PaddleOCR (Primary) - Best accuracy for screen text
2. Tesseract (Fallback) - Widely available, good fallback
3. Metadata (Last Resort) - Window title/app name only
"""

from .facade import OCRFacade, extract_text_from_image
from .config import OCRConfig

__all__ = ['OCRFacade', 'extract_text_from_image', 'OCRConfig']
```

#### File: `python-desktop-app/ocr/config.py`

```python
"""OCR Configuration for Linux environment"""

import os

class OCRConfig:
    """Configuration for OCR processing"""
    
    # Engine selection (paddle, tesseract, auto)
    PRIMARY_ENGINE = os.getenv('OCR_PRIMARY_ENGINE', 'paddle')
    FALLBACK_ENABLED = os.getenv('OCR_FALLBACK_ENABLED', 'true').lower() == 'true'
    
    # PaddleOCR settings
    PADDLE_USE_GPU = os.getenv('OCR_USE_GPU', 'false').lower() == 'true'
    PADDLE_LANG = os.getenv('OCR_LANGUAGE', 'en')
    PADDLE_DET_DB_THRESH = 0.3  # Detection threshold
    PADDLE_REC_BATCH_NUM = 6    # Recognition batch size
    
    # Tesseract settings
    TESSERACT_CMD = os.getenv('TESSERACT_CMD', '/usr/bin/tesseract')
    TESSERACT_LANG = os.getenv('TESSERACT_LANG', 'eng')
    TESSERACT_CONFIG = '--oem 3 --psm 3'  # LSTM + auto page segmentation
    
    # Quality thresholds
    MIN_CONFIDENCE = float(os.getenv('OCR_MIN_CONFIDENCE', '0.5'))
    MIN_TEXT_LENGTH = int(os.getenv('OCR_MIN_TEXT_LENGTH', '10'))
    
    # Privacy settings
    PRIVACY_FILTER_ENABLED = os.getenv('OCR_PRIVACY_FILTER', 'true').lower() == 'true'
    
    # Performance settings
    MAX_IMAGE_SIZE = (1920, 1080)  # Resize larger images
    JPEG_QUALITY = 85
    TIMEOUT_SECONDS = 30
    
    # Engine backoff (seconds to wait after failure)
    ENGINE_BACKOFF_SECONDS = 300  # 5 minutes
```

#### File: `python-desktop-app/ocr/engines/base.py`

```python
"""Base OCR Engine Interface"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, List, Tuple
from PIL import Image


@dataclass
class OCRResult:
    """Standard OCR result structure"""
    text: str                           # Extracted text
    confidence: float                   # Overall confidence (0.0-1.0)
    method: str                         # Engine used (paddle/tesseract/metadata)
    line_count: int                     # Number of text lines
    word_count: int                     # Number of words
    processing_time_ms: float           # Processing time in milliseconds
    error_message: Optional[str] = None # Error if extraction failed
    bounding_boxes: Optional[List] = None  # Optional text regions
    
    def to_dict(self) -> dict:
        return {
            'text': self.text,
            'confidence': self.confidence,
            'method': self.method,
            'line_count': self.line_count,
            'word_count': self.word_count,
            'processing_time_ms': self.processing_time_ms,
            'error_message': self.error_message
        }


class BaseOCREngine(ABC):
    """Abstract base class for OCR engines"""
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Engine name identifier"""
        pass
    
    @property
    @abstractmethod
    def is_available(self) -> bool:
        """Check if engine is available and initialized"""
        pass
    
    @abstractmethod
    def extract_text(self, image: Image.Image) -> OCRResult:
        """
        Extract text from image.
        
        Args:
            image: PIL Image to process
            
        Returns:
            OCRResult with extracted text and metadata
        """
        pass
    
    def initialize(self) -> bool:
        """Initialize the engine. Override if needed."""
        return True
    
    def cleanup(self):
        """Cleanup resources. Override if needed."""
        pass
```

#### File: `python-desktop-app/ocr/engines/paddle_engine.py`

```python
"""PaddleOCR Engine - Primary OCR for Linux"""

import time
import threading
from typing import Optional
from PIL import Image
import numpy as np

from .base import BaseOCREngine, OCRResult
from ..config import OCRConfig


class PaddleOCREngine(BaseOCREngine):
    """
    PaddleOCR-based text extraction.
    High accuracy for screen text with good multilingual support.
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self._ocr = None
        self._initialized = False
        self._init_error = None
    
    @classmethod
    def get_instance(cls) -> 'PaddleOCREngine':
        """Singleton instance for resource efficiency"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
    
    @property
    def name(self) -> str:
        return 'paddle'
    
    @property
    def is_available(self) -> bool:
        if not self._initialized:
            self.initialize()
        return self._initialized and self._ocr is not None
    
    def initialize(self) -> bool:
        """Initialize PaddleOCR (lazy loading)"""
        if self._initialized:
            return self._ocr is not None
        
        try:
            from paddleocr import PaddleOCR
            
            # Initialize with CPU (Linux typically doesn't have CUDA)
            self._ocr = PaddleOCR(
                use_angle_cls=True,           # Detect text orientation
                lang=OCRConfig.PADDLE_LANG,
                use_gpu=OCRConfig.PADDLE_USE_GPU,
                show_log=False,               # Suppress logging
                det_db_thresh=OCRConfig.PADDLE_DET_DB_THRESH,
                rec_batch_num=OCRConfig.PADDLE_REC_BATCH_NUM,
            )
            self._initialized = True
            print("[OCR] PaddleOCR initialized successfully")
            return True
            
        except ImportError as e:
            self._init_error = f"PaddleOCR not installed: {e}"
            print(f"[OCR] {self._init_error}")
        except Exception as e:
            self._init_error = f"PaddleOCR init failed: {e}"
            print(f"[OCR] {self._init_error}")
        
        self._initialized = True
        return False
    
    def extract_text(self, image: Image.Image) -> OCRResult:
        """Extract text using PaddleOCR"""
        start_time = time.time()
        
        if not self.is_available:
            return OCRResult(
                text='',
                confidence=0.0,
                method=self.name,
                line_count=0,
                word_count=0,
                processing_time_ms=0,
                error_message=self._init_error or "PaddleOCR not available"
            )
        
        try:
            # Convert PIL Image to numpy array (RGB)
            if image.mode != 'RGB':
                image = image.convert('RGB')
            img_array = np.array(image)
            
            # Run OCR
            result = self._ocr.ocr(img_array, cls=True)
            
            # Extract text and confidence
            lines = []
            confidences = []
            boxes = []
            
            if result and result[0]:
                for line in result[0]:
                    if line and len(line) >= 2:
                        box, (text, conf) = line[0], line[1]
                        if text.strip():
                            lines.append(text.strip())
                            confidences.append(conf)
                            boxes.append(box)
            
            # Combine results
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            processing_time = (time.time() - start_time) * 1000
            
            return OCRResult(
                text=full_text,
                confidence=avg_confidence,
                method=self.name,
                line_count=len(lines),
                word_count=len(full_text.split()),
                processing_time_ms=processing_time,
                bounding_boxes=boxes
            )
            
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            return OCRResult(
                text='',
                confidence=0.0,
                method=self.name,
                line_count=0,
                word_count=0,
                processing_time_ms=processing_time,
                error_message=str(e)
            )
    
    def cleanup(self):
        """Release PaddleOCR resources"""
        self._ocr = None
        self._initialized = False
```

#### File: `python-desktop-app/ocr/engines/tesseract_engine.py`

```python
"""Tesseract OCR Engine - Fallback for Linux"""

import time
import shutil
from typing import Optional
from PIL import Image

from .base import BaseOCREngine, OCRResult
from ..config import OCRConfig


class TesseractOCREngine(BaseOCREngine):
    """
    Tesseract-based text extraction.
    Widely available on Linux, good fallback option.
    """
    
    def __init__(self):
        self._pytesseract = None
        self._initialized = False
        self._init_error = None
    
    @property
    def name(self) -> str:
        return 'tesseract'
    
    @property
    def is_available(self) -> bool:
        if not self._initialized:
            self.initialize()
        return self._initialized and self._pytesseract is not None
    
    def initialize(self) -> bool:
        """Initialize Tesseract"""
        if self._initialized:
            return self._pytesseract is not None
        
        try:
            import pytesseract
            
            # Check Tesseract binary
            tesseract_path = OCRConfig.TESSERACT_CMD
            if not shutil.which(tesseract_path):
                # Try default path
                tesseract_path = shutil.which('tesseract')
                if not tesseract_path:
                    raise FileNotFoundError("Tesseract not found in PATH")
            
            pytesseract.pytesseract.tesseract_cmd = tesseract_path
            
            # Verify it works
            pytesseract.get_tesseract_version()
            
            self._pytesseract = pytesseract
            self._initialized = True
            print(f"[OCR] Tesseract initialized: {tesseract_path}")
            return True
            
        except ImportError as e:
            self._init_error = f"pytesseract not installed: {e}"
            print(f"[OCR] {self._init_error}")
        except FileNotFoundError as e:
            self._init_error = f"Tesseract binary not found: {e}"
            print(f"[OCR] {self._init_error}")
        except Exception as e:
            self._init_error = f"Tesseract init failed: {e}"
            print(f"[OCR] {self._init_error}")
        
        self._initialized = True
        return False
    
    def extract_text(self, image: Image.Image) -> OCRResult:
        """Extract text using Tesseract"""
        start_time = time.time()
        
        if not self.is_available:
            return OCRResult(
                text='',
                confidence=0.0,
                method=self.name,
                line_count=0,
                word_count=0,
                processing_time_ms=0,
                error_message=self._init_error or "Tesseract not available"
            )
        
        try:
            # Convert to RGB if needed
            if image.mode != 'RGB':
                image = image.convert('RGB')
            
            # Get detailed data with confidence
            data = self._pytesseract.image_to_data(
                image,
                lang=OCRConfig.TESSERACT_LANG,
                config=OCRConfig.TESSERACT_CONFIG,
                output_type=self._pytesseract.Output.DICT
            )
            
            # Extract text and calculate confidence
            lines = []
            confidences = []
            current_line = []
            current_line_num = -1
            
            for i, text in enumerate(data['text']):
                if text.strip():
                    conf = int(data['conf'][i])
                    line_num = data['line_num'][i]
                    
                    if line_num != current_line_num and current_line:
                        lines.append(' '.join(current_line))
                        current_line = []
                    
                    current_line.append(text.strip())
                    current_line_num = line_num
                    if conf > 0:  # Ignore -1 confidence
                        confidences.append(conf / 100.0)
            
            # Add last line
            if current_line:
                lines.append(' '.join(current_line))
            
            full_text = '\n'.join(lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            processing_time = (time.time() - start_time) * 1000
            
            return OCRResult(
                text=full_text,
                confidence=avg_confidence,
                method=self.name,
                line_count=len(lines),
                word_count=len(full_text.split()),
                processing_time_ms=processing_time
            )
            
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            return OCRResult(
                text='',
                confidence=0.0,
                method=self.name,
                line_count=0,
                word_count=0,
                processing_time_ms=processing_time,
                error_message=str(e)
            )
```

#### File: `python-desktop-app/ocr/engines/metadata_engine.py`

```python
"""Metadata Engine - Last Resort Fallback"""

import time
from PIL import Image

from .base import BaseOCREngine, OCRResult


class MetadataOCREngine(BaseOCREngine):
    """
    Metadata-based "OCR" - uses window title and app name only.
    Used as last resort when all OCR engines fail.
    """
    
    def __init__(self, window_title: str = '', app_name: str = ''):
        self._window_title = window_title
        self._app_name = app_name
    
    def set_metadata(self, window_title: str, app_name: str):
        """Update metadata for extraction"""
        self._window_title = window_title
        self._app_name = app_name
    
    @property
    def name(self) -> str:
        return 'metadata'
    
    @property
    def is_available(self) -> bool:
        return True  # Always available
    
    def extract_text(self, image: Image.Image = None) -> OCRResult:
        """Return window metadata as text"""
        start_time = time.time()
        
        # Combine metadata into text
        parts = []
        if self._app_name:
            parts.append(f"Application: {self._app_name}")
        if self._window_title:
            parts.append(f"Window: {self._window_title}")
        
        text = '\n'.join(parts)
        
        processing_time = (time.time() - start_time) * 1000
        
        return OCRResult(
            text=text,
            confidence=0.5 if text else 0.0,  # Lower confidence for metadata
            method=self.name,
            line_count=len(parts),
            word_count=len(text.split()),
            processing_time_ms=processing_time,
            error_message="OCR unavailable - using window metadata only" if not text else None
        )
```

#### File: `python-desktop-app/ocr/image_processor.py`

```python
"""Image preprocessing for OCR optimization on Linux"""

from PIL import Image, ImageEnhance, ImageFilter
import numpy as np
from typing import Tuple

from .config import OCRConfig


def preprocess_screenshot(image: Image.Image, engine_hint: str = 'paddle') -> Image.Image:
    """
    Preprocess screenshot for better OCR accuracy.
    
    Args:
        image: PIL Image to preprocess
        engine_hint: Target OCR engine ('paddle', 'tesseract')
        
    Returns:
        Preprocessed PIL Image
    """
    # Ensure RGB mode
    if image.mode == 'RGBA':
        # Create white background for transparency
        background = Image.new('RGB', image.size, (255, 255, 255))
        background.paste(image, mask=image.split()[3])
        image = background
    elif image.mode != 'RGB':
        image = image.convert('RGB')
    
    # Resize if too large
    max_size = OCRConfig.MAX_IMAGE_SIZE
    if image.size[0] > max_size[0] or image.size[1] > max_size[1]:
        image.thumbnail(max_size, Image.LANCZOS)
    
    # Engine-specific preprocessing
    if engine_hint == 'tesseract':
        image = _preprocess_for_tesseract(image)
    # PaddleOCR generally works well without heavy preprocessing
    
    return image


def _preprocess_for_tesseract(image: Image.Image) -> Image.Image:
    """
    Tesseract-specific preprocessing.
    Tesseract benefits from high contrast and clean images.
    """
    # Convert to grayscale for better text detection
    gray = image.convert('L')
    
    # Enhance contrast
    enhancer = ImageEnhance.Contrast(gray)
    gray = enhancer.enhance(1.5)
    
    # Slight sharpening
    gray = gray.filter(ImageFilter.SHARPEN)
    
    # Convert back to RGB (some Tesseract configs expect it)
    return gray.convert('RGB')


def extract_text_regions(image: Image.Image) -> Image.Image:
    """
    Extract regions likely to contain text.
    Useful for reducing OCR processing time on large screenshots.
    """
    # For now, return full image
    # Future: implement text region detection
    return image


def calculate_image_hash(image: Image.Image) -> str:
    """
    Calculate perceptual hash of image.
    Used to detect duplicate/unchanged screenshots.
    """
    import hashlib
    
    # Resize to small fixed size for hashing
    small = image.resize((16, 16), Image.LANCZOS).convert('L')
    pixels = list(small.getdata())
    
    # Simple average hash
    avg = sum(pixels) / len(pixels)
    bits = ''.join('1' if p > avg else '0' for p in pixels)
    
    return hashlib.md5(bits.encode()).hexdigest()
```

#### File: `python-desktop-app/ocr/privacy_filter.py`

```python
"""Privacy Filter - Redact sensitive information from OCR text"""

import re
from typing import List, Tuple


class PrivacyFilter:
    """
    Filters sensitive information from OCR-extracted text.
    Runs locally before any data is sent to the cloud.
    """
    
    # Compiled regex patterns for performance
    PATTERNS = [
        # Credit card numbers (13-19 digits, optionally with spaces/dashes)
        (re.compile(r'\b(?:\d[ -]*?){13,19}\b'), '[CARD_REDACTED]'),
        
        # SSN (XXX-XX-XXXX)
        (re.compile(r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b'), '[SSN_REDACTED]'),
        
        # Phone numbers (various formats)
        (re.compile(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'), '[PHONE_REDACTED]'),
        
        # Email addresses
        (re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'), '[EMAIL_REDACTED]'),
        
        # API keys / tokens (long alphanumeric strings)
        (re.compile(r'\b[A-Za-z0-9_-]{32,}\b'), '[TOKEN_REDACTED]'),
        
        # AWS access keys
        (re.compile(r'\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b'), '[AWS_KEY_REDACTED]'),
        
        # Password fields (common patterns in forms)
        (re.compile(r'(?i)password\s*[:=]\s*\S+'), '[PASSWORD_REDACTED]'),
        
        # Bank account numbers (8-17 digits)
        (re.compile(r'\b\d{8,17}\b'), '[ACCOUNT_REDACTED]'),
    ]
    
    # Keywords that indicate sensitive context
    SENSITIVE_KEYWORDS = {
        'password', 'secret', 'token', 'api_key', 'apikey', 'api-key',
        'private_key', 'privatekey', 'private-key', 'credential',
        'ssn', 'social security', 'credit card', 'bank account',
        'routing number', 'cvv', 'pin', 'otp'
    }
    
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
    
    def filter_text(self, text: str) -> Tuple[str, List[str]]:
        """
        Filter sensitive information from text.
        
        Args:
            text: Raw OCR-extracted text
            
        Returns:
            Tuple of (filtered_text, list of redaction types applied)
        """
        if not self.enabled or not text:
            return text, []
        
        redactions = []
        filtered = text
        
        # Apply regex patterns
        for pattern, replacement in self.PATTERNS:
            matches = pattern.findall(filtered)
            if matches:
                redactions.append(replacement.strip('[]'))
                filtered = pattern.sub(replacement, filtered)
        
        # Check for sensitive keyword context
        text_lower = text.lower()
        for keyword in self.SENSITIVE_KEYWORDS:
            if keyword in text_lower:
                redactions.append(f'CONTEXT_{keyword.upper()}')
        
        return filtered, list(set(redactions))
    
    def is_sensitive_context(self, window_title: str, app_name: str) -> bool:
        """
        Check if the current context is sensitive.
        
        Args:
            window_title: Current window title
            app_name: Application name
            
        Returns:
            True if context appears sensitive
        """
        combined = f"{window_title} {app_name}".lower()
        
        sensitive_apps = {
            'keepass', 'lastpass', '1password', 'bitwarden',  # Password managers
            'bank', 'chase', 'wells fargo', 'citi',           # Banking
            'payroll', 'salary', 'hr',                         # HR/Payroll
            'medical', 'health', 'hipaa',                      # Healthcare
        }
        
        for keyword in sensitive_apps:
            if keyword in combined:
                return True
        
        return False
```

#### File: `python-desktop-app/ocr/facade.py`

```python
"""OCR Facade - Unified interface with automatic fallback"""

import time
import threading
from typing import Optional, Dict
from datetime import datetime, timedelta
from PIL import Image

from .engines.base import OCRResult
from .engines.paddle_engine import PaddleOCREngine
from .engines.tesseract_engine import TesseractOCREngine
from .engines.metadata_engine import MetadataOCREngine
from .image_processor import preprocess_screenshot
from .privacy_filter import PrivacyFilter
from .config import OCRConfig


class OCRFacade:
    """
    Unified OCR interface with automatic engine selection and fallback.
    
    Fallback chain:
    1. PaddleOCR (Primary) - Best accuracy
    2. Tesseract (Fallback 1) - Widely available
    3. Metadata (Fallback 2) - Window title/app only
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self._paddle = PaddleOCREngine.get_instance()
        self._tesseract = TesseractOCREngine()
        self._metadata = MetadataOCREngine()
        self._privacy_filter = PrivacyFilter(enabled=OCRConfig.PRIVACY_FILTER_ENABLED)
        
        # Engine backoff tracking
        self._engine_failures: Dict[str, datetime] = {}
    
    @classmethod
    def get_instance(cls) -> 'OCRFacade':
        """Get singleton instance"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
    
    def _is_engine_in_backoff(self, engine_name: str) -> bool:
        """Check if engine is in backoff period after failure"""
        if engine_name not in self._engine_failures:
            return False
        
        backoff_until = self._engine_failures[engine_name]
        if datetime.now() < backoff_until:
            return True
        
        # Backoff expired, reset
        del self._engine_failures[engine_name]
        return False
    
    def _record_engine_failure(self, engine_name: str):
        """Record engine failure for backoff"""
        backoff_seconds = OCRConfig.ENGINE_BACKOFF_SECONDS
        self._engine_failures[engine_name] = datetime.now() + timedelta(seconds=backoff_seconds)
        print(f"[OCR] {engine_name} engine in backoff for {backoff_seconds}s")
    
    def extract_text(
        self,
        image: Image.Image,
        window_title: str = '',
        app_name: str = '',
        apply_privacy_filter: bool = True
    ) -> OCRResult:
        """
        Extract text from image with automatic fallback.
        
        Args:
            image: PIL Image to process
            window_title: Window title for metadata fallback
            app_name: Application name for metadata fallback
            apply_privacy_filter: Whether to filter sensitive data
            
        Returns:
            OCRResult with extracted text
        """
        # Check for sensitive context
        if self._privacy_filter.is_sensitive_context(window_title, app_name):
            print(f"[OCR] Sensitive context detected - using metadata only")
            self._metadata.set_metadata(window_title, app_name)
            return self._metadata.extract_text()
        
        # Update metadata engine with current context
        self._metadata.set_metadata(window_title, app_name)
        
        # Try engines in order
        engines = [
            ('paddle', self._paddle, 'paddle'),
            ('tesseract', self._tesseract, 'tesseract'),
            ('metadata', self._metadata, None),
        ]
        
        for name, engine, preprocess_hint in engines:
            # Skip if in backoff
            if self._is_engine_in_backoff(name):
                continue
            
            # Skip if not available
            if not engine.is_available:
                continue
            
            try:
                # Preprocess image for this engine
                if preprocess_hint:
                    processed_image = preprocess_screenshot(image, preprocess_hint)
                else:
                    processed_image = image
                
                # Extract text
                result = engine.extract_text(processed_image)
                
                # Check quality
                if result.confidence >= OCRConfig.MIN_CONFIDENCE and len(result.text) >= OCRConfig.MIN_TEXT_LENGTH:
                    # Apply privacy filter
                    if apply_privacy_filter and result.text:
                        filtered_text, redactions = self._privacy_filter.filter_text(result.text)
                        if redactions:
                            print(f"[OCR] Privacy filter applied: {redactions}")
                        result = OCRResult(
                            text=filtered_text,
                            confidence=result.confidence,
                            method=result.method,
                            line_count=result.line_count,
                            word_count=len(filtered_text.split()),
                            processing_time_ms=result.processing_time_ms,
                            bounding_boxes=result.bounding_boxes
                        )
                    
                    print(f"[OCR] {name} succeeded: {result.line_count} lines, {result.confidence:.2f} confidence")
                    return result
                
                # Low quality result - try next engine
                print(f"[OCR] {name} low quality (conf={result.confidence:.2f}, len={len(result.text)})")
                
            except Exception as e:
                print(f"[OCR] {name} failed: {e}")
                if name != 'metadata':
                    self._record_engine_failure(name)
        
        # All engines failed - return metadata result
        print("[OCR] All engines failed, returning metadata only")
        return self._metadata.extract_text()


# Convenience function for direct import
def extract_text_from_image(
    image: Image.Image,
    window_title: str = '',
    app_name: str = ''
) -> OCRResult:
    """
    Extract text from screenshot image.
    
    Convenience wrapper around OCRFacade.
    
    Args:
        image: PIL Image to process
        window_title: Window title for context
        app_name: Application name for context
        
    Returns:
        OCRResult with extracted text
    """
    facade = OCRFacade.get_instance()
    return facade.extract_text(image, window_title, app_name)
```

---

## 5. Phase 2: Local Storage Layer

### 5.1 SQLite Schema for Linux

#### File: `python-desktop-app/local_storage/__init__.py`

```python
"""Local Storage Module for Hybrid OCR"""

from .sqlite_manager import SQLiteManager
from .session_tracker import ActiveSessionTracker
from .batch_uploader import BatchUploader

__all__ = ['SQLiteManager', 'ActiveSessionTracker', 'BatchUploader']
```

#### File: `python-desktop-app/local_storage/sqlite_manager.py`

```python
"""SQLite Database Manager for Linux"""

import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from contextlib import contextmanager


def get_linux_app_data_dir() -> str:
    """Get Linux app data directory"""
    # XDG Base Directory specification
    xdg_data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    app_dir = os.path.join(xdg_data, 'timetracker')
    os.makedirs(app_dir, exist_ok=True)
    return app_dir


class SQLiteManager:
    """
    SQLite database manager for local activity storage.
    Thread-safe with connection pooling.
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_path = os.path.join(get_linux_app_data_dir(), 'hybrid_ocr_storage.db')
        
        self.db_path = db_path
        self._local = threading.local()
        self._init_database()
    
    @classmethod
    def get_instance(cls, db_path: Optional[str] = None) -> 'SQLiteManager':
        """Get singleton instance"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(db_path)
        return cls._instance
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get thread-local connection"""
        if not hasattr(self._local, 'connection') or self._local.connection is None:
            self._local.connection = sqlite3.connect(
                self.db_path,
                check_same_thread=False,
                timeout=30.0
            )
            self._local.connection.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            self._local.connection.execute('PRAGMA journal_mode=WAL')
            self._local.connection.execute('PRAGMA busy_timeout=30000')
        return self._local.connection
    
    @contextmanager
    def get_cursor(self):
        """Context manager for database cursor"""
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            yield cursor
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()
    
    def _init_database(self):
        """Initialize database schema"""
        with self.get_cursor() as cursor:
            # Active sessions table - tracks accumulated time per window
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS active_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    window_title TEXT,
                    application_name TEXT,
                    classification TEXT DEFAULT 'unknown',
                    ocr_text TEXT,
                    ocr_method TEXT,
                    ocr_confidence REAL DEFAULT 0.0,
                    ocr_error_message TEXT,
                    total_time_seconds REAL DEFAULT 0,
                    visit_count INTEGER DEFAULT 1,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    timer_started_at TEXT,
                    batch_id TEXT,
                    synced INTEGER DEFAULT 0,
                    UNIQUE(window_title, application_name)
                )
            ''')
            
            # Activity records for batch upload
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS pending_activity_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    organization_id TEXT,
                    window_title TEXT,
                    application_name TEXT,
                    ocr_text TEXT,
                    ocr_method TEXT,
                    ocr_confidence REAL,
                    classification TEXT,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    duration_seconds INTEGER NOT NULL,
                    work_date TEXT NOT NULL,
                    user_timezone TEXT,
                    user_assigned_issues TEXT,
                    metadata TEXT,
                    batch_id TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    synced INTEGER DEFAULT 0,
                    sync_error TEXT
                )
            ''')
            
            # App classification cache
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS app_classifications_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id TEXT,
                    project_key TEXT,
                    identifier TEXT NOT NULL,
                    display_name TEXT,
                    classification TEXT NOT NULL,
                    match_by TEXT NOT NULL DEFAULT 'process',
                    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(organization_id, project_key, identifier, match_by)
                )
            ''')
            
            # Create indices
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_sessions_synced ON active_sessions(synced)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_synced ON pending_activity_records(synced)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_batch ON pending_activity_records(batch_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_cache_identifier ON app_classifications_cache(identifier)')
        
        print(f"[SQLite] Database initialized: {self.db_path}")
    
    def insert_activity_record(self, record: Dict[str, Any]) -> int:
        """Insert a pending activity record"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                INSERT INTO pending_activity_records (
                    user_id, organization_id, window_title, application_name,
                    ocr_text, ocr_method, ocr_confidence, classification,
                    start_time, end_time, duration_seconds, work_date,
                    user_timezone, user_assigned_issues, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                record['user_id'],
                record.get('organization_id'),
                record.get('window_title'),
                record.get('application_name'),
                record.get('ocr_text'),
                record.get('ocr_method'),
                record.get('ocr_confidence'),
                record.get('classification'),
                record['start_time'],
                record['end_time'],
                record['duration_seconds'],
                record['work_date'],
                record.get('user_timezone'),
                record.get('user_assigned_issues'),  # JSON string
                record.get('metadata'),  # JSON string
            ))
            return cursor.lastrowid
    
    def get_pending_records(self, limit: int = 100) -> List[Dict]:
        """Get pending records for batch upload"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                SELECT * FROM pending_activity_records 
                WHERE synced = 0 
                ORDER BY created_at ASC 
                LIMIT ?
            ''', (limit,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
    
    def mark_records_synced(self, record_ids: List[int], batch_id: str):
        """Mark records as synced"""
        with self.get_cursor() as cursor:
            placeholders = ','.join('?' * len(record_ids))
            cursor.execute(f'''
                UPDATE pending_activity_records 
                SET synced = 1, batch_id = ?
                WHERE id IN ({placeholders})
            ''', [batch_id] + record_ids)
    
    def mark_record_failed(self, record_id: int, error: str):
        """Mark record sync as failed"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                UPDATE pending_activity_records 
                SET sync_error = ?
                WHERE id = ?
            ''', (error, record_id))
    
    def get_pending_count(self) -> int:
        """Get count of pending records"""
        with self.get_cursor() as cursor:
            cursor.execute('SELECT COUNT(*) FROM pending_activity_records WHERE synced = 0')
            return cursor.fetchone()[0]
    
    def cleanup_old_synced_records(self, days: int = 7):
        """Delete old synced records"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                DELETE FROM pending_activity_records 
                WHERE synced = 1 
                AND datetime(created_at) < datetime('now', ?)
            ''', (f'-{days} days',))
            deleted = cursor.rowcount
            if deleted > 0:
                print(f"[SQLite] Cleaned up {deleted} old synced records")
```

#### File: `python-desktop-app/local_storage/session_tracker.py`

```python
"""Active Session Tracker for accumulated time tracking"""

import threading
import json
from datetime import datetime, timezone
from typing import Optional, Dict, Tuple

from .sqlite_manager import SQLiteManager


class ActiveSessionTracker:
    """
    Tracks time accumulated per unique (window_title, application_name) pair.
    Uses SQLite for persistence across app restarts.
    """
    
    def __init__(self, db_manager: Optional[SQLiteManager] = None):
        self._db = db_manager or SQLiteManager.get_instance()
        self._lock = threading.Lock()
        self._current_key: Optional[Tuple[str, str]] = None
        self._timer_start: Optional[datetime] = None
    
    def on_window_switch(
        self,
        window_title: str,
        app_name: str,
        classification: str = 'unknown',
        ocr_result: Optional[Dict] = None
    ) -> Optional[Dict]:
        """
        Handle window switch event.
        
        1. Stops timer on previous session and accumulates time
        2. Creates or resumes session for new window
        3. Stores OCR data if available
        
        Args:
            window_title: New window title
            app_name: New application name
            classification: Work classification (productive/non_productive/private/unknown)
            ocr_result: OCR extraction result dict
            
        Returns:
            Previous session data if timer was stopped, None otherwise
        """
        with self._lock:
            now = datetime.now(timezone.utc)
            now_iso = now.isoformat()
            new_key = (window_title, app_name)
            
            previous_session = None
            
            # Stop timer on current session
            if self._current_key is not None and self._timer_start is not None:
                elapsed = (now - self._timer_start).total_seconds()
                if elapsed > 0:
                    previous_session = self._stop_timer(elapsed, now_iso)
            
            # Skip if same window
            if new_key == self._current_key:
                return previous_session
            
            # Get or create session for new window
            with self._db.get_cursor() as cursor:
                cursor.execute('''
                    SELECT id, total_time_seconds, visit_count 
                    FROM active_sessions 
                    WHERE window_title = ? AND application_name = ?
                ''', (window_title, app_name))
                existing = cursor.fetchone()
                
                # Prepare OCR data
                ocr_text = ocr_result.get('text', '') if ocr_result else ''
                ocr_method = ocr_result.get('method', '') if ocr_result else ''
                ocr_confidence = ocr_result.get('confidence', 0.0) if ocr_result else 0.0
                ocr_error = ocr_result.get('error_message') if ocr_result else None
                
                if existing:
                    # Resume existing session
                    cursor.execute('''
                        UPDATE active_sessions SET
                            visit_count = visit_count + 1,
                            last_seen = ?,
                            timer_started_at = ?,
                            classification = COALESCE(?, classification),
                            ocr_text = COALESCE(?, ocr_text),
                            ocr_method = COALESCE(?, ocr_method),
                            ocr_confidence = COALESCE(?, ocr_confidence)
                        WHERE id = ?
                    ''', (now_iso, now_iso, classification, ocr_text, ocr_method, ocr_confidence, existing['id']))
                else:
                    # Create new session
                    cursor.execute('''
                        INSERT INTO active_sessions (
                            window_title, application_name, classification,
                            ocr_text, ocr_method, ocr_confidence, ocr_error_message,
                            first_seen, last_seen, timer_started_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        window_title, app_name, classification,
                        ocr_text, ocr_method, ocr_confidence, ocr_error,
                        now_iso, now_iso, now_iso
                    ))
            
            # Update tracking state
            self._current_key = new_key
            self._timer_start = now
            
            return previous_session
    
    def _stop_timer(self, elapsed_seconds: float, now_iso: str) -> Optional[Dict]:
        """Stop timer and accumulate time for current session"""
        if self._current_key is None:
            return None
        
        window_title, app_name = self._current_key
        
        with self._db.get_cursor() as cursor:
            # Get current session data
            cursor.execute('''
                SELECT * FROM active_sessions 
                WHERE window_title = ? AND application_name = ?
            ''', (window_title, app_name))
            session = cursor.fetchone()
            
            if session:
                # Accumulate time
                cursor.execute('''
                    UPDATE active_sessions SET
                        total_time_seconds = total_time_seconds + ?,
                        last_seen = ?,
                        timer_started_at = NULL
                    WHERE id = ?
                ''', (elapsed_seconds, now_iso, session['id']))
                
                return dict(session)
        
        return None
    
    def get_session_stats(self) -> Dict:
        """Get overall session statistics"""
        with self._db.get_cursor() as cursor:
            cursor.execute('''
                SELECT 
                    COUNT(*) as session_count,
                    SUM(total_time_seconds) as total_time,
                    SUM(CASE WHEN classification = 'productive' THEN total_time_seconds ELSE 0 END) as productive_time,
                    SUM(CASE WHEN classification = 'non_productive' THEN total_time_seconds ELSE 0 END) as non_productive_time
                FROM active_sessions
            ''')
            row = cursor.fetchone()
            return {
                'session_count': row['session_count'] or 0,
                'total_time_seconds': row['total_time'] or 0,
                'productive_time_seconds': row['productive_time'] or 0,
                'non_productive_time_seconds': row['non_productive_time'] or 0,
            }
    
    def prepare_for_batch_upload(self) -> int:
        """
        Prepare accumulated sessions for batch upload.
        Creates activity records from sessions that have accumulated time.
        
        Returns:
            Number of records prepared
        """
        # This will be called by the batch uploader
        # Implementation depends on integration with desktop_app.py
        pass
    
    def reset_sessions(self):
        """Reset all sessions (after successful batch upload)"""
        with self._db.get_cursor() as cursor:
            cursor.execute('UPDATE active_sessions SET total_time_seconds = 0, synced = 1')
```

#### File: `python-desktop-app/local_storage/batch_uploader.py`

```python
"""Batch Uploader for Hybrid OCR data"""

import json
import time
import threading
from datetime import datetime, timezone
from typing import Optional, List, Dict, Callable
from uuid import uuid4

from .sqlite_manager import SQLiteManager


class BatchUploader:
    """
    Handles batch upload of activity records to Supabase.
    Uploads text-only data (no images) for AI analysis.
    """
    
    def __init__(
        self,
        db_manager: Optional[SQLiteManager] = None,
        upload_callback: Optional[Callable] = None,
        batch_interval_seconds: int = 300,  # 5 minutes
        batch_size: int = 50
    ):
        self._db = db_manager or SQLiteManager.get_instance()
        self._upload_callback = upload_callback
        self._batch_interval = batch_interval_seconds
        self._batch_size = batch_size
        
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_upload_time = 0
    
    def set_upload_callback(self, callback: Callable):
        """Set the callback for uploading to Supabase"""
        self._upload_callback = callback
    
    def start(self):
        """Start background batch upload thread"""
        if self._running:
            return
        
        self._running = True
        self._thread = threading.Thread(target=self._upload_loop, daemon=True)
        self._thread.start()
        print(f"[BatchUploader] Started (interval: {self._batch_interval}s)")
    
    def stop(self):
        """Stop batch upload thread"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        print("[BatchUploader] Stopped")
    
    def _upload_loop(self):
        """Background loop for batch uploads"""
        while self._running:
            try:
                # Check if it's time to upload
                now = time.time()
                if now - self._last_upload_time >= self._batch_interval:
                    self.upload_pending_batch()
                    self._last_upload_time = now
                
                # Sleep for a bit
                time.sleep(10)
                
            except Exception as e:
                print(f"[BatchUploader] Error in upload loop: {e}")
                time.sleep(60)  # Wait longer on error
    
    def upload_pending_batch(self) -> Dict:
        """
        Upload pending records to Supabase.
        
        Returns:
            Dict with upload statistics
        """
        if not self._upload_callback:
            print("[BatchUploader] No upload callback set")
            return {'uploaded': 0, 'failed': 0, 'error': 'No callback'}
        
        # Get pending records
        pending = self._db.get_pending_records(self._batch_size)
        if not pending:
            return {'uploaded': 0, 'failed': 0, 'message': 'No pending records'}
        
        batch_id = str(uuid4())
        uploaded = 0
        failed = 0
        
        print(f"[BatchUploader] Uploading {len(pending)} records (batch: {batch_id[:8]})")
        
        # Prepare records for upload
        records_to_upload = []
        for record in pending:
            try:
                upload_record = {
                    'user_id': record['user_id'],
                    'organization_id': record['organization_id'],
                    'window_title': record['window_title'],
                    'application_name': record['application_name'],
                    'extracted_text': record['ocr_text'],
                    'ocr_method': record['ocr_method'],
                    'ocr_confidence': record['ocr_confidence'],
                    'local_classification': record['classification'],
                    'start_time': record['start_time'],
                    'end_time': record['end_time'],
                    'duration_seconds': record['duration_seconds'],
                    'work_date': record['work_date'],
                    'user_timezone': record['user_timezone'],
                    'user_assigned_issues': json.loads(record['user_assigned_issues']) if record['user_assigned_issues'] else [],
                    'status': 'pending',  # For AI analysis
                    'batch_id': batch_id,
                    'source': 'hybrid_ocr_linux',
                    'metadata': json.loads(record['metadata']) if record['metadata'] else {},
                }
                records_to_upload.append((record['id'], upload_record))
            except Exception as e:
                print(f"[BatchUploader] Error preparing record {record['id']}: {e}")
                self._db.mark_record_failed(record['id'], str(e))
                failed += 1
        
        # Upload via callback
        if records_to_upload:
            try:
                # Callback should handle Supabase insert
                success_ids = self._upload_callback(
                    [r for _, r in records_to_upload],
                    batch_id
                )
                
                if success_ids:
                    uploaded = len(success_ids)
                    local_ids = [r[0] for r in records_to_upload if r[1] in success_ids or uploaded == len(records_to_upload)]
                    self._db.mark_records_synced(local_ids, batch_id)
                    print(f"[BatchUploader] Uploaded {uploaded} records")
                
            except Exception as e:
                print(f"[BatchUploader] Upload failed: {e}")
                failed += len(records_to_upload)
        
        return {
            'uploaded': uploaded,
            'failed': failed,
            'batch_id': batch_id,
            'pending_remaining': self._db.get_pending_count()
        }
    
    def force_upload(self) -> Dict:
        """Force immediate upload of pending records"""
        return self.upload_pending_batch()
    
    def get_status(self) -> Dict:
        """Get uploader status"""
        return {
            'running': self._running,
            'pending_count': self._db.get_pending_count(),
            'last_upload': datetime.fromtimestamp(self._last_upload_time).isoformat() if self._last_upload_time else None,
            'batch_interval': self._batch_interval,
            'batch_size': self._batch_size,
        }
```

---

## 6. Phase 3: Desktop App Integration

### 6.1 Modify `desktop_app.py`

Add these changes to integrate OCR into the main desktop app:

#### 6.1.1 Add Imports

```python
# Add after existing imports in desktop_app.py

# OCR Module (Hybrid OCR approach)
OCR_AVAILABLE = False
try:
    from ocr import OCRFacade, extract_text_from_image, OCRConfig
    from local_storage import SQLiteManager, ActiveSessionTracker, BatchUploader
    OCR_AVAILABLE = True
    print("[OK] Hybrid OCR module loaded")
except ImportError as e:
    print(f"[WARN] Hybrid OCR not available: {e}")
    print("[INFO] Screenshots will be uploaded without local OCR")
```

#### 6.1.2 Add OCR to TimeTracker Class

```python
class TimeTracker:
    def __init__(self, ...):
        # ... existing init code ...
        
        # Initialize Hybrid OCR components
        self.ocr_enabled = OCR_AVAILABLE and self._should_use_hybrid_ocr()
        self.ocr_facade = None
        self.session_tracker = None
        self.batch_uploader = None
        
        if self.ocr_enabled:
            self._init_hybrid_ocr()
    
    def _should_use_hybrid_ocr(self) -> bool:
        """Check if Hybrid OCR should be used based on settings"""
        # Can be controlled via environment variable or settings
        return os.getenv('USE_HYBRID_OCR', 'true').lower() == 'true'
    
    def _init_hybrid_ocr(self):
        """Initialize Hybrid OCR components"""
        try:
            self.ocr_facade = OCRFacade.get_instance()
            self.session_tracker = ActiveSessionTracker()
            self.batch_uploader = BatchUploader(
                upload_callback=self._upload_activity_batch,
                batch_interval_seconds=300  # 5 minutes
            )
            self.batch_uploader.start()
            print("[OK] Hybrid OCR initialized")
        except Exception as e:
            print(f"[ERROR] Failed to initialize Hybrid OCR: {e}")
            self.ocr_enabled = False
```

#### 6.1.3 Modify Screenshot Processing

```python
def process_screenshot_with_ocr(self, screenshot, window_info):
    """Process screenshot using Hybrid OCR approach"""
    if not self.ocr_enabled:
        # Fall back to original upload method
        return self.upload_screenshot(screenshot, window_info)
    
    try:
        # Step 1: Extract text via OCR
        ocr_result = self.ocr_facade.extract_text(
            image=screenshot,
            window_title=window_info.get('title', ''),
            app_name=window_info.get('app', '')
        )
        
        print(f"[OCR] Extracted {ocr_result.line_count} lines via {ocr_result.method}")
        
        # Step 2: Local classification
        classification = self._classify_activity(
            window_info=window_info,
            ocr_text=ocr_result.text
        )
        
        # Step 3: Track session
        self.session_tracker.on_window_switch(
            window_title=window_info.get('title', ''),
            app_name=window_info.get('app', ''),
            classification=classification,
            ocr_result=ocr_result.to_dict()
        )
        
        # Step 4: Store activity record locally
        timestamp = datetime.now(timezone.utc)
        activity_record = {
            'user_id': self.current_user_id,
            'organization_id': self.organization_id,
            'window_title': window_info.get('title', ''),
            'application_name': window_info.get('app', ''),
            'ocr_text': ocr_result.text,
            'ocr_method': ocr_result.method,
            'ocr_confidence': ocr_result.confidence,
            'classification': classification,
            'start_time': self.last_screenshot_end_time.isoformat() if self.last_screenshot_end_time else timestamp.isoformat(),
            'end_time': timestamp.isoformat(),
            'duration_seconds': int((timestamp - (self.last_screenshot_end_time or timestamp)).total_seconds()),
            'work_date': datetime.now().date().isoformat(),
            'user_timezone': get_local_timezone_name(),
            'user_assigned_issues': json.dumps(self.user_issues or []),
            'metadata': json.dumps({
                'work_type': classification,
                'tracking_mode': self.tracking_settings.get('tracking_mode', 'interval'),
                'ocr_processing_time_ms': ocr_result.processing_time_ms,
            })
        }
        
        # Save to local SQLite
        db = SQLiteManager.get_instance()
        record_id = db.insert_activity_record(activity_record)
        
        # Update tracking state
        self.last_screenshot_end_time = timestamp
        
        print(f"[OCR] Activity saved locally (ID: {record_id})")
        return record_id
        
    except Exception as e:
        print(f"[ERROR] Hybrid OCR processing failed: {e}")
        traceback.print_exc()
        # Fall back to original method
        return self.upload_screenshot(screenshot, window_info)
    
def _classify_activity(self, window_info: Dict, ocr_text: str) -> str:
    """Classify activity as productive/non_productive/private/unknown"""
    app_name = window_info.get('app', '').lower()
    title = window_info.get('title', '').lower()
    
    # Productive apps
    productive_apps = {
        'code', 'vscode', 'cursor', 'sublime', 'vim', 'nvim', 'emacs',  # Editors
        'jira', 'confluence', 'bitbucket', 'github', 'gitlab',           # Dev tools
        'slack', 'teams', 'zoom', 'meet',                                # Communication
        'terminal', 'konsole', 'gnome-terminal', 'alacritty',            # Terminals
        'firefox', 'chrome', 'chromium',                                  # Browsers (check context)
    }
    
    # Non-productive apps
    non_productive_apps = {
        'steam', 'discord', 'spotify', 'vlc', 'netflix',
        'games', 'reddit', 'twitter', 'facebook', 'instagram',
    }
    
    # Private/sensitive contexts
    private_keywords = {
        'bank', 'paypal', 'password', 'keepass', '1password',
        'lastpass', 'bitwarden', 'medical', 'health',
    }
    
    # Check for productive apps
    for app in productive_apps:
        if app in app_name:
            # For browsers, check if browsing work-related sites
            if app in ('firefox', 'chrome', 'chromium'):
                if any(work in title for work in ['jira', 'confluence', 'github', 'gitlab', 'stackoverflow']):
                    return 'productive'
                if any(play in title for play in ['youtube', 'netflix', 'reddit', 'twitter']):
                    return 'non_productive'
            return 'productive'
    
    # Check for non-productive apps
    for app in non_productive_apps:
        if app in app_name or app in title:
            return 'non_productive'
    
    # Check for private contexts
    for keyword in private_keywords:
        if keyword in app_name or keyword in title:
            return 'private'
    
    # Check OCR text for Jira issue patterns
    if ocr_text:
        import re
        jira_pattern = r'\b[A-Z]{2,10}-\d+\b'
        if re.search(jira_pattern, ocr_text):
            return 'productive'
    
    return 'unknown'

def _upload_activity_batch(self, records: List[Dict], batch_id: str) -> List[Dict]:
    """Upload batch of activity records to Supabase"""
    if not self.supabase_service:
        print("[ERROR] Supabase service not available")
        return []
    
    try:
        # Insert into activity_records table (or screenshots table with OCR data)
        result = self.supabase_service.table('activity_records').insert(records).execute()
        
        if result.data:
            print(f"[OK] Uploaded {len(result.data)} activity records")
            return result.data
        return []
        
    except Exception as e:
        print(f"[ERROR] Batch upload failed: {e}")
        return []
```

#### 6.1.4 Modify Tracking Loop

```python
def tracking_loop(self):
    """Main tracking loop - modified for Hybrid OCR"""
    while self.is_tracking:
        try:
            # ... existing idle detection code ...
            
            # Capture and process screenshot
            screenshot = self.capture_screenshot()
            if screenshot:
                window_info = self.get_active_window()
                
                # Use Hybrid OCR if enabled, otherwise fall back to upload
                if self.ocr_enabled:
                    self.process_screenshot_with_ocr(screenshot, window_info)
                else:
                    self.upload_screenshot(screenshot, window_info)
            
            # ... rest of tracking loop ...
            
        except Exception as e:
            print(f"[ERROR] Tracking loop error: {e}")
```

---

## 7. Phase 4: Batch Upload Service

### 7.1 Activity Record Format

The batch uploader sends records in this format to Supabase:

```json
{
  "user_id": "uuid",
  "organization_id": "uuid",
  "window_title": "Visual Studio Code - project.py",
  "application_name": "code",
  "extracted_text": "def process_data():\n    ...",
  "ocr_method": "paddle",
  "ocr_confidence": 0.95,
  "local_classification": "productive",
  "start_time": "2026-03-12T10:00:00Z",
  "end_time": "2026-03-12T10:05:00Z",
  "duration_seconds": 300,
  "work_date": "2026-03-12",
  "user_timezone": "Asia/Kolkata",
  "user_assigned_issues": [
    {"key": "SCRUM-123", "summary": "Implement feature X"}
  ],
  "status": "pending",
  "batch_id": "batch-uuid",
  "source": "hybrid_ocr_linux",
  "metadata": {
    "work_type": "productive",
    "tracking_mode": "interval",
    "ocr_processing_time_ms": 450
  }
}
```

### 7.2 Upload Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         BATCH UPLOAD FLOW                                  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Every 5 minutes (configurable):                                           │
│                                                                            │
│  1. BatchUploader.upload_pending_batch()                                   │
│     │                                                                      │
│     ▼                                                                      │
│  2. SQLiteManager.get_pending_records(limit=50)                            │
│     │                                                                      │
│     ▼                                                                      │
│  3. Prepare records for upload (JSON serialization)                        │
│     │                                                                      │
│     ▼                                                                      │
│  4. supabase.table('activity_records').insert(records)                     │
│     │                                                                      │
│     ├─────────────────────┐                                                │
│     ▼                     ▼                                                │
│  SUCCESS              FAILURE                                              │
│     │                     │                                                │
│     ▼                     ▼                                                │
│  Mark synced          Mark failed + retry later                            │
│  in SQLite            in SQLite                                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Phase 5: AI Server Modifications

### 8.1 Overview

The AI Server needs to be modified to handle text-based activity records instead of downloading and analyzing screenshots.

### 8.2 New Endpoint for Text Analysis

#### File: `ai-server/src/controllers/text-analysis-controller.js`

```javascript
/**
 * Text Analysis Controller
 * Handles analysis of OCR-extracted text from Hybrid OCR approach
 */

const textAnalyzer = require('../services/ai/text-analyzer');
const supabaseService = require('../services/supabase-service');
const logger = require('../utils/logger');

/**
 * Analyze activity record with extracted text
 */
exports.analyzeTextActivity = async (req, res) => {
  try {
    const { 
      recordId, 
      extractedText, 
      windowTitle, 
      applicationName,
      userAssignedIssues,
      organizationId,
      userId
    } = req.body;

    if (!recordId || !extractedText) {
      return res.status(400).json({ 
        error: 'Missing required fields: recordId, extractedText' 
      });
    }

    logger.info('Text analysis requested', { recordId, textLength: extractedText.length });

    // Analyze using text LLM
    const analysis = await textAnalyzer.analyzeText({
      text: extractedText,
      windowTitle,
      applicationName,
      userAssignedIssues: userAssignedIssues || [],
      userId,
      organizationId
    });

    // Update record in database
    await supabaseService.updateActivityRecord(recordId, {
      status: 'analyzed',
      task_key: analysis.taskKey,
      project_key: analysis.projectKey,
      work_type: analysis.workType,
      confidence_score: analysis.confidenceScore,
      ai_reasoning: analysis.reasoning,
      analyzed_at: new Date().toISOString()
    });

    logger.info('Text analysis completed', {
      recordId,
      taskKey: analysis.taskKey,
      confidence: analysis.confidenceScore
    });

    return res.json({
      success: true,
      recordId,
      analysis
    });

  } catch (error) {
    logger.error('Text analysis failed', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Batch analyze multiple text records
 */
exports.batchAnalyzeText = async (req, res) => {
  try {
    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Missing records array' });
    }

    logger.info(`Batch text analysis: ${records.length} records`);

    const results = [];
    for (const record of records) {
      try {
        const analysis = await textAnalyzer.analyzeText({
          text: record.extractedText,
          windowTitle: record.windowTitle,
          applicationName: record.applicationName,
          userAssignedIssues: record.userAssignedIssues || [],
          userId: record.userId,
          organizationId: record.organizationId
        });

        results.push({
          recordId: record.id,
          success: true,
          analysis
        });
      } catch (err) {
        results.push({
          recordId: record.id,
          success: false,
          error: err.message
        });
      }
    }

    return res.json({
      success: true,
      processed: results.length,
      results
    });

  } catch (error) {
    logger.error('Batch text analysis failed', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
};
```

### 8.3 Text Analyzer Service

#### File: `ai-server/src/services/ai/text-analyzer.js`

```javascript
/**
 * Text Analyzer Service
 * Analyzes OCR-extracted text using LLM (not Vision API)
 */

const { callLiteLLM, callFireworks } = require('./ai-client');
const { getTextAnalysisPrompt } = require('./prompts');
const logger = require('../../utils/logger');

/**
 * Analyze extracted text to identify Jira issue and work type
 * @param {Object} params Analysis parameters
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeText({
  text,
  windowTitle,
  applicationName,
  userAssignedIssues = [],
  userId,
  organizationId
}) {
  // Build context for analysis
  const context = {
    windowTitle,
    applicationName,
    extractedText: text.substring(0, 4000), // Limit text length
    assignedIssues: userAssignedIssues.map(i => ({
      key: i.key,
      summary: i.summary
    }))
  };

  // Generate prompt for text analysis
  const prompt = getTextAnalysisPrompt(context);

  let response;
  let provider = 'litellm';

  try {
    // Try LiteLLM first (faster, cheaper for text-only)
    response = await callLiteLLM({
      messages: [
        {
          role: 'system',
          content: 'You analyze work activity from screen text and window metadata to identify Jira issues being worked on.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: process.env.LITELLM_TEXT_MODEL || 'gemini/gemini-2.0-flash',
      maxTokens: 500
    });
  } catch (litellmError) {
    logger.warn('LiteLLM text analysis failed, trying Fireworks', { error: litellmError.message });
    provider = 'fireworks';

    // Fallback to Fireworks
    response = await callFireworks({
      messages: [
        {
          role: 'system',
          content: 'You analyze work activity from screen text and window metadata to identify Jira issues being worked on.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: process.env.FIREWORKS_TEXT_MODEL || 'accounts/fireworks/models/llama-v3p1-8b-instruct'
    });
  }

  // Parse response
  const analysis = parseAnalysisResponse(response);

  return {
    taskKey: analysis.taskKey,
    projectKey: analysis.projectKey || (analysis.taskKey ? analysis.taskKey.split('-')[0] : null),
    workType: analysis.workType || 'office',
    confidenceScore: analysis.confidence || 0.5,
    reasoning: analysis.reasoning || '',
    aiProvider: provider,
    aiModel: response.model || 'unknown'
  };
}

/**
 * Parse AI response to extract analysis
 */
function parseAnalysisResponse(response) {
  try {
    const content = response.choices?.[0]?.message?.content || '';
    
    // Try to parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Fallback: extract key fields from text
    const taskKeyMatch = content.match(/task[_\s]*key[:\s]*["']?([A-Z]+-\d+)["']?/i);
    const workTypeMatch = content.match(/work[_\s]*type[:\s]*["']?(\w+)["']?/i);
    const confidenceMatch = content.match(/confidence[:\s]*["']?([\d.]+)["']?/i);

    return {
      taskKey: taskKeyMatch ? taskKeyMatch[1] : null,
      workType: workTypeMatch ? workTypeMatch[1] : 'office',
      confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
      reasoning: content.substring(0, 500)
    };
  } catch (err) {
    logger.warn('Failed to parse analysis response', { error: err.message });
    return {
      taskKey: null,
      workType: 'office',
      confidence: 0.3
    };
  }
}

module.exports = { analyzeText };
```

### 8.4 Update Polling Service

Modify `polling-service.js` to handle both screenshot and text-based records:

```javascript
// Add to polling-service.js

/**
 * Process pending activity records (Hybrid OCR)
 */
async processPendingActivityRecords() {
  try {
    // Fetch pending activity records
    const pendingRecords = await supabaseService.getPendingActivityRecords(this.batchSize);

    if (pendingRecords.length === 0) {
      logger.debug('No pending activity records');
      return;
    }

    logger.info(`Processing ${pendingRecords.length} activity record(s) (Hybrid OCR)`);

    for (const record of pendingRecords) {
      try {
        // Mark as processing
        await supabaseService.updateActivityRecordStatus(record.id, 'processing');

        // Analyze text
        const textAnalyzer = require('./ai/text-analyzer');
        const analysis = await textAnalyzer.analyzeText({
          text: record.extracted_text,
          windowTitle: record.window_title,
          applicationName: record.application_name,
          userAssignedIssues: record.user_assigned_issues || [],
          userId: record.user_id,
          organizationId: record.organization_id
        });

        // Update record
        await supabaseService.updateActivityRecord(record.id, {
          status: 'analyzed',
          task_key: analysis.taskKey,
          project_key: analysis.projectKey,
          work_type: analysis.workType,
          confidence_score: analysis.confidenceScore,
          ai_reasoning: analysis.reasoning,
          analyzed_at: new Date().toISOString()
        });

        logger.info('Activity record analyzed', {
          id: record.id,
          taskKey: analysis.taskKey
        });

      } catch (err) {
        logger.error('Failed to process activity record', {
          id: record.id,
          error: err.message
        });
        await supabaseService.updateActivityRecordStatus(record.id, 'failed', err.message);
      }
    }

  } catch (err) {
    logger.error('Error processing activity records', { error: err.message });
  }
}
```

---

## 9. Phase 6: Database Schema Updates

### 9.1 New Table: `activity_records`

```sql
-- Migration: Add activity_records table for Hybrid OCR
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.activity_records (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    organization_id UUID REFERENCES public.organizations(id),
    
    -- Window/App metadata
    window_title TEXT,
    application_name TEXT,
    
    -- OCR data (locally extracted)
    extracted_text TEXT,
    ocr_method TEXT,                    -- 'paddle', 'tesseract', 'metadata'
    ocr_confidence NUMERIC(4,3),        -- 0.000 to 1.000
    local_classification TEXT,          -- 'productive', 'non_productive', 'private', 'unknown'
    
    -- Time tracking
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    work_date DATE NOT NULL,
    user_timezone TEXT,
    
    -- AI analysis results
    task_key TEXT,                      -- Matched Jira issue (e.g., 'SCRUM-123')
    project_key TEXT,                   -- Project (e.g., 'SCRUM')
    work_type TEXT DEFAULT 'office',    -- 'office', 'meeting', 'break', etc.
    confidence_score NUMERIC(4,3),      -- AI confidence
    ai_reasoning TEXT,                  -- AI explanation
    
    -- Context
    user_assigned_issues JSONB DEFAULT '[]',
    
    -- Processing status
    status TEXT DEFAULT 'pending',      -- 'pending', 'processing', 'analyzed', 'failed'
    batch_id TEXT,                      -- Upload batch identifier
    source TEXT DEFAULT 'hybrid_ocr',   -- 'hybrid_ocr', 'hybrid_ocr_linux', 'screenshot'
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    analyzed_at TIMESTAMP WITH TIME ZONE,
    
    -- Worklog tracking
    worklog_created BOOLEAN DEFAULT FALSE,
    worklog_id TEXT,
    worklog_created_at TIMESTAMP WITH TIME ZONE
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_activity_records_user_work_date 
    ON activity_records(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_activity_records_status 
    ON activity_records(status);
CREATE INDEX IF NOT EXISTS idx_activity_records_task_key 
    ON activity_records(task_key);
CREATE INDEX IF NOT EXISTS idx_activity_records_batch_id 
    ON activity_records(batch_id);
CREATE INDEX IF NOT EXISTS idx_activity_records_organization 
    ON activity_records(organization_id);

-- Row Level Security
ALTER TABLE activity_records ENABLE ROW LEVEL SECURITY;

-- Users can read their own records
CREATE POLICY "Users can view own activity records"
    ON activity_records FOR SELECT
    USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY "Service role full access to activity_records"
    ON activity_records FOR ALL
    USING (auth.role() = 'service_role');

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON activity_records TO authenticated;
GRANT ALL ON activity_records TO service_role;

COMMENT ON TABLE activity_records IS 'Activity records from Hybrid OCR approach - text-only, no screenshots';
```

### 9.2 Update Views

```sql
-- Update activity_sessions view to include activity_records
CREATE OR REPLACE VIEW public.activity_sessions AS
SELECT 
    id,
    user_id,
    organization_id,
    start_time,
    end_time,
    duration_seconds,
    task_key,
    project_key,
    work_type,
    confidence_score,
    window_title,
    application_name,
    'activity_record' as source_type,
    created_at
FROM activity_records
WHERE status = 'analyzed'

UNION ALL

SELECT 
    s.id,
    s.user_id,
    s.organization_id,
    s.start_time,
    s.end_time,
    s.duration_seconds,
    ar.active_task_key as task_key,
    ar.active_project_key as project_key,
    COALESCE(s.metadata->>'work_type', 'office') as work_type,
    ar.confidence_score,
    s.window_title,
    s.application_name,
    'screenshot' as source_type,
    s.created_at
FROM screenshots s
LEFT JOIN analysis_results ar ON ar.screenshot_id = s.id
WHERE s.status = 'analyzed';
```

---

## 10. Testing Strategy

### 10.1 Unit Tests

#### OCR Module Tests

```python
# tests/test_ocr_module.py

import pytest
from PIL import Image
import numpy as np

from ocr import OCRFacade, extract_text_from_image
from ocr.engines.paddle_engine import PaddleOCREngine
from ocr.engines.tesseract_engine import TesseractOCREngine
from ocr.privacy_filter import PrivacyFilter


class TestOCREngines:
    @pytest.fixture
    def sample_image(self):
        """Create a simple test image with text"""
        img = Image.new('RGB', (800, 600), color='white')
        # In real tests, add text to the image
        return img
    
    def test_paddle_initialization(self):
        engine = PaddleOCREngine.get_instance()
        # May not be available on all systems
        assert engine is not None
    
    def test_tesseract_initialization(self):
        engine = TesseractOCREngine()
        # Tesseract should be available on Linux
        assert engine.is_available or engine._init_error is not None
    
    def test_facade_fallback(self, sample_image):
        facade = OCRFacade.get_instance()
        result = facade.extract_text(sample_image, 'Test Window', 'test_app')
        
        # Should return some result (even if metadata fallback)
        assert result is not None
        assert result.method in ('paddle', 'tesseract', 'metadata')


class TestPrivacyFilter:
    @pytest.fixture
    def filter(self):
        return PrivacyFilter(enabled=True)
    
    def test_credit_card_redaction(self, filter):
        text = "Card: 4111 1111 1111 1111"
        filtered, redactions = filter.filter_text(text)
        assert '[CARD_REDACTED]' in filtered
        assert 'CARD_REDACTED' in redactions
    
    def test_email_redaction(self, filter):
        text = "Contact: user@example.com"
        filtered, redactions = filter.filter_text(text)
        assert '[EMAIL_REDACTED]' in filtered
    
    def test_sensitive_context(self, filter):
        assert filter.is_sensitive_context('Chase Bank - Login', 'firefox')
        assert not filter.is_sensitive_context('GitHub - Project', 'firefox')
```

### 10.2 Integration Tests

```python
# tests/test_integration.py

import pytest
import json
from datetime import datetime, timezone

from local_storage import SQLiteManager, ActiveSessionTracker, BatchUploader


class TestLocalStorage:
    @pytest.fixture
    def db(self, tmp_path):
        db_path = tmp_path / 'test.db'
        return SQLiteManager(str(db_path))
    
    def test_insert_activity_record(self, db):
        record = {
            'user_id': 'test-user',
            'window_title': 'Test Window',
            'application_name': 'test_app',
            'ocr_text': 'Sample text',
            'ocr_method': 'paddle',
            'ocr_confidence': 0.95,
            'classification': 'productive',
            'start_time': datetime.now(timezone.utc).isoformat(),
            'end_time': datetime.now(timezone.utc).isoformat(),
            'duration_seconds': 300,
            'work_date': datetime.now().date().isoformat(),
        }
        
        record_id = db.insert_activity_record(record)
        assert record_id > 0
        
        pending = db.get_pending_records(10)
        assert len(pending) == 1
        assert pending[0]['window_title'] == 'Test Window'
    
    def test_mark_synced(self, db):
        # Insert test record
        record_id = db.insert_activity_record({...})
        
        # Mark as synced
        db.mark_records_synced([record_id], 'batch-123')
        
        # Should no longer be pending
        pending = db.get_pending_records(10)
        assert len(pending) == 0


class TestSessionTracker:
    @pytest.fixture
    def tracker(self, tmp_path):
        db = SQLiteManager(str(tmp_path / 'test.db'))
        return ActiveSessionTracker(db)
    
    def test_window_switch(self, tracker):
        # Switch to first window
        result = tracker.on_window_switch(
            'Window 1',
            'app1',
            'productive',
            {'text': 'Test', 'confidence': 0.9, 'method': 'paddle'}
        )
        assert result is None  # First switch, no previous
        
        # Switch to second window
        result = tracker.on_window_switch(
            'Window 2',
            'app2',
            'unknown'
        )
        # Should return previous session data
        assert result is not None
```

### 10.3 Manual Testing Checklist

- [ ] **OCR Accuracy**
  - [ ] Test with VS Code screenshots
  - [ ] Test with browser (Jira, Confluence)
  - [ ] Test with terminal applications
  - [ ] Test with dark mode applications

- [ ] **Privacy Filter**
  - [ ] Verify credit card numbers are redacted
  - [ ] Verify emails are redacted
  - [ ] Verify banking sites trigger sensitive context

- [ ] **Local Storage**
  - [ ] Records persist across app restart
  - [ ] Batch upload works after network reconnection
  - [ ] Old synced records are cleaned up

- [ ] **Classification**
  - [ ] VS Code classified as productive
  - [ ] YouTube classified as non-productive
  - [ ] Banking sites classified as private

- [ ] **End-to-End**
  - [ ] Activity records appear in Supabase
  - [ ] AI analysis assigns correct Jira issues
  - [ ] Worklogs created in Jira

---

## 11. Migration & Rollback Plan

### 11.1 Migration Steps

1. **Database Migration**
   ```bash
   # Run migration to create activity_records table
   supabase db push
   ```

2. **Deploy AI Server Updates**
   ```bash
   cd ai-server
   docker build -t ai-server:hybrid-ocr .
   docker push ai-server:hybrid-ocr
   # Update deployment
   ```

3. **Deploy Desktop App**
   ```bash
   cd python-desktop-app
   # Install OCR dependencies
   pip install paddlepaddle paddleocr pytesseract opencv-python-headless
   
   # For system-wide deployment, update install_linux.sh
   ```

4. **Gradual Rollout**
   - Start with 5% of users
   - Monitor error rates and API costs
   - Increase to 25%, 50%, 100%

### 11.2 Feature Flag

```python
# In desktop_app.py
def _should_use_hybrid_ocr(self) -> bool:
    """Check if Hybrid OCR should be used"""
    # Environment variable override
    env_setting = os.getenv('USE_HYBRID_OCR')
    if env_setting is not None:
        return env_setting.lower() == 'true'
    
    # Check feature flag from server
    try:
        response = self.supabase_service.rpc('get_feature_flag', {
            'flag_name': 'hybrid_ocr_linux',
            'user_id': self.current_user_id
        }).execute()
        return response.data.get('enabled', False)
    except:
        return False  # Default to screenshot approach
```

### 11.3 Rollback Plan

If issues arise:

1. **Immediate Rollback**
   ```bash
   # Set environment variable
   export USE_HYBRID_OCR=false
   # Or disable feature flag in database
   UPDATE feature_flags SET enabled = false WHERE name = 'hybrid_ocr_linux';
   ```

2. **Data Recovery**
   - Activity records remain in `activity_records` table
   - Can be converted to screenshots table format if needed

3. **Gradual Rollback**
   - Reduce percentage in feature flag
   - Monitor screenshot approach for stability

---

## Appendix: Code Templates

### A.1 Complete `__init__.py` for OCR Engines

```python
# python-desktop-app/ocr/engines/__init__.py
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
```

### A.2 Updated `requirements.txt`

```txt
# Core dependencies
pillow>=9.0.0
psutil>=5.9.0
requests>=2.28.0
flask>=2.0.0
flask-cors>=3.0.0
pystray>=0.19.0
supabase>=2.0.0
python-dotenv>=1.0.0
keyring>=23.0.0

# Linux-specific
dbus-python>=1.3.2; sys_platform == 'linux'
ewmh>=0.1.6; sys_platform == 'linux'
python-xlib>=0.33; sys_platform == 'linux'
PyGObject>=3.42.0; sys_platform == 'linux'

# OCR Dependencies (Hybrid OCR)
paddlepaddle==2.6.0
paddleocr==2.7.0.3
pytesseract==0.3.10
opencv-python-headless==4.9.0.80
numpy>=1.21.0,<2.0.0
```

### A.3 Updated `install_linux.sh`

```bash
#!/bin/bash
# Linux installation script with OCR dependencies

set -e

echo "=== JIRAForge Time Tracker - Linux Installation ==="

# Check for Python 3.11+
python_version=$(python3 --version 2>&1 | cut -d' ' -f2)
echo "Python version: $python_version"

# Install system dependencies
echo "Installing system dependencies..."
if command -v apt-get &> /dev/null; then
    # Ubuntu/Debian
    sudo apt-get update
    sudo apt-get install -y \
        python3-pip \
        python3-venv \
        python3-gi \
        gir1.2-gstreamer-1.0 \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-pipewire \
        libnotify-bin \
        tesseract-ocr \
        tesseract-ocr-eng \
        libtesseract-dev \
        libgl1-mesa-glx \
        libglib2.0-0
elif command -v dnf &> /dev/null; then
    # Fedora/RHEL
    sudo dnf install -y \
        python3-pip \
        python3-gobject \
        gstreamer1-plugins-base \
        gstreamer1-plugins-good \
        pipewire-gstreamer \
        libnotify \
        tesseract \
        tesseract-langpack-eng \
        mesa-libGL \
        glib2
fi

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Create application directories
echo "Creating application directories..."
mkdir -p ~/.local/share/timetracker
mkdir -p ~/.config/autostart

echo "=== Installation complete ==="
echo "Run with: source venv/bin/activate && python desktop_app.py"
```

---

## Summary

This implementation guide provides a complete roadmap for converting the Linux screenshot-based approach to the Hybrid OCR approach. The key benefits include:

1. **96-99% reduction in bandwidth** - Only text data uploaded
2. **85-96% reduction in AI costs** - Text LLM vs Vision API
3. **Improved privacy** - Screenshots never leave the device
4. **Better offline support** - Full local processing capability
5. **Faster processing** - Local OCR is faster than cloud Vision AI

The implementation is modular and includes fallback mechanisms, feature flags for gradual rollout, and a clear rollback plan.

**Estimated Implementation Timeline: 13-17 days**

---

*Document Version: 1.0*
*Last Updated: March 12, 2026*
