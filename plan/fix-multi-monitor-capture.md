# Multi-Monitor Screen Capture — Bug Fix Plan

> **Status:** Proposed — awaiting implementation
> **Owner:** Desktop App
> **Affected component:** [`python-desktop-app/desktop_app.py`](../python-desktop-app/desktop_app.py)
> **Severity:** High (silently corrupts OCR text in activity records, privacy
> filter sees the wrong screen, pause popup lands on the wrong monitor)
> **Effort:** Small (~30 lines of code, 5 + 1 call sites)

---

## 1. Problem Statement

When a user has more than one monitor and is actively working in a window on
**any monitor that is not the Windows primary monitor**, the desktop app
captures the **primary monitor's pixels** for OCR. Every activity record's
`ocr_text` therefore describes the wrong screen.

The window-identification half of tracking still works — `application_name`
and `window_title` come from `GetForegroundWindow()` which is monitor-agnostic
— so each broken record contains a self-contradiction:

| Field | Source | Correct on multi-monitor? |
|---|---|---|
| `application_name` | Process owning `GetForegroundWindow()` HWND | ✅ |
| `window_title` | `GetWindowText(hwnd)` | ✅ |
| `ocr_text` / `ocr_method` / `ocr_confidence` | `ImageGrab.grab()` of primary monitor | ❌ |
| `metadata.extracted_text` (screenshots flow, currently disabled) | Same | ❌ |

The mismatch silently propagates downstream into:

- **Privacy filter** — redacts pixels from a screen the user isn't on; misses
  PII on the screen the user actually sees. Disables the app-elevated rules
  ([privacy/filter.py:33](../python-desktop-app/privacy/filter.py#L33)) because `app_name='excel.exe'`
  paired with OCR text from a browser doesn't match the app-specific patterns.
- **AI server's unknown-app classifier** ([desktop_app.py:8725](../python-desktop-app/desktop_app.py#L8725))
  receives the wrong OCR context and returns wrong classifications.
- **AI server's Jira-issue matcher** matches productive sessions to issue keys
  visible on the wrong screen, or fails to match at all.
- **Pause popup** ([desktop_app.py:3367-3370](../python-desktop-app/desktop_app.py#L3367-L3370))
  appears in the bottom-right of the **primary** monitor regardless of which
  monitor the user is currently working on.

---

## 2. Evidence (from manual testing)

Verified on a 3-monitor Windows 11 setup using the bundled test scripts.

### Monitor layout used in test

```
Monitor count:   3
Virtual desktop: origin=(-3520,-58)  size=5440 x 1138
  [0] \\.\DISPLAY1   rect=(-1920, -58, -384, 806)   primary=False
  [1] \\.\DISPLAY2   rect=(-3520,  72, -1920, 972)  primary=False
  [2] \\.\DISPLAY3   rect=(    0,   0,  1920, 1080) primary=True
```

### Test 1 — VS Code focused on DISPLAY3 (primary)

Bug masked: `ImageGrab.grab()` returns 1920×1080 from DISPLAY3, which happens
to be where VS Code is. OCR text matches the activity record. (Apparent
behaviour: works.)

### Test 2 — Google Docs focused on DISPLAY1 (secondary, negative-x)

```
Active window     : "Copilot Prompts — AI Chatbot Course - Google Docs - Google Chrome"
Window rect       : (-1927, -65, -377, 765)
On monitor        : \\.\DISPLAY1   rect=(-1920, -58, -384, 806)
Bare grab() size  : 1920 x 1080      ← captured DISPLAY3 (primary)
Active-monitor fix: 1536 x 864       ← captured DISPLAY1 (correct)
```

The bare-grab image showed VS Code from DISPLAY3. The active-monitor capture
showed Google Docs from DISPLAY1. The activity record claims
`window_title="Copilot Prompts — Google Docs"` and
`application_name="chrome.exe"` regardless. The two halves of the record
disagree.

### Test 3 — Claude focused on DISPLAY2 (tertiary, far-left)

```
Active window     : "Jira issues quality and assignment report - Claude - Google Chrome"
On monitor        : \\.\DISPLAY2   rect=(-3520, 72, -1920, 972)
Active-monitor fix: 1600 x 900     ← captured DISPLAY2 (correct)
```

`focused_screen.png` produced by `test_focused_screen.py` shows the Claude
chat — the same screen the user was looking at — confirming the fix works
identically on a third monitor.

### Reproducer scripts

- [test_multimon_bug.py](../python-desktop-app/test_multimon_bug.py) — reproduces the bug, exits
  with code `1` when `ImageGrab.grab()` does not contain the active window.
- [test_multimon_fixed.py](../python-desktop-app/test_multimon_fixed.py) — produces three
  side-by-side captures (bug, all-screens, active-monitor).
- [test_focused_screen.py](../python-desktop-app/test_focused_screen.py) — single-output demo.

---

## 3. Root Cause

Two factors combine, both inside `desktop_app.py`:

### 3.1 Pillow's `ImageGrab.grab()` default on Windows is primary-only

`PIL.ImageGrab.grab(bbox=None, include_layered_windows=False, all_screens=False, xdisplay=None)`
captures only the primary monitor unless `all_screens=True` or a `bbox` is
supplied. This is documented Pillow behaviour and confirmed on the test
hardware (1920×1080 captured out of a 5440×1138 virtual desktop).

### 3.2 The desktop app never asks which monitor the focused window is on

A repository-wide grep for `MonitorFromWindow`, `EnumDisplayMonitors`,
`GetMonitorInfo`, `GetSystemMetrics(SM_*VIRTUAL*)`, or `all_screens` returns
**zero matches** in production code. The five capture sites all call
`ImageGrab.grab()` with no arguments, and the pause popup uses Tk's
`winfo_screenwidth()`/`winfo_screenheight()` which report the primary
monitor's size on Windows.

So the app already identifies *what* the user is doing (focused window) but
not *where* the user is doing it (which monitor) — the missing link is a
single Win32 call.

### 3.3 Affected call sites

| File:Line | Function | What it captures today |
|---|---|---|
| [desktop_app.py:4603](../python-desktop-app/desktop_app.py#L4603) | `LocalOCRProcessor.capture_screenshot_only()` (throttled branch) | primary only |
| [desktop_app.py:4609](../python-desktop-app/desktop_app.py#L4609) | `LocalOCRProcessor.capture_screenshot_only()` (non-throttled branch) | primary only |
| [desktop_app.py:4650](../python-desktop-app/desktop_app.py#L4650) | `LocalOCRProcessor.capture_and_ocr()` (throttled branch) | primary only |
| [desktop_app.py:4660](../python-desktop-app/desktop_app.py#L4660) | `LocalOCRProcessor.capture_and_ocr()` (non-throttled branch) | primary only |
| [desktop_app.py:8934](../python-desktop-app/desktop_app.py#L8934) | `TimeTracker.capture_screenshot()` (interval-based screenshot for `screenshots` table) | primary only |
| [desktop_app.py:3367-3370](../python-desktop-app/desktop_app.py#L3367-L3370) | `PausePopupWindow._create_window()` | popup positioned on primary |

---

## 4. Goals & Non-Goals

### Goals

- `ocr_text` matches `window_title`/`application_name` in every activity
  record, regardless of which monitor the focused window is on.
- The privacy filter sees the screen the user is actually viewing, so
  app-elevated rules in `APP_ELEVATED_DETECTION` fire on the right pixels.
- The AI-server unknown-app classifier and Jira-issue matcher receive OCR
  context from the user's active screen.
- The pause popup appears on the monitor the user is currently working on.
- Behaviour is identical to today on single-monitor systems.
- No new third-party dependencies; only existing `pywin32` and `Pillow`.
- Falls back safely (to current behaviour) on unexpected Win32 errors.

### Non-Goals

- Capturing every monitor simultaneously — too costly, leaks unrelated pixels.
- Per-window cropping (capturing only the focused window's bounding rect) —
  breaks when window is partially off-screen, minimised, or covered.
- Changes to the OCR pipeline downstream of capture
  ([`ocr/facade.py`](../python-desktop-app/ocr/facade.py)).
- Re-enabling the disabled screenshot-storage path
  (`SCREENSHOT_MONITORING_HARD_DISABLED = True` at
  [desktop_app.py:341](../python-desktop-app/desktop_app.py#L341)).
- Any schema change to Supabase tables.
- Any change to AI-server classification logic.

---

## 5. Proposed Solution

### 5.1 Add a single helper at module scope

Add at the top of `desktop_app.py` (near the existing Win32 imports), or just
above `class LocalOCRProcessor`:

```python
# Win32 constant for MonitorFromWindow — fallback flag if no monitor matches.
MONITOR_DEFAULTTONEAREST = 2


def grab_active_monitor_screenshot():
    """Capture the monitor that the foreground window is on.

    This replaces bare ``ImageGrab.grab()`` calls so the OCR pipeline reads
    pixels from the screen the user is actually working on, not the Windows
    primary monitor. The window's identity (title, app) is already taken
    from the same foreground HWND via ``GetForegroundWindow``, so this keeps
    ``ocr_text`` aligned with ``window_title``/``application_name``.

    Fallback hierarchy on errors:
        1. No focused window  → ``ImageGrab.grab(all_screens=True)``
           (best-effort virtual-desktop capture so we still get something)
        2. Win32 unavailable / any exception → ``ImageGrab.grab()``
           (primary-monitor capture, current behaviour)

    Returns:
        PIL.Image — never None. Caller does not need to defensive-check.
    """
    if not WIN32_AVAILABLE:
        return ImageGrab.grab()
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            # Rare: taskbar interaction or transition between desktops.
            return ImageGrab.grab(all_screens=True)
        hmon = win32api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(hmon)
        mon_rect = info["Monitor"]  # (left, top, right, bottom)
        # all_screens=True is REQUIRED — without it Pillow clamps the bbox
        # to the primary monitor, defeating the whole purpose.
        return ImageGrab.grab(bbox=mon_rect, all_screens=True)
    except Exception as e:
        print(f"[WARN] Active-monitor capture failed: {e}, "
              f"falling back to primary monitor")
        return ImageGrab.grab()
```

### 5.2 Replace the 5 bare `ImageGrab.grab()` capture sites

Each of these stays a single line. No surrounding code changes.

```python
# desktop_app.py:4603, 4609, 4650, 4660, 8934
- screenshot = ImageGrab.grab()
+ screenshot = grab_active_monitor_screenshot()
```

### 5.3 Update the pause popup positioning

Replace [desktop_app.py:3367-3370](../python-desktop-app/desktop_app.py#L3367-L3370):

```python
# BEFORE
screen_width = self.window.winfo_screenwidth()
screen_height = self.window.winfo_screenheight()
x = screen_width - window_width - 20
y = screen_height - window_height - 60  # Above taskbar
self.window.geometry(f"{window_width}x{window_height}+{x}+{y}")

# AFTER
left, top, right, bottom = _focused_window_work_rect(
    fallback=(0, 0,
              self.window.winfo_screenwidth(),
              self.window.winfo_screenheight())
)
x = right - window_width - 20
y = bottom - window_height - 20  # Use Work rect (excludes taskbar)
self.window.geometry(f"{window_width}x{window_height}+{x}+{y}")
```

Where `_focused_window_work_rect()` is a small helper that mirrors the
capture helper but returns the monitor's `Work` rectangle (which excludes
the taskbar — important so the popup doesn't sit on top of it):

```python
def _focused_window_work_rect(fallback):
    """Return (left, top, right, bottom) of the active monitor's work area.

    Falls back to the supplied tuple on any error so the popup still appears.
    """
    if not WIN32_AVAILABLE:
        return fallback
    try:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return fallback
        hmon = win32api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(hmon)
        return info["Work"]
    except Exception:
        return fallback
```

### 5.4 Total diff size

- **+ ~50 LOC** (two helper functions, comments).
- **6 lines changed** at the call sites.
- **No deletions** of existing behaviour — fallbacks preserve today's
  semantics on error.

---

## 6. Edge Cases & Error Handling

| Scenario | What happens | Mitigation |
|---|---|---|
| Single monitor | `MonitorFromWindow` returns the only monitor; `mon_rect` equals primary; identical capture to today | none required |
| `GetForegroundWindow()` returns 0 (taskbar / desktop switch / lock screen transition) | `hwnd == 0` falls through to `ImageGrab.grab(all_screens=True)` | best-effort capture; lock-screen apps already filtered upstream by `LOCK_SCREEN_APPS` check at [desktop_app.py:8603](../python-desktop-app/desktop_app.py#L8603) |
| Window straddles two monitors | `MONITOR_DEFAULTTONEAREST` picks the one with the most overlap | acceptable — matches Windows behaviour for "which monitor is this window on" |
| Window minimised | `MonitorFromWindow` returns the monitor where it was last visible; `IsIconic(hwnd)` could be checked but the app already throttles OCR on classification | OCR text may be empty; current code paths handle empty text gracefully |
| Per-monitor DPI awareness | `MonitorFromWindow` returns physical-pixel coordinates that match what `ImageGrab.grab(bbox=...)` expects under `PROCESS_PER_MONITOR_DPI_AWARE_V2` | verify after build; pywin32 + Pillow are DPI-aware on Windows 10+ |
| Win32 import failed (`WIN32_AVAILABLE = False`) | helper falls through to bare `ImageGrab.grab()` (today's behaviour) | desktop app is Windows-only, but defensive |
| Any unexpected `Win32Exception` | logged and falls back to bare `ImageGrab.grab()` | logged via `print` with `[WARN]` prefix matching app convention |
| Screenshot dimensions change capture timing | Active-monitor capture is identical cost to primary capture (single-monitor pixel grab) | benchmark not required |

---

## 7. Testing Strategy

### 7.1 Pre-merge — manual on multi-monitor hardware

Use the existing scripts from this branch:

1. `python test_multimon_bug.py` with focus on DISPLAY1 — confirm bug
   still reproduces with **unpatched** code (sanity check the test).
2. Apply patch.
3. `python test_multimon_bug.py` with focus on DISPLAY1 — confirm
   `Active window pixels inside capture? True` (or only off by the
   maximised-overhang artifact).
4. `python test_focused_screen.py` cycling focus across DISPLAY1, DISPLAY2,
   DISPLAY3 — confirm the saved PNG matches the focused monitor each time.
5. End-to-end smoke: launch the patched desktop app, spend 10 minutes on
   each monitor in turn while running the activity batch upload, then
   inspect the resulting Supabase `activity_records` rows. `ocr_text`
   should describe the same window as `window_title` for every row.

### 7.2 Single-monitor regression check

On a single-monitor laptop, run the full app and verify activity records
look identical to a pre-patch run. The capture path falls through to
"monitor 0 = primary" so behaviour is unchanged.

### 7.3 Pause popup smoke test

- Trigger pause from tray menu while focus is on each monitor in turn.
- Confirm the floating clock window appears in the bottom-right of the
  monitor whose window had focus — not always on the primary.
- Re-trigger after re-focus to confirm the popup follows the user.

### 7.4 Diagnostics signal

After rollout, watch the AI server's diagnostics endpoint
(`/api/auth/diagnostics`) for new error categories logged by
`grab_active_monitor_screenshot`. Any spike in
`Active-monitor capture failed` warnings indicates the fallback path is
firing more than expected and needs investigation.

### 7.5 Optional automated test

Mock `win32gui.GetForegroundWindow` and `win32api.MonitorFromWindow` to
assert the helper:

- Returns a PIL image when Win32 succeeds.
- Falls back to `ImageGrab.grab(all_screens=True)` when `hwnd == 0`.
- Falls back to `ImageGrab.grab()` on `Win32Exception`.
- Returns a PIL image when `WIN32_AVAILABLE = False`.

Add to `tests/test_screenshot_capture.py` (new file).

---

## 8. Rollout Plan

| Step | Action | Verification |
|---|---|---|
| 1 | Create branch `fix/multi-monitor-capture` | git checkout |
| 2 | Apply changes from §5 | `git diff` matches plan |
| 3 | Run §7.1–7.3 manually on the 3-monitor test rig | all PNGs and Supabase records correct |
| 4 | Build PyInstaller exe with `build.bat` | exe runs, tray icon appears |
| 5 | Smoke test the built exe on multi-monitor for 30 minutes | no crashes, activity records correct |
| 6 | Open PR, link this plan, attach `focused_screen.png` evidence | reviewer signs off |
| 7 | Merge → tag bumped patch version → publish via existing auto-update flow | clients receive update silently |
| 8 | Watch admin dashboard for 24 h: any spike in OCR errors / fallback warnings? | green |
| 9 | Promote to all users | done |

If a regression appears (e.g. higher rate of `Active-monitor capture failed`),
roll back by reverting the merge — the fallback path means even mid-rollout
the worst case is "current behaviour."

---

## 9. Risks & Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Per-monitor DPI scaling causes wrong-sized capture | Low | Wrong-resolution OCR input → lower confidence | Test on a high-DPI external monitor before merge; existing app already runs DPI-aware |
| Some apps create transient foreground HWNDs (auto-hide menus, splash screens) and `MonitorFromWindow` picks a stale monitor | Low | Off-by-one capture for ~1 frame | Throttling already serialises captures; next capture corrects |
| `ImageGrab.grab(bbox=...)` rejects negative coordinates on older Pillow | Negligible | Helper falls back to primary | `requirements.txt` pins `Pillow==10.1.0` which is documented to support `all_screens=True` with negative-origin bboxes |
| Privacy concern: capture target changes | None | Beneficial — captures the screen the user is on, which is what the privacy contract already promises | Document in release notes |
| User expectation: pause popup "moved" | Very low | Cosmetic | Document in release notes |
| Build-time hidden import for new code | None | n/a | No new modules; only uses pywin32 + Pillow already in `desktop_app.spec` hidden imports |

---

## 10. Verification Metrics

After rollout, the following can be checked from the AI server / Supabase:

1. **Mismatch ratio**: count rows in `activity_records` where
   `window_title` references one app domain but `ocr_text` mentions a clearly
   different one (e.g. "Outlook" in title, "github.com" in OCR). Should drop
   sharply.
2. **AI server `match_jira_issue` success rate** on rows with
   `classification='productive'`. Should improve when users work on
   non-primary monitors.
3. **Privacy filter `redactions_count` distribution per app** — should
   become more aligned with each app's expected PII patterns (Excel
   showing more `POSSIBLE_SSN`/`POSSIBLE_CREDIT_CARD`, code editors showing
   more `API_KEY`/`PASSWORD`).
4. **Diagnostics events** of type `ocr` or `error` mentioning the new
   `Active-monitor capture failed` warning — should be near zero.

---

## 11. Out-of-Scope Follow-ups

These came up while investigating but are **not** part of this fix:

- **Maximised window overhang.** Strict `rect_contains` check fails on
  maximised windows by ~7-9 px because Windows extends maximised window
  borders off-screen. Cosmetic only — visible content is fully captured.
- **Multi-window OCR.** When the user is actively reading window A on
  monitor 1 *and* glancing at window B on monitor 2, only the focused
  window's monitor is captured. Capturing both would double OCR cost;
  current model assumes "focused window = what the user is doing."
- **Cursor-based capture.** Considered and rejected — cursor and focus
  diverge often; capturing cursor's monitor would re-introduce the
  mismatch in a different shape.
- **Re-enabling screenshot storage.** Currently disabled by
  `SCREENSHOT_MONITORING_HARD_DISABLED`; that decision is independent of
  this fix. If/when it's re-enabled, this fix means the stored screenshot
  will already match the recorded `window_title`.

---

## 12. References

- Pillow `ImageGrab.grab` documentation:
  https://pillow.readthedocs.io/en/stable/reference/ImageGrab.html
- Win32 `MonitorFromWindow`:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-monitorfromwindow
- Win32 `GetMonitorInfoW` (used via pywin32 `GetMonitorInfo`):
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmonitorinfow
- Existing focused-window code path:
  [desktop_app.py:8961-9027](../python-desktop-app/desktop_app.py#L8961-L9027) `get_active_window()`
- Existing privacy filter pipeline:
  [ocr/facade.py:486](../python-desktop-app/ocr/facade.py#L486) `OCRFacade.extract_text()`
- Existing activity batch upload:
  [desktop_app.py:8134](../python-desktop-app/desktop_app.py#L8134) `upload_activity_batch()`
- Reproducer scripts in this branch:
  [test_multimon_bug.py](../python-desktop-app/test_multimon_bug.py),
  [test_multimon_fixed.py](../python-desktop-app/test_multimon_fixed.py),
  [test_focused_screen.py](../python-desktop-app/test_focused_screen.py)
