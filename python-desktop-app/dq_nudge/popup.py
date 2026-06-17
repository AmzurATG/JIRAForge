"""Tkinter popup window for description-quality nudges (Enhancement #13)."""

import logging
import threading
import tkinter as tk
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)

SNOOZE_HOURS = 1

# Color palette and sizing tuned for readability and low visual noise.
BG = '#171a1f'
SURFACE = '#1f242c'
SURFACE_ALT = '#262d38'
SURFACE_HOVER = '#2b3340'
BORDER = '#313a47'
HEADER_BG = '#141820'
PRIMARY = '#3f8cff'
PRIMARY_HOVER = '#5a9dff'
DANGER = '#e66b6b'
DANGER_HOVER = '#f07e7e'
LINK = '#dbe7ff'
LINK_HOVER = '#5a9dff'
TXT_PRI = '#eef2f7'
TXT_SEC = '#9ca8ba'
TXT_MUTED = '#8693a9'

MIN_WIDTH = 760
MIN_HEIGHT = 320
DEFAULT_WIDTH = 860
DEFAULT_HEIGHT = 440
CARD_PAD = 16


def _score_color(score: int) -> str:
    if score < 40:
        return '#ff8585'
    if score < 70:
        return '#f1cc6d'
    return '#7bd99d'


def _score_badge_bg(score: int) -> str:
    if score < 40:
        return '#3a2428'
    if score < 70:
        return '#38311f'
    return '#203329'


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
        self._count_label: Optional[tk.Label] = None
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
        # Always own the root because this thread creates a fresh Tk instance.
        self._window.mainloop()

    # ------------------------------------------------------------------
    def _create_window(self) -> tk.Tk:
        # Using tk._default_root / Toplevel from this background thread can
        # fail when pystray owns the real main thread, so create a fresh root.
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

        # Keep the OS title bar as the named window header. This in-app strip
        # only carries the nudge summary so the title is not repeated.
        hdr = tk.Frame(win, bg=HEADER_BG, pady=0)
        hdr.pack(fill='x')

        self._count_label = tk.Label(
            hdr,
            text=self._count_message(),
            font=('Segoe UI', 10),
            bg=HEADER_BG,
            fg=TXT_SEC,
            padx=18,
            pady=12,
            anchor='w',
        )
        self._count_label.pack(fill='x')

        last_hdr_width = None
        def _update_count_wrap(event):
            nonlocal last_hdr_width
            if event.widget != hdr:
                return
            if event.width == last_hdr_width:
                return
            last_hdr_width = event.width
            self._count_label.configure(wraplength=max(200, event.width - 36))
        hdr.bind('<Configure>', _update_count_wrap)

        tk.Frame(win, bg=BORDER, height=1).pack(fill='x')

        wrapper = tk.Frame(win, bg=BG)
        wrapper.pack(fill='both', expand=True, padx=14, pady=(12, 12))
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

        return win

    # ------------------------------------------------------------------
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
            parent,
            text=text,
            font=('Segoe UI', 9, 'bold'),
            bg=bg,
            fg=fg,
            bd=bd,
            relief=relief,
            cursor='hand2',
            activebackground=hover_bg,
            activeforeground=active_fg,
            highlightthickness=0,
            padx=padx,
            pady=pady,
            command=cmd,
        )
        btn.bind('<Enter>', lambda e: btn.config(bg=hover_bg))
        btn.bind('<Leave>', lambda e: btn.config(bg=bg))
        return btn

    def _count_message(self) -> str:
        count = len(self.nudges)
        if count == 1:
            return '1 ticket needs a better description. Open it in Jira from the title.'
        return f'{count} tickets need better descriptions. Open them in Jira from each title.'

    @staticmethod
    def _pointer_inside(widget: tk.Widget) -> bool:
        try:
            x = widget.winfo_pointerx()
            y = widget.winfo_pointery()
            left = widget.winfo_rootx()
            top = widget.winfo_rooty()
            return left <= x <= left + widget.winfo_width() and top <= y <= top + widget.winfo_height()
        except Exception:
            return False

    @staticmethod
    def _bind_tree(widget: tk.Widget, sequence: str, callback) -> None:
        try:
            widget.bind(sequence, callback, add='+')
            for child in widget.winfo_children():
                DqNudgePopupWindow._bind_tree(child, sequence, callback)
        except Exception:
            pass

    @staticmethod
    def _layout_action_buttons(btn_row, open_btn, snooze_btn, dismiss_btn) -> None:
        """Legacy helper retained for tests and old callers."""
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
        group = tk.Frame(parent, bg=BG)
        group.pack(fill='x', padx=2, pady=(0, 10 if is_last else 0))

        card = tk.Frame(
            group,
            bg=SURFACE_ALT,
            padx=CARD_PAD,
            pady=CARD_PAD,
            highlightthickness=1,
            highlightbackground=BORDER,
            highlightcolor=BORDER,
        )
        card.pack(fill='x')

        top_row = tk.Frame(card, bg=SURFACE_ALT)
        top_row.pack(fill='x')

        meta_row = tk.Frame(top_row, bg=SURFACE_ALT)
        meta_row.pack(side='left', fill='x', expand=True)

        issue_key = nudge.get('issueKey', '?')
        issue_label = tk.Label(
            meta_row,
            text=issue_key,
            font=('Segoe UI', 10, 'bold'),
            bg=SURFACE_ALT,
            fg=TXT_PRI,
        )
        issue_label.pack(side='left')

        score = nudge.get('score')
        if isinstance(score, (int, float)):
            sc = int(score)
            tk.Label(
                meta_row,
                text=f'{sc}/100',
                font=('Segoe UI', 9, 'bold'),
                bg=_score_badge_bg(sc),
                fg=_score_color(sc),
                padx=8,
                pady=2,
            ).pack(side='left', padx=(10, 0))

        right_actions = tk.Frame(top_row, bg=SURFACE_ALT)
        right_actions.pack(side='right')

        dismiss_btn = tk.Button(
            right_actions,
            text='x',
            font=('Segoe UI', 10, 'bold'),
            bg=SURFACE_ALT,
            fg=TXT_MUTED,
            bd=0,
            relief='flat',
            activebackground=SURFACE_ALT,
            activeforeground=DANGER_HOVER,
            cursor='hand2',
            highlightthickness=0,
            padx=8,
            pady=0,
            command=lambda n=nudge, g=group: self._on_dismiss_one(n, g),
        )
        dismiss_btn.pack(side='right')
        dismiss_btn.bind('<Enter>', lambda e: dismiss_btn.config(fg=DANGER_HOVER))
        dismiss_btn.bind('<Leave>', lambda e: dismiss_btn.config(fg=TXT_MUTED))

        hover_bg_widgets = [top_row, meta_row, right_actions, issue_label]

        summary = nudge.get('summary') or ''
        if summary:
            summary_label = tk.Label(
                card,
                text=summary,
                font=('Segoe UI', 10),
                bg=SURFACE_ALT,
                fg=LINK,
                wraplength=620,
                justify='left',
                anchor='w',
                cursor='hand2',
            )
            summary_label.pack(fill='x', pady=(8, 0))
            hover_bg_widgets.append(summary_label)
            summary_label.bind('<Button-1>', lambda e, n=nudge: self._on_open(n))
            summary_label.bind(
                '<Enter>',
                lambda e, lbl=summary_label: lbl.config(fg=LINK_HOVER, font=('Segoe UI', 10, 'underline')),
            )
            summary_label.bind(
                '<Leave>',
                lambda e, lbl=summary_label: lbl.config(fg=LINK, font=('Segoe UI', 10)),
            )

            last_card_width = None
            def _update_wrap(event):
                nonlocal last_card_width
                if event.widget != card:
                    return
                if event.width == last_card_width:
                    return
                last_card_width = event.width
                summary_label.configure(wraplength=max(280, event.width - 24))

            card.bind('<Configure>', _update_wrap)

        def _show_card_actions(_event=None):
            try:
                card.config(bg=SURFACE_HOVER, highlightbackground=PRIMARY, highlightcolor=PRIMARY)
                for widget in hover_bg_widgets:
                    widget.config(bg=SURFACE_HOVER)
                dismiss_btn.config(bg=SURFACE_HOVER, activebackground=SURFACE_HOVER)
            except Exception:
                pass

        def _hide_card_actions(_event=None):
            if self._pointer_inside(card):
                return
            try:
                card.config(bg=SURFACE_ALT, highlightbackground=BORDER, highlightcolor=BORDER)
                for widget in hover_bg_widgets:
                    widget.config(bg=SURFACE_ALT)
                dismiss_btn.config(bg=SURFACE_ALT, activebackground=SURFACE_ALT)
            except Exception:
                pass

        self._bind_tree(card, '<Enter>', _show_card_actions)
        self._bind_tree(card, '<Leave>', _hide_card_actions)

        if not is_last:
            tk.Frame(group, bg=BORDER, height=1).pack(fill='x', pady=(10, 0))

    # ------------------------------------------------------------------
    # Action handlers
    # ------------------------------------------------------------------
    def _ack_safe(self, ids: List[int], action: str, snooze_until: Optional[str]) -> None:
        try:
            self._ack(ids, action, snooze_until)
        except Exception as exc:  # noqa: BLE001 - best-effort ack
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

    def _on_dismiss_one(self, nudge: dict, card_group: Optional[tk.Widget] = None) -> None:
        threading.Thread(
            target=self._ack_safe,
            args=([nudge['id']], 'dismissed', None),
            daemon=True,
        ).start()
        self.nudges = [n for n in self.nudges if n['id'] != nudge['id']]
        if self._count_label is not None:
            try:
                self._count_label.config(text=self._count_message())
            except Exception:
                pass
        if card_group is not None:
            try:
                card_group.destroy()
            except Exception:
                pass
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
