"""
SQLite Manager & Local Storage Test Suite
==========================================

Tests the local_storage module: SQLiteManager, SessionTracker, BatchUploader.

Usage:
    python -m pytest tests/test_sqlite_manager.py -v
    python -m tests.test_sqlite_manager
"""

import os
import sys
import time
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from local_storage.sqlite_manager import SQLiteManager


class TestSQLiteManagerSchema(unittest.TestCase):
    """Test DB initialization and schema creation."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, 'test.db')
        self.db = SQLiteManager(db_path=self.db_path)

    def tearDown(self):
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_db_file_created(self):
        self.assertTrue(os.path.isfile(self.db_path))

    def test_wal_mode(self):
        conn = self.db._get_connection()
        result = conn.execute("PRAGMA journal_mode").fetchone()
        self.assertEqual(result[0], 'wal')

    def test_tables_exist(self):
        conn = self.db._get_connection()
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        self.assertIn('active_sessions', tables)
        self.assertIn('pending_activity_records', tables)
        self.assertIn('app_classifications_cache', tables)


class TestActiveSessions(unittest.TestCase):
    """Test active_sessions CRUD operations."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))

    def tearDown(self):
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_upsert_new_session(self):
        self.db.upsert_session(
            window_title="VS Code",
            application_name="code",
            elapsed_seconds=60.0,
            ocr_text="hello world",
            ocr_method="rapidocr",
            ocr_confidence=0.95,
        )
        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['window_title'], 'VS Code')
        self.assertAlmostEqual(sessions[0]['total_time_seconds'], 60.0)

    def test_upsert_accumulates_time(self):
        self.db.upsert_session("VS Code", "code", 30.0)
        self.db.upsert_session("VS Code", "code", 45.0)
        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertAlmostEqual(sessions[0]['total_time_seconds'], 75.0)
        self.assertEqual(sessions[0]['visit_count'], 2)

    def test_upsert_different_windows(self):
        self.db.upsert_session("VS Code", "code", 30.0)
        self.db.upsert_session("Chrome", "chrome", 20.0)
        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 2)

    def test_clear_sessions(self):
        self.db.upsert_session("VS Code", "code", 30.0)
        self.db.clear_sessions()
        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 0)

    def test_ocr_text_updated_on_non_empty(self):
        """OCR text should only be updated if the new value is non-empty."""
        self.db.upsert_session("VS Code", "code", 30.0, ocr_text="first text")
        self.db.upsert_session("VS Code", "code", 10.0, ocr_text="")
        sessions = self.db.get_all_sessions()
        self.assertEqual(sessions[0]['ocr_text'], 'first text')


class TestPendingRecords(unittest.TestCase):
    """Test pending_activity_records operations."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))

    def tearDown(self):
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_add_and_get_pending(self):
        self.db.add_pending_record(
            user_id='user1', organization_id='org1',
            window_title='VS Code', application_name='code',
            start_time='2026-01-01T00:00:00Z', end_time='2026-01-01T00:05:00Z',
            duration_seconds=300.0, work_date='2026-01-01',
        )
        records = self.db.get_pending_records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['user_id'], 'user1')

    def test_mark_synced(self):
        self.db.add_pending_record(
            'user1', 'org1', 'title', 'app',
            '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300.0
        )
        records = self.db.get_pending_records()
        self.db.mark_synced([records[0]['id']])
        remaining = self.db.get_pending_records()
        self.assertEqual(len(remaining), 0)

    def test_increment_retry(self):
        self.db.add_pending_record(
            'user1', 'org1', 'title', 'app',
            '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300.0
        )
        records = self.db.get_pending_records()
        rid = records[0]['id']
        self.db.increment_retry([rid])
        self.db.increment_retry([rid])
        self.db.increment_retry([rid])
        # After 3 retries, should not appear in pending
        remaining = self.db.get_pending_records()
        self.assertEqual(len(remaining), 0)

    def test_pending_count(self):
        for i in range(5):
            self.db.add_pending_record(
                f'user{i}', 'org1', f'title{i}', 'app',
                '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300.0
            )
        self.assertEqual(self.db.get_pending_count(), 5)

    def test_batch_limit(self):
        for i in range(10):
            self.db.add_pending_record(
                f'user{i}', 'org1', f'title{i}', 'app',
                '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 300.0
            )
        records = self.db.get_pending_records(limit=3)
        self.assertEqual(len(records), 3)


class TestClassificationsCache(unittest.TestCase):
    """Test app_classifications_cache operations."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))

    def tearDown(self):
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_cache_and_retrieve(self):
        classifications = [
            {'identifier': 'vscode', 'display_name': 'VS Code', 'classification': 'productive', 'match_by': 'title'},
            {'identifier': 'chrome', 'display_name': 'Chrome', 'classification': 'neutral', 'match_by': 'title'},
        ]
        self.db.cache_classifications('org1', 'PROJ', classifications)
        cached = self.db.get_cached_classifications('org1', 'PROJ')
        self.assertEqual(len(cached), 2)

    def test_cache_replace(self):
        """Caching again should replace old entries for the same org/project."""
        self.db.cache_classifications('org1', 'PROJ', [
            {'identifier': 'vscode', 'classification': 'productive'},
        ])
        self.db.cache_classifications('org1', 'PROJ', [
            {'identifier': 'chrome', 'classification': 'neutral'},
        ])
        cached = self.db.get_cached_classifications('org1', 'PROJ')
        self.assertEqual(len(cached), 1)
        self.assertEqual(cached[0]['identifier'], 'chrome')


if __name__ == '__main__':
    unittest.main()
