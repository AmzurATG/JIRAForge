"""
Verify SQLite Tables for Offline Activity Tracking
Run this script to check if the tables are properly created
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

def verify_tables():
    """Verify that all required tables exist with correct schema"""
    db_path = os.path.join(get_app_data_dir(), 'time_tracker_offline.db')
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found at: {db_path}")
        print("   Run the desktop app first to create it.")
        return False
    
    print(f"✅ Database found at: {db_path}\n")
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()

    # Check active_sessions table
    print("=" * 60)
    print("Checking 'active_sessions' table...")
    print("=" * 60)
    
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='active_sessions'")
        if cursor.fetchone():
            print("✅ Table 'active_sessions' exists")
            
            # Get column info
            cursor.execute("PRAGMA table_info(active_sessions)")
            columns = cursor.fetchall()
            print("\nColumns:")
            for col in columns:
                col_id, name, col_type, not_null, default, pk = col
                print(f"  - {name:20s} {col_type:10s} {'PRIMARY KEY' if pk else ''}")
            
            # Check if ocr_text column exists
            column_names = [col[1] for col in columns]
            if 'ocr_text' in column_names:
                print("\n✅ OCR_TEXT column exists! OCR data will be stored here.")
            else:
                print("\n❌ OCR_TEXT column missing! Need to add it.")
            
            # Count records
            cursor.execute("SELECT COUNT(*) FROM active_sessions")
            count = cursor.fetchone()[0]
            print(f"\nCurrent records: {count}")
            
        else:
            print("❌ Table 'active_sessions' does NOT exist")
    except Exception as e:
        print(f"❌ Error checking active_sessions: {e}")
    
    # Check app_classifications_cache table
    print("\n" + "=" * 60)
    print("Checking 'app_classifications_cache' table...")
    print("=" * 60)
    
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='app_classifications_cache'")
        if cursor.fetchone():
            print("✅ Table 'app_classifications_cache' exists")
            
            # Get column info
            cursor.execute("PRAGMA table_info(app_classifications_cache)")
            columns = cursor.fetchall()
            print("\nColumns:")
            for col in columns:
                col_id, name, col_type, not_null, default, pk = col
                print(f"  - {name:20s} {col_type:10s} {'PRIMARY KEY' if pk else ''}")
            
            # Count records
            cursor.execute("SELECT COUNT(*) FROM app_classifications_cache")
            count = cursor.fetchone()[0]
            print(f"\nCurrent records: {count}")
            
            if count > 0:
                # Show sample classifications
                cursor.execute("SELECT identifier, classification, match_by FROM app_classifications_cache LIMIT 5")
                print("\nSample classifications:")
                for identifier, classification, match_by in cursor.fetchall():
                    print(f"  - {identifier:30s} {classification:15s} ({match_by})")
        else:
            print("❌ Table 'app_classifications_cache' does NOT exist")
    except Exception as e:
        print(f"❌ Error checking app_classifications_cache: {e}")
    
    # Check offline_screenshots table
    print("\n" + "=" * 60)
    print("Checking 'offline_screenshots' table...")
    print("=" * 60)
    
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_screenshots'")
        if cursor.fetchone():
            print("✅ Table 'offline_screenshots' exists")
            
            # Count records
            cursor.execute("SELECT COUNT(*) FROM offline_screenshots")
            count = cursor.fetchone()[0]
            print(f"Current records: {count}")
            
            # Count pending sync
            cursor.execute("SELECT COUNT(*) FROM offline_screenshots WHERE synced = 0")
            pending = cursor.fetchone()[0]
            print(f"Pending sync: {pending}")
        else:
            print("❌ Table 'offline_screenshots' does NOT exist")
    except Exception as e:
        print(f"❌ Error checking offline_screenshots: {e}")
    
    # List all tables
    print("\n" + "=" * 60)
    print("All tables in database:")
    print("=" * 60)
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    for table in tables:
        print(f"  - {table[0]}")
    
    conn.close()
    print("\n✅ Verification complete!")
    return True

if __name__ == "__main__":
    verify_tables()
