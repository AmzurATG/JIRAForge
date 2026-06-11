#!/usr/bin/env python3
"""
Wayland Window Detection Test Suite

Tests all window detection methods on Linux/Wayland to diagnose
the "Unknown" window title issue.

Usage:
    python tests/test_wayland_window_detection.py
    python tests/test_wayland_window_detection.py --save-results
    python tests/test_wayland_window_detection.py --continuous 10  # 10 iterations

Requirements:
    - Linux with Wayland session (GNOME, KDE, etc.)
    - Optional: python3-gi, gir1.2-atspi-2.0, xdotool

Author: TimeTracker Team
Date: 2026-06-11
"""

import os
import sys
import subprocess
import time
import json
import re
import argparse
from datetime import datetime
from typing import Optional, Tuple, Dict, List

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Colors:
    """ANSI color codes for terminal output."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    END = '\033[0m'


def colored(text: str, color: str) -> str:
    """Add color to text if terminal supports it."""
    if sys.stdout.isatty():
        return f"{color}{text}{Colors.END}"
    return text


class WaylandWindowDetectionTests:
    """Comprehensive test suite for Wayland window detection methods."""
    
    def __init__(self, verbose: bool = True):
        self.verbose = verbose
        self.results: List[Dict] = []
        self.is_wayland = self._detect_wayland()
        self.gnome_version = self._get_gnome_version()
        self.kde_version = self._get_kde_version()
        
    def _detect_wayland(self) -> bool:
        """Check if running on Wayland."""
        return bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
    
    def _get_gnome_version(self) -> Optional[str]:
        """Get GNOME Shell version."""
        try:
            result = subprocess.run(
                ['gnome-shell', '--version'],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                match = re.search(r'(\d+)\.(\d+)', result.stdout)
                if match:
                    return f"{match.group(1)}.{match.group(2)}"
        except Exception:
            pass
        return None
    
    def _get_kde_version(self) -> Optional[str]:
        """Get KDE Plasma version."""
        try:
            result = subprocess.run(
                ['plasmashell', '--version'],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                match = re.search(r'(\d+)\.(\d+)', result.stdout)
                if match:
                    return f"{match.group(1)}.{match.group(2)}"
        except Exception:
            pass
        return None
    
    def _log(self, message: str, level: str = "INFO"):
        """Log a message if verbose mode is enabled."""
        if self.verbose:
            prefix = {
                "INFO": colored("ℹ", Colors.BLUE),
                "PASS": colored("✓", Colors.GREEN),
                "FAIL": colored("✗", Colors.RED),
                "WARN": colored("⚠", Colors.YELLOW),
            }.get(level, "")
            print(f"  {prefix} {message}")
    
    def _log_result(self, test_name: str, passed: bool, details: str = "", 
                    method: str = ""):
        """Record and log test result."""
        status = colored("PASS", Colors.GREEN) if passed else colored("FAIL", Colors.RED)
        self.results.append({
            'test': test_name,
            'passed': passed,
            'details': details,
            'method': method,
            'timestamp': datetime.now().isoformat()
        })
        print(f"  [{status}] {test_name}")
        if details and self.verbose:
            print(f"         {details}")
    
    # =========================================================================
    # Environment Detection Tests
    # =========================================================================
    
    def test_environment(self) -> bool:
        """Test and report the current display environment."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: Environment Detection", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        env_info = {
            'WAYLAND_DISPLAY': os.environ.get('WAYLAND_DISPLAY', ''),
            'DISPLAY': os.environ.get('DISPLAY', ''),
            'XDG_SESSION_TYPE': os.environ.get('XDG_SESSION_TYPE', ''),
            'XDG_CURRENT_DESKTOP': os.environ.get('XDG_CURRENT_DESKTOP', ''),
            'DESKTOP_SESSION': os.environ.get('DESKTOP_SESSION', ''),
        }
        
        for key, value in env_info.items():
            self._log(f"{key}: '{value}'")
        
        self._log(f"GNOME Shell: {self.gnome_version or 'N/A'}")
        self._log(f"KDE Plasma: {self.kde_version or 'N/A'}")
        self._log(f"Detected as Wayland: {self.is_wayland}")
        
        self._log_result(
            "Environment Detection",
            True,
            f"Wayland={self.is_wayland}, DE={os.environ.get('XDG_CURRENT_DESKTOP', 'Unknown')}"
        )
        return True
    
    # =========================================================================
    # GNOME Introspect API Tests
    # =========================================================================
    
    def test_introspect_availability(self) -> bool:
        """Test if GNOME Shell Introspect D-Bus interface is available."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: GNOME Introspect API Availability", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        try:
            result = subprocess.run(
                ['gdbus', 'introspect', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell/Introspect'],
                capture_output=True, text=True, timeout=3
            )
            
            api_available = result.returncode == 0
            has_getwindows = 'GetWindows' in result.stdout if api_available else False
            
            self._log(f"D-Bus introspect return code: {result.returncode}")
            self._log(f"Introspect interface: {'Available' if api_available else 'Not available'}")
            self._log(f"GetWindows method: {'Found' if has_getwindows else 'Not found'}")
            
            if result.stderr:
                self._log(f"stderr: {result.stderr[:200]}", "WARN")
            
            passed = api_available and has_getwindows
            self._log_result(
                "Introspect API Availability",
                passed,
                f"Interface={api_available}, GetWindows={has_getwindows}",
                "gnome_introspect"
            )
            return passed
            
        except FileNotFoundError:
            self._log("gdbus command not found", "FAIL")
            self._log_result("Introspect API Availability", False, "gdbus not installed")
            return False
        except subprocess.TimeoutExpired:
            self._log("D-Bus introspect timed out", "FAIL")
            self._log_result("Introspect API Availability", False, "Timeout")
            return False
        except Exception as e:
            self._log(f"Error: {e}", "FAIL")
            self._log_result("Introspect API Availability", False, str(e))
            return False
    
    def test_introspect_getwindows(self) -> Tuple[bool, Optional[Tuple[str, str]]]:
        """Test GetWindows call and parse the focused window."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: Introspect GetWindows Call", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        try:
            start_time = time.time()
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell/Introspect',
                 '--method', 'org.gnome.Shell.Introspect.GetWindows'],
                capture_output=True, text=True, timeout=5
            )
            elapsed = time.time() - start_time
            
            self._log(f"Return code: {result.returncode}")
            self._log(f"Response time: {elapsed:.2f}s")
            self._log(f"Output length: {len(result.stdout)} chars")
            
            if result.returncode != 0:
                self._log(f"stderr: {result.stderr[:300]}", "WARN")
                self._log_result("GetWindows Call", False, 
                               f"rc={result.returncode}", "gnome_introspect")
                return False, None
            
            # Parse the output to find focused window
            stdout = result.stdout
            focused_title = None
            focused_app = None
            window_count = stdout.count("'title':")
            
            self._log(f"Windows found: {window_count}")
            
            # Find focused window
            for title_match in re.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
                title = title_match.group(1)
                ahead_start = title_match.end()
                lookahead = stdout[ahead_start:ahead_start + 500]
                
                focus_match = re.search(r"'has-focus':\s*<\s*(true|false)\s*>", lookahead)
                if focus_match and focus_match.group(1) == 'true':
                    focused_title = title
                    block = stdout[title_match.start():ahead_start + 500]
                    
                    # Try app-id first
                    app_match = re.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                    if app_match:
                        focused_app = app_match.group(1)
                    
                    # Fall back to wm-class
                    if not focused_app:
                        wm_match = re.search(r"'wm-class':\s*<\s*'([^']*)'\s*>", block)
                        focused_app = wm_match.group(1) if wm_match else 'Unknown'
                    
                    break
            
            if focused_title:
                self._log(f"Focused window: '{focused_title}'", "PASS")
                self._log(f"Focused app: '{focused_app}'")
            else:
                self._log("No focused window found in response", "WARN")
                # Print a sample of windows for debugging
                titles = re.findall(r"'title':\s*<\s*'([^']{0,50})'", stdout)[:5]
                if titles:
                    self._log(f"Sample window titles: {titles}")
            
            passed = focused_title is not None and focused_title != ''
            self._log_result(
                "GetWindows Call",
                passed,
                f"Title='{focused_title}', App='{focused_app}'",
                "gnome_introspect"
            )
            
            return passed, (focused_title, focused_app) if passed else None
            
        except subprocess.TimeoutExpired:
            self._log("GetWindows timed out after 5s", "FAIL")
            self._log_result("GetWindows Call", False, "Timeout", "gnome_introspect")
            return False, None
        except Exception as e:
            self._log(f"Error: {e}", "FAIL")
            self._log_result("GetWindows Call", False, str(e), "gnome_introspect")
            return False, None
    
    # =========================================================================
    # Shell.Eval Test
    # =========================================================================
    
    def test_shell_eval(self) -> Tuple[bool, Optional[Tuple[str, str]]]:
        """Test GNOME Shell.Eval API (disabled by default in GNOME 45+)."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: Shell.Eval API", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        try:
            js_code = (
                "let w=global.display.focus_window;"
                "w?(w.title+'|||'+(w.gtk_application_id||w.wm_class||'Unknown'))"
                ":'Unknown|||Unknown'"
            )
            
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell',
                 '--method', 'org.gnome.Shell.Eval', js_code],
                capture_output=True, text=True, timeout=2
            )
            
            self._log(f"Return code: {result.returncode}")
            
            if result.returncode != 0:
                self._log("Shell.Eval is disabled (expected on GNOME 45+)", "WARN")
                self._log("To enable: gsettings set org.gnome.shell development-tools true")
                self._log_result("Shell.Eval", False, 
                               "Disabled (normal for GNOME 45+)", "gdbus")
                return False, None
            
            # Parse: (true, 'Title|||AppName') or (false, '...')
            match = re.search(r"\((true|false),\s*'([^']*)'\)", result.stdout)
            if match:
                success = match.group(1) == 'true'
                raw = match.group(2)
                
                if success and '|||' in raw:
                    title, app = raw.split('|||', 1)
                    self._log(f"Focused title: '{title}'", "PASS")
                    self._log(f"Focused app: '{app}'")
                    self._log_result("Shell.Eval", True, 
                                   f"Title='{title}'", "gdbus")
                    return True, (title, app)
                else:
                    self._log(f"Shell.Eval returned false: {raw}", "WARN")
            else:
                self._log(f"Could not parse response: {result.stdout[:200]}", "WARN")
            
            self._log_result("Shell.Eval", False, "Parse error or no focus", "gdbus")
            return False, None
            
        except subprocess.TimeoutExpired:
            self._log("Shell.Eval timed out", "FAIL")
            self._log_result("Shell.Eval", False, "Timeout", "gdbus")
            return False, None
        except FileNotFoundError:
            self._log("gdbus not found", "FAIL")
            self._log_result("Shell.Eval", False, "gdbus not installed", "gdbus")
            return False, None
        except Exception as e:
            self._log(f"Error: {e}", "FAIL")
            self._log_result("Shell.Eval", False, str(e), "gdbus")
            return False, None
    
    # =========================================================================
    # AT-SPI2 Test
    # =========================================================================
    
    def test_atspi(self) -> Tuple[bool, Optional[Tuple[str, str]]]:
        """Test AT-SPI2 accessibility-based window detection."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: AT-SPI2 Accessibility API", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        # Check AT-SPI2 D-Bus service
        try:
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.a11y.Bus',
                 '--object-path', '/org/a11y/bus',
                 '--method', 'org.a11y.Bus.GetAddress'],
                capture_output=True, text=True, timeout=2
            )
            atspi_bus = result.returncode == 0
            self._log(f"AT-SPI2 bus: {'Running' if atspi_bus else 'Not running'}")
        except Exception:
            atspi_bus = False
            self._log("AT-SPI2 bus: Not available", "WARN")
        
        # Try in-process gi import
        gi_available = False
        focused_window = None
        
        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi
            gi_available = True
            self._log("python3-gi + Atspi: Available (in-process)", "PASS")
            
            # Try to get focused window
            Atspi.init()
            desktop = Atspi.get_desktop(0)
            ACTIVE = Atspi.StateType.ACTIVE
            
            app_count = desktop.get_child_count()
            self._log(f"Desktop apps: {app_count}")
            
            for i in range(app_count):
                app = desktop.get_child_at_index(i)
                if not app:
                    continue
                app_name = app.get_name()
                if app_name == 'gnome-shell':
                    continue
                    
                for j in range(app.get_child_count()):
                    win = app.get_child_at_index(j)
                    if not win:
                        continue
                    try:
                        state_set = win.get_state_set()
                        if state_set and state_set.contains(ACTIVE):
                            title = win.get_name() or ''
                            if title:
                                focused_window = (title, app_name or 'Unknown')
                                break
                    except Exception:
                        continue
                if focused_window:
                    break
                    
        except ImportError as e:
            self._log(f"python3-gi not available: {e}", "WARN")
        except ValueError as e:
            self._log(f"Atspi typelib not found: {e}", "WARN")
        except Exception as e:
            self._log(f"AT-SPI query error: {e}", "WARN")
        
        # Try system Python fallback if gi not available in-process
        # Important: Try both 'python3' and '/usr/bin/python3' for AppImage/venv compatibility
        system_gi = False
        if not gi_available:
            python_paths = ['python3', '/usr/bin/python3']
            for python_path in python_paths:
                try:
                    code = (
                        "import gi\n"
                        "gi.require_version('Atspi','2.0')\n"
                        "from gi.repository import Atspi\n"
                        "print('OK')"
                    )
                    result = subprocess.run(
                        [python_path, '-c', code],
                        capture_output=True, text=True, timeout=3
                    )
                    if result.returncode == 0 and 'OK' in result.stdout:
                        system_gi = True
                        self._log(f"System python ({python_path}): Available", "PASS")
                        
                        # Also try to get focused window via system python
                        detect_code = (
                            "import gi,sys\n"
                            "gi.require_version('Atspi','2.0')\n"
                            "from gi.repository import Atspi\n"
                            "Atspi.init()\n"
                            "d=Atspi.get_desktop(0)\n"
                            "A=Atspi.StateType.ACTIVE\n"
                            "for i in range(d.get_child_count()):\n"
                            " a=d.get_child_at_index(i)\n"
                            " if not a or a.get_name()=='gnome-shell':continue\n"
                            " for j in range(a.get_child_count()):\n"
                            "  w=a.get_child_at_index(j)\n"
                            "  if not w:continue\n"
                            "  try:\n"
                            "   if w.get_state_set().contains(A) and w.get_name():\n"
                            "    print(w.get_name()+'|||'+(a.get_name() or 'Unknown'))\n"
                            "    sys.exit(0)\n"
                            "  except:pass\n"
                        )
                        detect_result = subprocess.run(
                            [python_path, '-c', detect_code],
                            capture_output=True, text=True, timeout=3
                        )
                        if detect_result.returncode == 0 and '|||' in detect_result.stdout:
                            parts = detect_result.stdout.strip().split('|||', 1)
                            focused_window = (parts[0].strip(), parts[1].strip() if len(parts) > 1 else 'Unknown')
                        break
                except Exception as e:
                    self._log(f"System python ({python_path}): Failed - {e}", "WARN")
            
            if not system_gi:
                self._log("System python3 gi: Not available", "WARN")
        
        if focused_window:
            self._log(f"Focused window: '{focused_window[0]}'", "PASS")
            self._log(f"Focused app: '{focused_window[1]}'")
        else:
            self._log("Focused window: Not detected", "WARN")
        
        passed = gi_available or system_gi
        details = f"gi={gi_available}, system={system_gi}"
        if focused_window:
            details += f", title='{focused_window[0]}'"
        
        self._log_result("AT-SPI2", passed, details, "atspi")
        
        if not passed:
            self._log("Install: sudo apt install python3-gi gir1.2-atspi-2.0")
        
        return passed, focused_window
    
    # =========================================================================
    # xdotool Test
    # =========================================================================
    
    def test_xdotool(self) -> Tuple[bool, Optional[Tuple[str, str]]]:
        """Test xdotool for XWayland window detection."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: xdotool (XWayland fallback)", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        try:
            # Check if xdotool is installed
            which_result = subprocess.run(['which', 'xdotool'], 
                                         capture_output=True, timeout=2)
            if which_result.returncode != 0:
                self._log("xdotool not installed", "FAIL")
                self._log("Install: sudo apt install xdotool")
                self._log_result("xdotool", False, "Not installed", "xdotool")
                return False, None
            
            # Get active window ID
            wid_result = subprocess.run(
                ['xdotool', 'getactivewindow'],
                capture_output=True, text=True, timeout=2
            )
            
            if wid_result.returncode != 0:
                self._log("No active XWayland window", "WARN")
                self._log("(Focused app may be native Wayland)")
                self._log_result("xdotool", False, 
                               "No XWayland window focused", "xdotool")
                return False, None
            
            wid = wid_result.stdout.strip()
            self._log(f"Active window ID: {wid}")
            
            # Get window name
            name_result = subprocess.run(
                ['xdotool', 'getwindowname', wid],
                capture_output=True, text=True, timeout=2
            )
            title = name_result.stdout.strip() if name_result.returncode == 0 else 'Unknown'
            self._log(f"Window title: '{title}'")
            
            # Get window PID and process name
            app_name = 'Unknown'
            try:
                pid_result = subprocess.run(
                    ['xdotool', 'getwindowpid', wid],
                    capture_output=True, text=True, timeout=2
                )
                if pid_result.returncode == 0:
                    pid = pid_result.stdout.strip()
                    import psutil
                    proc = psutil.Process(int(pid))
                    app_name = proc.name()
                    self._log(f"Process: {app_name} (PID: {pid})")
            except Exception as e:
                self._log(f"Could not get process: {e}", "WARN")
            
            passed = title and title != 'Unknown' and title != ''
            self._log_result("xdotool", passed, 
                           f"Title='{title}', App='{app_name}'", "xdotool")
            
            return passed, (title, app_name) if passed else None
            
        except FileNotFoundError:
            self._log("xdotool not found", "FAIL")
            self._log_result("xdotool", False, "Not installed", "xdotool")
            return False, None
        except subprocess.TimeoutExpired:
            self._log("xdotool timed out", "FAIL")
            self._log_result("xdotool", False, "Timeout", "xdotool")
            return False, None
        except Exception as e:
            self._log(f"Error: {e}", "FAIL")
            self._log_result("xdotool", False, str(e), "xdotool")
            return False, None
    
    # =========================================================================
    # Full Detection Flow Test
    # =========================================================================
    
    def test_full_detection_flow(self) -> Tuple[bool, Optional[Tuple[str, str]], str]:
        """Test the complete window detection flow as used in the app."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST: Full Detection Flow", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        result = None
        method_used = None
        
        # Method order for Wayland (same as app logic)
        self._log("Testing methods in priority order...")
        
        # 1. gnome_introspect
        self._log("  → Trying gnome_introspect...", "INFO")
        try:
            passed, window = self.test_introspect_getwindows()
            if passed and window and window[0]:
                result = window
                method_used = 'gnome_introspect'
        except Exception as e:
            self._log(f"    Error: {e}", "WARN")
        
        # 2. atspi (if introspect failed)
        if not result:
            self._log("  → Trying atspi...", "INFO")
            try:
                passed, window = self.test_atspi()
                if passed and window and window[0]:
                    result = window
                    method_used = 'atspi'
            except Exception as e:
                self._log(f"    Error: {e}", "WARN")
        
        # 3. gdbus/Shell.Eval (if atspi failed)
        if not result:
            self._log("  → Trying gdbus (Shell.Eval)...", "INFO")
            try:
                passed, window = self.test_shell_eval()
                if passed and window and window[0]:
                    result = window
                    method_used = 'gdbus'
            except Exception as e:
                self._log(f"    Error: {e}", "WARN")
        
        # 4. xdotool (final fallback)
        if not result:
            self._log("  → Trying xdotool...", "INFO")
            try:
                passed, window = self.test_xdotool()
                if passed and window and window[0]:
                    result = window
                    method_used = 'xdotool'
            except Exception as e:
                self._log(f"    Error: {e}", "WARN")
        
        # Result
        print(f"\n{colored('─' * 40, Colors.BOLD)}")
        if result:
            self._log(f"Final result: '{result[0]}' / '{result[1]}'", "PASS")
            self._log(f"Method used: {method_used}")
        else:
            result = ('Unknown', 'Unknown')
            self._log("Final result: ('Unknown', 'Unknown')", "FAIL")
            self._log("All methods failed!")
        
        passed = result[0] != 'Unknown'
        self._log_result(
            "Full Detection Flow",
            passed,
            f"Method={method_used}, Title='{result[0]}'",
            method_used or 'none'
        )
        
        return passed, result, method_used or 'none'
    
    # =========================================================================
    # Run All Tests
    # =========================================================================
    
    def run_all(self) -> bool:
        """Run all tests and print summary."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("WAYLAND WINDOW DETECTION TEST SUITE", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        # Run tests
        self.test_environment()
        self.test_introspect_availability()
        self.test_introspect_getwindows()
        self.test_shell_eval()
        self.test_atspi()
        self.test_xdotool()
        
        # Print summary
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("TEST SUMMARY", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        passed = sum(1 for r in self.results if r['passed'])
        total = len(self.results)
        
        for r in self.results:
            status = colored("✓", Colors.GREEN) if r['passed'] else colored("✗", Colors.RED)
            method = f" [{r['method']}]" if r.get('method') else ""
            print(f"  {status} {r['test']}{method}: {r['details']}")
        
        pass_rate = (passed / total * 100) if total > 0 else 0
        color = Colors.GREEN if pass_rate >= 70 else Colors.YELLOW if pass_rate >= 40 else Colors.RED
        print(f"\n  Total: {colored(f'{passed}/{total}', color)} tests passed ({pass_rate:.0f}%)")
        
        # Recommendations
        self._print_recommendations()
        
        return passed == total
    
    def _print_recommendations(self):
        """Print recommendations based on test results."""
        print(f"\n{colored('═' * 60, Colors.BOLD)}")
        print(colored("RECOMMENDATIONS", Colors.BOLD))
        print(colored("═" * 60, Colors.BOLD))
        
        introspect_ok = any(r['test'] == 'GetWindows Call' and r['passed'] 
                          for r in self.results)
        atspi_ok = any(r['test'] == 'AT-SPI2' and r['passed'] 
                      for r in self.results)
        gdbus_ok = any(r['test'] == 'Shell.Eval' and r['passed'] 
                      for r in self.results)
        xdotool_ok = any(r['test'] == 'xdotool' and r['passed'] 
                        for r in self.results)
        
        if introspect_ok:
            print(colored("  ✓ gnome_introspect is working (preferred method)", Colors.GREEN))
        else:
            print(colored("  ✗ gnome_introspect is NOT working", Colors.RED))
            print("    → Check GNOME Shell version compatibility")
            print("    → Verify D-Bus session is accessible")
        
        if atspi_ok:
            print(colored("  ✓ AT-SPI2 available as fallback", Colors.GREEN))
        else:
            print(colored("  ⚠ AT-SPI2 not available", Colors.YELLOW))
            print("    → Install: sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core")
            print("    → Enable accessibility: gsettings set org.gnome.desktop.interface toolkit-accessibility true")
        
        if not gdbus_ok and self.gnome_version:
            major = int(self.gnome_version.split('.')[0]) if self.gnome_version else 0
            if major >= 45:
                print(colored("  ℹ Shell.Eval disabled (normal for GNOME 45+)", Colors.BLUE))
            else:
                print(colored("  ⚠ Shell.Eval not working", Colors.YELLOW))
            print("    → To enable: gsettings set org.gnome.shell development-tools true")
        
        if xdotool_ok:
            print(colored("  ✓ xdotool works for XWayland apps", Colors.GREEN))
        else:
            print(colored("  ⚠ xdotool not working (may have no XWayland focus)", Colors.YELLOW))
            print("    → Install: sudo apt install xdotool")
        
        print()
    
    def save_results(self, filepath: Optional[str] = None):
        """Save results to JSON file."""
        if filepath is None:
            filepath = f"wayland_test_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        data = {
            'timestamp': datetime.now().isoformat(),
            'environment': {
                'is_wayland': self.is_wayland,
                'gnome_version': self.gnome_version,
                'kde_version': self.kde_version,
                'wayland_display': os.environ.get('WAYLAND_DISPLAY', ''),
                'xdg_session_type': os.environ.get('XDG_SESSION_TYPE', ''),
                'xdg_current_desktop': os.environ.get('XDG_CURRENT_DESKTOP', ''),
            },
            'results': self.results,
            'summary': {
                'total': len(self.results),
                'passed': sum(1 for r in self.results if r['passed']),
                'failed': sum(1 for r in self.results if not r['passed']),
            }
        }
        
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
        
        print(f"\n{colored('Results saved to:', Colors.BLUE)} {filepath}")
        return filepath


def run_continuous_test(iterations: int = 10, interval: float = 2.0):
    """Run continuous detection tests to see if results change."""
    print(f"\n{colored('═' * 60, Colors.BOLD)}")
    print(colored(f"CONTINUOUS TEST ({iterations} iterations, {interval}s interval)", Colors.BOLD))
    print(colored("═" * 60, Colors.BOLD))
    print("Switch between different windows during the test")
    print("Press Ctrl+C to stop\n")
    
    results = []
    try:
        for i in range(iterations):
            tests = WaylandWindowDetectionTests(verbose=False)
            passed, window, method = tests.test_full_detection_flow()
            
            title = window[0] if window else 'Unknown'
            app = window[1] if window else 'Unknown'
            
            status = colored("✓", Colors.GREEN) if passed else colored("✗", Colors.RED)
            print(f"  [{i+1:2d}] {status} [{method:18s}] {title[:40]:<40} | {app}")
            
            results.append({
                'iteration': i + 1,
                'passed': passed,
                'method': method,
                'title': title,
                'app': app,
                'timestamp': datetime.now().isoformat()
            })
            
            if i < iterations - 1:
                time.sleep(interval)
                
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
    
    # Summary
    print(f"\n{colored('─' * 60, Colors.BOLD)}")
    successful = sum(1 for r in results if r['passed'])
    print(f"Results: {successful}/{len(results)} successful detections")
    
    # Method breakdown
    methods = {}
    for r in results:
        m = r['method']
        if m not in methods:
            methods[m] = {'success': 0, 'fail': 0}
        if r['passed']:
            methods[m]['success'] += 1
        else:
            methods[m]['fail'] += 1
    
    print("\nMethod breakdown:")
    for method, counts in methods.items():
        total = counts['success'] + counts['fail']
        rate = counts['success'] / total * 100 if total > 0 else 0
        print(f"  {method}: {counts['success']}/{total} ({rate:.0f}%)")
    
    return results


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Wayland Window Detection Test Suite',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python test_wayland_window_detection.py           # Run all tests
  python test_wayland_window_detection.py --save    # Save results to JSON
  python test_wayland_window_detection.py -c 20     # Continuous test (20 iterations)
  python test_wayland_window_detection.py -q        # Quiet mode (less output)
        """
    )
    parser.add_argument('-s', '--save', action='store_true',
                       help='Save results to JSON file')
    parser.add_argument('-c', '--continuous', type=int, metavar='N',
                       help='Run continuous test with N iterations')
    parser.add_argument('-i', '--interval', type=float, default=2.0,
                       help='Interval between continuous tests (default: 2.0s)')
    parser.add_argument('-q', '--quiet', action='store_true',
                       help='Quiet mode (less verbose output)')
    parser.add_argument('-o', '--output', type=str,
                       help='Output file for results (with --save)')
    
    args = parser.parse_args()
    
    if args.continuous:
        results = run_continuous_test(args.continuous, args.interval)
        if args.save:
            filepath = args.output or f"wayland_continuous_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            with open(filepath, 'w') as f:
                json.dump(results, f, indent=2)
            print(f"Results saved to: {filepath}")
    else:
        tests = WaylandWindowDetectionTests(verbose=not args.quiet)
        tests.run_all()
        if args.save:
            tests.save_results(args.output)


if __name__ == '__main__':
    main()
