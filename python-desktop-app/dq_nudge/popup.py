"""Tkinter popup window for description-quality nudges (Enhancement #13)."""

import json
import logging
import threading
import tkinter as tk
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional
import customtkinter as ctk

logger = logging.getLogger(__name__)

SNOOZE_HOURS = 1

# Configure CustomTkinter default appearance
ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")
ctk.set_widget_scaling(1.0)
ctk.set_window_scaling(1.0)

MIN_WIDTH = 1000
MIN_HEIGHT = 600
DEFAULT_WIDTH = 1200
DEFAULT_HEIGHT = 800

def _score_color(score: int) -> str:
    if score < 40:
        return '#ff4d4d' # Red
    if score < 70:
        return '#f5a623' # Orange
    return '#28a745'     # Green

class DqNudgePopupWindow:
    """
    Single-shot popup using CustomTkinter. Pass `nudges` (list of dicts with at least
    {id, issueKey, score, summary, issueUrl, appUrl}) and the auth_manager
    so the popup can fire-and-forget acknowledgements via ack_client.
    """

    def __init__(
        self,
        nudges: List[dict],
        ack_callback: Callable[[List[int], str, Optional[str]], bool],
        disable_popup_callback: Optional[Callable[[], bool]] = None,
        parent_root: Optional[tk.Tk] = None,
    ):
        self.nudges = list(nudges)
        self._ack = ack_callback
        self._disable_popup = disable_popup_callback or (lambda: False)
        self._parent_root = parent_root
        self._window: Optional[ctk.CTk] = None
        self._count_label: Optional[ctk.CTkLabel] = None
        self._owns_root = False
        self._ui_thread: Optional[threading.Thread] = None

    def show(self) -> None:
        if not self.nudges:
            return
        if self._ui_thread and self._ui_thread.is_alive():
            return
        self._ui_thread = threading.Thread(target=self._run_window, daemon=True)
        self._ui_thread.start()

    def _run_window(self) -> None:
        self._window = self._create_window()
        threading.Thread(
            target=self._ack_safe,
            args=([n['id'] for n in self.nudges], 'viewed', None),
            daemon=True,
        ).start()
        self._window.mainloop()

    def _create_window(self) -> ctk.CTk:
        win = ctk.CTk()
        self._owns_root = True

        win.title('Description Quality Nudges')
        win.attributes('-topmost', True)
        win.resizable(True, True)
        win.minsize(MIN_WIDTH, MIN_HEIGHT)
        try:
            win.protocol('WM_DELETE_WINDOW', self._close_window)
        except Exception:
            pass

        win.update_idletasks()
        try:
            import ctypes
            user32 = ctypes.windll.user32
            screen_w = user32.GetSystemMetrics(0)
            screen_h = user32.GetSystemMetrics(1)
        except Exception:
            screen_w = win.winfo_screenwidth()
            screen_h = win.winfo_screenheight()

        width = min(DEFAULT_WIDTH, max(MIN_WIDTH, int(screen_w * 0.8)))
        height = min(DEFAULT_HEIGHT, max(MIN_HEIGHT, int(screen_h * 0.75)))
        
        # Calculate physical pixels for proper centering on DPI-scaled monitors
        try:
            scaling = win._get_window_scaling()
        except Exception:
            scaling = 1.0
            
        actual_width = int(width * scaling)
        actual_height = int(height * scaling)
        
        # Explicit robust centering on the primary monitor using calculated physical offsets
        x = max(0, int((screen_w / 2) - (actual_width / 2)))
        y = max(0, int((screen_h / 2) - (actual_height / 2)))
        win.geometry(f'{width}x{height}+{x}+{y}')

        win.configure(fg_color="#1d232a") # Dark background matching mock

        # Header Frame
        hdr = ctk.CTkFrame(win, corner_radius=0, fg_color="transparent")
        hdr.pack(fill='x', padx=30, pady=20)

        self._count_label = ctk.CTkLabel(
            hdr,
            text=self._count_message(),
            font=ctk.CTkFont(family='Segoe UI', size=14),
            text_color="#a6adbb"
        )
        self._count_label.pack(side="left")

        # Sort Dropdown
        sort_frame = ctk.CTkFrame(hdr, fg_color="transparent")
        sort_frame.pack(side="right")
        
        ctk.CTkLabel(
            sort_frame, 
            text="Sort by:", 
            font=ctk.CTkFont(family='Segoe UI', size=13),
            text_color="#a6adbb"
        ).pack(side="left", padx=(0, 10))

        self.sort_var = ctk.StringVar(value="Score: Low to High")
        sort_dropdown = ctk.CTkOptionMenu(
            sort_frame,
            variable=self.sort_var,
            values=["Score: Low to High", "Score: High to Low"],
            command=self._on_sort_change,
            fg_color="#2a303c",
            button_color="#2a303c",
            button_hover_color="#3b4252",
            dropdown_fg_color="#2a303c",
            dropdown_hover_color="#3b4252",
            font=ctk.CTkFont(family='Segoe UI', size=13),
            dropdown_font=ctk.CTkFont(family='Segoe UI', size=13),
            text_color="#a6adbb",
            corner_radius=6
        )
        sort_dropdown.pack(side="left")

        # Scrollable Frame for Grid
        self.scrollable_frame = ctk.CTkScrollableFrame(win, fg_color="transparent")
        self.scrollable_frame.pack(fill='both', expand=True, padx=20, pady=0)

        # Configure 3 columns
        self.scrollable_frame.grid_columnconfigure((0, 1, 2), weight=1, uniform="col")

        # Initial Sort
        self._sort_nudges("Score: Low to High")
        self._render_nudges()

        return win

    def _on_sort_change(self, value: str) -> None:
        self._sort_nudges(value)
        self._render_nudges()

    def _sort_nudges(self, sort_type: str) -> None:
        if sort_type == "Score: Low to High":
            self.nudges.sort(key=lambda n: n.get('score', 0))
        elif sort_type == "Score: High to Low":
            self.nudges.sort(key=lambda n: n.get('score', 0), reverse=True)

    def _render_nudges(self) -> None:
        for widget in self.scrollable_frame.winfo_children():
            widget.destroy()

        for idx, nudge in enumerate(self.nudges):
            row = idx // 3
            col = idx % 3
            card = self._build_nudge_card(self.scrollable_frame, nudge)
            card.grid(row=row, column=col, padx=10, pady=10, sticky="nsew")

    def _close_window(self) -> None:
        win = self._window
        if win is None:
            return
        try:
            win.quit()
            win.destroy()
        except (tk.TclError, RuntimeError):
            pass
        finally:
            self._window = None

    def _count_message(self) -> str:
        count = len(self.nudges)
        if count == 1:
            return '1 ticket needs a better description. Open it in Jira from the title.'
        return f'{count} tickets need better descriptions. Open them in Jira from each title.'

    def _parse_ai_feedback(self, nudge: dict):
        suggestions = nudge.get('suggestions')
        issues = nudge.get('issues')
        
        if not suggestions or not issues:
            for key in ['aiFeedback', 'feedback', 'result', 'data']:
                val = nudge.get(key)
                if isinstance(val, dict):
                    if not suggestions: suggestions = val.get('suggestions')
                    if not issues: issues = val.get('issues')
                elif isinstance(val, str):
                    try:
                        parsed = json.loads(val)
                        if not suggestions: suggestions = parsed.get('suggestions')
                        if not issues: issues = parsed.get('issues')
                    except Exception:
                        pass

        return issues or [], suggestions or []

    def _build_nudge_card(self, parent: ctk.CTkScrollableFrame, nudge: dict) -> ctk.CTkFrame:
        card = ctk.CTkFrame(
            parent,
            fg_color="#2a303c",
            corner_radius=12
        )

        # Header Row: Key + Radial Gauge
        top_row = ctk.CTkFrame(card, fg_color="transparent")
        top_row.pack(fill='x', padx=20, pady=(20, 10))

        # Left side: Icon + Issue Key
        key_frame = ctk.CTkFrame(top_row, fg_color="transparent")
        key_frame.pack(side='left', anchor='nw')
        
        issue_key = nudge.get('issueKey', '?')
        ctk.CTkLabel(
            key_frame, 
            text="🔷", 
            font=ctk.CTkFont(size=14)
        ).pack(side='left', padx=(0, 6))
        
        issue_link = ctk.CTkLabel(
            key_frame,
            text=issue_key,
            font=ctk.CTkFont(family='Segoe UI', size=14, weight='bold', underline=True),
            text_color="#3abff8",
            cursor="hand2"
        )
        issue_link.pack(side='left')
        issue_link.bind('<Button-1>', lambda e, n=nudge: self._on_open(n))

        # Right side: Radial Gauge & Score
        score = nudge.get('score', 0)
        gauge_color = _score_color(score)
        
        gauge_frame = ctk.CTkFrame(top_row, fg_color="transparent")
        gauge_frame.pack(side='right', anchor='ne')
        
        # Draw arc within Canvas to prevent clipping text
        canvas_width = 64
        canvas_height = 36
        canvas = tk.Canvas(gauge_frame, width=canvas_width, height=canvas_height, bg="#2a303c", highlightthickness=0)
        canvas.pack(side="top")
        
        pad = 4
        bbox = (pad, pad, canvas_width - pad, (canvas_height * 2) - pad)
        canvas.create_arc(bbox, start=0, extent=180, style="arc", outline="#3b4252", width=6)
        extent = - (score / 100.0) * 180
        canvas.create_arc(bbox, start=180, extent=extent, style="arc", outline=gauge_color, width=6)
        
        # Render text natively in CustomTkinter below the arc to avoid massive Tkinter Canvas fonts
        ctk.CTkLabel(
            gauge_frame,
            text=f"{score}/100",
            font=ctk.CTkFont(family='Segoe UI', size=14, weight='bold'),
            text_color=gauge_color
        ).pack(side="top", pady=(0, 0))

        # Title
        summary = nudge.get('summary') or 'No Title'
        ctk.CTkLabel(
            card,
            text=summary,
            font=ctk.CTkFont(family='Segoe UI', size=16, weight='bold'),
            text_color="#ffffff",
            wraplength=320,
            justify='left',
            anchor='w'
        ).pack(fill='x', padx=20, pady=(0, 8))

        # Parse Feedback
        issues, suggestions = self._parse_ai_feedback(nudge)

        # Subtitle (First issue) - Ensure we don't repeat the title
        if issues:
            first_issue = str(issues[0])
            if first_issue.strip() != summary.strip():
                ctk.CTkLabel(
                    card,
                    text=first_issue,
                    font=ctk.CTkFont(family='Segoe UI', size=13),
                    text_color="#a6adbb",
                    wraplength=320,
                    justify='left',
                    anchor='w'
                ).pack(fill='x', padx=20, pady=(0, 16))
        else:
            # Spacer if no subtitle
            ctk.CTkFrame(card, height=16, fg_color="transparent").pack()

        # Inner feedback box for Suggestions
        if suggestions:
            feedback_box = ctk.CTkFrame(card, fg_color="#333b49", corner_radius=8)
            feedback_box.pack(fill='x', padx=20, pady=(0, 20), expand=True)

            ctk.CTkLabel(
                feedback_box,
                text="💡 Suggestions for Improvement",
                font=ctk.CTkFont(family='Segoe UI', size=12, weight='bold'),
                text_color="#a6adbb",
                anchor='w'
            ).pack(fill='x', padx=16, pady=(12, 4))

            for sugg in suggestions[:2]: # Show up to 2 suggestions
                ctk.CTkLabel(
                    feedback_box,
                    text=f"• {sugg}",
                    font=ctk.CTkFont(family='Segoe UI', size=13),
                    text_color="#eef2f7",
                    wraplength=280,
                    justify='left',
                    anchor='w'
                ).pack(fill='x', padx=16, pady=(0, 8))

        # Bottom Button
        btn_frame = ctk.CTkFrame(card, fg_color="transparent")
        btn_frame.pack(fill='x', padx=20, pady=(0, 20))
        
        open_btn = ctk.CTkButton(
            btn_frame,
            text="Open Ticket in Jira",
            font=ctk.CTkFont(family='Segoe UI', size=13, weight='bold'),
            fg_color="transparent",
            border_width=1,
            border_color="#4b5563",
            text_color="#a6adbb",
            hover_color="#3b4252",
            corner_radius=6,
            command=lambda n=nudge: self._on_open(n)
        )
        open_btn.pack(side='right')

        return card

    # ------------------------------------------------------------------
    # Action handlers
    # ------------------------------------------------------------------
    def _ack_safe(self, ids: List[int], action: str, snooze_until: Optional[str]) -> None:
        try:
            self._ack(ids, action, snooze_until)
        except Exception as exc:  # noqa: BLE001
            logger.warning('[DqNudge.popup] ack failed: %s', exc)

    def _on_open(self, nudge: dict) -> None:
        url = nudge.get('issueUrl') or nudge.get('appUrl')
        if url:
            try:
                webbrowser.open(url)
            except Exception as exc:  # noqa: BLE001
                logger.warning('[DqNudge.popup] open browser failed: %s', exc)
        threading.Thread(
            target=self._ack_safe,
            args=([nudge['id']], 'opened-in-jira', None),
            daemon=True,
        ).start()

    def _on_snooze(self, nudge: dict) -> None:
        until = (datetime.now(timezone.utc) + timedelta(hours=SNOOZE_HOURS)).isoformat().replace('+00:00', 'Z')
        threading.Thread(
            target=self._ack_safe,
            args=([nudge['id']], 'snoozed', until),
            daemon=True,
        ).start()

    def _on_dismiss_one(self, nudge: dict) -> None:
        threading.Thread(
            target=self._ack_safe,
            args=([nudge['id']], 'dismissed', None),
            daemon=True,
        ).start()
        self.nudges = [n for n in self.nudges if n['id'] != nudge['id']]
        if self._count_label is not None:
            try:
                self._count_label.configure(text=self._count_message())
            except Exception:
                pass
        self._render_nudges()
        if not self.nudges:
            self._close_window()

    def _on_dismiss_all(self, win=None) -> None:
        ids = [n['id'] for n in self.nudges]
        threading.Thread(
            target=self._ack_safe,
            args=(ids, 'dismissed', None),
            daemon=True,
        ).start()
        if win and self._window is None:
            self._window = win
        self._close_window()

    def _on_dont_show(self, win=None) -> None:
        ids = [n['id'] for n in self.nudges]
        threading.Thread(
            target=self._ack_safe,
            args=(ids, 'dismissed', None),
            daemon=True,
        ).start()
        try:
            self._disable_popup()
        except Exception as exc:  # noqa: BLE001
            logger.warning('[DqNudge.popup] disable_popup failed: %s', exc)
        if win and self._window is None:
            self._window = win
        self._close_window()
