# Spec: Focused-Monitor Screenshot Capture for Extended Multi-Display Workflows

## Problem

In extended multi-display setups, the desktop app can capture pixels from the wrong monitor while still reporting the correct active window title/app. This creates a mismatch between:
- active-window metadata (app/title)
- OCR text/context (captured image)

User-visible impact:
- OCR may reflect another screen than the one the user is actively working on.
- AI classification and issue matching can use incorrect context.
- Privacy filtering may process unrelated screen content while missing relevant content on the focused display.

## Root Cause / Context

Current screenshot capture paths in the desktop tracker rely on default screen grabbing behavior without monitor targeting. In Windows extended-display environments, this can default to the primary monitor unless an explicit monitor-aware strategy is used.

The app already identifies the focused window using Win32 APIs, but current capture behavior does not consistently bind screenshot capture to the monitor containing that focused window.

## Proposed Solution

Implement a focused-monitor capture strategy in python-desktop-app that ties screenshot selection to the monitor of the current foreground window.

Approach:
1. Determine current foreground window handle via Win32.
2. Resolve the monitor containing that window (nearest-monitor fallback when needed).
3. Read monitor bounds and capture only that monitor region.
4. Apply the same helper across all production screenshot call sites used by OCR/time-tracking flows.
5. Keep a safe fallback hierarchy when monitor resolution fails:
   - fallback to all-screens capture only when foreground window is temporarily unavailable
   - fallback to current default single-grab behavior on Win32/API errors

Design choices to mitigate multi-display risks:
- Use monitor-of-foreground-window instead of primary-monitor assumptions.
- Capture one monitor (focused) instead of all monitors to avoid unrelated pixels and reduce privacy/performance risks.
- Preserve existing behavior on single-monitor systems and failure paths.

Scope of intended code touch points (implementation phase):
- Shared screenshot helper in desktop capture module.
- OCR capture flow call sites.
- Any tracker screenshot path that contributes to activity/OCR payloads.
- Optional: popup placement logic to display on the focused monitor work area.

## How This Mitigates Extended Multi-Display Setups

For users working across multiple extended displays, this approach ensures the captured screenshot corresponds to the screen where active work is occurring.

Mitigation outcomes:
- Aligns OCR text with active app/window metadata.
- Improves AI matching quality by sending context from the correct display.
- Reduces accidental processing of unrelated monitors.
- Maintains expected behavior when users move windows between monitors.

## Acceptance Criteria

1. When the active window is on a non-primary monitor, captured screenshot region corresponds to that monitor, not the primary monitor.
2. OCR text and active window metadata are from the same active-work context in multi-display scenarios.
3. When the active window moves between monitors, subsequent captures follow the new monitor without restart.
4. Single-monitor systems behave unchanged.
5. If Win32 monitor lookup fails, capture path falls back safely without crashing tracking.
6. No new third-party dependency is introduced for this change.

## Out of Scope

- Capturing all connected monitors in one combined screenshot for normal activity tracking.
- Per-window pixel cropping (window-rectangle-only capture).
- Changes to AI-server matching logic or Supabase schema.
- Reworking OCR engine internals/configuration semantics.
- Broad UI redesign beyond optional focused-monitor popup placement.

## Implementation Notes (Planning Only)

This document is a pre-implementation plan only. No production code changes, tests, or behavior changes are included in this step.

---

## Addendum: Architectural Review Resolutions

This addendum addresses the 14 findings from the architectural review (2026-05-23).

### P0-1: DPI Awareness

**Resolution:** `monitor_capture.py` calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` at module import time (earliest safe point, before any Win32 display API). Falls back to `shcore.SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)` on pre-1703 Windows. A startup log line records the declared mode.

### P0-2: Privacy-Safe Fallback Hierarchy

**Resolution:** The fallback ladder is:
- **Tier 1:** Focused-monitor capture (foreground window's monitor bbox).
- **Tier 2:** Primary monitor capture (explicit primary rect, never captures more than one monitor).
- **Tier 3:** Skip the capture tick entirely, return None, log reason code.

`all_screens` is NEVER used without a bbox. Under no automatic fallback does the app capture more monitors than the originally targeted one.

### P0-3: Foreground Window Stability

**Resolution:** A 300ms stability window is implemented. If the foreground HWND changed within this window, the last stable HWND (cached for up to 10s) is reused. Known transient window classes (`Shell_TrayWnd`, `Windows.UI.Core.CoreWindow`, UAC dialogs, etc.) are filtered before monitor resolution. NULL HWND results in Tier 2/3 fallback — never all-screens.

### P0-4: Minimized / Cloaked / Spanning Windows

**Resolution:**
- `MONITOR_DEFAULTTONEAREST` is the specified flag.
- Minimized windows detected via `IsIconic()` → Tier 3 (skip capture).
- Cloaked UWP windows detected via `DwmGetWindowAttribute(DWMWA_CLOAKED)` → Tier 3.
- Spanning windows: `EnumDisplayMonitors` + rectangle intersection picks the monitor with the largest window overlap area.

### P1-5: Platform Scope

**Resolution:** Windows-only implementation. Non-Windows platforms get a passthrough to `ImageGrab.grab()` (current behavior). The public interface (`capture_focused_monitor() -> Image | None`) is platform-agnostic.

### P1-6: Monitor Hot-Plug

**Resolution:** Monitors are re-enumerated on every capture via `EnumDisplayMonitors` — no topology cache exists. Undocking or unplugging mid-session is handled automatically by the next capture tick.

### P1-7: RDP / Virtual Desktops

**Resolution:** `is_rdp_session()` helper detects RDP via `GetSystemMetrics(SM_REMOTESESSION)` and logs it at startup. Windows virtual desktops (Win+Ctrl+D) work correctly because the foreground HWND on the active virtual desktop still maps to a physical monitor.

### P1-8: Privacy Framing

**Acknowledged:** The focused monitor will now *reliably* capture the user's active work area. The existing privacy filter pipeline runs unchanged on the (possibly smaller) single-monitor image. No confidence thresholds or model assumptions depend on image dimensions.

### P1-9: Performance / Sizing

**Resolution:** Single-monitor capture is ≤ one monitor's pixel area (worst case 4K = ~8MP). This is identical or smaller than the previous primary-monitor capture. OCR `max_image_dimension` config (default 4096) already handles downscaling. No upload payload change.

### P1-10: Testable Acceptance Criteria

**Resolution:** 23 unit tests cover: feature flag, stability debouncing, transient filtering, minimized/cloaked detection, spanning-window resolution, tier fallback hierarchy, popup work-rect, RDP detection, and rectangle intersection math.

### P1-11: Feature Flag / Telemetry

**Resolution:** `MULTIMON_CAPTURE_MODE` env var (`on`/`off`). Default `on`. Per-capture stats tracked internally (`tier1_focused`, `tier2_primary`, `tier3_skipped`, `total`) accessible via `get_capture_stats()`. Kill switch: set `MULTIMON_CAPTURE_MODE=off` in `.env` to instantly revert to legacy behavior without code changes.

### P2-12: AI-Server Contract

**Confirmed:** AI server accepts any single-monitor dimension. No heuristics depend on capture dimensions or aspect ratio. The `max_image_dimension` OCR config (4096px) normalizes input before processing.

### P2-13: Dependency Decision

**Decision:** Uses existing `pywin32` (already a project dependency) for `MonitorFromWindow`, `GetMonitorInfo`, `EnumDisplayMonitors`, `GetForegroundWindow`, `GetClassName`, `GetWindowRect`. Uses `ctypes` (stdlib) for `IsIconic`, `DwmGetWindowAttribute`, DPI awareness APIs. No new third-party dependency.

### P2-14: Popup Placement

**Decision:** IN SCOPE. The `PausePopupWindow` now uses `get_focused_monitor_work_rect()` to position itself on the focused monitor's work area (excludes taskbar). Covered by dedicated test case.
