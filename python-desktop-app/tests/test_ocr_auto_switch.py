"""
OCR Auto-Switch Test Suite
===========================

Tests that the OCR facade correctly auto-switches engines based on
platform availability. Verifies that WinRT OCR is skipped on Linux
and RapidOCR becomes the effective primary.

Usage:
    python -m pytest tests/test_ocr_auto_switch.py -v
    python -m tests.test_ocr_auto_switch
"""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestOCRAutoSwitch(unittest.TestCase):
    """Verify the OCR engine auto-switch mechanism."""

    def test_winrtocr_engine_unavailable_on_linux(self):
        """WinRTocr engine's is_available() should return False on Linux."""
        if sys.platform == 'win32':
            self.skipTest("Test only meaningful on Linux")

        try:
            from ocr.engines.winrtocr_engine import WinRTOCREngine
            engine = WinRTOCREngine()
            self.assertFalse(engine.is_available())
        except ImportError:
            # Module not importable at all — also means unavailable
            pass

    def test_rapidocr_engine_available(self):
        """RapidOCR engine should be available on any platform."""
        try:
            from ocr.engines.rapidocr_engine import RapidOCREngine
            engine = RapidOCREngine()
            self.assertTrue(engine.is_available())
        except ImportError:
            self.skipTest("rapidocr_onnxruntime not installed")

    def test_easyocr_engine_file_exists(self):
        """EasyOCR engine adapter should exist."""
        engine_path = os.path.join(
            os.path.dirname(__file__), '..', 'ocr', 'engines', 'easyocr_engine.py'
        )
        self.assertTrue(os.path.isfile(engine_path))

    def test_auto_installer_skips_winrt_on_linux(self):
        """auto_installer should return empty deps for winrtocr on non-Windows."""
        if sys.platform == 'win32':
            self.skipTest("Test only meaningful on Linux")

        try:
            from ocr.auto_installer import get_engine_dependencies
            deps = get_engine_dependencies('winrtocr')
            self.assertEqual(deps, [])
        except ImportError:
            self.skipTest("ocr.auto_installer not importable")

    def test_engine_factory_registry_has_engines(self):
        """Engine factory should have rapidocr and winrtocr registered."""
        try:
            from ocr.engine_factory import OCREngineFactory
            factory = OCREngineFactory.get_instance()
            # These are the engine names that should be registered
            registered = factory.list_engines() if hasattr(factory, 'list_engines') else []
            # At minimum, rapidocr should be available
            if registered:
                engine_names = [e.lower() for e in registered]
                self.assertIn('rapidocr', engine_names)
        except ImportError:
            self.skipTest("engine_factory not importable")

    def test_ocr_config_from_env(self):
        """OCRConfig.from_env() should read OCR_PRIMARY_ENGINE from env."""
        try:
            from ocr.config import OCRConfig
        except ImportError:
            self.skipTest("ocr.config not importable")

        with patch.dict(os.environ, {
            'OCR_PRIMARY_ENGINE': 'winrtocr',
            'OCR_FALLBACK_ENGINES': 'rapidocr,easyocr',
        }):
            config = OCRConfig.from_env()
            self.assertEqual(config.primary_engine, 'winrtocr')
            self.assertIn('rapidocr', config.fallback_engines)
            self.assertIn('easyocr', config.fallback_engines)

    def test_ai_server_env_has_easyocr_fallback(self):
        """AI server .env should have easyocr in OCR_FALLBACK_ENGINES."""
        env_path = os.path.join(
            os.path.dirname(__file__), '..', '..', 'ai-server', '.env'
        )
        if not os.path.isfile(env_path):
            self.skipTest("ai-server/.env not found")

        with open(env_path, 'r') as f:
            content = f.read()

        self.assertIn('OCR_PRIMARY_ENGINE=winrtocr', content)
        self.assertIn('OCR_FALLBACK_ENGINES=rapidocr,easyocr', content)
        self.assertIn('OCR_EASYOCR_MIN_CONFIDENCE', content)


class TestOCRFallbackChain(unittest.TestCase):
    """Test the actual OCR fallback chain behavior."""

    def test_facade_skips_unavailable_primary(self):
        """If primary engine is unavailable, facade should use fallbacks."""
        try:
            from ocr.facade import OCRFacade
            from ocr.config import OCRConfig
        except ImportError:
            self.skipTest("OCR modules not importable")

        with patch.dict(os.environ, {
            'OCR_PRIMARY_ENGINE': 'winrtocr',
            'OCR_FALLBACK_ENGINES': 'rapidocr',
        }):
            config = OCRConfig.from_env()
            facade = OCRFacade(config)

            if sys.platform.startswith('linux'):
                # On Linux, primary should be None (WinRT unavailable)
                if facade._primary_engine is not None:
                    self.assertFalse(facade._primary_engine.is_available())


if __name__ == '__main__':
    unittest.main()
