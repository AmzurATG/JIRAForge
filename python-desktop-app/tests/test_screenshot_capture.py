#!/usr/bin/env python3
"""
TimeTracker Screenshot Capture & OCR Pipeline Test

Tests the complete capture → OCR chain to verify OCR fixes work.

Usage:
    python tests/test_screenshot_capture.py
    python tests/test_screenshot_capture.py --verbose
    python tests/test_screenshot_capture.py --json report.json

Exit codes:
    0  = all critical tests pass
    1  = critical failure (screenshot pipeline is broken)
"""

import os
import sys
import json
import time
import argparse
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GREEN = "\033[92m"
RED   = "\033[91m"
YELL  = "\033[93m"
RESET = "\033[0m"


class ScreenshotCaptureTest:
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.results = []
        self.critical_failures = []

    def _record(self, name, passed, details="", critical=False):
        color  = GREEN if passed else RED
        status = "PASS" if passed else "FAIL"
        marker = " [CRITICAL]" if (not passed and critical) else ""
        print(f"  [{color}{status}{RESET}] {name}{marker}")
        if details and (self.verbose or not passed):
            for line in details.strip().splitlines():
                print(f"         {line}")
        self.results.append({"name": name, "passed": passed, "details": details})
        if not passed and critical:
            self.critical_failures.append(name)

    def _is_wayland(self):
        return bool(os.environ.get("WAYLAND_DISPLAY"))

    @staticmethod
    def _is_black(img) -> bool:
        import array as _a
        bands = img.split()
        return not any(max(_a.array("B", b.tobytes())) > 0 for b in bands)

    # ------------------------------------------------------------------
    # Phase 1 - package check + system_check diagnostic
    # ------------------------------------------------------------------

    def test_system_check_diagnostic(self):
        print("\n=== Phase 1: check_gstreamer_pipewire_installable() ===")
        try:
            from system_check import SystemDependencyChecker
        except ImportError:
            self._record("SystemDependencyChecker import", False, "system_check not available")
            return
        chk = SystemDependencyChecker()
        try:
            info = chk.check_gstreamer_pipewire_installable()
        except AttributeError:
            self._record("check_gstreamer_pipewire_installable()", False,
                         "Method not yet added — Phase 1 not done")
            return
        required = {"plugin_installed", "plugin_loadable", "pipewire_running", "action"}
        missing = required - set(info.keys())
        self._record("All required keys present", not missing,
                     details=(f"Missing: {missing}" if missing else
                               f"plugin_installed={info.get('plugin_installed')} "
                               f"loadable={info.get('plugin_loadable')} "
                               f"action={info.get('action')}"))
        valid_actions = {"install", "restart", "ok", "unknown"}
        self._record("action is valid value", info.get("action") in valid_actions,
                     details=f"Got: {info.get('action')}")

    def test_packages(self):
        print("\n=== Phase 1: Package Availability ===")
        try:
            r = subprocess.run(["gst-inspect-1.0", "pipewiresrc"],
                               capture_output=True, timeout=5)
            ok = r.returncode == 0
            self._record("gstreamer1.0-pipewire (pipewiresrc)", ok,
                         details=("" if ok else "Install: sudo apt install gstreamer1.0-pipewire"),
                         critical=self._is_wayland())
        except FileNotFoundError:
            self._record("gstreamer1.0-pipewire (pipewiresrc)", False,
                         "gst-inspect-1.0 not found", critical=self._is_wayland())

        try:
            r = subprocess.run(["pgrep", "-x", "pipewire"], capture_output=True, timeout=3)
            self._record("PipeWire daemon running", r.returncode == 0,
                         details=("" if r.returncode == 0 else
                                  "Start: systemctl --user start pipewire"),
                         critical=self._is_wayland())
        except Exception as e:
            self._record("PipeWire daemon running", False, str(e))

        try:
            r = subprocess.run(
                ["gdbus", "introspect", "--session",
                 "--dest", "org.freedesktop.portal.Desktop",
                 "--object-path", "/org/freedesktop/portal/desktop"],
                capture_output=True, text=True, timeout=5)
            ok = r.returncode == 0 and "org.freedesktop.portal.ScreenCast" in r.stdout
            self._record("XDG ScreenCast portal", ok,
                         details=("" if ok else
                                  "Install: sudo apt install xdg-desktop-portal "
                                  "xdg-desktop-portal-gnome"),
                         critical=self._is_wayland())
        except Exception as e:
            self._record("XDG ScreenCast portal", False, str(e))

    # ------------------------------------------------------------------
    # Phase 2 & 3 - restore token
    # ------------------------------------------------------------------

    def test_restore_token(self):
        print("\n=== Phase 2 & 3: Restore Token ===")
        try:
            from monitor_capture import _load_restore_token, _get_restore_token_file
        except ImportError as e:
            self._record("monitor_capture import", False, str(e), critical=True)
            return

        token_file = _get_restore_token_file()
        exists = os.path.exists(token_file)
        self._record("Restore token file exists", exists,
                     details=(f"Path: {token_file}" if exists else
                               f"Missing: {token_file}\n"
                               "Fix: Start TimeTracker and grant screen sharing permission."))
        if not exists:
            return

        data = _load_restore_token()
        has_tok = bool(data and data.get("restore_token"))
        self._record("restore_token field present", has_tok)
        if not has_tok:
            return
        age = (time.time() - data.get("saved_at", 0)) / 86400
        self._record("Restore token fresh (<30 days)", age < 30,
                     details=f"Age: {age:.1f} days")

    def test_validate_restore_token(self):
        print("\n=== Phase 3: _validate_restore_token() ===")
        try:
            from monitor_capture import _validate_restore_token
        except ImportError:
            self._record("_validate_restore_token()", False,
                         "Function not in monitor_capture — Phase 3 not implemented")
            return

        cases = [
            (None,                                                         False, "None"),
            ({},                                                           False, "empty dict"),
            ({"restore_token": ""},                                        False, "empty string"),
            ({"restore_token": "ab", "saved_at": time.time()},             False, "too short"),
            ({"restore_token": "valid-xyz", "saved_at": time.time()},      True,  "valid fresh"),
            ({"restore_token": "old", "saved_at": time.time()-40*86400},   False, "expired"),
        ]
        all_ok = True
        for data, exp, desc in cases:
            valid, reason = _validate_restore_token(data)
            ok = (valid == exp)
            all_ok = all_ok and ok
            if self.verbose or not ok:
                m = f"{GREEN}OK{RESET}" if ok else f"{RED}FAIL{RESET}"
                print(f"    [{m}] {desc}: exp={exp} got={valid} ({reason})")
        self._record("_validate_restore_token all cases", all_ok)

    # ------------------------------------------------------------------
    # Phase 2 - get_screencast_permission_status()
    # ------------------------------------------------------------------

    def test_permission_status(self):
        print("\n=== Phase 2: get_screencast_permission_status() ===")
        try:
            from monitor_capture import get_screencast_permission_status
        except ImportError:
            self._record("get_screencast_permission_status()", False,
                         "Not in monitor_capture — Phase 2 not implemented")
            return
        status = get_screencast_permission_status()
        required = {"has_token", "token_age_days", "token_valid",
                    "plugin_installed", "portal_available", "status"}
        missing = required - set(status.keys())
        self._record("Required keys present", not missing,
                     details=(f"Missing: {missing}" if missing else ""))
        valid_statuses = {"ready", "needs_permission", "missing_plugin", "no_portal"}
        self._record("status value valid", status.get("status") in valid_statuses,
                     details=f"Got: {status.get('status')}")
        print(f"\n  status={status.get('status')}  plugin={status.get('plugin_installed')}  "
              f"token={status.get('has_token')}  valid={status.get('token_valid')}")

    # ------------------------------------------------------------------
    # Phase 5 - get_capture_health()
    # ------------------------------------------------------------------

    def test_capture_health(self):
        print("\n=== Phase 5: get_capture_health() ===")
        try:
            from monitor_capture import get_capture_health
        except ImportError:
            self._record("get_capture_health()", False,
                         "Not in monitor_capture — Phase 5 not implemented")
            return
        health = get_capture_health()
        required = {"consecutive_black_images", "black_image_duration_minutes",
                    "screencast_available", "restore_token_exists"}
        missing = required - set(health.keys())
        self._record("Required keys present", not missing,
                     details=(f"Missing: {missing}" if missing else
                               f"black_images={health.get('consecutive_black_images')} "
                               f"sc={health.get('screencast_available')}"))
        self._record("consecutive_black_images is int>=0",
                     isinstance(health.get("consecutive_black_images"), int)
                     and health["consecutive_black_images"] >= 0)

    # ------------------------------------------------------------------
    # Live capture
    # ------------------------------------------------------------------

    def test_screencast_capture(self):
        print("\n=== ScreenCast Capture (live) ===")
        try:
            from monitor_capture import _check_screencast_available, _capture_screencast
        except ImportError as e:
            self._record("monitor_capture import", False, str(e), critical=True)
            return

        if not _check_screencast_available():
            self._record("ScreenCast prerequisites met", False,
                         "Plugin/portal unavailable — see Phase 1 tests",
                         critical=self._is_wayland())
            return

        print("  [INFO] Attempting ScreenCast capture (may take up to 30s)…")
        start = time.time()
        img   = _capture_screencast()
        elapsed = time.time() - start

        if img is None:
            self._record("ScreenCast returns image", False,
                         f"None after {elapsed:.1f}s — permission denied or token invalid",
                         critical=True)
            return

        black = self._is_black(img)
        self._record("ScreenCast image not all-black", not black,
                     details=(f"{img.size[0]}x{img.size[1]} in {elapsed:.1f}s"
                               if not black else f"All-black after {elapsed:.1f}s"),
                     critical=black)

    # ------------------------------------------------------------------
    # OCR pipeline
    # ------------------------------------------------------------------

    def test_ocr_pipeline(self):
        print("\n=== OCR Pipeline (end-to-end) ===")
        try:
            from monitor_capture import capture_focused_monitor
        except ImportError as e:
            self._record("capture_focused_monitor import", False, str(e))
            return

        img = capture_focused_monitor()
        if img is None:
            self._record("Screenshot obtained", False,
                         "capture_focused_monitor() returned None — fix Phase 1/2 first",
                         critical=True)
            return
        if self._is_black(img):
            self._record("Screenshot not all-black", False,
                         "All-black image — OCR will fail", critical=True)
            return
        self._record("Screenshot obtained", True, f"{img.size[0]}x{img.size[1]}")

        try:
            from ocr.facade import extract_text_from_image
            result = extract_text_from_image(img)
            text = result.get("text", "") if isinstance(result, dict) else str(result)
            conf = result.get("confidence", 0.0) if isinstance(result, dict) else 0.0
            has_text = bool(text and text.strip())
            self._record("OCR text extracted", has_text or conf > 0,
                         details=f"Confidence: {conf:.2f}  Chars: {len(text or '')}")
        except Exception as e:
            self._record("OCR text extracted", False, f"OCR error: {e}")

    # ------------------------------------------------------------------

    def run_all(self) -> int:
        print("\n╔════════════════════════════════════════════════════════════╗")
        print("║  TIMETRACKER SCREENSHOT CAPTURE & OCR PIPELINE TEST SUITE  ║")
        print("╚════════════════════════════════════════════════════════════╝")
        print(f"\nEnv: {'Wayland' if self._is_wayland() else 'X11'}  "
              f"DISPLAY={os.environ.get('DISPLAY','none')}  "
              f"WAYLAND_DISPLAY={os.environ.get('WAYLAND_DISPLAY','none')}\n")

        self.test_system_check_diagnostic()
        self.test_packages()
        self.test_restore_token()
        self.test_validate_restore_token()
        self.test_permission_status()
        self.test_capture_health()
        self.test_screencast_capture()
        self.test_ocr_pipeline()

        total  = len(self.results)
        passed = sum(1 for r in self.results if r["passed"])
        print(f"\n{'='*60}")
        print(f"  Total: {passed}/{total} tests passed")
        if self.critical_failures:
            print(f"\n  {RED}CRITICAL FAILURES:{RESET}")
            for f in self.critical_failures:
                print(f"    ✗ {f}")
            return 1
        print(f"\n  {GREEN}No critical failures.{RESET}")
        return 0 if passed == total else 2


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--json", metavar="FILE")
    args = ap.parse_args()

    tester = ScreenshotCaptureTest(verbose=args.verbose)
    code   = tester.run_all()

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"results": tester.results,
                       "critical_failures": tester.critical_failures}, f, indent=2)
        print(f"\n  Results saved to {args.json}")

    sys.exit(code)
