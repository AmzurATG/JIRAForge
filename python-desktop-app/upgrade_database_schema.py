"""
Script to upgrade the local SQLite database schema.
Adds the missing tables: app_classifications_cache and active_sessions
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from db_connection import DatabaseConnectionManager

def get_app_data_dir():
    """Get the application data directory"""
    if sys.platform == 'win32':
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    else:
        app_data = os.path.expanduser('~/.local/share')
    
    app_dir = os.path.join(app_data, 'TimeTracker')
    return app_dir

def upgrade_database():
    """Add missing tables to existing database"""
    db_path = os.path.join(get_app_data_dir(), 'time_tracker_offline.db')
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found: {db_path}")
        print("   Run the desktop app first to create the database.")
        return False
    
    print(f"🔧 Upgrading database: {db_path}")
    print()
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()

    # Check existing tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    existing_tables = [row[0] for row in cursor.fetchall()]
    print(f"📋 Existing tables: {', '.join(existing_tables)}")
    print()
    
    tables_added = []
    
    # Add app_classifications_cache table
    if 'app_classifications_cache' not in existing_tables:
        print("✨ Creating table: app_classifications_cache")
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
        tables_added.append('app_classifications_cache')
    else:
        print("✓ Table already exists: app_classifications_cache")
    
    # Add active_sessions table
    if 'active_sessions' not in existing_tables:
        print("✨ Creating table: active_sessions")
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
        tables_added.append('active_sessions')
    else:
        print("✓ Table already exists: active_sessions")
    
    conn.commit()
    conn.close()
    
    print()
    if tables_added:
        print(f"✅ Database upgraded successfully! Added {len(tables_added)} table(s):")
        for table in tables_added:
            print(f"   • {table}")
    else:
        print("✅ Database is already up to date!")
    
    return True

if __name__ == '__main__':
    print("=" * 70)
    print("  SQLite Database Schema Upgrade")
    print("=" * 70)
    print()
    
    try:
        success = upgrade_database()
        if success:
            print()
            print("💡 Tip: Run 'python view_sqlite_db.py' to verify the new tables")
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
