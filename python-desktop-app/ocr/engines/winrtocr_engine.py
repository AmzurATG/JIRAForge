"""
WinRT OCR Engine — native Windows OCR via WinRT APIs.

Uses the Windows built-in OCR engine (winsdk) directly, bypassing the winrtocr
library's subprocess/multiprocessing wrapper which is incompatible with
PyInstaller-bundled executables.

Falls back to the winrtocr library if winsdk is not available.
"""

import logging
import sys
from typing import Dict, Any, Optional

import numpy as np
from PIL import Image

from ..base_engine import BaseOCREngine

logger = logging.getLogger(__name__)

# Flag: can we use the direct winsdk API?
_WINSDK_AVAILABLE = False
_WINRTOCR_LIB_AVAILABLE = False

try:
    import winsdk.windows.media.ocr as _ocr_api
    import winsdk.windows.graphics.imaging as _imaging_api
    import winsdk.windows.storage.streams as _streams_api
    import winsdk.windows.globalization as _glob_api
    _WINSDK_AVAILABLE = True
except ImportError:
    pass

try:
    import winrtocr as _winrtocr_lib
    _WINRTOCR_LIB_AVAILABLE = True
except ImportError:
    pass


def _is_frozen() -> bool:
    """Check if running inside a PyInstaller bundle."""
    return getattr(sys, 'frozen', False)


class WinRTOCREngine(BaseOCREngine):
    """
    Native WinRT OCR engine for Windows.

    In development (non-frozen): delegates to the winrtocr library.
    In EXE (frozen): calls winsdk WinRT OCR APIs directly, avoiding the
    subprocess mechanism that the winrtocr library uses internally.
    """

    def __init__(
        self,
        use_gpu: bool = False,
        language: str = 'en-US',
        min_confidence: float = 0.5,
        **kwargs,
    ):
        self.language = language
        self.min_confidence = min_confidence
        self._engine = None  # cached WinRT OcrEngine instance
        self._init_error: Optional[str] = None

    def get_name(self) -> str:
        return 'winrtocr'

    def is_available(self) -> bool:
        if _WINSDK_AVAILABLE:
            return True
        if _WINRTOCR_LIB_AVAILABLE:
            return True
        self._init_error = (
            "Neither winsdk nor winrtocr installed. "
            "Install with: pip install winrtocr"
        )
        return False

    # ------------------------------------------------------------------
    # Direct winsdk implementation (works inside PyInstaller EXE)
    # ------------------------------------------------------------------

    def _get_winrt_engine(self):
        """Lazily create and cache the WinRT OcrEngine."""
        if self._engine is not None:
            return self._engine

        try:
            # Use winsdk.windows.globalization.Language for language creation
            lang = _glob_api.Language(self.language)
            if _ocr_api.OcrEngine.is_language_supported(lang):
                self._engine = _ocr_api.OcrEngine.try_create_from_language(lang)
                logger.info(f"WinRT OcrEngine created for language: {self.language}")
            else:
                # Fall back to user profile languages
                self._engine = _ocr_api.OcrEngine.try_create_from_user_profile_languages()
                logger.info(
                    f"Language '{self.language}' not supported, using profile default."
                )
        except Exception as exc:
            logger.warning(f"WinRT OcrEngine creation failed: {exc}")
            self._engine = _ocr_api.OcrEngine.try_create_from_user_profile_languages()

        return self._engine

    def _recognize_direct(self, image: np.ndarray) -> Dict[str, Any]:
        """Run OCR via winsdk directly (no subprocess)."""
        import time

        engine = self._get_winrt_engine()
        if engine is None:
            return self._create_error_result(
                "WinRT OcrEngine could not be created — "
                "no OCR language packs installed on this system."
            )

        # Ensure RGBA uint8
        pil_img = Image.fromarray(image)
        rgba = np.array(pil_img.convert('RGBA'))

        # Write pixel data into a WinRT SoftwareBitmap
        data_writer = _streams_api.DataWriter()
        data_writer.write_bytes(bytearray(rgba.tobytes()))
        bitmap = _imaging_api.SoftwareBitmap(
            _imaging_api.BitmapPixelFormat.RGBA8,
            rgba.shape[1],
            rgba.shape[0],
        )
        bitmap.copy_from_buffer(data_writer.detach_buffer())
        del data_writer

        # Async recognition (poll until done)
        async_op = engine.recognize_async(bitmap)
        for _ in range(600):  # up to ~60 s
            if async_op.status.value:
                break
            time.sleep(0.1)

        result = async_op.get_results()

        texts = []
        confidences = []
        for line in result.lines:
            for word in line.words:
                texts.append(word.text)
                confidences.append(1.0)  # WinRT doesn't expose per-word conf

        try:
            result.close()
        except Exception:
            pass

        full_text = ' '.join(texts)
        avg_conf = sum(confidences) / len(confidences) if confidences else 0.0

        return self._create_success_result(text=full_text, confidence=avg_conf)

    # ------------------------------------------------------------------
    # Library-based fallback (dev mode only — uses subprocess)
    # ------------------------------------------------------------------

    def _recognize_via_library(self, image: np.ndarray) -> Dict[str, Any]:
        """Use the winrtocr library (spawns subprocess — dev mode only)."""
        import tempfile
        import os

        pil_img = Image.fromarray(image)
        fd, tmp_path = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        try:
            pil_img.save(tmp_path, format='PNG')
            w = _winrtocr_lib.WinRTocr(cpus=1, language=self.language)
            df = w.get_ocr_df([tmp_path])

            if df is None or (hasattr(df, 'empty') and df.empty):
                return self._create_success_result(text='', confidence=0.0)

            text_col = next(
                (c for c in ['text', 'Text', 'word'] if c in df.columns), None
            )
            if text_col is None:
                return self._create_success_result(
                    text=str(df), confidence=0.5
                )

            texts = df[text_col].dropna().astype(str).tolist()
            conf_col = next(
                (c for c in ['conf', 'confidence'] if c in df.columns), None
            )
            if conf_col:
                confs = df[conf_col].dropna().astype(float).tolist()
                avg_conf = sum(confs) / len(confs) if confs else 1.0
            else:
                avg_conf = 1.0

            return self._create_success_result(
                text=' '.join(texts), confidence=avg_conf
            )
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def extract_text(self, image: np.ndarray) -> Dict[str, Any]:
        if not self.is_available():
            return self._create_error_result('WinRT OCR not available')

        try:
            if _WINSDK_AVAILABLE:
                # Always prefer direct API — works in both dev and EXE
                return self._recognize_direct(image)
            elif _WINRTOCR_LIB_AVAILABLE and not _is_frozen():
                # Library fallback only in dev mode (subprocess won't work in EXE)
                return self._recognize_via_library(image)
            else:
                return self._create_error_result(
                    'winsdk not installed and winrtocr library cannot run in EXE mode'
                )
        except Exception as exc:
            logger.error(f"WinRT OCR failed: {exc}", exc_info=True)
            return self._create_error_result(str(exc))
