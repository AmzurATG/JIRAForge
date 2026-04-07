"""
DATABASE INSPECTOR - Quick Data Viewer
=======================================

Simple script to inspect current state of SQLite and Supabase databases.
Use this for quick checks without running full tests.

USAGE:
    python inspect_databases.py              # Show current state
    python inspect_databases.py --watch      # Auto-refresh every 10 seconds
    python inspect_databases.py --detailed   # Show full record details
"""

import os
import sys
import time
import json
import argparse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from db_connection import DatabaseConnectionManager
from pathlib import Path

try:
    from supabase import create_client
    from dotenv import load_dotenv
except ImportError:
    print("ERROR: Missing dependencies. Install with:")
    print("  pip install supabase python-dotenv")
    sys.exit(1)

load_dotenv()


def find_sqlite_db():
    """Find SQLite database"""
    possible_paths = [
        Path.home() / 'AppData' / 'Local' / 'TimeTracker' / 'time_tracker_offline.db',
        Path.home() / '.timetracker' / 'time_tracker_offline.db',
        Path(__file__).parent / 'time_tracker_offline.db',
    ]
    
    for path in possible_paths:
        if path.exists():
            return str(path)
    return None


def get_sqlite_sessions(db_path):
    """Get SQLite active_sessions"""
    if not db_path or not os.path.exists(db_path):
        return None
    
    try:
        conn = DatabaseConnectionManager.open_diagnostic_connection(db_path)
        cursor = conn.cursor()

        cursor.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='active_sessions'
        """)
        
        if not cursor.fetchone():
            conn.close()
            return []
        
        cursor.execute("SELECT * FROM active_sessions ORDER BY last_seen DESC")
        columns = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()
        conn.close()
        
        return [dict(zip(columns, row)) for row in rows]
    except Exception as e:
        print(f"Error reading SQLite: {e}")
        return None


def get_supabase_records(limit=10):
    """Get recent Supabase activity_records"""
    url = os.getenv('SUPABASE_URL')
    key = os.getenv('SUPABASE_SERVICE_KEY') or os.getenv('SUPABASE_KEY')
    
    if not url or not key:
        return None
    
    try:
        client = create_client(url, key)
        result = client.table('activity_records').select('*').order(
            'created_at', desc=True
        ).limit(limit).execute()
        return result.data if result.data else []
    except Exception as e:
        print(f"Error reading Supabase: {e}")
        return None


def display_sqlite_sessions(sessions, detailed=False):
    """Display SQLite sessions"""
    print("\n" + "="*80)
    print("  📊 SQLITE active_sessions TABLE")
    print("="*80)
    
    if sessions is None:
        print("  ❌ Could not read SQLite database")
        return
    
    if not sessions:
        print("  ✓ Table is empty (no active sessions)")
        return
    
    print(f"  ✓ Found {len(sessions)} active session(s)\n")
    
    for i, session in enumerate(sessions, 1):
        window_title = session.get('window_title', 'N/A')
        app_name = session.get('application_name', 'N/A')
        classification = session.get('classification', 'unknown')
        time_seconds = session.get('total_time_seconds', 0)
        visit_count = session.get('visit_count', 0)
        ocr_method = session.get('ocr_method') or 'none'
        first_seen = session.get('first_seen', 'N/A')[:19]
        last_seen = session.get('last_seen', 'N/A')[:19]
        
        print(f"  [{i}] {window_title[:60]}")
        print(f"      App: {app_name}")
        print(f"      Classification: {classification} | OCR Method: {ocr_method}")
        print(f"      Time: {int(time_seconds)}s | Visits: {visit_count}")
        print(f"      First Seen: {first_seen} | Last Seen: {last_seen}")
        
        if detailed:
            ocr_text = session.get('ocr_text', '')
            if ocr_text:
                preview = ocr_text[:100].replace('\n', ' ')
                print(f"      OCR Text: {preview}{'...' if len(ocr_text) > 100 else ''}")
            
            ocr_confidence = session.get('ocr_confidence')
            if ocr_confidence:
                print(f"      OCR Confidence: {ocr_confidence:.2f}")
        
        print()


def display_supabase_records(records, detailed=False):
    """Display Supabase records"""
    print("\n" + "="*80)
    print("  ☁️  SUPABASE activity_records TABLE (Recent)")
    print("="*80)
    
    if records is None:
        print("  ❌ Could not read Supabase database")
        return
    
    if not records:
        print("  ✓ No recent records found")
        return
    
    print(f"  ✓ Found {len(records)} recent record(s)\n")
    
    for i, record in enumerate(records, 1):
        window_title = record.get('window_title', 'N/A')
        app_name = record.get('application_name', 'N/A')
        classification = record.get('classification', 'unknown')
        duration = record.get('duration_seconds', 0)
        status = record.get('status', 'unknown')
        batch_time = record.get('batch_timestamp', 'N/A')[:19]
        created_at = record.get('created_at', 'N/A')[:19]
        
        print(f"  [{i}] {window_title[:60]}")
        print(f"      App: {app_name}")
        print(f"      Classification: {classification} | Status: {status}")
        print(f"      Duration: {duration}s | Batch: {batch_time}")
        print(f"      Created: {created_at}")
        
        if detailed:
            # Show Jira context
            user_issues = record.get('user_assigned_issues')
            if user_issues:
                try:
                    issues = json.loads(user_issues) if isinstance(user_issues, str) else user_issues
                    issue_keys = [issue.get('key') for issue in issues]
                    print(f"      Jira Issues: {', '.join(issue_keys)}")
                except:
                    pass
            
            # Show OCR preview
            ocr_text = record.get('ocr_text', '')
            if ocr_text:
                preview = ocr_text[:100].replace('\n', ' ')
                print(f"      OCR Text: {preview}{'...' if len(ocr_text) > 100 else ''}")
            
            # Show project
            project_key = record.get('project_key')
            if project_key:
                print(f"      Project: {project_key}")
        
        print()


def inspect_databases(detailed=False):
    """Inspect both databases"""
    print("\n╔════════════════════════════════════════════════════════════════════════════╗")
    print("║                         DATABASE INSPECTOR                                 ║")
    print("╚════════════════════════════════════════════════════════════════════════════╝")
    
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f"\n  Inspection Time: {timestamp}")
    
    # SQLite
    db_path = find_sqlite_db()
    if db_path:
        print(f"  SQLite DB: {os.path.basename(db_path)}")
    else:
        print("  SQLite DB: Not found")
    
    sessions = get_sqlite_sessions(db_path)
    display_sqlite_sessions(sessions, detailed)
    
    # Supabase
    records = get_supabase_records(limit=10)
    display_supabase_records(records, detailed)
    
    # Summary
    print("\n" + "="*80)
    print("  📊 SUMMARY")
    print("="*80)
    
    session_count = len(sessions) if sessions else 0
    record_count = len(records) if records else 0
    
    print(f"\n  Active Sessions (SQLite): {session_count}")
    print(f"  Recent Records (Supabase): {record_count}")
    
    if session_count > 0:
        total_time = sum(s.get('total_time_seconds', 0) for s in sessions)
        print(f"  Total Active Time: {int(total_time)}s ({int(total_time/60)} min)")
    
    if record_count > 0:
        total_duration = sum(r.get('duration_seconds', 0) for r in records)
        print(f"  Total Recorded Duration: {int(total_duration)}s ({int(total_duration/60)} min)")
        
        # Status breakdown
        pending = sum(1 for r in records if r.get('status') == 'pending')
        analyzed = sum(1 for r in records if r.get('status') == 'analyzed')
        print(f"  Status: {pending} pending, {analyzed} analyzed")
    
    print()


def watch_databases(detailed=False, interval=10):
    """Watch databases with auto-refresh"""
    print("\n🔄 WATCH MODE - Auto-refreshing every {} seconds (Ctrl+C to stop)\n".format(interval))
    
    try:
        while True:
            # Clear screen (Windows and Unix)
            os.system('cls' if os.name == 'nt' else 'clear')
            
            inspect_databases(detailed)
            
            print(f"  Next refresh in {interval} seconds... (Ctrl+C to stop)")
            time.sleep(interval)
    
    except KeyboardInterrupt:
        print("\n\n✓ Watch mode stopped")


def main():
    parser = argparse.ArgumentParser(
        description='Inspect SQLite and Supabase databases',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python inspect_databases.py              # Show current state
  python inspect_databases.py --watch      # Auto-refresh every 10 seconds
  python inspect_databases.py --detailed   # Show full details
  python inspect_databases.py --watch --detailed --interval 5
        """
    )
    
    parser.add_argument(
        '--watch',
        action='store_true',
        help='Watch mode: auto-refresh display'
    )
    
    parser.add_argument(
        '--detailed',
        action='store_true',
        help='Show detailed information (OCR text, Jira issues, etc.)'
    )
    
    parser.add_argument(
        '--interval',
        type=int,
        default=10,
        help='Refresh interval in seconds (default: 10)'
    )
    
    args = parser.parse_args()
    
    if args.watch:
        watch_databases(detailed=args.detailed, interval=args.interval)
    else:
        inspect_databases(detailed=args.detailed)


if __name__ == '__main__':
    main()
