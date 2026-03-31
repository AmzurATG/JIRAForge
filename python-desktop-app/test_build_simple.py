#!/usr/bin/env python3
"""
Simple macOS Build Test
Basic validation without macOS framework calls that might cause segfaults
"""
import os
import sys
import subprocess

def print_status(message):
    print(f"[INFO] {message}")

def print_success(message):  
    print(f"[✓] {message}")

def print_error(message):
    print(f"[✗] {message}")

def main():
    print("TimeTracker macOS Build Test")
    print("=" * 40)
    
    # Check Python version
    python_version = sys.version_info
    if python_version >= (3, 8):
        print_success(f"Python {python_version.major}.{python_version.minor}.{python_version.micro}")
    else:
        print_error(f"Python 3.8+ required")
        return False
        
    # Check required files
    files = ['mac_desktop_app.py', 'mac_desktop_app.spec', 'build_mac.sh']
    for f in files:
        if os.path.exists(f):
            print_success(f"File exists: {f}")
        else:
            print_error(f"Missing file: {f}")
            return False
            
    # Check PyInstaller
    try:
        result = subprocess.run(['python3', '-m', 'PyInstaller', '--version'], 
                               capture_output=True, text=True)
        if result.returncode == 0:
            print_success(f"PyInstaller: {result.stdout.strip()}")
        else:
            print_error("PyInstaller not available")
            return False
    except Exception as e:
        print_error(f"PyInstaller check failed: {e}")
        return False
        
    print_success("Basic validation complete - ready to build!")
    return True

if __name__ == "__main__":
    success = main()
    if success:
        print("\nTo build the app, run: ./build_mac.sh")
    sys.exit(0 if success else 1)