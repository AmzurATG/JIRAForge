# Plan: Tray Menu Button Removal & Notification Click Fixes

**Branch:** `feature/smart-auto-update-installer3`  
**Date:** April 23, 2026  
**Status:** Implemented & Tested

---

## Problem Statement

Three issues were identified in the desktop app's auto-update UX:

1. **Unwanted tray menu buttons:** "Cancel Download", "Later", and "Release Notes" buttons in the system tray icon menu should be removed to simplify the update flow.
2. **Notification click does nothing:** When update notifications appear (downloading, ready to install), clicking them does not trigger any action — the user must manually open the tray icon and click the install button.
3. **No automated test coverage** for tray menu composition or notification click behavior.

---

## Scope of Changes

### File Modified
- `python-desktop-app/desktop_app.py`

### File Created
- `python-desktop-app/tests/test_tray_menu_and_notifications.py`

---

## Fix 1: Remove Tray Menu Buttons

### What Changed
**Location:** `TimeTracker._build_tray_menu()` method (~line 10624)

#### Before
| Update State | Menu Items Shown |
|---|---|
| `downloading` | Progress label (disabled) + **Cancel Download** button |
| `ready` / `deferred` | Install action + **Later** button |
| `mandatory_ready` | Install action (no Later — already correct) |
| `idle` | "Up to Date" / Check Updates |

#### After
| Update State | Menu Items Shown |
|---|---|
| `downloading` | Progress label (disabled) — no Cancel |
| `ready` / `deferred` | Install action only — no Later |
| `mandatory_ready` | Install action only (unchanged) |
| `idle` | "Up to Date" / Check Updates (unchanged) |

### Removed Code
```python
# REMOVED: cancel_download_action and defer_update_action callbacks
def cancel_download_action():
    self.update_manager.cancel_download()

def defer_update_action():
    self.update_manager.defer_update()

# REMOVED: "Cancel Download" menu item in downloading state
menu_items.append(item('Cancel Download', cancel_download_action))

# REMOVED: "Later" menu item in ready/deferred state
menu_items.append(item('Later', defer_update_action))
```

### Impact
- Users can no longer cancel an in-progress download from the tray menu
- Users can no longer defer updates via the tray menu
- The `UpdateManager.cancel_download()` and `UpdateManager.defer_update()` methods are **not removed** — they remain available for programmatic use
- "Release Notes" was confirmed to have never existed as a tray menu button (only used in notification message text)

---

## Fix 2: Notification Click → Install Action

### Problem
`show_update_notification()` used `winotify.Notification` but never added any click actions via `notification.add_actions()`. Notifications were purely informational — clicking them did nothing.

### Solution
Four changes were made:

#### 2a. Added `web_port` and `install_callback` parameters to `show_update_notification()`
**Location:** `show_update_notification()` function (~line 645)

```python
# Before:
def show_update_notification(update_info, callback=None, state='available'):

# After:
def show_update_notification(update_info, callback=None, state='available', web_port=None, install_callback=None):
```

The "Install Now" button is only added when **both** `install_callback` is provided **and** the state is `ready` or `mandatory_ready`:

```python
if install_callback and state in ('ready', 'mandatory_ready'):
    install_url = f"http://localhost:{web_port}/api/update/install" if web_port else None
    if install_url:
        notification.add_actions(label="Install Now", launch=install_url)
```

This ensures:
- **`downloading`** notifications have no action button (no URL opened)
- **`failed`** notifications have no action button
- Only `ready`/`mandatory_ready` show the "Install Now" button

#### 2b. Updated notification messages
| State | Old Message | New Message |
|---|---|---|
| `ready` | "...Open tray menu to install now." | "...Click Install Now to update." |
| `mandatory_ready` | "...Tracking paused until updated." | "...Click Install Now to update." |
| `downloading` | (unchanged) | (unchanged) |
| `failed` | (unchanged) | (unchanged) |

#### 2c. Added `/api/update/install` Flask route with auto-closing browser tab
**Location:** `TimeTracker.setup_routes()` method (~line 5947)

New endpoint that handles the notification click action. The browser tab **auto-closes after 1.5 seconds** via `window.close()` JavaScript so users don't see a lingering browser page:

```
GET /api/update/install
```

| Current State | Behavior | Response |
|---|---|---|
| `ready` / `mandatory_ready` / `deferred` | Triggers `apply_update()` in a daemon thread | Auto-closing page: "Installing update..." |
| `downloading` | No action (download still in progress) | Auto-closing page: "Download in progress ({progress}%)" |
| `idle` / other | No action | Auto-closing page: "No update available" |
| No update manager | Error | Auto-closing page with 503 status |

All responses include:
- `<script>setTimeout(function(){window.close()},1500)</script>` to auto-close the tab
- "This tab will close automatically." message as fallback

#### 2d. Updated state change callback to pass `web_port` and `install_callback`
**Location:** `TimeTracker._on_update_manager_state_changed()` (~line 5028)

```python
# Before:
show_update_notification(update_info, state=state)

# After:
show_update_notification(
    update_info,
    state=state,
    web_port=self.web_port,
    install_callback=self.update_manager.apply_update if self.update_manager else None
)
```

### User Flow After Fix
1. Update is downloaded → "Update Ready" notification appears with **"Install Now"** button
2. User clicks "Install Now" → browser tab opens briefly, triggers `apply_update()`
3. Browser tab auto-closes after 1.5 seconds
4. App exits, updater script runs, app restarts with new version

**Note:** The `downloading` notification does **not** open any URL or show any action button — it is purely informational.

---

## Fix 3: Automated Test Suite

### File: `tests/test_tray_menu_and_notifications.py`

**28 tests** across 9 test classes:

| # | Test Class | Tests | What It Validates |
|---|---|---|---|
| 1 | `TestTrayMenuCancelDownloadRemoved` | 2 | No "Cancel Download" in downloading state; progress label is disabled |
| 2 | `TestTrayMenuLaterRemoved` | 3 | No "Later" in ready, deferred, or mandatory_ready states |
| 3 | `TestTrayMenuReleaseNotesRemoved` | 5 | No "Release Notes" in any state (idle, downloading, ready, deferred, mandatory_ready) |
| 4 | `TestTrayMenuInstallAction` | 2 | Install action present in ready and mandatory_ready states |
| 5 | `TestNotificationInstallAction` | 5 | "Install Now" button added for ready/mandatory_ready; not added for downloading/failed/no-callback |
| 6 | `TestNotificationMessageText` | 3 | Correct notification message text for ready, mandatory_ready, downloading |
| 7 | `TestUpdateInstallRoute` | 4 | Flask route triggers install when ready; returns progress when downloading; returns no-update when idle; returns 503 with no manager |
| 8 | `TestStateChangeNotificationPort` | 1 | `_on_update_manager_state_changed` passes `web_port` and `install_callback` to notification |
| 9 | `TestTrayMenuItemCount` | 3 | Exact menu item count for idle (4), ready (4), downloading (4) — confirms no extra buttons |

### Test Approach
- **Tray menu tests** use a `FakeMenuItem`/`FakeMenu` to capture pystray menu construction without requiring a real system tray
- **Notification tests** use `unittest.mock.patch` to mock `winotify.Notification` and verify `add_actions` calls
- **Route tests** use Flask's `test_client()` to test the HTTP endpoint in isolation
- **State callback tests** use `MagicMock` to verify the correct parameters are passed through

### Running Tests
```bash
cd python-desktop-app
.\venv\Scripts\activate
python -m pytest tests/test_tray_menu_and_notifications.py -v
python -m pytest tests/test_update_manager.py -v  # existing tests (regression check)
```

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Users can no longer cancel downloads | Downloads are background operations and complete quickly; cancellation was rarely needed |
| Users can no longer defer updates | Updates only auto-install when the user explicitly clicks "Install Now"; the app doesn't force-install |
| `/api/update/install` route is unauthenticated | Route is bound to `127.0.0.1` (localhost only) — not accessible from external machines |
| Notification click opens browser briefly | The browser tab auto-closes after 1.5 seconds via `window.close()` JavaScript; user barely sees it |
| `defer_update()`/`cancel_download()` methods left in UpdateManager | Kept for backward compatibility and potential future use; no dead code risk since they're part of the manager's public API |

---

## Verification Checklist

- [x] "Cancel Download" button removed from tray menu
- [x] "Later" button removed from tray menu
- [x] "Release Notes" button confirmed absent from tray menu
- [x] Notification shows "Install Now" button for ready/mandatory_ready states
- [x] Clicking "Install Now" triggers update installation via Flask route
- [x] Downloading notification does NOT show install button
- [x] Failed notification does NOT show install button
- [x] `web_port` and `install_callback` correctly passed through state change callback
- [x] Browser tab auto-closes after triggering install
- [x] Downloading notification does NOT open any URL or action
- [x] All 28 new tests passing
- [x] All 7 existing update manager tests passing (no regressions)
