"""
Batch Uploader — Periodic Upload of Pending Activity Records
==============================================================

Reads unsynced records from SQLite and uploads them in batches to
the Supabase ``screenshots`` table, then triggers the AI analysis
Edge Function.  Retries failed records up to 3 times with backoff.
"""

import time
import uuid
import logging
import threading
from datetime import datetime, timezone

from .sqlite_manager import SQLiteManager

logger = logging.getLogger(__name__)


class BatchUploader:
    """Upload pending local activity records to Supabase in batches."""

    def __init__(self, db_manager: SQLiteManager,
                 upload_interval: float = 300.0,
                 max_batch_size: int = 100,
                 max_retries: int = 3,
                 retry_backoff: float = 60.0):
        self.db = db_manager
        self.upload_interval = upload_interval
        self.max_batch_size = max_batch_size
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff

        self._running = False
        self._thread = None

    # ------------------------------------------------------------------
    # Background upload loop
    # ------------------------------------------------------------------

    def start(self, supabase_client, on_batch_uploaded=None):
        """Start the background upload loop.

        Args:
            supabase_client: Authenticated Supabase client.
            on_batch_uploaded: Optional callback ``fn(batch_id, count)``
                called after each successful batch upload.
        """
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._upload_loop,
            args=(supabase_client, on_batch_uploaded),
            daemon=True,
        )
        self._thread.start()
        logger.info("Batch uploader started (interval=%ds)", self.upload_interval)

    def stop(self):
        """Stop the background loop gracefully."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=10)

    def _upload_loop(self, supabase_client, on_batch_uploaded):
        while self._running:
            try:
                self.upload_batch(supabase_client, on_batch_uploaded)
            except Exception as exc:
                logger.warning("Batch upload cycle error: %s", exc)
            # Sleep in short increments so stop() is responsive
            for _ in range(int(self.upload_interval)):
                if not self._running:
                    return
                time.sleep(1)

    # ------------------------------------------------------------------
    # Single batch upload
    # ------------------------------------------------------------------

    def upload_batch(self, supabase_client, on_batch_uploaded=None):
        """Fetch pending records and upload them as a batch.

        Returns the number of records successfully synced.
        """
        records = self.db.get_pending_records(limit=self.max_batch_size)
        if not records:
            return 0

        batch_id = str(uuid.uuid4())
        record_ids = [r['id'] for r in records]

        rows = []
        for r in records:
            rows.append({
                'user_id': r['user_id'],
                'organization_id': r['organization_id'],
                'window_title': r['window_title'],
                'application_name': r['application_name'],
                'ocr_text': r.get('ocr_text', ''),
                'ocr_method': r.get('ocr_method', ''),
                'ocr_confidence': r.get('ocr_confidence', 0.0),
                'classification': r.get('classification', ''),
                'start_time': r['start_time'],
                'end_time': r['end_time'],
                'duration_seconds': r['duration_seconds'],
                'work_date': r.get('work_date', ''),
                'batch_id': batch_id,
            })

        try:
            result = supabase_client.table('screenshots').insert(rows).execute()
            if result.data:
                self.db.mark_synced(record_ids)
                logger.info("Batch %s uploaded %d records", batch_id, len(record_ids))
                if on_batch_uploaded:
                    on_batch_uploaded(batch_id, len(record_ids))
                # Cleanup old synced records periodically
                self.db.cleanup_old_synced(days=7)
                return len(record_ids)
        except Exception as exc:
            logger.warning("Batch %s upload failed: %s", batch_id, exc)
            self.db.increment_retry(record_ids)

        return 0

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def pending_count(self):
        """Return number of unsynced records."""
        return self.db.get_pending_count()
