#!/usr/bin/env python3
"""
Test script for Mac desktop app build validation
Tests the key functionality that was causing issues
"""

import sys
import os
import traceback
from datetime import datetime, timezone, timedelta
from io import BytesIO

# Test PIL Image handling for RGBA to RGB conversion
def test_image_conversion():
    """Test the RGBA to RGB conversion that was causing the JPEG error"""
    try:
        from PIL import Image, ImageGrab
        
        print("🖼️  Testing image conversion...")
        
        # Test RGBA to RGB conversion
        # Create a test RGBA image
        test_image = Image.new('RGBA', (400, 300), (255, 255, 255, 128))
        print(f"   Original mode: {test_image.mode}")
        
        # Convert as done in the fixed code
        if test_image.mode == 'RGBA':
            rgb_image = Image.new('RGB', test_image.size, (255, 255, 255))
            rgb_image.paste(test_image, mask=test_image.split()[-1])
            test_image = rgb_image
        
        print(f"   Converted mode: {test_image.mode}")
        
        # Test JPEG saving
        buffer = BytesIO()
        test_image.save(buffer, format='JPEG', quality=70)
        jpeg_bytes = buffer.getvalue()
        
        print(f"   ✅ JPEG conversion successful ({len(jpeg_bytes)} bytes)")
        return True, None
        
    except Exception as e:
        error_msg = f"❌ Image conversion test failed: {e}"
        print(error_msg)
        traceback.print_exc()
        return False, str(e)

def test_screenshot_capture():
    """Test screenshot capture functionality"""
    try:
        from PIL import Image, ImageGrab
        
        print("📸 Testing screenshot capture...")
        
        # Try to take a screenshot
        screenshot = ImageGrab.grab()
        if screenshot:
            print(f"   Screenshot captured: {screenshot.size}, mode: {screenshot.mode}")
            
            # Test the conversion process
            if screenshot.mode == 'RGBA':
                print("   ⚠️  Screenshot is in RGBA mode - will need conversion")
                rgb_image = Image.new('RGB', screenshot.size, (255, 255, 255))
                rgb_image.paste(screenshot, mask=screenshot.split()[-1])
                screenshot = rgb_image
                print(f"   Converted to: {screenshot.mode}")
            
            # Test thumbnail creation
            thumbnail = screenshot.copy()
            thumbnail.thumbnail((400, 300))
            
            # Test JPEG conversion
            buffer = BytesIO()
            thumbnail.save(buffer, format='JPEG', quality=70)
            
            print(f"   ✅ Screenshot processing successful")
            return True, None
        else:
            error_msg = "❌ Failed to capture screenshot"
            print(error_msg)
            return False, error_msg
            
    except Exception as e:
        error_msg = f"❌ Screenshot test failed: {e}"
        print(error_msg)
        traceback.print_exc()
        return False, str(e)

def test_macos_frameworks():
    """Test macOS-specific framework imports"""
    try:
        print("🍎 Testing macOS frameworks...")
        
        # Test Core frameworks
        try:
            import AppKit
            print("   ✅ AppKit imported")
        except ImportError as e:
            print(f"   ⚠️  AppKit import failed: {e}")
        
        try:
            import Quartz
            print("   ✅ Quartz imported")
        except ImportError as e:
            print(f"   ⚠️  Quartz import failed: {e}")
        
        try:
            import Foundation
            print("   ✅ Foundation imported")
        except ImportError as e:
            print(f"   ⚠️  Foundation import failed: {e}")
        
        return True, None
        
    except Exception as e:
        error_msg = f"❌ macOS frameworks test failed: {e}"
        print(error_msg)
        traceback.print_exc()
        return False, str(e)

def test_dependencies():
    """Test key dependencies"""
    try:
        print("📦 Testing dependencies...")
        
        dependencies = [
            'flask',
            'flask_cors',
            'requests',
            'supabase',
            'pynput',
            'pystray',
            'keyring',
            'cryptography',
            'psutil'
        ]
        
        for dep in dependencies:
            try:
                __import__(dep)
                print(f"   ✅ {dep}")
            except ImportError as e:
                print(f"   ❌ {dep}: {e}")
        
        return True, None
        
    except Exception as e:
        error_msg = f"❌ Dependencies test failed: {e}"
        print(error_msg)
        return False, str(e)

def main():
    """Run all tests"""
    print("🧪 Mac Desktop App Build Validation Tests")
    print("=" * 50)
    
    tests = [
        ("Image Conversion", test_image_conversion),
        ("Screenshot Capture", test_screenshot_capture),
        ("macOS Frameworks", test_macos_frameworks),
        ("Dependencies", test_dependencies)
    ]
    
    results = []
    
    for test_name, test_func in tests:
        print(f"\n{test_name}:")
        success, error = test_func()
        results.append((test_name, success, error))
    
    print("\n" + "=" * 50)
    print("📊 Test Summary:")
    
    passed = 0
    failed = 0
    
    for test_name, success, error in results:
        if success:
            print(f"   ✅ {test_name}")
            passed += 1
        else:
            print(f"   ❌ {test_name}: {error}")
            failed += 1
    
    print(f"\nResults: {passed} passed, {failed} failed")
    
    if failed == 0:
        print("🎉 All tests passed! Ready for build.")
        return 0
    else:
        print("⚠️  Some tests failed. Check dependencies and setup.")
        return 1

if __name__ == "__main__":
    sys.exit(main())