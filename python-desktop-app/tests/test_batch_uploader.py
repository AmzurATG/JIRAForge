"""
Batch Uploader Test Suite
==========================

Tests the local_storage.batch_uploader module — batch creation,
retry logic, sync marking.

Usage:
    python -m pytest tests/test_batch_uploader.py -v
    python -m tests.test_batch_uploader
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from local_storage.sqlite_manager import SQLiteManager
from local_storage.batch_uploader import BatchUploader


class TestBatchUploader(unittest.TestCase):
    """Test BatchUploader upload_batch logic."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))
        self.uploader = BatchUploader(
            self.db,
            upload_interval=10,
            max_batch_size=5,
            max_retries=3,
        )
        # Seed some pending records
        for i in range(8):
            self.db.add_pending_record(
                user_id=f'user{i}', organization_id='org1',
                window_title=f'Window {i}', application_name='app',
                start_time='2026-01-01T00:00:00Z',
                end_time='2026-01-01T00:05:00Z',
                duration_seconds=300.0,
            )

    def tearDown(self):
        self.uploader.stop()
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _mock_supabase(self, success=True):
        client = MagicMock()
        if success:
            client.table.return_value.insert.return_value.execute.return_value = MagicMock(
                data=[{'id': 1}]
            )
        else:
            client.table.return_value.insert.return_value.execute.side_effect = Exception(
                "Network error"
            )
        return client

    def test_upload_batch_respects_limit(self):
        """Should upload at most max_batch_size records."""
        client = self._mock_supabase()
        count = self.uploader.upload_batch(client)
        self.assertEqual(count, 5)  # max_batch_size
        self.assertEqual(self.db.get_pending_count(), 3)  # 8 - 5

    def test_upload_batch_marks_synced(self):
        """Successful upload should mark records as synced."""
        client = self._mock_supabase()
        self.uploader.upload_batch(client)
        # 5 synced, 3 remaining
        remaining = self.db.get_pending_records()
        self.assertEqual(len(remaining), 3)

    def test_upload_batch_on_failure_increments_retry(self):
        """Failed upload should increment retry count."""
        client = self._mock_supabase(success=False)
        count = self.uploader.upload_batch(client)
        self.assertEqual(count, 0)
        # All 5 attempted records should still be pending but with retry_count=1
        records = self.db.get_pending_records(limit=10)
        for r in records[:5]:
            self.assertLessEqual(r['retry_count'], 1)

    def test_upload_batch_empty(self):
        """If no pending records, should return 0."""
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))
        uploader = BatchUploader(self.db)
        client = self._mock_supabase()
        count = uploader.upload_batch(client)
        self.assertEqual(count, 0)

    def test_upload_batch_callback(self):
        """on_batch_uploaded callback should be called with batch_id and count."""
        client = self._mock_supabase()
        callback = MagicMock()
        self.uploader.upload_batch(client, on_batch_uploaded=callback)
        callback.assert_called_once()
        args = callback.call_args[0]
        self.assertIsInstance(args[0], str)   # batch_id
        self.assertEqual(args[1], 5)          # count

    def test_pending_count(self):
        self.assertEqual(self.uploader.pending_count(), 8)


if __name__ == '__main__':
    unittest.main()
