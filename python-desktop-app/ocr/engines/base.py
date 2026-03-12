"""Base OCR Engine Interface"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, List
from PIL import Image


@dataclass
class OCRResult:
    """Standard OCR result structure"""
    text: str                            # Extracted text
    confidence: float                    # Overall confidence (0.0-1.0)
    method: str                          # Engine used (paddle/tesseract/metadata)
    line_count: int                      # Number of text lines
    word_count: int                      # Number of words
    processing_time_ms: float            # Processing time in milliseconds
    error_message: Optional[str] = None  # Error if extraction failed
    bounding_boxes: Optional[List] = None  # Optional text regions
    
    def to_dict(self) -> dict:
        """Convert to dictionary for storage/serialization"""
        return {
            'text': self.text,
            'confidence': self.confidence,
            'method': self.method,
            'line_count': self.line_count,
            'word_count': self.word_count,
            'processing_time_ms': self.processing_time_ms,
            'error_message': self.error_message
        }
    
    def is_valid(self, min_confidence: float = 0.5, min_length: int = 10) -> bool:
        """Check if result meets quality thresholds"""
        return (
            self.confidence >= min_confidence and 
            len(self.text) >= min_length and
            self.error_message is None
        )


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
