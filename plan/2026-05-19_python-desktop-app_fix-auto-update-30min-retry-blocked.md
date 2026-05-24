# Fix: 30-Minute Download Retry Silently Blocked by 4-Hour Cooldown

**Date:** 2026-05-19  
**Component:** `python-desktop-app`  
**Type:** Bug Fix  
**File:** `python-desktop-app/desktop_app.py`  
**Status:** Fixed

---

## Problem

When the desktop app's update download fails (network timeout, checksum mismatch, size mismatch, etc.), the `UpdateManager` transitions to a `'failed'` state and shows a toast notification:

> *"Failed to download update: \<error\>. Will retry automatically."*

The user reasonably expects the retry to happen within 30 minutes. However, the retry **never fires** — the download stays failed until the next 4-hour periodic check cycle.

---

## Root Cause

The retry mechanism was implemented across two layers that were never wired together correctly.

### Layer 1 — UpdateManager (correctly implemented)

`UpdateManager` has two members added as part of Fix #6 from the auto-update failure implementation plan:

```python
# UpdateManager.__init__  (line ~1237)
self._last_download_attempt = 0       # Timestamp of last download start
self._download_retry_interval = 30 * 60  # 30 minutes in seconds
```

`_last_download_attempt` is set at the moment a download begins (line ~1327):

```python
# Record download attempt time for retry logic
self._last_download_attempt = time.time()
```

`should_retry_download()` (line ~1432) checks both conditions:

```python
def should_retry_download(self):
    if self.state != 'failed':
        return False
    if self._last_download_attempt == 0:
        return False
    time_since_last_attempt = time.time() - self._last_download_attempt
    if time_since_last_attempt >= self._download_retry_interval:
        return True
    return False
```

This logic is correct and complete.

### Layer 2 — Tracking loop (the broken wiring)

The tracking loop (line ~10363) evaluates `should_retry_download()` and, when True, calls:

```python
# BEFORE (broken)
if should_check_normal or should_retry_download:
    self.check_for_app_updates(show_notification=True)
```

`check_for_app_updates` is called **without** `force=True`.

### Why `force=True` is critical here

Inside `check_for_app_updates` (line ~5296) there is a 4-hour cooldown guard:

```python
if not force and (current_time - self.last_version_check_time) < self.version_check_interval:
    return self.latest_version_info   # ← EARLY EXIT
```

`version_check_interval = 4 * 60 * 60` (14,400 seconds).  
`last_version_check_time` was set at most 30 minutes ago (when the download first ran).

**Evaluation when retry fires at 30 minutes:**

| Variable | Value |
|---|---|
| `force` | `False` |
| `current_time - last_version_check_time` | ~1,800 s (30 min) |
| `version_check_interval` | 14,400 s (4 hours) |
| `1800 < 14400` | **True → early return** |

The method returns the cached `latest_version_info` immediately. `check_for_updates()` is never called. `check_and_download()` is never called. **The retry is completely dead.**

### Execution trace (before fix)

```
[30 min after failed download]
  tracking_loop:
    should_retry_download() → True   ✅
    check_for_app_updates(show_notification=True)   ← no force=True
      check_connectivity() → True
      not force=False and 1800 < 14400 → True
        return self.latest_version_info   ← EARLY EXIT, retry silently skipped
```

---

## Fix

Split the single `if … or …` branch into two separate paths so the retry path explicitly passes `force=True`:

**File:** `python-desktop-app/desktop_app.py` — tracking loop (line ~10363)

### Before

```python
# Check for app updates OUTSIDE idle block (every 4 hours by default, or 30 min if last download failed)
# Update check and download happen in background, installation waits for user to be active
should_check_normal = time.time() - self.last_version_check_time > self.version_check_interval
should_retry_download = self.update_manager and self.update_manager.should_retry_download()

if should_check_normal or should_retry_download:
    self.check_for_app_updates(show_notification=True)
```

### After

```python
# Check for app updates OUTSIDE idle block (every 4 hours by default, or 30 min if last download failed)
# Update check and download happen in background, installation waits for user to be active
should_check_normal = time.time() - self.last_version_check_time > self.version_check_interval
should_retry_download = self.update_manager and self.update_manager.should_retry_download()

if should_check_normal:
    self.check_for_app_updates(show_notification=True)
elif should_retry_download:
    # force=True is required here — without it, check_for_app_updates returns
    # cached info early because the 4-hour cooldown hasn't elapsed yet (only 30 min has)
    print("[INFO] Retrying failed update download (30-minute retry interval)...")
    self.check_for_app_updates(show_notification=True, force=True)
```

### Why this works

With `force=True`, the cooldown guard inside `check_for_app_updates` is bypassed:

```python
if not force and ...:   # not True → condition is False → guard skipped
```

The method proceeds to call `check_for_updates()` (the live API call) and then `update_manager.check_and_download(update_info)`, which restarts the download from scratch.

---

## Full Retry Timeline (after fix)

| Event | Time | Action |
|---|---|---|
| Download starts | T+0 | `_last_download_attempt = time.time()` |
| Download fails | T+~Xs | `state = 'failed'`, user toast shown |
| Retry check fires | T+30 min | `should_retry_download() → True` |
| `check_for_app_updates(force=True)` | T+30 min | Bypasses 4-hour guard |
| API re-queried | T+30 min | Fresh `check_for_updates()` call |
| Download restarted | T+30 min | `check_and_download()` called |

---

## Affected Scenarios

| Failure cause | Retried after 30 min? |
|---|---|
| Network timeout during download | ✅ Yes |
| Connection reset mid-download | ✅ Yes |
| Checksum verification failed | ✅ Yes |
| Downloaded size mismatch | ✅ Yes |
| Server 4xx/5xx during download | ✅ Yes |

---

## No Regression Risk

- The `should_check_normal` path is unchanged — normal 4-hour checks behave identically to before.
- The `elif` ensures only one branch fires per loop iteration.
- `should_retry_download()` returns `False` for all states other than `'failed'`, so there is no interference with normal download or install flows.
- `force=True` only bypasses the interval guard inside `check_for_app_updates`; all other logic (connectivity check, version comparison, `check_and_download` deduplication) runs as normal.
