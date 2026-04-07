"""
Standalone script to create SQLite tables for offline activity tracking
Run this script to create all required tables WITHOUT running the full desktop app
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from db_connection import DatabaseConnectionManager

def get_app_data_dir():
    """Get application data directory"""
    app_data = os.getenv('APPDATA')
    app_dir = os.path.join(app_data, 'TimeTracker')
    return app_dir

def create_tables():
    """Create all required SQLite tables"""
    
    # Ensure directory exists
    app_dir = get_app_data_dir()
    if not os.path.exists(app_dir):
        os.makedirs(app_dir)
        print(f"✅ Created directory: {app_dir}")
    
    db_path = os.path.join(app_dir, 'time_tracker_offline.db')
    print(f"📁 Database path: {db_path}")
    
    # Connect to database (auto-detects encrypted vs plaintext)
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()
    
    print("\n" + "=" * 60)
    print("Creating tables...")
    print("=" * 60)
    
    # ========================================================================
    # TABLE 1: active_sessions (Event-based activity tracking)
    # ========================================================================
    print("\n1️⃣  Creating 'active_sessions' table...")
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            window_title TEXT,
            application_name TEXT,
            classification TEXT,
            ocr_text TEXT,
            ocr_method TEXT,
            ocr_confidence REAL,
            ocr_error_message TEXT,
            total_time_seconds REAL DEFAULT 0,
            visit_count INTEGER DEFAULT 1,
            first_seen TEXT,
            last_seen TEXT,
            timer_started_at TEXT,
            UNIQUE(window_title, application_name)
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_active_sessions_app 
        ON active_sessions(application_name)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_active_sessions_classification 
        ON active_sessions(classification)
    ''')
    
    print("   ✅ Table 'active_sessions' created with indexes")
    print("   ✅ OCR_TEXT column included!")
    
    # ========================================================================
    # TABLE 2: app_classifications_cache (App classification rules)
    # ========================================================================
    print("\n2️⃣  Creating 'app_classifications_cache' table...")
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS app_classifications_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT,
            project_key TEXT,
            identifier TEXT NOT NULL,
            display_name TEXT,
            classification TEXT NOT NULL,
            match_by TEXT NOT NULL,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(organization_id, project_key, identifier, match_by)
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_app_class_cache_identifier
        ON app_classifications_cache(identifier)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_app_class_cache_match_by
        ON app_classifications_cache(match_by)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_app_class_cache_classification 
        ON app_classifications_cache(classification)
    ''')
    
    print("   ✅ Table 'app_classifications_cache' created with indexes")
    
    # ========================================================================
    # TABLE 3: offline_screenshots (Offline backup/sync)
    # ========================================================================
    print("\n3️⃣  Creating 'offline_screenshots' table...")
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS offline_screenshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            timestamp TEXT NOT NULL,
            storage_path TEXT,
            window_title TEXT,
            application_name TEXT,
            file_size_bytes INTEGER,
            start_time TEXT,
            end_time TEXT,
            duration_seconds INTEGER,
            project_key TEXT,
            user_assigned_issues TEXT,
            metadata TEXT,
            image_data BLOB,
            thumbnail_data BLOB,
            synced INTEGER DEFAULT 0,
            sync_attempts INTEGER DEFAULT 0,
            last_sync_error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_offline_screenshots_synced 
        ON offline_screenshots(synced)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_offline_screenshots_user 
        ON offline_screenshots(user_id)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_offline_screenshots_timestamp 
        ON offline_screenshots(timestamp)
    ''')
    
    print("   ✅ Table 'offline_screenshots' created with indexes")
    
    # ========================================================================
    # TABLE 4: project_settings_cache (Project settings cache)
    # ========================================================================
    print("\n4️⃣  Creating 'project_settings_cache' table...")
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS project_settings_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            project_key TEXT NOT NULL,
            project_name TEXT,
            tracked_statuses TEXT,
            cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(organization_id, project_key)
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_project_settings_org 
        ON project_settings_cache(organization_id)
    ''')
    
    print("   ✅ Table 'project_settings_cache' created with indexes")
    
    # Commit changes
    conn.commit()
    
    # Verify tables were created
    print("\n" + "=" * 60)
    print("Verifying tables...")
    print("=" * 60)
    
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = cursor.fetchall()
    
    print(f"\n✅ {len(tables)} tables created:")
    for table in tables:
        print(f"   - {table[0]}")
    
    # Show active_sessions schema to confirm ocr_text column
    print("\n" + "=" * 60)
    print("active_sessions schema (confirming ocr_text column):")
    print("=" * 60)
    cursor.execute("PRAGMA table_info(active_sessions)")
    columns = cursor.fetchall()
    
    ocr_text_found = False
    for col in columns:
        col_id, name, col_type, not_null, default, pk = col
        if name == 'ocr_text':
            print(f"   ✅ {name:20s} {col_type:10s} ← OCR TEXT COLUMN")
            ocr_text_found = True
        else:
            print(f"   - {name:20s} {col_type:10s}")
    
    if not ocr_text_found:
        print("\n   ❌ WARNING: ocr_text column not found!")
    else:
        print("\n   ✅ OCR text column confirmed!")
    
    conn.close()
    
    print("\n" + "=" * 60)
    print("✅ SUCCESS! All tables created successfully!")
    print("=" * 60)
    print(f"\nDatabase location: {db_path}")
    print("\nYou can now:")
    print("  1. Run the desktop app: python desktop_app.py")
    print("  2. Verify tables: python verify_sqlite_tables.py")
    print("  3. Open in SQLite browser to inspect")
    
    return db_path

if __name__ == "__main__":
    try:
        db_path = create_tables()
        print("\n🎉 Done!")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
