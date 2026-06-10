#!/usr/bin/env python3
"""
Test XDG Desktop Portal availability for screenshot capture.

This script tests all screenshot capture methods and determines
which ones work on the current system.

Usage:
    python test_portal_availability.py
"""

import subprocess
import os
import sys
import shutil


def print_header(text):
    """Print a formatted header."""
    print()
    print("=" * 60)
    print(text)
    print("=" * 60)


def test_environment():
    """Print current environment info."""
    print_header("ENVIRONMENT DETECTION")
    
    session_type = os.environ.get('XDG_SESSION_TYPE', 'unknown')
    wayland_display = os.environ.get('WAYLAND_DISPLAY', '')
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', 'unknown')
    
    is_wayland = bool(wayland_display) or session_type == 'wayland'
    
    print(f"Session Type:     {session_type}")
    print(f"WAYLAND_DISPLAY:  {wayland_display or '(not set)'}")
    print(f"Desktop:          {desktop}")
    print(f"Is Wayland:       {is_wayland}")
    
    return {
        'session_type': session_type,
        'is_wayland': is_wayland,
        'desktop': desktop
    }


def test_gnome_version():
    """Get GNOME Shell version."""
    print_header("GNOME VERSION")
    
    try:
        result = subprocess.run(
            ['gnome-shell', '--version'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            version_str = result.stdout.strip()
            print(f"GNOME Shell: {version_str}")
            
            # Extract version number
            import re
            match = re.search(r'(\d+)', version_str)
            if match:
                major_version = int(match.group(1))
                if major_version >= 46:
                    print("⚠️  GNOME 46+ detected - D-Bus screenshot may be blocked")
                else:
                    print("✅ GNOME < 46 - D-Bus screenshot should work")
                return major_version
        else:
            print("GNOME Shell not found")
    except Exception as e:
        print(f"Error detecting GNOME: {e}")
    
    return None


def test_gnome_dbus():
    """Test GNOME Shell Screenshot D-Bus access."""
    print_header("TEST: GNOME Shell Screenshot D-Bus (flash=false)")
    
    try:
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Screenshot',
                '--method', 'org.gnome.Shell.Screenshot.Screenshot',
                'false', 'false', '/tmp/test_gnome_dbus.png',
            ],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0 and '(true,' in result.stdout:
            print("✅ GNOME D-Bus Screenshot: AVAILABLE")
            print("   Flash-free capture via D-Bus works!")
            # Clean up
            try:
                os.unlink('/tmp/test_gnome_dbus.png')
            except:
                pass
            return True
        else:
            print("❌ GNOME D-Bus Screenshot: BLOCKED")
            if 'AccessDenied' in result.stderr:
                print("   Reason: Access denied (GNOME 46+ security)")
            else:
                print(f"   Error: {result.stderr.strip()[:100]}")
            return False
            
    except subprocess.TimeoutExpired:
        print("❌ GNOME D-Bus Screenshot: TIMEOUT")
        return False
    except FileNotFoundError:
        print("❌ gdbus command not found")
        return False
    except Exception as e:
        print(f"❌ GNOME D-Bus Screenshot: ERROR - {e}")
        return False


def test_xdg_portal():
    """Test XDG Desktop Portal availability."""
    print_header("TEST: XDG Desktop Portal Screenshot Interface")
    
    try:
        result = subprocess.run(
            [
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop',
            ],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0 and 'org.freedesktop.portal.Screenshot' in result.stdout:
            print("✅ XDG Desktop Portal: AVAILABLE")
            print("   Portal screenshot interface found!")
            print("   This can be used for flash-free capture on GNOME 46+")
            return True
        else:
            print("❌ XDG Desktop Portal: NOT AVAILABLE")
            print("   Portal daemon may not be running")
            return False
            
    except FileNotFoundError:
        print("❌ gdbus command not found")
        return False
    except Exception as e:
        print(f"❌ XDG Desktop Portal: ERROR - {e}")
        return False


def test_scrot():
    """Test scrot availability and Wayland behavior."""
    print_header("TEST: scrot (X11 screenshot tool)")
    
    if not shutil.which('scrot'):
        print("❌ scrot: NOT INSTALLED")
        print("   Install with: sudo apt install scrot")
        return False
    
    print("✅ scrot: INSTALLED")
    
    session_type = os.environ.get('XDG_SESSION_TYPE', '')
    if session_type == 'wayland':
        print()
        print("⚠️  WARNING: You are running Wayland")
        print("   scrot WILL PRODUCE A BLACK IMAGE")
        print()
        print("   ROOT CAUSE:")
        print("   • scrot uses X11 protocol (XGetImage)")
        print("   • On Wayland, X11 apps only see XWayland layer")
        print("   • XWayland root window is EMPTY by design")
        print("   • This is a SECURITY FEATURE of Wayland")
        print()
        print("   CONCLUSION:")
        print("   • scrot CANNOT be used on Wayland")
        print("   • No X11 screenshot tool can work on Wayland")
        print("   • Must use compositor-native methods (D-Bus, Portal)")
        return False
    else:
        print("   scrot should work correctly on X11")
        return True


def test_other_tools():
    """Test other screenshot tools."""
    print_header("TEST: Other Screenshot Tools")
    
    tools = {
        'gnome-screenshot': 'GNOME default (causes flash)',
        'maim': 'X11 only (black on Wayland)',
        'grim': 'Wayland wlroots only (NOT for GNOME)',
        'spectacle': 'KDE screenshot tool',
        'import': 'ImageMagick (X11 only)',
    }
    
    for tool, description in tools.items():
        available = shutil.which(tool) is not None
        status = "✅ installed" if available else "❌ not found"
        print(f"  {tool}: {status}")
        print(f"      {description}")


def print_summary(env, gnome_version, dbus_works, portal_available, scrot_works):
    """Print summary and recommendations."""
    print_header("SUMMARY & RECOMMENDATIONS")
    
    if env['is_wayland']:
        print("🖥️  You are running WAYLAND session")
        print()
        
        print("Available capture methods (in priority order):")
        print()
        
        if portal_available:
            print("  1. ✅ XDG Desktop Portal")
            print("     • Flash-free after one-time consent")
            print("     • RECOMMENDED for GNOME 46+")
            print()
        
        if dbus_works:
            print("  2. ✅ GNOME D-Bus (flash=false)")
            print("     • Flash-free, no consent needed")
            print("     • Works on your system!")
            print()
        else:
            print("  2. ❌ GNOME D-Bus - BLOCKED")
            print("     • GNOME 46+ security restriction")
            print()
        
        print("  3. ⚠️  gnome-screenshot binary")
        print("     • CAUSES VISUAL FLASH")
        print("     • Last resort fallback")
        print()
        
        print("  ❌ NOT USABLE on Wayland:")
        print("     • scrot (black image)")
        print("     • maim (black image)")
        print("     • python-mss (black image)")
        print("     • Pillow ImageGrab (black image)")
        print()
        
        print("RECOMMENDATION:")
        if portal_available and not dbus_works:
            print("  → Implement XDG Desktop Portal for flash-free capture")
        elif dbus_works:
            print("  → Current D-Bus method works, no changes needed")
        else:
            print("  → Flash will occur, consider switching to X11 session")
            
    else:
        print("🖥️  You are running X11 session")
        print()
        print("All screenshot methods should work without flash:")
        print("  • scrot (recommended)")
        print("  • Pillow ImageGrab")
        print("  • python-mss")
        print()
        print("No changes needed for X11.")


def main():
    """Main test function."""
    print()
    print("🔍 SCREENSHOT CAPTURE CAPABILITY TEST")
    print("    Testing which methods work on your system...")
    
    env = test_environment()
    gnome_version = test_gnome_version()
    dbus_works = test_gnome_dbus()
    portal_available = test_xdg_portal()
    scrot_works = test_scrot()
    test_other_tools()
    
    print_summary(env, gnome_version, dbus_works, portal_available, scrot_works)
    
    print()
    print("=" * 60)
    print("TEST COMPLETE")
    print("=" * 60)
    print()
    
    # Return exit code based on results
    if env['is_wayland'] and not dbus_works and not portal_available:
        print("⚠️  No flash-free capture method available!")
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
