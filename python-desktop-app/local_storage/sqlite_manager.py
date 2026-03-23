"""
SQLite Manager for Local OCR Storage
======================================

Thread-safe SQLite database with WAL mode for storing:
- Active window sessions with accumulated time
- Pending activity records awaiting batch upload
- Cached app classification rules from server
"""

import os
import sqlite3
import threading
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Default DB path uses XDG on Linux, LocalAppData on Windows
_DEFAULT_DB_DIR = os.path.join(
    os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')),
    'timetracker'
)


class SQLiteManager:
    """Thread-safe SQLite manager with WAL journaling and per-thread connections."""

    def __init__(self, db_path=None):
        if db_path is None:
            os.makedirs(_DEFAULT_DB_DIR, exist_ok=True)
            db_path = os.path.join(_DEFAULT_DB_DIR, 'hybrid_ocr_storage.db')
        self.db_path = db_path
        self._local = threading.local()
        self._create_tables()

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def _get_connection(self):
        """Return a thread-local SQLite connection."""
        conn = getattr(self._local, 'conn', None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def close(self):
        """Close the thread-local connection (if any)."""
        conn = getattr(self._local, 'conn', None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _create_tables(self):
        conn = self._get_connection()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS active_sessions (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                window_title        TEXT NOT NULL,
                application_name    TEXT NOT NULL,
                classification      TEXT DEFAULT '',
                ocr_text            TEXT DEFAULT '',
                ocr_method          TEXT DEFAULT '',
                ocr_confidence      REAL DEFAULT 0.0,
                total_time_seconds  REAL DEFAULT 0.0,
                visit_count         INTEGER DEFAULT 1,
                first_seen          TEXT NOT NULL,
                last_seen           TEXT NOT NULL,
                UNIQUE(window_title, application_name)
            );

            CREATE TABLE IF NOT EXISTS pending_activity_records (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id             TEXT,
                organization_id     TEXT,
                window_title        TEXT NOT NULL,
                application_name    TEXT NOT NULL,
                ocr_text            TEXT DEFAULT '',
                ocr_method          TEXT DEFAULT '',
                ocr_confidence      REAL DEFAULT 0.0,
                classification      TEXT DEFAULT '',
                start_time          TEXT NOT NULL,
                end_time            TEXT NOT NULL,
                duration_seconds    REAL NOT NULL,
                work_date           TEXT,
                synced              INTEGER DEFAULT 0,
                retry_count         INTEGER DEFAULT 0,
                batch_id            TEXT,
                created_at          TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS app_classifications_cache (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                organization_id     TEXT NOT NULL,
                project_key         TEXT DEFAULT '',
                identifier          TEXT NOT NULL,
                display_name        TEXT DEFAULT '',
                classification      TEXT NOT NULL,
                match_by            TEXT DEFAULT 'title',
                cached_at           TEXT DEFAULT (datetime('now')),
                UNIQUE(organization_id, project_key, identifier, match_by)
            );

            CREATE INDEX IF NOT EXISTS idx_pending_synced
                ON pending_activity_records(synced);
            CREATE INDEX IF NOT EXISTS idx_pending_batch
                ON pending_activity_records(batch_id);
            CREATE INDEX IF NOT EXISTS idx_classifications_org
                ON app_classifications_cache(organization_id, project_key);
        """)
        conn.commit()
        logger.info("SQLite tables ensured at %s", self.db_path)

    # ------------------------------------------------------------------
    # Active sessions CRUD
    # ------------------------------------------------------------------

    def upsert_session(self, window_title, application_name, elapsed_seconds,
                       ocr_text='', ocr_method='', ocr_confidence=0.0,
                       classification=''):
        """Insert or accumulate time for a window session."""
        conn = self._get_connection()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("""
            INSERT INTO active_sessions
                (window_title, application_name, classification,
                 ocr_text, ocr_method, ocr_confidence,
                 total_time_seconds, visit_count, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(window_title, application_name) DO UPDATE SET
                total_time_seconds = total_time_seconds + excluded.total_time_seconds,
                visit_count = visit_count + 1,
                last_seen = excluded.last_seen,
                ocr_text = CASE WHEN excluded.ocr_text != '' THEN excluded.ocr_text ELSE ocr_text END,
                ocr_method = CASE WHEN excluded.ocr_method != '' THEN excluded.ocr_method ELSE ocr_method END,
                ocr_confidence = CASE WHEN excluded.ocr_confidence > ocr_confidence THEN excluded.ocr_confidence ELSE ocr_confidence END,
                classification = CASE WHEN excluded.classification != '' THEN excluded.classification ELSE classification END
        """, (window_title, application_name, classification,
              ocr_text, ocr_method, ocr_confidence,
              elapsed_seconds, now, now))
        conn.commit()

    def get_all_sessions(self):
        """Return all active sessions as list of dicts."""
        conn = self._get_connection()
        rows = conn.execute("SELECT * FROM active_sessions ORDER BY last_seen DESC").fetchall()
        return [dict(r) for r in rows]

    def clear_sessions(self):
        """Delete all active sessions (after successful upload)."""
        conn = self._get_connection()
        conn.execute("DELETE FROM active_sessions")
        conn.commit()

    # ------------------------------------------------------------------
    # Pending activity records
    # ------------------------------------------------------------------

    def add_pending_record(self, user_id, organization_id, window_title,
                           application_name, start_time, end_time,
                           duration_seconds, work_date='',
                           ocr_text='', ocr_method='', ocr_confidence=0.0,
                           classification=''):
        """Queue an activity record for batch upload."""
        conn = self._get_connection()
        conn.execute("""
            INSERT INTO pending_activity_records
                (user_id, organization_id, window_title, application_name,
                 ocr_text, ocr_method, ocr_confidence, classification,
                 start_time, end_time, duration_seconds, work_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, organization_id, window_title, application_name,
              ocr_text, ocr_method, ocr_confidence, classification,
              start_time, end_time, duration_seconds, work_date))
        conn.commit()

    def get_pending_records(self, limit=100):
        """Return up to *limit* unsynced records."""
        conn = self._get_connection()
        rows = conn.execute("""
            SELECT * FROM pending_activity_records
            WHERE synced = 0 AND retry_count < 3
            ORDER BY created_at ASC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]

    def mark_synced(self, record_ids):
        """Mark records as successfully synced."""
        if not record_ids:
            return
        conn = self._get_connection()
        placeholders = ','.join('?' for _ in record_ids)
        conn.execute(
            f"UPDATE pending_activity_records SET synced = 1 WHERE id IN ({placeholders})",
            list(record_ids)
        )
        conn.commit()

    def increment_retry(self, record_ids):
        """Increment retry count for failed records."""
        if not record_ids:
            return
        conn = self._get_connection()
        placeholders = ','.join('?' for _ in record_ids)
        conn.execute(
            f"UPDATE pending_activity_records SET retry_count = retry_count + 1 WHERE id IN ({placeholders})",
            list(record_ids)
        )
        conn.commit()

    def cleanup_old_synced(self, days=7):
        """Delete synced records older than *days*."""
        conn = self._get_connection()
        conn.execute("""
            DELETE FROM pending_activity_records
            WHERE synced = 1
              AND created_at < datetime('now', ?)
        """, (f"-{days} days",))
        conn.commit()

    def get_pending_count(self):
        """Return count of unsynced records."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT COUNT(*) FROM pending_activity_records WHERE synced = 0"
        ).fetchone()
        return row[0] if row else 0

    # ------------------------------------------------------------------
    # Classification cache
    # ------------------------------------------------------------------

    def cache_classifications(self, organization_id, project_key, classifications):
        """Replace cached classifications for an org/project."""
        conn = self._get_connection()
        conn.execute("""
            DELETE FROM app_classifications_cache
            WHERE organization_id = ? AND project_key = ?
        """, (organization_id, project_key))
        for c in classifications:
            conn.execute("""
                INSERT OR REPLACE INTO app_classifications_cache
                    (organization_id, project_key, identifier,
                     display_name, classification, match_by)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (organization_id, project_key,
                  c.get('identifier', ''),
                  c.get('display_name', ''),
                  c.get('classification', ''),
                  c.get('match_by', 'title')))
        conn.commit()

    def get_cached_classifications(self, organization_id, project_key=''):
        """Return cached classifications for an org/project."""
        conn = self._get_connection()
        rows = conn.execute("""
            SELECT * FROM app_classifications_cache
            WHERE organization_id = ? AND (project_key = ? OR project_key = '')
        """, (organization_id, project_key)).fetchall()
        return [dict(r) for r in rows]
