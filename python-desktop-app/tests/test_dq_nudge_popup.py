"""Tests for dq_nudge.popup — verifies button wiring and ack dispatch.

We avoid actually rendering a Tk window in CI by mocking tk.Toplevel and
related primitives. Behavioural assertions focus on which ack actions are
emitted in response to each user gesture.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from dq_nudge.popup import DqNudgePopupWindow  # noqa: E402


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
        ttk=MagicMock(),
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


# ---------------------------------------------------------------------------
# show() — fires "viewed" ack with all nudge ids
# ---------------------------------------------------------------------------
def test_show_acks_viewed_with_all_ids(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    with _patch_tk():
        with patch('dq_nudge.popup.threading.Thread') as thread_cls:
            instance = MagicMock()
            thread_cls.return_value = instance
            popup.show()
            # First thread fired is the viewed-ack thread
            thread_cls.assert_called()
            kwargs = thread_cls.call_args_list[0].kwargs
            assert kwargs['args'] == ([1, 2], 'viewed', None)


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
# _on_snooze
# ---------------------------------------------------------------------------
def test_on_snooze_sends_future_timestamp(sample_nudges):
    ack = MagicMock(return_value=True)
    popup = DqNudgePopupWindow(sample_nudges, ack)
    with patch('dq_nudge.popup.threading.Thread') as thread_cls:
        popup._on_snooze(sample_nudges[0])
        ids, action, until = thread_cls.call_args.kwargs['args']
        assert ids == [1]
        assert action == 'snoozed'
        assert until and until.endswith('Z')


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
