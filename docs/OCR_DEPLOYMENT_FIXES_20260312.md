# OCR Deployment Fixes - March 12, 2026

## Problem Summary

Users reported that OCR was failing on deployed systems (other machines running the built exe). All activity records showed:
- `ocr_method: "metadata"` 
- `ocr_error_message: "OCR failed with method: metadata"`
- `ocr_text: null`

Additionally, even when Tesseract was working, the AI was not matching activities to Jira issues effectively.

**NEW**: Users couldn't see OCR diagnostic logs on deployed systems, making debugging difficult.

---

## Root Cause Analysis

### Issue 1: PaddleOCR Not Working

**Root Cause**: PaddleOCR stores/expects models in `~/.paddleocr/` (user's home directory). When bundled with PyInstaller:
- Models were bundled to `sys._MEIPASS/.paddleocr/` (temp extraction folder)
- PaddleOCR couldn't find them because it only looks in `~/.paddleocr/`
- Auto-download was attempted but may fail due to network/firewall restrictions

### Issue 2: Tesseract Path Not Found

**Root Cause**: Tesseract binary and tessdata were bundled in the exe but:
- The code wasn't detecting the bundled paths in `sys._MEIPASS/tesseract/`
- Without explicit path configuration, pytesseract couldn't find the binary

### Issue 3: AI Not Matching Issues

**Root Cause**: When OCR fails and falls back to metadata-only:
- AI only had `window_title` and `application_name` to work with
- The prompts weren't optimized for metadata-only matching
- AI was being too conservative and returning `null` for task matches

### Issue 4: No Remote Diagnostic Visibility

**Root Cause**: Logs were only visible on local machines:
- No way to see OCR initialization errors remotely
- Login failures didn't send diagnostic data
- Admins couldn't troubleshoot deployed systems

---

## Fixes Applied

### Fix 1: PaddleOCR Model Setup (paddle_engine.py)

**File**: `python-desktop-app/ocr/engines/paddle_engine.py`

Added `_setup_bundled_paddleocr_models()` function that runs at module import:

```python
def _setup_bundled_paddleocr_models():
    """
    Setup bundled PaddleOCR models for PyInstaller exe deployment.
    
    Flow:
    1. Check if models exist in user's home (~/.paddleocr/whl/)
    2. If not, and running as frozen exe, copy from bundled location
    3. If bundled models don't exist, PaddleOCR will auto-download
    """
```

**Changes**:
- Copies bundled models from `sys._MEIPASS/.paddleocr/` to `~/.paddleocr/`
- Only runs once (skips if models already exist)
- Falls back to auto-download if bundled models not found
- Added detailed logging for troubleshooting
- **NEW**: Stores initialization errors in `_init_error` for diagnostics

### Fix 2: Tesseract Bundled Path Detection (tesseract_engine.py)

**File**: `python-desktop-app/ocr/engines/tesseract_engine.py`

Added `_get_bundled_tesseract_paths()` function:

```python
def _get_bundled_tesseract_paths() -> Tuple[Optional[str], Optional[str]]:
    """
    Detect bundled Tesseract paths when running as a frozen PyInstaller exe.
    
    Returns:
        Tuple of (tesseract_exe_path, tessdata_prefix) or (None, None)
    """
```

**Changes**:
- Detects `sys._MEIPASS/tesseract/tesseract.exe`
- Auto-sets `TESSDATA_PREFIX` for language data
- Falls back to system PATH if bundled not found
- Priority order: explicit config → env vars → bundled → system PATH

### Fix 3: Enhanced OCR Diagnostics (facade.py)

**File**: `python-desktop-app/ocr/facade.py`

**NEW Enhanced Methods**:

```python
def get_ocr_diagnostics(self) -> Dict[str, Any]:
    """Get comprehensive OCR diagnostics including:
    - System info (platform, hostname, Python version)
    - Engine initialization details with error messages
    - Bundled dependency paths and status
    - Model availability (bundled vs user home)
    - Recommendations for fixing issues
    """
    
def _get_engine_init_details(self) -> Dict[str, Any]:
    """Get detailed initialization info for each engine:
    - PaddleOCR: module version, model paths, init errors
    - Tesseract: binary path, tessdata path, version
    """
    
def get_diagnostics_json(self) -> str:
    """Get diagnostics as JSON for sending to AI server."""
```

**Detailed Log Output Example**:
```
============================================================
OCR DIAGNOSTICS REPORT
============================================================
Timestamp: 2026-03-12T10:30:45Z
Running as frozen exe: True
Bundled path (_MEIPASS): C:\Users\...\AppData\Local\Temp\_MEI...
System: Windows 10.0.19045 | Python: 3.10.11
Hostname: LAPTOP-ABC123
Primary engine: paddle
Fallback engines: ['tesseract']
----------------------------------------
ENGINE INITIALIZATION DETAILS:
  [PaddleOCR]
    Module available: True
    Version: 2.8.1
    Engine ready: True
    User models exist: True
    User models path: C:\Users\...\.paddleocr
  [Tesseract]
    Module available: True
    Version: 5.3.1
    Engine ready: True
    Bundled exe exists: True
    Bundled tessdata exists: True
----------------------------------------
OCR Status: READY
============================================================
```

### Fix 4: Remote Diagnostics Endpoint (AI Server)

**File**: `ai-server/src/controllers/auth-controller.js`

**NEW** - Added `/api/auth/diagnostics` endpoint:

```javascript
/**
 * POST /api/auth/diagnostics
 * Body: { 
 *   atlassian_token: string,
 *   type: 'ocr' | 'login' | 'error',
 *   diagnostics: object 
 * }
 */
exports.submitDiagnostics = async (req, res) => {
    // Logs diagnostics with structured format for searching:
    // [DIAG:OCR] User: user@email.com | Host: LAPTOP | Platform: Windows
    // [DIAG:OCR] PaddleOCR: module=true, engine=true, user_models=true
    // [DIAG:LOGIN] Login Status: failed | Step: token_exchange
}
```

**Log Format** (in AI server logs):
```
[DIAG:OCR] User: john@company.com | Host: LAPTOP-123 | Platform: Windows | App: 1.0.1
[DIAG:OCR] OCR Status: ready
[DIAG:OCR] PaddleOCR: module=true, engine=true, user_models=true, version=2.8.1
[DIAG:OCR] Tesseract: module=true, engine=true, version=5.3.1
[DIAG:OCR] Bundled: tesseract=YES, paddle_bundled=YES, paddle_user=YES
```

### Fix 5: Desktop App Diagnostics Integration

**File**: `python-desktop-app/desktop_app.py`

Added diagnostic sending functions:

```python
def send_diagnostics(self, diag_type: str, diagnostics: dict) -> bool:
    """Send diagnostics to AI server for remote debugging."""

def send_ocr_diagnostics(auth_manager):
    """Collect and send OCR diagnostics after login."""

def send_login_diagnostics(auth_manager, status, step, error=None):
    """Send login event diagnostics (success/failure)."""
```

**Integration Points**:
- OCR diagnostics sent automatically after successful login
- Login failures send detailed error diagnostics
- Error categories: timeout, connection, token_exchange, access_denied, etc.

### Fix 6: Improved Login Error Messages

**File**: `python-desktop-app/desktop_app.py`

**Enhanced Error Handling**:

```python
# Categorized error messages for users
if error_category == 'timeout':
    hint = "The authentication server is taking too long to respond."
elif error_category == 'connection':
    hint = "Could not connect to the authentication server."
elif error_category == 'access_denied':
    hint = "Access was denied. Please ensure your Jira account has the TimeTracker app installed."
```

**HTTP Error Details**:
```python
if response.status_code == 403:
    if 'not associated with an organization' in error:
        raise Exception(
            "Access denied: Your Jira account is not registered with an organization "
            "that has the TimeTracker Forge app installed. "
            "Please ask your Jira administrator to install the app."
        )
```

### Fix 7: Improved PyInstaller Spec (desktop_app.spec)

**File**: `python-desktop-app/desktop_app.spec`

**Changes**:
- Search multiple Tesseract installation locations
- Validate PaddleOCR models exist before bundling
- Show clear BUILD CONFIGURATION SUMMARY
- Warnings if dependencies not found

### Fix 8: AI Matching Improvements (activity-service.js)

**File**: `ai-server/src/services/activity-service.js`

**Changes to System Prompt**:
- Added detailed matching guidelines for metadata-only analysis
- Improved confidence scoring
- Better handling of "(no text extracted)" cases

---

## How to View Remote Diagnostics

### Viewing OCR Diagnostics

After users log in, check AI server logs for:

```bash
# Search for OCR diagnostics
grep "DIAG:OCR" /var/log/ai-server.log

# Filter by user
grep "DIAG:OCR.*john@company.com" /var/log/ai-server.log

# Find failures
grep "DIAG:OCR.*engine=false" /var/log/ai-server.log
```

### Viewing Login Failures

```bash
# All login failures
grep "DIAG:LOGIN.*failed" /var/log/ai-server.log

# Specific error types
grep "DIAG:LOGIN.*timeout" /var/log/ai-server.log
grep "DIAG:LOGIN.*access_denied" /var/log/ai-server.log
```

---

## Build Process

### Prerequisites on Build Machine

1. **Install Tesseract OCR**:
   ```
   Download from: https://github.com/UB-Mannheim/tesseract/wiki
   Install to: C:\Program Files\Tesseract-OCR\
   ```

2. **Download PaddleOCR Models**:
   ```bash
   python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='en')"
   ```
   This downloads models to `~/.paddleocr/whl/`

3. **Build the exe**:
   ```bash
   cd python-desktop-app
   build.bat
   ```

4. **Verify build output** shows:
   ```
   ======================================================================
   BUILD CONFIGURATION SUMMARY
   ======================================================================
     Tesseract OCR:     FOUND - Will be bundled
     PaddleOCR models:  FOUND - Will be bundled
   ======================================================================
   ```

---

## Deployment Behavior

### On Target Machine (First Run)

1. **App starts** → OCR module initializes
2. **PaddleOCR check**:
   - Checks `~/.paddleocr/whl/` for models
   - If not found, copies from bundled location
   - If bundled not found, attempts auto-download
3. **Tesseract check**:
   - Uses bundled binary from `_MEIPASS/tesseract/`
   - Sets TESSDATA_PREFIX automatically
4. **User logs in** → Diagnostics logged locally AND sent to AI server
5. **OCR diagnostics** sent to server for remote monitoring

---

## Troubleshooting Guide

### PaddleOCR Shows "UNAVAILABLE"

**Check AI server logs for**:
```
[DIAG:OCR] PaddleOCR Init Error: <error message>
```

**Common Errors**:
- SSL/Certificate error → Proxy/firewall blocking download
- Connection timeout → No internet access
- Permission denied → Can't write to user's home directory

**Solutions**:
1. Ensure internet access on first run
2. Manually copy `~/.paddleocr/` from working machine
3. Add exception for paddle's download servers in firewall

### Tesseract Shows "UNAVAILABLE"

**Check AI server logs for**:
```
[DIAG:OCR] Tesseract: engine=false
```

**Solutions**:
- Rebuild exe with Tesseract installed on build machine
- Verify `tesseract/tesseract.exe` exists in bundled path

### Login Failures

**Check AI server logs for**:
```
[DIAG:LOGIN] Login Status: failed | Step: <step>
[DIAG:LOGIN] Login Error: <message>
```

**Common Errors**:
- `access_denied` → User's org doesn't have Forge app installed
- `timeout` → AI server slow or unreachable
- `connection` → Network issues on client

---

## Files Modified

| File | Changes |
|------|---------|
| `python-desktop-app/ocr/engines/paddle_engine.py` | Added model setup, improved error logging, stores init errors |
| `python-desktop-app/ocr/engines/tesseract_engine.py` | Added bundled path detection |
| `python-desktop-app/ocr/facade.py` | Enhanced diagnostics with system info, engine details, JSON export |
| `python-desktop-app/desktop_app.py` | Added send_diagnostics(), login error categorization, OCR diag on login |
| `python-desktop-app/desktop_app.spec` | Improved dependency detection |
| `ai-server/src/controllers/auth-controller.js` | Added /api/auth/diagnostics endpoint |
| `ai-server/src/index.js` | Registered diagnostics route |
| `ai-server/src/services/activity-service.js` | Improved AI matching prompts |

---

## Verification

After deploying the new build:

1. **Local Verification**:
   - Check TimeTracker logs for OCR DIAGNOSTICS REPORT
   - Verify engines show "READY"
   - Test OCR by taking a screenshot of text content
   - Verify `ocr_method` is "paddle" or "tesseract" (not "metadata")

2. **Remote Verification** (AI Server):
   - Search logs for `[DIAG:OCR]` entries from deployed machines
   - Verify all engines show `engine=true`
   - Check for any `Init Error` messages
   - Monitor login diagnostics for any failures
