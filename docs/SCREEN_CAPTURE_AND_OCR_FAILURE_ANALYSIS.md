# Screen Capture & OCR Failure Analysis

**Date:** 2026-09-29
**Scope:** `python-desktop-app/` — `monitor_capture.py`, `capability_router.py`, `desktop_app.py` (`LocalOCRProcessor`, `SessionManager`, `process_window_event`, batch upload), `ocr/` package
**Type:** Read-only investigation. No code was changed.

---

## 1. Executive summary

Screen capture and OCR fail for a set of separate reasons that add up. Some make capture fail outright. Some make capture return a useless image (black, wrong monitor, wrong moment). Others throw away OCR results that were produced correctly.

The most important root causes, ordered by impact:

| # | Area | Root cause | Symptom seen by users |
|---|------|-----------|-----------------------|
| C-1 | Capture (Wayland) | ScreenCast portal callbacks and timeouts are scheduled on the **global default GLib context**, but the loop that waits for them runs on a **private context**. It only works when another thread (the AppIndicator tray) happens to be running the default GLib loop. | Capture hangs forever or stalls the tracking loop. This happens when the tray falls back to the `xorg` backend or the tray's main loop is busy. |
| C-2 | Capture (Wayland) | `persist_mode` / `restore_token` are passed to `CreateSession` instead of `SelectSources`, so the portal ignores them. No restore token is ever issued. | The "Share your screen" dialog appears on every app start or login. Captures fail when nobody clicks *Allow* within 30 s. |
| C-3 | Capture (Wayland) | Every capture creates a new PipeWire fd and a GStreamer pipeline and waits **3 s** before stopping. The fd is never closed. | Captures are slow (at least 3 s, up to 45 s) and use a lot of CPU. The fd leak can make capture stop working after hours ("Too many open files"). |
| C-4 | Capture (all Linux) | The all-black-image check is wrong for RGBA images, and Pillow-XCB has no check at all. | Black frames are passed to OCR, and OCR then reports "Confidence too low (0.00)". |
| C-5 | Capture (all Linux) | Linux always captures the whole desktop or a single monitor the user picked once. It is never the monitor with the focused window. The image is then downscaled to 1920 px. | On multi-monitor or HiDPI setups, text is too small to read, or it comes from the wrong screen. |
| C-6 | Capture (Linux) | Capability and availability checks are cached for the whole process lifetime. A router exception disables capture permanently. | When the app autostarts before the portal or PipeWire is ready, capture stays degraded or disabled until the app restarts. |
| C-7 | Capture timing | Capture runs synchronously inside the tracking loop and can take 3–80 s. | The screenshot and OCR text belong to a *different* window than the session they are attached to. |
| O-1 | OCR pipeline | The batch backfill processes at most 3 throttled screenshots and **silently discards the rest**. | Sessions have no OCR text. In the sample log, **262 screenshots were dropped against 321 that were processed**. |
| O-2 | OCR pipeline | Async OCR results are matched to a session by `(title, app)` after the fact. The batch can harvest the session first, and the done-event synchronisation is racy. | The OCR result is computed but never saved. |
| O-3 | OCR engine | All-or-nothing confidence gating: individual lines under the threshold are dropped, and if none remain the whole result becomes a "failure". Engine *errors* are also reported as "Confidence too low". | Intermittent empty OCR on dark themes or small or stylised text. Log messages are misleading. |
| O-4 | OCR engine | The facade singleton is rebuilt at runtime (capability router, `reset_facade`) without locking, and the RapidOCR instance is shared between threads. | Occasional exceptions, slow first OCR, and the circuit breaker opening (all OCR off for 120 s). |

Details, file references, evidence and verification steps follow.

---

## 2. How the pipeline works today

```
tracking_loop()  (desktop_app.py:14690, background thread)
  └─ process_window_event(window_info)                       desktop_app.py:11495
       ├─ classify app → private / non_productive  → NO capture, NO OCR (by design)
       └─ productive / unknown
            ├─ LocalOCRProcessor.capture_screenshot_only()    desktop_app.py:6519   ← synchronous, in tracking thread
            │     └─ monitor_capture.capture_focused_monitor()  monitor_capture.py:1898
            │           └─ Linux: _capture_linux()              monitor_capture.py:1566
            │                 order = [router preferred] + screencast → screenshot portal
            │                         → gnome D-Bus → gnome-screenshot(muted) → scrot → Pillow XCB
            ├─ SessionManager.on_window_switch(...)          (creates the session row)
            ├─ if throttled (<10 s since last OCR) → screenshot kept in memory for batch "backfill"
            └─ else submit_ocr_async() → OCR-Worker thread → extract_text_from_image()
                    → OCRFacade.extract_text()  (ocr/facade.py:490)
                        → preprocess_screenshot() (downscale to 1920 px)
                        → RapidOCR (Linux) / WinRT (Windows) → privacy filter
                    → callback → SessionManager.backfill_ocr(title, app, result)

upload batch (every 5 min)                                    desktop_app.py:~10990
  ├─ wait_for_ocr(5 s)
  ├─ backfill max 3 throttled screenshots (rest dropped)
  └─ harvest_and_clear() → upload
```

---

## 3. Screen capture findings

### C-1 — ScreenCast/Portal GLib callbacks run on the wrong main context (hang or stall)

**Files:** `monitor_capture.py:993-1297` (`_capture_screencast`), `:599-669` (`_capture_xdg_portal`), `:1394-1479` (`_capture_frame_with_gstreamer`)

Each function creates a private context and pushes it as the thread default:

```python
context = GLib.MainContext.new()
context.push_thread_default()
loop = GLib.MainLoop(context)
...
GLib.timeout_add_seconds(30, on_timeout)   # line 1290
GLib.idle_add(_create_session)             # line 1293
loop.run()                                 # line 1296
```

`GLib.idle_add`, `GLib.timeout_add` and `GLib.timeout_add_seconds` always attach to the **global default** `GMainContext`, not the thread-default one. The consequences:

- `_create_session`, which starts the whole ScreenCast handshake, never runs on `loop`. It runs only if some *other* thread is iterating the default context.
- The 30 s / 15 s safety timeouts are also on the default context, so they cannot rescue `loop.run()` either.
- In `_capture_frame_with_gstreamer`, `stop_pipeline` (`GLib.timeout_add(3000, …)`, line 1418) and the 15 s timeout (line 1475) have the same problem. The bus watch, however, *is* on the private context.

The design only works by accident. On the AppIndicator tray backend, the main thread runs a GTK/GLib main loop on the default context, so the callbacks execute *on the tray thread*.

- If pystray falls back to the `xorg` backend (`desktop_app.py:119-199` sets `PYSTRAY_BACKEND=xorg` in several branches), nothing iterates the default context. `loop.run()` then **blocks forever**, the tracking thread freezes, and no more captures or sessions are recorded.
- When the tray loop is busy (menu open, GTK work), captures are delayed by the same amount.
- It also runs D-Bus signal subscriptions and portal calls on the GTK thread from a background thread. `desktop_app.py:12243` documents this exact pattern causing `g_hash_table_lookup` assertions and crashes in the AT-SPI code.

In `_capture_xdg_portal` (line 637-662) there is an additional **race**: `Screenshot()` is called *before* subscribing to the `Response` signal. If the portal answers quickly (it does with `interactive=False`), the signal is missed. The call then waits for the timeout, which as described above may never fire.

The code also does not guarantee cleanup. `context.pop_thread_default()` and `signal_unsubscribe` are skipped when an exception is raised, and the subscriptions in `_capture_screencast` (lines 1094, 1151, 1202) are never unsubscribed. Handlers therefore pile up on the shared session bus with each attempt.

**How to verify:** run with `PYSTRAY_BACKEND=xorg` on a Wayland session and watch the tracking loop stop after the first productive window switch. Alternatively, `py-spy dump --pid <pid>` shows the tracking thread parked in `loop.run()`.

---

### C-2 — ScreenCast permission never persists (consent dialog on every start)

**File:** `monitor_capture.py:1115-1126`

```python
options = {
    'handle_token': ...,
    'session_handle_token': ...,
    'persist_mode': GLib.Variant('u', 2),           # ← wrong method
}
if _SCREENCAST_SESSION_CACHE.get('restore_token'):
    options['restore_token'] = ...                  # ← wrong method
proxy.call('CreateSession', ...)
```

In the `org.freedesktop.portal.ScreenCast` spec (v4+), `persist_mode` and `restore_token` are options of **`SelectSources`**. `CreateSession` accepts only `handle_token` and `session_handle_token`, and the portal silently ignores unknown keys. As a result:

1. The portal never persists the grant, and the `Start` response has no `restore_token`. The code logs `"ScreenCast: No restore_token in Start response - session may not persist"` (line 1067).
2. `screencast_restore_token.json` is never written, so `get_screencast_permission_status()` returns `needs_permission` on every launch.
3. `_onboard_screencast_permission()` (`desktop_app.py:13781`, called on every startup at `:15989`) shows the "share your screen" dialog on every app start.
4. At autostart or login time the user is often not looking. The dialog times out after 30 s (C-1 permitting), the capture falls through to the Screenshot portal / gnome-screenshot (flash, sound, extra dialogs), or it fails.

This is also why `SCREENCAST_PERMISSION_DIALOG_ANALYSIS.md` reported "dialog appears every time". The earlier fix added token *saving* but left the options on the wrong call.

A related problem: after an app restart, the `session_handle` loaded from disk (`:902-908`) is always dead, because portal sessions die with the D-Bus connection. The "reuse cached session" branch therefore always fails first. It logs a warning with a traceback and costs one extra D-Bus round trip on each first capture.

---

### C-3 — Each ScreenCast capture is slow, CPU-heavy, and leaks a file descriptor

**File:** `monitor_capture.py:929-945` and `1357-1507`

- **New PipeWire remote per capture.** `OpenPipeWireRemote` is called on every capture. `fd_list.get(fd_index)` returns a *duplicated* fd that the caller owns. It is passed to `pipewiresrc fd=…` (which dups it again) and never `os.close()`d. **One fd leaks per successful capture.** With a soft limit of 1024 fds and a capture on every window switch, capture can start failing after a few hours with `EMFILE` / "Too many open files". It then recovers only after the app restarts. This matches the "works in the morning, stops later" pattern.
- **Fixed 3 s recording.** The pipeline runs `pipewiresrc ! videoconvert ! pngenc ! filesink` and sends EOS 3 s after reaching PLAYING (`:1418`). `pngenc` does not have `snapshot=true`, so it encodes every frame for 3 s and `filesink` concatenates all the PNGs into one file (PIL reads only the first). That means seconds of full-resolution PNG encoding on the CPU for each capture.
- **Minimum latency of about 3 s, maximum 15 s** for the GStreamer step, plus up to 30 s for session setup.
- **Static screen.** Mutter only emits frames on damage. If the first buffer does not arrive (for example after a monitor wake), the result is an empty file and a failed capture.

---

### C-4 — Black and blank images are not detected correctly

**Files:** `monitor_capture.py:447-452, 503-509, 689-696, 956-961, 1329-1347, 1664-1671, 1684-1690`

The "all-black" check used throughout is:

```python
bands = im.split()
if any(max(array('B', b.tobytes())) > 0 for b in bands): return im
```

- For **RGBA** images the alpha band is 255, so a completely black but opaque frame **passes** the check. GNOME Shell screenshots and `pngenc` output are commonly RGBA.
- One non-zero pixel (for example the cursor or a status LED icon) is enough to pass.
- Its cost is O(pixels) in pure Python arrays for each band (tens of ms on 4K).
- The **Pillow XCB fallback** (`:1684-1690`) has **no check at all** and calls `_reset_black_image_counter()`. On Wayland it returns the XWayland root window, which is black. The failure counter is reset, and OCR then processes a black image.
- On a **locked screen** or during screen-blank, the capture methods can return the lock shield or an all-dark frame. That image is OCR'd and its (useless) text is attached to the last session.

The result for OCR is `"Confidence too low (0.00 < 0.6 threshold)"` and `method='metadata'`. That looks like an OCR failure, but it is a capture failure.

---

### C-5 — Wrong monitor or too little resolution on Linux

**Files:** `monitor_capture.py:1916-1917`, `:1172-1176`, `ocr/image_processor.py:243, 284-290`

- On Linux, `capture_focused_monitor()` ignores focus entirely (`return _capture_linux()`). All the focused-monitor logic is Windows-only.
- **ScreenCast** asks for `types=Monitor, multiple=False`, so the user picks **one** monitor in the dialog. Every later capture uses *that* monitor, even when the active window is on the other one. The OCR text then describes the wrong screen.
- **Screenshot portal, gnome-screenshot, scrot and XCB** capture the **whole desktop** across all monitors, for example 3840×1080 or 5120×1440.
- `preprocess_screenshot` then downscales so the longest side is **1920 px** (`SCREENSHOT_MAX_DIMENSION`). On a dual 1080p setup this halves the text height (about 12 px → 6 px), which is below what the RapidOCR detector reliably finds. The per-line confidence then drops under the threshold (see O-3).
- HiDPI or fractional scaling (a 4K laptop at 200 %) is also downscaled by 2×.

This alone explains most "OCR works on my laptop but not on the docked setup" reports.

---

### C-6 — Capability and availability decisions are frozen at first use

**Files:** `monitor_capture.py:530-562` (`_XDG_PORTAL_AVAILABLE`), `:710, 796-865` (`_SCREENCAST_AVAILABLE`), `capability_router.py:382-423` (`_ROUTER_PLAN`)

- The result of the portal and pipewiresrc checks is cached for the life of the process. Autostart often runs before `xdg-desktop-portal` / PipeWire / WirePlumber are up. The checks return `False` and stay `False`, so the app is stuck on the gnome-screenshot/scrot path, or has no capture at all, until it restarts. (`get_screencast_permission_status()` resets only the ScreenCast flag, not the portal flag or the router plan.)
- If `get_router_plan()` raises for any reason (for example `os_diagnostics` or the facade construction throws), the fallback plan is `capture_mode: 'disabled'` (`capability_router.py:410-421`). `_capture_linux()` then returns `None` for every capture for the rest of the session (`monitor_capture.py:1602-1605`), with only one warning line per attempt.
- **X11 sessions:** the router maps X11 to `gnome_screenshot_cli` (`capability_router.py:248-253`), and `_capture_linux()` then *also* tries the ScreenCast portal, Screenshot portal and GNOME D-Bus before reaching `scrot`. On GNOME-on-X11 the ScreenCast portal exists, so X11 users can get the consent dialog and 3 s captures, even though `scrot` or XCB would work instantly. The docstring (`:1592-1594`) says X11 uses scrot first, which is not what the code does.

---

### C-7 — Capture latency attaches OCR text to the wrong window

**Files:** `desktop_app.py:11557` (called from `tracking_loop` at `:14690`), `desktop_app.py:6519-6530`

- The capture runs **synchronously in the tracking thread**, after the window switch has already been detected. On Wayland with ScreenCast it takes at least 3 s. In the worst case, where every method in the chain fails and times out, it takes about **80 s**: 30 + 15 (ScreenCast) + 15 (portal) + 8 (D-Bus) + 8+3 (gnome-screenshot + gsettings) + 5 (scrot).
- If the user switches again during that time, the frame shows the *new* window but is saved against the *old* session. The next switch is detected late, so its session duration is wrong as well.
- **The capture still happens when OCR is throttled** (`capture_screenshot_only`: throttled branch at `:6524-6528` still calls `capture_focused_monitor()`), so every productive window switch pays the full capture cost.
- In event tracking mode, `tracking_loop` also calls `self.capture_screenshot()` (`:14775`) for the same switch. On Linux that is a *second* full capture through the same slow path.
- The capture functions are not thread-safe, but they are called from the tracking thread, the startup onboarding thread (`desktop_app.py:13851`) and the web endpoints (`/api/grant-screencast-permission`, `desktop_app.py:8508`). Concurrent calls race on `_SCREENCAST_SESSION_CACHE` and can open two portal sessions or dialogs at the same time.

---

### C-8 — Failure alerting does not work as intended

- `_check_capture_health_and_alert()` (`desktop_app.py:13885`) is **never called anywhere**, so it is dead code.
- The counter it relies on (`_CONSECUTIVE_BLACK_IMAGES`) is incremented only when *every* method fails. It is not incremented when a black image is accepted (C-4), and XCB resets it.
- By contrast, `capture_screenshot_only()` (`:6531-6545`) sends a *critical* desktop notification on **every** failed capture once the counter is ≥ 3, with no de-duplication. That produces notification spam instead of a single actionable alert.

---

## 4. OCR extraction findings

### O-1 — Throttled screenshots are silently discarded (confirmed in logs)

**File:** `desktop_app.py:~11003-11028` (batch upload), `SessionManager.get_pending_ocr_entries` at `:6050`

- OCR is throttled to one run per 10 s (`LocalOCRProcessor._min_interval`). Screenshots from rapid switches are held in memory for "backfill" at the next 5-minute batch.
- The batch backfills **at most 3** (`MAX_BACKFILL_PER_BATCH = 3`) and then `break`s. `get_pending_ocr_entries()` has already **cleared** the whole dict, so every remaining screenshot is lost for good. Those sessions are uploaded with no OCR text.

**Evidence** (`timetrackerlogs.md`, one user, one day):

| Metric | Count |
|---|---|
| `Backfill OCR cap reached` events | 67 |
| Screenshots dropped by the cap | **262** |
| Backfill OCR runs that happened | 321 |
| Async OCR dispatches | 857 |

About 45 % of throttled sessions in that log lost their OCR text because of this cap alone.

### O-2 — Async OCR results are lost before they are written

**Files:** `desktop_app.py:6492-6517` (`submit_ocr_async`, `wait_for_ocr`), `:6075-6100` (`backfill_ocr`), `:11585-11606`

- **Done-event race.** `submit_ocr_async()` clears `_ocr_done_event` for job B while job A is still running. When A finishes, the worker calls `set()`, so `wait_for_ocr()` reports "idle" while B is still queued. The `queue.Full` branch also calls `set()` while a job is running. The batch then runs `harvest_and_clear()`, the session row is deleted, and when B's callback runs, `backfill_ocr()`'s `SELECT … WHERE window_title=? AND application_name=?` finds nothing. **The result is dropped silently.**
- **5 s wait.** When OCR takes longer than 5 s (a slow CPU, the first model load, or a large image), the batch uploads without it, with the same effect.
- **Write-once guard.** `backfill_ocr()` only writes when `ocr_method` is empty (`if row and not row[1]`). A session that first got a failed result (`method='metadata'` or `'error'`, for example from a black frame) can **never** be corrected by a later successful OCR for the same window.
- **Key collision.** Results are matched by `(display_title, app)`. Two visits to the same title share one row, so the OCR from visit 1 can be attached to visit 2 or the other way round.

### O-3 — Confidence gating turns partial text into "OCR failed", and errors are mislabelled

**Files:** `ocr/engines/rapidocr_engine.py:103-114`, `ocr/facade.py:559-629`, `ocr/config.py:124`, `.env.example:78`

- RapidOCR drops every **line** below `min_confidence` (0.5 default, 0.6 in `.env.example` and the server config). The facade then requires the **average** of the remaining lines to be ≥ `min_confidence`.
- If no line passes, for example with small text after downscaling (C-5), dark or low-contrast themes, stylised fonts, or anti-aliased text on a coloured background, the text is empty with confidence 0. The facade then records the whole capture as a failure: `"Confidence too low (0.00 < 0.6 threshold)"`, `method='metadata'`.
- When lines partially pass, low-confidence lines are **silently removed**. Code editors and dark IDEs lose many lines this way.
- **Misleading errors.** When RapidOCR *throws* internally, it catches the exception and returns `_create_error_result` (`success=False`, confidence 0). The facade handles that in the *same* branch as low confidence, so real errors are logged as "Confidence too low (0.00 …)". They also **never count towards the circuit breaker**, and the actual exception text never reaches `ocr_error_message`.
- A blank screen (desktop wallpaper, video) is also reported as a failure rather than "no text".

### O-4 — Facade and engine lifecycle is not thread-safe

**Files:** `ocr/facade.py:791-808`, `capability_router.py:125`, `desktop_app.py:798` (`set_runtime_ocr_config` → `reset_facade`)

- `get_facade(config)` **creates a new singleton whenever `config` is not None**. `collect_capability_signature()` always passes a config, so the first Linux capture (which calls `get_router_plan()` from the tracking thread) replaces the facade that the OCR worker may be using at that moment. That also reloads the Presidio privacy filter, which takes seconds.
- `reset_facade()` after the runtime OCR config is fetched does the same thing asynchronously. The next OCR call pays the full engine and model initialisation cost, and in that time the 5 s `wait_for_ocr` window (O-2) is easily exceeded.
- `get_facade()` has no lock, so two threads (the OCR worker and the batch backfill) can both construct facades at once.
- One `RapidOCR` instance is used concurrently by the OCR worker thread, the batch backfill (`ocr_from_image`, which runs on the batch thread) and the `capture_and_ocr()` fallback. RapidOCR's Python pipeline is not documented as thread-safe. Intermittent exceptions from this open the circuit breaker: **three exceptions disable the engine for 120 s** (`facade.py:635-641`). On Linux there is effectively only one engine: `winrtocr` is filtered out and replaced with `easyocr`/`tesseract` (`ocr/config.py:330-338`), which are usually not installed. So **all OCR fails for 2 minutes**.
- If `RapidOCR()` instantiation fails (missing models in the AppImage, broken cv2), `_get_ocr()` retries a full instantiation **on every call** (`rapidocr_engine.py:71-83`), and every call returns an error that is mislabelled as low confidence (O-3).

### O-5 — Image format and preprocessing issues

**File:** `ocr/image_processor.py`

- `preprocess_screenshot` is **defined twice** (lines 68 and 246), so the second definition wins. The second one uses `cv2` unconditionally, without the `_CV2`/PIL fallback the first one has. With a broken or missing OpenCV (the case `_validate_cv2_runtime` warns about at `desktop_app.py:6385`), resizing throws. The code then falls back to the *full-size* array, and RapidOCR (which needs cv2 itself) fails.
- Images are passed to RapidOCR as **RGB or RGBA numpy arrays**. RapidOCR/OpenCV expect **BGR**. Channel order has only a small effect on recognition, but RGBA arrays from PNG captures add an extra conversion path and memory copy per call.

### O-6 — Output truncation (text is "missing" but not failed)

- `OCRFacade.MAX_OCR_LINES = 40` (`facade.py:488`) and a hard 2000-character cap (`desktop_app.py:6441, 6637, 6688`) cut the text. Issue keys or task context further down the screen never reach the AI server.
- **Windows WinRT engine:** it joins all lines with spaces into one line and hard-codes confidence to `1.0` (`winrtocr_engine.py:146-157`). Every log line shows `lines: 1, confidence: 1.00`, 1178 times in the sample log. The line cap never applies, but the confidence value carries no information, and the 2000-char cap cuts through the middle of the screen.

### O-7 — Cases where "no OCR" is expected (not bugs)

These cases produce no OCR by design and should be excluded when measuring failure rates:

- Apps classified `private` or `non_productive` get no capture or OCR (`desktop_app.py:11530-11538`).
- Sessions shorter than 5 s are dropped at harvest.
- Capture is skipped while the screen is locked or idle.

---

## 5. How to reproduce and verify each finding

| Finding | Quick check |
|---|---|
| C-1 | `PYSTRAY_BACKEND=xorg ./TimeTracker.AppImage` on Wayland, then switch to a productive app. The tracking loop stops logging. `py-spy dump` shows `loop.run()` in `_capture_screencast`. |
| C-2 | `grep "No restore_token in Start response" ~/.local/share/TimeTracker/logs/*`. `~/.config/timetracker/screencast_restore_token.json` is missing after granting. The dialog reappears on the next launch. |
| C-3 | `watch -n60 'ls /proc/$(pgrep -f TimeTracker)/fd \| wc -l'`. The count grows by about 1 per capture. `top` shows CPU spikes of about 3 s per window switch. |
| C-4 | Lock the screen for 1 minute, or force the XCB fallback on Wayland. Sessions get `ocr_method='metadata'` with "Confidence too low (0.00 …)". |
| C-5 | With two monitors, log the `size` of the captured image before OCR; it is 3840 px wide or more. Compare OCR line count with one monitor unplugged. |
| C-6 | Enable autostart and log in. The first log lines show `ScreenCast unavailable` / `XDG Desktop Portal Screenshot available: False`, and captures stay degraded for the whole session. |
| C-7 | Alt-Tab twice within 3 s. The OCR text of session A contains window B's content. |
| O-1 | `grep -c "Backfill OCR cap reached"`, and add up `skipping remaining N entries`. |
| O-2 | Count `[OCR-ASYNC] Dispatched` against rows with a non-null `ocr_method` after upload. Look for batches that start within about 1 s of a dispatch. |
| O-3 | Open a dark-theme IDE with 11–12 px font on a 1080p×2 setup and inspect `ocr_error_message`. |
| O-4 | Log lines `OCR engine 'rapidocr' failed 3 consecutive times … circuit breaker open`, and repeated `OCR DIAGNOSTICS REPORT` banners (each facade rebuild prints one). |

---

## 6. Recommended fixes (priority order, for a follow-up spec)

The project workflow requires a spec in `plan/` and failing tests before any code change. These are the directions to cover in that spec. **None of them has been applied.**

1. **(C-1) Correct GLib context usage.** Attach every source to the private context (`GLib.idle_source_new()`/`GLib.timeout_source_new()` + `source.attach(context)`, or `context.invoke_full`). Subscribe to the portal `Response` signal *before* calling the method (use `handle_token` to compute the request path). Unsubscribe and `pop_thread_default()` in `finally`. Better still, move all portal and GStreamer work to one dedicated capture thread that owns its own main loop.
2. **(C-2) Move `persist_mode=2` and `restore_token` into the `SelectSources` options.** Save the new token returned by every `Start` (tokens are single-use). Stop persisting `session_handle`/`node_id` to disk.
3. **(C-3) Keep one ScreenCast stream open** and grab the latest buffer with `appsink` (`max-buffers=1 drop=true`) instead of a 3 s pipeline per capture. At minimum, use `pngenc snapshot=true` or `num-buffers=1`, and `os.close()` the fd from `OpenPipeWireRemote`.
4. **(C-4) Real blank detection.** Convert to `L`, ignore alpha, and treat the image as blank when the pixel standard deviation or histogram spread is near zero. Apply the check to every method, XCB included, and count those frames as failures.
5. **(C-5) Crop to the focused window's monitor on Linux,** using the GNOME Shell introspect / `xdotool` geometry that the app already gathers for window titles. Alternatively, do not downscale below native text size: tile the image, or raise `SCREENSHOT_MAX_DIMENSION` when the width exceeds a single monitor.
6. **(O-1, O-2) Make OCR results durable.** Keep the pending entries that were not processed (re-queue them instead of clearing). Store OCR results keyed by a session *id* captured at dispatch time. Track in-flight jobs with a counter or `queue.join()` instead of one `Event`. Allow a successful OCR to overwrite a failed one.
7. **(O-3) Separate the outcomes** "no text", "low confidence" and "engine error" in the result. Raise or propagate engine exceptions so the circuit breaker and `ocr_error_message` see them. Keep partially passing text instead of discarding everything.
8. **(O-4) Protect the facade with a lock.** Do not rebuild it from the capability router (use `get_facade()` without a config, or a separate diagnostic instance). Serialise engine calls with a lock or run all OCR on the single worker thread, including the backfill.
9. **(C-6) Re-evaluate capability caches** after failures or after N minutes, and never permanently disable capture because of a router exception.
10. **(C-7) Move capture off the tracking thread,** and skip capture entirely when OCR is throttled and the previous frame is recent. Remove the second `capture_screenshot()` for the same switch.
11. **(C-8) Wire up `_check_capture_health_and_alert()`** with de-duplication, and count accepted blank frames as failures.
12. **(O-5, O-6) Remove the duplicate `preprocess_screenshot`,** convert to 3-channel BGR before inference, and revisit the 40-line and 2000-character caps. Rank lines by position or relevance instead of plain truncation.
