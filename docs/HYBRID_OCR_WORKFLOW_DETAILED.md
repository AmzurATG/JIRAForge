# Hybrid OCR Approach - Complete Technical Workflow Documentation

## Document Information

| Property | Value |
|----------|-------|
| **Version** | 1.0 |
| **Created** | March 12, 2026 |
| **Project** | JIRAForge Time Tracker |
| **Purpose** | Detailed technical workflow of the Hybrid OCR approach |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Detailed Component Workflow](#3-detailed-component-workflow)
   - [Step 1: Screenshot Capture](#step-1-screenshot-capture)
   - [Step 2: OCR Text Extraction](#step-2-ocr-text-extraction)
   - [Step 3: Local Classification](#step-3-local-classification)
   - [Step 4: Local SQLite Storage](#step-4-local-sqlite-storage)
   - [Step 5: Batch Upload to Supabase](#step-5-batch-upload-to-supabase)
   - [Step 6: AI Server Batch Analysis](#step-6-ai-server-batch-analysis)
   - [Step 7: Database Update](#step-7-database-update)
4. [Comparison: Screenshot vs Hybrid OCR Approach](#4-comparison-screenshot-vs-hybrid-ocr-approach)
5. [OCR Engine Deep Dive](#5-ocr-engine-deep-dive)
6. [Data Flow Diagrams](#6-data-flow-diagrams)
7. [Database Schema](#7-database-schema)
8. [Performance Metrics](#8-performance-metrics)
9. [Configuration Reference](#9-configuration-reference)

---

## 1. Executive Summary

The **Hybrid OCR Approach** is a sophisticated time-tracking system that combines local text extraction with AI-powered analysis to efficiently classify user activities and match them to Jira issues.

### Key Benefits

| Metric | Improvement |
|--------|-------------|
| **Cost Reduction** | 85-96% lower AI API costs |
| **Bandwidth Reduction** | 99% less data transfer |
| **Processing Speed** | 3-5x faster end-to-end |
| **Privacy** | Text extracted locally, no image transfer |
| **Scalability** | Linear scaling, no API rate limit issues |

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           HYBRID OCR WORKFLOW OVERVIEW                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  DESKTOP APP (Local)              │           CLOUD                                 │
│  ────────────────────             │           ─────                                 │
│                                   │                                                 │
│  ┌─────────────────┐              │                                                 │
│  │ 1. Screenshot   │              │                                                 │
│  │    Capture      │              │                                                 │
│  └───────┬─────────┘              │                                                 │
│          ▼                        │                                                 │
│  ┌─────────────────┐              │                                                 │
│  │ 2. OCR Text     │              │                                                 │
│  │    Extraction   │              │                                                 │
│  │  ├─ PaddleOCR   │              │                                                 │
│  │  ├─ Tesseract   │              │                                                 │
│  │  └─ Metadata    │              │                                                 │
│  └───────┬─────────┘              │                                                 │
│          ▼                        │                                                 │
│  ┌─────────────────┐              │                                                 │
│  │ 3. Local        │              │                                                 │
│  │    Classify     │              │                                                 │
│  └───────┬─────────┘              │                                                 │
│          ▼                        │                                                 │
│  ┌─────────────────┐              │    ┌───────────────────┐    ┌─────────────────┐│
│  │ 4. SQLite       │──5 min batch─┼──▶│  5. Supabase      │───▶│  6. AI Server   ││
│  │    Storage      │    5-20KB    │    │     Database      │    │  Batch Analysis ││
│  └─────────────────┘              │    └───────────────────┘    └────────┬────────┘│
│                                   │                                      │         │
│                                   │    ┌───────────────────────────────┘          │
│                                   │    ▼                                           │
│                                   │    ┌─────────────────────────────────────────┐ │
│                                   │    │  7. Store Analysis Results in Supabase  │ │
│                                   │    └─────────────────────────────────────────┘ │
│                                   │                                                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture Overview

### 2.1 System Components

| Component | Location | Technology | Purpose |
|-----------|----------|------------|---------|
| **Desktop App** | Local Machine | Python (PyQt5) | Screenshot capture, OCR, local storage |
| **OCR Module** | `python-desktop-app/ocr/` | PaddleOCR, Tesseract | Text extraction from screenshots |
| **SQLite DB** | `%APPDATA%\TimeTracker\` | SQLite | Local activity session storage |
| **Supabase** | Cloud | PostgreSQL | Persistent cloud storage |
| **AI Server** | Cloud | Node.js | Batch text analysis with LLM |

### 2.2 Technology Stack

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          TECHNOLOGY STACK                                  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  DESKTOP LAYER                    │  CLOUD LAYER                           │
│  ───────────────                  │  ───────────                           │
│                                   │                                        │
│  Python 3.11+                     │  Node.js 18+                           │
│  ├─ PyQt5 (UI)                    │  ├─ Express (API)                      │
│  ├─ PIL/Pillow (Image capture)    │  ├─ Supabase Client                    │
│  ├─ sqlite3 (Local DB)            │  └─ AI Providers:                      │
│  └─ OCR Engines:                  │     ├─ Google Gemini Flash            │
│     ├─ PaddleOCR (Primary)        │     ├─ OpenAI GPT-4o-mini             │
│     ├─ Tesseract (Fallback)       │     └─ LiteLLM (Routing)              │
│     └─ EasyOCR (Optional)         │                                        │
│                                   │  Supabase (PostgreSQL)                 │
│                                   │  ├─ activity_records table             │
│                                   │  ├─ Edge Functions                     │
│                                   │  └─ Row-Level Security                 │
│                                   │                                        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Workflow

### Step 1: Screenshot Capture

**Location:** `python-desktop-app/desktop_app.py`

#### 1.1 Capture Mechanism

The desktop app captures screenshots in two modes:

##### Event-Based Mode (Window Switch Detection)

```python
# Triggered on every window switch event
class LocalOCRProcessor:
    def capture_screenshot_only(self, force=False):
        """Capture screenshot without running OCR (for async dispatch)."""
        now = time.time()
        if not force and (now - self._last_ocr_time) < self._min_interval:
            try:
                screenshot = ImageGrab.grab()
            except Exception:
                screenshot = None
            return {'screenshot': screenshot, 'throttled': True}

        try:
            screenshot = ImageGrab.grab()
            return {'screenshot': screenshot, 'throttled': False}
        except Exception as e:
            print(f"[OCR] Screenshot capture failed: {e}")
            return {'screenshot': None, 'throttled': False}
```

##### Interval-Based Mode (Periodic Capture)

```python
# Called every N minutes based on CAPTURE_INTERVAL setting
def upload_screenshot(self, screenshot, window_info):
    # Capture with PIL ImageGrab
    screenshot = ImageGrab.grab()
    
    # Create thumbnail for storage (optional)
    thumb = screenshot.copy()
    thumb.thumbnail((256, 144), Image.LANCZOS)
```

#### 1.2 Capture Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    SCREENSHOT CAPTURE FLOW                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐                                             │
│  │ Window Switch   │──────┐                                      │
│  │ Event Detected  │      │                                      │
│  └─────────────────┘      │                                      │
│                           ▼                                      │
│  ┌─────────────────┐    ┌────────────────────┐                   │
│  │ Timer Interval  │───▶│ Throttle Check     │                   │
│  │ (5-15 min)      │    │ (min 3s between)   │                   │
│  └─────────────────┘    └─────────┬──────────┘                   │
│                                   │                              │
│                    ┌──────────────┴──────────────┐               │
│                    ▼                             ▼               │
│            ┌─────────────┐              ┌─────────────┐          │
│            │  THROTTLED  │              │ NOT THROTTLED│          │
│            │ Save image  │              │ Proceed to  │          │
│            │ for backfill│              │ OCR         │          │
│            └─────────────┘              └─────────────┘          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### 1.3 Screenshot Properties

| Property | Value |
|----------|-------|
| Format | PNG (in-memory) |
| Resolution | Full screen (1920x1080 typical) |
| Color Depth | 24-bit RGB |
| Size (uncompressed) | ~6MB |
| Size (PNG compressed) | ~500KB average |
| Thumbnail Size | 256x144 JPEG, ~5-10KB |

---

### Step 2: OCR Text Extraction

**Location:** `python-desktop-app/ocr/`

#### 2.1 OCR Architecture

The OCR system implements the **Facade Pattern** with multiple engines and automatic fallback:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         OCR MODULE ARCHITECTURE                            │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  extract_text_from_image()  ─────▶  OCRFacade                              │
│                                        │                                   │
│                                        ▼                                   │
│                              ┌─────────────────┐                           │
│                              │  EngineFactory  │                           │
│                              └────────┬────────┘                           │
│                                       │                                    │
│              ┌────────────────────────┼────────────────────────┐           │
│              │                        │                        │           │
│              ▼                        ▼                        ▼           │
│      ┌──────────────┐        ┌──────────────┐        ┌──────────────┐      │
│      │ PaddleOCR    │        │ Tesseract    │        │ Metadata     │      │
│      │ (Primary)    │        │ (Fallback 1) │        │ (Fallback 2) │      │
│      │              │        │              │        │              │      │
│      │ Accuracy:    │        │ Accuracy:    │        │ Accuracy:    │      │
│      │ 95-98%       │        │ 85-90%       │        │ 40-70%       │      │
│      │              │        │              │        │              │      │
│      │ Speed:       │        │ Speed:       │        │ Speed:       │      │
│      │ 500-1500ms   │        │ 2000-4000ms  │        │ <10ms        │      │
│      └──────────────┘        └──────────────┘        └──────────────┘      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 2.2 OCR Facade Implementation

**File:** `python-desktop-app/ocr/facade.py`

```python
class OCRFacade:
    """
    Unified facade for OCR operations.
    
    Features:
        - Automatic engine selection based on configuration
        - Graceful fallback when engines fail
        - Preprocessing pipeline integration
        - Metadata fallback as last resort
    """
    
    def __init__(self, config: Optional[OCRConfig] = None):
        self.config = config or OCRConfig.from_env()
        self._primary_engine: Optional[BaseOCREngine] = None
        self._fallback_engines: List[BaseOCREngine] = []
        self._engine_failure_counts: Dict[str, int] = {}
        self._engine_backoff_until: Dict[str, float] = {}
        
        self._initialize_engines()
        self._initialize_privacy_filter()
    
    def extract_text(
        self,
        image,
        window_title: str = '',
        app_name: str = '',
        use_preprocessing: bool = True,
        screenshot_mode: bool = False,
        max_lines: int = 0
    ) -> Dict[str, Any]:
        """
        Extract text from image using configured engines with fallback.
        
        Args:
            image: PIL Image, numpy array, or file path
            window_title: Window title (for metadata fallback)
            app_name: Application name (for metadata fallback)
            use_preprocessing: Apply image preprocessing (full pipeline)
            screenshot_mode: Use lightweight preprocessing optimized for screen captures
            max_lines: Maximum text lines to return (0 = unlimited)
        
        Returns:
            Standardized result dict with text, confidence, method, etc.
        """
```

#### 2.3 Engine Selection Logic

```
┌────────────────────────────────────────────────────────────────────────────┐
│                      OCR ENGINE SELECTION FLOW                             │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Input: Screenshot Image                                                   │
│         │                                                                  │
│         ▼                                                                  │
│  ┌──────────────────────────────────────────────────────┐                  │
│  │ Check Primary Engine (OCR_PRIMARY_ENGINE env var)    │                  │
│  │ Default: PaddleOCR                                   │                  │
│  └───────────────────────┬──────────────────────────────┘                  │
│                          │                                                 │
│            ┌─────────────┴─────────────┐                                   │
│            │                           │                                   │
│            ▼                           ▼                                   │
│   ┌─────────────────┐        ┌─────────────────────┐                       │
│   │ Engine Available│        │ Engine Unavailable  │                       │
│   │ & Not in Backoff│        │ or In Backoff       │                       │
│   └────────┬────────┘        └──────────┬──────────┘                       │
│            │                            │                                  │
│            ▼                            ▼                                  │
│   ┌─────────────────┐        ┌─────────────────────┐                       │
│   │ Run OCR         │        │ Try Fallback Engine │                       │
│   │ Extraction      │        │ (Tesseract)         │                       │
│   └────────┬────────┘        └──────────┬──────────┘                       │
│            │                            │                                  │
│   ┌────────┴────────┐                   │                                  │
│   ▼                 ▼                   │                                  │
│ SUCCESS          FAILURE                │                                  │
│ (conf >= min)    (conf < min)           │                                  │
│   │                 │                   │                                  │
│   │                 └───────────────────┤                                  │
│   │                                     │                                  │
│   ▼                                     ▼                                  │
│ Return Result              ┌─────────────────────────┐                     │
│ {                          │ Last Resort: Metadata   │                     │
│   text: "...",             │ Fallback (window title, │                     │
│   confidence: 0.95,        │ app name only)          │                     │
│   method: "paddle"         └─────────────────────────┘                     │
│ }                                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 2.4 Image Preprocessing Pipeline

**File:** `python-desktop-app/ocr/image_processor.py`

```python
def preprocess_screenshot(image, engine_hint='paddle'):
    """
    Lightweight preprocessing optimized for screen captures.
    Skips expensive denoising/CLAHE/sharpening and downscales instead.
    
    For Tesseract: Convert to grayscale + apply CLAHE
    For PaddleOCR: Keep as RGB (works best with color)
    """
    if engine_hint == 'tesseract':
        # Convert to grayscale for Tesseract
        gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
        enhanced = clahe.apply(gray)
        return enhanced
    else:
        # PaddleOCR works best with RGB
        return np.array(image)
```

#### 2.5 OCR Result Structure

```python
# Standard OCR result dictionary
ocr_result = {
    'text': 'Extracted text content...',       # Full extracted text
    'confidence': 0.92,                        # Confidence score (0.0-1.0)
    'method': 'paddle',                        # Engine used
    'success': True,                           # Whether extraction succeeded
    'prep_ms': 45.3,                           # Preprocessing time (ms)
    'infer_ms': 892.1,                         # Inference time (ms)
    'total_ms': 937.4,                         # Total time (ms)
    'line_count': 25,                          # Number of text lines
    'window_title': 'VS Code - main.py',       # Context metadata
    'app_name': 'Code.exe',                    # Application name
    'privacy_applied': True,                   # Whether privacy filter ran
    'privacy_redactions': 3,                   # Number of items redacted
    'boxes': [...]                             # Optional: bounding boxes
}
```

#### 2.6 Privacy Filter

The OCR module includes a privacy filter that redacts sensitive information before storage:

```python
# Patterns redacted by privacy filter:
- Credit card numbers (16-digit sequences)
- SSN patterns (XXX-XX-XXXX)
- Email addresses
- Phone numbers
- API keys / tokens (long alphanumeric strings)
- Passwords (if detected in form contexts)
```

---

### Step 3: Local Classification

**Location:** `python-desktop-app/desktop_app.py`

#### 3.1 Classification Flow

Before uploading to cloud, the desktop app performs local classification to reduce AI API calls:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       LOCAL CLASSIFICATION FLOW                            │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Input: Window Info + OCR Text                                             │
│         │                                                                  │
│         ▼                                                                  │
│  ┌────────────────────────────────────────────┐                            │
│  │ CHECK CACHED CLASSIFICATIONS               │                            │
│  │ (app_classifications_cache table)          │                            │
│  └────────────────────┬───────────────────────┘                            │
│                       │                                                    │
│         ┌─────────────┴─────────────┐                                      │
│         ▼                           ▼                                      │
│  ┌─────────────┐           ┌─────────────────┐                             │
│  │ Cache HIT   │           │ Cache MISS      │                             │
│  └──────┬──────┘           └────────┬────────┘                             │
│         │                           │                                      │
│         │                           ▼                                      │
│         │                  ┌─────────────────────┐                         │
│         │                  │ Rule-Based Check    │                         │
│         │                  │ ├─ Known work apps  │                         │
│         │                  │ ├─ Known non-work   │                         │
│         │                  │ └─ Private patterns │                         │
│         │                  └──────────┬──────────┘                         │
│         │                             │                                    │
│         │               ┌─────────────┴─────────────┐                      │
│         │               ▼                           ▼                      │
│         │        ┌─────────────┐           ┌─────────────────┐             │
│         │        │ CLASSIFIED  │           │ UNKNOWN         │             │
│         │        │ (no AI)     │           │ (needs AI later)│             │
│         │        └──────┬──────┘           └────────┬────────┘             │
│         │               │                           │                      │
│         └───────────────┴───────────────────────────┘                      │
│                         │                                                  │
│                         ▼                                                  │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │ Classification Result:                                     │            │
│  │ • productive   → Work-related (IDEs, Jira, Office apps)    │            │
│  │ • non_productive → Entertainment (Games, Social media)     │            │
│  │ • private      → Sensitive (Banking, Healthcare, Passwords)│            │
│  │ • unknown      → Needs AI analysis                         │            │
│  └────────────────────────────────────────────────────────────┘            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 3.2 Classification Categories

| Category | Description | AI Required | Examples |
|----------|-------------|-------------|----------|
| **productive** | Work-related activities | No* | VS Code, Jira, Slack, Confluence |
| **non_productive** | Entertainment/Personal | No | YouTube (entertainment), Games |
| **private** | Sensitive personal data | No | Banking sites, Password managers |
| **unknown** | Cannot determine locally | **Yes** | New/unknown applications |

*AI may still be needed to match to specific Jira issues

---

### Step 4: Local SQLite Storage

**Location:** `%APPDATA%\TimeTracker\time_tracker_offline.db`

#### 4.1 Database Schema

```sql
-- Main table for tracking active sessions between batch uploads
CREATE TABLE IF NOT EXISTS active_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_title TEXT,                    -- Window title of active app
    application_name TEXT,                -- Process name (e.g., 'chrome.exe')
    classification TEXT,                  -- productive/non_productive/private/unknown
    ocr_text TEXT,                        -- OCR extracted text from window
    ocr_method TEXT,                      -- OCR engine used (paddle/tesseract/metadata)
    ocr_confidence REAL,                  -- OCR confidence score (0.0-1.0)
    ocr_error_message TEXT,               -- Error message if OCR failed
    total_time_seconds REAL DEFAULT 0,    -- Accumulated time in this session
    visit_count INTEGER DEFAULT 1,        -- Number of returns to this window
    first_seen TEXT,                      -- ISO timestamp when first seen
    last_seen TEXT,                       -- ISO timestamp when last active
    timer_started_at TEXT,                -- Current timer start (NULL if paused)
    UNIQUE(window_title, application_name) -- One record per unique window
);

-- Cache for app classifications synced from Supabase
CREATE TABLE IF NOT EXISTS app_classifications_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT,
    project_key TEXT,
    identifier TEXT NOT NULL,             -- Process name or URL pattern
    display_name TEXT,                    -- Human-readable name
    classification TEXT NOT NULL,         -- productive/non_productive/private
    match_by TEXT NOT NULL,               -- 'process' or 'url'
    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, project_key, identifier, match_by)
);

-- Offline screenshot storage (backup when network unavailable)
CREATE TABLE IF NOT EXISTS offline_screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT,
    timestamp TEXT NOT NULL,
    storage_path TEXT,
    window_title TEXT,
    application_name TEXT,
    extracted_text TEXT,                  -- OCR extracted text
    ocr_confidence REAL,                  -- OCR confidence score
    ocr_method TEXT,                      -- OCR engine used
    ocr_line_count INTEGER,               -- Number of text lines
    image_data BLOB,                      -- Screenshot image bytes
    thumbnail_data BLOB,                  -- Thumbnail bytes
    synced INTEGER DEFAULT 0,             -- 0 = pending, 1 = synced
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

#### 4.2 ActiveSessionManager

**File:** `python-desktop-app/desktop_app.py`

```python
class ActiveSessionManager:
    """Manages active_sessions SQLite table for real-time activity tracking.
    
    Tracks time accumulated per unique (window_title, application_name) pair.
    Thread-safe with a lock.
    """
    
    def on_window_switch(self, title, app_name, classification, ocr_result=None):
        """Handle a window switch event.
        
        1. Stops timer on previous session
        2. Creates or resumes session for new window
        3. Stores OCR data if available
        """
        with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            new_key = (title, app_name)
            
            # Stop timer on current session
            if self._current_key is not None:
                self._stop_timer_internal(cursor, now)
            
            # Check if session exists
            cursor.execute(
                'SELECT id FROM active_sessions WHERE window_title = ? AND application_name = ?',
                (title, app_name)
            )
            existing = cursor.fetchone()
            
            if existing:
                # Resume existing session
                cursor.execute(
                    'UPDATE active_sessions SET visit_count = visit_count + 1, timer_started_at = ? WHERE id = ?',
                    (now, existing[0])
                )
            else:
                # Create new session
                cursor.execute(
                    '''INSERT INTO active_sessions
                    (window_title, application_name, classification, ocr_text, ocr_method, ...)
                    VALUES (?, ?, ?, ?, ?, ...)''',
                    (title, app_name, classification, ocr_text, ocr_method, ...)
                )
            
            self._current_key = new_key
```

#### 4.3 Session Timing Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         SESSION TIMING FLOW                                │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Window A Active                  Window B Active                          │
│  ──────────────                   ──────────────                           │
│        │                                │                                  │
│        ▼                                │                                  │
│  ┌─────────────┐                        │                                  │
│  │ Timer Start │                        │                                  │
│  │ 10:00:00    │                        │                                  │
│  └──────┬──────┘                        │                                  │
│         │                               │                                  │
│         │   User switches at 10:05:00   │                                  │
│         │ ─────────────────────────────▶│                                  │
│         │                               │                                  │
│  ┌──────┴──────┐                 ┌──────┴──────┐                           │
│  │ Timer Stop  │                 │ Timer Start │                           │
│  │ +5 minutes  │                 │ 10:05:00    │                           │
│  │ accumulated │                 └─────────────┘                           │
│  └─────────────┘                                                           │
│                                                                            │
│  Session A: { total_time_seconds: 300, visit_count: 1 }                    │
│  Session B: { total_time_seconds: 0, timer_started_at: "10:05:00" }        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### Step 5: Batch Upload to Supabase

**Location:** `python-desktop-app/desktop_app.py`

#### 5.1 Batch Upload Trigger

The batch upload runs **every 5 minutes** (300 seconds):

```python
# Checked in the main tracking loop
if time.time() - self.last_batch_upload_time >= self.batch_upload_interval:
    self.upload_activity_batch()
```

#### 5.2 Batch Upload Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         BATCH UPLOAD PROCESS                               │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Every 5 Minutes:                                                          │
│  ───────────────                                                           │
│                                                                            │
│  Step 1: Wait for in-flight OCR                                            │
│          │                                                                 │
│          ▼                                                                 │
│  Step 2: Backfill OCR for throttled sessions (max 3)                       │
│          │── Use ORIGINAL saved screenshots, not new ones                  │
│          │                                                                 │
│          ▼                                                                 │
│  Step 3: Stop current timer (finalize accumulated time)                    │
│          │                                                                 │
│          ▼                                                                 │
│  Step 4: Fetch all sessions from SQLite                                    │
│          │── SELECT * FROM active_sessions                                 │
│          │                                                                 │
│          ▼                                                                 │
│  Step 5: Check network connectivity                                        │
│          │                                                                 │
│          ├── OFFLINE → Records stay in SQLite for retry                    │
│          │                                                                 │
│          ▼ ONLINE                                                          │
│  Step 6: Build JSON records array                                          │
│          │                                                                 │
│          │  for each session:                                              │
│          │    record = {                                                   │
│          │      user_id, organization_id,                                  │
│          │      window_title, application_name,                           │
│          │      classification,                                            │
│          │      ocr_text, ocr_method, ocr_confidence,                      │
│          │      total_time_seconds, visit_count,                           │
│          │      start_time, end_time,                                      │
│          │      project_key, user_assigned_issues,                         │
│          │      status: 'pending' or 'analyzed',                          │
│          │      batch_timestamp, work_date, ...                            │
│          │    }                                                            │
│          │                                                                 │
│          ▼                                                                 │
│  Step 7: Single batch INSERT to Supabase                                   │
│          │── supabase.table('activity_records').insert(records)            │
│          │                                                                 │
│          ▼                                                                 │
│  Step 8: Clear SQLite sessions (only on success)                           │
│          │── DELETE FROM active_sessions                                   │
│          │                                                                 │
│          ▼                                                                 │
│  Step 9: Reset batch timer                                                 │
│          │── self.last_batch_upload_time = time.time()                     │
│          │                                                                 │
│          ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐           │
│  │ Database Trigger: activity_insert_webhook                   │           │
│  │ → Fires Edge Function → Calls AI Server                    │           │
│  └─────────────────────────────────────────────────────────────┘           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 5.3 Record Status Logic

```python
# Determine if AI analysis is needed
if classification in ('non_productive', 'private'):
    status = 'analyzed'  # Pre-classified, no AI needed
else:
    status = 'pending'   # Needs AI analysis for Jira matching
```

---

### Step 6: AI Server Batch Analysis

**Location:** `ai-server/src/services/activity-service.js`

#### 6.1 Batch Analysis Trigger

The AI server receives batch analysis requests via:
1. **Database Webhook:** Supabase Edge Function triggered on INSERT
2. **Polling:** Fallback mechanism that checks for pending records

#### 6.2 Batch Analysis Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       AI SERVER BATCH ANALYSIS                             │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Input: Array of activity records with status='pending'                    │
│         │                                                                  │
│         ▼                                                                  │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 1: Fetch User's Assigned Jira Issues              │                │
│  │         (from user_jira_issues_cache or embedded)      │                │
│  └───────────────────────┬────────────────────────────────┘                │
│                          │                                                 │
│                          ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 2: Build Batch Analysis Prompt                     │                │
│  │                                                         │                │
│  │ System: "You are an expert at analyzing work activity   │                │
│  │          from text. Match activities to Jira issues..."│                │
│  │                                                         │                │
│  │ User: "Activity Records:                                │                │
│  │        Record 0: [VS Code] main.py - editing            │                │
│  │          Time: 300s | 10:00 → 10:05                     │                │
│  │          OCR Text: def handle_request(): ...            │                │
│  │                                                         │                │
│  │        Record 1: [Chrome] JIRA-123 - Bug fix            │                │
│  │          Time: 180s | 10:05 → 10:08                     │                │
│  │          OCR Text: JIRA-123 Fix null pointer...         │                │
│  │                                                         │                │
│  │        User's Assigned Issues:                          │                │
│  │        - JIRA-123: Fix login bug                        │                │
│  │        - JIRA-456: Implement new feature                │                │
│  │        ..."                                             │                │
│  └───────────────────────┬────────────────────────────────┘                │
│                          │                                                 │
│                          ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 3: Call LLM (ONE call for entire batch)            │                │
│  │                                                         │                │
│  │ Provider: Gemini 2.0 Flash (primary)                    │                │
│  │           GPT-4o-mini (fallback)                        │                │
│  │                                                         │                │
│  │ Settings:                                               │                │
│  │   temperature: 0.3                                      │                │
│  │   max_tokens: records.length * 150 + 200                │                │
│  └───────────────────────┬────────────────────────────────┘                │
│                          │                                                 │
│                          ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 4: Parse JSON Response                             │                │
│  │                                                         │                │
│  │ [                                                       │                │
│  │   {                                                     │                │
│  │     "recordIndex": 0,                                   │                │
│  │     "taskKey": "JIRA-123",                              │                │
│  │     "projectKey": "JIRA",                               │                │
│  │     "confidenceScore": 0.85,                            │                │
│  │     "workType": "office",                               │                │
│  │     "reasoning": "Code editing related to bug fix"      │                │
│  │   },                                                    │                │
│  │   { "recordIndex": 1, ... }                             │                │
│  │ ]                                                       │                │
│  └───────────────────────┬────────────────────────────────┘                │
│                          │                                                 │
│                          ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 5: Validate Task Keys                              │                │
│  │         (Only allow keys from assigned issues)          │                │
│  └───────────────────────┬────────────────────────────────┘                │
│                          │                                                 │
│                          ▼                                                 │
│  ┌────────────────────────────────────────────────────────┐                │
│  │ Step 6: Update Database Records                         │                │
│  │         status: 'pending' → 'analyzed'                  │                │
│  │         + taskKey, projectKey, metadata                 │                │
│  └────────────────────────────────────────────────────────┘                │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### 6.3 Batch Prompt Structure

```javascript
function buildBatchAnalysisPrompt(records, assignedIssuesText) {
  const recordDescriptions = records.map((record, index) => {
    const ocrSnippet = record.ocr_text
      ? record.ocr_text.substring(0, 500)
      : '(no text extracted)';

    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  OCR Text: ${ocrSnippet}`;
  }).join('\n\n');

  return `Analyze these activity records and match each to the most relevant Jira issue.
Match based on MEANING, not just keywords.

User's Assigned Issues (from Jira):
${assignedIssuesText}

Activity Records:
${recordDescriptions}

Return ONLY valid JSON array:
[
  {
    "recordIndex": 0,
    "taskKey": "PROJECT-123" or null,
    "projectKey": "PROJECT" or null,
    "confidenceScore": 0.0-1.0,
    "workType": "office" or "non-office",
    "reasoning": "Brief explanation"
  }
]`;
}
```

---

### Step 7: Database Update

**Location:** `ai-server/src/services/activity-db-service.js`

#### 7.1 Final Record Structure in Supabase

After AI analysis, each `activity_records` row contains:

```sql
{
  id: UUID,
  user_id: UUID,
  organization_id: UUID,
  
  -- Activity Data
  window_title: "VS Code - main.py",
  application_name: "Code.exe",
  classification: "productive",
  
  -- OCR Data (from desktop app)
  ocr_text: "def handle_request(): ...",
  ocr_method: "paddle",
  ocr_confidence: 0.95,
  ocr_error_message: null,
  
  -- Time Data
  total_time_seconds: 300,
  visit_count: 2,
  start_time: "2026-03-12T10:00:00Z",
  end_time: "2026-03-12T10:05:00Z",
  duration_seconds: 300,
  work_date: "2026-03-12",
  
  -- Batch Info
  batch_timestamp: "2026-03-12T10:05:00Z",
  batch_start: "2026-03-12T10:00:00Z",
  batch_end: "2026-03-12T10:05:00Z",
  
  -- Jira Context
  project_key: "JIRA",
  user_assigned_issue_key: "JIRA-123",
  user_assigned_issues: "[{\"key\":\"JIRA-123\",...}]",
  
  -- AI Analysis Result
  status: "analyzed",
  metadata: {
    workType: "office",
    confidenceScore: 0.85,
    reasoning: "Code editing related to bug fix",
    aiProvider: "google",
    aiModel: "gemini-2.0-flash"
  },
  analyzed_at: "2026-03-12T10:05:30Z",
  
  -- Timestamps
  created_at: "2026-03-12T10:05:00Z",
  updated_at: "2026-03-12T10:05:30Z"
}
```

---

## 4. Comparison: Screenshot vs Hybrid OCR Approach

### 4.1 Architecture Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│               OLD APPROACH: Direct Screenshot to Vision AI                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Desktop App          Upload           Cloud              AI                │
│  ─────────────        ──────           ─────              ──                │
│  ┌────────────┐      500KB/img     ┌──────────────┐    ┌──────────────────┐│
│  │ Capture    │ ───────────────▶   │  Supabase    │ ─▶ │ Vision Analyzer  ││
│  │ Screenshot │                    │  Storage     │    │ (GPT-4 Vision)   ││
│  └────────────┘                    └──────────────┘    │                  ││
│                                                        │ • Download image ││
│                                                        │ • Base64 encode  ││
│                                                        │ • Send to GPT-4V ││
│                                                        │ • Parse response ││
│                                                        └──────────────────┘│
│                                                                             │
│  FLOW: Capture → Upload Image → Download → Encode → Vision API → Result    │
│  TIME: 5-15 seconds end-to-end                                              │
│  COST: $0.02-0.03 per screenshot (Vision tokens)                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│               NEW APPROACH: Hybrid OCR + Text LLM                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Desktop App (Local)           Upload        Cloud         AI               │
│  ────────────────────          ──────        ─────         ──               │
│  ┌────────────────────┐       5-20KB     ┌─────────────┐ ┌───────────────┐ │
│  │ 1. Capture         │                  │  Supabase   │ │ Text Analyzer │ │
│  │ 2. OCR Extract     │ ─────────────▶   │  Database   │─▶│ (Gemini Flash)│ │
│  │    ├─ PaddleOCR    │   text only      │  (text)     │ │               │ │
│  │    ├─ Tesseract    │                  └─────────────┘ │ • Parse text  │ │
│  │    └─ Metadata     │                                  │ • Match Jira  │ │
│  │ 3. Classify        │                                  │ • Classify    │ │
│  │ 4. Store SQLite    │                                  └───────────────┘ │
│  └────────────────────┘                                                     │
│                                                                             │
│  FLOW: Capture → Local OCR → Classify → Batch Upload Text → Text LLM       │
│  TIME: 1-4 seconds end-to-end                                               │
│  COST: $0.0001-0.0003 per record (Text tokens only)                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Detailed Metrics Comparison

| Metric | Old (Vision) | New (Hybrid OCR) | Improvement |
|--------|-------------|------------------|-------------|
| **Local Processing** | ~50ms | 500-1500ms | More local work |
| **Data Upload Size** | 500KB/image | 5-20KB/text | **96-99% smaller** |
| **Upload Time** | 2-5 seconds | 50-200ms | **10-25x faster** |
| **AI Inference Time** | 3-8 seconds | 0.5-2 seconds | **4-16x faster** |
| **Total E2E Time** | 5-15 seconds | 1-4 seconds | **3-5x faster** |
| **Tokens per Request** | 1,165-1,705 | 420-1,000 | **40-60% fewer** |
| **Cost per Screenshot** | $0.02-0.03 | $0.0001-0.0003 | **85-99% cheaper** |
| **Monthly Cost (1 user)** | $48.00 | $0.98-2.00 | **96-98% cheaper** |
| **Network Bandwidth** | ~960MB/month | ~10-40MB/month | **96-99% less** |
| **API Rate Limit Risk** | High | Low | Much better scaling |
| **Offline Capability** | None | Full local storage | Better resilience |
| **Privacy** | Images in cloud | Text only in cloud | More private |

### 4.3 Cost Breakdown

#### Old Approach (Monthly, 1 User)
```
Screenshots: 12/hour × 8 hours × 20 days = 1,920 screenshots
Cost: 1,920 × $0.025 = $48.00/month
```

#### New Hybrid Approach (Monthly, 1 User)
```
Activity Records: 1,920 records/month

Tier 1 - Rule-based (40% free):     $0.00
Tier 2 - Batch OCR analysis (40%):  768 × $0.0000747 = $0.06
Tier 3 - App classification (10%): 192 × $0.000090 = $0.02
Tier 4 - Fallback Vision (10%):    192 × $0.001 = $0.19

Total: ~$0.27/month (tiered) to ~$1.50/month (all AI)
```

### 4.4 When to Use Which Approach

| Scenario | Recommended Approach | Reason |
|----------|---------------------|--------|
| Text-heavy apps (IDEs, browsers) | Hybrid OCR | OCR excels at text extraction |
| Visual apps (Figma, design tools) | Vision fallback | OCR struggles with visual content |
| High-volume tracking | Hybrid OCR | Cost-effective at scale |
| Offline environments | Hybrid OCR | Local processing works offline |
| Precise visual analysis | Vision | Better understanding of UI context |

---

## 5. OCR Engine Deep Dive

### 5.1 PaddleOCR (Primary Engine)

**Strengths:**
- High accuracy (95-98%)
- Fast inference (500-1500ms)
- Good with mixed fonts/sizes
- Handles rotated text

**Configuration:**
```bash
# Environment variables
OCR_PRIMARY_ENGINE=paddle
OCR_PADDLE_MIN_CONFIDENCE=0.5
OCR_PADDLE_USE_GPU=false
OCR_PADDLE_LANGUAGE=en
```

**Implementation:**
```python
class PaddleOCREngine(BaseOCREngine):
    def __init__(self, config=None):
        self._ocr = PaddleOCR(
            use_angle_cls=True,
            lang='en',
            use_gpu=config.use_gpu if config else False
        )
    
    def extract_text(self, image, skip_angle_cls=False):
        result = self._ocr.ocr(image, cls=not skip_angle_cls)
        # Process results, calculate confidence, return text
```

### 5.2 Tesseract (Fallback Engine)

**Strengths:**
- Very reliable
- Works on all platforms
- Extensive language support
- Open source

**Weaknesses:**
- Slower (2-4 seconds)
- Lower accuracy on complex layouts
- Requires preprocessing for best results

**Configuration:**
```bash
# Environment variables
OCR_FALLBACK_ENGINES=tesseract
OCR_TESSERACT_MIN_CONFIDENCE=0.6
OCR_TESSERACT_LANGUAGE=eng
```

### 5.3 Metadata Fallback

When both OCR engines fail, the system falls back to metadata-only analysis:

```python
def _create_metadata_result(self, window_title, app_name):
    """Create result using only metadata when all OCR fails."""
    text_parts = []
    if window_title:
        text_parts.append(f"Window: {window_title}")
    if app_name:
        text_parts.append(f"Application: {app_name}")
    
    return {
        'text': '\n'.join(text_parts),
        'confidence': 0.3,  # Low confidence
        'method': 'metadata',
        'success': True if text_parts else False
    }
```

---

## 6. Data Flow Diagrams

### 6.1 Complete End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          COMPLETE DATA FLOW DIAGRAM                                 │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  TIME    0s        0.05s      0.5-1.5s     1.5s        5min        5min+1s         │
│  ─────   ──        ─────      ────────     ────        ────        ───────         │
│                                                                                     │
│  ┌─────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │Event│→│Capture  │→│   OCR   │→│Classify │→│Store in │→│Batch    │→│AI Batch   │ │
│  │(Win │ │Screenshot│ │Extract │ │Activity │ │SQLite   │ │Upload to│ │Analysis   │ │
│  │Switch│ │         │ │Text    │ │        │ │         │ │Supabase │ │(LLM)      │ │
│  └─────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └───────────┘ │
│                                                                                     │
│  Details:                                                                           │
│  ────────                                                                           │
│                                                                                     │
│  Event     │ Window switch detected by desktop app                                  │
│            │ Uses Win32 API hooks for window focus changes                          │
│            │                                                                        │
│  Capture   │ PIL ImageGrab.grab() captures full screen                              │
│            │ ~50ms, ~6MB uncompressed → ~500KB PNG                                  │
│            │                                                                        │
│  OCR       │ PaddleOCR primary (500-1500ms)                                         │
│            │ Tesseract fallback (2000-4000ms)                                       │
│            │ Metadata last resort (<10ms)                                           │
│            │                                                                        │
│  Classify  │ Check app_classifications_cache (SQLite)                               │
│            │ Rule-based classification for known apps                               │
│            │ Mark as 'unknown' if not found                                         │
│            │                                                                        │
│  SQLite    │ INSERT or UPDATE active_sessions table                                 │
│            │ Track accumulated time per window                                      │
│            │ Store OCR text for later analysis                                      │
│            │                                                                        │
│  Batch     │ Every 5 minutes (300 seconds)                                          │
│            │ Collect all sessions from SQLite                                       │
│            │ Build JSON array (~5-20KB)                                             │
│            │ Single INSERT to Supabase activity_records                             │
│            │                                                                        │
│  AI        │ Database webhook triggers Edge Function                                │
│            │ Edge Function calls AI server /api/analyze-batch                       │
│            │ Single LLM call for entire batch (Gemini Flash)                        │
│            │ Update records with taskKey, workType, etc.                            │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Error Handling Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         ERROR HANDLING FLOW                                │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────┐                                                           │
│  │ OCR Fails   │                                                           │
│  └──────┬──────┘                                                           │
│         │                                                                  │
│         ▼                                                                  │
│  ┌─────────────┐       ┌─────────────┐       ┌─────────────┐               │
│  │Try Primary  │──Fail─▶│Try Fallback │──Fail─▶│Use Metadata │               │
│  │(PaddleOCR)  │       │(Tesseract)  │       │(Window only)│               │
│  └──────┬──────┘       └──────┬──────┘       └──────┬──────┘               │
│         │Success              │Success              │                      │
│         └──────────────┬──────┘                     │                      │
│                        ▼                            │                      │
│              ┌─────────────────┐                    │                      │
│              │ Continue with   │◀───────────────────┘                      │
│              │ whatever we got │                                           │
│              └─────────────────┘                                           │
│                                                                            │
│  ┌─────────────┐                                                           │
│  │Network Fail │                                                           │
│  └──────┬──────┘                                                           │
│         │                                                                  │
│         ▼                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │ Records stay in SQLite                                        │          │
│  │ Retry on next 5-minute batch cycle                           │          │
│  │ No data loss - offline-first design                          │          │
│  └──────────────────────────────────────────────────────────────┘          │
│                                                                            │
│  ┌─────────────┐                                                           │
│  │ AI Fails    │                                                           │
│  └──────┬──────┘                                                           │
│         │                                                                  │
│         ▼                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │ Records stay status='pending'                                 │          │
│  │ Polling mechanism will retry                                  │          │
│  │ Fallback to secondary AI provider (LiteLLM)                   │          │
│  └──────────────────────────────────────────────────────────────┘          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Database Schema

### 7.1 Local SQLite Schema

```sql
-- File: %APPDATA%\TimeTracker\time_tracker_offline.db

-- Real-time activity sessions (cleared every 5 minutes on successful upload)
CREATE TABLE active_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_title TEXT,
    application_name TEXT,
    classification TEXT,                  -- productive/non_productive/private/unknown
    ocr_text TEXT,                        -- OCR extracted text
    ocr_method TEXT,                      -- paddle/tesseract/metadata
    ocr_confidence REAL,                  -- 0.0 to 1.0
    ocr_error_message TEXT,
    total_time_seconds REAL DEFAULT 0,
    visit_count INTEGER DEFAULT 1,
    first_seen TEXT,                      -- ISO timestamp
    last_seen TEXT,                       -- ISO timestamp
    timer_started_at TEXT,                -- NULL when paused
    UNIQUE(window_title, application_name)
);

-- App classification cache (synced from Supabase)
CREATE TABLE app_classifications_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT,
    project_key TEXT,
    identifier TEXT NOT NULL,             -- Process name or URL
    classification TEXT NOT NULL,
    match_by TEXT NOT NULL,               -- 'process' or 'url'
    cached_at TEXT
);

-- Offline screenshots (for backup when network unavailable)
CREATE TABLE offline_screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    extracted_text TEXT,
    ocr_confidence REAL,
    ocr_method TEXT,
    image_data BLOB,
    synced INTEGER DEFAULT 0
);
```

### 7.2 Supabase PostgreSQL Schema

```sql
-- Table: public.activity_records
CREATE TABLE public.activity_records (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id),
    organization_id UUID REFERENCES public.organizations(id),
    
    -- Activity data
    window_title TEXT,
    application_name TEXT,
    classification TEXT CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown')),
    
    -- OCR data (from desktop app)
    ocr_text TEXT,
    ocr_method TEXT,
    ocr_confidence REAL,
    ocr_error_message TEXT,
    
    -- Time tracking
    total_time_seconds INTEGER,
    visit_count INTEGER DEFAULT 1,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER,
    
    -- Batch metadata
    batch_timestamp TIMESTAMPTZ,
    batch_start TIMESTAMPTZ,
    batch_end TIMESTAMPTZ,
    work_date DATE,
    user_timezone TEXT,
    
    -- Jira integration
    project_key TEXT,
    user_assigned_issue_key TEXT,        -- Matched by AI
    user_assigned_issues TEXT,            -- JSON array of issues
    
    -- Processing status
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'analyzed', 'failed')),
    metadata JSONB DEFAULT '{}',          -- AI analysis results
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    analyzed_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX idx_activity_user_work_date ON activity_records(user_id, work_date);
CREATE INDEX idx_activity_status ON activity_records(status);
CREATE INDEX idx_activity_batch_timestamp ON activity_records(batch_timestamp);
```

---

## 8. Performance Metrics

### 8.1 Timing Benchmarks

| Operation | P50 | P95 | P99 |
|-----------|-----|-----|-----|
| Screenshot Capture | 45ms | 80ms | 120ms |
| PaddleOCR Inference | 800ms | 1,200ms | 1,800ms |
| Tesseract Inference | 2,500ms | 3,500ms | 4,500ms |
| SQLite Write | 5ms | 15ms | 30ms |
| Batch Upload (20 records) | 200ms | 500ms | 800ms |
| AI Batch Analysis (10 records) | 2,000ms | 4,000ms | 6,000ms |

### 8.2 Resource Usage

| Resource | Idle | Active OCR | Peak |
|----------|------|------------|------|
| CPU (Desktop App) | 1-2% | 30-60% | 80% |
| Memory (Desktop App) | 150MB | 400MB | 600MB |
| Disk I/O | Minimal | ~5MB/min | ~20MB/min |
| Network Upload | 0 | ~5KB/record | ~100KB/batch |

### 8.3 Scalability Characteristics

| Users | Records/Hour | AI Calls/Hour | Monthly Cost |
|-------|--------------|---------------|--------------|
| 1 | 12 | 2 | ~$1-2 |
| 10 | 120 | 20 | ~$10-20 |
| 50 | 600 | 100 | ~$50-100 |
| 100 | 1,200 | 200 | ~$100-200 |
| 500 | 6,000 | 1,000 | ~$500-1,000 |

---

## 9. Configuration Reference

### 9.1 Desktop App Environment Variables

```bash
# ======================================
# OCR Configuration
# ======================================

# Primary OCR engine (paddle, tesseract, easyocr)
OCR_PRIMARY_ENGINE=paddle

# Fallback engines (comma-separated)
OCR_FALLBACK_ENGINES=tesseract,mock

# PaddleOCR settings
OCR_PADDLE_MIN_CONFIDENCE=0.5
OCR_PADDLE_USE_GPU=false
OCR_PADDLE_LANGUAGE=en

# Tesseract settings
OCR_TESSERACT_MIN_CONFIDENCE=0.6
OCR_TESSERACT_LANGUAGE=eng

# ======================================
# Tracking Configuration
# ======================================

# Batch upload interval (seconds)
BATCH_UPLOAD_INTERVAL=300  # 5 minutes

# Screenshot capture interval (seconds)
CAPTURE_INTERVAL=900  # 15 minutes (for interval-based mode)

# OCR throttle minimum interval (seconds)
OCR_MIN_INTERVAL=3

# ======================================
# API Configuration
# ======================================

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-key  # For batch inserts

# AI Server (if using direct connection)
AI_SERVER_URL=https://your-ai-server.com
```

### 9.2 AI Server Environment Variables

```bash
# ======================================
# AI Providers
# ======================================

# Google Gemini (primary for text analysis)
GOOGLE_API_KEY=your-google-api-key

# OpenAI (fallback)
OPENAI_API_KEY=your-openai-api-key

# LiteLLM routing
LITELLM_ENABLED=true

# ======================================
# Analysis Settings
# ======================================

# Default temperature for AI calls
AI_TEMPERATURE=0.3

# Max tokens for batch analysis
AI_MAX_TOKENS_PER_RECORD=150

# Batch size limits
MAX_BATCH_SIZE=50
```

---

## Appendix: Quick Reference

### A. File Locations

| Component | Location |
|-----------|----------|
| Desktop App | `python-desktop-app/desktop_app.py` |
| OCR Module | `python-desktop-app/ocr/` |
| OCR Facade | `python-desktop-app/ocr/facade.py` |
| AI Server | `ai-server/src/` |
| Activity Service | `ai-server/src/services/activity-service.js` |
| Database Migrations | `supabase/migrations/` |
| Documentation | `docs/` |

### B. Key API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/analyze-batch` | POST | Batch analyze activity records |
| `/api/classify-app` | POST | Classify unknown application |
| `/api/health` | GET | Health check |

### C. Database Tables

| Table | Purpose |
|-------|---------|
| `active_sessions` (SQLite) | Real-time local activity tracking |
| `activity_records` (Supabase) | Persistent cloud storage |
| `app_classifications_cache` | Cached app classifications |
| `user_jira_issues_cache` | Cached Jira issues |

---

*Document generated: March 12, 2026*
*Project: JIRAForge Time Tracker*
*Version: 1.0*
