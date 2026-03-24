# Unknown App Tab Switch Detection — Periodic Recheck Mechanism

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Why Normal Window Detection Fails](#why-normal-window-detection-fails)
3. [Solution: Periodic OCR Recheck](#solution-periodic-ocr-recheck)
4. [Detailed Implementation](#detailed-implementation)
5. [End-to-End Flow with Timeline](#end-to-end-flow-with-timeline)
6. [Code Walkthrough](#code-walkthrough)
7. [Deduplication via OCR Hash](#deduplication-via-ocr-hash)
8. [AI Classification Pipeline](#ai-classification-pipeline)
9. [Session Management](#session-management)
10. [Logging & Diagnostics](#logging--diagnostics)
11. [Configuration & Tuning](#configuration--tuning)
12. [Platform Comparison](#platform-comparison)
13. [Known Limitations](#known-limitations)
14. [Architecture Diagram](#architecture-diagram)

---

## Problem Statement

On **GNOME 46 Wayland**, certain applications (particularly Snap/Flatpak-sandboxed browsers
and AppArmor-confined apps) cannot be identified by the OS-level window detection APIs.
When this happens, the time tracker sees:

- **app_name** = `"Unknown"`
- **window_title** = `"Unknown"`
- **window_key** = `"unknown"`

The core problem: **when the user switches tabs within an Unknown app, the OS still reports
the exact same `window_key = "unknown"`**. The normal window switch detection compares
`window_key != self.current_window_key` — but since both are `"unknown"`, it sees no
change and does nothing. Tab switches within Unknown apps become invisible.

## Why Normal Window Detection Fails

### Normal Window Detection (Known Apps)

For known apps like VS Code, the detection chain works perfectly:

```
Tab 1: window_key = "code|||requirements.txt - VS Code"
Tab 2: window_key = "code|||desktop_app.py - VS Code"
→ window_key changed → is_new_window = True → screenshot → OCR → session created
```

The **window title changes** with each tab, so the `window_key` (format: `app|||title`)
naturally differs.

### Unknown App Detection (Broken Path)

For Unknown apps on GNOME 46 Wayland:

```
Tab 1: window_key = "unknown"
Tab 2: window_key = "unknown"  (identical!)
→ window_key == self.current_window_key → is_new_window = False → NOTHING HAPPENS
```

**Root cause:** The three Wayland window detection APIs all fail for sandboxed apps:

| API                    | Status on GNOME 46                                    |
|------------------------|-------------------------------------------------------|
| AT-SPI Accessibility   | Returns "Unknown" for sandboxed apps (no a11y bridge)  |
| GNOME Shell Eval       | **Disabled** on GNOME 46 (returns `false, ''`)         |
| GNOME Introspect       | **AccessDenied** (allowlisted apps only)               |

Since the OS cannot tell us *which tab* is active inside the Unknown app, we must use
an alternative signal: **the visual content on screen** (via OCR).

---

## Solution: Periodic OCR Recheck

Instead of waiting for an impossible OS-level window switch signal, the system uses a
**timer-based periodic recheck** that:

1. Detects that the user has been in an Unknown app for ≥ 10 seconds
2. Forces `is_new_window = True` (artificially triggers a "window switch")
3. Captures a new screenshot of whatever is currently on screen
4. Runs OCR to extract the screen text
5. Computes an MD5 hash of the OCR text
6. If the hash differs from the previous capture, triggers a new AI classification
7. The AI server (or local inference) identifies the actual app/site being used

This effectively turns **time-based polling + OCR content comparison** into a
tab switch detection mechanism.

---

## Detailed Implementation

### Component Overview

| Component                     | File               | Line  | Role                                                   |
|-------------------------------|---------------------|-------|-------------------------------------------------------|
| `get_active_window()`         | `desktop_app.py`    | ~7703 | Periodic recheck timer — forces `is_new_window = True` |
| `tracking_loop()`             | `desktop_app.py`    | ~8738 | Main poll loop — calls `process_window_event` on switch |
| `process_window_event()`      | `desktop_app.py`    | ~7230 | Captures screenshot + dispatches async OCR              |
| `capture_screenshot_only()`   | `desktop_app.py`    | ~4162 | Screenshot capture with throttle bypass (`force=True`)  |
| `_ocr_callback()`             | `desktop_app.py`    | ~7294 | Receives OCR result, triggers AI classification         |
| `_maybe_classify_unknown_app()` | `desktop_app.py`  | ~7312 | Dedup via OCR hash → spawns AI classification thread    |
| `_classify_unknown_app_async()` | `desktop_app.py`  | ~7352 | Calls AI server `/api/classify-app` endpoint            |
| `_infer_app_from_ocr()`       | `desktop_app.py`    | ~7445 | Local 3-phase heuristic to identify app from screen text |
| `on_window_switch()`          | `desktop_app.py`    | ~3772 | Session manager — creates/resumes session in SQLite     |
| `get_active_window_linux()`   | `desktop_app_linux.py` | — | AT-SPI → GNOME D-Bus → EWMH → xdotool fallback chain  |
| `_get_active_window_atspi()`  | `desktop_app_linux.py` | ~198 | AT-SPI accessibility interface for window detection     |

### State Variables

| Variable                        | Type       | Purpose                                            |
|---------------------------------|------------|----------------------------------------------------|
| `self.current_window_key`       | `str`      | Current window identifier (`app|||title` or `"unknown"`) |
| `self.current_window_start_time` | `datetime` | When the current window was first detected (UTC)   |
| `self.current_window_screenshot_id` | `str`  | Screenshot record ID (reset on recheck)            |
| `self.current_window_record_created_at` | `str` | Record creation timestamp (reset on recheck)     |
| `self._unknown_apps_classified` | `set`      | Dedup set — stores OCR hash keys already classified |

---

## End-to-End Flow with Timeline

### Scenario: User opens Snap Firefox, visits Skyscanner, then switches to Gmail

```
T=0s    User switches from VS Code to Snap Firefox (Skyscanner tab)
        ├─ AT-SPI: detects "Unknown" / "Unknown" (sandboxed — no a11y bridge)
        ├─ window_key = "unknown"
        ├─ self.current_window_key = "code|||desktop_app.py - VS Code"
        ├─ "unknown" != "code|||desktop_app.py..." → is_new_window = True ← NORMAL DETECTION
        ├─ self.current_window_key = "unknown"
        ├─ self.current_window_start_time = T=0s
        ├─ tracking_loop: window_switched = True
        │   └─ process_window_event({app: "Unknown", title: "Unknown"})
        │       ├─ classification = "unknown" (classify manager)
        │       ├─ force_ocr = True (unknown classification)
        │       ├─ capture_screenshot_only(force=True) → screenshot ✓
        │       ├─ session_manager.on_window_switch("Unknown", "Unknown", "unknown")
        │       └─ submit_ocr_async(screenshot, _ocr_callback)
        │           └─ _ocr_callback fires ~2-5s later:
        │               ├─ OCR text: "Skyscanner flights hotels cheap..." (800 chars)
        │               ├─ backfill_ocr → updates session with OCR text
        │               └─ _maybe_classify_unknown_app("Unknown", "Unknown", ocr_text)
        │                   ├─ MD5 hash = "a3f8b2c1e9d4"
        │                   ├─ app_key = "unknown|a3f8b2c1e9d4" (NOT in dedup set)
        │                   ├─ Add to _unknown_apps_classified
        │                   └─ Thread → _classify_unknown_app_async
        │                       ├─ POST /api/classify-app → "productive"
        │                       └─ _infer_app_from_ocr → ("google-chrome", "Skyscanner - Flights")
        │                           └─ update_app_info("Unknown", "Unknown", "google-chrome", "Skyscanner")

T=2s    Poll: window_key="unknown", self.current_window_key="unknown"
        ├─ Recheck: elapsed = 2s < 10s → skip
        └─ is_new_window = False → nothing happens

T=4s    Poll: same → elapsed = 4s < 10s → skip

T=5s    User switches to Gmail tab (inside same Unknown Firefox)
        ├─ OS still reports: window_key = "unknown"
        └─ *** THE OS CANNOT SEE THIS TAB SWITCH ***

T=6s    Poll: same → elapsed = 6s < 10s → skip
T=8s    Poll: same → elapsed = 8s < 10s → skip

T=10s   Poll: window_key="unknown", self.current_window_key="unknown"
        ├─ Recheck: elapsed = 10s >= 10s → FIRES! ← PERIODIC RECHECK
        ├─ is_new_window = True (forced by timer)
        ├─ self.current_window_start_time = T=10s (reset for next cycle)
        ├─ self.current_window_screenshot_id = None (reset)
        ├─ LOG: "[INFO] Unknown app re-check at HH:MM:SS: capturing new screenshot..."
        ├─ tracking_loop: window_switched = True
        │   └─ process_window_event({app: "Unknown", title: "Unknown"})
        │       ├─ force_ocr = True
        │       ├─ capture_screenshot_only(force=True) → NEW screenshot of Gmail ✓
        │       └─ submit_ocr_async → _ocr_callback fires:
        │           ├─ OCR text: "Gmail Inbox compose mail starred..." (950 chars)
        │           └─ _maybe_classify_unknown_app("Unknown", "Unknown", new_ocr_text)
        │               ├─ MD5 hash = "7e2f1b0d5a8c" (DIFFERENT from Skyscanner's hash!)
        │               ├─ app_key = "unknown|7e2f1b0d5a8c" (NOT in dedup set)
        │               └─ Thread → _classify_unknown_app_async
        │                   ├─ POST /api/classify-app → "productive"
        │                   └─ _infer_app_from_ocr → ("google-chrome", "Gmail - Inbox")

T=20s   Next recheck fires (10s after last reset)
        ├─ Screenshot → OCR → same Gmail content → same hash "7e2f1b0d5a8c"
        ├─ app_key = "unknown|7e2f1b0d5a8c" already in dedup set
        └─ LOG: "[UNKNOWN] Unknown — already sent to AI server, skipping"
        (No duplicate AI call — dedup working correctly)

T=22s   User switches to YouTube tab
T=30s   Next recheck → screenshot → OCR text has "YouTube" → new hash → new AI classification
```

---

## Code Walkthrough

### Step 1: Periodic Recheck Timer (`get_active_window`)

**File:** `desktop_app.py`, `get_active_window()` method

This is the entry point. Every 2 seconds, the tracking loop calls `get_active_window()`.
When the user is in an Unknown app, this code fires:

```python
_UNKNOWN_RECHECK_INTERVAL = 10  # seconds between re-checks

if (window_key == 'unknown' and self.current_window_key == 'unknown'
        and self.current_window_start_time is not None):
    elapsed = (datetime.now(timezone.utc) - self.current_window_start_time).total_seconds()
    if elapsed >= _UNKNOWN_RECHECK_INTERVAL:
        # Treat as a new window event to trigger OCR + AI classification
        is_new_window = True
        self.current_window_start_time = datetime.now(timezone.utc)  # Reset for next cycle
        self.current_window_screenshot_id = None
        self.current_window_record_created_at = None
        result['is_new_window'] = True
        return result
```

**Why it works:**
- `window_key == 'unknown'`: The OS still reports an Unknown window
- `self.current_window_key == 'unknown'`: We've been tracking an Unknown window
- `elapsed >= 10`: At least 10 seconds since the last recheck (or initial detection)
- Setting `is_new_window = True` tricks the downstream code into processing this as a window switch
- Resetting `current_window_start_time` ensures the next recheck fires 10 seconds later

**Why `current_window_key` is NOT reset to `None`:**
If we reset `current_window_key`, the next poll would see `"unknown" != None` and trigger a
*full* window switch (saving previous window info, etc.). By keeping it as `"unknown"`, we only
trigger the recheck path — lighter weight and doesn't corrupt the session history.

### Step 2: Tracking Loop Dispatches Event

**File:** `desktop_app.py`, `tracking_loop()` method

The tracking loop polls every 2 seconds:

```python
window_info = self.get_active_window()
window_switched = window_info.get('is_new_window', False)

if window_switched:
    self.process_window_event(window_info)
```

Since the recheck set `is_new_window = True`, `window_switched` is `True`, and
`process_window_event` fires as though a real window switch occurred.

### Step 3: Screenshot Capture

**File:** `desktop_app.py`, `process_window_event()` method

For unknown classification, `force_ocr = True` is set, which bypasses the OCR throttle:

```python
force_ocr = (classification == 'unknown') or issue_key_in_title or ...

capture_result = self.ocr_processor.capture_screenshot_only(force=force_ocr)
```

Inside `capture_screenshot_only`, the `force=True` parameter skips the rate limiter entirely:

```python
def capture_screenshot_only(self, force=False):
    now = time.time()
    if not force and (now - self._last_ocr_time) < self._min_interval:
        return {'screenshot': screenshot, 'throttled': True}  # throttled
    # force=True → reaches here directly
    screenshot = self._grab_screenshot()
    return {'screenshot': screenshot, 'throttled': False}
```

This is critical — without `force=True`, the recheck's screenshot could be throttled
and OCR would never run, making tab detection impossible.

### Step 4: Async OCR Dispatch

The screenshot is submitted to the OCR worker thread:

```python
def _ocr_callback(ocr_res, _title=_cb_title, _app=_cb_app,
                  _cls=_cb_classification, _wtitle=_cb_window_title):
    self.session_manager.backfill_ocr(_title, _app, ocr_res)
    if _cls == 'unknown':
        ocr_text = ocr_res.get('text') if ocr_res else None
        ocr_len = len(ocr_text) if ocr_text else 0
        print(f"[OCR-DONE] Unknown app OCR complete: {ocr_len} chars extracted")
        self._maybe_classify_unknown_app(_app, _wtitle, ocr_text)

submitted = self.ocr_processor.submit_ocr_async(screenshot, _ocr_callback)
```

The OCR worker thread (single-threaded) processes the screenshot using the configured
OCR engine (RapidOCR, EasyOCR, or Tesseract), extracts text, and calls `_ocr_callback`.

### Step 5: Deduplication & AI Classification

See [Deduplication via OCR Hash](#deduplication-via-ocr-hash) section below.

---

## Deduplication via OCR Hash

Each recheck produces OCR text. To avoid sending duplicate AI classification requests
(e.g., user stays on the same tab for 5 minutes → 30 rechecks with same content), the
system uses an **MD5 hash of the OCR text** as a dedup key.

```python
def _maybe_classify_unknown_app(self, app_name, window_title, ocr_text):
    app_lower = app_name.lower()
    if app_lower == 'unknown':
        import hashlib
        ocr_hash = hashlib.md5((ocr_text or '').encode()).hexdigest()[:12]
        app_key = f"unknown|{ocr_hash}" if ocr_hash else f"unknown|{window_title[:50]}"

    if app_key not in self._unknown_apps_classified:
        self._unknown_apps_classified.add(app_key)
        # Spawn AI classification thread
        threading.Thread(target=self._classify_unknown_app_async, ...).start()
    else:
        print(f"[UNKNOWN] ... already sent to AI server, skipping")
```

### How the hash-based dedup works

| Recheck # | Screen Content | OCR Hash (first 12) | In Dedup Set? | Action                |
|-----------|---------------|---------------------|---------------|----------------------|
| 1         | Skyscanner    | `a3f8b2c1e9d4`     | No            | → AI classification  |
| 2         | Skyscanner    | `a3f8b2c1e9d4`     | Yes           | → Skip (same tab)    |
| 3         | Gmail         | `7e2f1b0d5a8c`     | No            | → AI classification  |
| 4         | Gmail         | `7e2f1b0d5a8c`     | Yes           | → Skip (same tab)    |
| 5         | YouTube       | `c4d9e1f2a3b5`     | No            | → AI classification  |

This ensures:
- Each distinct screen content triggers exactly **one** AI classification
- Staying on the same tab doesn't produce duplicate API calls
- Minor OCR variations (noise) can occasionally cause duplicate calls, but this is acceptable

### Offline guard

If the system is offline, `_maybe_classify_unknown_app` returns immediately **without**
adding the key to the dedup set. This ensures reclassification is attempted when connectivity
is restored:

```python
if not self.offline_manager.is_online:
    return  # Don't add to dedup set — retry when online
```

---

## AI Classification Pipeline

When a new OCR hash is detected, the system runs two parallel identification strategies:

### Strategy 1: AI Server Classification (Remote)

```
POST /api/classify-app
{
    "application_name": "Unknown",
    "window_title": "Unknown",
    "ocr_text": "Skyscanner - Compare Cheap Flights Hotels..."
}
→ Response: { "classification": "productive", "reasoning": "Travel booking site" }
```

### Strategy 2: Local OCR Inference (`_infer_app_from_ocr`)

A 3-phase heuristic that runs **after** the AI server responds:

**Phase 1 — Desktop App Signatures (highest priority):**
Checks for distinctive UI elements that uniquely identify desktop apps:
- VS Code: `"file edit selection view go run terminal help"` (menu bar)
- Terminal: `"iswaryak@"`, `"$ "`, `"# "` (shell prompts)
- Slack: `"slack —"`, `"slack workspace"`

**Phase 2 — Browser Detection:**
Checks for indicators that this is a browser window:
- `"search google or type a url"`, `"new tab"`, `"search or enter address"`

**Phase 3 — Browser-Based Sites (only if Phase 2 confirmed browser):**
Maps website-specific keywords to app names:
- `"gmail"` → `google-chrome` with title `"Gmail - Inbox"`
- `"jira"` → `google-chrome` with title `"Jira - Project"`
- `"skyscanner"` → `google-chrome` with title `"Skyscanner - Flights"`

### Post-Classification Actions

After identification, the system updates:

1. **Local SQLite session** — `update_app_info()` renames `Unknown → google-chrome`
2. **Session classification** — `update_classification()` changes `unknown → productive`
3. **Supabase activity_records** — Retroactively updates any already-uploaded Unknown records

```python
if inferred_app and app_name == 'Unknown':
    self.session_manager.update_app_info(app_name, window_title, inferred_app, inferred_title)

self.session_manager.update_classification(effective_app, 'unknown', new_classification)
```

---

## Session Management

### Session Creation on Recheck

Each recheck calls `session_manager.on_window_switch("Unknown", "Unknown", "unknown")`:

```python
# CRITICAL: Create session FIRST so it exists when async OCR callback fires.
self.session_manager.on_window_switch(display_title, app_name, classification, ocr_result)
```

Since the session key is `(title="Unknown", app_name="Unknown")`, the **same session row**
is reused across all rechecks (it already exists from the first detection). The
`on_window_switch` method finds the existing row and increments `visit_count`:

```python
cursor.execute('SELECT id, ... FROM active_sessions WHERE window_title = ? AND application_name = ?',
               (title, app_name))
existing = cursor.fetchone()

if existing:
    cursor.execute('UPDATE active_sessions SET visit_count = ?, ...', (visit_count + 1, ...))
```

### Session Rename After Classification

When the AI identifies the app (e.g., Gmail), `update_app_info` renames the session:

- **Simple case:** No existing Gmail session → `UPDATE ... SET application_name = 'google-chrome'`
- **Merge case:** Gmail session already exists → Merge Unknown's time/visits into it, delete Unknown row

This merge logic prevents SQLite UNIQUE constraint violations on `(window_title, application_name)`.

---

## Logging & Diagnostics

The recheck mechanism includes comprehensive logging at every stage:

### Log Messages (chronological order)

```
[INFO] Window switched at HH:MM:SS: Unknown window (will identify via OCR)
[UNKNOWN] Unknown — Unknown (✓ screenshot)
[OCR-ASYNC] Dispatched async OCR for Unknown
[OCR-DONE] Unknown app OCR complete: 847 chars extracted
[UNKNOWN] Unknown — sending to AI server for classification (key: unknown|a3f8b2c1e9d4)
[AI] Classification for Unknown: productive
[AI] Inferred app from OCR: google-chrome (title: Skyscanner - Flights)
[AI] Updated 1 local session(s): Unknown → google-chrome

... 10 seconds later ...

[INFO] Unknown app re-check at HH:MM:SS: capturing new screenshot for tab detection
[UNKNOWN] Unknown — Unknown (✓ screenshot)
[OCR-ASYNC] Dispatched async OCR for Unknown
[OCR-DONE] Unknown app OCR complete: 923 chars extracted
[UNKNOWN] Unknown — sending to AI server for classification (key: unknown|7e2f1b0d5a8c)
[AI] Classification for Unknown: productive
[AI] Inferred app from OCR: google-chrome (title: Gmail - Inbox)

... 10 seconds later (same tab) ...

[INFO] Unknown app re-check at HH:MM:SS: capturing new screenshot for tab detection
[UNKNOWN] Unknown — Unknown (✓ screenshot)
[OCR-ASYNC] Dispatched async OCR for Unknown
[OCR-DONE] Unknown app OCR complete: 910 chars extracted
[UNKNOWN] Unknown — already sent to AI server, skipping (key: unknown|7e2f1b0d5a8c)
```

### What to look for when debugging

| Symptom                                            | Likely Cause                                                                   |
|----------------------------------------------------|--------------------------------------------------------------------------------|
| No `[INFO] Unknown app re-check` messages          | User left the Unknown app before 10 seconds elapsed                             |
| Recheck fires but `✗ no screenshot`                | PipeWire/GStreamer pipeline failed — check `wayland_screenshot.py` logs          |
| `OCR complete: 0 chars extracted`                  | OCR engine failed — check OCR engine logs                                       |
| `already sent to AI server, skipping` every time   | Same tab content — user hasn't switched tabs, or OCR extracts identical text     |
| `Screenshot capture failed for Unknown app`        | Screenshot module crashed — check GStreamer/PipeWire fd status                   |
| Classification fires but app not renamed            | `_infer_app_from_ocr` couldn't identify the app — needs new keyword signatures  |

---

## Configuration & Tuning

### Configurable Parameters

| Parameter                   | Value  | Location                    | Description                                         |
|-----------------------------|--------|-----------------------------|-----------------------------------------------------|
| `_UNKNOWN_RECHECK_INTERVAL` | `10s`  | `get_active_window()`       | How often to recheck Unknown app content             |
| `sleep_time` (tracking loop) | `2s`  | `tracking_loop()`           | How often the main loop polls (recheck granularity)  |
| `min_screenshot_interval`   | `10s`  | `tracking_loop()`           | Minimum time between window-switch screenshots       |
| `force_ocr`                 | `True` | `process_window_event()`    | Always `True` for unknown — bypasses OCR throttle    |
| `_min_interval` (OCR)       | varies | `LocalOCRProcessor`         | OCR rate limit (bypassed when `force=True`)          |

### Tradeoffs

**Shorter recheck interval (e.g., 5s):**
- Pro: Faster tab switch detection
- Con: More screenshots/OCR/API calls → higher CPU and cost

**Longer recheck interval (e.g., 30s):**
- Pro: Lower resource usage
- Con: Tab switches can go undetected for up to 30 seconds

**Current choice (10s):** Balances detection latency with resource usage. With a 2-second
poll interval, rechecks happen every 5 poll cycles.

---

## Platform Comparison

| Feature                          | Windows                          | Linux X11                        | Linux Wayland (GNOME 46)            |
|----------------------------------|----------------------------------|----------------------------------|-------------------------------------|
| Window title detection           | `win32gui.GetWindowText()`      | EWMH / `xdotool`                | AT-SPI accessibility interface       |
| Tab switch = title change?       | ✅ Yes — instant detection       | ✅ Yes — instant detection       | ❌ No — sandboxed apps return "Unknown" |
| Tab detection for Unknown apps   | N/A (no Unknown apps)            | N/A (no Unknown apps)            | ⏱️ Periodic OCR recheck (10s delay)  |
| Screenshot API                   | `PIL.ImageGrab`                  | `PIL.ImageGrab` / `scrot`        | PipeWire ScreenCast Portal + GStreamer |
| OCR required for tab switches?   | No                               | No                               | **Yes** — only way to detect content changes |

---

## Known Limitations

1. **Detection delay:** Tab switches within Unknown apps are detected with up to **10 seconds
   of delay**. This is a fundamental Wayland limitation — the OS provides no signal.

2. **OCR accuracy:** If OCR fails to extract meaningful text (e.g., video-heavy page, canvas
   app), the hash may not change between tabs, and tab switches go undetected.

3. **Resource usage:** Each recheck captures a full screenshot + runs OCR. On low-end hardware,
   this adds ~100-500ms of CPU time every 10 seconds while in an Unknown app.

4. **AI server dependency:** Without the AI server, the system falls back to `_infer_app_from_ocr`
   heuristics, which only recognizes known app signatures. Novel websites may remain "Unknown".

5. **Identical content tabs:** If two tabs have very similar text content (e.g., two Jira tickets
   with similar titles), they may produce the same hash and be treated as the same tab.

6. **First-capture race:** The very first tab is detected instantly (normal window switch).
   Any tab switch that happens within the first 10 seconds of entering the Unknown app won't
   be detected until the next recheck fires.

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         TRACKING LOOP (every 2s)                        │
│                                                                          │
│   ┌──────────────────┐                                                   │
│   │ get_active_window │                                                   │
│   │                    │                                                   │
│   │  AT-SPI → "Unknown"│                                                  │
│   │  window_key="unknown"│                                                │
│   └────────┬───────────┘                                                 │
│            │                                                              │
│            ▼                                                              │
│   ┌────────────────────────────────────────────┐                         │
│   │ Is current_window_key also "unknown"?       │                         │
│   │ AND elapsed >= 10 seconds?                  │                         │
│   └────────┬──────────────────┬────────────────┘                         │
│         YES│               NO │                                           │
│            ▼                  ▼                                           │
│   ┌─────────────────┐  ┌──────────────┐                                  │
│   │ RECHECK FIRES   │  │ is_new_window │                                  │
│   │ is_new_window=  │  │ = False       │                                  │
│   │ True (forced)   │  │ → skip        │                                  │
│   │ reset timer     │  └──────────────┘                                  │
│   └────────┬────────┘                                                    │
│            │                                                              │
│            ▼                                                              │
│   ┌──────────────────────────┐                                           │
│   │ process_window_event()    │                                           │
│   │                            │                                           │
│   │  classification = "unknown"│                                          │
│   │  force_ocr = True          │                                          │
│   └────────┬───────────────────┘                                         │
│            │                                                              │
│            ▼                                                              │
│   ┌──────────────────────────┐     ┌───────────────────────────────┐     │
│   │ capture_screenshot_only  │     │ session_manager.on_window_switch│    │
│   │ (force=True → no throttle)│     │ (reuses existing Unknown row) │    │
│   └────────┬─────────────────┘     └───────────────────────────────┘     │
│            │                                                              │
│            ▼                                                              │
│   ┌──────────────────────────┐                                           │
│   │ submit_ocr_async()       │                                           │
│   │ → OCR worker thread      │                                           │
│   └────────┬─────────────────┘                                           │
│            │ (async, ~2-5s)                                               │
│            ▼                                                              │
│   ┌──────────────────────────┐                                           │
│   │ _ocr_callback()          │                                           │
│   │ backfill_ocr → session   │                                           │
│   │ _maybe_classify_unknown  │                                           │
│   └────────┬─────────────────┘                                           │
│            │                                                              │
│            ▼                                                              │
│   ┌──────────────────────────────────────────────┐                       │
│   │ Hash-based dedup                              │                       │
│   │                                                │                       │
│   │ MD5(ocr_text)[:12] → app_key                  │                       │
│   │                                                │                       │
│   │ Same hash as before?                           │                       │
│   │   YES → skip (same tab, no change)             │                       │
│   │   NO  → new tab detected! ──┐                  │                       │
│   └──────────────────────────────┼─────────────────┘                     │
│                                  │                                        │
│                                  ▼                                        │
│   ┌──────────────────────────────────────────────┐                       │
│   │ _classify_unknown_app_async (background thread)│                      │
│   │                                                │                       │
│   │ 1. POST /api/classify-app → AI server          │                       │
│   │ 2. _infer_app_from_ocr (local heuristic)       │                       │
│   │ 3. update_app_info: Unknown → google-chrome     │                       │
│   │ 4. update_classification: unknown → productive  │                       │
│   │ 5. Update Supabase activity_records             │                       │
│   └──────────────────────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Summary

The periodic recheck mechanism is the **only way** to detect tab switches within Unknown
(sandboxed) apps on GNOME 46 Wayland. It replaces the impossible OS-level window title
change detection with a time-based polling + OCR content comparison approach:

1. **Timer:** Every 10s, force `is_new_window = True` for Unknown windows
2. **Screenshot:** Capture what's currently on screen (force bypasses throttle)
3. **OCR:** Extract text from the screenshot
4. **Hash:** MD5 of OCR text as dedup key — different content = different tab
5. **Classify:** AI server + local heuristics identify the actual application
6. **Update:** Rename session from "Unknown" to the real app name

The 10-second detection delay is the fundamental cost of working within Wayland's
security model, which intentionally prevents apps from observing each other's windows.
