"""PaddleOCR Engine - Primary OCR for Linux Hybrid OCR Approach"""

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
    Primary engine for the Hybrid OCR approach.
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
