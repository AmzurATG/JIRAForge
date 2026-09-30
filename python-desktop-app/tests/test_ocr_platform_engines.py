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


if __name__ == '__main__':
    unittest.main()
