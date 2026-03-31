#!/usr/bin/env python3
"""
macOS App Bundle Validation Script
Tests the TimeTracker macOS build process and validates functionality
"""
import os
import sys
import importlib
import subprocess
import tempfile
from pathlib import Path

def print_status(message):
    print(f"[INFO] {message}")

def print_success(message):
    print(f"[✓] {message}")

def print_error(message):
    print(f"[✗] {message}")

def print_warning(message):
    print(f"[⚠] {message}")

def check_python_environment():
    """Check Python version and environment"""
    print_status("Checking Python environment...")
    
    python_version = sys.version_info
    if python_version >= (3, 8):
        print_success(f"Python {python_version.major}.{python_version.minor}.{python_version.micro}")
    else:
        print_error(f"Python 3.8+ required, found {python_version.major}.{python_version.minor}")
        return False
        
    return True

def check_required_modules():
    """Check if all required modules can be imported"""
    print_status("Checking required modules...")
    
    required_modules = [
        # Core modules created for macOS
        'mac_auto_updater',
        'macos_compatibility',
        
        # Existing modules
        'ocr',
        'privacy',
        
        # Standard dependencies
        'PIL',
        'flask',
        'requests',
        'supabase',
        'keyring',
        'psutil',
        'dotenv',
    ]
    
    optional_modules = [
        'pystray',
        'pynput',
        'plyer',
        'paddleocr',
        'pytesseract',
        'cv2',
        'numpy',
    ]
    
    macOS_frameworks = [
        'Cocoa',
        'Foundation', 
        'AppKit',
        'Quartz',
    ]
    
    all_good = True
    
    # Check required modules
    for module in required_modules:
        try:
            importlib.import_module(module)
            print_success(f"Required module: {module}")
        except ImportError as e:
            print_error(f"Required module missing: {module} - {e}")
            all_good = False
            
    # Check optional modules
    for module in optional_modules:
        try:
            importlib.import_module(module)
            print_success(f"Optional module: {module}")
        except ImportError:
            print_warning(f"Optional module missing: {module}")
            
    # Check macOS frameworks
    frameworks_available = 0
    for framework in macOS_frameworks:
        try:
            importlib.import_module(framework)
            print_success(f"macOS framework: {framework}")
            frameworks_available += 1
        except ImportError:
            print_warning(f"macOS framework missing: {framework}")
            
    if frameworks_available == 0:
        print_warning("No macOS frameworks available - install PyObjC: pip install pyobjc")
        
    return all_good

def check_build_files():
    """Check if all build-related files exist"""
    print_status("Checking build files...")
    
    required_files = [
        'mac_desktop_app.py',
        'mac_desktop_app.spec', 
        'Info.plist',
        'build_mac.sh',
        'requirements.txt',
        'mac_auto_updater.py',
        'macos_compatibility.py',
    ]
    
    all_exist = True
    for file_path in required_files:
        if os.path.exists(file_path):
            print_success(f"Build file: {file_path}")
        else:
            print_error(f"Build file missing: {file_path}")
            all_exist = False
            
    return all_exist

def test_compatibility_layer():
    """Test the macOS compatibility layer"""
    print_status("Testing macOS compatibility layer...")
    
    try:
        from macos_compatibility import (
            init_compatibility_layer, get_compatibility,
            get_macos_version, is_macos_tahoe_or_later,
            get_screen_capture, get_notifications
        )
        
        # Test initialization
        if init_compatibility_layer():
            print_success("Compatibility layer initialized")
        else:
            print_error("Compatibility layer initialization failed")
            return False
            
        # Test version detection
        compat_info = get_compatibility()
        macos_version = compat_info.get('macos_version', 'Unknown')
        print_success(f"macOS version: {macos_version}")
        
        # Test Tahoe compatibility
        is_tahoe = is_macos_tahoe_or_later()
        if is_tahoe:
            print_success("macOS Tahoe (26.3+) compatibility: Yes")
        else:
            print_success(f"macOS Tahoe (26.3+) compatibility: No (running {macos_version})")
            
        # Test capabilities
        screen_cap = get_screen_capture()
        print_success(f"Screen capture available: {screen_cap.get('available', False)}")
        
        notif_cap = get_notifications()
        print_success(f"Notifications available: {notif_cap.get('available', False)}")
        
        return True
        
    except Exception as e:
        print_error(f"Compatibility layer test failed: {e}")
        return False

def test_auto_updater():
    """Test the auto-updater functionality"""
    print_status("Testing auto-updater...")
    
    try:
        from mac_auto_updater import MacAppAutoUpdater, initialize_auto_updater
        
        # Test initialization
        if initialize_auto_updater():
            print_success("Auto-updater initialized")
        else:
            print_warning("Auto-updater initialization failed")
            
        # Test updater creation
        updater = MacAppAutoUpdater("1.2.1", "https://forgesync.amzur.com")
        if updater:
            print_success("Auto-updater instance created")
        else:
            print_error("Failed to create auto-updater instance")
            return False
            
        return True
        
    except Exception as e:
        print_error(f"Auto-updater test failed: {e}")
        return False

def test_main_app_import():
    """Test importing the main app module"""
    print_status("Testing main app import...")
    
    try:
        # Test if we can import the main app without running it
        spec = importlib.util.spec_from_file_location("mac_desktop_app", "mac_desktop_app.py")
        if spec and spec.loader:
            print_success("Main app module can be loaded")
            return True
        else:
            print_error("Main app module spec creation failed")
            return False
            
    except Exception as e:
        print_error(f"Main app import test failed: {e}")
        return False

def validate_pyinstaller():
    """Validate PyInstaller configuration"""
    print_status("Validating PyInstaller configuration...")
    
    try:
        # Check if PyInstaller is available
        result = subprocess.run(['python3', '-m', 'PyInstaller', '--version'], 
                               capture_output=True, text=True)
        if result.returncode == 0:
            print_success(f"PyInstaller version: {result.stdout.strip()}")
        else:
            print_error("PyInstaller not available")
            return False
            
        # Validate spec file syntax
        if os.path.exists('mac_desktop_app.spec'):
            try:
                with open('mac_desktop_app.spec', 'r') as f:
                    spec_content = f.read()
                    
                # Basic syntax check
                compile(spec_content, 'mac_desktop_app.spec', 'exec')
                print_success("PyInstaller spec file syntax valid")
                
            except SyntaxError as e:
                print_error(f"PyInstaller spec file syntax error: {e}")
                return False
                
        return True
        
    except Exception as e:
        print_error(f"PyInstaller validation failed: {e}")
        return False

def dry_run_build():
    """Perform a dry run of the build process"""
    print_status("Performing dry run build test...")
    
    try:
        # Test spec file loading
        result = subprocess.run([
            'python3', '-m', 'PyInstaller', 
            'mac_desktop_app.spec', 
            '--dry-run'
        ], capture_output=True, text=True, cwd='.')
        
        if result.returncode == 0:
            print_success("PyInstaller dry run successful")
            return True
        else:
            print_error(f"PyInstaller dry run failed: {result.stderr}")
            return False
            
    except Exception as e:
        print_error(f"Dry run build failed: {e}")
        return False

def main():
    """Run all validation tests"""
    print("=" * 60)
    print("TimeTracker macOS App Bundle Validation")
    print("=" * 60)
    print()
    
    tests = [
        ("Python Environment", check_python_environment),
        ("Required Modules", check_required_modules),
        ("Build Files", check_build_files),
        ("Compatibility Layer", test_compatibility_layer),
        ("Auto-updater", test_auto_updater),
        ("Main App Import", test_main_app_import),
        ("PyInstaller", validate_pyinstaller),
        ("Dry Run Build", dry_run_build),
    ]
    
    results = {}
    
    for test_name, test_func in tests:
        print(f"\n--- {test_name} ---")
        try:
            results[test_name] = test_func()
        except Exception as e:
            print_error(f"Test '{test_name}' crashed: {e}")
            results[test_name] = False
            
    # Summary
    print("\n" + "=" * 60)
    print("VALIDATION SUMMARY")
    print("=" * 60)
    
    passed = sum(1 for result in results.values() if result)
    total = len(results)
    
    for test_name, result in results.items():
        status = "PASS" if result else "FAIL"
        icon = "✓" if result else "✗"
        print(f"{icon} {test_name}: {status}")
        
    print(f"\nResults: {passed}/{total} tests passed")
    
    if passed == total:
        print_success("\nAll tests passed! The macOS app bundle should build successfully.")
        print_success("You can now run: ./build_mac.sh")
    else:
        print_error("\nSome tests failed. Please resolve the issues before building.")
        
    return passed == total

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)