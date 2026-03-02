#!/usr/bin/env python3
"""
macOS Setup Script for Time Tracker
Handles dependency conflicts and creates a clean virtual environment
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path

def run_command(cmd, check=True, shell=True):
    """Run a shell command and return the result"""
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=shell, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"❌ Command failed: {cmd}")
        print(f"Error: {result.stderr}")
        return False
    return True

def main():
    print("🍎 Time Tracker macOS Setup")
    print("=" * 50)
    
    # Check if we're in the right directory
    if not os.path.exists("mac_desktop_app.py"):
        print("❌ Please run this script from the python-desktop-app directory")
        return False
    
    # Step 1: Clean up any existing problematic installations
    print("\n📦 Step 1: Cleaning up existing installations...")
    
    # Uninstall problematic packages first
    problematic_packages = [
        "supabase-auth", "supabase-functions", "supabase-storage", 
        "supabase-gotrue", "supabase-postgrest", "supabase-realtime",
        "supabase", "httpx", "httpcore"
    ]
    
    for package in problematic_packages:
        cmd = f"pip3 uninstall -y {package}"
        run_command(cmd, check=False)
    
    # Step 2: Install core dependencies without version conflicts
    print("\n📦 Step 2: Installing core dependencies...")
    
    # Install dependencies in specific order to avoid conflicts
    core_packages = [
        "flask==3.0.0",
        "flask-cors==4.0.0", 
        "pillow==10.1.0",
        "requests==2.31.0",
        "python-dotenv==1.0.0",
        "psutil==5.9.6",
        "cryptography==41.0.7",
        "pynput==1.7.6",
        "keyring==24.3.0",
        "plyer==2.1.0",
        "pystray==0.19.5",
        "tzlocal==5.2"
    ]
    
    for package in core_packages:
        if not run_command(f"pip3 install {package}"):
            print(f"❌ Failed to install {package}")
            return False
    
    # Step 3: Install macOS frameworks
    print("\n🍎 Step 3: Installing macOS frameworks...")
    
    macos_packages = [
        "pyobjc-core",
        "pyobjc-framework-Cocoa", 
        "pyobjc-framework-Quartz"
    ]
    
    for package in macos_packages:
        if not run_command(f"pip3 install {package}"):
            print(f"❌ Failed to install {package}")
            return False
    
    # Step 4: Install Supabase with compatible versions
    print("\n🗄️  Step 4: Installing Supabase client...")
    
    # Install latest compatible Supabase
    if not run_command("pip3 install 'supabase>=2.0.0,<3.0.0'"):
        print("❌ Failed to install Supabase")
        return False
    
    # Step 5: Verify installation
    print("\n✅ Step 5: Verifying installation...")
    
    if not run_command("python3 test_macos_compatibility.py"):
        print("❌ Compatibility test failed")
        return False
    
    print("\n🎉 Setup completed successfully!")
    print("\n📋 Next steps:")
    print("1. Run the application: python3 mac_desktop_app.py")
    print("2. Open web interface: http://localhost:51777")
    print("3. Grant macOS permissions when prompted")
    
    return True

if __name__ == "__main__":
    if main():
        sys.exit(0)
    else:
        sys.exit(1)