# Linux Screenshot Capture & AI Processing Workflow

## Complete Technical Documentation

This document provides a comprehensive step-by-step explanation of how screenshot capture and AI-based analysis works in the Linux environment for JIRAForge Time Tracker.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Screenshot Capture (Linux/Wayland)](#2-screenshot-capture-linuxwayland)
3. [Window Tracking & Idle Detection](#3-window-tracking--idle-detection)
4. [Screenshot Upload to Supabase](#4-screenshot-upload-to-supabase)
5. [AI Server Processing Pipeline](#5-ai-server-processing-pipeline)
6. [AI Analysis (Vision & OCR)](#6-ai-analysis-vision--ocr)
7. [Result Storage & Jira Integration](#7-result-storage--jira-integration)
8. [Complete Data Flow Diagram](#8-complete-data-flow-diagram)
9. [Linux-Specific Dependencies](#9-linux-specific-dependencies)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture Overview

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LINUX DESKTOP APP (Python)                           │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────────┐ │
│  │ Screenshot      │  │ Window Tracking  │  │ Idle Detection             │ │
│  │ Capture         │  │ (EWMH/X11)       │  │ (D-Bus/GNOME Mutter)       │ │
│  │ (Wayland/       │  │                  │  │                            │ │
│  │  PipeWire)      │  │                  │  │                            │ │
│  └────────┬────────┘  └────────┬─────────┘  └─────────────┬──────────────┘ │
│           │                    │                          │                 │
│           └────────────────────┴──────────────────────────┘                 │
│                                │                                            │
│                    ┌───────────┴───────────┐                               │
│                    │ Screenshot with       │                               │
│                    │ Metadata (window,     │                               │
│                    │ app, timestamp)       │                               │
│                    └───────────┬───────────┘                               │
└──────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 │ HTTPS Upload
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SUPABASE CLOUD                                     │
│  ┌─────────────────────┐        ┌─────────────────────────────────────────┐│
│  │ Storage Bucket      │        │ PostgreSQL Database                     ││
│  │ (screenshots)       │        │ - screenshots table (status: pending)   ││
│  │ - JPEG images       │        │ - user_jira_issues_cache table          ││
│  │ - thumbnails        │        │                                         ││
│  └─────────────────────┘        └─────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 │ Polling (Every 30 seconds)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AI SERVER (Node.js)                                │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Polling       │  │ Screenshot   │  │ AI Analysis  │  │ Result         │ │
│  │ Service       │──▶│ Download     │──▶│ (Vision/OCR) │──▶│ Storage        │ │
│  │               │  │              │  │              │  │                │ │
│  └───────────────┘  └──────────────┘  └──────────────┘  └────────────────┘ │
│                                              │                              │
│                                              ▼                              │
│                     ┌────────────────────────────────────────────────────┐ │
│                     │ 3-Tier AI Fallback Chain:                         │ │
│                     │ 1. LiteLLM/Gemini → 2. LiteLLM/GPT-4o → 3. Fireworks│ │
│                     └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Screenshot Capture (Linux/Wayland)

### 2.1 Overview

The Linux implementation uses **XDG ScreenCast Portal + PipeWire** for screenshot capture on Wayland. This is the **only supported method** for modern Linux systems running Wayland.

### 2.2 Key Files

| File | Purpose |
|------|---------|
| `python-desktop-app/desktop_app_linux.py` | Main Linux-specific implementation |
| `python-desktop-app/wayland_screenshot.py` | PipeWire ScreenCast helper daemon |

### 2.3 Permission System

```
┌─────────────────────────────────────────────────────────────────┐
│                    FIRST-TIME PERMISSION FLOW                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. App Starts                                                  │
│      │                                                          │
│      ▼                                                          │
│  2. Screenshot Daemon Initializes                               │
│      │                                                          │
│      ▼                                                          │
│  3. XDG ScreenCast Portal Request                               │
│      │                                                          │
│      ▼                                                          │
│  ┌───────────────────────────────────────────┐                  │
│  │  GNOME SCREEN SHARE DIALOG                │                  │
│  │  ┌────────────────────────────────┐       │                  │
│  │  │  Select screen to share:       │       │                  │
│  │  │  ○ Primary Display             │       │                  │
│  │  │  ○ Secondary Display           │       │                  │
│  │  │                                │       │                  │
│  │  │  [Cancel]          [Share]     │       │                  │
│  │  └────────────────────────────────┘       │                  │
│  └───────────────────────────────────────────┘                  │
│      │                                                          │
│      ▼                                                          │
│  4. Permission Saved (persist_mode=2)                           │
│     Token stored at: ~/.local/share/timetracker/.screencast_token│
│      │                                                          │
│      ▼                                                          │
│  5. Future captures: NO MORE PROMPTS!                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.4 Screenshot Capture Process (Detailed)

#### Step 1: Start Screenshot Daemon

```python
# Location: desktop_app_linux.py - _start_screenshot_daemon()

def _start_screenshot_daemon():
    """Start the screenshot daemon (keeps screen share alive)."""
    global _daemon_process
    
    # Check if daemon is already running
    if _is_daemon_running():
        return True
    
    # Create socket directory
    socket_dir = os.path.dirname(_SCREENSHOT_SOCKET)
    os.makedirs(socket_dir, exist_ok=True)
    
    # Start daemon process
    script_dir = os.path.dirname(os.path.abspath(__file__))
    helper_script = os.path.join(script_dir, 'wayland_screenshot.py')
    
    _daemon_process = subprocess.Popen(
        ['/usr/bin/python3', helper_script, '--daemon'],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Wait for DAEMON_READY signal
    # This confirms the screen share session is active
```

#### Step 2: Initialize PipeWire Session

```python
# Location: wayland_screenshot.py - _initialize_session()

def _initialize_session():
    """Initialize the ScreenCast session (called once, kept open)."""
    
    # Step 2.1: Initialize GStreamer
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import GLib, Gio, Gst
    Gst.init(None)
    
    # Step 2.2: Connect to D-Bus Session Bus
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    
    # Step 2.3: Create ScreenCast Session
    result = bus.call_sync(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.ScreenCast",
        "CreateSession",
        # Session options with persistence
        GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", token),
            "session_handle_token": GLib.Variant("s", f"s{token}"),
        },)),
        ...
    )
    
    # Step 2.4: Select Sources (with persist_mode=2 for permanent permission)
    options = {
        "types": GLib.Variant("u", 1),           # Monitor only
        "multiple": GLib.Variant("b", False),     # Single screen
        "persist_mode": GLib.Variant("u", 2),     # Permanent permission
    }
    
    # Use restore_token if available (skip permission dialog)
    restore_token = get_saved_token()
    if restore_token:
        options["restore_token"] = GLib.Variant("s", restore_token)
    
    # Step 2.5: Start the Stream
    # This triggers the permission dialog on first run
    
    # Step 2.6: Open PipeWire Remote
    # Get file descriptor for GStreamer pipeline
    result = bus.call_with_unix_fd_list_sync(...)
    _session_state['pw_fd'] = fd_list.get(fd_idx)
```

#### Step 3: Capture Screenshot via Socket

```python
# Location: desktop_app_linux.py - _capture_via_daemon()

def _capture_via_daemon(output_path):
    """Send capture request to daemon via Unix socket."""
    import socket
    
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(_SCREENSHOT_SOCKET)  # ~/.local/share/timetracker/.screenshot_socket
        
        # Send capture command with output path
        sock.send(f"CAPTURE:{output_path}\n".encode())
        
        # Wait for response
        response = sock.recv(1024).decode().strip()
        sock.close()
        
        return response == "SUCCESS"
```

#### Step 4: GStreamer Pipeline Captures Frame

```python
# Location: wayland_screenshot.py - capture_screenshot()

def capture_screenshot(output_path):
    """Capture screenshot using persistent PipeWire ScreenCast session."""
    
    # Duplicate file descriptor (GStreamer may close it)
    dup_fd = os.dup(_session_state['pw_fd'])
    
    # Build GStreamer pipeline
    pipeline_str = (
        f"pipewiresrc fd={dup_fd} path={node_id} do-timestamp=true ! "
        f"videoconvert ! pngenc snapshot=true ! filesink location={output_path}"
    )
    
    # Execute pipeline
    pipeline = Gst.parse_launch(pipeline_str)
    pipeline.set_state(Gst.State.PLAYING)
    
    # Wait for End-Of-Stream (frame captured)
    # ...
    
    # Return PIL Image
    return Image.open(output_path)
```

### 2.5 Screenshot Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SCREENSHOT CAPTURE FLOW (LINUX)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Desktop App                     Screenshot Daemon                          │
│      │                                  │                                   │
│      │  1. capture_screenshot_linux()   │                                   │
│      │─────────────────────────────────▶│                                   │
│      │                                  │                                   │
│      │  2. Check if daemon running      │                                   │
│      │─────────────────────────────────▶│                                   │
│      │                                  │                                   │
│      │  3. Socket: CAPTURE:/tmp/ss.png  │                                   │
│      │─────────────────────────────────▶│                                   │
│      │                                  │  4. Use GStreamer pipeline        │
│      │                                  │     with PipeWire source          │
│      │                                  │─────────────────────────────────▶ │
│      │                                  │                                   │
│      │                                  │  5. pipewiresrc → videoconvert    │
│      │                                  │     → pngenc → filesink           │
│      │                                  │                                   │
│      │  6. Socket: SUCCESS              │                                   │
│      │◀─────────────────────────────────│                                   │
│      │                                  │                                   │
│      │  7. Load PNG as PIL Image        │                                   │
│      │                                  │                                   │
│      │  8. Return Image                 │                                   │
│      │◀─────────────────────────────────│                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Window Tracking & Idle Detection

### 3.1 Window Tracking (EWMH/X11)

The desktop app tracks the currently active window to associate time with specific applications.

```python
# Location: desktop_app_linux.py - get_active_window_linux()

def get_active_window_linux():
    """Get active window information using EWMH."""
    
    ewmh = EWMH()
    
    # Get active window from window manager
    active_window = ewmh.getActiveWindow()
    
    # Get window title
    title = ewmh.getWmName(active_window)
    # Example: "SCRUM-5 - Implement login - Jira - Google Chrome"
    
    # Get process ID
    pid = ewmh.getWmPid(active_window)
    
    # Get application name from process
    if pid:
        process = psutil.Process(pid)
        app_name = process.name()
        # Example: "chrome"
    
    return {
        'title': title,              # Full window title
        'app': app_name,             # Application name
        'window_key': f"{app_name}|||{title}",  # Unique identifier
        'is_new_window': False
    }
```

### 3.2 Idle Detection (D-Bus/GNOME Mutter)

On Wayland, the app uses D-Bus to query the GNOME Mutter Idle Monitor:

```python
# Location: desktop_app_linux.py - get_idle_time_linux()

def get_idle_time_linux():
    """Get system idle time via D-Bus GNOME Mutter IdleMonitor."""
    
    import dbus
    
    # Connect to session bus
    bus = dbus.SessionBus()
    
    # Access GNOME Mutter IdleMonitor
    mutter = bus.get_object(
        'org.gnome.Mutter.IdleMonitor',
        '/org/gnome/Mutter/IdleMonitor/Core'
    )
    
    # Get idle time in milliseconds
    idle_ms = mutter.GetIdletime(dbus_interface='org.gnome.Mutter.IdleMonitor')
    
    return idle_ms / 1000.0  # Convert to seconds
```

**Idle Detection Flow:**
```
┌─────────────────────────────────────────────────────────────────┐
│                      IDLE DETECTION FLOW                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Desktop App calls get_idle_time_linux()                     │
│      │                                                          │
│      ▼                                                          │
│  2. D-Bus Query to org.gnome.Mutter.IdleMonitor                 │
│      │                                                          │
│      ▼                                                          │
│  3. GNOME Mutter reports milliseconds since last input          │
│      │                                                          │
│      ▼                                                          │
│  4. If idle_time > idle_timeout (default 5 min):                │
│      │                                                          │
│      ├──▶ SKIP screenshot capture                               │
│      │                                                          │
│  5. Else:                                                       │
│      │                                                          │
│      └──▶ CAPTURE screenshot                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Screenshot Upload to Supabase

### 4.1 Upload Process

```python
# Location: desktop_app.py - upload_screenshot()

def upload_screenshot(self, screenshot, window_info):
    """Upload screenshot to Supabase with event-based tracking."""
    
    # Step 1: Convert to JPEG (saves ~80% storage vs PNG)
    img = screenshot.copy()
    if img.mode == 'RGBA':
        img = img.convert('RGB')
    img_buffer = BytesIO()
    img.save(img_buffer, format='JPEG', quality=85)
    img_bytes = img_buffer.getvalue()
    
    # Step 2: Generate storage path
    timestamp = datetime.now(timezone.utc)
    filename = f"screenshot_{int(timestamp.timestamp())}.jpg"
    storage_path = f"{self.current_user_id}/{filename}"
    
    # Step 3: Calculate duration (event-based tracking)
    end_time = timestamp
    start_time = self.last_screenshot_end_time or self.current_window_start_time
    duration_seconds = int((end_time - start_time).total_seconds())
    
    # Step 4: Upload to Supabase Storage
    upload_result = storage_client.storage.from_('screenshots').upload(
        storage_path, 
        img_bytes, 
        file_options={'content-type': 'image/jpeg'}
    )
    
    # Step 5: Get public URL
    screenshot_url = storage_client.storage.from_('screenshots').get_public_url(storage_path)
    
    # Step 6: Insert metadata into database
    screenshot_data = {
        'user_id': self.current_user_id,
        'organization_id': self.organization_id,
        'timestamp': timestamp.isoformat(),
        'storage_url': screenshot_url,
        'storage_path': storage_path,
        'window_title': window_info.get('title'),
        'application_name': window_info.get('app'),
        'status': 'pending',  # Will be processed by AI Server
        'start_time': start_time.isoformat(),
        'end_time': end_time.isoformat(),
        'duration_seconds': duration_seconds,
        'user_assigned_issues': self.user_issues  # Jira issues for AI context
    }
    
    result = db_client.table('screenshots').insert(screenshot_data).execute()
```

### 4.2 Database Record Structure

```json
{
  "id": "uuid-screenshot-id",
  "user_id": "uuid-user-id",
  "organization_id": "uuid-org-id",
  "timestamp": "2025-03-12T10:30:00Z",
  "storage_url": "https://supabase.co/storage/screenshots/user123/screenshot_1710240600.jpg",
  "storage_path": "user123/screenshot_1710240600.jpg",
  "window_title": "SCRUM-5 - Implement login feature - VS Code",
  "application_name": "code",
  "status": "pending",
  "start_time": "2025-03-12T10:25:00Z",
  "end_time": "2025-03-12T10:30:00Z",
  "duration_seconds": 300,
  "user_assigned_issues": [
    {"key": "SCRUM-5", "summary": "Implement login feature", "status": "In Progress"},
    {"key": "SCRUM-8", "summary": "Fix dashboard bug", "status": "In Progress"}
  ]
}
```

---

## 5. AI Server Processing Pipeline

### 5.1 Polling Service

The AI server polls Supabase every 30 seconds for pending screenshots:

```javascript
// Location: ai-server/src/services/polling-service.js

class PollingService {
    constructor() {
        this.pollingInterval = 30000; // 30 seconds
    }
    
    async pollForPendingScreenshots() {
        // Query for pending screenshots
        const { data: pending } = await supabase
            .from('screenshots')
            .select('*')
            .eq('status', 'pending')
            .order('timestamp', { ascending: true })
            .limit(10);  // Process in batches of 10
        
        for (const screenshot of pending) {
            await this.processScreenshot(screenshot);
        }
    }
    
    async processScreenshot(screenshot) {
        // Claim screenshot (atomic operation to prevent race conditions)
        const claimed = await supabaseService.claimScreenshotForProcessing(screenshot.id);
        if (!claimed) return;  // Already being processed
        
        // Download and analyze
        const imageBuffer = await this.downloadScreenshot(screenshot.storage_url);
        const analysis = await screenshotService.analyzeActivity({
            imageBuffer,
            windowTitle: screenshot.window_title,
            applicationName: screenshot.application_name,
            userAssignedIssues: screenshot.user_assigned_issues,
            ...
        });
        
        // Update database with results
        await supabaseService.updateScreenshotAnalysis(screenshot.id, analysis);
    }
}
```

### 5.2 Processing Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AI SERVER PROCESSING PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  1. POLLING SERVICE (Every 30 seconds)                              │   │
│  │     SELECT * FROM screenshots WHERE status = 'pending' LIMIT 10     │   │
│  └────────────────────────────────┬────────────────────────────────────┘   │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  2. CLAIM SCREENSHOT                                                │   │
│  │     UPDATE screenshots SET status = 'processing'                    │   │
│  │     WHERE id = ? AND status = 'pending'  -- Atomic operation        │   │
│  └────────────────────────────────┬────────────────────────────────────┘   │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  3. DOWNLOAD SCREENSHOT                                             │   │
│  │     Fetch JPEG from Supabase Storage                                │   │
│  └────────────────────────────────┬────────────────────────────────────┘   │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  4. AI ANALYSIS (See Section 6)                                     │   │
│  │     Vision API (Primary) or OCR + Text AI (Fallback)                │   │
│  └────────────────────────────────┬────────────────────────────────────┘   │
│                                   │                                         │
│                                   ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  5. UPDATE DATABASE                                                 │   │
│  │     status = 'analyzed'                                             │   │
│  │     task_key = 'SCRUM-5'                                            │   │
│  │     confidence_score = 0.85                                         │   │
│  │     work_type = 'office'                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. AI Analysis (Vision & OCR)

### 6.1 Analysis Methods

The AI server uses a **two-method approach** with automatic fallback:

| Method | Primary Use | Technology | Accuracy |
|--------|------------|------------|----------|
| **Vision Analysis** | Default | GPT-4 Vision / Gemini Vision | High |
| **OCR + Text AI** | Fallback | Tesseract.js + Text LLM | Medium |

### 6.2 Vision Analysis (Primary)

```javascript
// Location: ai-server/src/services/ai/vision-analyzer.js

async function analyzeWithVision({ imageBuffer, windowTitle, applicationName, userAssignedIssues }) {
    
    // Step 1: Convert image to base64
    const base64Image = imageBuffer.toString('base64');
    const imageDataUrl = `data:image/png;base64,${base64Image}`;
    
    // Step 2: Build prompt with user's Jira issues
    const assignedIssuesText = formatAssignedIssues(userAssignedIssues);
    const userPrompt = buildVisionUserPrompt(applicationName, windowTitle, assignedIssuesText);
    
    // Step 3: Send to Vision AI
    const messages = [
        {
            role: 'system',
            content: VISION_SYSTEM_PROMPT
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
            ]
        }
    ];
    
    // Step 4: Call AI with 3-tier fallback
    const { response, provider, model } = await chatCompletionWithFallback({
        messages,
        isVision: true,
        ...
    });
    
    // Step 5: Parse JSON response
    return parseAIResponse(response.choices[0].message.content);
}
```

### 6.3 OCR Fallback Analysis

```javascript
// Location: ai-server/src/services/ai/ocr-analyzer.js

async function analyzeWithOCRPipeline({ imageBuffer, windowTitle, applicationName, userAssignedIssues }) {
    
    // Step 1: OCR Text Extraction (Tesseract.js)
    const processedImage = await sharp(imageBuffer)
        .greyscale()
        .normalize()
        .toBuffer();
    
    const { data: { text } } = await Tesseract.recognize(processedImage, 'eng');
    const extractedText = text.trim();
    
    // Step 2: Build text-based prompt
    const userPrompt = buildOCRUserPrompt(applicationName, windowTitle, extractedText, assignedIssuesText);
    
    // Step 3: Send to Text AI (no vision capabilities needed)
    const { response, provider, model } = await chatCompletionWithFallback({
        messages: [
            { role: 'system', content: OCR_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
        ],
        isVision: false,
        ...
    });
    
    return parseAIResponse(response.choices[0].message.content);
}
```

### 6.4 3-Tier AI Fallback Chain

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         3-TIER AI FALLBACK CHAIN                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  TIER 1: LiteLLM with Gemini (gemini/gemini-2.0-flash)             │    │
│  │  - Primary provider                                                │    │
│  │  - Vision + Text capable                                           │    │
│  │  - Cost effective                                                  │    │
│  └───────────────────────────────┬────────────────────────────────────┘    │
│                                  │                                          │
│                    On 2 consecutive failures                                │
│                                  │                                          │
│                                  ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  TIER 2: LiteLLM with GPT-4o                                       │    │
│  │  - First fallback                                                  │    │
│  │  - High accuracy                                                   │    │
│  │  - Vision + Text capable                                           │    │
│  └───────────────────────────────┬────────────────────────────────────┘    │
│                                  │                                          │
│                    On 2 consecutive failures                                │
│                                  │                                          │
│                                  ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  TIER 3: Fireworks AI (Qwen2.5-VL-32B)                             │    │
│  │  - Final fallback                                                  │    │
│  │  - Open source model                                               │    │
│  │  - Vision capable                                                  │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  CIRCUIT BREAKER:                                                  │    │
│  │  - Provider demoted after 2 consecutive failures                   │    │
│  │  - 30-minute cooldown before restoration                           │    │
│  │  - Automatic recovery and reordering                               │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 AI Response Format

The AI returns a structured JSON response:

```json
{
  "workType": "office",
  "taskKey": "SCRUM-5",
  "projectKey": "SCRUM",
  "confidenceScore": 0.85,
  "contentAnalysis": "Screenshot shows VS Code with auth.service.ts open, implementing JWT token validation. File name suggests authentication work.",
  "reasoning": "Matched to SCRUM-5 'Implement login feature' because the code shows JWT token handling and authentication service implementation, which directly relates to login functionality."
}
```

---

## 7. Result Storage & Jira Integration

### 7.1 Screenshot Update

After analysis, the screenshot record is updated:

```sql
UPDATE screenshots
SET 
    status = 'analyzed',
    task_key = 'SCRUM-5',
    project_key = 'SCRUM',
    work_type = 'office',
    confidence_score = 0.85,
    analysis_reasoning = 'Matched to SCRUM-5...',
    ai_provider = 'LiteLLM/Gemini',
    ai_model = 'gemini-2.0-flash',
    analyzed_at = NOW()
WHERE id = 'uuid-screenshot-id';
```

### 7.2 Time Entry Creation

```sql
INSERT INTO time_entries (
    user_id,
    organization_id,
    task_key,
    project_key,
    start_time,
    end_time,
    duration_seconds,
    source,
    confidence_score,
    screenshot_id
) VALUES (
    'uuid-user-id',
    'uuid-org-id',
    'SCRUM-5',
    'SCRUM',
    '2025-03-12T10:25:00Z',
    '2025-03-12T10:30:00Z',
    300,
    'screenshot_ai',
    0.85,
    'uuid-screenshot-id'
);
```

---

## 8. Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        COMPLETE END-TO-END FLOW                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  LINUX DESKTOP                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  1. User works on laptop                                                  │   │
│  │     └── VS Code open with auth.service.ts                                │   │
│  │                                                                          │   │
│  │  2. Desktop App (every 5 minutes):                                       │   │
│  │     ├── Check idle time (D-Bus → GNOME Mutter)                           │   │
│  │     │   └── If idle > 5 min → SKIP                                       │   │
│  │     │                                                                    │   │
│  │     ├── Capture screenshot (Socket → Daemon → PipeWire → GStreamer)      │   │
│  │     │   └── PNG image in memory                                          │   │
│  │     │                                                                    │   │
│  │     ├── Get active window (EWMH/X11)                                     │   │
│  │     │   └── title: "auth.service.ts - VS Code"                           │   │
│  │     │   └── app: "code"                                                  │   │
│  │     │                                                                    │   │
│  │     └── Upload (HTTPS)                                                   │   │
│  │         └── JPEG image + metadata                                        │   │
│  └────────────────────────────────────┬─────────────────────────────────────┘   │
│                                       │                                          │
│                                       ▼                                          │
│  SUPABASE CLOUD                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  3. Storage: screenshots/user123/screenshot_1710240600.jpg               │   │
│  │                                                                          │   │
│  │  4. Database INSERT:                                                     │   │
│  │     ├── status: 'pending'                                                │   │
│  │     ├── window_title: "auth.service.ts - VS Code"                        │   │
│  │     ├── application_name: "code"                                         │   │
│  │     ├── duration_seconds: 300                                            │   │
│  │     └── user_assigned_issues: [{key: "SCRUM-5", ...}, ...]              │   │
│  └────────────────────────────────────┬─────────────────────────────────────┘   │
│                                       │                                          │
│                          Polling (every 30 seconds)                              │
│                                       │                                          │
│                                       ▼                                          │
│  AI SERVER                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  5. Claim screenshot (status: pending → processing)                      │   │
│  │                                                                          │   │
│  │  6. Download JPEG from Storage URL                                       │   │
│  │                                                                          │   │
│  │  7. AI Analysis:                                                         │   │
│  │     ├── Vision API (Primary):                                            │   │
│  │     │   └── "I see VS Code with auth.service.ts implementing JWT..."     │   │
│  │     │                                                                    │   │
│  │     └── OR OCR + Text AI (Fallback):                                     │   │
│  │         └── Tesseract extracts text → Text LLM analyzes                  │   │
│  │                                                                          │   │
│  │  8. Match to Jira Issue:                                                 │   │
│  │     ├── Content: JWT authentication code                                 │   │
│  │     ├── User Issue: SCRUM-5 "Implement login feature"                    │   │
│  │     └── MATCH! confidenceScore: 0.85                                     │   │
│  │                                                                          │   │
│  │  9. Update Database:                                                     │   │
│  │     ├── status: 'analyzed'                                               │   │
│  │     ├── task_key: 'SCRUM-5'                                              │   │
│  │     ├── confidence_score: 0.85                                           │   │
│  │     └── work_type: 'office'                                              │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  RESULT: 5 minutes of work automatically logged to SCRUM-5                       │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Linux-Specific Dependencies

### 9.1 Required System Packages

```bash
# GNOME/Wayland dependencies (for screenshot capture)
sudo apt install \
    gstreamer1.0-pipewire \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    python3-gi \
    gir1.2-gst-plugins-base-1.0

# X11 dependencies (for window tracking)
sudo apt install \
    python3-xlib \
    libx11-dev

# Notification support
sudo apt install libnotify-bin  # For notify-send

# Optional: Fallback tools
sudo apt install xdotool x11-utils  # For xdotool/xprop fallback
```

### 9.2 Required Python Packages

```bash
pip install \
    ewmh \
    python-xlib \
    psutil \
    Pillow \
    dbus-python \
    PyGObject \
    requests
```

### 9.3 Environment Detection

| Variable | Value | Meaning |
|----------|-------|---------|
| `XDG_SESSION_TYPE` | `wayland` | Wayland session (use PipeWire) |
| `XDG_SESSION_TYPE` | `x11` | X11 session (legacy) |

---

## 10. Troubleshooting

### 10.1 Screenshot Capture Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Black screenshots | Permission not granted | Re-run app, grant screen share permission |
| "Permission denied" | persist_mode not saved | Delete `~/.local/share/timetracker/.screencast_token` and retry |
| Daemon not starting | GStreamer missing | Install `gstreamer1.0-pipewire` |
| No captures on second monitor | Wrong screen selected | Re-grant permission, select correct monitor |

### 10.2 Debug Commands

```bash
# Check if PipeWire is running
systemctl --user status pipewire

# Test screenshot manually
python3 wayland_screenshot.py /tmp/test.png

# Check daemon status
echo "STATUS" | nc -U ~/.local/share/timetracker/.screenshot_socket

# View daemon logs
journalctl --user -f | grep -i screenshot
```

### 10.3 Idle Detection Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Always idle | D-Bus not available | Install `dbus-python`, check GNOME Mutter |
| Never idle | Using X11 session | Switch to Wayland or use pynput fallback |

### 10.4 Window Tracking Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Unknown" window | EWMH not working | Install `ewmh` and `python-xlib` |
| Wrong app name | PID not available | Some apps don't expose PID |

---

## Summary

The Linux screenshot capture and AI processing workflow consists of:

1. **Screenshot Capture**: Uses XDG ScreenCast Portal + PipeWire with persistent daemon for fast captures
2. **Window Tracking**: EWMH/X11 for active window detection
3. **Idle Detection**: D-Bus GNOME Mutter IdleMonitor
4. **Upload**: JPEG images to Supabase Storage with metadata
5. **AI Processing**: Polling service with Vision AI (primary) and OCR fallback
6. **Analysis**: 3-tier AI fallback chain (Gemini → GPT-4o → Fireworks)
7. **Storage**: Results in PostgreSQL with automatic Jira task matching

The system is designed for reliability with persistent permissions, automatic session recovery, and multiple fallback mechanisms at every stage.
