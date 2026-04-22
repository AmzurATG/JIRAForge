# Fix: Tray Icon Version Display Clarity & Release Notes Removal

## Problem Statement

Users are confused by the system tray menu's version display. The menu item `Check for Updates (v1.4.3)` shows the **current installed version**, but users misinterpret it as the version they are updating **to**. When an update is available and the menu shows `Update Ready - Install v1.4.5`, there is no reference to the current version, making it unclear what transition is happening.

Additionally, the tray menu includes a **"View Release Notes"** item that shows release notes for the new version via a toast notification. This is unnecessary clutter in the tray menu and should be removed.

## Goals

1. **Make version transition crystal clear** — always show `Current: vX.X.X → Update Available: vY.Y.Y` when an update exists.
2. **Show "Up to Date" when no update is pending** — reassure users they're on the latest version.
3. **Remove "View Release Notes"** from the tray menu entirely.

---

## Current Behavior (Before Fix)

### Tray Menu Items by State

| Update State       | Menu Text                              | Problem                                      |
|--------------------|----------------------------------------|----------------------------------------------|
| `idle` (no update) | `Check for Updates (v1.4.3)`           | Users think v1.4.3 is the *new* version      |
| `downloading`      | `Downloading Update (45%)...`          | No version context at all                    |
| `ready`/`deferred` | `Update Ready - Install v1.4.5`        | No current version shown for comparison      |
|                    | `Later`                                |                                              |
|                    | `View Release Notes`                   | Unnecessary — to be removed                  |
| `mandatory_ready`  | `Required Update - Install v1.4.5`     | No current version shown for comparison      |
|                    | `View Release Notes`                   | Unnecessary — to be removed                  |

### Toast Notifications (No Changes Needed)

The `show_update_notification()` function (line ~645) shows toast notifications with titles like:
- `Update Available: v1.4.5`
- `Update Ready: v1.4.5`
- `Update Required: v1.4.5`
- `No Updates Available` — "You're running the latest version (v1.4.3)"

These are clear enough and don't need changes.

---

## Target Behavior (After Fix)

### Tray Menu Items by State

| Update State       | Menu Text                                                        | Action on Click       |
|--------------------|------------------------------------------------------------------|-----------------------|
| `idle` (no update) | `Up to Date (v1.4.3)`                                           | Triggers manual check |
| `downloading`      | `Downloading v1.4.5 (45%) - Current: v1.4.3`                    | Disabled (no click)   |
|                    | `Cancel Download`                                                | Cancels download      |
| `ready`/`deferred` | `Current: v1.4.3 → Update Available: v1.4.5`                    | Installs update       |
|                    | `Later`                                                          | Defers update         |
| `mandatory_ready`  | `Current: v1.4.3 → Update Available: v1.4.5 (Required)`         | Installs update       |

### Removed Items

- ~~`View Release Notes`~~ — removed from all states

---

## Files to Change

### 1. `python-desktop-app/desktop_app.py`

#### Location: Tray menu builder method (~line 10625–10670)

**Changes:**

##### a) Remove `show_release_notes_action` function (DONE)

The entire function definition was removed since it's no longer called from any menu item.

```python
# REMOVED:
def show_release_notes_action():
    info = self.update_manager.get_status().get('update_info') or {}
    latest_version = info.get('latest_version', 'unknown')
    notes = info.get('release_notes') or 'No release notes available.'
    ...
```

##### b) Update menu items for each state (DONE)

**`idle` state** — No update pending:
```python
# BEFORE:
menu_items.append(item(lambda text: f"Check for Updates (v{self.app_version})", check_updates_action))

# AFTER:
menu_items.append(item(lambda text: f"Up to Date (v{self.app_version})", check_updates_action))
```

**`downloading` state** — Download in progress:
```python
# BEFORE:
menu_items.append(item(lambda text: f"Downloading Update ({progress}%)...", lambda: None, enabled=False))

# AFTER:
menu_items.append(item(lambda text: f"Downloading v{latest} ({progress}%) - Current: v{self.app_version}", lambda: None, enabled=False))
```

**`mandatory_ready` state** — Required update ready:
```python
# BEFORE:
menu_items.append(item(lambda text: f"Required Update - Install v{latest}", install_update_action))
menu_items.append(item('View Release Notes', show_release_notes_action))  # REMOVED

# AFTER:
menu_items.append(item(lambda text: f"Current: v{self.app_version} → Update Available: v{latest} (Required)", install_update_action))
```

**`ready`/`deferred` state** — Optional update ready:
```python
# BEFORE:
menu_items.append(item(lambda text: f"Update Ready - Install v{latest}", install_update_action))
menu_items.append(item('Later', defer_update_action))
menu_items.append(item('View Release Notes', show_release_notes_action))  # REMOVED

# AFTER:
menu_items.append(item(lambda text: f"Current: v{self.app_version} → Update Available: v{latest}", install_update_action))
menu_items.append(item('Later', defer_update_action))
```

---

## What Stays Unchanged

- **Toast notifications** (`show_update_notification`) — these already show clear messaging.
- **`check_updates_action` "no update" notification** — already says "You're running the latest version (v1.4.3)".
- **UpdateManager states and logic** — no backend changes needed.
- **AI server `/api/app-version/check` endpoint** — no API changes.
- **`release_notes` field in update_info** — still fetched and stored; just not displayed in tray menu. Toast notifications may still reference it.

---

## Testing Checklist

- [ ] **No update available**: Tray shows `Up to Date (v1.4.3)`. Clicking it triggers a check and shows "No Updates Available" toast.
- [ ] **Update downloading**: Tray shows `Downloading v1.4.5 (45%) - Current: v1.4.3` (disabled) + `Cancel Download`.
- [ ] **Update ready (optional)**: Tray shows `Current: v1.4.3 → Update Available: v1.4.5` + `Later`.
- [ ] **Update ready (mandatory)**: Tray shows `Current: v1.4.3 → Update Available: v1.4.5 (Required)`.
- [ ] **No "View Release Notes"** menu item visible in any state.
- [ ] **Menu text fits** within Windows system tray menu width without truncation.
- [ ] **Lambda closures** correctly capture `self.app_version` and `latest` values (pystray uses callable text).

---

## Implementation Status

All changes have been applied to `python-desktop-app/desktop_app.py`.
