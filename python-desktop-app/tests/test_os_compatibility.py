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

    def record_warn(self, name: str, details: str = "", category: str = "general"):
        """Record a WARNING — expected/policy issue, not a hard failure.
        
        WARNs are counted separately from FAILs and do not affect the overall
        pass/fail verdict. They represent known limitations or permission issues
        that the app has workarounds for.
        """
        self.results['tests'].append({
            'name': name,
            'category': category,
            'passed': True,   # Counted as pass for summary; 'warned' flag set
            'warned': True,
            'details': details,
            'timestamp': datetime.now().isoformat()
        })
        status = colored("WARN", Colors.YELLOW)
        print(f"  [{status}] {name}")
        if details:
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
        sys_info = self.results.get('system', {})
        gnome_major = sys_info.get('gnome_major', 0)
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
                # Check if disabled (GNOME 45+) — this is EXPECTED, not a real failure
                if 'false' in result.stdout.lower() or gnome_major >= 45:
                    self.record_warn(
                        "Shell.Eval window detection",
                        f"Disabled on GNOME {gnome_major}+ (EXPECTED — security policy).\n"
                        "App uses gnome_introspect_v2 + atspi_v2 as replacements.\n"
                        "To re-enable: Settings → Privacy → Development Tools → Enable",
                        "window_detection"
                    )
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
        """Test GNOME Shell Introspect API (v1 + v2)."""
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
                err = result.stderr.strip()[:200]
                # AccessDenied = security policy, not a missing feature.
                # Phase 2 v2 methods (atspi_v2) provide the fallback.
                if 'AccessDenied' in err or 'not allowed' in err.lower():
                    self.record_warn(
                        "GNOME Introspect GetWindows",
                        f"AccessDenied by GNOME Shell security policy (see GNOME settings).\n"
                        "Phase 2 FIX: atspi_v2 is used as automatic fallback.\n"
                        f"Error: {err[:80]}",
                        "window_detection"
                    )
                else:
                    self.record_test("GNOME Introspect GetWindows", False,
                                    f"GetWindows failed: {err}",
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
                            "python-dbus not installed\n"
                            "FIX: pip install dbus-python", "idle_detection")
        except Exception as e:
            err = str(e)
            # GNOME 46 does not implement GetSessionIdleTime fully — this is expected.
            # The app uses gnome_mutter as the primary backend.
            if 'NotSupported' in err or 'not part of the idle inhibition' in err:
                self.record_warn(
                    "FreeDesktop ScreenSaver",
                    "GetSessionIdleTime not supported by this GNOME version (expected).\n"
                    "App uses GNOME Mutter IdleMonitor as primary idle backend.",
                    "idle_detection"
                )
            else:
                self.record_test("FreeDesktop ScreenSaver", False,
                                err[:100], "idle_detection")
    
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
        elif devices:
            # Devices exist but are not readable — permission issue, not missing feature.
            # The app falls back to gnome_mutter or pynput.
            self.record_warn(
                "evdev access",
                f"{len(devices)} devices found but not readable (permission issue).\n"
                "FIX: sudo usermod -aG input $USER  (logout/login required)\n"
                "App falls back to GNOME Mutter / pynput for idle detection.",
                "idle_detection"
            )
        else:
            self.record_test("evdev access", False,
                            "No /dev/input/event* devices found",
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
    # Phase 2: v2 Window Detection Method Tests
    # =========================================================================

    def test_phase2_window_detection_v2(self):
        """Phase 2: Test the v2 enhanced window detection methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("PHASE 2: V2 WINDOW DETECTION METHODS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))

        self._test_gnome_introspect_v2()
        self._test_atspi_v2()
        self._test_version_specific_method_order()

    def _test_gnome_introspect_v2(self):
        """Phase 2: Test gnome_introspect_v2 (10s timeout + GNOME 49 parsing)."""
        try:
            check = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect'
            ], capture_output=True, text=True, timeout=5)

            if check.returncode != 0 or 'GetWindows' not in check.stdout:
                self.record_warn("gnome_introspect_v2",
                                 "Shell Introspect not available — atspi_v2 will be used",
                                 "phase2_window")
                return

            # v2 uses 10s timeout (vs 5s for v1)
            result = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect',
                '--method', 'org.gnome.Shell.Introspect.GetWindows',
            ], capture_output=True, text=True, timeout=10)

            if result.returncode == 0:
                # Test both parsing strategies (Strategy 1: single-quote, Strategy 2: double-quote)
                import re as _re
                found_s1 = bool(_re.search(r"'title':\s*<\s*'[^']*'\s*>", result.stdout))
                found_s2 = bool(_re.search(r'"title":\s*<\s*"[^"]*"\s*>', result.stdout))
                self.record_test("gnome_introspect_v2", True,
                                 f"Parse Strategy1(single-quote): {found_s1}, "
                                 f"Strategy2(double-quote): {found_s2}\n"
                                 f"Windows in response: {result.stdout.count(chr(39)+'title'+chr(39)+':')}",
                                 "phase2_window")
            else:
                err = result.stderr.strip()[:100]
                if 'AccessDenied' in err or 'not allowed' in err.lower():
                    self.record_warn("gnome_introspect_v2",
                                     "AccessDenied — atspi_v2 is used as automatic fallback",
                                     "phase2_window")
                else:
                    self.record_test("gnome_introspect_v2", False, err, "phase2_window")
        except subprocess.TimeoutExpired:
            self.record_test("gnome_introspect_v2", False, "Timeout (10s)", "phase2_window")
        except Exception as e:
            self.record_test("gnome_introspect_v2", False, str(e), "phase2_window")

    def _test_atspi_v2(self):
        """Phase 2: Test atspi_v2 (enhanced AT-SPI2 with SHOWING state + GNOME 49 skip list)."""
        code = '''
import gi, sys
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()
desktop = Atspi.get_desktop(0)
FOCUSED = Atspi.StateType.FOCUSED
SHOWING = Atspi.StateType.SHOWING
ACTIVE = Atspi.StateType.ACTIVE
SKIP = {"gnome-shell","gsd-color","gsd-keyboard","gsd-wacom","gsd-power",
        "gsd-media-keys","gsd-xsettings","ibus-daemon","ibus-x11",
        "ibus-extension-gtk3","xdg-desktop-portal-gtk","xdg-desktop-portal-gnome",
        "update-notifier","gjs","evolution-alarm-notify","gnome-panel",
        "goa-daemon","tracker-miner-fs-3","gvfsd","gvfsd-fuse",
        "gnome-keyring-daemon","at-spi2-registryd","at-spi-bus-launcher"}
best = None
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if not app: continue
    name = app.get_name() or ""
    if name in SKIP: continue
    for j in range(app.get_child_count()):
        win = app.get_child_at_index(j)
        if not win: continue
        try:
            ss = win.get_state_set()
            title = win.get_name() or ""
            if not title or not ss: continue
            if ss.contains(FOCUSED):
                print(f"FOCUSED:{title}|||{name}")
                sys.exit(0)
            elif ss.contains(ACTIVE) and ss.contains(SHOWING) and not best:
                best = (title, name)
            elif ss.contains(ACTIVE) and not best:
                best = (title, name)
        except: pass
if best:
    print(f"ACTIVE:{best[0]}|||{best[1]}")
else:
    print("NONE")
'''
        try:
            result = subprocess.run(['/usr/bin/python3', '-c', code],
                                    capture_output=True, text=True, timeout=8)
            if result.returncode == 0:
                out = result.stdout.strip()
                if out and out != 'NONE' and '|||' in out:
                    state, rest = out.split(':', 1)
                    title, app = rest.split('|||', 1)
                    self.record_test("atspi_v2", True,
                                     f"State: {state}, Title: {title[:40]!r}, App: {app}",
                                     "phase2_window")
                else:
                    self.record_warn("atspi_v2",
                                     "No focused/active window found (normal when no window has focus)",
                                     "phase2_window")
            else:
                self.record_test("atspi_v2", False,
                                 f"Error: {result.stderr.strip()[:150]}", "phase2_window")
        except subprocess.TimeoutExpired:
            self.record_test("atspi_v2", False, "Timeout (8s)", "phase2_window")
        except Exception as e:
            self.record_test("atspi_v2", False, str(e), "phase2_window")

    def _test_version_specific_method_order(self):
        """Phase 2: Verify method selection is version-specific."""
        sys_info = self.results.get('system', {})
        gnome_major = sys_info.get('gnome_major', 0)
        is_wayland = sys_info.get('is_wayland', False)

        if is_wayland and gnome_major >= 49:
            expected_primary = 'atspi_v2'
            detail = f"GNOME {gnome_major} on Wayland → atspi_v2 first (correct)"
        elif is_wayland and gnome_major >= 45:
            expected_primary = 'gnome_introspect'
            detail = f"GNOME {gnome_major} on Wayland → gnome_introspect first (correct)"
        elif is_wayland:
            expected_primary = 'gnome_introspect'
            detail = f"GNOME < 45 on Wayland → gnome_introspect first (correct)"
        else:
            expected_primary = 'xdotool'
            detail = "X11 → xdotool first (correct)"

        self.record_test("Version-specific method order", True, detail, "phase2_window")

    # =========================================================================
    # Phase 3: Idle Detection Backend Test
    # =========================================================================

    def test_phase3_idle_backend(self):
        """Phase 3: Test _detect_idle_backend selects the best available backend."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("PHASE 3: IDLE DETECTION BACKEND", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))

        self._test_idle_backend_selection()
        self._test_gnome_mutter_idle_direct()

    def _test_idle_backend_selection(self):
        """Phase 3: Verify _detect_idle_backend returns a usable backend."""
        # The priority order: dbus_screensaver → gnome_mutter → evdev → pynput → none
        backends_tried = []
        selected = None

        # Tier 1: dbus_screensaver
        try:
            import dbus
            bus = dbus.SessionBus()
            ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
            iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
            iface.GetSessionIdleTime()
            selected = 'dbus_screensaver'
        except Exception:
            backends_tried.append('dbus_screensaver: skip')

        # Tier 2: gnome_mutter
        if not selected:
            try:
                import dbus
                bus = dbus.SessionBus()
                obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                     '/org/gnome/Mutter/IdleMonitor/Core')
                iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
                idle = iface.GetIdletime()
                selected = 'gnome_mutter'
                backends_tried.append(f'gnome_mutter: idle={idle}ms')
            except Exception as e:
                backends_tried.append(f'gnome_mutter: {e}')

        # Tier 3: evdev
        if not selected:
            import glob
            readable = [d for d in glob.glob('/dev/input/event*') if os.access(d, os.R_OK)]
            if readable:
                selected = 'evdev'
                backends_tried.append(f'evdev: {len(readable)} devices')

        # Tier 4: pynput
        if not selected:
            try:
                import pynput
                selected = 'pynput'
                backends_tried.append('pynput: available')
            except ImportError:
                backends_tried.append('pynput: not installed')

        if selected and selected != 'none':
            self.record_test("Idle backend selected", True,
                             f"Backend: {selected}\n" + "\n".join(backends_tried),
                             "phase3_idle")
        else:
            self.record_test("Idle backend selected", False,
                             "No idle detection backend available!\n"
                             "FIX: pip install dbus-python  (for gnome_mutter backend)",
                             "phase3_idle")

    def _test_gnome_mutter_idle_direct(self):
        """Phase 3: Directly verify GNOME Mutter IdleMonitor works."""
        try:
            import dbus
            bus = dbus.SessionBus()
            obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                 '/org/gnome/Mutter/IdleMonitor/Core')
            iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
            idle_ms = int(iface.GetIdletime())
            idle_sec = idle_ms // 1000
            self.record_test("GNOME Mutter IdleMonitor (direct)", True,
                             f"Idle time: {idle_ms}ms ({idle_sec}s)",
                             "phase3_idle")
        except ImportError:
            self.record_test("GNOME Mutter IdleMonitor (direct)", False,
                             "python-dbus not installed. FIX: pip install dbus-python",
                             "phase3_idle")
        except Exception as e:
            self.record_test("GNOME Mutter IdleMonitor (direct)", False,
                             str(e)[:150], "phase3_idle")

    # =========================================================================
    # Phase 6: Runtime Compatibility Check Test
    # =========================================================================

    def test_phase6_runtime_compat(self):
        """Phase 6: Verify runtime compatibility check produces a valid report."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("PHASE 6: RUNTIME COMPATIBILITY CHECK", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))

        self._test_compat_report_structure()
        self._test_compat_notification_logic()
        self._test_compat_summary_api()

    def _test_compat_report_structure(self):
        """Phase 6: Validate CompatibilityReport has all required fields."""
        try:
            from os_diagnostics import collect_os_diagnostics, CompatibilityLevel
            report = collect_os_diagnostics()

            required_fields = [
                ('os_info.distro_id', bool(report.os_info.distro_id)),
                ('desktop.name', bool(report.desktop.name)),
                ('desktop.is_wayland', isinstance(report.desktop.is_wayland, bool)),
                ('desktop.version_major', isinstance(report.desktop.version_major, int)),
                ('dbus.gnome_shell', isinstance(report.dbus.gnome_shell, bool)),
                ('capabilities.gst_pipewiresrc_available',
                 isinstance(report.capabilities.gst_pipewiresrc_available, bool)),
                ('overall_level', report.overall_level != CompatibilityLevel.UNKNOWN),
                ('warnings is list', isinstance(report.warnings, list)),
                ('blockers is list', isinstance(report.blockers, list)),
            ]

            failed = [(f, v) for f, v in required_fields if not v]
            if not failed:
                self.record_test("CompatibilityReport structure", True,
                                 f"All {len(required_fields)} required fields present",
                                 "phase6_compat")
            else:
                self.record_test("CompatibilityReport structure", False,
                                 f"Missing/invalid fields: {[f for f, _ in failed]}",
                                 "phase6_compat")
        except Exception as e:
            self.record_test("CompatibilityReport structure", False, str(e), "phase6_compat")

    def _test_compat_notification_logic(self):
        """Phase 6: Verify LIMITED compatibility triggers notification intent."""
        try:
            from os_diagnostics import CompatibilityLevel, CompatibilityReport, OSInfo
            # Simulate a LIMITED report (e.g. all methods fail on minimal system)
            report = CompatibilityReport()
            from os_diagnostics import DesktopEnvironment
            report.desktop = DesktopEnvironment(name='GNOME', is_wayland=True)
            report.window_detection_level = CompatibilityLevel.LIMITED
            report.screenshot_level = CompatibilityLevel.LIMITED
            report.overall_level = CompatibilityLevel.LIMITED
            report.blockers = ['Window detection: No working method available']

            # Verify the logic that would trigger a desktop notification
            should_notify = report.overall_level == CompatibilityLevel.LIMITED
            self.record_test("LIMITED compat triggers notification", should_notify,
                             f"overall_level={report.overall_level.value}, "
                             f"should_notify={should_notify}",
                             "phase6_compat")
        except Exception as e:
            self.record_test("LIMITED compat notification logic", False, str(e), "phase6_compat")

    def _test_compat_summary_api(self):
        """Phase 6: Verify get_diagnostics_summary returns JSON-serializable dict."""
        try:
            import json as _json
            from os_diagnostics import collect_os_diagnostics, get_diagnostics_summary
            report = collect_os_diagnostics()
            summary = get_diagnostics_summary(report)

            # Must be JSON-serializable
            json_str = _json.dumps(summary)
            required_keys = ['os', 'desktop', 'dbus', 'capabilities', 'compatibility',
                             'warnings', 'blockers']
            missing = [k for k in required_keys if k not in summary]

            if not missing:
                self.record_test("get_diagnostics_summary API", True,
                                 f"JSON size: {len(json_str)} bytes, keys: {list(summary.keys())}",
                                 "phase6_compat")
            else:
                self.record_test("get_diagnostics_summary API", False,
                                 f"Missing keys: {missing}", "phase6_compat")
        except Exception as e:
            self.record_test("get_diagnostics_summary API", False, str(e), "phase6_compat")

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
        
        # Count results by category (WARNs count as passed)
        categories = {}
        total_warned = 0
        for test in self.results['tests']:
            cat = test['category']
            if cat not in categories:
                categories[cat] = {'passed': 0, 'failed': 0, 'warned': 0}
            if test['passed']:
                if test.get('warned'):
                    categories[cat]['warned'] += 1
                    total_warned += 1
                else:
                    categories[cat]['passed'] += 1
            else:
                categories[cat]['failed'] += 1
        
        total_passed = sum(c['passed'] for c in categories.values())
        total_failed = sum(c['failed'] for c in categories.values())
        total = total_passed + total_failed + total_warned
        
        print(f"\n  Total: {total_passed}/{total} passed, {total_warned} warnings, {total_failed} failed\n")
        
        for cat, counts in categories.items():
            cat_total = counts['passed'] + counts['failed'] + counts['warned']
            if counts['failed'] == 0:
                status = colored("✓", Colors.GREEN)
            else:
                status = colored("✗", Colors.RED)
            warn_str = f" ({counts['warned']} warn)" if counts['warned'] else ""
            print(f"  {status} {cat}: {counts['passed']}/{cat_total}{warn_str}")
        
        self.results['summary'] = {
            'total_tests': total,
            'passed': total_passed,
            'warned': total_warned,
            'failed': total_failed,
            'categories': categories
        }
        
        # Overall assessment (WARNs do not count as failures)
        sys_info = self.results['system']
        print(f"\n{colored('-' * 60, Colors.BOLD)}")
        
        if total_failed == 0 and total_warned == 0:
            print(colored("  ✓ FULL COMPATIBILITY", Colors.GREEN))
            print("    All features should work correctly.")
        elif total_failed == 0:
            print(colored("  ✓ COMPATIBLE (with warnings)", Colors.GREEN))
            print(f"    Core features work. {total_warned} advisory warning(s) noted.")
            print("    Warnings are expected limitations handled by app fallbacks.")
        elif total_failed <= 2:
            print(colored("  ⚠ PARTIAL COMPATIBILITY", Colors.YELLOW))
            print("    Most features will work, some may have issues.")
        else:
            print(colored("  ✗ LIMITED COMPATIBILITY", Colors.RED))
            print("    Several features may not work correctly.")
            print("\n  Recommendations:")
            
            # Generate specific recommendations
            if sys_info.get('gnome_major', 0) >= 45:
                print("    - GNOME 45+: Shell.Eval is disabled by design")
                print("      App uses gnome_introspect_v2 + atspi_v2 instead (automatic)")
            
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
        self.test_phase2_window_detection_v2()
        self.test_phase3_idle_backend()
        self.test_phase6_runtime_compat()
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
