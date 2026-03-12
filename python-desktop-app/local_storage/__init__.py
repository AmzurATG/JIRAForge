"""Local Storage Module for Hybrid OCR Approach

Provides local SQLite-based storage for:
- Activity session tracking
- Pending upload records
- Classification cache

This enables:
- Offline operation
- Batch uploads (reducing network overhead)
- Session time accumulation

Components:
- SQLiteManager: SQLite database operations with thread-safe connections
- ActiveSessionTracker: Track active time per window/application
- BatchUploader: Upload activity records to Supabase in batches

Usage:
    from local_storage import SQLiteManager, ActiveSessionTracker, BatchUploader
    
    # Get database manager (singleton)
    db = SQLiteManager.get_instance()
    
    # Create session tracker
    tracker = ActiveSessionTracker(db)
    
    # Create batch uploader
    uploader = BatchUploader(supabase_client, db)
    uploader.start_auto_upload()
"""

from .sqlite_manager import SQLiteManager, get_linux_app_data_dir
from .session_tracker import ActiveSessionTracker, ActiveWindow, SessionStats
from .batch_uploader import BatchUploader, BatchUploadConfig, BatchResult

__all__ = [
    # Main classes
    'SQLiteManager',
    'ActiveSessionTracker',
    'BatchUploader',
    
    # Data classes
    'ActiveWindow',
    'SessionStats',
    'BatchUploadConfig',
    'BatchResult',
    
    # Utilities
    'get_linux_app_data_dir',
]
