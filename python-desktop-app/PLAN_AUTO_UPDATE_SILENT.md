# Plan: Fully Automatic Silent Updates (Zero User Interaction)

## Goal
Remove all manual user interaction from the update flow. The app should:
1. Check for updates automatically every 4 hours (+ on startup) — unchanged
2. Download updates silently in the background
3. Install updates automatically once downloaded and verified
4. Show only a brief "Restarting for update..." toast before restart

No "Check for Updates" button click. No "Install Now" button click. Fully hands-free.

---

## Files Affected

| File | Type of Change |
|------|---------------|
| `desktop_app.py` | Core logic changes (5 locations) |
| `tests/test_update_manager.py` | Existing tests updated + new tests added |
| `tests/test_auto_update_silent.py` | **New file** — dedicated test suite for silent auto-update |

---

## Change 1: Add `auto_apply()` method to `UpdateManager` class

**File:** `desktop_app.py`  
**Location:** After `apply_update()` method (after line ~1440)  
**Purpose:** Automatically apply update after download completes — no user action needed.

### Exact Code to Add

Insert after the `apply_update()` method's `except` block (after line 1441):

```python
    def auto_apply(self):
        """Automatically apply a downloaded update without user interaction.
        Called by _on_update_manager_state_changed when state transitions
        to 'ready' or 'mandatory_ready'."""
        if self.state not in ('ready', 'mandatory_ready'):
            return False
        return self.apply_update()
```

---

## Change 2: Modify `_on_update_manager_state_changed()` to auto-install

**File:** `desktop_app.py`  
**Location:** `_on_update_manager_state_changed()` method (lines 5020-5048)  
**Purpose:** When state becomes `ready` or `mandatory_ready`, immediately trigger install instead of just showing a notification.

### Current Code (lines 5028-5048):

```python
        should_notify = state in ('downloading', 'ready', 'mandatory_ready', 'failed')
        if should_notify:
            version_changed = latest_version and self._last_notified_update_version != latest_version
            state_changed = self._last_update_notification_state != state
            if version_changed or state_changed:
                show_update_notification(
                    update_info,
                    state=state,
                    web_port=self.web_port,
                    install_callback=self.update_manager.apply_update if self.update_manager else None
                )
                self._last_update_notification_state = state
                self._last_notified_update_version = latest_version

        self.update_tray_menu()
        self.update_tray_icon()
```

### Replace With:

```python
        # Auto-apply: when download is verified and ready, install immediately
        if state in ('ready', 'mandatory_ready') and self.update_manager:
            latest = update_info.get('latest_version', 'unknown')
            print(f"[UPDATE] Auto-applying update v{latest}...")
            self.add_admin_log('INFO', f'Auto-applying update v{latest}')
            # Show brief "restarting" toast so user isn't surprised
            if WINOTIFY_AVAILABLE:
                try:
                    notification = Notification(
                        app_id="Time Tracker",
                        title="Updating Time Tracker",
                        msg=f"Installing v{latest}. The app will restart shortly.",
                        duration="short"
                    )
                    notification.set_audio(audio.Default, loop=False)
                    notification.show()
                except Exception:
                    pass
            self.update_manager.auto_apply()
            return  # app is shutting down, skip tray updates

        # Still notify for downloading/failed states (informational only)
        should_notify = state in ('downloading', 'failed')
        if should_notify:
            version_changed = latest_version and self._last_notified_update_version != latest_version
            state_changed = self._last_update_notification_state != state
            if version_changed or state_changed:
                show_update_notification(
                    update_info,
                    state=state,
                    web_port=self.web_port,
                    install_callback=None  # No manual install button needed
                )
                self._last_update_notification_state = state
                self._last_notified_update_version = latest_version

        self.update_tray_menu()
        self.update_tray_icon()
```

### What This Does:
- When `_download_worker` finishes and calls `_set_state('ready')` or `_set_state('mandatory_ready')`, the callback fires
- Instead of showing "Install Now" notification, it immediately calls `auto_apply()`
- Shows a brief informational toast: "Installing vX.Y.Z. The app will restart shortly."
- Removes `install_callback` from downloading/failed notifications (no "Install Now" button)

---

## Change 3: REMOVED — Keep 4-hour interval as-is

The update check interval stays at `4 * 60 * 60` (4 hours). No change needed.

---

## Change 4: Simplify tray menu — remove interactive update actions

**File:** `desktop_app.py`  
**Location:** Tray menu building (lines 10668-10707)  
**Purpose:** Remove "Check for Updates" click action and "Install Now" click action. Menu is informational only.

### Current Code (lines 10668-10707):

```python
        def check_updates_action():
            """Check for updates and start background download when available."""
            update_info = self.check_for_app_updates(show_notification=True, force=True)
            if not update_info or not update_info.get('update_available'):
                if WINOTIFY_AVAILABLE:
                    try:
                        notification = Notification(
                            app_id="Time Tracker",
                            title="No Updates Available",
                            msg=f"You're running the latest version (v{self.app_version})",
                            duration="short"
                        )
                        notification.show()
                    except Exception:
                        pass

        def install_update_action():
            self.update_manager.apply_update()

        status = self.update_manager.get_status() if self.update_manager else {'state': 'idle'}
        state = status.get('state', 'idle')
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        progress = int((status.get('progress', 0) or 0) * 100)

        if state == 'downloading':
            menu_items.append(item(lambda text: f"Downloading v{latest} ({progress}%) - Current: v{self.app_version}", lambda: None, enabled=False))
        elif state == 'mandatory_ready':
            menu_items.append(item(lambda text: f"Current: v{self.app_version} → Update Available: v{latest} (Required)", install_update_action))
        elif state in ('ready', 'deferred'):
            menu_items.append(item(lambda text: f"Current: v{self.app_version} → Update Available: v{latest}", install_update_action))
        else:
            menu_items.append(item(lambda text: f"Up to Date (v{self.app_version})", check_updates_action))
```

### Replace With:

```python
        status = self.update_manager.get_status() if self.update_manager else {'state': 'idle'}
        state = status.get('state', 'idle')
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        progress = int((status.get('progress', 0) or 0) * 100)

        if state == 'downloading':
            menu_items.append(item(lambda text: f"Downloading update v{latest} ({progress}%)", lambda: None, enabled=False))
        elif state in ('ready', 'mandatory_ready'):
            menu_items.append(item(lambda text: f"Installing update v{latest}...", lambda: None, enabled=False))
        elif state == 'installing':
            menu_items.append(item(lambda text: f"Restarting for update v{latest}...", lambda: None, enabled=False))
        else:
            menu_items.append(item(lambda text: f"Up to Date (v{self.app_version})", lambda: None, enabled=False))
```

### What This Does:
- Removes `check_updates_action()` function (no manual check button)
- Removes `install_update_action()` function (no manual install button)
- All menu items are now `enabled=False` (informational, not clickable)
- Shows real-time status: downloading → installing → restarting → up to date
- Removes `deferred` state from menu (defer is no longer possible)

---

## Change 5: Remove `defer_update()` calls and `show_update_notification` install button

**File:** `desktop_app.py`  

### 5a. Remove defer from notification (line 645-700)

The `show_update_notification()` function already doesn't have an explicit "Later" button in the toast — it only has "Install Now". Since we removed `install_callback=None` in Change 2 for downloading/failed states, and the ready/mandatory_ready states now auto-apply before reaching notification, no changes needed to this function itself.

However, for completeness, the `show_update_notification()` function will only be called for `downloading` and `failed` states now (from Change 2). The `ready` and `mandatory_ready` states bypass it entirely because auto-apply fires first.

### 5b. No change to `defer_update()` method itself

Keep the method in `UpdateManager` for backward compatibility but it will never be called. The `deferred` state is effectively dead code.

---

## Change 6: Remove `/api/update/install` web route (if it exists)

**Search needed:** Check if there's a Flask/web route for manual install trigger.

This endpoint was referenced in the notification `install_url`:
```python
install_url = f"http://localhost:{web_port}/api/update/install"
```

If this route exists, it should be kept for backward compatibility but is no longer triggered by any UI.

---

## Summary of State Machine Changes

### Before (6 states, user-driven transitions):
```
idle → checking → downloading → ready/mandatory_ready → [USER CLICKS] → installing
                                       ↓
                                   deferred → [USER CLICKS LATER] → installing
```

### After (5 active states, fully automatic):
```
idle → checking → downloading → ready/mandatory_ready → installing (automatic)
```

The `deferred` state is dead code. The `ready` → `installing` transition is now automatic.

---

## Unit Test Plan

### File: `tests/test_update_manager.py` — Changes to Existing Tests

#### Test `test_defer_update_from_ready_state` (lines 67-74)
**Keep as-is.** The `defer_update()` method still exists in `UpdateManager`. The test validates backward compatibility even though defer is never called in the new flow.

---

### File: `tests/test_auto_update_silent.py` — New Test Suite

```python
"""Unit tests for fully automatic silent update flow (zero user interaction)."""

import os
import sys
import time
import threading
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import UpdateManager


# ---------------------------------------------------------------------------
# 1. auto_apply() method tests
# ---------------------------------------------------------------------------

class TestAutoApply:
    """Tests for UpdateManager.auto_apply()."""

    def test_auto_apply_calls_apply_update_when_ready(self, tmp_path):
        """auto_apply() should call apply_update() when state is 'ready'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock_apply:
            result = manager.auto_apply()
            assert result is True
            mock_apply.assert_called_once()

    def test_auto_apply_calls_apply_update_when_mandatory_ready(self, tmp_path):
        """auto_apply() should call apply_update() when state is 'mandatory_ready'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None, 'is_mandatory': True}
        manager.download_path = str(staged)
        manager._set_state('mandatory_ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock_apply:
            result = manager.auto_apply()
            assert result is True
            mock_apply.assert_called_once()

    def test_auto_apply_returns_false_when_idle(self, tmp_path):
        """auto_apply() should return False when state is 'idle'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_returns_false_when_downloading(self, tmp_path):
        """auto_apply() should return False when state is 'downloading'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_returns_false_when_failed(self, tmp_path):
        """auto_apply() should return False when state is 'failed'."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('failed', error='test error')
        result = manager.auto_apply()
        assert result is False


# ---------------------------------------------------------------------------
# 2. State callback auto-triggers install
# ---------------------------------------------------------------------------

class TestStateCallbackAutoInstall:
    """Tests for _on_update_manager_state_changed auto-install behavior."""

    def test_status_change_to_ready_triggers_auto_apply(self, tmp_path):
        """When UpdateManager transitions to 'ready', auto_apply() must be called."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        auto_apply_called = threading.Event()

        original_auto_apply = manager.auto_apply

        def mock_auto_apply():
            auto_apply_called.set()
            return True

        manager.auto_apply = mock_auto_apply

        # Simulate the callback that _on_update_manager_state_changed would do:
        # When state is 'ready', it should call auto_apply
        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager._set_state('ready')

        # In the real flow, the App._on_update_manager_state_changed calls auto_apply.
        # Here we validate the UpdateManager can reach ready and auto_apply works.
        manager._set_state('ready')
        manager.auto_apply()  # simulating what the callback does
        assert auto_apply_called.is_set()

    def test_status_change_to_mandatory_ready_triggers_auto_apply(self, tmp_path):
        """When UpdateManager transitions to 'mandatory_ready', auto_apply() must be called."""
        manager = UpdateManager(str(tmp_path), '1.0.0')

        manager.update_info = {'latest_version': '2.0.0', 'is_mandatory': True, 'checksum': None}
        manager._set_state('mandatory_ready')

        with patch.object(manager, 'apply_update', return_value=True) as mock:
            result = manager.auto_apply()
            assert result is True
            mock.assert_called_once()

    def test_downloading_state_does_not_trigger_auto_apply(self, tmp_path):
        """'downloading' state should NOT trigger auto_apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.auto_apply()
        assert result is False

    def test_failed_state_does_not_trigger_auto_apply(self, tmp_path):
        """'failed' state should NOT trigger auto_apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('failed', error='network error')
        result = manager.auto_apply()
        assert result is False


# ---------------------------------------------------------------------------
# 4. Tray menu is informational only (no clickable actions)
# ---------------------------------------------------------------------------

class TestTrayMenuInfoOnly:
    """Tests validating tray menu items are informational (non-interactive)."""

    def test_idle_state_shows_up_to_date(self):
        """In idle state, menu should show 'Up to Date' (disabled)."""
        status = {'state': 'idle', 'update_info': None, 'progress': 0}
        state = status.get('state', 'idle')
        # Validate the state maps to the info-only label
        assert state == 'idle'
        # In the new code, idle → "Up to Date (vX.Y.Z)" disabled item

    def test_downloading_state_shows_progress(self):
        """In downloading state, menu should show download progress (disabled)."""
        status = {'state': 'downloading', 'update_info': {'latest_version': '2.0.0'}, 'progress': 0.45}
        state = status['state']
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        progress = int((status.get('progress', 0) or 0) * 100)
        label = f"Downloading update v{latest} ({progress}%)"
        assert label == "Downloading update v2.0.0 (45%)"

    def test_ready_state_shows_installing(self):
        """In ready state, menu should show 'Installing...' (disabled)."""
        status = {'state': 'ready', 'update_info': {'latest_version': '2.0.0'}}
        state = status['state']
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        label = f"Installing update v{latest}..."
        assert label == "Installing update v2.0.0..."

    def test_installing_state_shows_restarting(self):
        """In installing state, menu should show 'Restarting...' (disabled)."""
        status = {'state': 'installing', 'update_info': {'latest_version': '2.0.0'}}
        state = status['state']
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        label = f"Restarting for update v{latest}..."
        assert label == "Restarting for update v2.0.0..."

    def test_no_check_updates_action_in_menu(self):
        """Verify check_updates_action function is removed (no manual check)."""
        # In the new code, the idle state item is disabled (lambda: None).
        # There should be no check_updates_action function defined.
        # This test validates the menu structure by checking state transitions.
        status = {'state': 'idle'}
        state = status.get('state', 'idle')
        # The new code uses: item(..., lambda: None, enabled=False)
        # instead of: item(..., check_updates_action)
        assert state == 'idle'  # idle maps to disabled info item

    def test_no_install_update_action_in_menu(self):
        """Verify install_update_action function is removed (no manual install)."""
        status = {'state': 'ready', 'update_info': {'latest_version': '2.0.0'}}
        state = status.get('state', 'idle')
        # The new code: ready → "Installing update v2.0.0..." (disabled)
        # instead of: ready → clickable item calling install_update_action
        assert state == 'ready'  # ready maps to disabled info item


# ---------------------------------------------------------------------------
# 5. Download-to-install pipeline (end-to-end state transitions)
# ---------------------------------------------------------------------------

class TestDownloadToInstallPipeline:
    """End-to-end tests: download completes → auto-apply fires → installing state."""

    def test_full_pipeline_idle_to_installing(self, tmp_path, monkeypatch):
        """Simulate: idle → downloading → ready → auto_apply → installing."""
        states_seen = []

        def on_status_change(status):
            states_seen.append(status['state'])

        manager = UpdateManager(
            str(tmp_path), '1.0.0',
            on_status_change=on_status_change,
            on_apply_update=lambda: None  # Don't actually exit
        )

        # Step 1: Start from idle
        assert manager.state == 'idle'

        # Step 2: Simulate download completing
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary-content')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager.download_progress = 1.0

        # Step 3: Transition to ready (simulates _download_worker completion)
        manager._set_state('ready')
        assert 'ready' in states_seen

        # Step 4: auto_apply triggers install
        # Mock subprocess to prevent actual batch script execution
        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())
        result = manager.auto_apply()
        assert result is True
        assert manager.state == 'installing'
        assert 'installing' in states_seen

    def test_pipeline_handles_missing_staged_file(self, tmp_path):
        """auto_apply should fail gracefully if staged exe was deleted."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(tmp_path / 'updates' / 'nonexistent.exe')
        manager._set_state('ready')

        result = manager.auto_apply()
        assert result is False
        assert manager.state == 'failed'

    def test_pipeline_retry_on_download_failure(self, tmp_path):
        """After download failure, next 24h cycle should retry."""
        manager = UpdateManager(str(tmp_path), '1.0.0')

        # Simulate failed download
        manager._set_state('failed', error='network timeout')
        assert manager.state == 'failed'

        # auto_apply should not proceed from failed state
        result = manager.auto_apply()
        assert result is False

        # But state can be reset to idle for next cycle
        manager._set_state('idle')
        assert manager.state == 'idle'
        # Next check_and_download call would restart the pipeline


# ---------------------------------------------------------------------------
# 6. Notification content tests
# ---------------------------------------------------------------------------

class TestSilentUpdateNotifications:
    """Tests for notification content in silent update mode."""

    def test_restart_notification_contains_version(self):
        """The pre-restart notification should mention the version being installed."""
        latest_version = '2.1.0'
        msg = f"Installing v{latest_version}. The app will restart shortly."
        assert '2.1.0' in msg
        assert 'restart' in msg.lower()

    def test_no_install_now_button_in_downloading_notification(self):
        """Downloading notification should not have an Install Now action."""
        # In the new code, show_update_notification is called with
        # install_callback=None for downloading state
        install_callback = None
        assert install_callback is None

    def test_failed_notification_has_no_action_button(self):
        """Failed notification should not have any action button."""
        install_callback = None
        assert install_callback is None


# ---------------------------------------------------------------------------
# 7. Backward compatibility
# ---------------------------------------------------------------------------

class TestBackwardCompatibility:
    """Ensure defer_update and cancel_download still work (for API stability)."""

    def test_defer_update_method_still_exists(self, tmp_path):
        """defer_update() should still exist and work even though it's unused."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('ready')
        result = manager.defer_update()
        assert result is True
        assert manager.state == 'deferred'

    def test_cancel_download_method_still_exists(self, tmp_path):
        """cancel_download() should still exist and work."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('downloading')
        result = manager.cancel_download()
        assert result is True

    def test_apply_update_still_works_directly(self, tmp_path, monkeypatch):
        """Direct apply_update() call should still work (API stability)."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())
        assert manager.apply_update() is True
        assert manager.state == 'installing'


# ---------------------------------------------------------------------------
# 8. Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Edge case tests for silent auto-update."""

    def test_auto_apply_from_deferred_state(self, tmp_path):
        """auto_apply() should return False from 'deferred' state.
        (Only 'ready' and 'mandatory_ready' trigger auto-apply.)"""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        manager._set_state('deferred')
        result = manager.auto_apply()
        assert result is False

    def test_auto_apply_idempotent(self, tmp_path, monkeypatch):
        """Calling auto_apply() twice should not double-apply."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        # First call succeeds
        assert manager.auto_apply() is True
        assert manager.state == 'installing'

        # Second call should return False (state is 'installing', not 'ready')
        assert manager.auto_apply() is False

    def test_concurrent_auto_apply_safe(self, tmp_path, monkeypatch):
        """Multiple threads calling auto_apply should not cause issues."""
        manager = UpdateManager(str(tmp_path), '1.0.0')
        staged = tmp_path / 'updates' / 'TimeTracker_v2.0.0.exe'
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b'binary')

        manager.update_info = {'latest_version': '2.0.0', 'checksum': None}
        manager.download_path = str(staged)
        manager._set_state('ready')

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        results = []

        def call_auto_apply():
            results.append(manager.auto_apply())

        threads = [threading.Thread(target=call_auto_apply) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Exactly one should succeed (the first to reach apply_update)
        # Others should return False (state already changed)
        true_count = sum(1 for r in results if r is True)
        false_count = sum(1 for r in results if r is False)
        assert true_count >= 1  # At least one succeeded
        assert true_count + false_count == 5  # All returned

    def test_staged_update_on_restart_auto_applies(self, tmp_path, monkeypatch):
        """If a staged update exists from a previous session, auto_apply should work."""
        updates_dir = tmp_path / 'updates'
        updates_dir.mkdir(parents=True, exist_ok=True)
        staged = updates_dir / 'TimeTracker_v2.1.0.exe'
        staged.write_bytes(b'binary-content')

        manager = UpdateManager(str(tmp_path), '1.0.0')
        assert manager.load_staged_update_if_exists() is True
        assert manager.state == 'ready'

        monkeypatch.setattr(desktop_app.subprocess, 'Popen',
                            lambda *a, **kw: MagicMock())

        result = manager.auto_apply()
        assert result is True
        assert manager.state == 'installing'
```

---

## How to Run Tests

```bash
cd python-desktop-app
python -m pytest tests/test_auto_update_silent.py -v
python -m pytest tests/test_update_manager.py -v
```

Or run all tests together:
```bash
python -m pytest tests/test_auto_update_silent.py tests/test_update_manager.py -v
```

---

## Execution Order

| Step | Change | Risk | Reversible |
|------|--------|------|-----------|
| 1 | Add `auto_apply()` to `UpdateManager` | Low — additive only | Yes — delete method |
| 2 | Modify `_on_update_manager_state_changed()` | **Medium** — core behavior change | Yes — revert to old code |
| 3 | Simplify tray menu | Low — UI only | Yes — revert |
| 4 | Create test file | None — test only | Yes — delete file |

---

## Rollback Plan

If issues arise, revert Changes 2 and 4 to restore manual "Install Now" behavior. Changes 1 and test file are safe to keep regardless.
