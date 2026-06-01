#!/usr/bin/env python3
"""
Test OCR Platform Filtering

This script tests that the OCR configuration correctly filters out
incompatible engines based on the platform.

Run this script on both Windows and Linux to verify the filtering works.
"""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_platform_detection():
    """Test platform detection functions"""
    from ocr.config import get_platform_compatible_engines, filter_engines_by_platform
    
    print("=" * 70)
    print("PLATFORM DETECTION TEST")
    print("=" * 70)
    print(f"Current platform: {sys.platform}")
    print(f"Compatible engines: {get_platform_compatible_engines()}")
    print()
    
    # Test filtering
    test_engines = ['rapidocr', 'winrtocr', 'easyocr', 'tesseract', 'mock']
    filtered = filter_engines_by_platform(test_engines)
    print(f"Test engine list: {test_engines}")
    print(f"After filtering:  {filtered}")
    print()
    
    # Expected results
    if sys.platform == 'win32':
        expected = ['rapidocr', 'winrtocr', 'easyocr', 'tesseract']
    else:
        expected = ['rapidocr', 'easyocr', 'tesseract']
    
    if set(filtered) == set(expected):
        print("✓ PASS: Engine filtering works correctly!")
    else:
        print(f"✗ FAIL: Expected {expected}, got {filtered}")
        return False
    
    return True


def test_config_filtering():
    """Test that OCRConfig applies platform filters"""
    from ocr.config import OCRConfig, apply_platform_filters
    
    print("=" * 70)
    print("OCR CONFIG FILTERING TEST")
    print("=" * 70)
    
    # Create a config with winrtocr as primary (like AI server sends)
    os.environ['OCR_PRIMARY_ENGINE'] = 'winrtocr'
    os.environ['OCR_FALLBACK_ENGINES'] = 'rapidocr,tesseract'
    
    config = OCRConfig.from_env()
    print(f"Original config:")
    print(f"  Primary:   {config.primary_engine}")
    print(f"  Fallbacks: {config.fallback_engines}")
    print()
    
    # Apply platform filters
    config = apply_platform_filters(config)
    print(f"After platform filtering:")
    print(f"  Primary:   {config.primary_engine}")
    print(f"  Fallbacks: {config.fallback_engines}")
    print()
    
    # Verify results
    if sys.platform == 'win32':
        # Windows: Should keep winrtocr as primary
        if config.primary_engine == 'winrtocr':
            print("✓ PASS: Windows keeps WinRTOCR as primary")
            return True
        else:
            print(f"✗ FAIL: Expected winrtocr on Windows, got {config.primary_engine}")
            return False
    else:
        # Linux/Mac: Should switch to rapidocr (first fallback)
        if config.primary_engine == 'rapidocr':
            print(f"✓ PASS: {sys.platform} switched to RapidOCR (WinRT not available)")
            return True
        else:
            print(f"✗ FAIL: Expected rapidocr on {sys.platform}, got {config.primary_engine}")
            return False


def test_facade_filtering():
    """Test that OCRFacade automatically applies platform filters"""
    from ocr.facade import OCRFacade
    
    print("=" * 70)
    print("OCR FACADE FILTERING TEST")
    print("=" * 70)
    
    # Set config with winrtocr as primary
    os.environ['OCR_PRIMARY_ENGINE'] = 'winrtocr'
    os.environ['OCR_FALLBACK_ENGINES'] = 'rapidocr,tesseract'
    
    # Create facade (should automatically filter)
    facade = OCRFacade()
    
    print(f"Facade initialized:")
    print(f"  Primary:   {facade.config.primary_engine}")
    print(f"  Fallbacks: {facade.config.fallback_engines}")
    print()
    
    # Verify
    if sys.platform == 'win32':
        if facade.config.primary_engine == 'winrtocr':
            print("✓ PASS: Windows facade uses WinRTOCR")
            return True
        else:
            print(f"✗ FAIL: Expected winrtocr, got {facade.config.primary_engine}")
            return False
    else:
        if facade.config.primary_engine == 'rapidocr':
            print(f"✓ PASS: {sys.platform} facade switched to RapidOCR")
            return True
        else:
            print(f"✗ FAIL: Expected rapidocr, got {facade.config.primary_engine}")
            return False


def test_engine_availability():
    """Test that engines report availability correctly"""
    from ocr.engine_factory import EngineFactory
    
    print("=" * 70)
    print("ENGINE AVAILABILITY TEST")
    print("=" * 70)
    
    engines_to_test = ['rapidocr', 'winrtocr', 'tesseract', 'easyocr']
    
    for engine_name in engines_to_test:
        try:
            engine = EngineFactory.create(engine_name)
            available = engine.is_available()
            print(f"  {engine_name:15} - {'✓ Available' if available else '✗ Not available'}")
        except ValueError:
            print(f"  {engine_name:15} - ✗ Not registered")
        except Exception as e:
            print(f"  {engine_name:15} - ✗ Error: {e}")
    
    print()
    return True


def main():
    """Run all tests"""
    print()
    print("=" * 70)
    print(" OCR PLATFORM FILTERING TEST SUITE")
    print("=" * 70)
    print()
    
    results = []
    
    # Run tests
    try:
        results.append(("Platform Detection", test_platform_detection()))
        results.append(("Config Filtering", test_config_filtering()))
        results.append(("Facade Filtering", test_facade_filtering()))
        results.append(("Engine Availability", test_engine_availability()))
    except Exception as e:
        print(f"\n✗ TEST CRASHED: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    # Summary
    print()
    print("=" * 70)
    print(" TEST SUMMARY")
    print("=" * 70)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"  {status}: {name}")
    
    print()
    print(f"Results: {passed}/{total} tests passed")
    print()
    
    if passed == total:
        print("✓ ALL TESTS PASSED!")
        print()
        print("Platform filtering is working correctly.")
        print("The desktop app will:")
        print(" - Use RapidOCR as primary on Linux (WinRT not available)")
        print(" - Use WinRTOCR as primary on Windows (if configured)")
        print(" - Automatically fallback to compatible engines")
        print(" - Never crash due to missing engine imports")
        return 0
    else:
        print("✗ SOME TESTS FAILED")
        print("Please review the errors above.")
        return 1


if __name__ == '__main__':
    sys.exit(main())
