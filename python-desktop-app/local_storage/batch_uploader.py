"""Batch Uploader for Linux Hybrid OCR Approach

Handles batched upload of activity records to Supabase.
Implements retry logic, offline queueing, and server-side AI analysis triggers.
"""

import asyncio
import json
import uuid
import threading
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Callable
from dataclasses import dataclass


@dataclass
class BatchUploadConfig:
    """Configuration for batch uploads"""
    batch_interval_seconds: int = 300  # 5 minutes
    max_batch_size: int = 100
    retry_delay_seconds: int = 30
    max_retries: int = 3
    offline_queue_max_size: int = 10000


@dataclass
class BatchResult:
    """Result of a batch upload operation"""
    success: bool
    batch_id: str
    records_uploaded: int
    records_failed: int
    error_message: Optional[str] = None
    ai_analysis_triggered: bool = False


class BatchUploader:
    """
    Handles batched upload of OCR activity records to Supabase.
    
    Features:
    - Automatic batching at configurable intervals
    - Offline queue with SQLite persistence
    - Retry logic with exponential backoff
    - Server-side AI analysis triggering
    - Thread-safe operations
    """
    
    def __init__(self, supabase_client, db_manager, config: Optional[BatchUploadConfig] = None):
        """
        Initialize batch uploader.
        
        Args:
            supabase_client: Supabase client instance
            db_manager: SQLiteManager instance for local storage
            config: Optional configuration overrides
        """
        self.supabase = supabase_client
        self.db = db_manager
        self.config = config or BatchUploadConfig()
        
        self._upload_lock = threading.Lock()
        self._running = False
        self._upload_thread: Optional[threading.Thread] = None
        self._last_upload_time = datetime.now(timezone.utc)
        
        # Callbacks
        self._on_upload_complete: Optional[Callable[[BatchResult], None]] = None
        self._on_upload_error: Optional[Callable[[str], None]] = None
    
    def set_callbacks(self, 
                     on_complete: Optional[Callable[[BatchResult], None]] = None,
                     on_error: Optional[Callable[[str], None]] = None):
        """Set callback functions for upload events"""
        self._on_upload_complete = on_complete
        self._on_upload_error = on_error
    
    def queue_activity_record(self, record: Dict[str, Any]) -> int:
        """
        Queue an activity record for batch upload.
        
        Args:
            record: Activity record with OCR text (NOT image)
            
        Returns:
            Record ID in local database
        """
        # Ensure required fields
        required = ['user_id', 'start_time', 'end_time', 'duration_seconds', 'work_date']
        for field in required:
            if field not in record:
                raise ValueError(f"Missing required field: {field}")
        
        return self.db.insert_activity_record(record)
    
    def create_activity_record_from_session(self, 
                                           user_id: str,
                                           window_title: str,
                                           app_name: str,
                                           start_time: datetime,
                                           end_time: datetime,
                                           ocr_text: str,
                                           ocr_method: str,
                                           ocr_confidence: float,
                                           classification: str = None,
                                           organization_id: str = None,
                                           user_timezone: str = None,
                                           project_key: str = None,
                                           user_assigned_issues: List[str] = None) -> Dict:
        """Create a properly formatted activity record from session data"""
        duration = int((end_time - start_time).total_seconds())
        work_date = start_time.strftime('%Y-%m-%d')
        
        return {
            'user_id': user_id,
            'organization_id': organization_id,
            'window_title': window_title,
            'application_name': app_name,
            'ocr_text': ocr_text,
            'ocr_method': ocr_method,
            'ocr_confidence': ocr_confidence,
            'classification': classification,
            'start_time': start_time.isoformat(),
            'end_time': end_time.isoformat(),
            'duration_seconds': duration,
            'work_date': work_date,
            'user_timezone': user_timezone,
            'project_key': project_key,
            'user_assigned_issues': user_assigned_issues,
        }
    
    def start_auto_upload(self):
        """Start automatic batch upload thread"""
        if self._running:
            return
        
        self._running = True
        self._upload_thread = threading.Thread(target=self._upload_loop, daemon=True)
        self._upload_thread.start()
        print(f"[BatchUploader] Started auto-upload (interval: {self.config.batch_interval_seconds}s)")
    
    def stop_auto_upload(self):
        """Stop automatic batch upload thread"""
        self._running = False
        if self._upload_thread:
            self._upload_thread.join(timeout=5.0)
        print("[BatchUploader] Stopped auto-upload")
    
    def _upload_loop(self):
        """Background loop for automatic uploads"""
        while self._running:
            try:
                # Wait for interval
                for _ in range(self.config.batch_interval_seconds * 10):  # Check every 0.1s
                    if not self._running:
                        return
                    asyncio.run(asyncio.sleep(0.1))
                
                # Perform upload
                pending = self.db.get_pending_count()
                if pending > 0:
                    print(f"[BatchUploader] Auto-uploading {pending} pending records...")
                    result = self.upload_batch()
                    if self._on_upload_complete:
                        self._on_upload_complete(result)
                    
            except Exception as e:
                print(f"[BatchUploader] Upload loop error: {e}")
                if self._on_upload_error:
                    self._on_upload_error(str(e))
    
    def upload_batch(self, force: bool = False) -> BatchResult:
        """
        Upload pending activity records to Supabase.
        
        Args:
            force: Upload even if batch is small
            
        Returns:
            BatchResult with upload status
        """
        with self._upload_lock:
            batch_id = str(uuid.uuid4())
            
            # Get pending records
            records = self.db.get_pending_records(limit=self.config.max_batch_size)
            
            if not records:
                return BatchResult(
                    success=True,
                    batch_id=batch_id,
                    records_uploaded=0,
                    records_failed=0,
                )
            
            if not force and len(records) < 5:
                # Wait for more records unless forced
                return BatchResult(
                    success=True,
                    batch_id=batch_id,
                    records_uploaded=0,
                    records_failed=0,
                )
            
            print(f"[BatchUploader] Uploading batch {batch_id} with {len(records)} records")
            
            uploaded_ids = []
            failed_count = 0
            
            try:
                # Prepare records for Supabase
                supabase_records = []
                for record in records:
                    supabase_record = self._prepare_for_supabase(record, batch_id)
                    supabase_records.append(supabase_record)
                
                # Batch insert to Supabase
                response = self.supabase.table('activity_records').insert(supabase_records).execute()
                
                if response.data:
                    uploaded_ids = [r['id'] for r in records]
                    self.db.mark_records_synced(uploaded_ids, batch_id)
                    
                    # Trigger AI analysis for this batch
                    ai_triggered = self._trigger_ai_analysis(batch_id, len(uploaded_ids))
                    
                    self._last_upload_time = datetime.now(timezone.utc)
                    
                    return BatchResult(
                        success=True,
                        batch_id=batch_id,
                        records_uploaded=len(uploaded_ids),
                        records_failed=failed_count,
                        ai_analysis_triggered=ai_triggered,
                    )
                else:
                    raise Exception("No data returned from insert")
                    
            except Exception as e:
                error_msg = str(e)
                print(f"[BatchUploader] Batch upload failed: {error_msg}")
                
                # Mark individual failures
                for record in records:
                    if record['id'] not in uploaded_ids:
                        self.db.mark_record_failed(record['id'], error_msg)
                        failed_count += 1
                
                return BatchResult(
                    success=False,
                    batch_id=batch_id,
                    records_uploaded=len(uploaded_ids),
                    records_failed=failed_count,
                    error_message=error_msg,
                )
    
    def _prepare_for_supabase(self, record: Dict, batch_id: str) -> Dict:
        """Prepare local record for Supabase insertion"""
        # Map local fields to Supabase schema
        return {
            'user_id': record['user_id'],
            'organization_id': record.get('organization_id'),
            'window_title': record.get('window_title'),
            'application_name': record.get('application_name'),
            'ocr_text': record.get('ocr_text'),
            'ocr_method': record.get('ocr_method'),
            'ocr_confidence': record.get('ocr_confidence'),
            'local_classification': record.get('classification'),
            'duration_seconds': record['duration_seconds'],
            'work_date': record['work_date'],
            'start_time': record['start_time'],
            'end_time': record['end_time'],
            'user_timezone': record.get('user_timezone'),
            'project_key': record.get('project_key'),
            'batch_id': batch_id,
            'analysis_status': 'pending',  # Will be analyzed by server
            'created_at': datetime.now(timezone.utc).isoformat(),
        }
    
    def _trigger_ai_analysis(self, batch_id: str, record_count: int) -> bool:
        """Trigger server-side AI analysis for uploaded batch"""
        try:
            # Call server endpoint to trigger analysis
            # This will be processed by a Supabase Edge Function or AI Server
            response = self.supabase.functions.invoke(
                'analyze-activity-batch',
                invoke_options={
                    'body': {
                        'batch_id': batch_id,
                        'record_count': record_count,
                    }
                }
            )
            print(f"[BatchUploader] AI analysis triggered for batch {batch_id}")
            return True
        except Exception as e:
            # Non-fatal - analysis can be triggered later
            print(f"[BatchUploader] Could not trigger AI analysis: {e}")
            return False
    
    def upload_sessions(self, session_tracker, user_info: Dict) -> BatchResult:
        """
        Convert aggregated sessions to activity records and upload.
        
        Args:
            session_tracker: ActiveSessionTracker instance with accumulated sessions
            user_info: Dict with user_id, organization_id, timezone, etc.
            
        Returns:
            BatchResult with upload status
        """
        sessions = session_tracker.get_sessions_for_upload()
        
        if not sessions:
            return BatchResult(
                success=True,
                batch_id='',
                records_uploaded=0,
                records_failed=0,
            )
        
        now = datetime.now(timezone.utc)
        
        # Convert sessions to activity records
        for session in sessions:
            # Calculate time window
            duration = int(session['total_time_seconds'])
            if duration < 3:  # Skip very short sessions
                continue
            
            # Use last_seen as end time, calculate start
            end_time = datetime.fromisoformat(session['last_seen'].replace('Z', '+00:00'))
            start_time = end_time - timedelta(seconds=duration)
            
            record = self.create_activity_record_from_session(
                user_id=user_info['user_id'],
                window_title=session['window_title'],
                app_name=session['application_name'],
                start_time=start_time,
                end_time=end_time,
                ocr_text=session.get('ocr_text', ''),
                ocr_method=session.get('ocr_method', 'none'),
                ocr_confidence=session.get('ocr_confidence', 0.0),
                classification=session.get('classification'),
                organization_id=user_info.get('organization_id'),
                user_timezone=user_info.get('timezone'),
                project_key=user_info.get('project_key'),
                user_assigned_issues=user_info.get('assigned_issues'),
            )
            
            self.queue_activity_record(record)
        
        # Reset session tracker
        session_tracker.reset_after_upload()
        
        # Upload the batch
        return self.upload_batch(force=True)
    
    def get_status(self) -> Dict:
        """Get uploader status"""
        return {
            'running': self._running,
            'pending_count': self.db.get_pending_count(),
            'last_upload': self._last_upload_time.isoformat(),
            'batch_interval_seconds': self.config.batch_interval_seconds,
        }
    
    def force_upload_now(self) -> BatchResult:
        """Force immediate upload of all pending records"""
        return self.upload_batch(force=True)
    
    def cleanup(self, days: int = 7):
        """Cleanup old synced records"""
        self.db.cleanup_old_synced_records(days)
