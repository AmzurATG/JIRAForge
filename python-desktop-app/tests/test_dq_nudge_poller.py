"""Tests for dq_nudge.poller and dq_nudge.ack_client."""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from dq_nudge.poller import (  # noqa: E402
    DqNudgePoller,
    FOREGROUND_POLL_INTERVAL,
    IDLE_POLL_INTERVAL,
    DEFAULT_IDLE_THRESHOLD,
)
from dq_nudge.ack_client import acknowledge_nudges  # noqa: E402
from dq_nudge.preferences import DqNudgePreferences  # noqa: E402


class FakeAuthManager:
    def __init__(self, token='abc', ai_server_url='https://forgesync.amzur.com'):
        self._token = token
        self.ai_server_url = ai_server_url

    def get_supabase_token(self):
        return self._token


# ---------------------------------------------------------------------------
# poll_once
# ---------------------------------------------------------------------------
def test_poll_once_returns_nudges_on_200():
    fake_response = MagicMock(status_code=200)
    fake_response.json.return_value = {
        'success': True,
        'nudges': [
            {'id': 1, 'issueKey': 'X-1', 'score': 30, 'summary': 'a', 'issueUrl': 'u', 'appUrl': 'a'}
        ],
    }
    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None)
    with patch('dq_nudge.poller.requests.get', return_value=fake_response) as get:
        result = poller.poll_once()
    assert len(result) == 1
    assert result[0]['issueKey'] == 'X-1'
    # Verify Authorization header was sent.
    _, kwargs = get.call_args
    assert kwargs['headers']['Authorization'] == 'Bearer abc'


def test_poll_once_returns_empty_on_non_2xx():
    fake_response = MagicMock(status_code=500, text='boom')
    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None)
    with patch('dq_nudge.poller.requests.get', return_value=fake_response):
        result = poller.poll_once()
    assert result == []


def test_poll_once_returns_empty_when_no_token():
    poller = DqNudgePoller(FakeAuthManager(token=None), on_nudges=lambda n: None)
    with patch('dq_nudge.poller.requests.get') as get:
        result = poller.poll_once()
    assert result == []
    get.assert_not_called()


def test_poll_once_returns_empty_when_popup_disabled():
    prefs = MagicMock(popup_enabled=False)
    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None, preferences=prefs)
    with patch('dq_nudge.poller.requests.get') as get:
        result = poller.poll_once()
    assert result == []
    get.assert_not_called()


def test_poll_once_swallows_request_exception():
    import requests as _req
    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None)
    with patch('dq_nudge.poller.requests.get', side_effect=_req.ConnectionError('down')):
        result = poller.poll_once()
    assert result == []


def test_trigger_generation_returns_generated_count_on_success():
    fake_response = MagicMock(status_code=200)
    fake_response.json.return_value = {
        'success': True,
        'generated': 2,
        'candidates': 3,
        'reason': None,
        'skippedCooldown': 0
    }
    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None)

    with patch('dq_nudge.poller.requests.post', return_value=fake_response) as post:
        result = poller.trigger_generation(limit=5, force=True)

    assert result == {
        'success': True,
        'generated': 2,
        'candidates': 3,
        'reason': None,
        'skippedCooldown': 0
    }
    _, kwargs = post.call_args
    assert kwargs['headers']['Authorization'] == 'Bearer abc'


def test_trigger_generation_returns_failure_without_token():
    poller = DqNudgePoller(FakeAuthManager(token=None), on_nudges=lambda n: None)
    with patch('dq_nudge.poller.requests.post') as post:
        result = poller.trigger_generation()
    assert result['success'] is False
    post.assert_not_called()


def test_poller_prefers_auth_manager_ai_server_url_over_placeholder_env(monkeypatch):
    monkeypatch.setenv('AI_SERVER_URL', 'http://your-ai-server-url:3001')
    auth = FakeAuthManager(token='abc', ai_server_url='https://good-server.example')
    poller = DqNudgePoller(auth, on_nudges=lambda n: None)

    fake_response = MagicMock(status_code=200)
    fake_response.json.return_value = {'success': True, 'nudges': []}
    with patch('dq_nudge.poller.requests.get', return_value=fake_response) as get:
        poller.poll_once()

    assert get.call_args.args[0].startswith('https://good-server.example')


def test_preferences_prefers_auth_manager_ai_server_url_over_placeholder_env(monkeypatch):
    monkeypatch.setenv('AI_SERVER_URL', 'http://your-ai-server-url:3001')
    auth = FakeAuthManager(token='abc', ai_server_url='https://good-server.example')
    prefs = DqNudgePreferences(auth)

    fake_response = MagicMock(status_code=200)
    fake_response.json.return_value = {'preferences': {'bellEnabled': True, 'popupEnabled': True}}
    with patch('dq_nudge.preferences.requests.get', return_value=fake_response) as get:
        ok = prefs.refresh()

    assert ok is True
    assert get.call_args.args[0].startswith('https://good-server.example')


# ---------------------------------------------------------------------------
# Adaptive interval
# ---------------------------------------------------------------------------
def test_interval_foreground():
    poller = DqNudgePoller(
        FakeAuthManager(),
        on_nudges=lambda n: None,
        idle_seconds_provider=lambda: 30,
    )
    assert poller._current_interval() == FOREGROUND_POLL_INTERVAL
    assert FOREGROUND_POLL_INTERVAL == 30 * 60, 'foreground poll should be 30 min'


def test_interval_idle():
    poller = DqNudgePoller(
        FakeAuthManager(),
        on_nudges=lambda n: None,
        idle_seconds_provider=lambda: DEFAULT_IDLE_THRESHOLD + 1,
    )
    assert poller._current_interval() == IDLE_POLL_INTERVAL
    assert IDLE_POLL_INTERVAL == 60 * 60, 'idle poll should be 60 min'


def test_interval_provider_exception_defaults_to_foreground():
    def bad():
        raise RuntimeError('oops')

    poller = DqNudgePoller(FakeAuthManager(), on_nudges=lambda n: None, idle_seconds_provider=bad)
    assert poller._current_interval() == FOREGROUND_POLL_INTERVAL


# ---------------------------------------------------------------------------
# ack_client
# ---------------------------------------------------------------------------
def test_acknowledge_nudges_validates_action():
    assert acknowledge_nudges(FakeAuthManager(), [1], 'frobnicate') is False


def test_acknowledge_nudges_rejects_snoozed_without_until():
    assert acknowledge_nudges(FakeAuthManager(), [1], 'snoozed') is False


def test_acknowledge_nudges_rejects_empty_ids():
    assert acknowledge_nudges(FakeAuthManager(), [], 'viewed') is False


def test_acknowledge_nudges_posts_with_bearer_token():
    fake = MagicMock(status_code=200, text='{"success":true}')
    with patch('dq_nudge.ack_client.requests.post', return_value=fake) as post:
        ok = acknowledge_nudges(FakeAuthManager('TOKEN'), [1, 2], 'dismissed')
    assert ok is True
    _, kwargs = post.call_args
    assert kwargs['headers']['Authorization'] == 'Bearer TOKEN'
    assert kwargs['json']['nudgeIds'] == [1, 2]
    assert kwargs['json']['action'] == 'dismissed'


def test_acknowledge_nudges_returns_false_on_non_2xx():
    fake = MagicMock(status_code=400, text='bad')
    with patch('dq_nudge.ack_client.requests.post', return_value=fake):
        ok = acknowledge_nudges(FakeAuthManager('T'), [1], 'viewed')
    assert ok is False


def test_acknowledge_nudges_includes_snooze_until():
    fake = MagicMock(status_code=200, text='ok')
    with patch('dq_nudge.ack_client.requests.post', return_value=fake) as post:
        ok = acknowledge_nudges(FakeAuthManager('T'), [9], 'snoozed', '2026-12-31T00:00:00Z')
    assert ok is True
    _, kwargs = post.call_args
    assert kwargs['json']['snoozeUntil'] == '2026-12-31T00:00:00Z'


def test_acknowledge_nudges_prefers_auth_manager_ai_server_url_over_placeholder_env(monkeypatch):
    monkeypatch.setenv('AI_SERVER_URL', 'http://your-ai-server-url:3001')
    auth = FakeAuthManager(token='TOKEN', ai_server_url='https://good-server.example')
    fake = MagicMock(status_code=200, text='ok')

    with patch('dq_nudge.ack_client.requests.post', return_value=fake) as post:
        ok = acknowledge_nudges(auth, [7], 'viewed')

    assert ok is True
    assert post.call_args.args[0].startswith('https://good-server.example')
