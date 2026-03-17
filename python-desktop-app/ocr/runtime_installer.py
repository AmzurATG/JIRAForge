"""
OCR Runtime Installer (stub)

PaddleOCR and Tesseract model setup has been removed.
The app now uses RapidOCR and WinRTOCR which require no model downloads.

This module is kept for import compatibility only.
"""

import os
import logging
from typing import Callable, Dict, Any, Optional, List

logger = logging.getLogger(__name__)


def get_configured_engines() -> List[str]:
    """Read configured OCR engines from environment variables."""
    engines = []
    primary = os.environ.get('OCR_PRIMARY_ENGINE', 'rapidocr').split('#')[0].strip().lower()
    engines.append(primary)

    fallbacks = os.environ.get('OCR_FALLBACK_ENGINES', 'winrtocr').split('#')[0].strip()
    for engine in fallbacks.split(','):
        engine = engine.strip().lower()
        if engine and engine not in engines:
            engines.append(engine)

    return engines


def ensure_ocr_ready(
    callback: Optional[Callable[[str, int, int], None]] = None,
    download_if_missing: bool = True,
    install_tesseract: bool = False
) -> Dict[str, Any]:
    """
    Verify OCR engines are ready. No model downloads needed for rapidocr/winrtocr.
    """
    configured = get_configured_engines()

    if callback:
        callback(f"OCR engines configured: {', '.join(configured)}", 1, 1)

    return {
        'configured_engines': configured,
        'errors': [],
    }


def get_ocr_status_summary() -> str:
    """Get a human-readable summary of OCR engine status."""
    configured = get_configured_engines()
    return f"OCR engines configured: {', '.join(configured)}"
