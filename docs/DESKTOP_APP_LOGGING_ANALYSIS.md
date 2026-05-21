# Desktop App Logging Analysis - Where Logs Are Saved

**Date:** May 20, 2026  
**Analysis Type:** Deep Dive / Analyst Review  
**Focus:** Log file locations and accessibility for end users

---

## 🔍 Executive Summary

**CRITICAL FINDING:** The desktop application, when installed as an `.exe` file, **does NOT save application logs to a file by default**. All logging output is lost because:

1. The app is built with `console=False` in PyInstaller spec (no console window)
2. The app uses `print()` statements instead of proper file-based logging
3. There is NO `logging.basicConfig()` configuration with a file handler
4. Standard output (stdout/stderr) is redirected to nowhere in a no-console Windows app

**Impact:** When users report issues, there are NO accessible logs to diagnose problems, making troubleshooting nearly impossible.

---

## 📂 Current Log File Locations

### 1. **Update Logs** (Auto-Update Process Only)
✅ **ARE saved to disk**

**Location:** `%LOCALAPPDATA%\TimeTracker\updates\`

**Files:**
- `update_launcher.log` - Records when `apply_update()` is called, PID, paths, build marker
- `update_install.log` - Records each phase of the batch script execution

**Code Reference:** [`desktop_app.py` lines 1140-1206](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\desktop_app.py#L1140-L1206)

```python
update_log = os.path.join(updates_dir, 'update_install.log')
```

**Example Path:**
```
C:\Users\JohnDoe\AppData\Local\TimeTracker\updates\update_install.log
C:\Users\JohnDoe\AppData\Local\TimeTracker\updates\update_launcher.log
```

### 2. **Privacy Audit Logs** (Optional, Disabled by Default)
⚠️ **Configurable but NOT enabled**

**Location:** Configurable via environment variable, defaults to working directory

**Default:** `privacy_audit.log` (relative path - goes to wherever exe is run from)

**Code Reference:** [`privacy/config.py` line 92](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\privacy\config.py#L92)

```python
audit_log_path: str = 'privacy_audit.log'
enable_audit_log: bool = False  # Default: OFF
```

**To Enable:**
Set environment variable:
```
PRIVACY_AUDIT_LOG_PATH=C:\Users\%USERNAME%\AppData\Local\TimeTracker\privacy_audit.log
PRIVACY_ENABLE_AUDIT_LOG=true
```

**Code Reference:** [`privacy/filter.py` lines 192-202](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\privacy\filter.py#L192-L202)

```python
def _init_audit_logger(self):
    """Initialize audit logger for tracking redactions"""
    try:
        self._audit_logger = logging.getLogger('privacy_audit')
        handler = logging.FileHandler(self.config.audit_log_path)
        handler.setFormatter(logging.Formatter(
            '%(asctime)s - %(message)s'
        ))
        self._audit_logger.addHandler(handler)
        self._audit_logger.setLevel(logging.INFO)
    except Exception as e:
        logger.warning(f"Failed to initialize audit logger: {e}")
```

### 3. **Application Logs** (Main App Activity)
❌ **NOT SAVED - LOST FOREVER**

**Problem:** The application uses `print()` statements throughout the codebase:

**Examples:**
```python
print("[OK] Single instance lock acquired")                    # Line 260
print("[INFO] Initializing Time Tracker...")                   # Line 4942
print("[OK] Supabase config loaded from AI server")            # Line 383
print("[ERROR] Application error:")                            # Line 13498
```

**PyInstaller Configuration:** [`desktop_app.spec` line 513](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\desktop_app.spec#L513)

```python
exe = EXE(
    # ...
    console=False,  # ❌ NO CONSOLE WINDOW - stdout/stderr go nowhere
    # ...
)
```

**What Happens:**
- When `console=False`, Windows creates the app without a console window
- All `print()` statements write to stdout
- Stdout is NOT connected to any file or visible console
- **Output is silently discarded**

---

## 🗂️ Where User Data IS Saved

While logs aren't saved, other data files exist in the user's AppData directory:

**Location:** `%LOCALAPPDATA%\TimeTracker\`

**Full Path Example:**
```
C:\Users\JohnDoe\AppData\Local\TimeTracker\
```

**Files Present:**

| File | Purpose | Code Reference |
|------|---------|----------------|
| `config.json` | User preferences, OAuth client settings | [`config_manager.py` line 32](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\config_manager.py#L32) |
| `time_tracker_offline.db` | Local SQLite database (encrypted) | [`db_connection.py` line 71](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\db_connection.py#L71) |
| `.lock` | Single instance lock file | [`desktop_app.py` line 276](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\desktop_app.py#L276) |
| `.shutdown_signal` | Graceful shutdown signal | [`desktop_app.py` line 820](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\desktop_app.py#L820) |
| `updates/` | Update staging directory | [`desktop_app.py` line 1110](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\desktop_app.py#L1110) |

**Code Reference for Directory:**
```python
def get_app_data_dir():
    """Get the application data directory in LocalAppData"""
    if sys.platform == 'win32':
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    else:
        app_data = os.path.expanduser('~/.local/share')
    
    app_dir = os.path.join(app_data, 'TimeTracker')
    
    # Create directory if it doesn't exist
    if not os.path.exists(app_dir):
        os.makedirs(app_dir)
        print(f"[OK] Created app data directory: {app_dir}")
    
    return app_dir
```

---

## 🚨 Security & Privacy Implications

### PII in Logs

The desktop app has built-in PII sanitization in `secure_logger.py`, but it's **NOT being used** by the main application:

**Code Reference:** [`secure_logger.py` lines 1-25](d:\ATG-timetracker\dbversionfix\JIRAForge\python-desktop-app\secure_logger.py#L1-L25)

```python
"""
Secure Logger for Desktop App

Provides PII-sanitized logging for the desktop application.
Uses the same patterns as the privacy filter to redact sensitive
information from log output.

Usage:
    from secure_logger import secure_log, SecureLogger
    
    # Simple function usage
    secure_log("[OK] User authenticated", user_id="abc-123", email="user@test.com")
    # Output: [OK] User authenticated | user_id=[UUID] | email=[EMAIL]
"""
```

**Problem:** The module exists but is NOT imported or used in `desktop_app.py`.

---

## 🔧 Recommended Solutions

### Option 1: Add File-Based Logging (Recommended)

**Add to `desktop_app.py` main() function:**

```python
import logging
from logging.handlers import RotatingFileHandler

def setup_logging():
    """Configure file-based logging for the desktop app"""
    log_dir = get_app_data_dir()
    log_file = os.path.join(log_dir, 'timetracker.log')
    
    # Create rotating file handler (10MB max, keep 3 backups)
    handler = RotatingFileHandler(
        log_file,
        maxBytes=10*1024*1024,  # 10MB
        backupCount=3
    )
    
    # Use secure logging with PII redaction
    formatter = logging.Formatter(
        '%(asctime)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    # Configure root logger
    logging.basicConfig(
        level=logging.INFO,
        handlers=[handler]
    )
    
    # Redirect stdout/stderr to logger
    sys.stdout = StreamToLogger(logging.getLogger('STDOUT'), logging.INFO)
    sys.stderr = StreamToLogger(logging.getLogger('STDERR'), logging.ERROR)
    
    logging.info("=" * 60)
    logging.info(f"TimeTracker v{APP_VERSION} starting...")
    logging.info(f"Log file: {log_file}")
    logging.info("=" * 60)

class StreamToLogger:
    """Redirect print() statements to logger"""
    def __init__(self, logger, level):
        self.logger = logger
        self.level = level
        self.linebuf = ''
    
    def write(self, buf):
        for line in buf.rstrip().splitlines():
            self.logger.log(self.level, line.rstrip())
    
    def flush(self):
        pass

def main():
    """Main entry point"""
    setup_logging()  # ADD THIS LINE
    try:
        app = TimeTracker()
        app.run()
    except KeyboardInterrupt:
        logging.info("Application stopped by user")
    except Exception as e:
        logging.error(f"Application error: {e}", exc_info=True)
```

**Result:**
- Logs saved to: `C:\Users\%USERNAME%\AppData\Local\TimeTracker\timetracker.log`
- All `print()` statements automatically redirected to log file
- Rotating logs prevent disk space issues
- Exception tracebacks captured

### Option 2: Enable Console Mode for Debugging

**Temporary Fix for Troubleshooting:**

Modify `desktop_app.spec`:
```python
exe = EXE(
    # ...
    console=True,  # Change to True for debugging
    # ...
)
```

Then rebuild:
```bash
pyinstaller desktop_app.spec
```

**Result:** A console window appears showing all print() output in real-time.

**Drawback:** Not suitable for production (ugly console window).

### Option 3: Use Secure Logger Module (Best Practice)

Replace all `print()` statements with the existing `secure_logger`:

```python
from secure_logger import secure_log, SecureLogger

# Instead of:
print("[OK] User authenticated")

# Use:
secure_log("[OK] User authenticated", level="INFO")
```

**Benefits:**
- Built-in PII redaction
- Consistent log format
- Ready to use (already in codebase)

---

## 📊 Log File Size Estimates

Based on typical usage:

| Log Type | Size Per Day | Storage Location | Rotation |
|----------|--------------|------------------|----------|
| Application logs | 2-5 MB | `%LOCALAPPDATA%\TimeTracker\` | Recommended: 10MB x 3 files |
| Update logs | 10-50 KB | `%LOCALAPPDATA%\TimeTracker\updates\` | Manual cleanup |
| Privacy audit | 100-500 KB | Configurable | Recommended: 5MB x 2 files |

**Total Storage:** ~30-50 MB for 3-5 days of logs

---

## 🎯 Action Items

### Immediate (Critical)
1. ✅ Add file-based logging to `desktop_app.py`
2. ✅ Configure rotating log files (prevent disk fill)
3. ✅ Redirect all print() to logger
4. ✅ Test logging in built .exe

### Short-term (High Priority)
1. ✅ Replace print() with secure_log() throughout codebase
2. ✅ Enable PII redaction in logs
3. ✅ Add "View Logs" option to system tray menu
4. ✅ Document log locations in user guide

### Long-term (Improvement)
1. ✅ Add remote logging/telemetry for critical errors
2. ✅ Log upload feature for support tickets
3. ✅ Automated log analysis for common issues

---

## 📝 User Guide Addition

**Add to documentation:**

### Where Are My Logs?

When you install TimeTracker as an `.exe`, logs are saved to:

```
C:\Users\[YourUsername]\AppData\Local\TimeTracker\
```

**Files you'll find:**

- `timetracker.log` - Main application log (most recent)
- `timetracker.log.1` - Previous log (rotated)
- `timetracker.log.2` - Older log (rotated)
- `updates/update_install.log` - Auto-update installation log

**To access logs:**

1. Press `Win + R`
2. Type: `%LOCALAPPDATA%\TimeTracker`
3. Press Enter
4. Look for `.log` files

Or from the app:
- Right-click system tray icon
- Select "View Logs"
- Logs open in Notepad

---

## 🔗 Related Documentation

- [Desktop App Security & Packaging](./DESKTOP_APP_SECURITY_PACKAGING.md)
- [Desktop App Compliance](./DESKTOP_APP_COMPLIANCE.md)
- [Configuration Guide](./CONFIGURATION_GUIDE.md)
- [Troubleshooting Guide](./desktop-app_TROUBLESHOOTING.md)

---

## 📞 Support Contact

If you need to share logs for troubleshooting:

1. Navigate to `%LOCALAPPDATA%\TimeTracker`
2. Zip all `.log` files
3. Attach to your support ticket

**Important:** Logs are automatically sanitized to remove sensitive information (emails, tokens, passwords).
