"""
SQLite Database Viewer

View tables and data in the local time_tracker_offline.db database.

Usage:
    python view_sqlite_db.py                           # List all tables
    python view_sqlite_db.py --table active_sessions   # View specific table
    python view_sqlite_db.py --schema                  # Show table schemas
    python view_sqlite_db.py --stats                   # Show database statistics
"""

import os
import sys
import sqlite3
import argparse
from datetime import datetime

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

def get_db_path():
    """Get the database file path"""
    db_path = os.path.join(get_app_data_dir(), 'time_tracker_offline.db')
    return db_path

def list_tables(db_path):
    """List all tables in the database"""
    print("\n" + "=" * 70)
    print("  SQLITE DATABASE TABLES")
    print("=" * 70)
    print(f"Database: {db_path}\n")
    
    if not os.path.exists(db_path):
        print("❌ Database file not found!")
        print(f"Expected location: {db_path}")
        print("\nRun the desktop app first to create the database.")
        return
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()
    
    # Get all tables
    cursor.execute("""
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        ORDER BY name
    """)
    
    tables = cursor.fetchall()
    
    if not tables:
        print("No tables found in database.")
        conn.close()
        return
    
    print(f"Found {len(tables)} table(s):\n")
    
    for (table_name,) in tables:
        # Get row count
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        count = cursor.fetchone()[0]
        
        print(f"  📊 {table_name:<40} {count:>6} rows")
    
    conn.close()
    print("\n" + "=" * 70)

def show_table_schema(db_path, table_name=None):
    """Show schema for all tables or specific table"""
    print("\n" + "=" * 70)
    print("  TABLE SCHEMAS")
    print("=" * 70)
    print(f"Database: {db_path}\n")
    
    if not os.path.exists(db_path):
        print("❌ Database file not found!")
        return
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()
    
    # Get tables to show
    if table_name:
        tables = [(table_name,)]
    else:
        cursor.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='table' 
            ORDER BY name
        """)
        tables = cursor.fetchall()
    
    for (tbl,) in tables:
        print(f"\n📋 Table: {tbl}")
        print("-" * 70)
        
        # Get table schema
        cursor.execute(f"PRAGMA table_info({tbl})")
        columns = cursor.fetchall()
        
        if not columns:
            print(f"  ⚠ Table '{tbl}' not found")
            continue
        
        print(f"{'Column':<25} {'Type':<15} {'Null':<8} {'Key':<8} {'Default'}")
        print("-" * 70)
        
        for col in columns:
            cid, name, col_type, not_null, default_val, pk = col
            null_str = "NOT NULL" if not_null else "NULL"
            pk_str = "PK" if pk else ""
            default_str = str(default_val) if default_val else ""
            
            print(f"{name:<25} {col_type:<15} {null_str:<8} {pk_str:<8} {default_str}")
    
    conn.close()
    print("\n" + "=" * 70)

def view_table_data(db_path, table_name, limit=10):
    """View data from a specific table"""
    print("\n" + "=" * 70)
    print(f"  TABLE: {table_name}")
    print("=" * 70)
    print(f"Database: {db_path}\n")
    
    if not os.path.exists(db_path):
        print("❌ Database file not found!")
        return
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()
    
    try:
        # Get column names
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = cursor.fetchall()
        
        if not columns:
            print(f"❌ Table '{table_name}' not found!")
            conn.close()
            return
        
        col_names = [col[1] for col in columns]
        
        # Get row count
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        total_count = cursor.fetchone()[0]
        
        # Get data
        cursor.execute(f"SELECT * FROM {table_name} ORDER BY rowid DESC LIMIT {limit}")
        rows = cursor.fetchall()
        
        print(f"Total rows: {total_count}")
        print(f"Showing: {len(rows)} most recent row(s)\n")
        
        if not rows:
            print("No data in table.")
            conn.close()
            return
        
        # Print header
        print("-" * 70)
        for col in col_names:
            print(f"{col:<20}", end=" ")
        print("\n" + "-" * 70)
        
        # Print rows
        for row in rows:
            for i, value in enumerate(row):
                # Truncate long values
                str_val = str(value)
                if len(str_val) > 18:
                    str_val = str_val[:15] + "..."
                print(f"{str_val:<20}", end=" ")
            print()
        
        print("-" * 70)
        
        if total_count > limit:
            print(f"\n(Showing {limit} of {total_count} rows. Use --limit to show more)")
    
    except sqlite3.OperationalError as e:
        print(f"❌ Error: {e}")
    finally:
        conn.close()
    
    print("=" * 70)

def show_stats(db_path):
    """Show database statistics"""
    print("\n" + "=" * 70)
    print("  DATABASE STATISTICS")
    print("=" * 70)
    print(f"Database: {db_path}\n")
    
    if not os.path.exists(db_path):
        print("❌ Database file not found!")
        return
    
    # File size
    file_size = os.path.getsize(db_path)
    file_size_kb = file_size / 1024
    file_size_mb = file_size_kb / 1024
    
    print(f"📁 File Size: {file_size_mb:.2f} MB ({file_size_kb:.0f} KB)")
    
    # Last modified
    mod_time = os.path.getmtime(db_path)
    mod_date = datetime.fromtimestamp(mod_time).strftime('%Y-%m-%d %H:%M:%S')
    print(f"🕐 Last Modified: {mod_date}\n")
    
    conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
    cursor = conn.cursor()
    
    # Table statistics
    cursor.execute("""
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        ORDER BY name
    """)
    
    tables = cursor.fetchall()
    
    print(f"📊 Total Tables: {len(tables)}\n")
    print("Table Details:")
    print("-" * 70)
    
    total_rows = 0
    for (table_name,) in tables:
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        count = cursor.fetchone()[0]
        total_rows += count
        
        print(f"  {table_name:<35} {count:>10} rows")
    
    print("-" * 70)
    print(f"  {'TOTAL':<35} {total_rows:>10} rows")
    
    conn.close()
    print("\n" + "=" * 70)

def main():
    parser = argparse.ArgumentParser(
        description='View SQLite database tables and data',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        '--table',
        help='View data from specific table'
    )
    parser.add_argument(
        '--schema',
        action='store_true',
        help='Show table schemas'
    )
    parser.add_argument(
        '--stats',
        action='store_true',
        help='Show database statistics'
    )
    parser.add_argument(
        '--limit',
        type=int,
        default=10,
        help='Limit number of rows to display (default: 10)'
    )
    parser.add_argument(
        '--db-path',
        help='Custom database path (default: LocalAppData/TimeTracker/time_tracker_offline.db)'
    )
    
    args = parser.parse_args()
    
    # Get database path
    db_path = args.db_path or get_db_path()
    
    # Execute requested action
    if args.stats:
        show_stats(db_path)
    elif args.schema:
        if args.table:
            show_table_schema(db_path, args.table)
        else:
            show_table_schema(db_path)
    elif args.table:
        view_table_data(db_path, args.table, args.limit)
    else:
        # Default: list all tables
        list_tables(db_path)
        print("\nTip: Use --table <name> to view table data")
        print("     Use --schema to see table structures")
        print("     Use --stats for database statistics\n")

if __name__ == '__main__':
    main()
