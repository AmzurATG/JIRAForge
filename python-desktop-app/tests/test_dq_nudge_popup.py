"""Tests for dq_nudge.popup — verifies button wiring and ack dispatch.

We avoid actually rendering a Tk window in CI by mocking tk.Toplevel and
related primitives. Behavioural assertions focus on which ack actions are
committed in response to each user gesture.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from dq_nudge.popup import DqNudgePopupWindow  # noqa: E402
import tkinter as tk


@pytest.fixture
def sample_nudges():
    return [
        {'id': 1, 'issueKey': 'X-1', 'score': 30, 'summary': 'Fix login', 'issueUrl': 'https://j/X-1', 'appUrl': '#m'},
        {'id': 2, 'issueKey': 'X-2', 'score': 55, 'summary': 'Y', 'issueUrl': 'https://j/X-2', 'appUrl': '#m'},
    ]


def _patch_tk():
    """Patch tkinter primitives used by DqNudgePopupWindow._create_window."""
    return patch.multiple(
        'dq_nudge.popup',
        tk=MagicMock(),
        webbrowser=MagicMock(),
    )


# ---------------------------------------------------------------------------
# show() — early-return guard
# ---------------------------------------------------------------------------
def test_show_noop_when_no_nudges():
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow([], ack)
    with _patch_tk():
        popup.show()
    ack.assert_not_called()


def test_create_window_centers_and_sets_minimum_size(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)

    fake_tk = MagicMock()
    with patch.multiple('dq_nudge.popup', tk=fake_tk, webbrowser=MagicMock()):
        fake_win = MagicMock()
        fake_win.winfo_screenwidth.return_value = 1920
        fake_win.winfo_screenheight.return_value = 1080
        fake_tk.Tk.return_value = fake_win
        popup._create_window()

    fake_win.minsize.assert_called_once()
    min_w, min_h = fake_win.minsize.call_args.args
    assert min_w >= 760
    assert min_h >= 320

    fake_win.geometry.assert_called_once()
    geometry = fake_win.geometry.call_args.args[0]
    assert geometry.startswith('860x440+')
    assert geometry.endswith('+320')


# ---------------------------------------------------------------------------
# show() — starts popup UI thread
# ---------------------------------------------------------------------------
def test_show_starts_ui_thread(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    with _patch_tk():
        with patch('dq_nudge.popup.threading.Thread') as thread_cls:
            instance = MagicMock()
            thread_cls.return_value = instance
            popup.show()
            thread_cls.assert_called_once()
            kwargs = thread_cls.call_args.kwargs
            assert kwargs['target'] == popup._run_window


def test_layout_action_buttons_stacks_on_small_width(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)

    btn_row = MagicMock()
    btn_row.winfo_width.return_value = 300

    open_btn = MagicMock()
    snooze_btn = MagicMock()
    dismiss_btn = MagicMock()

    popup._layout_action_buttons(btn_row, open_btn, snooze_btn, dismiss_btn)

    open_btn.pack.assert_called_with(side='top', fill='x', pady=(0, 6))
    snooze_btn.pack.assert_called_with(side='top', fill='x', pady=(0, 6))
    dismiss_btn.pack.assert_called_with(side='top', fill='x')


# ---------------------------------------------------------------------------
# _run_window() — fires "viewed" ack with all nudge ids and enters mainloop
# ---------------------------------------------------------------------------
def test_run_window_acks_viewed_with_all_ids(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    fake_window = MagicMock()
    fake_window.master = fake_window
    popup._create_window = MagicMock(return_value=fake_window)

    with patch('dq_nudge.popup.threading.Thread') as thread_cls:
        popup._run_window()
        thread_cls.assert_called_once()
        kwargs = thread_cls.call_args.kwargs
        assert kwargs['args'] == ([1, 2], 'viewed', None)
        fake_window.mainloop.assert_called_once()


# ---------------------------------------------------------------------------
# _on_open
# ---------------------------------------------------------------------------
def test_on_open_opens_url_and_acks_opened(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    with patch('dq_nudge.popup.webbrowser.open') as wb:
        with patch('dq_nudge.popup.threading.Thread') as thread_cls:
            popup._on_open(sample_nudges[0])
            wb.assert_called_once_with('https://j/X-1')
            kwargs = thread_cls.call_args.kwargs
            assert kwargs['args'] == ([1], 'opened-in-jira', None)


# ---------------------------------------------------------------------------
# _on_dismiss_one / _on_dismiss_all
# ---------------------------------------------------------------------------
def test_on_dismiss_one(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    with patch('dq_nudge.popup.threading.Thread') as thread_cls:
        popup._on_dismiss_one(sample_nudges[1])
        assert thread_cls.call_args.kwargs['args'] == ([2], 'dismissed', None)


def test_on_dismiss_all_acks_every_id_and_destroys_window(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    fake_win = MagicMock()
    with patch('dq_nudge.popup.threading.Thread') as thread_cls:
        popup._on_dismiss_all(fake_win)
        assert thread_cls.call_args.kwargs['args'] == ([1, 2], 'dismissed', None)
    fake_win.destroy.assert_called_once()


# ---------------------------------------------------------------------------
# _on_dont_show
# ---------------------------------------------------------------------------
def test_on_dont_show_calls_disable_callback_and_dismisses(sample_nudges):
    ack = MagicMock(return_value=True)
    disable = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack, disable_popup_callback=disable)
    fake_win = MagicMock()
    with patch('dq_nudge.popup.threading.Thread'):
        popup._on_dont_show(fake_win)
    disable.assert_called_once()
    fake_win.destroy.assert_called_once()
