#!/usr/bin/env python3
"""
ScreenCast Permission Onboarding Test

Tests the Phase 2 & 3 functions added to monitor_capture.py:
  - _validate_restore_token()
  - get_screencast_permission_status()
  - request_screencast_permission()   (dry-run only; --request-permission for real)
  - get_capture_health()
  - _record_black_image() / _reset_black_image_counter()

Usage:
    python tests/test_screencast_permission.py
    python tests/test_screencast_permission.py --request-permission  # shows real dialog
    python tests/test_screencast_permission.py --timeout 30
"""

import os
import sys
import time
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

GREEN = "\033[92m"
RED   = "\033[91m"
RESET = "\033[0m"

PASS_STR = f"[{GREEN}PASS{RESET}]"
FAIL_STR = f"[{RED}FAIL{RESET}]"
SKIP_STR = f"[{RESET}SKIP{RESET}]"


def check(name, condition, details=""):
    st = PASS_STR if condition else FAIL_STR
    print(f"  {st} {name}")
    if details:
        print(f"         {details}")
    return condition


def skip(name, reason=""):
    print(f"  {SKIP_STR} {name}" + (f" — {reason}" if reason else ""))


# ---------------------------------------------------------------------------
# Test 1: Token round-trip
# ---------------------------------------------------------------------------

def test_token_roundtrip():
    print("\n=== Token File Round-Trip ===")
    try:
        from monitor_capture import (
            _save_restore_token, _load_restore_token,
            _clear_restore_token, _get_restore_token_file,
        )
    except ImportError as e:
        skip("Token round-trip", f"import failed: {e}")
        return

    _clear_restore_token()
    check("Clear: file absent after clear",
          not os.path.exists(_get_restore_token_file()))

    ok = _save_restore_token("test-abc-123456", session_handle="/test/handle", node_id=42)
    check("save_restore_token returns True", ok is True)
    check("Token file created", os.path.exists(_get_restore_token_file()))

    data = _load_restore_token()
    check("load returns dict",   isinstance(data, dict))
    check("restore_token field", data and data.get("restore_token") == "test-abc-123456",
          f"got: {data.get('restore_token') if data else None}")
    check("node_id preserved",   data and data.get("node_id") == 42)
    check("saved_at present",    data and "saved_at" in data)

    _clear_restore_token()
    check("Clear: file removed", not os.path.exists(_get_restore_token_file()))


# ---------------------------------------------------------------------------
# Test 2: _validate_restore_token edge cases
# ---------------------------------------------------------------------------

def test_validate_restore_token():
    print("\n=== _validate_restore_token() ===")
    try:
        from monitor_capture import _validate_restore_token
    except ImportError:
        skip("_validate_restore_token", "Phase 3 not implemented yet")
        return

    cases = [
        (None,                                                              False, "None input"),
        ({},                                                                False, "empty dict"),
        ({"restore_token": ""},                                             False, "empty string"),
        ({"restore_token": "ab", "saved_at": time.time()},                  False, "too short"),
        ({"restore_token": "valid-xyz-1234", "saved_at": time.time()},      True,  "valid fresh token"),
        ({"restore_token": "old-tok-xyz", "saved_at": time.time()-31*86400},False, "31-day-old expired"),
        ({"restore_token": "missing-ts"},                                   False, "no saved_at"),
    ]
    all_ok = True
    for data, exp, desc in cases:
        valid, reason = _validate_restore_token(data)
        ok = (valid == exp)
        all_ok = all_ok and ok
        print(f"    [{GREEN if ok else RED}{'OK' if ok else 'FAIL'}{RESET}] "
              f"{desc}: exp={exp} got={valid} ({reason})")
    check("All validation cases correct", all_ok)


# ---------------------------------------------------------------------------
# Test 3: get_screencast_permission_status()
# ---------------------------------------------------------------------------

def test_permission_status():
    print("\n=== get_screencast_permission_status() ===")
    try:
        from monitor_capture import get_screencast_permission_status
    except ImportError:
        skip("get_screencast_permission_status", "Phase 2 not implemented yet")
        return

    status = get_screencast_permission_status()
    required = {"has_token", "token_age_days", "token_valid",
                "plugin_installed", "portal_available", "status"}
    missing = required - set(status.keys())
    check("All required keys present", not missing,
          f"Missing: {missing}" if missing else "")

    valid_statuses = {"ready", "needs_permission", "missing_plugin", "no_portal"}
    check("status value is valid", status.get("status") in valid_statuses,
          f"Got: {status.get('status')}")
    check("plugin_installed is bool", isinstance(status.get("plugin_installed"), bool))
    check("has_token is bool",       isinstance(status.get("has_token"), bool))
    check("portal_available is bool",isinstance(status.get("portal_available"), bool))

    print(f"\n  Current status  : {status.get('status')}")
    print(f"  Plugin installed: {status.get('plugin_installed')}")
    print(f"  Has token       : {status.get('has_token')}")
    if status.get("token_age_days") is not None:
        print(f"  Token age       : {status['token_age_days']:.1f} days")


# ---------------------------------------------------------------------------
# Test 4: get_capture_health()
# ---------------------------------------------------------------------------

def test_capture_health():
    print("\n=== get_capture_health() + black-image counter ===")
    try:
        from monitor_capture import (
            get_capture_health,
            _record_black_image,
            _reset_black_image_counter,
        )
    except ImportError:
        skip("get_capture_health", "Phase 5 not implemented yet")
        return

    # Reset first
    _reset_black_image_counter()
    h = get_capture_health()
    check("counter starts at 0 after reset",
          h.get("consecutive_black_images") == 0)
    check("duration is 0 after reset",
          h.get("black_image_duration_minutes") == 0.0)

    # Record two black images
    _record_black_image()
    _record_black_image()
    h = get_capture_health()
    check("counter=2 after 2 records",
          h.get("consecutive_black_images") == 2,
          f"Got: {h.get('consecutive_black_images')}")
    check("duration > 0 after records",
          h.get("black_image_duration_minutes") >= 0.0)

    # Reset
    _reset_black_image_counter()
    h = get_capture_health()
    check("counter reset to 0", h.get("consecutive_black_images") == 0)

    required = {"consecutive_black_images", "black_image_duration_minutes",
                "screencast_available", "restore_token_exists"}
    missing = required - set(h.keys())
    check("All required keys present", not missing,
          f"Missing: {missing}" if missing else "")


# ---------------------------------------------------------------------------
# Test 5: request_screencast_permission — dry run (no dialog)
# ---------------------------------------------------------------------------

def test_request_permission_dry_run():
    print("\n=== request_screencast_permission (dry-run) ===")
    try:
        from monitor_capture import request_screencast_permission, _check_screencast_available
    except ImportError:
        skip("request_screencast_permission", "Phase 2 not implemented yet")
        return

    plugin_ok = _check_screencast_available()
    if not plugin_ok:
        # Plugin missing — function should return immediately with error, no dialog
        result = request_screencast_permission(timeout_seconds=5)
        check("Returns dict",       isinstance(result, dict))
        check("granted=False",      result.get("granted") is False)
        check("error message set",  bool(result.get("error")))
        check("already_had=False",  result.get("already_had_permission") is False)
        print(f"  Error: {result.get('error')}")
    else:
        print("  [INFO] Plugin is installed — skipping dry-run to avoid triggering dialog")
        print("         Run with --request-permission to test the real consent flow")


# ---------------------------------------------------------------------------
# Test 6: request_screencast_permission — real dialog (opt-in)
# ---------------------------------------------------------------------------

def test_request_permission_real(timeout=60):
    print(f"\n=== request_screencast_permission (REAL — dialog will appear, timeout={timeout}s) ===")
    try:
        from monitor_capture import request_screencast_permission
    except ImportError:
        skip("request_screencast_permission real", "Phase 2 not implemented yet")
        return

    print("  [INFO] Watch your screen — the GNOME screen sharing dialog should appear.")
    print("  [INFO] Click 'Allow' to grant permission, 'Deny' to test rejection.")

    result = request_screencast_permission(timeout_seconds=timeout)
    check("Returns dict",    isinstance(result, dict))
    check("granted=True",    result.get("granted") is True,
          f"Error: {result.get('error')}")
    if result.get("granted"):
        check("restore_token present", bool(result.get("restore_token")))
        check("node_id present",       result.get("node_id") is not None)
        print(f"  Token: {result['restore_token'][:20]}...")
        print(f"  Node:  {result.get('node_id')}")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="ScreenCast Permission Onboarding Unit Tests"
    )
    ap.add_argument("--request-permission", action="store_true",
                    help="Trigger real GNOME consent dialog (requires desktop session)")
    ap.add_argument("--timeout", type=int, default=60,
                    help="Consent dialog timeout seconds (default: 60)")
    args = ap.parse_args()

    print("╔════════════════════════════════════════════════════════════╗")
    print("║     SCREENCAST PERMISSION ONBOARDING TEST                  ║")
    print("╚════════════════════════════════════════════════════════════╝")

    test_token_roundtrip()
    test_validate_restore_token()
    test_permission_status()
    test_capture_health()
    test_request_permission_dry_run()

    if args.request_permission:
        test_request_permission_real(timeout=args.timeout)
    else:
        print("\n  [INFO] Run with --request-permission to test the real consent dialog.")

    print("\nDone.")
