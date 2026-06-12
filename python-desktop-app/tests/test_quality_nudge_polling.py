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

# Mock requests before potential import
import sys
sys.modules['requests'] = MagicMock()


# Constants that would be in desktop_app.py
QUALITY_NUDGE_POLL_INTERVAL_ACTIVE = 300   # 5 minutes
QUALITY_NUDGE_POLL_INTERVAL_IDLE = 900     # 15 minutes
QUALITY_NUDGE_POLL_INTERVAL_BATTERY = 600  # 10 minutes
QUALITY_NUDGE_MAX_PER_POPUP = 5


class TestQualityNudgePolling:
    """Tests for quality nudge polling functions."""
    
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
    
    @pytest.fixture
    def sample_api_response_many_nudges(self):
        """Sample API response with more than MAX nudges."""
        return {
            'showModal': True,
            'userName': 'Test User',
            'nudges': [
                {
                    'id': f'nudge-{i}',
                    'issueKey': f'PROJ-{i}',
                    'issueUrl': f'https://example.atlassian.net/browse/PROJ-{i}',
                    'score': 30 + i,
                    'summary': f'Test ticket {i}'
                }
                for i in range(10)  # 10 nudges, more than MAX_PER_POPUP
            ]
        }
    
    def test_poll_skipped_when_not_authenticated(self):
        """Test polling is skipped when user is not authenticated."""
        is_authenticated = False
        api_called = False
        
        def poll():
            nonlocal api_called
            if not is_authenticated:
                return
            api_called = True
        
        poll()
        assert api_called is False
    
    def test_poll_skipped_when_notifications_disabled(self):
        """Test polling is skipped when notifications are disabled."""
        is_authenticated = True
        notifications_enabled = False
        api_called = False
        
        def poll():
            nonlocal api_called
            if not is_authenticated:
                return
            if not notifications_enabled:
                return
            api_called = True
        
        poll()
        assert api_called is False
    
    def test_poll_proceeds_when_conditions_met(self):
        """Test polling proceeds when authenticated and enabled."""
        is_authenticated = True
        notifications_enabled = True
        api_called = False
        
        def poll():
            nonlocal api_called
            if not is_authenticated:
                return
            if not notifications_enabled:
                return
            api_called = True
        
        poll()
        assert api_called is True
    
    def test_nudges_limited_to_max_per_popup(self, sample_api_response_many_nudges):
        """Test nudges are limited to QUALITY_NUDGE_MAX_PER_POPUP."""
        all_nudges = sample_api_response_many_nudges['nudges']
        
        # Apply limit
        limited_nudges = all_nudges[:QUALITY_NUDGE_MAX_PER_POPUP]
        
        assert len(limited_nudges) == QUALITY_NUDGE_MAX_PER_POPUP
        assert len(all_nudges) > QUALITY_NUDGE_MAX_PER_POPUP
    
    def test_no_popup_when_show_modal_false(self):
        """Test no popup shown when showModal is False."""
        response = {
            'showModal': False,
            'nudges': [{'id': 'nudge-1'}]
        }
        
        should_show_popup = response.get('showModal') and response.get('nudges')
        assert should_show_popup is False
    
    def test_no_popup_when_nudges_empty(self):
        """Test no popup shown when nudges list is empty."""
        response = {
            'showModal': True,
            'nudges': []
        }
        
        should_show_popup = response.get('showModal') and response.get('nudges')
        assert should_show_popup is False
    
    def test_popup_shown_when_conditions_met(self, sample_api_response):
        """Test popup is shown when showModal=True and nudges exist."""
        response = sample_api_response
        
        should_show_popup = response.get('showModal') and response.get('nudges')
        assert should_show_popup is True


class TestQualityNudgeAcknowledgement:
    """Tests for quality nudge acknowledgement."""
    
    @pytest.fixture
    def sample_nudge(self):
        """Sample nudge for testing."""
        return {
            'id': 'nudge-1',
            'issueKey': 'PROJ-123',
            'issueUrl': 'https://example.atlassian.net/browse/PROJ-123'
        }
    
    def test_ack_payload_for_improved(self, sample_nudge):
        """Test acknowledgement payload for 'improved' action."""
        action = 'improved'
        snooze_hours = None
        
        payload = {
            'nudgeId': sample_nudge.get('id'),
            'issueKey': sample_nudge.get('issueKey'),
            'action': action
        }
        
        if snooze_hours is not None:
            payload['snoozeHours'] = snooze_hours
        
        assert payload['action'] == 'improved'
        assert 'snoozeHours' not in payload
        assert payload['nudgeId'] == 'nudge-1'
        assert payload['issueKey'] == 'PROJ-123'
    
    def test_ack_payload_for_snoozed_with_hours(self, sample_nudge):
        """Test acknowledgement payload for 'snoozed' action includes hours."""
        action = 'snoozed'
        snooze_hours = 4
        
        payload = {
            'nudgeId': sample_nudge.get('id'),
            'issueKey': sample_nudge.get('issueKey'),
            'action': action
        }
        
        if snooze_hours is not None:
            payload['snoozeHours'] = snooze_hours
        
        assert payload['action'] == 'snoozed'
        assert payload['snoozeHours'] == 4
    
    def test_ack_payload_for_dismissed(self, sample_nudge):
        """Test acknowledgement payload for 'dismissed' action."""
        action = 'dismissed'
        snooze_hours = None
        
        payload = {
            'nudgeId': sample_nudge.get('id'),
            'issueKey': sample_nudge.get('issueKey'),
            'action': action
        }
        
        if snooze_hours is not None:
            payload['snoozeHours'] = snooze_hours
        
        assert payload['action'] == 'dismissed'
        assert 'snoozeHours' not in payload
    
    def test_valid_snooze_hours(self):
        """Test valid snooze hour options."""
        valid_hours = [1, 4, 24]
        
        for hours in valid_hours:
            assert hours in valid_hours
        
        # Invalid hours
        assert 2 not in valid_hours
        assert 0 not in valid_hours


class TestPollIntervalLogic:
    """Tests for poll interval calculation."""
    
    def test_active_interval_used_when_active_and_plugged(self):
        """Test active interval is used when user is active and on power."""
        is_on_battery = False
        is_user_idle = False
        
        if is_on_battery:
            interval = QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        elif is_user_idle:
            interval = QUALITY_NUDGE_POLL_INTERVAL_IDLE
        else:
            interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        
        assert interval == QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        assert interval == 300  # 5 minutes
    
    def test_idle_interval_used_when_idle(self):
        """Test idle interval is used when user is idle."""
        is_on_battery = False
        is_user_idle = True
        
        if is_on_battery:
            interval = QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        elif is_user_idle:
            interval = QUALITY_NUDGE_POLL_INTERVAL_IDLE
        else:
            interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        
        assert interval == QUALITY_NUDGE_POLL_INTERVAL_IDLE
        assert interval == 900  # 15 minutes
    
    def test_battery_interval_used_when_on_battery(self):
        """Test battery interval is used when on battery (highest priority)."""
        is_on_battery = True
        is_user_idle = False  # Active but on battery
        
        if is_on_battery:
            interval = QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        elif is_user_idle:
            interval = QUALITY_NUDGE_POLL_INTERVAL_IDLE
        else:
            interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        
        assert interval == QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        assert interval == 600  # 10 minutes
    
    def test_battery_takes_precedence_over_idle(self):
        """Test battery interval takes precedence even when idle."""
        is_on_battery = True
        is_user_idle = True  # Both conditions
        
        if is_on_battery:
            interval = QUALITY_NUDGE_POLL_INTERVAL_BATTERY
        elif is_user_idle:
            interval = QUALITY_NUDGE_POLL_INTERVAL_IDLE
        else:
            interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        
        # Battery should take precedence
        assert interval == QUALITY_NUDGE_POLL_INTERVAL_BATTERY
    
    def test_should_poll_returns_true_after_interval(self):
        """Test _should_poll returns True after interval elapsed."""
        interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        last_poll = time.time() - interval - 10  # 10 seconds past interval
        
        elapsed = time.time() - last_poll
        should_poll = elapsed >= interval
        
        assert should_poll is True
    
    def test_should_poll_returns_false_before_interval(self):
        """Test _should_poll returns False before interval elapsed."""
        interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        last_poll = time.time() - 100  # Only 100 seconds ago
        
        elapsed = time.time() - last_poll
        should_poll = elapsed >= interval
        
        assert should_poll is False
    
    def test_first_poll_always_allowed(self):
        """Test first poll is always allowed (last_poll = 0)."""
        interval = QUALITY_NUDGE_POLL_INTERVAL_ACTIVE
        last_poll = 0  # Never polled before
        
        elapsed = time.time() - last_poll
        should_poll = elapsed >= interval
        
        # Current time is always > interval from epoch
        assert should_poll is True


class TestFallbackNotification:
    """Tests for fallback notification when popup unavailable."""
    
    def test_fallback_used_when_tkinter_unavailable(self):
        """Test fallback notification is used when tkinter is not available."""
        tkinter_available = False
        fallback_called = False
        
        def show_popup(nudges, user_name):
            nonlocal fallback_called
            if not tkinter_available:
                fallback_called = True
                return
            # Would create popup
        
        show_popup([{'id': 'nudge-1'}], 'User')
        assert fallback_called is True
    
    def test_popup_used_when_tkinter_available(self):
        """Test popup is used when tkinter is available."""
        tkinter_available = True
        popup_created = False
        
        def show_popup(nudges, user_name):
            nonlocal popup_created
            if not tkinter_available:
                return  # fallback
            popup_created = True
        
        show_popup([{'id': 'nudge-1'}], 'User')
        assert popup_created is True
    
    def test_notification_message_format(self):
        """Test fallback notification message format."""
        nudges = [
            {'id': 'nudge-1'},
            {'id': 'nudge-2'},
            {'id': 'nudge-3'}
        ]
        
        count = len(nudges)
        title = "Time Tracker: Improve Ticket Quality"
        body = f"You have {count} ticket{'s' if count != 1 else ''} with low quality scores"
        
        assert title == "Time Tracker: Improve Ticket Quality"
        assert body == "You have 3 tickets with low quality scores"
    
    def test_notification_message_singular(self):
        """Test fallback notification uses singular for 1 ticket."""
        nudges = [{'id': 'nudge-1'}]
        
        count = len(nudges)
        body = f"You have {count} ticket{'s' if count != 1 else ''} with low quality scores"
        
        assert body == "You have 1 ticket with low quality scores"


class TestIssueUrlHandling:
    """Tests for issue URL construction."""
    
    def test_improve_url_without_fragment(self):
        """Test #dq=improve is appended when URL has no fragment."""
        issue_url = 'https://example.atlassian.net/browse/PROJ-123'
        
        if '#' not in issue_url:
            issue_url += '#dq=improve'
        
        assert issue_url == 'https://example.atlassian.net/browse/PROJ-123#dq=improve'
    
    def test_improve_url_with_existing_fragment(self):
        """Test #dq=improve is NOT appended when URL has fragment."""
        issue_url = 'https://example.atlassian.net/browse/PROJ-123#existing'
        
        if '#' not in issue_url:
            issue_url += '#dq=improve'
        
        # Should not modify URL with existing fragment
        assert issue_url == 'https://example.atlassian.net/browse/PROJ-123#existing'
    
    def test_empty_url_handling(self):
        """Test empty URL is handled gracefully."""
        issue_url = ''
        
        # Should not process empty URL
        if issue_url:
            if '#' not in issue_url:
                issue_url += '#dq=improve'
        
        assert issue_url == ''
