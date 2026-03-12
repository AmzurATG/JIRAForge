"""Tesseract OCR Engine - Fallback for Linux Hybrid OCR Approach"""

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
