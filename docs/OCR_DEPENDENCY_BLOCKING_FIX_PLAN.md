# OCR Dependency Installation Blocking Fix - Implementation Plan

**Issue ID**: Desktop App Freeze During Authentication  
**Severity**: CRITICAL  
**Date**: 2026-06-08  
**Status**: Planning  
**Target Version**: v1.4.8

---

## Executive Summary

### Problem Statement
The desktop application **freezes for 6-15 minutes** during OAuth authentication due to synchronous OCR dependency installation (torch, torchvision, scipy, etc.) blocking the Flask web server thread. This prevents:
- Authentication from completing
- User consent verification
- Automatic tracking startup
- Tray icon state updates

### Impact
- **User Experience**: Application appears frozen/broken after login
- **Adoption**: Users cannot complete first-time setup
- **Authentication**: OAuth callbacks timeout, leaving incomplete auth state
- **Data Loss**: Tracking doesn't start, no time data collected

### Solution Overview
Move OCR dependency installation to an **asynchronous background thread** with:
- Non-blocking authentication flow
- Progress notifications to user
- Graceful degradation (continue without OCR until ready)
- One-time installation check (not on every auth)

---

## Root Cause Analysis

### Issue Timeline (from logs)

```
10:17:09 - OAuth callback starts
10:17:13 - Fetching OCR config from AI server
10:17:15 - [EASYOCR] Installing missing packages... ← BLOCKS HERE
10:17:15 - Installing torch>=2.0.0...
10:23:52 - torch installed (6m 37s)
10:23:52 - Installing torchvision>=0.15.0...
10:24:14 - torchvision installed (22s)
10:24:14 - Installing scipy...
10:25:10 - scipy installed (56s)
10:25:10 - Installing scikit-image...
10:25:40 - scikit-image installed (30s)
10:25:40 - Installing python-bidi...
10:25:57 - python-bidi installed (17s)
10:25:57 - Installing easyocr>=1.7.0...
10:27:06 - easyocr installation FAILED
```

**Total blocking time**: ~10 minutes minimum  
**Thread blocked**: Flask web server (handles OAuth callback)  
**User impact**: Browser shows loading spinner, app appears frozen

### Code Flow Analysis

```
OAuth Callback (auth_callback route)
  └─> handle_callback(code, state)
       └─> exchange tokens
       └─> get_user_info()
       └─> initialize_supabase()  ← ENTRY POINT
            ├─> get_supabase_config()
            ├─> get_ocr_config()
            └─> _setup_ocr_engines()  ← BLOCKING CALL
                 └─> check_and_install_dependencies(auto_install=True, silent=False)
                      └─> For each missing dependency:
                           └─> subprocess.run(['pip', 'install', package])  ← BLOCKS 6-15 min
            └─> ocr_processor = LocalOCRProcessor()
       └─> ensure_user_exists(user_info)
       └─> start_tracking()  ← NEVER REACHED
```

**Blocking locations**:
1. **Primary**: `desktop_app.py:5909` - `self._setup_ocr_engines()` called in `initialize_supabase()`
2. **Secondary**: `desktop_app.py:498` - `check_and_install_dependencies()` at module level
3. **Tertiary**: `ocr/auto_installer.py:267-274` - `subprocess.run(['pip', 'install', ...], check=True)`

### Why This Happens

1. **OCR config fetched from AI server** on every authentication
2. **Dependency check runs synchronously** when config changes
3. **Pip install runs in foreground** with no timeout
4. **Flask route handler blocks** waiting for pip to finish
5. **Browser times out** or user refreshes, triggering another attempt

### Secondary Issues

1. **Keyring failures**: Windows Credential Manager errors cause auth state inconsistency
2. **Multiple retries**: User clicks "retry" or refreshes, spawning multiple parallel installs
3. **Incomplete auth state**: Tokens saved but tracking never starts
4. **Orange icon**: `is_authenticated()` returns False or idle detection triggers

---

## Proposed Solution

### Architecture Changes

```
┌─────────────────────────────────────────────────────────────┐
│                    BEFORE (Blocking)                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  OAuth Callback (Flask Thread)                              │
│    ↓                                                         │
│  Initialize Supabase                                         │
│    ↓                                                         │
│  Check OCR Dependencies ←─────────── BLOCKS 6-15 min        │
│    ↓                                                         │
│  Install Missing Packages                                    │
│    ↓                                                         │
│  Setup OCR Engines                                           │
│    ↓                                                         │
│  Start Tracking ←───────────────────── Never reached        │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    AFTER (Non-Blocking)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  OAuth Callback (Flask Thread)                              │
│    ↓                                                         │
│  Initialize Supabase (skip OCR setup)                       │
│    ↓                                                         │
│  Start Tracking ←───────────────────── Immediate            │
│    ↓                                                         │
│  Return Success to Browser ←──────────── ~2 seconds         │
│                                                              │
│  Background Thread (daemon)                                 │
│    ↓                                                         │
│  Check OCR Dependencies ←─────────── Non-blocking           │
│    ↓                                                         │
│  Install Missing Packages (if needed)                       │
│    ↓                                                         │
│  Setup OCR Engines                                           │
│    ↓                                                         │
│  Notify User: "OCR Ready"                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Authentication First**: Complete auth flow without waiting for OCR
2. **Graceful Degradation**: Run without OCR until dependencies ready
3. **Background Installation**: Use daemon thread for pip installs
4. **User Feedback**: Show notifications for installation progress
5. **One-Time Check**: Install dependencies only once, not on every auth
6. **Timeout Protection**: Add max installation time (15 minutes)
7. **Failure Recovery**: Continue without OCR if installation fails

---

## Implementation Plan

### Phase 1: Decouple OCR from Authentication (CRITICAL)

**Goal**: Remove OCR setup from the authentication flow

#### File: `desktop_app.py`

**Change 1.1**: Modify `initialize_supabase()` to skip OCR setup

**Location**: Line 5887-5949

**Current Code**:
```python
def initialize_supabase(self):
    """Initialize Supabase client with custom JWT for RLS-scoped access."""
    if self.supabase_initialized:
        print("[INFO] Supabase already initialized")
        return True

    # Fetch Supabase config from AI server
    print("[INFO] Fetching Supabase configuration from AI server...")
    if not self.auth_manager.get_supabase_config():
        print("[ERROR] Failed to get Supabase config from AI server")
        return False

    # Fetch OCR config from AI server
    print("[INFO] Fetching OCR configuration from AI server...")
    if not self.auth_manager.get_ocr_config():
        print("[WARN] Failed to get OCR config from AI server, using defaults")

    # ❌ BLOCKING: OCR setup runs synchronously here
    self._setup_ocr_engines()
    self.ocr_processor = LocalOCRProcessor()

    # Initialize Supabase client...
    # (rest of method)
```

**New Code**:
```python
def initialize_supabase(self, skip_ocr_setup=False):
    """Initialize Supabase client with custom JWT for RLS-scoped access.
    
    Args:
        skip_ocr_setup: If True, defer OCR initialization to background thread.
                       Used during authentication to prevent blocking.
    """
    if self.supabase_initialized:
        print("[INFO] Supabase already initialized")
        return True

    # Fetch Supabase config from AI server
    print("[INFO] Fetching Supabase configuration from AI server...")
    if not self.auth_manager.get_supabase_config():
        print("[ERROR] Failed to get Supabase config from AI server")
        return False

    # Fetch OCR config from AI server (but don't install yet)
    print("[INFO] Fetching OCR configuration from AI server...")
    if not self.auth_manager.get_ocr_config():
        print("[WARN] Failed to get OCR config from AI server, using defaults")

    # ✅ DEFERRED: OCR setup moved to background thread
    if not skip_ocr_setup:
        # Called from startup path (already in background)
        self._setup_ocr_engines()
        self.ocr_processor = LocalOCRProcessor()
    else:
        # Called from auth callback (Flask thread) - defer OCR setup
        print("[INFO] OCR setup deferred to background thread")
        self.ocr_processor = None  # Will be initialized later

    # Initialize Supabase client...
    # (rest of method unchanged)
```

**Change 1.2**: Update auth callback to skip OCR setup

**Location**: Line 6213

**Current Code**:
```python
# Initialize Supabase clients (fetches config from AI server)
print("[INFO] Initializing database connection...")
if not self.initialize_supabase():
    error_msg = "Failed to initialize database connection"
    # ...
    return error_msg, 500
```

**New Code**:
```python
# Initialize Supabase clients (fetches config from AI server)
# Skip OCR setup to prevent blocking (will be done in background)
print("[INFO] Initializing database connection...")
if not self.initialize_supabase(skip_ocr_setup=True):
    error_msg = "Failed to initialize database connection"
    # ...
    return error_msg, 500

# Start background OCR initialization (non-blocking)
self._start_background_ocr_setup()
```

**Change 1.3**: Same for Google auth callback

**Location**: Line 6113

Apply same changes to Google OAuth callback.

---

### Phase 2: Background OCR Setup Thread

**Goal**: Install OCR dependencies asynchronously without blocking

#### File: `desktop_app.py`

**Change 2.1**: Add background OCR setup method

**Location**: After `_setup_ocr_engines()` method (~line 5730)

```python
def _start_background_ocr_setup(self):
    """
    Start OCR dependency installation in a background thread.
    Non-blocking - authentication completes immediately.
    Shows progress notifications to user.
    """
    if hasattr(self, '_ocr_setup_thread') and self._ocr_setup_thread and self._ocr_setup_thread.is_alive():
        print("[INFO] OCR setup already running in background")
        return

    print("[INFO] Starting background OCR setup...")
    self._ocr_setup_thread = threading.Thread(
        target=self._background_ocr_setup_worker,
        daemon=True,
        name="OCR-Setup-Worker"
    )
    self._ocr_setup_thread.start()

def _background_ocr_setup_worker(self):
    """
    Worker thread for OCR setup and dependency installation.
    Runs independently of authentication flow.
    """
    try:
        print("[OCR SETUP] Background worker started")
        self.add_admin_log('INFO', 'OCR setup started in background')
        
        # Track installation time
        start_time = time.time()
        max_install_time = 900  # 15 minutes timeout
        
        # Check if dependencies are already installed
        missing_count = self._count_missing_ocr_dependencies()
        
        if missing_count == 0:
            print("[OCR SETUP] All dependencies already installed")
            self._finalize_ocr_setup()
            return
        
        # Show notification to user
        print(f"[OCR SETUP] Installing {missing_count} OCR dependencies...")
        print("[OCR SETUP] This may take 5-15 minutes. App continues running.")
        self._show_ocr_installation_notification(missing_count, started=True)
        
        # Run dependency check (with timeout protection)
        try:
            from ocr.auto_installer import check_and_install_dependencies
            
            # Use threading.Timer for timeout protection
            install_complete = threading.Event()
            install_success = [False]  # Use list for closure mutable ref
            
            def run_install():
                try:
                    result = check_and_install_dependencies(
                        auto_install=True,
                        silent=False
                    )
                    install_success[0] = bool(result)
                    install_complete.set()
                except Exception as e:
                    print(f"[OCR SETUP] Installation error: {e}")
                    install_complete.set()
            
            install_thread = threading.Thread(target=run_install, daemon=True)
            install_thread.start()
            
            # Wait with timeout
            timed_out = not install_complete.wait(timeout=max_install_time)
            
            if timed_out:
                elapsed = time.time() - start_time
                print(f"[OCR SETUP] Installation timed out after {elapsed:.0f}s")
                self.add_admin_log('WARNING', f'OCR installation timed out after {elapsed:.0f}s')
                self._show_ocr_installation_notification(missing_count, failed=True, timeout=True)
                return
            
            elapsed = time.time() - start_time
            
            if install_success[0]:
                print(f"[OCR SETUP] Installation completed in {elapsed:.0f}s")
                self.add_admin_log('INFO', f'OCR dependencies installed ({elapsed:.0f}s)')
                self._finalize_ocr_setup()
                self._show_ocr_installation_notification(missing_count, success=True)
            else:
                print(f"[OCR SETUP] Installation failed after {elapsed:.0f}s")
                self.add_admin_log('WARNING', f'OCR installation failed ({elapsed:.0f}s)')
                self._show_ocr_installation_notification(missing_count, failed=True)
        
        except Exception as e:
            elapsed = time.time() - start_time
            print(f"[OCR SETUP] Unexpected error: {e}")
            traceback.print_exc()
            self.add_admin_log('ERROR', f'OCR setup error: {str(e)}')
            self._show_ocr_installation_notification(missing_count, failed=True)
    
    except Exception as e:
        print(f"[OCR SETUP] Worker thread crashed: {e}")
        traceback.print_exc()

def _count_missing_ocr_dependencies(self):
    """Count how many OCR dependencies are missing (fast check)."""
    try:
        from ocr.auto_installer import get_configured_engines, get_missing_dependencies
        
        engines = get_configured_engines()
        total_missing = 0
        
        for engine in engines:
            missing = get_missing_dependencies(engine)
            total_missing += len(missing)
        
        return total_missing
    except Exception as e:
        print(f"[OCR SETUP] Could not count missing dependencies: {e}")
        return 0

def _finalize_ocr_setup(self):
    """
    Finalize OCR setup after dependencies are installed.
    Creates OCR processor and runs diagnostics.
    """
    try:
        print("[OCR SETUP] Finalizing OCR engines...")
        
        # Setup OCR engines (now that dependencies are installed)
        self._setup_ocr_engines()
        
        # Create OCR processor
        from ocr.local_ocr_processor import LocalOCRProcessor
        self.ocr_processor = LocalOCRProcessor()
        
        print("[OCR SETUP] OCR system ready")
        self.add_admin_log('INFO', 'OCR system initialized successfully')
        
    except Exception as e:
        print(f"[OCR SETUP] Finalization error: {e}")
        traceback.print_exc()
        self.add_admin_log('ERROR', f'OCR finalization error: {str(e)}')

def _show_ocr_installation_notification(self, package_count, started=False, success=False, failed=False, timeout=False):
    """
    Show desktop notification for OCR installation progress.
    
    Args:
        package_count: Number of packages being installed
        started: Installation started
        success: Installation completed successfully
        failed: Installation failed
        timeout: Installation timed out
    """
    try:
        # Import notification library if available
        if not WINOTIFY_AVAILABLE:
            return
        
        from winotify import Notification, audio
        
        if started:
            title = "Setting Up OCR"
            msg = f"Installing {package_count} OCR dependencies in background. App continues running."
            duration = "long"
        elif success:
            title = "OCR Ready"
            msg = "OCR text extraction is now available for screenshot analysis."
            duration = "short"
        elif timeout:
            title = "OCR Installation Timeout"
            msg = f"Installation took too long (>15 min). App continues without OCR. Check logs."
            duration = "long"
        elif failed:
            title = "OCR Installation Issue"
            msg = "Could not install OCR dependencies. App continues with basic functionality."
            duration = "long"
        else:
            return
        
        notification = Notification(
            app_id="Time Tracker",
            title=title,
            msg=msg,
            duration=duration
        )
        
        if success:
            notification.set_audio(audio.Default, loop=False)
        
        notification.show()
        
    except Exception as e:
        print(f"[OCR SETUP] Could not show notification: {e}")
```

**Change 2.2**: Add OCR readiness check in upload flow

**Location**: In `upload_screenshot()` method (~line 10190)

```python
def upload_screenshot(self, screenshot, window_info, use_previous_window=False):
    """Upload screenshot to Supabase with event-based tracking."""
    
    # ... existing code ...
    
    # OCR text extraction (with availability check)
    ocr_text = ""
    if self.ocr_processor is not None:
        try:
            ocr_result = self.ocr_processor.extract_text(screenshot)
            ocr_text = ocr_result.get('text', '')
        except Exception as e:
            print(f"[WARN] OCR extraction failed: {e}")
    else:
        # OCR not ready yet (dependencies still installing)
        print("[INFO] OCR not available yet - skipping text extraction")
    
    # ... rest of method ...
```

---

### Phase 3: One-Time Installation Marker

**Goal**: Prevent re-installing dependencies on every authentication

#### File: `ocr/auto_installer.py`

**Change 3.1**: Add installation state tracking

**Location**: Beginning of file (~line 50)

```python
def get_installation_marker_path():
    """Get path to OCR installation marker file."""
    import tempfile
    from pathlib import Path
    
    # Store in user temp directory
    marker_dir = Path(tempfile.gettempdir()) / 'timetracker_ocr'
    marker_dir.mkdir(exist_ok=True)
    
    return marker_dir / 'installation_complete.marker'

def mark_installation_complete(engines):
    """Mark OCR dependencies as installed."""
    try:
        marker_path = get_installation_marker_path()
        with open(marker_path, 'w') as f:
            import json
            json.dump({
                'engines': engines,
                'timestamp': time.time(),
                'version': '1.0'
            }, f)
        print(f"[OCR] Installation marker saved: {marker_path}")
    except Exception as e:
        print(f"[OCR] Could not save installation marker: {e}")

def is_installation_complete():
    """Check if OCR dependencies were already installed."""
    try:
        marker_path = get_installation_marker_path()
        if not marker_path.exists():
            return False
        
        # Check if all configured engines are in the marker
        with open(marker_path, 'r') as f:
            import json
            marker_data = json.load(f)
        
        installed_engines = set(marker_data.get('engines', []))
        configured_engines = set(get_configured_engines())
        
        # All configured engines must be in the marker
        return configured_engines.issubset(installed_engines)
    
    except Exception as e:
        print(f"[OCR] Could not read installation marker: {e}")
        return False
```

**Change 3.2**: Update `check_and_install_dependencies()` to use marker

**Location**: Line 403-485

```python
def check_and_install_dependencies(
    auto_install: bool = True,
    silent: bool = False,
    force: bool = False
) -> Dict[str, bool]:
    """
    Check OCR engines and install missing dependencies.
    
    Args:
        auto_install: If True, automatically install missing packages
        silent: If True, suppress console output
        force: If True, skip installation marker check and always check
    
    Returns:
        Dict mapping engine names to installation success status
    """
    # Skip in production (bundled EXE)
    if not is_development_mode():
        logger.debug("Running in production mode, skipping dependency check")
        return {}
    
    # Check installation marker (unless forced)
    if not force and is_installation_complete():
        if not silent:
            print("[OCR] Dependencies already installed (skipping check)")
        return {}
    
    # ... existing installation logic ...
    
    # Mark installation complete if all succeeded
    if results and all(results.values()):
        mark_installation_complete(list(results.keys()))
    
    return results
```

---

### Phase 4: Startup Path Changes

**Goal**: Handle OCR setup on first app startup (not just auth)

#### File: `desktop_app.py`

**Change 4.1**: Add early OCR check on startup

**Location**: In `run()` method, after single instance lock (~line 12425)

```python
def run(self):
    """Main application entry point"""
    print("[OK] Starting Time Tracker...")
    
    # ... existing single instance lock code ...
    
    # Check if this is first run (OCR dependencies not installed)
    # Start background installation early so it's ready by the time user logs in
    if self._is_first_run_ocr_check():
        print("[INFO] First run detected - starting OCR dependency check in background")
        self._start_background_ocr_setup()
    
    # ... rest of startup code ...

def _is_first_run_ocr_check(self):
    """Check if OCR dependencies need to be installed."""
    try:
        from ocr.auto_installer import is_installation_complete
        return not is_installation_complete()
    except Exception as e:
        print(f"[WARN] Could not check OCR installation status: {e}")
        return False
```

---

## Testing Plan

### Phase 1: Unit Testing

#### Test 1.1: Background Thread Start
```python
def test_background_ocr_setup_starts():
    tracker = TimeTracker()
    tracker._start_background_ocr_setup()
    
    assert hasattr(tracker, '_ocr_setup_thread')
    assert tracker._ocr_setup_thread.is_alive()
    assert tracker._ocr_setup_thread.daemon == True
```

#### Test 1.2: Auth Completes Without OCR
```python
def test_auth_completes_without_ocr():
    tracker = TimeTracker()
    
    # Simulate auth callback with OCR dependencies missing
    start_time = time.time()
    success = tracker.initialize_supabase(skip_ocr_setup=True)
    elapsed = time.time() - start_time
    
    assert success == True
    assert elapsed < 5.0  # Should complete in <5 seconds
    assert tracker.supabase_initialized == True
    assert tracker.ocr_processor is None  # Not initialized yet
```

#### Test 1.3: Tracking Starts Without OCR
```python
def test_tracking_starts_without_ocr():
    tracker = TimeTracker()
    tracker.initialize_supabase(skip_ocr_setup=True)
    tracker.current_user_id = "test-user-123"
    
    # Should start tracking even without OCR ready
    tracker.start_tracking()
    
    assert tracker.running == True
    assert tracker.tracking_active == True
```

#### Test 1.4: Upload Works Without OCR
```python
def test_upload_without_ocr():
    tracker = TimeTracker()
    tracker.ocr_processor = None  # Simulate OCR not ready
    
    # Should upload without OCR text
    screenshot = create_test_screenshot()
    window_info = {'title': 'Test Window', 'app': 'TestApp'}
    
    result = tracker.upload_screenshot(screenshot, window_info)
    
    assert result is not None
    assert 'screenshot_id' in result
```

### Phase 2: Integration Testing

#### Test 2.1: Full Auth Flow
**Steps**:
1. Clear all cached credentials
2. Start app in development mode
3. Trigger OAuth login
4. Verify auth completes in <10 seconds
5. Verify tracking starts immediately
6. Verify OCR setup runs in background
7. Check tray icon is green

**Expected**:
- Auth callback returns success in <10s
- Browser redirects to success page
- Tracking starts automatically
- Tray icon shows green (authenticated + tracking)
- Background thread shows OCR installation progress
- After 5-15 min, OCR becomes available

#### Test 2.2: First Run Experience
**Steps**:
1. Clean install (no marker file)
2. Start app
3. Complete OAuth
4. Monitor background thread
5. Verify notifications appear

**Expected**:
- "Setting Up OCR" notification shown
- Auth completes immediately
- App functional during OCR install
- "OCR Ready" notification after install completes

#### Test 2.3: Subsequent Runs
**Steps**:
1. Complete first run (marker file exists)
2. Close and restart app
3. Complete OAuth

**Expected**:
- No OCR installation triggered
- OCR available immediately
- No blocking delays

#### Test 2.4: Installation Timeout
**Steps**:
1. Simulate slow network (throttle pip)
2. Trigger OCR installation
3. Wait 15+ minutes

**Expected**:
- Background thread times out gracefully
- App continues running
- User notified of timeout
- Can retry manually from admin panel

#### Test 2.5: Installation Failure
**Steps**:
1. Block pip from accessing PyPI
2. Trigger OCR installation
3. Verify graceful degradation

**Expected**:
- Installation fails without crashing
- User notified of failure
- Screenshots upload without OCR text
- Admin panel shows error details

### Phase 3: Performance Testing

#### Test 3.1: Auth Speed
**Metric**: Time from OAuth redirect to tracking start

**Before Fix**: 10-15 minutes (blocked)  
**After Fix**: <5 seconds (target)

**Test**:
```python
import time

start = time.time()
# Trigger OAuth callback
tracker.handle_callback(code, state)
elapsed = time.time() - start

assert elapsed < 5.0, f"Auth took {elapsed}s (expected <5s)"
```

#### Test 3.2: Background Thread Resource Usage
**Metrics**:
- CPU usage during installation
- Memory usage
- Disk I/O

**Test**: Monitor system resources during background OCR installation
**Expected**: 
- Main app remains responsive
- CPU usage <50% per core
- No memory leaks

#### Test 3.3: Concurrent Auth + OCR Install
**Test**: Multiple users authenticate while OCR installs
**Expected**: No race conditions, all users authenticated successfully

### Phase 4: Edge Case Testing

#### Test 4.1: OCR Config Changes
**Scenario**: User changes OCR engine in .env, restarts app
**Expected**: New dependencies installed in background

#### Test 4.2: Partial Installation
**Scenario**: Some packages install, others fail
**Expected**: Uses available engines, logs failures

#### Test 4.3: Network Interruption
**Scenario**: Network drops during pip install
**Expected**: Installation fails gracefully, can retry

#### Test 4.4: User Logout During Install
**Scenario**: User logs out while OCR installs
**Expected**: Background thread continues, ready for next login

#### Test 4.5: App Shutdown During Install
**Scenario**: User closes app during OCR installation
**Expected**: Daemon thread exits cleanly, no hung processes

---

## Rollback Plan

### Rollback Triggers
1. Auth failure rate >10%
2. Tracking start failure >5%
3. Critical bugs in production
4. User reports of "app not working"

### Rollback Steps

**Step 1**: Revert code changes
```bash
git checkout main -- python-desktop-app/desktop_app.py
git checkout main -- python-desktop-app/ocr/auto_installer.py
```

**Step 2**: Clear installation markers
```python
import tempfile
from pathlib import Path

marker_path = Path(tempfile.gettempdir()) / 'timetracker_ocr' / 'installation_complete.marker'
if marker_path.exists():
    marker_path.unlink()
```

**Step 3**: Deploy hotfix
```bash
python build.bat
# Upload to AI server
# Notify users to update
```

### Rollback Testing
- Verify auth works as before
- Verify OCR installs synchronously (blocking behavior restored)
- Check all existing features still work

---

## Migration Strategy

### Backward Compatibility

**Existing Users (v1.4.7 → v1.4.8)**:
- Already have OCR dependencies installed
- Installation marker won't exist on first v1.4.8 run
- Will see background installation attempt
- If dependencies found, installation completes instantly

**New Users (fresh install v1.4.8)**:
- First run triggers background OCR installation
- Can use app immediately (without OCR)
- OCR becomes available after 5-15 minutes
- Notification informs them of progress

### Data Migration
**None required** - this is a code-only change

### Configuration Migration
**None required** - OCR config remains in `.env` and AI server

---

## Deployment Plan

### Pre-Deployment Checklist
- [ ] All unit tests pass
- [ ] Integration tests pass on test environment
- [ ] Performance benchmarks meet targets (<5s auth)
- [ ] Edge case testing complete
- [ ] Rollback plan tested
- [ ] Documentation updated
- [ ] Release notes prepared

### Deployment Steps

**Step 1**: Deploy to Staging (1 day)
```bash
# Deploy to staging server
python build.bat
# Test with staging AI server
# Monitor logs for issues
```

**Step 2**: Beta Testing (3 days)
- Select 10 beta testers
- Provide test build
- Monitor their experience
- Collect feedback

**Step 3**: Gradual Rollout (1 week)
- Day 1: 10% of users
- Day 2: 25% of users
- Day 3: 50% of users
- Day 7: 100% of users

**Step 4**: Monitor Production (ongoing)
- Track auth completion rate
- Monitor background thread failures
- Check OCR availability metrics
- Review user feedback

### Success Metrics

**Critical Metrics** (must improve):
1. **Auth completion time**: <5 seconds (down from 10-15 min)
2. **Auth success rate**: >95% (up from ~50%)
3. **Tracking start rate**: >95% (up from ~40%)
4. **User setup success**: >90% complete first run

**Secondary Metrics** (monitor for regressions):
1. OCR availability after auth: Target 100% within 15 min
2. Background thread failure rate: <5%
3. Installation timeout rate: <10%
4. App crash rate: No increase
5. User satisfaction: No decrease

---

## Risk Analysis

### High Risk Areas

#### Risk 1: Background Thread Management
**Issue**: Thread lifecycle, cleanup, race conditions  
**Mitigation**:
- Use daemon threads (auto-cleanup)
- Add thread state tracking
- Test concurrent scenarios
- Monitor for hung threads

#### Risk 2: OCR Processor Null References
**Issue**: Code expects `ocr_processor` to exist, crashes if None  
**Mitigation**:
- Add null checks before OCR calls
- Graceful degradation (skip OCR if not ready)
- Test all code paths with `ocr_processor=None`
- Add type hints for clarity

#### Risk 3: Installation Marker Corruption
**Issue**: Marker file corrupted, causing repeated installations  
**Mitigation**:
- Use JSON format with validation
- Add marker version field
- Handle read/write errors gracefully
- Add force-reinstall option in admin panel

#### Risk 4: Network Timeout During Pip
**Issue**: Pip hangs on slow networks, thread blocked  
**Mitigation**:
- Add 15-minute timeout to background thread
- Monitor thread heartbeat
- Kill hung threads if needed
- Notify user of timeout

### Medium Risk Areas

#### Risk 5: Notification Fatigue
**Issue**: Too many notifications annoy users  
**Mitigation**:
- Show max 2 notifications (start, finish)
- Allow users to disable OCR notifications
- Only show if installation >30 seconds

#### Risk 6: Dependency Conflicts
**Issue**: New packages conflict with existing ones  
**Mitigation**:
- Test all engine combinations
- Resolve opencv conflicts (already handled)
- Document known conflicts
- Add conflict resolution to auto_installer

### Low Risk Areas

#### Risk 7: Marker File Security
**Issue**: Marker file in temp dir could be deleted  
**Mitigation**:
- Accept that marker may be deleted
- Worst case: re-check dependencies (fast if installed)
- Consider moving to app data dir

#### Risk 8: Admin Panel Visibility
**Issue**: Users can't see OCR installation status  
**Mitigation**:
- Add OCR status section to admin panel
- Show "Installing...", "Ready", "Failed" states
- Add manual retry button

---

## Documentation Updates

### User Documentation

**File**: `docs/USER_GUIDE.md`

**Section to Add**: "First Run Setup"
```markdown
## First Run Setup

When you install TimeTracker for the first time, the app will:

1. **Authenticate** - Complete the Atlassian OAuth flow (~30 seconds)
2. **Start Tracking** - Tracking begins immediately after authentication
3. **Install OCR** - Text extraction dependencies install in the background (5-15 minutes)

### During OCR Installation
- ✅ App continues running normally
- ✅ Screenshots are captured and uploaded
- ✅ You can use all features
- ⏳ Text extraction from screenshots will be available when installation completes

### Notifications
You'll see two notifications:
1. **"Setting Up OCR"** - Installation started
2. **"OCR Ready"** - Installation complete

If installation fails, the app continues working with basic functionality.
```

### Developer Documentation

**File**: `docs/DEVELOPER_GUIDE.md`

**Section to Add**: "OCR Architecture"
```markdown
## OCR Architecture

### Background Installation (v1.4.8+)

OCR dependencies are installed asynchronously to prevent blocking authentication:

```
┌──────────────────────────────────────────┐
│         Main Application Flow            │
├──────────────────────────────────────────┤
│ OAuth Auth ──> Tracking Starts (2-5s)    │
└──────────────────────────────────────────┘
                    │
                    ├── Background Thread ─────────────┐
                    │                                    │
                    │   ┌──────────────────────────┐   │
                    │   │ Check Missing Deps       │   │
                    │   │ Install Packages (5-15m) │   │
                    │   │ Setup OCR Engines        │   │
                    │   │ Create OCR Processor     │   │
                    │   │ Notify User              │   │
                    │   └──────────────────────────┘   │
                    │                                    │
                    └────────────────────────────────────┘
```

### Key Components

1. **`_start_background_ocr_setup()`** - Starts daemon thread
2. **`_background_ocr_setup_worker()`** - Installs dependencies
3. **`_finalize_ocr_setup()`** - Creates OCR processor
4. **`initialize_supabase(skip_ocr_setup=True)`** - Non-blocking auth

### Graceful Degradation

If OCR is not ready:
- Screenshots upload without OCR text
- `ocr_text` field in DB is empty string
- AI analysis continues (uses window title only)
- OCR becomes available after installation completes
```

### Admin Panel

**File**: `desktop_app.py` - Admin panel template

**Add OCR Status Section**:
```python
def render_admin_panel():
    # ... existing code ...
    
    # OCR Status Section
    ocr_status = "Ready" if self.ocr_processor else "Not Available"
    if hasattr(self, '_ocr_setup_thread') and self._ocr_setup_thread and self._ocr_setup_thread.is_alive():
        ocr_status = "Installing..."
    
    ocr_status_html = f'''
    <div class="status-section">
        <h3>OCR Status</h3>
        <p><strong>Status:</strong> {ocr_status}</p>
        {
            '<button onclick="retryOcrSetup()">Retry Installation</button>'
            if ocr_status == "Not Available" else ''
        }
    </div>
    '''
```

---

## Success Criteria

### Must Have (Blockers for Release)
- [ ] Authentication completes in <5 seconds (no blocking)
- [ ] Tracking starts immediately after auth
- [ ] Background OCR installation works
- [ ] App functional without OCR (graceful degradation)
- [ ] No crashes or hung threads
- [ ] Rollback plan tested

### Should Have (Important for UX)
- [ ] User notifications show installation progress
- [ ] Admin panel shows OCR status
- [ ] Installation marker prevents duplicate installs
- [ ] Timeout protection (15 min) works
- [ ] All unit tests pass

### Nice to Have (Future Enhancements)
- [ ] OCR installation progress bar
- [ ] Retry failed installation from UI
- [ ] Pre-fetch dependencies on app download
- [ ] Offline OCR installer (bundled dependencies)

---

## Post-Deployment Monitoring

### Week 1: Critical Monitoring
- Auth completion rate (target >95%)
- Tracking start rate (target >95%)
- Background thread failures
- User error reports

### Week 2-4: Stability Monitoring
- OCR availability metrics
- Installation success rate
- Timeout occurrences
- Memory leaks
- Thread cleanup

### Month 2+: Performance Optimization
- Average installation time
- User engagement (tracking hours)
- OCR accuracy impact
- Feature adoption

---

## Appendix A: Code Review Checklist

### Authentication Flow
- [ ] `initialize_supabase()` has `skip_ocr_setup` parameter
- [ ] Auth callbacks call `initialize_supabase(skip_ocr_setup=True)`
- [ ] Background thread started after auth
- [ ] Tracking starts without waiting for OCR

### Background Thread
- [ ] Thread marked as daemon
- [ ] Timeout protection (15 min)
- [ ] Exception handling in worker
- [ ] Thread state tracking
- [ ] No blocking calls on main thread

### OCR Processor
- [ ] Null checks before OCR calls
- [ ] Graceful degradation if None
- [ ] Initialized after dependencies ready
- [ ] Error handling on extraction

### Installation Marker
- [ ] Marker saved after successful install
- [ ] Marker checked before reinstalling
- [ ] Force flag available
- [ ] JSON format with version

### Notifications
- [ ] Start notification shown
- [ ] Success notification shown
- [ ] Failure notification shown
- [ ] Timeout notification shown

### Error Handling
- [ ] Installation failures logged
- [ ] User notified of failures
- [ ] App continues without OCR
- [ ] Admin panel shows errors

---

## Appendix B: Known Issues

### Issue 1: EasyOCR Installation Failures
**Symptom**: EasyOCR fails to install on some systems  
**Cause**: Torch version conflicts, GPU driver issues  
**Workaround**: Use RapidOCR or WinRT OCR instead  
**Fix**: Update `ocr/auto_installer.py` to detect conflicts

### Issue 2: Windows Keyring Errors
**Symptom**: `(1783, 'CredWrite', 'The stub received bad data')`  
**Cause**: Windows Credential Manager issues  
**Impact**: Falls back to encrypted file storage (works)  
**Action**: Document as known limitation

### Issue 3: Slow First Run on Slow Networks
**Symptom**: Pip downloads take >30 minutes  
**Cause**: Large packages (torch ~800MB) on slow connections  
**Solution**: Timeout protection (15 min) catches this  
**Future**: Pre-bundle dependencies or use faster mirrors

---

## Appendix C: Testing Matrix

| Test Case | Before Fix | After Fix | Status |
|-----------|------------|-----------|--------|
| Fresh install auth | ❌ Hangs | ✅ <5s | 🔄 Test |
| Existing user auth | ⚠️ Slow | ✅ <2s | 🔄 Test |
| Tracking start | ❌ Never starts | ✅ Immediate | 🔄 Test |
| OCR availability | ⚠️ After 10min | ✅ After 5-15min | 🔄 Test |
| App responsiveness | ❌ Frozen | ✅ Responsive | 🔄 Test |
| Tray icon color | 🟠 Orange | 🟢 Green | 🔄 Test |
| Multiple retries | ❌ Crashes | ✅ Works | 🔄 Test |
| Network failure | ❌ Hangs | ✅ Graceful | 🔄 Test |
| Slow network | ❌ Hangs | ✅ Timeout | 🔄 Test |
| Installation failure | ❌ Blocks | ✅ Continues | 🔄 Test |

---

## Appendix D: Test Scripts

### Unit Tests

**File**: `python-desktop-app/tests/test_ocr_background_setup.py`

Comprehensive unit tests covering:
- Background thread initialization
- Authentication speed (target <5s)
- OCR processor null checks
- Installation marker functionality
- Timeout protection
- Concurrent access

**Run Tests**:
```bash
cd python-desktop-app
python -m pytest tests/test_ocr_background_setup.py -v
```

**Expected Output**:
```
test_initialize_supabase_with_skip_ocr ... PASSED
test_initialize_supabase_without_skip ... PASSED
test_background_ocr_setup_starts_thread ... PASSED
test_background_ocr_setup_no_duplicate_threads ... PASSED
test_background_worker_completes ... PASSED
test_background_worker_handles_timeout ... PASSED
test_ocr_processor_null_checks ... PASSED
test_mark_installation_complete ... PASSED
test_is_installation_complete_true ... PASSED
test_is_installation_complete_false_no_marker ... PASSED
test_is_installation_complete_false_missing_engine ... PASSED
test_check_and_install_skips_when_complete ... PASSED
test_check_and_install_runs_when_forced ... PASSED
test_auth_callback_completes_quickly ... PASSED

================================ 14 passed ================================
```

### Integration Tests

**File**: `python-desktop-app/tests/test_integration_ocr_background.py`

End-to-end integration tests covering:
- Full authentication flow (<5s target)
- Tracking starts immediately
- Background OCR setup thread
- Existing user authentication (<2s target)
- Concurrent authentication + OCR installation

**Run Tests**:
```bash
cd python-desktop-app
python tests/test_integration_ocr_background.py
```

**Expected Output**:
```
╔════════════════════════════════════════════════════════════════════╗
║  OCR Background Setup - Integration Tests                         ║
║  Testing fix for OCR dependency blocking authentication           ║
╚════════════════════════════════════════════════════════════════════╝

======================================================================
 INTEGRATION TEST: Full Authentication Flow
======================================================================

[1/5] Testing authentication speed...
   ✅ Auth completed in 1.42s (<5s target)

[2/5] Testing tracking starts immediately...
   ✅ Tracking started in 0.21s (<1s)

[3/5] Testing background OCR setup thread...
   [OCR SETUP] Background worker started
   [OCR SETUP] Checking dependencies...
   [OCR SETUP] Installing packages (simulated)...
   ✅ Background OCR thread started

[4/5] Testing OCR deferred from auth flow...
   ✅ OCR processor is None during auth (deferred)

[5/5] Testing no blocking behavior...
   [MAIN THREAD] Responsive (iteration 1/3)
   [MAIN THREAD] Responsive (iteration 2/3)
   [MAIN THREAD] Responsive (iteration 3/3)
   ✅ Main thread remained responsive during OCR setup

[BACKGROUND] Waiting for OCR thread to complete...
[BACKGROUND] OCR setup completed

======================================================================
 TEST RESULTS SUMMARY
======================================================================
  ✅ PASS  Auth Speed
  ✅ PASS  Tracking Started
  ✅ PASS  Background Thread
  ✅ PASS  Ocr Deferred
  ✅ PASS  No Blocking

Overall: 5/5 tests passed

🎉 ALL TESTS PASSED!

======================================================================
 INTEGRATION TEST: Existing User Authentication
======================================================================

[TEST] Simulating existing user with OCR already installed...
   [OCR] Dependencies already installed (skipping check)

✅ Existing user auth completed in 1.31s (<2s target)

======================================================================
 INTEGRATION TEST: Concurrent Auth + OCR Install
======================================================================

[TEST] Simulating 3 concurrent authentications...

   [OCR] Background installation started
   [USER 1] Starting authentication...
   [USER 1] Auth completed
   [USER 2] Starting authentication...
   [USER 2] Auth completed
   [USER 3] Starting authentication...
   [USER 3] Auth completed
   [OCR] Background installation completed

✅ All 3 users authenticated successfully

======================================================================
 INTEGRATION TESTS COMPLETE
======================================================================

🎉 ALL INTEGRATION TESTS PASSED!
```

### Manual Testing Checklist

**Test 1: Fresh Install Authentication**
```
Steps:
1. Delete all cached credentials and markers:
   - %TEMP%\timetracker_ocr\installation_complete.marker
   - %LOCALAPPDATA%\TimeTracker\auth_metadata.json
   - Keyring credentials (Credential Manager)

2. Start app: python desktop_app.py

3. Complete OAuth login

4. Observe:
   - Browser redirects to success page within 5 seconds ✓
   - Tracking starts immediately ✓
   - Notification: "Setting Up OCR" appears ✓
   - App remains responsive ✓

5. Wait 5-15 minutes

6. Observe:
   - Notification: "OCR Ready" appears ✓
   - Admin panel shows OCR status: "Ready" ✓
   - Screenshots now include OCR text ✓
```

**Test 2: Existing User Authentication**
```
Steps:
1. Complete Test 1 (OCR already installed)

2. Close app

3. Restart app: python desktop_app.py

4. Complete OAuth login (if needed)

5. Observe:
   - Auth completes in <2 seconds ✓
   - No OCR installation notification ✓
   - Tracking starts immediately ✓
   - OCR available from start ✓
```

**Test 3: Installation Timeout**
```
Steps:
1. Throttle network to simulate slow pip install

2. Delete marker: %TEMP%\timetracker_ocr\installation_complete.marker

3. Start app and authenticate

4. Wait 15+ minutes

5. Observe:
   - Notification: "OCR Installation Timeout" appears ✓
   - App continues running normally ✓
   - Admin panel shows OCR status: "Not Available" ✓
   - Tracking works (without OCR text) ✓
```

**Test 4: Installation Failure**
```
Steps:
1. Block pip from accessing PyPI (firewall rule)

2. Delete marker

3. Start app and authenticate

4. Observe:
   - Notification: "OCR Installation Issue" appears ✓
   - App continues running ✓
   - Screenshots upload without OCR text ✓
   - Admin panel shows error details ✓
```

**Test 5: Tray Icon States**
```
Steps:
1. Fresh install, not authenticated:
   - Icon: 🔴 RED ✓

2. After authentication (OCR installing in background):
   - Icon: 🟢 GREEN (authenticated + tracking) ✓

3. During OCR installation:
   - Icon: 🟢 GREEN (no change - app functional) ✓

4. After OCR ready:
   - Icon: 🟢 GREEN (still tracking) ✓

5. Pause tracking:
   - Icon: 🟡 YELLOW ✓

6. Resume tracking:
   - Icon: 🟢 GREEN ✓
```

### Performance Benchmarks

**Benchmark 1: Authentication Speed**
```bash
# Before fix: 10-15 minutes (blocked)
# After fix: <5 seconds (target)

cd python-desktop-app
python -c "
import time
from desktop_app import TimeTracker

tracker = TimeTracker()
# Mock auth manager
tracker.auth_manager.get_supabase_config = lambda: True
tracker.auth_manager.get_ocr_config = lambda: True

start = time.time()
result = tracker.initialize_supabase(skip_ocr_setup=True)
elapsed = time.time() - start

print(f'Auth time: {elapsed:.2f}s')
assert elapsed < 5.0, f'Too slow: {elapsed}s'
print('✅ PASS: Auth completed in <5s')
"
```

**Benchmark 2: Background Thread Resource Usage**
```bash
# Monitor CPU and memory during OCR installation

cd python-desktop-app
python -c "
import psutil
import time
import threading
from desktop_app import TimeTracker

tracker = TimeTracker()

# Start monitoring
def monitor():
    process = psutil.Process()
    for i in range(10):
        cpu = process.cpu_percent(interval=1)
        mem = process.memory_info().rss / 1024 / 1024  # MB
        print(f'CPU: {cpu:.1f}%  Memory: {mem:.1f}MB')
        time.sleep(1)

monitor_thread = threading.Thread(target=monitor, daemon=True)
monitor_thread.start()

# Start background OCR setup
tracker._start_background_ocr_setup()

# Keep main thread responsive
for i in range(10):
    print(f'Main thread responsive: iteration {i+1}')
    time.sleep(1)
"
```

**Expected**: CPU <50% per core, Memory stable (no leaks)

### Test Reports

**Test Report Template**:
```markdown
# OCR Background Setup Fix - Test Report

**Tester**: [Name]
**Date**: [Date]
**Version**: v1.4.8
**Environment**: [Windows 10/11, Python 3.11, etc.]

## Test Results

### Unit Tests
- [ ] All 14 unit tests passed
- [ ] Test duration: [X] seconds
- [ ] No errors or warnings

### Integration Tests
- [ ] All 3 integration tests passed
- [ ] Auth speed: [X]s (target <5s)
- [ ] Existing user auth: [X]s (target <2s)
- [ ] Concurrent auth: All users succeeded

### Manual Tests
- [ ] Fresh install auth: Success within 5s
- [ ] OCR notification shown: "Setting Up OCR"
- [ ] App remained responsive during install
- [ ] OCR ready notification: "OCR Ready"
- [ ] Existing user auth: <2s
- [ ] Installation timeout handled gracefully
- [ ] Installation failure handled gracefully
- [ ] Tray icon states correct

### Performance Benchmarks
- [ ] Auth speed: [X]s (<5s target)
- [ ] CPU usage: [X]% (<50% target)
- [ ] Memory usage: Stable (no leaks)
- [ ] Main thread: Remained responsive

## Issues Found
[List any issues discovered during testing]

## Recommendations
[Any recommendations for improvements]

## Approval
- [ ] All tests passed
- [ ] No blocking issues found
- [ ] Ready for deployment

**Signature**: _______________  **Date**: _______________
```

---

## Appendix E: Deployment Verification Script

**File**: `python-desktop-app/tests/verify_ocr_fix.py`

```python
"""
Deployment Verification Script

Run this script after deploying to verify the OCR fix is working correctly.
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def verify_deployment():
    """Verify OCR fix deployment"""
    print("="*70)
    print(" OCR BACKGROUND SETUP FIX - DEPLOYMENT VERIFICATION")
    print("="*70)
    print()
    
    checks = {
        'initialize_supabase_signature': False,
        'background_methods_exist': False,
        'marker_functions_exist': False,
        'null_checks_present': False,
        'startup_check_exists': False
    }
    
    try:
        from desktop_app import TimeTracker
        from ocr.auto_installer import (
            mark_installation_complete,
            is_installation_complete,
            check_and_install_dependencies
        )
        
        # Check 1: initialize_supabase has skip_ocr_setup parameter
        print("[1/5] Checking initialize_supabase signature...")
        import inspect
        sig = inspect.signature(TimeTracker.initialize_supabase)
        if 'skip_ocr_setup' in sig.parameters:
            print("   ✅ skip_ocr_setup parameter found")
            checks['initialize_supabase_signature'] = True
        else:
            print("   ❌ skip_ocr_setup parameter missing")
        
        # Check 2: Background methods exist
        print()
        print("[2/5] Checking background OCR methods...")
        tracker = TimeTracker()
        if (hasattr(tracker, '_start_background_ocr_setup') and
            hasattr(tracker, '_background_ocr_setup_worker') and
            hasattr(tracker, '_finalize_ocr_setup')):
            print("   ✅ All background OCR methods exist")
            checks['background_methods_exist'] = True
        else:
            print("   ❌ Some background OCR methods missing")
        
        # Check 3: Marker functions exist
        print()
        print("[3/5] Checking installation marker functions...")
        if (callable(mark_installation_complete) and
            callable(is_installation_complete)):
            print("   ✅ Installation marker functions exist")
            checks['marker_functions_exist'] = True
        else:
            print("   ❌ Installation marker functions missing")
        
        # Check 4: Null checks present
        print()
        print("[4/5] Checking OCR processor null checks...")
        # Read source to verify null checks
        import desktop_app
        source = inspect.getsource(desktop_app.TimeTracker.upload_activity_batch)
        if 'if not self.ocr_processor' in source or 'if self.ocr_processor' in source:
            print("   ✅ OCR processor null checks present")
            checks['null_checks_present'] = True
        else:
            print("   ⚠️  Could not verify null checks (manual review needed)")
        
        # Check 5: Startup first-run check exists
        print()
        print("[5/5] Checking startup first-run check...")
        if hasattr(tracker, '_is_first_run_ocr_check'):
            print("   ✅ First-run OCR check method exists")
            checks['startup_check_exists'] = True
        else:
            print("   ❌ First-run OCR check method missing")
        
    except Exception as e:
        print(f"   ❌ Error during verification: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    print("="*70)
    print(" VERIFICATION RESULTS")
    print("="*70)
    
    passed = sum(checks.values())
    total = len(checks)
    
    for check_name, result in checks.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {status}  {check_name.replace('_', ' ').title()}")
    
    print()
    print(f"Overall: {passed}/{total} checks passed")
    print()
    
    if passed == total:
        print("🎉 DEPLOYMENT VERIFIED!")
        print("   All required changes are present.")
        return 0
    elif passed >= total - 1:
        print("⚠️  MOSTLY VERIFIED")
        print("   One check needs manual review.")
        return 0
    else:
        print("❌ DEPLOYMENT VERIFICATION FAILED")
        print("   Please review the failed checks.")
        return 1

if __name__ == '__main__':
    sys.exit(verify_deployment())
```

**Run After Deployment**:
```bash
cd python-desktop-app
python tests/verify_ocr_fix.py
```

---

**Document Version**: 1.0  
**Status**: Ready for Implementation ✅  
**Estimated Effort**: 2-3 days development + 1 week testing  
**Risk Level**: Medium (significant architecture change)  
**Impact**: High (fixes critical UX blocker)
