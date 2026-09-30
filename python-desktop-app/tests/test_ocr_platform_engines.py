"""
Tests for platform-aware OCR engine resolution.

Spec: linux-desktop-app/plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 4-6)
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ocr.config import OCRConfig, resolve_engines_for_platform


class TestResolveEnginesForPlatform(unittest.TestCase):

    def test_windows_unchanged(self):
        """AC 4"""
        self.assertEqual(
            resolve_engines_for_platform('rapidocr', ['winrtocr'], platform='win32'),
            ('rapidocr', ['winrtocr']),
        )
        self.assertEqual(
            resolve_engines_for_platform('winrtocr', [], platform='win32'),
            ('winrtocr', []),
        )

    def test_linux_drops_winrt_fallback(self):
        """AC 5"""
        self.assertEqual(
            resolve_engines_for_platform('rapidocr', ['winrtocr'], platform='linux'),
            ('rapidocr', []),
        )

    def test_linux_drops_winrt_alias(self):
        self.assertEqual(
            resolve_engines_for_platform('rapidocr', ['winrt', 'easyocr'], platform='linux'),
            ('rapidocr', ['easyocr']),
        )

    def test_linux_promotes_first_fallback(self):
        self.assertEqual(
            resolve_engines_for_platform('winrtocr', ['easyocr', 'rapidocr'], platform='linux'),
            ('easyocr', ['rapidocr']),
        )

    def test_linux_empty_gets_rapidocr(self):
        self.assertEqual(
            resolve_engines_for_platform('winrtocr', [], platform='linux'),
            ('rapidocr', []),
        )
        self.assertEqual(
            resolve_engines_for_platform('winrtocr', ['winrt'], platform='linux'),
            ('rapidocr', []),
        )

    def test_linux_no_duplicate_rapidocr(self):
        self.assertEqual(
            resolve_engines_for_platform('winrtocr', ['rapidocr'], platform='linux'),
            ('rapidocr', []),
        )

    def test_case_insensitive(self):
        self.assertEqual(
            resolve_engines_for_platform('RapidOCR', ['WinRTOCR'], platform='linux'),
            ('rapidocr', []),
        )


class TestConfigAppliesResolution(unittest.TestCase):
    """AC 6"""

    @patch('ocr.config.sys.platform', 'linux')
    def test_from_env_linux(self):
        env = {'OCR_PRIMARY_ENGINE': 'rapidocr', 'OCR_FALLBACK_ENGINES': 'winrtocr'}
        with patch.dict(os.environ, env):
            config = OCRConfig.from_env()
        self.assertEqual(config.primary_engine, 'rapidocr')
        self.assertEqual(config.fallback_engines, [])

    @patch('ocr.config.sys.platform', 'win32')
    def test_from_env_windows(self):
        env = {'OCR_PRIMARY_ENGINE': 'rapidocr', 'OCR_FALLBACK_ENGINES': 'winrtocr'}
        with patch.dict(os.environ, env):
            config = OCRConfig.from_env()
        self.assertEqual(config.primary_engine, 'rapidocr')
        self.assertEqual(config.fallback_engines, ['winrtocr'])

    @patch('ocr.config.sys.platform', 'linux')
    def test_from_dict_linux(self):
        config = OCRConfig.from_dict({'primary_engine': 'winrtocr', 'fallback_engines': []})
        self.assertEqual(config.primary_engine, 'rapidocr')
        self.assertEqual(config.fallback_engines, [])

    @patch('ocr.config.sys.platform', 'win32')
    def test_from_dict_windows(self):
        config = OCRConfig.from_dict({'primary_engine': 'rapidocr', 'fallback_engines': ['winrtocr']})
        self.assertEqual(config.fallback_engines, ['winrtocr'])


class TestRapidOCRTextBoxCap(unittest.TestCase):
    """Only the lines the facade keeps are sent to (slow) recognition."""

    class _FakeRapidOCR:
        def auto_text_det(self, img):
            return [f'box{i}' for i in range(100)], 0.1

    def test_detection_capped_in_reading_order(self):
        from ocr.engines.rapidocr_engine import RapidOCREngine
        ocr = self._FakeRapidOCR()
        RapidOCREngine(max_text_boxes=48)._cap_text_boxes(ocr)
        boxes, elapse = ocr.auto_text_det(None)
        self.assertEqual(boxes, [f'box{i}' for i in range(48)])
        self.assertEqual(elapse, 0.1)

    def test_zero_disables_cap(self):
        from ocr.engines.rapidocr_engine import RapidOCREngine
        ocr = self._FakeRapidOCR()
        RapidOCREngine(max_text_boxes=0)._cap_text_boxes(ocr)
        self.assertEqual(len(ocr.auto_text_det(None)[0]), 100)

    def test_no_detection_result_passes_through(self):
        from ocr.engines.rapidocr_engine import RapidOCREngine
        ocr = type('NoText', (), {'auto_text_det': lambda self, img: (None, 0.0)})()
        RapidOCREngine()._cap_text_boxes(ocr)
        self.assertEqual(ocr.auto_text_det(None), (None, 0.0))


if __name__ == '__main__':
    unittest.main()
