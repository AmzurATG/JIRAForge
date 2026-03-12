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
