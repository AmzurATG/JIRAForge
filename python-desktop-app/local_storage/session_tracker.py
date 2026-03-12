"""Active Session Tracker for Linux Hybrid OCR Approach

Tracks accumulated active time per window/application using SQLite storage.
Implements window change detection and time accumulation logic.
"""

import time
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Tuple
from dataclasses import dataclass, field

from .sqlite_manager import SQLiteManager


@dataclass
class ActiveWindow:
    """Represents currently active window state"""
    window_title: str
    application_name: str
    session_id: int
    started_at: float  # time.time() when window became active
    ocr_text: Optional[str] = None
    ocr_method: Optional[str] = None
    ocr_confidence: float = 0.0
    classification: Optional[str] = None
    
    def get_elapsed_seconds(self) -> float:
        """Get seconds since window became active"""
        return time.time() - self.started_at


@dataclass
class SessionStats:
    """Statistics about tracked sessions"""
    total_sessions: int = 0
    total_tracked_seconds: float = 0
    pending_upload_count: int = 0
    current_window: Optional[str] = None
    current_elapsed: float = 0


class ActiveSessionTracker:
    """
    Tracks active time per window/application combination.
    
    Features:
    - Window change detection
    - Time accumulation per window
    - OCR text and classification association
    - SQLite persistence
    - Session aggregation for batch uploads
    """
    
    def __init__(self, db: Optional[SQLiteManager] = None):
        self.db = db or SQLiteManager.get_instance()
        self._current_window: Optional[ActiveWindow] = None
        self._last_activity_time = time.time()
        
        # Configuration
        self.idle_threshold_seconds = 120  # Consider idle after 2 minutes
        self.min_session_duration_seconds = 3  # Ignore very short sessions
    
    def get_current_window(self) -> Optional[ActiveWindow]:
        """Get the currently tracked window"""
        return self._current_window
    
    def on_window_change(self, window_title: str, app_name: str,
                        ocr_text: Optional[str] = None,
                        ocr_method: Optional[str] = None,
                        ocr_confidence: float = 0.0,
                        classification: Optional[str] = None) -> Optional[float]:
        """
        Handle window/application change.
        
        Returns: Elapsed seconds in previous window (if any)
        """
        elapsed_in_previous = None
        
        # Check if window actually changed
        if self._current_window:
            if (self._current_window.window_title == window_title and 
                self._current_window.application_name == app_name):
                # Same window, update OCR data if provided
                if ocr_text:
                    self._current_window.ocr_text = ocr_text
                    self._current_window.ocr_method = ocr_method
                    self._current_window.ocr_confidence = ocr_confidence
                if classification:
                    self._current_window.classification = classification
                self._last_activity_time = time.time()
                return None
            
            # Window changed, close previous session
            elapsed_in_previous = self._close_current_session()
        
        # Start new session
        self._start_new_session(
            window_title=window_title,
            app_name=app_name,
            ocr_text=ocr_text,
            ocr_method=ocr_method,
            ocr_confidence=ocr_confidence,
            classification=classification
        )
        
        return elapsed_in_previous
    
    def _start_new_session(self, window_title: str, app_name: str,
                          ocr_text: Optional[str] = None,
                          ocr_method: Optional[str] = None,
                          ocr_confidence: float = 0.0,
                          classification: Optional[str] = None):
        """Start tracking a new window session"""
        # Get or create database session
        session = self.db.get_or_create_session(window_title, app_name)
        
        # Update session with OCR data
        updates = {}
        if ocr_text:
            updates['ocr_text'] = ocr_text
            updates['ocr_method'] = ocr_method
            updates['ocr_confidence'] = ocr_confidence
        if classification:
            updates['classification'] = classification
        
        updates['last_seen'] = datetime.now(timezone.utc).isoformat()
        updates['timer_started_at'] = datetime.now(timezone.utc).isoformat()
        updates['visit_count'] = session.get('visit_count', 0) + 1
        
        self.db.update_session(session['id'], updates)
        
        # Create active window tracker
        self._current_window = ActiveWindow(
            window_title=window_title,
            application_name=app_name,
            session_id=session['id'],
            started_at=time.time(),
            ocr_text=ocr_text,
            ocr_method=ocr_method,
            ocr_confidence=ocr_confidence,
            classification=classification
        )
        
        self._last_activity_time = time.time()
    
    def _close_current_session(self) -> float:
        """Close current session and return elapsed time"""
        if not self._current_window:
            return 0.0
        
        elapsed = self._current_window.get_elapsed_seconds()
        
        # Only record if session was long enough
        if elapsed >= self.min_session_duration_seconds:
            self.db.accumulate_session_time(
                self._current_window.session_id,
                elapsed
            )
        
        self._current_window = None
        return elapsed
    
    def update_classification(self, classification: str):
        """Update classification for current window"""
        if self._current_window:
            self._current_window.classification = classification
            self.db.update_session(
                self._current_window.session_id,
                {'classification': classification}
            )
    
    def update_ocr_data(self, ocr_text: str, ocr_method: str, confidence: float):
        """Update OCR data for current window"""
        if self._current_window:
            self._current_window.ocr_text = ocr_text
            self._current_window.ocr_method = ocr_method
            self._current_window.ocr_confidence = confidence
            self.db.update_session(
                self._current_window.session_id,
                {
                    'ocr_text': ocr_text,
                    'ocr_method': ocr_method,
                    'ocr_confidence': confidence
                }
            )
    
    def on_activity(self):
        """Called when user activity detected (mouse/keyboard)"""
        self._last_activity_time = time.time()
    
    def is_idle(self) -> bool:
        """Check if user is considered idle"""
        return (time.time() - self._last_activity_time) > self.idle_threshold_seconds
    
    def pause_tracking(self):
        """Pause tracking (close current session without clearing)"""
        if self._current_window:
            elapsed = self._current_window.get_elapsed_seconds()
            if elapsed >= self.min_session_duration_seconds:
                self.db.accumulate_session_time(
                    self._current_window.session_id,
                    elapsed
                )
            # Reset timer for next resume
            self._current_window.started_at = time.time()
    
    def get_sessions_for_upload(self) -> list:
        """
        Get all sessions with accumulated time for batch upload.
        Returns list of session dicts ready for API payload.
        """
        sessions = self.db.get_all_sessions()
        
        # Include current session's pending time
        if self._current_window:
            for session in sessions:
                if session['id'] == self._current_window.session_id:
                    session['total_time_seconds'] += self._current_window.get_elapsed_seconds()
                    break
        
        # Filter out sessions with no meaningful time
        return [s for s in sessions if s['total_time_seconds'] >= self.min_session_duration_seconds]
    
    def reset_after_upload(self):
        """Reset session times after successful batch upload"""
        # Close current window's elapsed time first
        if self._current_window:
            self.db.accumulate_session_time(
                self._current_window.session_id,
                self._current_window.get_elapsed_seconds()
            )
            # Restart timer
            self._current_window.started_at = time.time()
        
        # Reset all session totals
        self.db.reset_sessions()
    
    def get_stats(self) -> SessionStats:
        """Get current tracking statistics"""
        db_stats = self.db.get_database_stats()
        
        stats = SessionStats(
            total_sessions=db_stats['active_sessions'],
            total_tracked_seconds=db_stats['total_tracked_seconds'],
            pending_upload_count=db_stats['pending_records'],
        )
        
        if self._current_window:
            stats.current_window = f"{self._current_window.application_name}: {self._current_window.window_title[:50]}"
            stats.current_elapsed = self._current_window.get_elapsed_seconds()
            stats.total_tracked_seconds += stats.current_elapsed
        
        return stats
    
    def get_current_session_info(self) -> Optional[Dict]:
        """Get info about currently tracked window"""
        if not self._current_window:
            return None
        
        return {
            'window_title': self._current_window.window_title,
            'application_name': self._current_window.application_name,
            'session_id': self._current_window.session_id,
            'elapsed_seconds': self._current_window.get_elapsed_seconds(),
            'ocr_text': self._current_window.ocr_text,
            'ocr_method': self._current_window.ocr_method,
            'ocr_confidence': self._current_window.ocr_confidence,
            'classification': self._current_window.classification,
            'is_idle': self.is_idle(),
        }
    
    def close(self):
        """Clean shutdown - save current session"""
        self._close_current_session()
