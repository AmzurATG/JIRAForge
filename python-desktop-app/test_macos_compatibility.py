#!/usr/bin/env python3
"""
macOS Compatibility Test for Time Tracker
Tests if all required macOS frameworks and dependencies are available
"""

import sys
import os
import importlib

def test_import(module_name, friendly_name=None, required=True):
    """Test if a module can be imported"""
    if friendly_name is None:
        friendly_name = module_name
    
    try:
        importlib.import_module(module_name)
        print(f"✅ {friendly_name}")
        return True
    except ImportError as e:
        status = "❌" if required else "⚠️ "
        print(f"{status} {friendly_name} - {e}")
        return False

def main():
    """Run compatibility tests"""
    print("🍎 Time Tracker macOS Compatibility Test")
    print("=" * 50)
    
    # Check Python version
    print(f"🐍 Python Version: {sys.version}")
    if sys.version_info < (3, 8):
        print("❌ Python 3.8+ required")
        return False
    else:
        print("✅ Python version compatible")
    
    print("\n📦 Testing Core Dependencies:")
    core_passed = True
    
    # Core dependencies
    core_deps = [
        ('flask', 'Flask'),
        ('PIL', 'Pillow (PIL)'),
        ('requests', 'Requests'),
        ('supabase', 'Supabase'),
        ('dotenv', 'python-dotenv'),
        ('psutil', 'psutil'),
        ('cryptography', 'Cryptography'),
        ('keyring', 'Keyring'),
        ('pystray', 'Pystray'),
    ]
    
    for module, name in core_deps:
        if not test_import(module, name, required=True):
            core_passed = False
    
    print("\n🍎 Testing macOS Frameworks:")
    macos_passed = True
    
    if sys.platform != 'darwin':
        print("⚠️  Not running on macOS - macOS-specific tests skipped")
        macos_passed = False
    else:
        # macOS-specific dependencies
        macos_deps = [
            ('Cocoa', 'Cocoa Framework'),
            ('Quartz', 'Quartz Framework'), 
            ('AppKit', 'AppKit (part of Cocoa)'),
        ]
        
        for module, name in macos_deps:
            if not test_import(module, name, required=True):
                macos_passed = False
    
    print("\n🔔 Testing Notification Support:")
    notification_available = False
    
    if test_import('plyer', 'Plyer (Cross-platform notifications)', required=False):
        try:
            from plyer import notification
            print("✅ Plyer notification support")
            notification_available = True
        except Exception as e:
            print(f"⚠️  Plyer notification not functional: {e}")
    
    if test_import('winotify', 'Winotify (Windows fallback)', required=False):
        print("✅ Windows notification fallback available")
    
    if not notification_available:
        print("⚠️  No notification support detected")
    
    print("\n💾 Testing Optional Dependencies:")
    test_import('tzlocal', 'Timezone Support', required=False)
    test_import('pyinstaller', 'PyInstaller (for building)', required=False)
    
    print("\n🔍 System Information:")
    print(f"   Platform: {sys.platform}")
    print(f"   Architecture: {os.uname().machine if hasattr(os, 'uname') else 'Unknown'}")
    
    if sys.platform == 'darwin':
        try:
            import platform
            print(f"   macOS Version: {platform.mac_ver()[0]}")
        except:
            print("   macOS Version: Unknown")
    
    # App data directory test
    try:
        if sys.platform == 'darwin':
            app_data = os.path.expanduser('~/.local/share')
        else:
            app_data = os.path.expanduser('~')
        
        app_dir = os.path.join(app_data, 'TimeTracker')
        print(f"   App Data Directory: {app_dir}")
        
        # Test if we can create the directory
        os.makedirs(app_dir, exist_ok=True)
        if os.path.exists(app_dir):
            print("✅ App data directory accessible")
        else:
            print("❌ Cannot create app data directory")
            
    except Exception as e:
        print(f"❌ App data directory test failed: {e}")
        core_passed = False
    
    print("\n" + "=" * 50)
    
    # Final result
    if core_passed and (macos_passed or sys.platform != 'darwin'):
        print("🎉 All tests passed! Time Tracker should work on this system.")
        
        if sys.platform == 'darwin':
            print("\n📋 Next Steps:")
            print("   1. Run: python3 mac_desktop_app.py")
            print("   2. Grant permissions when prompted")
            print("   3. Or build standalone app: ./build_macos.sh")
        else:
            print("⚠️  This system is not macOS. Use the appropriate version for your platform.")
        
        return True
    else:
        print("❌ Some tests failed. Please install missing dependencies:")
        print("   pip3 install -r requirements-macos.txt")
        
        if sys.platform == 'darwin' and not macos_passed:
            print("   xcode-select --install  # For macOS frameworks")
        
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)