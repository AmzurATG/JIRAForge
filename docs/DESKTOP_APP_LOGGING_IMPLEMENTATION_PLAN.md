# Desktop App Logging Implementation Plan

**Date:** May 20, 2026  
**Priority:** CRITICAL  
**Status:** Ready for Implementation  

---

## 🎯 Objectives

Implement comprehensive logging to diagnose and fix critical user issues:

1. **Session Expired Issues** - Users seeing "Session expired, login again" notifications
2. **Tracking Delays** - Some users experience 2-3 day delays before tracking starts
3. **General Diagnostics** - Enable support team to troubleshoot user issues

---

## 🚨 Current Problems

### Issue 1: Session Expiry Loop
**User Report:** "Keep getting session expired notification"

**Possible Root Causes:**
- JWT token refresh failures
- Supabase token expiration (default: 1 hour)
- AI server connectivity issues during token exchange
- Clock skew between user PC and server
- Network interruptions during refresh

**What We Need to Log:**
- Token expiration timestamps
- Token refresh attempts and failures
- Network connectivity status during auth operations
- JWT exchange response codes
- Time differences (client vs server)

### Issue 2: Tracking Delays (2-3 Days)
**User Report:** "App installed but didn't start tracking for 3 days"

**Possible Root Causes:**
- App not actually running (no system tray icon)
- Silent authentication failures
- OCR engine initialization failures
- Project key not set/detected
- Network issues preventing Supabase uploads
- Database write failures

**What We Need to Log:**
- App startup timestamp
- Authentication success/failure with details
- OCR initialization status
- Screenshot capture attempts
- Activity record creation and upload status
- Project key detection
- Supabase sync attempts and failures

---

## 📋 Implementation Plan

### Phase 1: Core Logging Infrastructure (Day 1)

#### 1.1 Create Enhanced Logging Module

**File:** `python-desktop-app/app_logger.py` (NEW)

**Features:**
- Rotating file handler (10MB per file, 5 backups = 50MB total)
- PII redaction using existing `secure_logger.py` patterns
- Structured logging with correlation IDs
- Automatic stdout/stderr redirection
- Performance metrics
- Log levels: DEBUG, INFO, WARNING, ERROR, CRITICAL

**Code Structure:**
```python
class AppLogger:
    - setup_logging()          # Initialize file handlers
    - get_logger(name)         # Get logger instance
    - log_auth_event()         # Auth-specific logging
    - log_tracking_event()     # Tracking-specific logging
    - log_network_event()      # Network diagnostics
    - log_ocr_event()          # OCR diagnostics
    - sanitize_message()       # PII redaction
```

#### 1.2 Modify desktop_app.py

**Changes Required:**

1. **Import logger at top:**
```python
from app_logger import AppLogger, get_logger
```

2. **Initialize in main():**
```python
def main():
    # Setup logging FIRST
    app_logger = AppLogger()
    app_logger.setup_logging()
    logger = get_logger(__name__)
    
    logger.info("="*60)
    logger.info(f"TimeTracker v{APP_VERSION} starting")
    logger.info(f"OS: {platform.system()} {platform.release()}")
    logger.info(f"Python: {sys.version}")
    logger.info(f"Log location: {app_logger.log_file}")
    logger.info("="*60)
    
    # ... rest of main()
```

3. **Replace critical print() statements:**
   - Keep print() for user-facing messages
   - Add logger calls for diagnostics
   - Dual-log critical events

### Phase 2: Authentication Logging (Day 1-2)

#### 2.1 Token Lifecycle Tracking

**What to Log:**

```python
# AtlassianAuthManager class modifications:

def get_supabase_token(self):
    """Get Supabase token via AI server JWT exchange"""
    logger.info("Requesting Supabase token from AI server")
    
    # Log request details
    logger.debug(f"Access token present: {bool(self.tokens.get('access_token'))}")
    logger.debug(f"Access token expires at: {self.tokens.get('expires_at')}")
    
    try:
        response = requests.post(...)
        logger.info(f"JWT exchange response: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            expires_in = result.get('expires_in', 0)
            logger.info(f"Supabase token obtained, expires in: {expires_in}s ({expires_in/3600:.1f}h)")
            
            # Log token expiry warning
            if expires_in < 1800:  # Less than 30 minutes
                logger.warning(f"Token expires soon: {expires_in}s remaining")
        else:
            logger.error(f"JWT exchange failed: {response.status_code} {response.text}")
            
    except requests.exceptions.ConnectionError as e:
        logger.error(f"Network error during JWT exchange: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"Unexpected error in JWT exchange: {e}", exc_info=True)

def get_valid_supabase_token(self):
    """Get a valid Supabase token, refreshing if needed"""
    supabase_token = self.tokens.get('supabase_token')
    expires_at = self.tokens.get('supabase_token_expires_at', 0)
    time_remaining = expires_at - time.time()
    
    # Log token status
    logger.debug(f"Token check: time_remaining={time_remaining:.0f}s")
    
    if supabase_token and time_remaining > 300:
        logger.debug("Using cached Supabase token")
        return supabase_token
    
    logger.info("Token expired or missing, refreshing...")
    logger.info(f"Token status: exists={bool(supabase_token)}, time_remaining={time_remaining:.0f}s")
    
    # Log refresh attempts
    for attempt in range(3):
        logger.info(f"Token refresh attempt {attempt + 1}/3")
        try:
            token = self.get_supabase_token()
            if token:
                logger.info("Token refresh successful")
                return token
        except Exception as e:
            logger.error(f"Token refresh attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                wait_time = (attempt + 1) * 3
                logger.info(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
    
    logger.error("Token refresh failed after 3 attempts")
    return None
```

#### 2.2 Session Expiry Detection

**Add monitoring for:**
- Token refresh failures
- 401/403 responses from Supabase
- Auth state changes
- Login prompt triggers

```python
def show_login_reminder(self):
    """Show notification to user to log in again"""
    logger.warning("Showing login reminder to user")
    logger.info(f"Auth state: logged_in={self.is_logged_in}, "
                f"token_exists={bool(self.tokens.get('access_token'))}, "
                f"token_expired={self._is_token_expired()}")
    
    # ... show notification
    
    logger.info("Login reminder displayed")
```

### Phase 3: Tracking Activity Logging (Day 2-3)

#### 3.1 Startup Sequence Logging

**Log critical checkpoints:**

```python
class TimeTracker:
    def __init__(self):
        logger.info("Initializing TimeTracker...")
        
        # Log configuration
        logger.info(f"Capture interval: {self.capture_interval}s")
        logger.info(f"Web port: {self.web_port}")
        logger.info(f"Screenshot monitoring: {'DISABLED' if SCREENSHOT_MONITORING_HARD_DISABLED else 'ENABLED'}")
        
        # Log auth initialization
        logger.info("Initializing authentication manager...")
        self.auth_manager = AtlassianAuthManager(web_port=self.web_port)
        logger.info("Authentication manager initialized")
        
        # Log database connection
        logger.info("Checking database connection...")
        # ... db checks
        logger.info(f"Database status: {db_status}")

    def run(self):
        """Main run loop"""
        logger.info("Starting TimeTracker main loop")
        
        # Log authentication status
        if not self.is_authenticated():
            logger.warning("Not authenticated - starting login flow")
            self.start_login_flow()
        else:
            logger.info("Already authenticated - starting tracking")
        
        # Log tracking start
        logger.info("Starting activity tracking...")
        self.start_tracking()
        
        logger.info("TimeTracker running - monitoring system tray for exit signal")
```

#### 3.2 Activity Capture Logging

**Log each capture cycle:**

```python
def capture_and_process_activity(self):
    """Capture screenshot and process activity"""
    capture_start = time.time()
    logger.debug("Starting activity capture cycle")
    
    try:
        # Log window info
        window_title = self.get_active_window_title()
        app_name = self.get_active_app_name()
        logger.info(f"Active window: app={app_name}, title={window_title[:50]}...")
        
        # Log screenshot capture
        logger.debug("Capturing screenshot...")
        screenshot = self.capture_screenshot()
        logger.debug(f"Screenshot captured: {screenshot.size}")
        
        # Log OCR processing
        logger.debug("Extracting text with OCR...")
        ocr_start = time.time()
        ocr_text = extract_text_from_image(screenshot)
        ocr_duration = time.time() - ocr_start
        logger.info(f"OCR completed in {ocr_duration:.2f}s, extracted {len(ocr_text)} chars")
        
        # Log activity record creation
        logger.debug("Creating activity record...")
        record = self.create_activity_record(window_title, app_name, ocr_text)
        logger.info(f"Activity record created: id={record.get('id')}")
        
        # Log upload attempt
        logger.debug("Uploading to Supabase...")
        result = self.upload_to_supabase(record)
        
        if result.get('success'):
            logger.info("Activity record uploaded successfully")
        else:
            logger.error(f"Upload failed: {result.get('error')}")
        
        capture_duration = time.time() - capture_start
        logger.info(f"Capture cycle completed in {capture_duration:.2f}s")
        
    except Exception as e:
        logger.error(f"Error in capture cycle: {e}", exc_info=True)
```

#### 3.3 Project Key Detection Logging

**Critical for tracking delays:**

```python
def detect_project_key(self, window_title, ocr_text):
    """Detect Jira project key from window/text"""
    logger.debug(f"Detecting project key from window: {window_title[:100]}")
    
    # Try window title
    project_key = self.extract_project_key_from_title(window_title)
    if project_key:
        logger.info(f"Project key detected from window title: {project_key}")
        return project_key
    
    # Try OCR text
    project_key = self.extract_project_key_from_text(ocr_text)
    if project_key:
        logger.info(f"Project key detected from OCR text: {project_key}")
        return project_key
    
    logger.warning("No project key detected - activity may not be tracked")
    return None
```

### Phase 4: Network & Sync Logging (Day 3)

#### 4.1 Network Connectivity Monitoring

**Log network status:**

```python
def check_network_connectivity(self):
    """Check if we can reach critical endpoints"""
    logger.debug("Checking network connectivity...")
    
    endpoints = {
        'AI Server': get_env_var('AI_SERVER_URL'),
        'Supabase': get_env_var('SUPABASE_URL'),
    }
    
    results = {}
    for name, url in endpoints.items():
        try:
            response = requests.get(url, timeout=5)
            results[name] = 'OK'
            logger.debug(f"{name}: OK ({response.status_code})")
        except Exception as e:
            results[name] = 'FAILED'
            logger.warning(f"{name}: FAILED - {e}")
    
    if all(v == 'OK' for v in results.values()):
        logger.info("Network connectivity: ALL OK")
    else:
        logger.warning(f"Network connectivity issues: {results}")
    
    return results
```

#### 4.2 Offline Queue Logging

**Track offline records:**

```python
def sync_offline_records(self):
    """Sync offline records when network is available"""
    logger.info("Starting offline records sync...")
    
    offline_records = self.get_offline_records()
    logger.info(f"Found {len(offline_records)} offline records to sync")
    
    success_count = 0
    failed_count = 0
    
    for record in offline_records:
        try:
            result = self.upload_to_supabase(record)
            if result.get('success'):
                success_count += 1
                logger.debug(f"Synced offline record: {record.get('id')}")
            else:
                failed_count += 1
                logger.warning(f"Failed to sync record {record.get('id')}: {result.get('error')}")
        except Exception as e:
            failed_count += 1
            logger.error(f"Error syncing record {record.get('id')}: {e}")
    
    logger.info(f"Offline sync completed: {success_count} success, {failed_count} failed")
```

### Phase 5: Diagnostic Endpoints (Day 4)

#### 5.1 Health Check Endpoint

**Add to Flask web server:**

```python
@app.route('/health')
def health_check():
    """Health check endpoint with diagnostics"""
    logger.debug("Health check requested")
    
    health = {
        'status': 'ok',
        'version': APP_VERSION,
        'uptime_seconds': time.time() - start_time,
        'authenticated': tracker.is_authenticated(),
        'tracking_active': tracker.tracking_active,
        'last_capture': tracker.last_capture_time,
        'offline_records': len(tracker.get_offline_records()),
        'log_file': app_logger.log_file,
    }
    
    logger.info(f"Health check: {health}")
    return jsonify(health)
```

#### 5.2 Log Viewer Endpoint

**Allow users to view recent logs:**

```python
@app.route('/logs')
def view_logs():
    """View recent log entries"""
    logger.debug("Log viewer requested")
    
    try:
        with open(app_logger.log_file, 'r') as f:
            lines = f.readlines()
            recent_logs = lines[-500:]  # Last 500 lines
        
        return jsonify({
            'logs': recent_logs,
            'total_lines': len(lines),
            'log_file': app_logger.log_file
        })
    except Exception as e:
        logger.error(f"Error reading logs: {e}")
        return jsonify({'error': str(e)}), 500
```

### Phase 6: System Tray Integration (Day 4)

#### 6.1 Add "View Logs" Menu Item

**Modify system tray menu:**

```python
def create_tray_menu(self):
    """Create system tray menu"""
    menu_items = [
        item('Dashboard', lambda: self.open_dashboard()),
        item('Tracking Status', lambda: self.show_tracking_status()),
        item('View Logs', lambda: self.open_log_viewer()),  # NEW
        item('Separator'),
        item('Pause Tracking', lambda: self.toggle_pause()),
        item('Settings', lambda: self.open_settings()),
        item('Separator'),
        item('Exit', lambda: self.exit_app()),
    ]
    return menu_items

def open_log_viewer(self):
    """Open log file in default text editor"""
    logger.info("Opening log viewer")
    try:
        if sys.platform == 'win32':
            os.startfile(app_logger.log_file)
        else:
            subprocess.call(['xdg-open', app_logger.log_file])
        logger.info("Log file opened")
    except Exception as e:
        logger.error(f"Failed to open log file: {e}")
        self.show_notification("Error", "Could not open log file")
```

---

## 📊 Log Format Specification

### Standard Log Entry Format

```
2026-05-20 14:30:45,123 - INFO - [AUTH] - Token refresh successful (expires_in=3600s)
2026-05-20 14:30:50,456 - DEBUG - [TRACKING] - Capture cycle started
2026-05-20 14:30:51,789 - INFO - [TRACKING] - Active window: app=chrome.exe, title=JIRA-123: Bug fix...
2026-05-20 14:30:52,012 - INFO - [OCR] - Text extracted in 0.85s (1234 chars)
2026-05-20 14:30:52,345 - INFO - [TRACKING] - Activity record uploaded (id=abc-123)
2026-05-20 14:30:52,678 - INFO - [TRACKING] - Capture cycle completed in 2.35s
```

### Log Entry Components

```
[TIMESTAMP] - [LEVEL] - [COMPONENT] - [MESSAGE]
```

**Components:**
- `[AUTH]` - Authentication/token operations
- `[TRACKING]` - Activity capture and tracking
- `[OCR]` - OCR processing
- `[NETWORK]` - Network connectivity
- `[SYNC]` - Offline sync operations
- `[SYSTEM]` - System events (sleep, wake, etc.)
- `[ERROR]` - Error details with stack traces

### Sensitive Data Redaction

**Automatically redact:**
- Email addresses → `[EMAIL]`
- JWT tokens → `[JWT]`
- UUIDs (user/org IDs) → `[UUID]`
- API keys → `[API_KEY]`
- Passwords → `[PASSWORD]`
- Credit cards → `[CREDIT_CARD]`

**Example:**
```
# Before redaction:
User logged in: john.doe@company.com with token eyJhbGc...

# After redaction:
User logged in: [EMAIL] with token [JWT]
```

---

## 📁 File Structure

```
python-desktop-app/
├── app_logger.py                    # NEW - Main logging module
├── desktop_app.py                   # MODIFIED - Add logging calls
├── secure_logger.py                 # EXISTING - Use for PII redaction
├── auth/
│   └── __init__.py                  # MODIFIED - Add auth logging
└── logs/                            # NEW - Log directory (gitignored)
    ├── timetracker.log              # Current log
    ├── timetracker.log.1            # Rotated log
    ├── timetracker.log.2            # Rotated log
    ├── timetracker.log.3            # Rotated log
    └── timetracker.log.4            # Rotated log
```

**Storage Location:**
```
%LOCALAPPDATA%\TimeTracker\logs\
```

**Example:**
```
C:\Users\JohnDoe\AppData\Local\TimeTracker\logs\timetracker.log
```

---

## 🧪 Testing Plan

### Test 1: Log File Creation
1. Build new .exe with logging
2. Install on clean Windows VM
3. Run app
4. Verify log file created at: `%LOCALAPPDATA%\TimeTracker\logs\timetracker.log`
5. Verify log contains startup messages

### Test 2: Session Expiry Logging
1. Force token expiration (modify token timestamp)
2. Trigger token refresh
3. Verify logs show:
   - Token expiry detection
   - Refresh attempts
   - Success/failure status

### Test 3: Tracking Delay Diagnosis
1. Fresh install
2. Complete authentication
3. Verify logs show:
   - Auth success
   - OCR initialization
   - First capture attempt
   - Project key detection
   - Upload success

### Test 4: Network Failure Handling
1. Disconnect network
2. Attempt tracking
3. Verify logs show:
   - Network failure detection
   - Offline queue creation
   - Reconnect and sync

### Test 5: Log Rotation
1. Generate >10MB of logs
2. Verify rotation occurs
3. Verify only 5 log files kept
4. Verify old logs deleted

### Test 6: PII Redaction
1. Trigger log entries with sensitive data
2. Review log file
3. Verify all PII redacted

---

## 📈 Success Metrics

### Immediate (Week 1)
- ✅ Log file created on all user machines
- ✅ Session expiry events captured with root cause
- ✅ Tracking delays diagnosed within 24 hours

### Short-term (Month 1)
- ✅ 90% reduction in "can't diagnose" support tickets
- ✅ Average support ticket resolution time: 2 hours → 30 minutes
- ✅ Proactive issue detection before user reports

### Long-term (Quarter 1)
- ✅ Session expiry rate: < 1% of users
- ✅ Tracking delay issues: < 0.5% of installations
- ✅ Automated error reports to development team

---

## 🚀 Deployment Plan

### Phase 1: Development & Testing (Days 1-4)
- Implement logging module
- Add logging calls throughout codebase
- Test on development machines
- Code review

### Phase 2: Beta Testing (Days 5-7)
- Build test .exe with logging
- Deploy to 5-10 beta users experiencing issues
- Monitor logs remotely
- Fix any logging issues

### Phase 3: Production Rollout (Days 8-10)
- Build production .exe
- Deploy via auto-update system
- Monitor adoption rate
- Support team training on log analysis

### Phase 4: Monitoring & Improvement (Ongoing)
- Weekly log analysis
- Identify common error patterns
- Add additional logging as needed
- Refine log levels and messages

---

## 📝 Documentation Updates

### User Documentation
1. **Help Article:** "Where are my TimeTracker logs?"
2. **Troubleshooting Guide:** "How to share logs with support"
3. **FAQ:** "What data is in the log files?"

### Developer Documentation
1. **Logging Standards:** When and what to log
2. **Log Analysis Guide:** Common patterns and fixes
3. **Adding New Logs:** Code examples and best practices

### Support Documentation
1. **Log Location Reference**
2. **Common Error Patterns**
3. **Escalation Procedures**

---

## 🔒 Privacy & Security

### Data Retention
- Logs kept for 7 days locally
- Automatically rotated and deleted
- No logs sent to server without user consent

### Sensitive Data Handling
- All PII automatically redacted
- Tokens masked in logs
- User can review logs before sharing

### Compliance
- GDPR compliant (no PII stored)
- User can delete logs anytime
- Logs deleted on uninstall

---

## 💰 Cost & Resource Estimate

### Development Time
- Implementation: 3-4 days
- Testing: 2-3 days
- Documentation: 1-2 days
- **Total: 6-9 days** (1.5-2 weeks)

### Storage Impact
- Per user: 50MB max (5 x 10MB log files)
- For 1000 users: 50GB total (distributed across user machines)
- No server storage required

### Performance Impact
- Log write overhead: < 1ms per entry
- No noticeable performance impact
- Disk I/O: Minimal (buffered writes)

---

## 📞 Support Team Training

### Training Topics
1. How to request logs from users
2. How to read and interpret logs
3. Common error patterns and solutions
4. When to escalate to development team

### Training Materials
- Video walkthrough of log analysis
- Cheat sheet of common errors
- Practice exercises with sample logs

---

## ✅ Implementation Checklist

### Code Changes
- [ ] Create `app_logger.py` module
- [ ] Modify `desktop_app.py` - add logging setup in main()
- [ ] Modify `AtlassianAuthManager` - add auth logging
- [ ] Modify `TimeTracker.run()` - add tracking logging
- [ ] Modify `capture_and_process_activity()` - add capture logging
- [ ] Add network connectivity checks with logging
- [ ] Add system tray "View Logs" menu item
- [ ] Add Flask `/health` endpoint
- [ ] Add Flask `/logs` endpoint

### Testing
- [ ] Test log file creation
- [ ] Test log rotation
- [ ] Test PII redaction
- [ ] Test session expiry logging
- [ ] Test tracking delay logging
- [ ] Test network failure logging
- [ ] Test offline queue logging
- [ ] Test system tray menu

### Documentation
- [ ] User guide for accessing logs
- [ ] Developer logging standards
- [ ] Support log analysis guide
- [ ] Privacy policy update

### Deployment
- [ ] Code review
- [ ] Beta testing with 5-10 users
- [ ] Production build
- [ ] Deploy via auto-update
- [ ] Monitor rollout
- [ ] Support team training

---

## 🎯 Next Steps

1. **Review this plan** with team
2. **Approve implementation approach**
3. **Assign developer** to implementation
4. **Set timeline** for completion
5. **Begin Phase 1** (Core Infrastructure)

**Estimated Start Date:** Immediately  
**Estimated Completion:** 2 weeks  
**Priority:** CRITICAL - Blocking user issue resolution
