"""SQLite Database Manager for Linux Hybrid OCR Approach"""

import os
import sqlite3
import threading
import json
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from contextlib import contextmanager


def get_linux_app_data_dir() -> str:
    """Get Linux app data directory following XDG Base Directory specification"""
    xdg_data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    app_dir = os.path.join(xdg_data, 'timetracker')
    os.makedirs(app_dir, exist_ok=True)
    return app_dir


class SQLiteManager:
    """
    SQLite database manager for local activity storage.
    Thread-safe with connection pooling.
    
    This manages local storage for the Hybrid OCR approach:
    - Activity records waiting to be uploaded
    - Active session tracking
    - Classification cache from server
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_path = os.path.join(get_linux_app_data_dir(), 'hybrid_ocr_storage.db')
        
        self.db_path = db_path
        self._local = threading.local()
        self._init_database()
    
    @classmethod
    def get_instance(cls, db_path: Optional[str] = None) -> 'SQLiteManager':
        """Get singleton instance"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(db_path)
        return cls._instance
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton (for testing)"""
        cls._instance = None
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get thread-local connection"""
        if not hasattr(self._local, 'connection') or self._local.connection is None:
            self._local.connection = sqlite3.connect(
                self.db_path,
                check_same_thread=False,
                timeout=30.0
            )
            self._local.connection.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            self._local.connection.execute('PRAGMA journal_mode=WAL')
            self._local.connection.execute('PRAGMA busy_timeout=30000')
        return self._local.connection
    
    @contextmanager
    def get_cursor(self):
        """Context manager for database cursor with automatic commit/rollback"""
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            yield cursor
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cursor.close()
    
    def _init_database(self):
        """Initialize database schema"""
        with self.get_cursor() as cursor:
            # Active sessions table - tracks accumulated time per window
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS active_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    window_title TEXT,
                    application_name TEXT,
                    classification TEXT DEFAULT 'unknown',
                    ocr_text TEXT,
                    ocr_method TEXT,
                    ocr_confidence REAL DEFAULT 0.0,
                    ocr_error_message TEXT,
                    total_time_seconds REAL DEFAULT 0,
                    visit_count INTEGER DEFAULT 1,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    timer_started_at TEXT,
                    batch_id TEXT,
                    synced INTEGER DEFAULT 0,
                    UNIQUE(window_title, application_name)
                )
            ''')
            
            # Activity records for batch upload - main storage for Hybrid OCR
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS pending_activity_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    organization_id TEXT,
                    window_title TEXT,
                    application_name TEXT,
                    ocr_text TEXT,
                    ocr_method TEXT,
                    ocr_confidence REAL,
                    classification TEXT,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    duration_seconds INTEGER NOT NULL,
                    work_date TEXT NOT NULL,
                    user_timezone TEXT,
                    user_assigned_issues TEXT,
                    project_key TEXT,
                    metadata TEXT,
                    batch_id TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    synced INTEGER DEFAULT 0,
                    sync_error TEXT,
                    retry_count INTEGER DEFAULT 0
                )
            ''')
            
            # App classification cache - synced from server
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS app_classifications_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    organization_id TEXT,
                    project_key TEXT,
                    identifier TEXT NOT NULL,
                    display_name TEXT,
                    classification TEXT NOT NULL,
                    match_by TEXT NOT NULL DEFAULT 'process',
                    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(organization_id, project_key, identifier, match_by)
                )
            ''')
            
            # Create indices for performance
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_sessions_synced ON active_sessions(synced)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_synced ON pending_activity_records(synced)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_batch ON pending_activity_records(batch_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_activity_records(user_id)')
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_cache_identifier ON app_classifications_cache(identifier)')
        
        print(f"[SQLite] Database initialized: {self.db_path}")
    
    # ==================== Activity Records ====================
    
    def insert_activity_record(self, record: Dict[str, Any]) -> int:
        """Insert a pending activity record for batch upload"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                INSERT INTO pending_activity_records (
                    user_id, organization_id, window_title, application_name,
                    ocr_text, ocr_method, ocr_confidence, classification,
                    start_time, end_time, duration_seconds, work_date,
                    user_timezone, user_assigned_issues, project_key, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                record['user_id'],
                record.get('organization_id'),
                record.get('window_title'),
                record.get('application_name'),
                record.get('ocr_text'),
                record.get('ocr_method'),
                record.get('ocr_confidence'),
                record.get('classification'),
                record['start_time'],
                record['end_time'],
                record['duration_seconds'],
                record['work_date'],
                record.get('user_timezone'),
                json.dumps(record.get('user_assigned_issues')) if record.get('user_assigned_issues') else None,
                record.get('project_key'),
                json.dumps(record.get('metadata')) if record.get('metadata') else None,
            ))
            return cursor.lastrowid
    
    def get_pending_records(self, limit: int = 100) -> List[Dict]:
        """Get pending records for batch upload"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                SELECT * FROM pending_activity_records 
                WHERE synced = 0 AND (retry_count < 3 OR retry_count IS NULL)
                ORDER BY created_at ASC 
                LIMIT ?
            ''', (limit,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
    
    def mark_records_synced(self, record_ids: List[int], batch_id: str):
        """Mark records as successfully synced"""
        if not record_ids:
            return
        with self.get_cursor() as cursor:
            placeholders = ','.join('?' * len(record_ids))
            cursor.execute(f'''
                UPDATE pending_activity_records 
                SET synced = 1, batch_id = ?, sync_error = NULL
                WHERE id IN ({placeholders})
            ''', [batch_id] + record_ids)
    
    def mark_record_failed(self, record_id: int, error: str):
        """Mark record sync as failed and increment retry count"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                UPDATE pending_activity_records 
                SET sync_error = ?, retry_count = COALESCE(retry_count, 0) + 1
                WHERE id = ?
            ''', (error, record_id))
    
    def get_pending_count(self) -> int:
        """Get count of pending records"""
        with self.get_cursor() as cursor:
            cursor.execute('SELECT COUNT(*) FROM pending_activity_records WHERE synced = 0')
            return cursor.fetchone()[0]
    
    def cleanup_old_synced_records(self, days: int = 7):
        """Delete old synced records to save space"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                DELETE FROM pending_activity_records 
                WHERE synced = 1 
                AND datetime(created_at) < datetime('now', ?)
            ''', (f'-{days} days',))
            deleted = cursor.rowcount
            if deleted > 0:
                print(f"[SQLite] Cleaned up {deleted} old synced records")
            return deleted
    
    # ==================== Active Sessions ====================
    
    def get_or_create_session(self, window_title: str, app_name: str) -> Dict:
        """Get existing session or create new one"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                SELECT * FROM active_sessions 
                WHERE window_title = ? AND application_name = ?
            ''', (window_title, app_name))
            row = cursor.fetchone()
            if row:
                return dict(row)
            
            # Create new session
            now = datetime.now(timezone.utc).isoformat()
            cursor.execute('''
                INSERT INTO active_sessions (
                    window_title, application_name, first_seen, last_seen, timer_started_at
                ) VALUES (?, ?, ?, ?, ?)
            ''', (window_title, app_name, now, now, now))
            
            return {
                'id': cursor.lastrowid,
                'window_title': window_title,
                'application_name': app_name,
                'first_seen': now,
                'last_seen': now,
                'total_time_seconds': 0,
                'visit_count': 1,
            }
    
    def update_session(self, session_id: int, updates: Dict):
        """Update session with new data"""
        if not updates:
            return
        with self.get_cursor() as cursor:
            set_clause = ', '.join(f'{k} = ?' for k in updates.keys())
            values = list(updates.values()) + [session_id]
            cursor.execute(f'''
                UPDATE active_sessions SET {set_clause} WHERE id = ?
            ''', values)
    
    def accumulate_session_time(self, session_id: int, elapsed_seconds: float):
        """Add elapsed time to session total"""
        with self.get_cursor() as cursor:
            now = datetime.now(timezone.utc).isoformat()
            cursor.execute('''
                UPDATE active_sessions 
                SET total_time_seconds = total_time_seconds + ?,
                    last_seen = ?,
                    timer_started_at = NULL
                WHERE id = ?
            ''', (elapsed_seconds, now, session_id))
    
    def get_all_sessions(self) -> List[Dict]:
        """Get all active sessions"""
        with self.get_cursor() as cursor:
            cursor.execute('SELECT * FROM active_sessions ORDER BY last_seen DESC')
            return [dict(row) for row in cursor.fetchall()]
    
    def reset_sessions(self):
        """Reset all sessions (after batch upload)"""
        with self.get_cursor() as cursor:
            cursor.execute('UPDATE active_sessions SET total_time_seconds = 0, synced = 1')
    
    # ==================== Classification Cache ====================
    
    def get_cached_classification(self, identifier: str, organization_id: str = None) -> Optional[str]:
        """Get cached classification for an app/URL"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                SELECT classification FROM app_classifications_cache 
                WHERE identifier = ? AND (organization_id = ? OR organization_id IS NULL)
                ORDER BY organization_id DESC NULLS LAST
                LIMIT 1
            ''', (identifier, organization_id))
            row = cursor.fetchone()
            return row['classification'] if row else None
    
    def cache_classification(self, identifier: str, classification: str, 
                            organization_id: str = None, match_by: str = 'process'):
        """Cache a classification"""
        with self.get_cursor() as cursor:
            cursor.execute('''
                INSERT OR REPLACE INTO app_classifications_cache 
                (organization_id, identifier, classification, match_by, cached_at)
                VALUES (?, ?, ?, ?, ?)
            ''', (organization_id, identifier, classification, match_by, 
                  datetime.now(timezone.utc).isoformat()))
    
    def clear_classification_cache(self, organization_id: str = None):
        """Clear classification cache (optionally for specific org)"""
        with self.get_cursor() as cursor:
            if organization_id:
                cursor.execute(
                    'DELETE FROM app_classifications_cache WHERE organization_id = ?',
                    (organization_id,)
                )
            else:
                cursor.execute('DELETE FROM app_classifications_cache')
    
    # ==================== Utilities ====================
    
    def get_database_stats(self) -> Dict:
        """Get database statistics"""
        with self.get_cursor() as cursor:
            stats = {}
            
            cursor.execute('SELECT COUNT(*) FROM pending_activity_records WHERE synced = 0')
            stats['pending_records'] = cursor.fetchone()[0]
            
            cursor.execute('SELECT COUNT(*) FROM pending_activity_records WHERE synced = 1')
            stats['synced_records'] = cursor.fetchone()[0]
            
            cursor.execute('SELECT COUNT(*) FROM active_sessions')
            stats['active_sessions'] = cursor.fetchone()[0]
            
            cursor.execute('SELECT SUM(total_time_seconds) FROM active_sessions')
            row = cursor.fetchone()
            stats['total_tracked_seconds'] = row[0] or 0
            
            cursor.execute('SELECT COUNT(*) FROM app_classifications_cache')
            stats['cached_classifications'] = cursor.fetchone()[0]
            
            return stats
    
    def vacuum(self):
        """Compact the database"""
        conn = self._get_connection()
        conn.execute('VACUUM')
        print("[SQLite] Database vacuumed")
