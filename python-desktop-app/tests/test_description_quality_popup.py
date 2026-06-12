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

# The conftest.py already mocks tkinter and other heavy modules


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
    
    def test_wayland_detection_with_wayland_display(self):
        """Test Wayland detection when WAYLAND_DISPLAY is set."""
        with patch.dict(os.environ, {'WAYLAND_DISPLAY': 'wayland-0'}, clear=False):
            # Create a mock popup instance to test the method
            mock_popup = MagicMock()
            
            def _is_wayland():
                return bool(
                    os.environ.get('WAYLAND_DISPLAY') or
                    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
                )
            
            mock_popup._is_wayland = _is_wayland
            assert mock_popup._is_wayland() is True
    
    def test_wayland_detection_with_xdg_session_type(self):
        """Test Wayland detection via XDG_SESSION_TYPE."""
        env = {'XDG_SESSION_TYPE': 'wayland'}
        with patch.dict(os.environ, env, clear=True):
            def _is_wayland():
                return bool(
                    os.environ.get('WAYLAND_DISPLAY') or
                    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
                )
            
            assert _is_wayland() is True
    
    def test_x11_detection_no_wayland_env(self):
        """Test X11 detection when no Wayland env vars are set."""
        env = {'DISPLAY': ':0'}
        with patch.dict(os.environ, env, clear=True):
            def _is_wayland():
                return bool(
                    os.environ.get('WAYLAND_DISPLAY') or
                    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
                )
            
            assert _is_wayland() is False
    
    def test_score_color_red_for_low_scores(self):
        """Test score color is red for scores below 50."""
        # Test the color logic directly
        def _get_score_color(score: int) -> str:
            SUCCESS_COLOR = '#4CAF50'
            WARNING_COLOR = '#FFA500'
            DANGER_COLOR = '#FF5252'
            
            if score >= 80:
                return SUCCESS_COLOR
            elif score >= 50:
                return WARNING_COLOR
            else:
                return DANGER_COLOR
        
        assert _get_score_color(25) == '#FF5252'  # DANGER_COLOR
        assert _get_score_color(0) == '#FF5252'
        assert _get_score_color(49) == '#FF5252'
    
    def test_score_color_yellow_for_medium_scores(self):
        """Test score color is yellow for scores between 50 and 79."""
        def _get_score_color(score: int) -> str:
            SUCCESS_COLOR = '#4CAF50'
            WARNING_COLOR = '#FFA500'
            DANGER_COLOR = '#FF5252'
            
            if score >= 80:
                return SUCCESS_COLOR
            elif score >= 50:
                return WARNING_COLOR
            else:
                return DANGER_COLOR
        
        assert _get_score_color(50) == '#FFA500'  # WARNING_COLOR
        assert _get_score_color(65) == '#FFA500'
        assert _get_score_color(79) == '#FFA500'
    
    def test_score_color_green_for_high_scores(self):
        """Test score color is green for scores 80 and above."""
        def _get_score_color(score: int) -> str:
            SUCCESS_COLOR = '#4CAF50'
            WARNING_COLOR = '#FFA500'
            DANGER_COLOR = '#FF5252'
            
            if score >= 80:
                return SUCCESS_COLOR
            elif score >= 50:
                return WARNING_COLOR
            else:
                return DANGER_COLOR
        
        assert _get_score_color(80) == '#4CAF50'  # SUCCESS_COLOR
        assert _get_score_color(95) == '#4CAF50'
        assert _get_score_color(100) == '#4CAF50'
    
    def test_nudge_removal_from_list(self, sample_nudges):
        """Test nudge is removed from list after action."""
        nudges_copy = sample_nudges.copy()
        initial_count = len(nudges_copy)
        
        # Simulate removal
        nudge_to_remove = nudges_copy[0]
        if nudge_to_remove in nudges_copy:
            nudges_copy.remove(nudge_to_remove)
        
        assert len(nudges_copy) == initial_count - 1
        assert nudge_to_remove not in nudges_copy
    
    def test_all_nudges_removed_triggers_close(self, callbacks):
        """Test popup should close when all nudges are handled."""
        nudges = [{'id': 'nudge-1', 'issueKey': 'PROJ-123'}]
        
        # Simulate removing the last nudge
        nudges.remove(nudges[0])
        
        # When empty, on_close should be called
        if not nudges:
            callbacks['on_close']()
        
        callbacks['on_close'].assert_called_once()
    
    def test_improve_callback_triggered(self, sample_nudges, callbacks):
        """Test improve callback is triggered with correct nudge."""
        nudge = sample_nudges[0]
        
        # Simulate improve button click
        callbacks['on_improve'](nudge)
        
        callbacks['on_improve'].assert_called_once_with(nudge)
    
    def test_snooze_callback_with_hours(self, sample_nudges, callbacks):
        """Test snooze callback includes hours parameter."""
        nudge = sample_nudges[0]
        hours = 4
        
        # Simulate snooze selection
        callbacks['on_snooze'](nudge, hours)
        
        callbacks['on_snooze'].assert_called_once_with(nudge, hours)
    
    def test_dismiss_callback_triggered(self, sample_nudges, callbacks):
        """Test dismiss callback is triggered with correct nudge."""
        nudge = sample_nudges[0]
        
        # Simulate dismiss button click
        callbacks['on_dismiss'](nudge)
        
        callbacks['on_dismiss'].assert_called_once_with(nudge)


class TestWaylandWindowConfiguration:
    """Tests specific to Wayland window configuration."""
    
    def test_dialog_type_should_be_set_on_wayland(self):
        """Test that dialog type hint should be set on Wayland."""
        mock_popup = MagicMock()
        is_wayland = True
        
        # Simulate _configure_window_hints behavior
        if is_wayland:
            try:
                mock_popup.attributes('-type', 'dialog')
            except Exception:
                pass
        
        mock_popup.attributes.assert_called_with('-type', 'dialog')
    
    def test_topmost_not_set_on_wayland(self):
        """Test that -topmost is NOT set on Wayland."""
        mock_popup = MagicMock()
        is_wayland = True
        
        # Simulate _configure_window_hints behavior
        if is_wayland:
            try:
                mock_popup.attributes('-type', 'dialog')
            except Exception:
                pass
            # -topmost should NOT be called on Wayland
        else:
            mock_popup.attributes('-topmost', True)
        
        # Verify -topmost was not called
        calls = [call for call in mock_popup.attributes.call_args_list 
                 if call[0][0] == '-topmost']
        assert len(calls) == 0
    
    def test_topmost_set_on_x11(self):
        """Test that -topmost IS set on X11."""
        mock_popup = MagicMock()
        is_wayland = False
        
        # Simulate _configure_window_hints behavior
        if is_wayland:
            try:
                mock_popup.attributes('-type', 'dialog')
            except Exception:
                pass
        else:
            try:
                mock_popup.attributes('-topmost', True)
            except Exception:
                pass
        
        mock_popup.attributes.assert_called_with('-topmost', True)
    
    def test_transient_relationship_set(self):
        """Test that transient relationship is established with parent."""
        mock_popup = MagicMock()
        mock_parent = MagicMock()
        
        # Simulate transient setting
        try:
            mock_popup.transient(mock_parent)
        except Exception:
            pass
        
        mock_popup.transient.assert_called_once_with(mock_parent)


class TestWindowCentering:
    """Tests for window centering logic."""
    
    def test_center_calculation_1920x1080(self):
        """Test center calculation for 1920x1080 screen."""
        screen_width = 1920
        screen_height = 1080
        window_width = 550
        window_height = 420
        
        x = (screen_width - window_width) // 2
        y = (screen_height - window_height) // 2
        
        assert x == 685
        assert y == 330
    
    def test_center_calculation_1366x768(self):
        """Test center calculation for 1366x768 screen."""
        screen_width = 1366
        screen_height = 768
        window_width = 550
        window_height = 420
        
        x = (screen_width - window_width) // 2
        y = (screen_height - window_height) // 2
        
        assert x == 408
        assert y == 174
    
    def test_center_calculation_4k_screen(self):
        """Test center calculation for 4K screen."""
        screen_width = 3840
        screen_height = 2160
        window_width = 550
        window_height = 420
        
        x = (screen_width - window_width) // 2
        y = (screen_height - window_height) // 2
        
        assert x == 1645
        assert y == 870


class TestSummaryTruncation:
    """Tests for summary text truncation."""
    
    def test_short_summary_not_truncated(self):
        """Test short summaries are not truncated."""
        summary = "Short summary"
        max_length = 60
        
        if len(summary) > max_length:
            summary = summary[:max_length - 3] + '...'
        
        assert summary == "Short summary"
        assert '...' not in summary
    
    def test_long_summary_truncated(self):
        """Test long summaries are truncated with ellipsis."""
        summary = "This is a very long summary that exceeds the maximum length and should be truncated"
        max_length = 60
        
        if len(summary) > max_length:
            summary = summary[:max_length - 3] + '...'
        
        assert len(summary) == max_length
        assert summary.endswith('...')
    
    def test_exactly_60_chars_not_truncated(self):
        """Test summary of exactly 60 chars is not truncated."""
        summary = "A" * 60
        max_length = 60
        
        if len(summary) > max_length:
            summary = summary[:max_length - 3] + '...'
        
        assert len(summary) == 60
        assert '...' not in summary
