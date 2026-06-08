"""Tkinter popup window for description-quality nudges (Enhancement #13)."""

import logging
import threading
import tkinter as tk
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

SNOOZE_HOURS = 1

# Color palette and sizing tuned for readability and lower visual noise.
BG = '#171a1f'
SURFACE = '#1f242c'
SURFACE_ALT = '#262d38'
BORDER = '#313a47'
HEADER_BG = '#141820'
PRIMARY = '#3f8cff'
PRIMARY_HOVER = '#5a9dff'
DANGER = '#e66b6b'
DANGER_HOVER = '#f07e7e'
TXT_PRI = '#eef2f7'
TXT_SEC = '#9ca8ba'
TXT_MUTED = '#8693a9'

MIN_WIDTH = 760
MIN_HEIGHT = 460
DEFAULT_WIDTH = 960
DEFAULT_HEIGHT = 620
CARD_PAD = 16


def _score_color(score: int) -> str:
    if score < 40:
        return '#ef6d6d'
    if score < 70:
        return '#e3bc62'
    return '#68bf8a'


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
        self._window: Optional[tk.Tk] = None
        self._owns_root = False
        self._ui_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    def show(self) -> None:
        """Build and show the popup on a dedicated Tk thread."""
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
        # Always own the root — we created a fresh tk.Tk() in this thread.
        self._window.mainloop()

    # ------------------------------------------------------------------
    def _create_window(self) -> tk.Tk:
        # Always create a brand-new Tk interpreter in this thread.
        # Using tk._default_root / Toplevel from a background thread causes
        # "main thread is not in main loop" when pystray owns the real main thread.
        win = tk.Tk()
        self._owns_root = True

        win.title('Description Quality Nudges')
        win.configure(bg=BG)
        win.attributes('-topmost', True)
        win.resizable(True, True)
        win.minsize(MIN_WIDTH, MIN_HEIGHT)
        try:
            win.protocol('WM_DELETE_WINDOW', self._close_window)
        except Exception:
            pass

        screen_w = win.winfo_screenwidth()
        screen_h = win.winfo_screenheight()
        width = min(DEFAULT_WIDTH, max(MIN_WIDTH, int(screen_w * 0.8)))
        height = min(DEFAULT_HEIGHT, max(MIN_HEIGHT, int(screen_h * 0.75)))
        x = max(0, (screen_w - width) // 2)
        y = max(0, (screen_h - height) // 2)
        win.geometry(f'{width}x{height}+{x}+{y}')

        # ── Header ──────────────────────────────────────────────────────
        hdr = tk.Frame(win, bg=HEADER_BG, pady=0)
        hdr.pack(fill='x')

        tk.Label(
            hdr, text='🔔  Description Quality Nudges',
            font=('Segoe UI', 14, 'bold'),
            bg=HEADER_BG, fg=TXT_PRI, padx=18, pady=12,
        ).pack(side='left')

        count_text = f'{len(self.nudges)} ticket{"s" if len(self.nudges) != 1 else ""}'
        tk.Label(
            hdr, text=count_text,
            font=('Segoe UI', 11),
            bg=HEADER_BG, fg=TXT_MUTED, padx=6, pady=12,
        ).pack(side='left')

        tk.Button(
            hdr, text='✕', font=('Segoe UI', 13),
            bg=HEADER_BG, fg=TXT_MUTED, bd=0, activebackground=HEADER_BG,
            activeforeground=DANGER, cursor='hand2',
            command=self._close_window, padx=14, pady=10,
        ).pack(side='right')

        # sub-header hint
        tk.Label(
            win,
            text='These tickets need a better description. Improve them in Jira now.',
            font=('Segoe UI', 10),
            bg=BG, fg=TXT_SEC, padx=18, pady=8, anchor='w',
        ).pack(fill='x')

        # separator
        tk.Frame(win, bg=BORDER, height=1).pack(fill='x', pady=(4, 0))

        # ── Scrollable nudge list ────────────────────────────────────────
        wrapper = tk.Frame(win, bg=BG)
        wrapper.pack(fill='both', expand=True, padx=14, pady=(10, 0))
        wrapper.grid_rowconfigure(0, weight=1)
        wrapper.grid_columnconfigure(0, weight=1)

        canvas = tk.Canvas(wrapper, bg=BG, bd=0, highlightthickness=0)
        canvas.grid(row=0, column=0, sticky='nsew')

        scrollbar = tk.Scrollbar(wrapper, orient='vertical', command=canvas.yview)
        scrollbar.grid(row=0, column=1, sticky='ns')
        canvas.configure(yscrollcommand=scrollbar.set)

        inner = tk.Frame(canvas, bg=BG)
        canvas_win_id = canvas.create_window((0, 0), window=inner, anchor='nw')

        def _on_inner_configure(event):
            canvas.configure(scrollregion=canvas.bbox('all'))

        def _on_canvas_configure(event):
            canvas.itemconfig(canvas_win_id, width=event.width)

        inner.bind('<Configure>', _on_inner_configure)
        canvas.bind('<Configure>', _on_canvas_configure)

        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), 'units')

        canvas.bind_all('<MouseWheel>', _on_mousewheel)

        for idx, nudge in enumerate(self.nudges):
            self._build_nudge_card(inner, nudge, is_last=(idx == len(self.nudges) - 1))

        # ── Footer ──────────────────────────────────────────────────────
        tk.Frame(win, bg=BORDER, height=1).pack(fill='x', pady=(8, 0))

        footer = tk.Frame(win, bg=HEADER_BG, pady=10, padx=14)
        footer.pack(fill='x')

        self._make_button(
            footer, "Don't show again",
            lambda: self._on_dont_show(win),
            variant='ghost',
        ).pack(side='left')

        self._make_button(
            footer, 'Dismiss all',
            lambda: self._on_dismiss_all(win),
            variant='danger-ghost',
        ).pack(side='right')

        return win

    # ------------------------------------------------------------------
    def _close_window(self) -> None:
        win = self._window
        if win is None:
            return
        try:
            win.quit()   # stops mainloop
            win.destroy()
        except (tk.TclError, RuntimeError):
            pass
        finally:
            self._window = None

    # ------------------------------------------------------------------
    @staticmethod
    def _make_button(parent, text, cmd, variant='primary', padx=14, pady=7):
        if variant == 'primary':
            bg = PRIMARY
            hover_bg = PRIMARY_HOVER
            fg = '#ffffff'
            bd = 0
            relief = 'flat'
            active_fg = '#ffffff'
        elif variant == 'danger-ghost':
            bg = SURFACE
            hover_bg = '#3a2a2a'
            fg = DANGER
            bd = 1
            relief = 'solid'
            active_fg = '#ffd9d9'
        else:
            bg = SURFACE
            hover_bg = '#2b323e'
            fg = TXT_SEC
            bd = 1
            relief = 'solid'
            active_fg = TXT_PRI

        btn = tk.Button(
            parent, text=text, font=('Segoe UI', 9, 'bold'),
            bg=bg, fg=fg, bd=bd, relief=relief, cursor='hand2',
            activebackground=hover_bg, activeforeground=active_fg,
            highlightthickness=0,
            padx=padx, pady=pady, command=cmd,
        )
        btn.bind('<Enter>', lambda e: btn.config(bg=hover_bg))
        btn.bind('<Leave>', lambda e: btn.config(bg=bg))
        return btn

    @staticmethod
    def _layout_action_buttons(btn_row, open_btn, snooze_btn, dismiss_btn) -> None:
        for btn in (open_btn, snooze_btn, dismiss_btn):
            try:
                btn.pack_forget()
            except Exception:
                pass

        try:
            row_width = int(btn_row.winfo_width())
        except Exception:
            row_width = 0

        if row_width < 560:
            open_btn.pack(side='top', fill='x', pady=(0, 6))
            snooze_btn.pack(side='top', fill='x', pady=(0, 6))
            dismiss_btn.pack(side='top', fill='x')
            return

        open_btn.pack(side='left')
        snooze_btn.pack(side='left', padx=(10, 0))
        dismiss_btn.pack(side='right')

    def _build_nudge_card(self, parent: tk.Frame, nudge: dict, is_last: bool) -> None:
        card = tk.Frame(parent, bg=SURFACE_ALT, padx=CARD_PAD, pady=CARD_PAD)
        card.pack(fill='x', padx=2, pady=(0, 10 if is_last else 0))

        # top row: issue key badge + score badge
        top_row = tk.Frame(card, bg=SURFACE_ALT)
        top_row.pack(fill='x')

        issue_key = nudge.get('issueKey', '?')
        tk.Label(
            top_row,
            text=f'  {issue_key}  ',
            font=('Segoe UI', 10, 'bold'),
            bg='#303a4d', fg='#b7c9e8',
            padx=4, pady=2,
        ).pack(side='left')

        score = nudge.get('score')
        if isinstance(score, (int, float)):
            sc = int(score)
            bar_color = _score_color(sc)
            score_wrap = tk.Frame(top_row, bg=SURFACE_ALT)
            score_wrap.pack(side='right')
            tk.Label(
                score_wrap,
                text=f'{sc}/100',
                font=('Segoe UI', 10),
                bg=SURFACE_ALT,
                fg=bar_color,
                anchor='e',
            ).pack(anchor='e')
            progress = tk.Canvas(
                score_wrap,
                width=170,
                height=10,
                bg=SURFACE_ALT,
                bd=0,
                highlightthickness=0,
            )
            progress.pack(anchor='e', pady=(3, 0))
            progress.create_rectangle(0, 0, 170, 10, fill='#1a1f27', outline='')
            progress.create_rectangle(0, 0, int((max(0, min(sc, 100)) / 100) * 170), 10, fill=bar_color, outline='')

        # summary
        summary = nudge.get('summary') or ''
        if summary:
            summary_label = tk.Label(
                card,
                text=summary,
                font=('Segoe UI', 10),
                bg=SURFACE_ALT,
                fg=TXT_PRI,
                wraplength=620,
                justify='left',
                anchor='w',
            )
            summary_label.pack(fill='x', pady=(10, 0))

            def _update_wrap(event):
                summary_label.configure(wraplength=max(280, event.width - 24))

            card.bind('<Configure>', _update_wrap)

        # action buttons
        btn_row = tk.Frame(card, bg=SURFACE_ALT, pady=10)
        btn_row.pack(fill='x')

        open_btn = self._make_button(
            btn_row,
            'Open in Jira',
            lambda n=nudge: self._on_open(n),
            variant='primary',
        )

        snooze_btn = self._make_button(
            btn_row,
            f'Snooze {SNOOZE_HOURS}h',
            lambda n=nudge: self._on_snooze(n),
            variant='ghost',
        )

        dismiss_btn = self._make_button(
            btn_row,
            'Dismiss',
            lambda n=nudge: self._on_dismiss_one(n),
            variant='danger-ghost',
        )

        self._layout_action_buttons(btn_row, open_btn, snooze_btn, dismiss_btn)
        btn_row.bind(
            '<Configure>',
            lambda event, row=btn_row, o=open_btn, s=snooze_btn, d=dismiss_btn: self._layout_action_buttons(row, o, s, d),
        )

        if not is_last:
            tk.Frame(parent, bg=BORDER, height=1).pack(fill='x', padx=2, pady=(0, 10))

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
        # Remove from local nudge list; close if last one
        self.nudges = [n for n in self.nudges if n['id'] != nudge['id']]
        if not self.nudges:
            self._close_window()

    def _on_dismiss_all(self, win: tk.Toplevel) -> None:
        ids = [n['id'] for n in self.nudges]
        threading.Thread(
            target=self._ack_safe,
            args=(ids, 'dismissed', None),
            daemon=True,
        ).start()
        if self._window is None:
            self._window = win
        self._close_window()

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
        if self._window is None:
            self._window = win
        self._close_window()
