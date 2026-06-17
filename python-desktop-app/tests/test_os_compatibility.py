#!/usr/bin/env python3
"""
TimeTracker OS Compatibility Test Suite

Tests all TimeTracker features across different Linux distributions
and desktop environment versions.

Usage:
    python tests/test_os_compatibility.py
    python tests/test_os_compatibility.py --json output.json
    python tests/test_os_compatibility.py --verbose

Version: 1.0.0
Date: 2026-06-17
"""

import os
import sys
import json
import argparse
import subprocess
import time
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

# Add parent directory for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Colors:
    """ANSI color codes for terminal output."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'


def colored(text: str, color: str) -> str:
    """Apply color to text if stdout is a terminal."""
    if sys.stdout.isatty():
        return f"{color}{text}{Colors.END}"
    return text


class OSCompatibilityTester:
    """Comprehensive OS compatibility test suite for TimeTracker."""
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.results: Dict[str, Any] = {
            'timestamp': datetime.now().isoformat(),
            'system': {},
            'tests': [],
            'summary': {}
        }
    
    def log(self, message: str, level: str = "INFO"):
        """Log a message with appropriate prefix."""
        if self.verbose or level in ("ERROR", "WARN"):
            prefix = {
                "INFO": colored("ℹ", Colors.BLUE),
                "PASS": colored("✓", Colors.GREEN),
                "FAIL": colored("✗", Colors.RED),
                "WARN": colored("⚠", Colors.YELLOW),
                "ERROR": colored("✗", Colors.RED),
            }.get(level, "")
            print(f"  {prefix} {message}")
    
    def record_test(self, name: str, passed: bool, details: str = "", 
                    category: str = "general"):
        """Record a test result."""
        self.results['tests'].append({
            'name': name,
            'category': category,
            'passed': passed,
            'details': details,
            'timestamp': datetime.now().isoformat()
        })
        
        status = colored("PASS", Colors.GREEN) if passed else colored("FAIL", Colors.RED)
        print(f"  [{status}] {name}")
        if details and (self.verbose or not passed):
            for line in details.split('\n'):
                print(f"         {line}")
    
    # =========================================================================
    # System Information Collection
    # =========================================================================
    
    def collect_system_info(self) -> Dict[str, Any]:
        """Collect comprehensive system information."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("COLLECTING SYSTEM INFORMATION", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        info = {}
        
        # Kernel
        try:
            result = subprocess.run(['uname', '-r'], capture_output=True, text=True)
            info['kernel'] = result.stdout.strip()
            self.log(f"Kernel: {info['kernel']}")
        except Exception:
            info['kernel'] = 'Unknown'
        
        # Full kernel info
        try:
            result = subprocess.run(['uname', '-a'], capture_output=True, text=True)
            info['kernel_full'] = result.stdout.strip()
        except Exception:
            info['kernel_full'] = 'Unknown'
        
        # OS Release
        try:
            with open('/etc/os-release') as f:
                for line in f:
                    if '=' in line:
                        key, value = line.strip().split('=', 1)
                        info[f'os_{key.lower()}'] = value.strip('"')
            self.log(f"OS: {info.get('os_name', 'Unknown')} {info.get('os_version_id', '')}")
        except Exception:
            pass
        
        # GNOME Version
        try:
            result = subprocess.run(['gnome-shell', '--version'], 
                                    capture_output=True, text=True, timeout=3)
            if result.returncode == 0:
                import re
                match = re.search(r'(\d+)\.(\d+)', result.stdout)
                if match:
                    info['gnome_version'] = f"{match.group(1)}.{match.group(2)}"
                    info['gnome_major'] = int(match.group(1))
                    self.log(f"GNOME Shell: {info['gnome_version']}")
        except Exception:
            pass
        
        # Display server
        info['wayland_display'] = os.environ.get('WAYLAND_DISPLAY', '')
        info['x_display'] = os.environ.get('DISPLAY', '')
        info['session_type'] = os.environ.get('XDG_SESSION_TYPE', '')
        info['is_wayland'] = bool(info['wayland_display'] or 
                                   info['session_type'].lower() == 'wayland')
        
        self.log(f"Session: {'Wayland' if info['is_wayland'] else 'X11'}")
        self.log(f"WAYLAND_DISPLAY: '{info['wayland_display']}'")
        self.log(f"DISPLAY: '{info['x_display']}'")
        
        self.results['system'] = info
        return info
    
    # =========================================================================
    # Window Detection Tests
    # =========================================================================
    
    def test_window_detection(self):
        """Test all window detection methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("WINDOW DETECTION TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        # Test 1: xdotool
        self._test_xdotool()
        
        # Test 2: gdbus Shell.Eval
        self._test_gdbus_shell_eval()
        
        # Test 3: GNOME Introspect
        self._test_gnome_introspect()
        
        # Test 4: AT-SPI2
        self._test_atspi()
    
    def _test_xdotool(self):
        """Test xdotool window detection."""
        try:
            # Check if installed
            result = subprocess.run(['which', 'xdotool'], capture_output=True)
            if result.returncode != 0:
                self.record_test("xdotool available", False, 
                                "xdotool not installed", "window_detection")
                return
            
            self.record_test("xdotool installed", True, "", "window_detection")
            
            # Try to get active window
            result = subprocess.run(['xdotool', 'getactivewindow'],
                                    capture_output=True, text=True, timeout=3)
            if result.returncode == 0:
                wid = result.stdout.strip()
                # Get window name
                name_result = subprocess.run(['xdotool', 'getwindowname', wid],
                                             capture_output=True, text=True, timeout=3)
                title = name_result.stdout.strip() if name_result.returncode == 0 else 'Unknown'
                self.record_test("xdotool window detection", True,
                                f"Window ID: {wid}, Title: {title[:50]}",
                                "window_detection")
            else:
                self.record_test("xdotool window detection", False,
                                f"getactivewindow failed: {result.stderr.strip()[:100]}",
                                "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("xdotool window detection", False,
                            "Timeout", "window_detection")
        except Exception as e:
            self.record_test("xdotool window detection", False,
                            str(e), "window_detection")
    
    def _test_gdbus_shell_eval(self):
        """Test GNOME Shell.Eval method."""
        try:
            result = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell',
                '--method', 'org.gnome.Shell.Eval',
                "let w=global.display.focus_window;w?w.title:'none'"
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0 and 'true' in result.stdout.lower():
                self.record_test("Shell.Eval window detection", True,
                                f"Response: {result.stdout.strip()[:100]}",
                                "window_detection")
            else:
                # Check if disabled (GNOME 45+)
                if 'false' in result.stdout.lower():
                    self.record_test("Shell.Eval window detection", False,
                                    "Disabled (expected on GNOME 45+)",
                                    "window_detection")
                else:
                    self.record_test("Shell.Eval window detection", False,
                                    f"Failed: {result.stderr.strip()[:100]}",
                                    "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("Shell.Eval window detection", False,
                            "Timeout", "window_detection")
        except FileNotFoundError:
            self.record_test("Shell.Eval window detection", False,
                            "gdbus not installed", "window_detection")
        except Exception as e:
            self.record_test("Shell.Eval window detection", False,
                            str(e), "window_detection")
    
    def _test_gnome_introspect(self):
        """Test GNOME Shell Introspect API."""
        try:
            # First check if interface exists
            check = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect'
            ], capture_output=True, text=True, timeout=3)
            
            if check.returncode != 0 or 'GetWindows' not in check.stdout:
                self.record_test("GNOME Introspect API", False,
                                "Interface not available", "window_detection")
                return
            
            self.record_test("GNOME Introspect API available", True, "", "window_detection")
            
            # Call GetWindows
            result = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect',
                '--method', 'org.gnome.Shell.Introspect.GetWindows',
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0:
                window_count = result.stdout.count("'title':")
                has_focus = "'has-focus': <true>" in result.stdout
                self.record_test("GNOME Introspect GetWindows", True,
                                f"Windows: {window_count}, Has focused: {has_focus}",
                                "window_detection")
            else:
                self.record_test("GNOME Introspect GetWindows", False,
                                f"GetWindows failed: {result.stderr.strip()[:100]}",
                                "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("GNOME Introspect API", False,
                            "Timeout (10s)", "window_detection")
        except Exception as e:
            self.record_test("GNOME Introspect API", False,
                            str(e), "window_detection")
    
    def _test_atspi(self):
        """Test AT-SPI2 accessibility API."""
        try:
            # Check if AT-SPI2 bus is available
            check = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.a11y.Bus',
                '--object-path', '/org/a11y/bus',
                '--method', 'org.a11y.Bus.GetAddress'
            ], capture_output=True, text=True, timeout=3)
            
            if check.returncode != 0:
                self.record_test("AT-SPI2 D-Bus", False,
                                "Bus not running", "window_detection")
                return
            
            self.record_test("AT-SPI2 D-Bus", True,
                            "Bus available", "window_detection")
            
            # Try to query windows via python3
            code = '''
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()
d = Atspi.get_desktop(0)
count = d.get_child_count()
print(f"Apps: {count}")
for i in range(min(count, 5)):
    app = d.get_child_at_index(i)
    if app:
        print(f"  - {app.get_name()}")
'''
            result = subprocess.run(['/usr/bin/python3', '-c', code],
                                    capture_output=True, text=True, timeout=5)
            
            if result.returncode == 0:
                self.record_test("AT-SPI2 window enumeration", True,
                                result.stdout.strip()[:200], "window_detection")
            else:
                self.record_test("AT-SPI2 window enumeration", False,
                                f"Error: {result.stderr.strip()[:100]}",
                                "window_detection")
        except Exception as e:
            self.record_test("AT-SPI2 test", False, str(e), "window_detection")
    
    # =========================================================================
    # Idle Detection Tests
    # =========================================================================
    
    def test_idle_detection(self):
        """Test all idle detection methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("IDLE DETECTION TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        self._test_freedesktop_screensaver()
        self._test_gnome_mutter_idle()
        self._test_evdev()
        self._test_pynput()
    
    def _test_freedesktop_screensaver(self):
        """Test FreeDesktop ScreenSaver idle API."""
        try:
            import dbus
            bus = dbus.SessionBus()
            ss = bus.get_object('org.freedesktop.ScreenSaver', 
                               '/org/freedesktop/ScreenSaver')
            iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
            idle_time = iface.GetSessionIdleTime()
            self.record_test("FreeDesktop ScreenSaver", True,
                            f"Current idle: {idle_time}ms", "idle_detection")
        except ImportError:
            self.record_test("FreeDesktop ScreenSaver", False,
                            "python-dbus not installed", "idle_detection")
        except Exception as e:
            self.record_test("FreeDesktop ScreenSaver", False,
                            str(e)[:100], "idle_detection")
    
    def _test_gnome_mutter_idle(self):
        """Test GNOME Mutter IdleMonitor."""
        try:
            import dbus
            bus = dbus.SessionBus()
            obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                '/org/gnome/Mutter/IdleMonitor/Core')
            iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
            idle_time = iface.GetIdletime()
            self.record_test("GNOME Mutter IdleMonitor", True,
                            f"Current idle: {idle_time}ms", "idle_detection")
        except ImportError:
            self.record_test("GNOME Mutter IdleMonitor", False,
                            "python-dbus not installed", "idle_detection")
        except Exception as e:
            self.record_test("GNOME Mutter IdleMonitor", False,
                            str(e)[:100], "idle_detection")
    
    def _test_evdev(self):
        """Test evdev input device access."""
        import glob
        devices = glob.glob('/dev/input/event*')
        readable = [d for d in devices if os.access(d, os.R_OK)]
        
        if readable:
            self.record_test("evdev access", True,
                            f"{len(readable)}/{len(devices)} devices readable",
                            "idle_detection")
        else:
            self.record_test("evdev access", False,
                            f"No devices readable (need 'input' group)",
                            "idle_detection")
    
    def _test_pynput(self):
        """Test pynput availability."""
        try:
            import pynput
            is_wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
            if is_wayland:
                self.record_test("pynput", True,
                                "Available (WARNING: unreliable on Wayland)",
                                "idle_detection")
            else:
                self.record_test("pynput", True,
                                "Available", "idle_detection")
        except ImportError:
            self.record_test("pynput", False,
                            "Not installed", "idle_detection")
    
    # =========================================================================
    # Screenshot Capture Tests
    # =========================================================================
    
    def test_screenshot_capture(self):
        """Test screenshot capture methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("SCREENSHOT CAPTURE TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        self._test_gstreamer()
        self._test_gstreamer_pipewiresrc()
        self._test_pipewire()
        self._test_screencast_portal()
        self._test_screenshot_portal()
        self._test_gnome_screenshot()
        self._test_scrot()
    
    def _test_gstreamer(self):
        """Test GStreamer availability."""
        try:
            result = subprocess.run(['which', 'gst-launch-1.0'], capture_output=True)
            if result.returncode == 0:
                self.record_test("GStreamer", True,
                                "gst-launch-1.0 available", "screenshot")
            else:
                self.record_test("GStreamer", False,
                                "gst-launch-1.0 not found", "screenshot")
        except Exception as e:
            self.record_test("GStreamer", False, str(e), "screenshot")
    
    def _test_gstreamer_pipewiresrc(self):
        """Test GStreamer pipewiresrc plugin."""
        try:
            result = subprocess.run(['gst-inspect-1.0', 'pipewiresrc'],
                                    capture_output=True, timeout=3)
            if result.returncode == 0:
                self.record_test("GStreamer pipewiresrc", True,
                                "Plugin available", "screenshot")
            else:
                self.record_test("GStreamer pipewiresrc", False,
                                "Plugin not installed (needed for Wayland)\n"
                                "FIX: sudo apt install gstreamer1.0-pipewire",
                                "screenshot")
        except FileNotFoundError:
            self.record_test("GStreamer pipewiresrc", False,
                            "gst-inspect-1.0 not found", "screenshot")
        except Exception as e:
            self.record_test("GStreamer pipewiresrc", False, str(e), "screenshot")
    
    def _test_pipewire(self):
        """Test PipeWire daemon status."""
        try:
            result = subprocess.run(['pgrep', '-x', 'pipewire'],
                                    capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                self.record_test("PipeWire daemon", True,
                                f"Running (PID: {result.stdout.strip()})", "screenshot")
            else:
                self.record_test("PipeWire daemon", False,
                                "Not running", "screenshot")
        except Exception as e:
            self.record_test("PipeWire daemon", False, str(e), "screenshot")
    
    def _test_screencast_portal(self):
        """Test ScreenCast Portal availability."""
        try:
            result = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop'
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0:
                has_screencast = 'org.freedesktop.portal.ScreenCast' in result.stdout
                self.record_test("ScreenCast Portal", has_screencast,
                                "Available" if has_screencast else "Interface not found",
                                "screenshot")
            else:
                self.record_test("ScreenCast Portal", False,
                                "Portal daemon not running", "screenshot")
        except Exception as e:
            self.record_test("ScreenCast Portal", False, str(e), "screenshot")
    
    def _test_screenshot_portal(self):
        """Test Screenshot Portal availability."""
        try:
            result = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop'
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0:
                has_screenshot = 'org.freedesktop.portal.Screenshot' in result.stdout
                self.record_test("Screenshot Portal", has_screenshot,
                                "Available" if has_screenshot else "Interface not found",
                                "screenshot")
            else:
                self.record_test("Screenshot Portal", False,
                                "Portal daemon not running", "screenshot")
        except Exception as e:
            self.record_test("Screenshot Portal", False, str(e), "screenshot")
    
    def _test_gnome_screenshot(self):
        """Test gnome-screenshot tool."""
        try:
            result = subprocess.run(['which', 'gnome-screenshot'], capture_output=True)
            self.record_test("gnome-screenshot", result.returncode == 0,
                            "Available" if result.returncode == 0 else "Not installed",
                            "screenshot")
        except Exception as e:
            self.record_test("gnome-screenshot", False, str(e), "screenshot")
    
    def _test_scrot(self):
        """Test scrot tool."""
        try:
            result = subprocess.run(['which', 'scrot'], capture_output=True)
            is_wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
            if result.returncode == 0:
                msg = "Available (WARNING: X11 only)" if is_wayland else "Available"
                self.record_test("scrot", True, msg, "screenshot")
            else:
                self.record_test("scrot", False, "Not installed", "screenshot")
        except Exception as e:
            self.record_test("scrot", False, str(e), "screenshot")
    
    # =========================================================================
    # OS Diagnostics Integration Test
    # =========================================================================
    
    def test_os_diagnostics_module(self):
        """Test the os_diagnostics module."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("OS DIAGNOSTICS MODULE TEST", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        try:
            from os_diagnostics import collect_os_diagnostics, CompatibilityLevel
            
            report = collect_os_diagnostics()
            
            self.record_test("os_diagnostics import", True, "", "integration")
            self.record_test("OS info collection", bool(report.os_info.distro_id), 
                            f"Distro: {report.os_info.distro_name}", "integration")
            self.record_test("Desktop detection", bool(report.desktop.name),
                            f"Desktop: {report.desktop.name} {report.desktop.version}",
                            "integration")
            self.record_test("D-Bus services check", True,
                            f"GNOME Shell: {report.dbus.gnome_shell}, "
                            f"Introspect: {report.dbus.gnome_shell_introspect}",
                            "integration")
            self.record_test("Compatibility assessment", 
                            report.overall_level != CompatibilityLevel.UNKNOWN,
                            f"Window: {report.window_detection_level.value}, "
                            f"Idle: {report.idle_detection_level.value}, "
                            f"Screenshot: {report.screenshot_level.value}",
                            "integration")
            
        except ImportError as e:
            self.record_test("os_diagnostics import", False, str(e), "integration")
        except Exception as e:
            self.record_test("os_diagnostics module", False, str(e), "integration")
    
    # =========================================================================
    # Summary
    # =========================================================================
    
    def generate_summary(self):
        """Generate test summary."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("TEST SUMMARY", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        # Count results by category
        categories = {}
        for test in self.results['tests']:
            cat = test['category']
            if cat not in categories:
                categories[cat] = {'passed': 0, 'failed': 0}
            if test['passed']:
                categories[cat]['passed'] += 1
            else:
                categories[cat]['failed'] += 1
        
        total_passed = sum(c['passed'] for c in categories.values())
        total_failed = sum(c['failed'] for c in categories.values())
        total = total_passed + total_failed
        
        print(f"\n  Total: {total_passed}/{total} tests passed\n")
        
        for cat, counts in categories.items():
            cat_total = counts['passed'] + counts['failed']
            status = colored("✓", Colors.GREEN) if counts['failed'] == 0 else colored("✗", Colors.RED)
            print(f"  {status} {cat}: {counts['passed']}/{cat_total}")
        
        self.results['summary'] = {
            'total_tests': total,
            'passed': total_passed,
            'failed': total_failed,
            'categories': categories
        }
        
        # Overall assessment
        sys_info = self.results['system']
        print(f"\n{colored('-' * 60, Colors.BOLD)}")
        
        if total_failed == 0:
            print(colored("  ✓ FULL COMPATIBILITY", Colors.GREEN))
            print("    All features should work correctly.")
        elif total_failed <= 3:
            print(colored("  ⚠ PARTIAL COMPATIBILITY", Colors.YELLOW))
            print("    Most features will work, some may have issues.")
        else:
            print(colored("  ✗ LIMITED COMPATIBILITY", Colors.RED))
            print("    Several features may not work correctly.")
            print("\n  Recommendations:")
            
            # Generate specific recommendations
            if sys_info.get('gnome_major', 0) >= 45:
                print("    - GNOME 45+: Shell.Eval is disabled by default")
                print("      Consider enabling Development Tools in Settings")
            
            # Check for missing packages
            for test in self.results['tests']:
                if not test['passed'] and 'not installed' in test['details'].lower():
                    print(f"    - Install missing package for: {test['name']}")
    
    def run_all_tests(self) -> Dict[str, Any]:
        """Run all compatibility tests."""
        print(colored("\n╔════════════════════════════════════════════════════════════╗", Colors.CYAN))
        print(colored("║     TIMETRACKER OS COMPATIBILITY TEST SUITE                ║", Colors.CYAN))
        print(colored("╚════════════════════════════════════════════════════════════╝", Colors.CYAN))
        
        self.collect_system_info()
        self.test_window_detection()
        self.test_idle_detection()
        self.test_screenshot_capture()
        self.test_os_diagnostics_module()
        self.generate_summary()
        
        return self.results


def main():
    parser = argparse.ArgumentParser(
        description='TimeTracker OS Compatibility Test Suite'
    )
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Show detailed output')
    parser.add_argument('--json', '-j', metavar='FILE',
                        help='Save results to JSON file')
    
    args = parser.parse_args()
    
    tester = OSCompatibilityTester(verbose=args.verbose)
    results = tester.run_all_tests()
    
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\n  Results saved to: {args.json}")
    
    # Exit code based on results
    if results['summary']['failed'] == 0:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == '__main__':
    main()
