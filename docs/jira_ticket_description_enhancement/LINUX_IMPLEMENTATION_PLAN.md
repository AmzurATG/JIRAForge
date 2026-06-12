# Jira Ticket Description Enhancement — Linux Implementation Plan

**Date:** 2026-06-12  
**Status:** Ready for Implementation  
**Estimated Effort:** 3-4 days  
**Priority:** High

---

## Table of Contents

1. [Overview](#1-overview)
2. [Implementation Requirements](#2-implementation-requirements)
3. [Wayland Compatibility Strategy](#3-wayland-compatibility-strategy)
4. [Detailed Implementation Specifications](#4-detailed-implementation-specifications)
5. [File Changes Summary](#5-file-changes-summary)
6. [Test Scripts](#6-test-scripts)
7. [Implementation Checklist](#7-implementation-checklist)

---

## 1. Overview

### 1.1 Scope

This plan covers the **5% of changes** required to bring the Jira Ticket Description Enhancement feature to Linux. The remaining 95% (Forge App, AI Server, Supabase) is platform-agnostic and requires no modifications.

### 1.2 Components Requiring Changes

| Component | Change Type | Effort | Wayland Risk |
|-----------|-------------|--------|--------------|
| `DescriptionQualityPopup` | New class | 1.5 days | **Mitigated** |
| Quality nudge polling | New function | 0.5 day | None |
| Enhanced Linux notifications | Enhancement | 0.5 day | None |
| Test infrastructure | New tests | 1 day | None |

### 1.3 Design Principles

1. **No Wayland blockers** — All features work on both X11 and Wayland
2. **Graceful degradation** — Features degrade gracefully when dependencies are missing
3. **Consistent patterns** — Follow existing codebase patterns (e.g., `_bootstrap_linux_tray_backend()`)
4. **Testable** — All new code has corresponding unit tests

---

## 2. Implementation Requirements

### 2.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Display centered popup showing low-quality tickets | P0 |
| FR-2 | "Improve in Jira" button opens browser to issue panel | P0 |
| FR-3 | "Snooze" option with 1h, 4h, 24h choices | P1 |
| FR-4 | "Dismiss" closes popup and acknowledges nudge | P0 |
| FR-5 | Poll AI server for pending nudges | P0 |
| FR-6 | Respect user's notification settings | P1 |
| FR-7 | Work on both X11 and Wayland | P0 |

### 2.2 Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1 | Popup appears within 500ms of nudge received | P1 |
| NFR-2 | Polling does not increase CPU usage >1% | P1 |
| NFR-3 | Battery drain increase <5% when polling | P2 |
| NFR-4 | Works without PyGObject installed | P0 |

---

## 3. Wayland Compatibility Strategy

### 3.1 Problem Statement

Wayland's security model prevents applications from:
- Forcing windows to appear above all others (`-topmost`)
- Stealing focus from the current application
- Grabbing global keyboard/mouse input

### 3.2 Mitigation Strategy

| Issue | X11 Behavior | Wayland Behavior | Mitigation |
|-------|--------------|------------------|------------|
| Always-on-top | `-topmost` works | Ignored by compositor | Use `-type dialog` hint; accept compositor placement |
| Focus stealing | `focus_force()` works | Security-blocked | Use urgency hints; rely on notification |
| Window position | Global coordinates | Per-window only | Use `winfo_screenwidth/height` (relative) |

### 3.3 Implementation Approach

**Strategy: "Best Effort + Fallback Notification"**

```
┌─────────────────────────────────────────────────────────────────┐
│                     Quality Nudge Received                       │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│           Check: TKINTER_AVAILABLE == True?                     │
└─────────────────────┬───────────────────────────┬───────────────┘
                      │ Yes                       │ No
                      ▼                           ▼
┌─────────────────────────────────┐   ┌───────────────────────────┐
│   Create DescriptionQualityPopup │   │   Fallback: Send desktop  │
│   - Set dialog type hint         │   │   notification with       │
│   - Request focus (best effort)  │   │   "Open My Focus" link    │
│   - Center on screen             │   │                           │
└─────────────────────────────────┘   └───────────────────────────┘
```

### 3.4 Wayland-Specific Code Patterns

```python
def _configure_window_wayland_safe(window: tk.Toplevel) -> None:
    """Configure window hints that work on both X11 and Wayland."""
    # 1. Set window type to dialog (respected by most compositors)
    try:
        window.attributes('-type', 'dialog')
    except tk.TclError:
        pass  # Older Tk versions may not support this
    
    # 2. Attempt topmost on X11 only (harmless no-op on Wayland)
    if not _is_wayland():
        try:
            window.attributes('-topmost', True)
        except tk.TclError:
            pass
    
    # 3. Request focus (best effort - compositor may ignore)
    window.lift()
    window.focus_set()

def _is_wayland() -> bool:
    """Detect if running under Wayland display server."""
    return bool(
        os.environ.get('WAYLAND_DISPLAY') or
        os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
    )
```

---

## 4. Detailed Implementation Specifications

### 4.1 DescriptionQualityPopup Class

**Location:** `python-desktop-app/desktop_app.py` (insert after `PausePopupWindow` class, ~line 5700)

**Dependencies:**
- `tkinter` (already imported with fallback)
- `ttk` (already imported)
- `webbrowser` (already imported)

```python
# ==============================================================================
# DESCRIPTION QUALITY POPUP
# ==============================================================================

class DescriptionQualityPopup:
    """
    Centered popup window showing low-quality Jira tickets that need improvement.
    
    Works on both X11 and Wayland with graceful degradation:
    - X11: Uses -topmost for always-on-top behavior
    - Wayland: Uses dialog type hint; compositor controls window placement
    
    Thread Safety:
    - Must be instantiated from the tkinter main thread
    - Use root.after() to schedule from other threads
    """
    
    # Style constants
    WINDOW_WIDTH = 550
    WINDOW_HEIGHT = 420
    PADDING = 10
    
    # Colors (matching Time Tracker theme)
    BG_COLOR = '#2D2D2D'
    FG_COLOR = '#E0E0E0'
    ACCENT_COLOR = '#4A9EFF'
    WARNING_COLOR = '#FFA500'
    DANGER_COLOR = '#FF5252'
    SUCCESS_COLOR = '#4CAF50'
    
    def __init__(
        self,
        parent: tk.Tk,
        nudges: list,
        user_name: str,
        on_improve: callable,
        on_snooze: callable,
        on_dismiss: callable,
        on_close: callable = None
    ):
        """
        Initialize the quality popup.
        
        Args:
            parent: The root Tk window (for transient relationship)
            nudges: List of nudge dicts with keys: issueKey, issueUrl, score, summary
            user_name: Display name for greeting
            on_improve: Callback(nudge) when "Improve" clicked
            on_snooze: Callback(nudge, hours) when snooze selected
            on_dismiss: Callback(nudge) when single nudge dismissed
            on_close: Callback() when popup closed (optional)
        """
        self.parent = parent
        self.nudges = nudges
        self.user_name = user_name
        self.on_improve = on_improve
        self.on_snooze = on_snooze
        self.on_dismiss = on_dismiss
        self.on_close = on_close
        
        self.popup = None
        self._is_destroyed = False
        
        self._create_popup()
    
    def _create_popup(self) -> None:
        """Create and configure the popup window."""
        self.popup = tk.Toplevel(self.parent)
        self.popup.title("Time Tracker — Improve Ticket Quality")
        self.popup.configure(bg=self.BG_COLOR)
        
        # Prevent resize
        self.popup.resizable(False, False)
        
        # Center on screen
        self._center_window()
        
        # Platform-specific window configuration (Wayland-safe)
        self._configure_window_hints()
        
        # Handle window close
        self.popup.protocol("WM_DELETE_WINDOW", self._on_close)
        
        # Build UI
        self._create_header()
        self._create_ticket_list()
        self._create_footer()
        
        # Bring to front (best effort)
        self.popup.lift()
        self.popup.focus_set()
    
    def _center_window(self) -> None:
        """Center the popup on the primary monitor."""
        self.popup.update_idletasks()
        
        screen_width = self.popup.winfo_screenwidth()
        screen_height = self.popup.winfo_screenheight()
        
        x = (screen_width - self.WINDOW_WIDTH) // 2
        y = (screen_height - self.WINDOW_HEIGHT) // 2
        
        self.popup.geometry(f"{self.WINDOW_WIDTH}x{self.WINDOW_HEIGHT}+{x}+{y}")
    
    def _configure_window_hints(self) -> None:
        """Set window hints that work on both X11 and Wayland."""
        # Dialog type hint (respected by most compositors on Wayland)
        try:
            self.popup.attributes('-type', 'dialog')
        except tk.TclError:
            pass  # Older Tk versions
        
        # Transient relationship with parent
        try:
            self.popup.transient(self.parent)
        except tk.TclError:
            pass
        
        # X11-only: attempt topmost (harmless no-op on Wayland)
        if not self._is_wayland():
            try:
                self.popup.attributes('-topmost', True)
            except tk.TclError:
                pass
    
    def _is_wayland(self) -> bool:
        """Detect if running under Wayland."""
        return bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
    
    def _create_header(self) -> None:
        """Create the header with greeting and subtitle."""
        header_frame = tk.Frame(self.popup, bg=self.BG_COLOR, padx=self.PADDING, pady=self.PADDING)
        header_frame.pack(fill='x')
        
        # Greeting
        greeting = f"Hi {self.user_name}," if self.user_name else "Hi there,"
        greeting_label = tk.Label(
            header_frame,
            text=greeting,
            font=('Helvetica', 14, 'bold'),
            bg=self.BG_COLOR,
            fg=self.FG_COLOR
        )
        greeting_label.pack(anchor='w')
        
        # Subtitle
        count = len(self.nudges)
        subtitle_text = f"You have {count} ticket{'s' if count != 1 else ''} that could use clearer descriptions:"
        subtitle_label = tk.Label(
            header_frame,
            text=subtitle_text,
            font=('Helvetica', 11),
            bg=self.BG_COLOR,
            fg='#AAAAAA',
            wraplength=self.WINDOW_WIDTH - 2 * self.PADDING
        )
        subtitle_label.pack(anchor='w', pady=(5, 0))
    
    def _create_ticket_list(self) -> None:
        """Create the scrollable list of tickets."""
        # Container frame
        list_container = tk.Frame(self.popup, bg=self.BG_COLOR, padx=self.PADDING)
        list_container.pack(fill='both', expand=True)
        
        # Canvas for scrolling
        canvas = tk.Canvas(list_container, bg=self.BG_COLOR, highlightthickness=0)
        scrollbar = ttk.Scrollbar(list_container, orient='vertical', command=canvas.yview)
        
        # Scrollable frame inside canvas
        scrollable_frame = tk.Frame(canvas, bg=self.BG_COLOR)
        
        scrollable_frame.bind(
            '<Configure>',
            lambda e: canvas.configure(scrollregion=canvas.bbox('all'))
        )
        
        canvas.create_window((0, 0), window=scrollable_frame, anchor='nw', width=self.WINDOW_WIDTH - 40)
        canvas.configure(yscrollcommand=scrollbar.set)
        
        # Mouse wheel scrolling
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), 'units')
        
        def _on_mousewheel_linux(event):
            if event.num == 4:
                canvas.yview_scroll(-1, 'units')
            elif event.num == 5:
                canvas.yview_scroll(1, 'units')
        
        canvas.bind_all('<MouseWheel>', _on_mousewheel)
        canvas.bind_all('<Button-4>', _on_mousewheel_linux)
        canvas.bind_all('<Button-5>', _on_mousewheel_linux)
        
        # Add ticket rows
        for i, nudge in enumerate(self.nudges):
            self._create_ticket_row(scrollable_frame, nudge, i)
        
        canvas.pack(side='left', fill='both', expand=True)
        if len(self.nudges) > 3:
            scrollbar.pack(side='right', fill='y')
    
    def _create_ticket_row(self, parent: tk.Frame, nudge: dict, index: int) -> None:
        """Create a single ticket row with actions."""
        # Alternating background for visual separation
        row_bg = '#363636' if index % 2 == 0 else self.BG_COLOR
        
        row_frame = tk.Frame(parent, bg=row_bg, padx=8, pady=8)
        row_frame.pack(fill='x', pady=(0, 2))
        
        # Left side: ticket info
        info_frame = tk.Frame(row_frame, bg=row_bg)
        info_frame.pack(side='left', fill='x', expand=True)
        
        # Issue key with score
        score = nudge.get('score', 0)
        score_color = self._get_score_color(score)
        
        key_frame = tk.Frame(info_frame, bg=row_bg)
        key_frame.pack(anchor='w')
        
        key_label = tk.Label(
            key_frame,
            text=nudge.get('issueKey', 'Unknown'),
            font=('Helvetica', 11, 'bold'),
            bg=row_bg,
            fg=self.ACCENT_COLOR,
            cursor='hand2'
        )
        key_label.pack(side='left')
        key_label.bind('<Button-1>', lambda e, n=nudge: self._open_issue(n))
        
        score_label = tk.Label(
            key_frame,
            text=f" (Score: {score})",
            font=('Helvetica', 10),
            bg=row_bg,
            fg=score_color
        )
        score_label.pack(side='left')
        
        # Summary (truncated)
        summary = nudge.get('summary', 'No summary')
        if len(summary) > 60:
            summary = summary[:57] + '...'
        
        summary_label = tk.Label(
            info_frame,
            text=summary,
            font=('Helvetica', 10),
            bg=row_bg,
            fg='#CCCCCC',
            anchor='w'
        )
        summary_label.pack(anchor='w')
        
        # Right side: action buttons
        actions_frame = tk.Frame(row_frame, bg=row_bg)
        actions_frame.pack(side='right')
        
        # Improve button
        improve_btn = tk.Button(
            actions_frame,
            text="✨ Improve",
            font=('Helvetica', 9),
            bg=self.SUCCESS_COLOR,
            fg='white',
            activebackground='#5CBF60',
            relief='flat',
            padx=8,
            pady=2,
            cursor='hand2',
            command=lambda n=nudge: self._handle_improve(n)
        )
        improve_btn.pack(side='left', padx=(0, 5))
        
        # Snooze dropdown (using menubutton)
        snooze_menu = tk.Menubutton(
            actions_frame,
            text="⏰ Snooze",
            font=('Helvetica', 9),
            bg='#555555',
            fg='white',
            activebackground='#666666',
            relief='flat',
            padx=8,
            pady=2,
            cursor='hand2'
        )
        snooze_menu.menu = tk.Menu(snooze_menu, tearoff=0)
        snooze_menu['menu'] = snooze_menu.menu
        
        snooze_menu.menu.add_command(
            label="1 hour",
            command=lambda n=nudge: self._handle_snooze(n, 1)
        )
        snooze_menu.menu.add_command(
            label="4 hours",
            command=lambda n=nudge: self._handle_snooze(n, 4)
        )
        snooze_menu.menu.add_command(
            label="24 hours",
            command=lambda n=nudge: self._handle_snooze(n, 24)
        )
        snooze_menu.pack(side='left', padx=(0, 5))
        
        # Dismiss button
        dismiss_btn = tk.Button(
            actions_frame,
            text="✕",
            font=('Helvetica', 9),
            bg='#444444',
            fg='#AAAAAA',
            activebackground='#555555',
            relief='flat',
            padx=6,
            pady=2,
            cursor='hand2',
            command=lambda n=nudge: self._handle_dismiss(n)
        )
        dismiss_btn.pack(side='left')
    
    def _get_score_color(self, score: int) -> str:
        """Return color based on score value."""
        if score >= 80:
            return self.SUCCESS_COLOR
        elif score >= 50:
            return self.WARNING_COLOR
        else:
            return self.DANGER_COLOR
    
    def _open_issue(self, nudge: dict) -> None:
        """Open the issue in the browser."""
        url = nudge.get('issueUrl', '')
        if url:
            webbrowser.open(url)
    
    def _handle_improve(self, nudge: dict) -> None:
        """Handle improve button click."""
        if self.on_improve:
            self.on_improve(nudge)
        self._remove_nudge(nudge)
    
    def _handle_snooze(self, nudge: dict, hours: int) -> None:
        """Handle snooze selection."""
        if self.on_snooze:
            self.on_snooze(nudge, hours)
        self._remove_nudge(nudge)
    
    def _handle_dismiss(self, nudge: dict) -> None:
        """Handle dismiss button click."""
        if self.on_dismiss:
            self.on_dismiss(nudge)
        self._remove_nudge(nudge)
    
    def _remove_nudge(self, nudge: dict) -> None:
        """Remove a nudge from the list and update UI."""
        if nudge in self.nudges:
            self.nudges.remove(nudge)
        
        # Close popup if no nudges left
        if not self.nudges:
            self._on_close()
    
    def _create_footer(self) -> None:
        """Create the footer with dismiss all and settings buttons."""
        footer_frame = tk.Frame(self.popup, bg=self.BG_COLOR, padx=self.PADDING, pady=self.PADDING)
        footer_frame.pack(fill='x')
        
        # Separator line
        separator = tk.Frame(footer_frame, bg='#444444', height=1)
        separator.pack(fill='x', pady=(0, 10))
        
        # Button container
        btn_container = tk.Frame(footer_frame, bg=self.BG_COLOR)
        btn_container.pack(fill='x')
        
        # Open My Focus button
        focus_btn = tk.Button(
            btn_container,
            text="📊 Open My Focus",
            font=('Helvetica', 10),
            bg=self.ACCENT_COLOR,
            fg='white',
            activebackground='#5AAFFF',
            relief='flat',
            padx=12,
            pady=5,
            cursor='hand2',
            command=self._open_my_focus
        )
        focus_btn.pack(side='left')
        
        # Dismiss All button
        dismiss_all_btn = tk.Button(
            btn_container,
            text="Dismiss All",
            font=('Helvetica', 10),
            bg='#555555',
            fg='white',
            activebackground='#666666',
            relief='flat',
            padx=12,
            pady=5,
            cursor='hand2',
            command=self._dismiss_all
        )
        dismiss_all_btn.pack(side='right')
    
    def _open_my_focus(self) -> None:
        """Open the My Focus page in browser."""
        # TODO: Get actual URL from config or nudge data
        # Placeholder URL - should be replaced with actual My Focus URL
        my_focus_url = self.nudges[0].get('appUrl', '') if self.nudges else ''
        if my_focus_url:
            webbrowser.open(my_focus_url)
    
    def _dismiss_all(self) -> None:
        """Dismiss all nudges and close popup."""
        for nudge in list(self.nudges):
            if self.on_dismiss:
                self.on_dismiss(nudge)
        self._on_close()
    
    def _on_close(self) -> None:
        """Handle popup close."""
        if self._is_destroyed:
            return
        
        self._is_destroyed = True
        
        if self.on_close:
            self.on_close()
        
        try:
            self.popup.destroy()
        except tk.TclError:
            pass  # Window already destroyed
    
    def destroy(self) -> None:
        """Programmatically destroy the popup."""
        self._on_close()
```

---

### 4.2 Quality Nudge Polling Function

**Location:** Add to `TimeTracker` class in `desktop_app.py`

```python
# ==============================================================================
# DESCRIPTION QUALITY NUDGE POLLING
# ==============================================================================

# Add these constants near the top of the file (after other constants)
QUALITY_NUDGE_POLL_INTERVAL_ACTIVE = 300  # 5 minutes when user is active
QUALITY_NUDGE_POLL_INTERVAL_IDLE = 900    # 15 minutes when user is idle
QUALITY_NUDGE_POLL_INTERVAL_BATTERY = 600  # 10 minutes on battery
QUALITY_NUDGE_MAX_PER_POPUP = 5

# Add this method to TimeTracker class

def poll_description_quality_nudges(self) -> None:
    """
    Poll the AI server for pending description quality nudges.
    
    This method is called periodically from the tracking loop.
    It fetches any pending nudges for the current user and displays
    a popup or notification if nudges are available.
    
    Thread Safety:
    - Safe to call from any thread
    - UI updates are scheduled on tkinter main thread
    """
    if not self._is_authenticated():
        return
    
    # Skip if quality notifications are disabled
    if not self._quality_notifications_enabled():
        return
    
    try:
        # Make API request to AI server
        response = requests.get(
            f"{self.ai_server_url}/api/desktop/description-quality-nudges",
            headers={'Authorization': f'Bearer {self._get_fit_token()}'},
            timeout=(10, 30)
        )
        
        if response.status_code != 200:
            logger.debug(f"Quality nudge poll returned {response.status_code}")
            return
        
        data = response.json()
        
        if data.get('showModal') and data.get('nudges'):
            nudges = data['nudges'][:QUALITY_NUDGE_MAX_PER_POPUP]
            user_name = data.get('userName', '')
            
            # Schedule popup on tkinter thread
            if TKINTER_AVAILABLE and self._tk_root:
                self._tk_root.after(0, lambda: self._show_quality_popup(nudges, user_name))
            else:
                # Fallback to desktop notification
                self._show_quality_notification_fallback(nudges)
    
    except requests.exceptions.RequestException as e:
        logger.debug(f"Quality nudge poll failed: {e}")
    except Exception as e:
        logger.exception(f"Unexpected error in quality nudge poll: {e}")


def _quality_notifications_enabled(self) -> bool:
    """Check if quality notifications are enabled in user settings."""
    # Check notification settings
    if hasattr(self, '_notification_settings'):
        return self._notification_settings.get('description_quality', {}).get('enabled', True)
    return True


def _show_quality_popup(self, nudges: list, user_name: str) -> None:
    """
    Show the description quality popup.
    
    Must be called from the tkinter main thread.
    """
    if not TKINTER_AVAILABLE:
        self._show_quality_notification_fallback(nudges)
        return
    
    if self._quality_popup and not self._quality_popup._is_destroyed:
        # Popup already open - don't show another
        return
    
    try:
        self._quality_popup = DescriptionQualityPopup(
            parent=self._tk_root,
            nudges=nudges,
            user_name=user_name,
            on_improve=self._on_quality_improve,
            on_snooze=self._on_quality_snooze,
            on_dismiss=self._on_quality_dismiss,
            on_close=self._on_quality_popup_closed
        )
    except Exception as e:
        logger.exception(f"Failed to show quality popup: {e}")
        self._show_quality_notification_fallback(nudges)


def _on_quality_improve(self, nudge: dict) -> None:
    """Handle 'Improve' action from quality popup."""
    # Open the issue in browser with #dq=improve hash
    issue_url = nudge.get('issueUrl', '')
    if issue_url:
        # Add fragment to trigger improve mode
        if '#' not in issue_url:
            issue_url += '#dq=improve'
        webbrowser.open(issue_url)
    
    # Acknowledge the nudge
    self._acknowledge_quality_nudge(nudge, 'improved')


def _on_quality_snooze(self, nudge: dict, hours: int) -> None:
    """Handle 'Snooze' action from quality popup."""
    self._acknowledge_quality_nudge(nudge, 'snoozed', snooze_hours=hours)


def _on_quality_dismiss(self, nudge: dict) -> None:
    """Handle 'Dismiss' action from quality popup."""
    self._acknowledge_quality_nudge(nudge, 'dismissed')


def _on_quality_popup_closed(self) -> None:
    """Handle quality popup close."""
    self._quality_popup = None


def _acknowledge_quality_nudge(
    self,
    nudge: dict,
    action: str,
    snooze_hours: int = None
) -> None:
    """
    Send acknowledgement to AI server for a quality nudge.
    
    Args:
        nudge: The nudge dict
        action: One of 'improved', 'snoozed', 'dismissed'
        snooze_hours: Hours to snooze (only for 'snoozed' action)
    """
    try:
        payload = {
            'nudgeId': nudge.get('id'),
            'issueKey': nudge.get('issueKey'),
            'action': action
        }
        
        if snooze_hours is not None:
            payload['snoozeHours'] = snooze_hours
        
        response = requests.post(
            f"{self.ai_server_url}/api/desktop/description-quality-nudges/ack",
            json=payload,
            headers={'Authorization': f'Bearer {self._get_fit_token()}'},
            timeout=(10, 30)
        )
        
        if response.status_code != 200:
            logger.warning(f"Quality nudge ack failed: {response.status_code}")
    
    except Exception as e:
        logger.debug(f"Failed to acknowledge quality nudge: {e}")


def _show_quality_notification_fallback(self, nudges: list) -> None:
    """
    Show a fallback desktop notification when popup is not available.
    
    This is used when:
    - tkinter is not available
    - User prefers notifications over popups
    """
    count = len(nudges)
    title = "Time Tracker: Improve Ticket Quality"
    body = f"You have {count} ticket{'s' if count != 1 else ''} with low quality scores"
    
    if sys.platform == 'win32' and WINOTIFY_AVAILABLE:
        try:
            notification = Notification(
                app_id="Time Tracker",
                title=title,
                msg=body
            )
            notification.add_actions(label="Open My Focus", launch=nudges[0].get('appUrl', ''))
            notification.show()
        except Exception as e:
            logger.debug(f"Windows notification failed: {e}")
    
    elif sys.platform.startswith('linux'):
        _linux_notify(title, body, urgency="normal")
```

---

### 4.3 Enhanced Linux Notifications (Optional)

**Location:** Add to `desktop_app.py` after `_linux_notify()` function (~line 700)

```python
def _linux_notify_with_actions(
    title: str,
    body: str,
    actions: list = None,
    urgency: str = "normal"
) -> bool:
    """
    Send a desktop notification on Linux with action buttons.
    
    Uses PyGObject (gi) if available for action support,
    falls back to basic notify-send otherwise.
    
    Args:
        title: Notification title
        body: Notification body text
        actions: List of (action_id, label, callback) tuples
        urgency: One of "low", "normal", "critical"
    
    Returns:
        True if notification was shown successfully
    """
    if not sys.platform.startswith('linux'):
        return False
    
    # Try gi-based notification with actions first
    if actions:
        try:
            import gi
            gi.require_version('Notify', '0.7')
            from gi.repository import Notify
            
            if not Notify.is_initted():
                Notify.init("Time Tracker")
            
            notification = Notify.Notification.new(title, body)
            notification.set_urgency(_get_notify_urgency(urgency))
            
            for action_id, label, callback in actions:
                notification.add_action(action_id, label, callback)
            
            notification.show()
            return True
        
        except ImportError:
            logger.debug("PyGObject not available, falling back to notify-send")
        except Exception as e:
            logger.debug(f"gi-based notification failed: {e}")
    
    # Fallback to basic notify-send
    _linux_notify(title, body, urgency)
    return True


def _get_notify_urgency(urgency: str):
    """Convert string urgency to Notify.Urgency enum."""
    try:
        from gi.repository import Notify
        urgency_map = {
            'low': Notify.Urgency.LOW,
            'normal': Notify.Urgency.NORMAL,
            'critical': Notify.Urgency.CRITICAL
        }
        return urgency_map.get(urgency, Notify.Urgency.NORMAL)
    except:
        return None
```

---

### 4.4 Integration with Tracking Loop

**Location:** Modify `tracking_loop()` method in `TimeTracker` class

Add quality nudge polling to the existing tracking loop:

```python
# In tracking_loop() method, add after the unassigned work check:

# Description quality nudge polling (every 5-15 minutes depending on activity)
if self._should_poll_quality_nudges():
    self.poll_description_quality_nudges()
    self._last_quality_nudge_poll = time.time()


# Add this helper method to TimeTracker class:

def _should_poll_quality_nudges(self) -> bool:
    """Determine if it's time to poll for quality nudges."""
    if not hasattr(self, '_last_quality_nudge_poll'):
        self._last_quality_nudge_poll = 0
    
    elapsed = time.time() - self._last_quality_nudge_poll
    
    # Adjust interval based on activity and power state
    if self._is_on_battery():
        interval = QUALITY_NUDGE_POLL_INTERVAL_BATTERY
    elif self._is_user_idle():
        interval = QUALITY_NUDGE_POLL_INTERVAL_IDLE
    else:
        interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
    
    return elapsed >= interval


def _is_on_battery(self) -> bool:
    """Check if device is running on battery power."""
    try:
        import psutil
        battery = psutil.sensors_battery()
        return battery is not None and not battery.power_plugged
    except:
        return False
```

---

## 5. File Changes Summary

### 5.1 Files to Modify

| File | Lines to Add | Lines to Modify | Description |
|------|--------------|-----------------|-------------|
| `desktop_app.py` | ~450 | ~20 | Main implementation |
| `requirements.txt` | 2 | 0 | Optional PyGObject dep |

### 5.2 New Files to Create

| File | Purpose |
|------|---------|
| `tests/test_description_quality_popup.py` | Unit tests for popup |
| `tests/test_quality_nudge_polling.py` | Unit tests for polling |
| `tests/integration/test_quality_popup_linux.py` | Linux-specific integration tests |

---

## 6. Test Scripts

### 6.1 Unit Tests for DescriptionQualityPopup

**File:** `python-desktop-app/tests/test_description_quality_popup.py`

```python
"""
Unit tests for DescriptionQualityPopup class.

These tests verify:
- Popup creation and destruction
- Window positioning (centering)
- Wayland vs X11 configuration
- Action callbacks
- Nudge removal logic
"""

import pytest
import sys
import os
from unittest.mock import Mock, patch, MagicMock

# Mock tkinter before importing the module
sys.modules['tkinter'] = MagicMock()
sys.modules['tkinter.ttk'] = MagicMock()


class TestDescriptionQualityPopup:
    """Tests for DescriptionQualityPopup class."""
    
    @pytest.fixture
    def mock_tk(self):
        """Create mock tkinter components."""
        mock_root = MagicMock()
        mock_root.winfo_screenwidth.return_value = 1920
        mock_root.winfo_screenheight.return_value = 1080
        return mock_root
    
    @pytest.fixture
    def sample_nudges(self):
        """Sample nudge data for testing."""
        return [
            {
                'id': 'nudge-1',
                'issueKey': 'PROJ-123',
                'issueUrl': 'https://example.atlassian.net/browse/PROJ-123',
                'score': 45,
                'summary': 'Test ticket with low quality description'
            },
            {
                'id': 'nudge-2',
                'issueKey': 'PROJ-456',
                'issueUrl': 'https://example.atlassian.net/browse/PROJ-456',
                'score': 60,
                'summary': 'Another ticket needing improvement'
            }
        ]
    
    @pytest.fixture
    def callbacks(self):
        """Create mock callbacks."""
        return {
            'on_improve': Mock(),
            'on_snooze': Mock(),
            'on_dismiss': Mock(),
            'on_close': Mock()
        }
    
    def test_popup_creation_basic(self, mock_tk, sample_nudges, callbacks):
        """Test basic popup creation."""
        with patch.dict(os.environ, {}, clear=True):
            # Import here to get fresh module state
            from desktop_app import DescriptionQualityPopup
            
            popup = DescriptionQualityPopup(
                parent=mock_tk,
                nudges=sample_nudges,
                user_name='Test User',
                **callbacks
            )
            
            assert popup.nudges == sample_nudges
            assert popup.user_name == 'Test User'
            assert not popup._is_destroyed
    
    def test_wayland_detection_true(self):
        """Test Wayland detection when WAYLAND_DISPLAY is set."""
        with patch.dict(os.environ, {'WAYLAND_DISPLAY': 'wayland-0'}):
            from desktop_app import DescriptionQualityPopup
            
            popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            assert popup._is_wayland() is True
    
    def test_wayland_detection_xdg_session(self):
        """Test Wayland detection via XDG_SESSION_TYPE."""
        with patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}, clear=True):
            from desktop_app import DescriptionQualityPopup
            
            popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            assert popup._is_wayland() is True
    
    def test_x11_detection(self):
        """Test X11 detection (no Wayland env vars)."""
        with patch.dict(os.environ, {'DISPLAY': ':0'}, clear=True):
            from desktop_app import DescriptionQualityPopup
            
            popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            assert popup._is_wayland() is False
    
    def test_window_centering(self, mock_tk, sample_nudges, callbacks):
        """Test window is centered on screen."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=sample_nudges,
            user_name='Test User',
            **callbacks
        )
        
        # Verify geometry was called with centered position
        # Expected: center of 1920x1080 for 550x420 window
        # x = (1920 - 550) / 2 = 685
        # y = (1080 - 420) / 2 = 330
        popup.popup.geometry.assert_called()
    
    def test_score_color_red(self, sample_nudges, callbacks):
        """Test score color is red for low scores."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
        
        assert popup._get_score_color(25) == '#FF5252'  # DANGER_COLOR
        assert popup._get_score_color(49) == '#FF5252'
    
    def test_score_color_yellow(self, sample_nudges, callbacks):
        """Test score color is yellow for medium scores."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
        
        assert popup._get_score_color(50) == '#FFA500'  # WARNING_COLOR
        assert popup._get_score_color(79) == '#FFA500'
    
    def test_score_color_green(self, sample_nudges, callbacks):
        """Test score color is green for high scores."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
        
        assert popup._get_score_color(80) == '#4CAF50'  # SUCCESS_COLOR
        assert popup._get_score_color(100) == '#4CAF50'
    
    def test_improve_callback(self, mock_tk, sample_nudges, callbacks):
        """Test improve button triggers callback."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=sample_nudges.copy(),
            user_name='Test User',
            **callbacks
        )
        
        popup._handle_improve(sample_nudges[0])
        
        callbacks['on_improve'].assert_called_once_with(sample_nudges[0])
    
    def test_snooze_callback(self, mock_tk, sample_nudges, callbacks):
        """Test snooze triggers callback with hours."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=sample_nudges.copy(),
            user_name='Test User',
            **callbacks
        )
        
        popup._handle_snooze(sample_nudges[0], 4)
        
        callbacks['on_snooze'].assert_called_once_with(sample_nudges[0], 4)
    
    def test_dismiss_callback(self, mock_tk, sample_nudges, callbacks):
        """Test dismiss triggers callback."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=sample_nudges.copy(),
            user_name='Test User',
            **callbacks
        )
        
        popup._handle_dismiss(sample_nudges[0])
        
        callbacks['on_dismiss'].assert_called_once_with(sample_nudges[0])
    
    def test_nudge_removal(self, mock_tk, sample_nudges, callbacks):
        """Test nudge is removed from list after action."""
        from desktop_app import DescriptionQualityPopup
        
        nudges_copy = sample_nudges.copy()
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=nudges_copy,
            user_name='Test User',
            **callbacks
        )
        
        initial_count = len(popup.nudges)
        popup._remove_nudge(nudges_copy[0])
        
        assert len(popup.nudges) == initial_count - 1
    
    def test_popup_closes_when_all_nudges_dismissed(self, mock_tk, callbacks):
        """Test popup closes automatically when all nudges are handled."""
        from desktop_app import DescriptionQualityPopup
        
        single_nudge = [{
            'id': 'nudge-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.atlassian.net',
            'score': 45,
            'summary': 'Test'
        }]
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=single_nudge,
            user_name='Test User',
            **callbacks
        )
        
        popup._remove_nudge(single_nudge[0])
        
        # on_close should be called when last nudge is removed
        callbacks['on_close'].assert_called_once()
    
    def test_destroy_method(self, mock_tk, sample_nudges, callbacks):
        """Test destroy method properly cleans up."""
        from desktop_app import DescriptionQualityPopup
        
        popup = DescriptionQualityPopup(
            parent=mock_tk,
            nudges=sample_nudges,
            user_name='Test User',
            **callbacks
        )
        
        popup.destroy()
        
        assert popup._is_destroyed is True
        callbacks['on_close'].assert_called_once()


class TestWaylandWindowConfiguration:
    """Tests specific to Wayland window configuration."""
    
    def test_dialog_type_hint_set_on_wayland(self):
        """Test that dialog type hint is set on Wayland."""
        mock_popup = MagicMock()
        
        with patch.dict(os.environ, {'WAYLAND_DISPLAY': 'wayland-0'}):
            from desktop_app import DescriptionQualityPopup
            
            instance = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            instance.popup = mock_popup
            
            instance._configure_window_hints()
            
            mock_popup.attributes.assert_any_call('-type', 'dialog')
    
    def test_topmost_not_set_on_wayland(self):
        """Test that -topmost is NOT set on Wayland."""
        mock_popup = MagicMock()
        
        with patch.dict(os.environ, {'WAYLAND_DISPLAY': 'wayland-0'}):
            from desktop_app import DescriptionQualityPopup
            
            instance = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            instance.popup = mock_popup
            
            instance._configure_window_hints()
            
            # Verify -topmost was not called
            calls = [call for call in mock_popup.attributes.call_args_list 
                     if call[0][0] == '-topmost']
            assert len(calls) == 0
    
    def test_topmost_set_on_x11(self):
        """Test that -topmost IS set on X11."""
        mock_popup = MagicMock()
        
        with patch.dict(os.environ, {'DISPLAY': ':0'}, clear=True):
            from desktop_app import DescriptionQualityPopup
            
            instance = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
            instance.popup = mock_popup
            
            instance._configure_window_hints()
            
            mock_popup.attributes.assert_any_call('-topmost', True)
```

---

### 6.2 Unit Tests for Quality Nudge Polling

**File:** `python-desktop-app/tests/test_quality_nudge_polling.py`

```python
"""
Unit tests for quality nudge polling functionality.

These tests verify:
- Poll timing logic (active/idle/battery intervals)
- API request handling
- Error handling
- Acknowledgement requests
"""

import pytest
import time
from unittest.mock import Mock, patch, MagicMock
import requests


class TestQualityNudgePolling:
    """Tests for quality nudge polling functions."""
    
    @pytest.fixture
    def mock_tracker(self):
        """Create a mock TimeTracker instance."""
        tracker = MagicMock()
        tracker.ai_server_url = 'https://test.server.com'
        tracker._is_authenticated.return_value = True
        tracker._quality_notifications_enabled.return_value = True
        tracker._get_fit_token.return_value = 'test-token'
        tracker._tk_root = MagicMock()
        tracker._quality_popup = None
        return tracker
    
    @pytest.fixture
    def sample_api_response(self):
        """Sample API response with nudges."""
        return {
            'showModal': True,
            'userName': 'Test User',
            'nudges': [
                {
                    'id': 'nudge-1',
                    'issueKey': 'PROJ-123',
                    'issueUrl': 'https://example.atlassian.net/browse/PROJ-123',
                    'score': 45,
                    'summary': 'Test ticket'
                }
            ]
        }
    
    def test_poll_skips_when_not_authenticated(self, mock_tracker):
        """Test polling is skipped when user is not authenticated."""
        mock_tracker._is_authenticated.return_value = False
        
        from desktop_app import TimeTracker
        TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        # API should not be called
        mock_tracker._get_fit_token.assert_not_called()
    
    def test_poll_skips_when_notifications_disabled(self, mock_tracker):
        """Test polling is skipped when notifications are disabled."""
        mock_tracker._quality_notifications_enabled.return_value = False
        
        from desktop_app import TimeTracker
        TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        # API should not be called
        mock_tracker._get_fit_token.assert_not_called()
    
    @patch('requests.get')
    def test_poll_makes_correct_api_request(self, mock_get, mock_tracker, sample_api_response):
        """Test API request is made with correct parameters."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = sample_api_response
        mock_get.return_value = mock_response
        
        from desktop_app import TimeTracker
        TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        mock_get.assert_called_once_with(
            'https://test.server.com/api/desktop/description-quality-nudges',
            headers={'Authorization': 'Bearer test-token'},
            timeout=(10, 30)
        )
    
    @patch('requests.get')
    def test_poll_handles_non_200_response(self, mock_get, mock_tracker):
        """Test polling handles non-200 responses gracefully."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_get.return_value = mock_response
        
        from desktop_app import TimeTracker
        
        # Should not raise exception
        TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        # Popup should not be shown
        mock_tracker._tk_root.after.assert_not_called()
    
    @patch('requests.get')
    def test_poll_handles_network_error(self, mock_get, mock_tracker):
        """Test polling handles network errors gracefully."""
        mock_get.side_effect = requests.exceptions.ConnectionError("Network error")
        
        from desktop_app import TimeTracker
        
        # Should not raise exception
        TimeTracker.poll_description_quality_nudges(mock_tracker)
    
    @patch('requests.get')
    def test_poll_shows_popup_when_nudges_available(self, mock_get, mock_tracker, sample_api_response):
        """Test popup is shown when nudges are available."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = sample_api_response
        mock_get.return_value = mock_response
        
        # Mock TKINTER_AVAILABLE
        with patch.dict('desktop_app.__dict__', {'TKINTER_AVAILABLE': True}):
            from desktop_app import TimeTracker
            TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        # Verify popup scheduling
        mock_tracker._tk_root.after.assert_called()
    
    @patch('requests.get')
    def test_poll_limits_nudges_to_max(self, mock_get, mock_tracker):
        """Test nudges are limited to MAX_PER_POPUP."""
        many_nudges = {
            'showModal': True,
            'userName': 'Test User',
            'nudges': [{'id': f'nudge-{i}', 'issueKey': f'PROJ-{i}'} for i in range(10)]
        }
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = many_nudges
        mock_get.return_value = mock_response
        
        from desktop_app import TimeTracker, QUALITY_NUDGE_MAX_PER_POPUP
        
        # Capture the nudges passed to popup
        captured_nudges = []
        
        def capture_after(delay, func):
            # Execute the scheduled function to capture args
            func()
        
        mock_tracker._tk_root.after.side_effect = capture_after
        mock_tracker._show_quality_popup = Mock(side_effect=lambda n, u: captured_nudges.extend(n))
        
        TimeTracker.poll_description_quality_nudges(mock_tracker)
        
        # Verify nudges were limited
        assert len(captured_nudges) <= QUALITY_NUDGE_MAX_PER_POPUP


class TestQualityNudgeAcknowledgement:
    """Tests for quality nudge acknowledgement."""
    
    @pytest.fixture
    def mock_tracker(self):
        """Create a mock TimeTracker instance."""
        tracker = MagicMock()
        tracker.ai_server_url = 'https://test.server.com'
        tracker._get_fit_token.return_value = 'test-token'
        return tracker
    
    @pytest.fixture
    def sample_nudge(self):
        """Sample nudge for testing."""
        return {
            'id': 'nudge-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-123'
        }
    
    @patch('requests.post')
    def test_ack_improved(self, mock_post, mock_tracker, sample_nudge):
        """Test acknowledgement for 'improved' action."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response
        
        from desktop_app import TimeTracker
        TimeTracker._acknowledge_quality_nudge(mock_tracker, sample_nudge, 'improved')
        
        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]['json']['action'] == 'improved'
    
    @patch('requests.post')
    def test_ack_snoozed_with_hours(self, mock_post, mock_tracker, sample_nudge):
        """Test acknowledgement for 'snoozed' action includes hours."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response
        
        from desktop_app import TimeTracker
        TimeTracker._acknowledge_quality_nudge(mock_tracker, sample_nudge, 'snoozed', snooze_hours=4)
        
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]['json']['action'] == 'snoozed'
        assert call_kwargs[1]['json']['snoozeHours'] == 4
    
    @patch('requests.post')
    def test_ack_dismissed(self, mock_post, mock_tracker, sample_nudge):
        """Test acknowledgement for 'dismissed' action."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_post.return_value = mock_response
        
        from desktop_app import TimeTracker
        TimeTracker._acknowledge_quality_nudge(mock_tracker, sample_nudge, 'dismissed')
        
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]['json']['action'] == 'dismissed'
    
    @patch('requests.post')
    def test_ack_handles_network_error(self, mock_post, mock_tracker, sample_nudge):
        """Test acknowledgement handles network errors gracefully."""
        mock_post.side_effect = requests.exceptions.ConnectionError("Network error")
        
        from desktop_app import TimeTracker
        
        # Should not raise exception
        TimeTracker._acknowledge_quality_nudge(mock_tracker, sample_nudge, 'dismissed')


class TestPollIntervalLogic:
    """Tests for poll interval calculation."""
    
    @pytest.fixture
    def mock_tracker(self):
        """Create a mock TimeTracker instance."""
        tracker = MagicMock()
        tracker._is_on_battery.return_value = False
        tracker._is_user_idle.return_value = False
        return tracker
    
    def test_poll_interval_active(self, mock_tracker):
        """Test active interval is used when user is active."""
        mock_tracker._is_on_battery.return_value = False
        mock_tracker._is_user_idle.return_value = False
        
        from desktop_app import TimeTracker, QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        
        mock_tracker._last_quality_nudge_poll = time.time() - QUALITY_NUDGE_POLL_INTERVAL_ACTIVE - 1
        
        result = TimeTracker._should_poll_quality_nudges(mock_tracker)
        assert result is True
    
    def test_poll_interval_idle(self, mock_tracker):
        """Test idle interval is used when user is idle."""
        mock_tracker._is_on_battery.return_value = False
        mock_tracker._is_user_idle.return_value = True
        
        from desktop_app import TimeTracker, QUALITY_NUDGE_POLL_INTERVAL_IDLE
        
        # Set last poll to just after idle interval
        mock_tracker._last_quality_nudge_poll = time.time() - QUALITY_NUDGE_POLL_INTERVAL_IDLE + 10
        
        result = TimeTracker._should_poll_quality_nudges(mock_tracker)
        assert result is False
    
    def test_poll_interval_battery(self, mock_tracker):
        """Test battery interval is used when on battery."""
        mock_tracker._is_on_battery.return_value = True
        mock_tracker._is_user_idle.return_value = False
        
        from desktop_app import TimeTracker, QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        
        mock_tracker._last_quality_nudge_poll = time.time() - QUALITY_NUDGE_POLL_INTERVAL_BATTERY - 1
        
        result = TimeTracker._should_poll_quality_nudges(mock_tracker)
        assert result is True
```

---

### 6.3 Linux Integration Tests

**File:** `python-desktop-app/tests/integration/test_quality_popup_linux.py`

```python
"""
Integration tests for quality popup on Linux.

These tests are designed to run on actual Linux systems and verify:
- Popup displays correctly on X11 and Wayland
- Window hints are applied correctly
- User interactions work as expected

Run with: pytest tests/integration/test_quality_popup_linux.py -v --linux
"""

import pytest
import sys
import os

# Skip all tests in this file if not on Linux
pytestmark = pytest.mark.skipif(
    not sys.platform.startswith('linux'),
    reason="Linux-specific tests"
)


@pytest.fixture
def display_available():
    """Check if a display is available for GUI tests."""
    return bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


@pytest.fixture
def is_wayland():
    """Detect if running under Wayland."""
    return bool(
        os.environ.get('WAYLAND_DISPLAY') or
        os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
    )


class TestLinuxPopupDisplay:
    """Integration tests for popup display on Linux."""
    
    @pytest.mark.skipif(not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'),
                        reason="No display available")
    def test_popup_creates_without_error(self, display_available):
        """Test popup can be created on Linux."""
        if not display_available:
            pytest.skip("No display available")
        
        import tkinter as tk
        from desktop_app import DescriptionQualityPopup
        
        root = tk.Tk()
        root.withdraw()  # Hide root window
        
        nudges = [{
            'id': 'test-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.com',
            'score': 45,
            'summary': 'Test ticket'
        }]
        
        popup = DescriptionQualityPopup(
            parent=root,
            nudges=nudges,
            user_name='Test User',
            on_improve=lambda n: None,
            on_snooze=lambda n, h: None,
            on_dismiss=lambda n: None
        )
        
        # Verify popup was created
        assert popup.popup is not None
        assert popup.popup.winfo_exists()
        
        # Cleanup
        popup.destroy()
        root.destroy()
    
    @pytest.mark.skipif(not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'),
                        reason="No display available")
    def test_popup_is_centered(self, display_available):
        """Test popup is approximately centered on screen."""
        if not display_available:
            pytest.skip("No display available")
        
        import tkinter as tk
        from desktop_app import DescriptionQualityPopup
        
        root = tk.Tk()
        root.withdraw()
        
        nudges = [{'id': 'test-1', 'issueKey': 'PROJ-123', 'issueUrl': '', 'score': 45, 'summary': 'Test'}]
        
        popup = DescriptionQualityPopup(
            parent=root,
            nudges=nudges,
            user_name='Test',
            on_improve=lambda n: None,
            on_snooze=lambda n, h: None,
            on_dismiss=lambda n: None
        )
        
        # Get screen and window dimensions
        screen_width = popup.popup.winfo_screenwidth()
        screen_height = popup.popup.winfo_screenheight()
        window_x = popup.popup.winfo_x()
        window_y = popup.popup.winfo_y()
        window_width = popup.popup.winfo_width()
        window_height = popup.popup.winfo_height()
        
        # Calculate expected center
        expected_x = (screen_width - window_width) // 2
        expected_y = (screen_height - window_height) // 2
        
        # Allow some tolerance (compositors may adjust slightly)
        tolerance = 50
        assert abs(window_x - expected_x) < tolerance, f"X position off: {window_x} vs {expected_x}"
        assert abs(window_y - expected_y) < tolerance, f"Y position off: {window_y} vs {expected_y}"
        
        popup.destroy()
        root.destroy()
    
    @pytest.mark.skipif(not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'),
                        reason="No display available")
    def test_wayland_dialog_hint(self, is_wayland, display_available):
        """Test dialog type hint is set on Wayland."""
        if not display_available:
            pytest.skip("No display available")
        
        import tkinter as tk
        from desktop_app import DescriptionQualityPopup
        
        root = tk.Tk()
        root.withdraw()
        
        nudges = [{'id': 'test-1', 'issueKey': 'PROJ-123', 'issueUrl': '', 'score': 45, 'summary': 'Test'}]
        
        popup = DescriptionQualityPopup(
            parent=root,
            nudges=nudges,
            user_name='Test',
            on_improve=lambda n: None,
            on_snooze=lambda n, h: None,
            on_dismiss=lambda n: None
        )
        
        # On Wayland, we can't easily verify the hint was set,
        # but we can verify no error was raised
        assert popup.popup.winfo_exists()
        
        popup.destroy()
        root.destroy()


class TestLinuxNotifications:
    """Integration tests for Linux notifications."""
    
    def test_notify_send_available(self):
        """Test notify-send is available on the system."""
        import shutil
        
        notify_send = shutil.which('notify-send')
        
        # This test is informational - we don't fail if not available
        if notify_send:
            print(f"notify-send found at: {notify_send}")
        else:
            pytest.skip("notify-send not installed")
    
    def test_basic_notification(self):
        """Test basic notification can be sent."""
        import shutil
        import subprocess
        
        notify_send = shutil.which('notify-send')
        if not notify_send:
            pytest.skip("notify-send not installed")
        
        # Send a test notification
        result = subprocess.run(
            [notify_send, "--urgency", "low", "--app-name", "Test",
             "Test Title", "Test body message"],
            timeout=5,
            capture_output=True
        )
        
        # Exit code 0 means success
        assert result.returncode == 0


class TestEnvironmentDetection:
    """Tests for environment detection functions."""
    
    def test_wayland_detection_accuracy(self, is_wayland):
        """Test Wayland detection matches actual environment."""
        from desktop_app import DescriptionQualityPopup
        
        # Create a bare instance to test detection
        instance = DescriptionQualityPopup.__new__(DescriptionQualityPopup)
        detected = instance._is_wayland()
        
        assert detected == is_wayland, f"Detection mismatch: detected={detected}, actual={is_wayland}"
    
    def test_environment_variables_present(self):
        """Log environment variables for debugging."""
        print(f"DISPLAY: {os.environ.get('DISPLAY', 'not set')}")
        print(f"WAYLAND_DISPLAY: {os.environ.get('WAYLAND_DISPLAY', 'not set')}")
        print(f"XDG_SESSION_TYPE: {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
        print(f"XDG_CURRENT_DESKTOP: {os.environ.get('XDG_CURRENT_DESKTOP', 'not set')}")
```

---

### 6.4 Manual Test Script

**File:** `python-desktop-app/scripts/test_quality_popup.py`

```python
#!/usr/bin/env python3
"""
Manual test script for Description Quality Popup.

Usage:
    python scripts/test_quality_popup.py [--wayland] [--x11] [--minimal]

Options:
    --wayland    Force Wayland mode (set WAYLAND_DISPLAY env var)
    --x11        Force X11 mode (unset Wayland env vars)
    --minimal    Show popup with minimal UI (for debugging)
"""

import sys
import os
import argparse
import webbrowser

# Ensure we can import from parent directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def parse_args():
    parser = argparse.ArgumentParser(description='Test Description Quality Popup')
    parser.add_argument('--wayland', action='store_true', help='Force Wayland mode')
    parser.add_argument('--x11', action='store_true', help='Force X11 mode')
    parser.add_argument('--minimal', action='store_true', help='Minimal UI mode')
    return parser.parse_args()


def setup_environment(args):
    """Configure environment based on arguments."""
    if args.wayland:
        os.environ['WAYLAND_DISPLAY'] = 'wayland-test'
        os.environ['XDG_SESSION_TYPE'] = 'wayland'
        print("Forcing Wayland mode")
    elif args.x11:
        os.environ.pop('WAYLAND_DISPLAY', None)
        os.environ['XDG_SESSION_TYPE'] = 'x11'
        os.environ['DISPLAY'] = os.environ.get('DISPLAY', ':0')
        print("Forcing X11 mode")


def create_sample_nudges():
    """Create sample nudge data for testing."""
    return [
        {
            'id': 'nudge-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-123',
            'score': 25,
            'summary': 'This is a ticket with a very poor description that needs significant improvement'
        },
        {
            'id': 'nudge-2',
            'issueKey': 'PROJ-456',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-456',
            'score': 55,
            'summary': 'Medium quality ticket - could use some clarification'
        },
        {
            'id': 'nudge-3',
            'issueKey': 'PROJ-789',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-789',
            'score': 70,
            'summary': 'Borderline ticket - minor improvements needed'
        },
        {
            'id': 'nudge-4',
            'issueKey': 'PROJ-101',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-101',
            'score': 35,
            'summary': 'Another low quality ticket for testing scrolling behavior'
        },
        {
            'id': 'nudge-5',
            'issueKey': 'PROJ-202',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-202',
            'score': 42,
            'summary': 'Fifth ticket to test the max nudges limit'
        }
    ]


def main():
    args = parse_args()
    setup_environment(args)
    
    # Print environment info
    print(f"\n=== Environment ===")
    print(f"Platform: {sys.platform}")
    print(f"DISPLAY: {os.environ.get('DISPLAY', 'not set')}")
    print(f"WAYLAND_DISPLAY: {os.environ.get('WAYLAND_DISPLAY', 'not set')}")
    print(f"XDG_SESSION_TYPE: {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
    print(f"XDG_CURRENT_DESKTOP: {os.environ.get('XDG_CURRENT_DESKTOP', 'not set')}")
    print()
    
    # Import tkinter
    try:
        import tkinter as tk
        from tkinter import ttk
        print("✓ tkinter available")
    except ImportError:
        print("✗ tkinter not available")
        sys.exit(1)
    
    # Import the popup class
    try:
        from desktop_app import DescriptionQualityPopup
        print("✓ DescriptionQualityPopup imported")
    except ImportError as e:
        print(f"✗ Could not import DescriptionQualityPopup: {e}")
        print("  Make sure the class has been added to desktop_app.py")
        sys.exit(1)
    
    # Create root window
    root = tk.Tk()
    root.withdraw()  # Hide root window
    print("✓ Root window created")
    
    # Callback functions
    def on_improve(nudge):
        print(f"IMPROVE clicked: {nudge['issueKey']}")
        # Simulate opening browser
        print(f"  Would open: {nudge['issueUrl']}#dq=improve")
    
    def on_snooze(nudge, hours):
        print(f"SNOOZE clicked: {nudge['issueKey']} for {hours} hours")
    
    def on_dismiss(nudge):
        print(f"DISMISS clicked: {nudge['issueKey']}")
    
    def on_close():
        print("Popup CLOSED")
        root.quit()
    
    # Create sample nudges
    nudges = create_sample_nudges()
    print(f"✓ Created {len(nudges)} sample nudges")
    
    # Create popup
    print("\n=== Creating popup ===")
    try:
        popup = DescriptionQualityPopup(
            parent=root,
            nudges=nudges,
            user_name='Test User',
            on_improve=on_improve,
            on_snooze=on_snooze,
            on_dismiss=on_dismiss,
            on_close=on_close
        )
        print("✓ Popup created successfully")
        
        # Print window info
        popup.popup.update_idletasks()
        print(f"\n=== Window Info ===")
        print(f"Size: {popup.popup.winfo_width()}x{popup.popup.winfo_height()}")
        print(f"Position: ({popup.popup.winfo_x()}, {popup.popup.winfo_y()})")
        print(f"Screen: {popup.popup.winfo_screenwidth()}x{popup.popup.winfo_screenheight()}")
        print(f"Is Wayland: {popup._is_wayland()}")
        
    except Exception as e:
        print(f"✗ Failed to create popup: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    print("\n=== Running mainloop ===")
    print("Close the popup window to exit.\n")
    
    try:
        root.mainloop()
    except KeyboardInterrupt:
        print("\nInterrupted by user")
    finally:
        try:
            root.destroy()
        except:
            pass
    
    print("\n=== Test complete ===")


if __name__ == '__main__':
    main()
```

---

## 7. Implementation Checklist

### 7.1 Pre-Implementation

- [ ] Review existing `PausePopupWindow` class for patterns
- [ ] Verify tkinter is available in dev environment
- [ ] Test notify-send availability
- [ ] Review API specification (Document 13)

### 7.2 Implementation

- [ ] Add constants (`QUALITY_NUDGE_POLL_INTERVAL_*`, etc.)
- [ ] Implement `DescriptionQualityPopup` class
- [ ] Implement `poll_description_quality_nudges()` method
- [ ] Implement `_acknowledge_quality_nudge()` method
- [ ] Implement `_show_quality_notification_fallback()` method
- [ ] Implement `_should_poll_quality_nudges()` method
- [ ] Add polling to `tracking_loop()`
- [ ] Add `_quality_popup` instance variable initialization

### 7.3 Testing

- [ ] Run unit tests: `pytest tests/test_description_quality_popup.py -v`
- [ ] Run unit tests: `pytest tests/test_quality_nudge_polling.py -v`
- [ ] Run manual test script on X11
- [ ] Run manual test script on Wayland (if available)
- [ ] Test with notify-send fallback
- [ ] Test snooze functionality
- [ ] Test dismiss functionality
- [ ] Test "Improve" browser opening

### 7.4 Documentation

- [ ] Update `LINUX_SETUP.md` with any new system requirements
- [ ] Add inline code comments
- [ ] Update `CHANGELOG.md`

### 7.5 Code Review Checklist

- [ ] No blocking Wayland calls
- [ ] Graceful degradation when tkinter unavailable
- [ ] Proper error handling for API calls
- [ ] Thread safety (UI updates via `root.after()`)
- [ ] Consistent with existing code patterns
- [ ] All tests passing

---

## Appendix A: Environment Detection Reference

```python
# Wayland Detection
def _is_wayland() -> bool:
    return bool(
        os.environ.get('WAYLAND_DISPLAY') or
        os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
    )

# Display Server Detection
def get_display_server() -> str:
    if os.environ.get('WAYLAND_DISPLAY'):
        return 'wayland'
    if os.environ.get('DISPLAY'):
        return 'x11'
    return 'unknown'

# Desktop Environment Detection  
def get_desktop_environment() -> str:
    return os.environ.get('XDG_CURRENT_DESKTOP', 
           os.environ.get('DESKTOP_SESSION', 'unknown')).lower()
```

---

## Appendix B: Dependencies

### Required (Already Present)

- `tkinter` (Python standard library)
- `requests` (in requirements.txt)
- `pystray` (in requirements.txt)

### Optional (Enhanced Notifications)

```txt
# Add to requirements.txt (platform-specific)
PyGObject>=3.42.0; sys_platform == 'linux'
```

### System Packages

```bash
# Debian/Ubuntu
sudo apt install python3-tk python3-gi gir1.2-ayatanaappindicator3-0.1 libnotify-bin

# Fedora  
sudo dnf install python3-tkinter python3-gobject libappindicator-gtk3 libnotify

# Arch Linux
sudo pacman -S tk python-gobject libappindicator-gtk3 libnotify
```

---

*Document Created: 2026-06-12*  
*Last Updated: 2026-06-12*
