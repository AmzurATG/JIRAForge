"""
Tkinter popup window for description-quality nudges (Enhancement #13).

Modeled on the existing PausePopupWindow pattern in desktop_app.py:
- Toplevel created on the main thread
- Centred on the primary monitor (winfo_screenwidth/height)
- attributes('-topmost', True) so it floats above other apps
- We do NOT call focus_force() — that disrupts whatever the user is doing

Per-nudge actions: "Improve in Jira" (opens browser), "Snooze 1h", "Dismiss"
Global actions: "Dismiss all", "Don't show again"
"""

import logging
import threading
import tkinter as tk
import webbrowser
from datetime import datetime, timedelta, timezone
from tkinter import ttk
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

SNOOZE_HOURS = 1


class DqNudgePopupWindow:
    """
    Single-shot popup. Pass `nudges` (list of dicts with at least
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
        self._window: Optional[tk.Toplevel] = None

    # ------------------------------------------------------------------
    def show(self) -> None:
        """
        Build and show the popup on the current (must be main) thread.
        Marks all nudges as `viewed` on close.
        """
        if not self.nudges:
            return

        self._window = self._create_window()
        # Best-effort: mark all as viewed immediately so the server stops
        # surfacing them in subsequent polls.
        threading.Thread(
            target=self._ack_safe,
            args=([n['id'] for n in self.nudges], 'viewed', None),
            daemon=True,
        ).start()

    # ------------------------------------------------------------------
    def _create_window(self) -> tk.Toplevel:
        root = self._parent_root or tk._default_root  # type: ignore[attr-defined]
        if root is None:
            # Test / headless safety — caller should have a Tk instance.
            root = tk.Tk()
            root.withdraw()

        win = tk.Toplevel(root)
        win.title('Improve ticket description')
        win.attributes('-topmost', True)
        win.resizable(False, False)

        # Centre on primary monitor (matches PausePopupWindow pattern).
        width, height = 480, 60 + 110 * min(len(self.nudges), 5) + 60
        screen_w = win.winfo_screenwidth()
        screen_h = win.winfo_screenheight()
        x = (screen_w - width) // 2
        y = (screen_h - height) // 2
        win.geometry(f'{width}x{height}+{x}+{y}')

        # Header
        header = ttk.Label(
            win,
            text='These tickets could use a better description',
            font=('Segoe UI', 11, 'bold'),
        )
        header.pack(pady=(10, 6), padx=12, anchor='w')

        # Per-nudge rows
        body = ttk.Frame(win)
        body.pack(fill='both', expand=True, padx=12)
        for nudge in self.nudges[:5]:
            self._build_nudge_row(body, nudge)

        # Footer
        footer = ttk.Frame(win)
        footer.pack(fill='x', padx=12, pady=(6, 10))
        ttk.Button(footer, text='Dismiss all', command=lambda: self._on_dismiss_all(win)).pack(side='right')
        ttk.Button(footer, text="Don't show again", command=lambda: self._on_dont_show(win)).pack(side='right', padx=(0, 6))
        return win

    def _build_nudge_row(self, parent: ttk.Frame, nudge: dict) -> None:
        row = ttk.Frame(parent)
        row.pack(fill='x', pady=4)

        title = f"[{nudge.get('issueKey', '?')}] {nudge.get('summary') or ''}"
        ttk.Label(row, text=title, wraplength=440, anchor='w').pack(anchor='w')
        score = nudge.get('score')
        if isinstance(score, (int, float)):
            ttk.Label(row, text=f'Quality score: {int(score)}/100', foreground='#a00').pack(anchor='w')

        buttons = ttk.Frame(row)
        buttons.pack(fill='x', pady=(2, 0))

        ttk.Button(
            buttons,
            text='Improve in Jira →',
            command=lambda n=nudge: self._on_open(n),
        ).pack(side='left')

        ttk.Button(
            buttons,
            text=f'Snooze {SNOOZE_HOURS}h',
            command=lambda n=nudge: self._on_snooze(n),
        ).pack(side='left', padx=(6, 0))

        ttk.Button(
            buttons,
            text='Dismiss',
            command=lambda n=nudge: self._on_dismiss_one(n),
        ).pack(side='left', padx=(6, 0))

    # ------------------------------------------------------------------
    # Action handlers
    # ------------------------------------------------------------------
    def _ack_safe(self, ids: List[int], action: str, snooze_until: Optional[str]) -> None:
        try:
            self._ack(ids, action, snooze_until)
        except Exception as exc:  # noqa: BLE001 — best-effort ack
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

    def _on_dismiss_all(self, win: tk.Toplevel) -> None:
        ids = [n['id'] for n in self.nudges]
        threading.Thread(
            target=self._ack_safe,
            args=(ids, 'dismissed', None),
            daemon=True,
        ).start()
        try:
            win.destroy()
        except tk.TclError:
            pass

    def _on_dont_show(self, win: tk.Toplevel) -> None:
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
        try:
            win.destroy()
        except tk.TclError:
            pass
