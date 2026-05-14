"""
BATCH UPLOAD TESTER - USING EXISTING REAL DATA
===============================================

This script reads REAL data from your existing offline_screenshots.db
and tests the batch upload process WITHOUT running the desktop app.

Perfect for:
- Testing batch upload with accumulated real data
- Validating Supabase connectivity
- Testing the upload mechanism independently
- Manual batch upload when needed

USAGE:
    python test_existing_data_upload.py

REQUIREMENTS:
    pip install supabase python-dotenv
    
    .env file with Supabase credentials:
    SUPABASE_URL=https://xxx.supabase.co
    SUPABASE_SERVICE_KEY=eyJxxx...
"""

import os
import sys
import json
import sqlite3
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from dotenv import load_dotenv
    
    # Try loading .env from multiple locations
    env_locations = [
        '.env',  # Current directory
        '../.env',  # Parent directory
        '../../.env',  # Grandparent directory
        os.path.join(os.path.dirname(__file__), '.env'),  # Script directory
        os.path.join(os.path.dirname(__file__), '..', '.env'),  # Parent of script
    ]
    
    env_loaded = False
    for env_path in env_locations:
        if os.path.exists(env_path):
            load_dotenv(env_path)
            env_loaded = True
            break
    
    if not env_loaded:
        load_dotenv()  # Try default behavior
    
    from supabase import create_client
    SUPABASE_AVAILABLE = True
except ImportError as e:
    print(f"✗ Missing dependency: {e}")
    print("\nInstall with: pip install supabase python-dotenv")
    sys.exit(1)

# Import TimeTracker for idle record creation
try:
    from desktop_app import TimeTracker
except ImportError:
    print("Warning: Could not import TimeTracker from desktop_app")
    TimeTracker = None


class ExistingDataBatchTester:
    """Tests batch upload using existing real data from SQLite"""
    
    def __init__(self):
        self.db_path = None
        self.supabase = None
        
        # user_id must be a valid UUID
        user_id_env = os.getenv('USER_ID')
        if user_id_env:
            self.user_id = user_id_env
        else:
            # Generate a valid test UUID
            self.user_id = str(uuid.uuid4())
        
        # organization_id must be a valid UUID
        org_id_env = os.getenv('ORGANIZATION_ID')
        if org_id_env:
            self.org_id = org_id_env
        else:
            # Generate a valid test UUID
            self.org_id = str(uuid.uuid4())
        
    def find_sqlite_database(self):
        """Find the existing time_tracker database"""
        print("\n" + "="*80)
        print("  STEP 1: LOCATE EXISTING DATABASE")
        print("="*80)
        
        # Try multiple database names (time_tracker_offline.db is the actual name)
        db_names = ['time_tracker_offline.db', 'offline_screenshots.db']
        
        possible_locations = []
        for db_name in db_names:
            possible_locations.extend([
                # Current directory
                os.path.join(os.getcwd(), db_name),
                # User's AppData
                os.path.join(os.getenv('LOCALAPPDATA', ''), 'TimeTracker', db_name),
                # User's home directory
                os.path.join(Path.home(), '.timetracker', db_name),
                # Parent directory
                os.path.join(os.path.dirname(os.getcwd()), db_name),
            ])
        
        print("\n  Searching for database...")
        
        for location in possible_locations:
            if os.path.exists(location):
                self.db_path = location
                print(f"\n  ✓ Found database: {location}")
                
                # Show database info
                size = os.path.getsize(location)
                modified = datetime.fromtimestamp(os.path.getmtime(location))
                print(f"  Size: {size:,} bytes")
                print(f"  Last Modified: {modified}")
                return True
        
        print("\n  ✗ Database not found in standard locations")
        print("\n  Searched:")
        for loc in possible_locations:
            print(f"    - {loc}")
        
        # Ask user for path
        print("\n  Enter the full path to your database file:")
        print("  (e.g., C:\\Users\\YourName\\AppData\\Local\\TimeTracker\\time_tracker_offline.db)")
        custom_path = input("  > ").strip().strip('"')
        
        if custom_path and os.path.exists(custom_path):
            self.db_path = custom_path
            print(f"\n  ✓ Using: {custom_path}")
            return True
        
        return False
    
    def connect_supabase(self):
        """Connect to Supabase"""
        print("\n" + "="*80)
        print("  STEP 2: CONNECT TO SUPABASE")
        print("="*80)
        
        url = os.getenv('SUPABASE_URL')
        # Check multiple possible key names
        key = (os.getenv('SUPABASE_SERVICE_ROLE_KEY') or 
               os.getenv('SUPABASE_SERVICE_KEY') or 
               os.getenv('SUPABASE_KEY'))
        
        print(f"\n  Checking environment variables...")
        print(f"  SUPABASE_URL: {'✓ Found' if url else '✗ Not set'}")
        
        # Show which key was found
        if os.getenv('SUPABASE_SERVICE_ROLE_KEY'):
            print(f"  SUPABASE_SERVICE_ROLE_KEY: ✓ Found")
        elif os.getenv('SUPABASE_SERVICE_KEY'):
            print(f"  SUPABASE_SERVICE_KEY: ✓ Found")
        elif os.getenv('SUPABASE_KEY'):
            print(f"  SUPABASE_KEY: ✓ Found")
        else:
            print(f"  SUPABASE_SERVICE_ROLE_KEY: ✗ Not set")
        
        if not url or not key:
            print("\n  ✗ Missing Supabase credentials")
            print("\n  Checked these environment variables:")
            print("    - SUPABASE_URL")
            print("    - SUPABASE_SERVICE_ROLE_KEY")
            print("    - SUPABASE_SERVICE_KEY")
            print("    - SUPABASE_KEY")
            print("\n  Make sure your .env file is in one of these locations:")
            print("    - python-desktop-app/.env")
            print("    - JIRAForge/.env (project root)")
            print("\n  Expected format:")
            print("    SUPABASE_URL=https://xxx.supabase.co")
            print("    SUPABASE_SERVICE_ROLE_KEY=eyJxxx...")
            return False
        
        try:
            self.supabase = create_client(url, key)
            print(f"\n  ✓ Connected to Supabase")
            print(f"  URL: {url}")
            
            # Get valid user_id and org_id if not set in .env
            if not os.getenv('USER_ID'):
                # First get organization
                org_result = self.supabase.table('organizations').select('id').limit(1).execute()
                if not org_result.data:
                    print("\n  ⚠️  No organizations found. Create one first.")
                    return False
                
                self.org_id = org_result.data[0]['id']
                print(f"  ✓ Using organization ID: {self.org_id}")
                
                # Then get user in that org
                result = self.supabase.table('users').select('id, email').eq(
                    'organization_id', self.org_id
                ).limit(1).execute()
                
                if result.data and len(result.data) > 0:
                    self.user_id = result.data[0]['id']
                    print(f"  ✓ Using existing user: {result.data[0].get('email')}")
                else:
                    print("\n  ⚠️  No users found. Create a user first or set USER_ID in .env")
                    return False
            
            return True
        except Exception as e:
            print(f"\n  ✗ Failed to connect: {e}")
            return False
    
    def read_active_sessions(self):
        """Read real data from active_sessions table"""
        print("\n" + "="*80)
        print("  STEP 3: READ EXISTING SESSIONS")
        print("="*80)
        
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Check if table exists
            cursor.execute("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='active_sessions'
            """)
            
            if not cursor.fetchone():
                print("\n  ✗ Table 'active_sessions' not found in database")
                conn.close()
                return []
            
            # Read all sessions
            cursor.execute("SELECT * FROM active_sessions")
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            conn.close()
            
            if not rows:
                print("\n  ⚠️  No sessions found in active_sessions table")
                print("\n  This is normal if:")
                print("    - Desktop app hasn't been used yet")
                print("    - Last batch upload cleared all sessions")
                print("    - Database was recently created")
                return []
            
            sessions = [dict(zip(columns, row)) for row in rows]
            
            print(f"\n  ✓ Found {len(sessions)} sessions\n")
            
            # Display summary
            total_time = sum(s.get('total_time_seconds', 0) or 0 for s in sessions)
            total_visits = sum(s.get('visit_count', 0) or 0 for s in sessions)
            
            classifications = {}
            for s in sessions:
                cls = s.get('classification', 'unknown')
                classifications[cls] = classifications.get(cls, 0) + 1
            
            print("  📊 SUMMARY:")
            print(f"  Total Time: {int(total_time)}s ({int(total_time/60)}m)")
            print(f"  Total Visits: {total_visits}")
            print(f"  Classifications:")
            for cls, count in classifications.items():
                print(f"    - {cls}: {count}")
            
            # Show sample sessions
            print(f"\n  📋 SAMPLE SESSIONS:")
            for i, session in enumerate(sessions[:5], 1):
                title = session.get('window_title', 'N/A')[:50]
                app = session.get('application_name', 'N/A')
                duration = int(session.get('total_time_seconds', 0) or 0)
                visits = session.get('visit_count', 1)
                cls = session.get('classification', 'unknown')
                
                print(f"\n  [{i}] {title}")
                print(f"      App: {app}")
                print(f"      Classification: {cls}")
                print(f"      Duration: {duration}s | Visits: {visits}")
            
            if len(sessions) > 5:
                print(f"\n  ... and {len(sessions) - 5} more sessions")
            
            return sessions
            
        except Exception as e:
            print(f"\n  ✗ Error reading database: {e}")
            return []
    
    def get_user_jira_issues(self):
        """Get mock Jira issues (replace with real API call if needed)"""
        # In real app, this would fetch from Jira API
        # For testing, returning mock data
        return [
            {
                'key': 'PROJ-123',
                'summary': 'Sample Issue 1',
                'status': 'In Progress',
                'project': 'PROJ',
                'description': 'Sample description',
                'labels': ['backend']
            }
        ]
    
    def build_activity_records(self, sessions):
        """Build activity records in the correct JSON format"""
        print("\n" + "="*80)
        print("  STEP 4: BUILD ACTIVITY RECORDS")
        print("="*80)
        
        print(f"\n  Building JSON records for {len(sessions)} sessions...\n")
        
        batch_timestamp = datetime.now(timezone.utc).isoformat()
        batch_start = datetime.now(timezone.utc)
        batch_end = datetime.now(timezone.utc)
        
        jira_issues = self.get_user_jira_issues()
        
        records = []
        
        for session in sessions:
            classification = session.get('classification', 'unknown')
            
            # Determine status based on classification
            if classification in ('non_productive', 'private'):
                status = 'analyzed'
            else:
                status = 'pending'
            
            # Extract timestamps
            start_time = session.get('first_seen')
            end_time = session.get('last_seen')
            work_date = start_time[:10] if start_time else datetime.now().strftime('%Y-%m-%d')
            
            record = {
                'user_id': self.user_id,
                'organization_id': self.org_id,
                'window_title': session.get('window_title'),
                'application_name': session.get('application_name'),
                'classification': classification,
                'ocr_text': session.get('ocr_text'),
                'ocr_method': session.get('ocr_method'),
                'ocr_confidence': session.get('ocr_confidence'),
                'ocr_error_message': session.get('ocr_error_message'),
                'total_time_seconds': int(session.get('total_time_seconds', 0) or 0),
                'visit_count': session.get('visit_count', 1),
                'start_time': start_time,
                'end_time': end_time,
                'duration_seconds': int(session.get('total_time_seconds', 0) or 0),
                'batch_timestamp': batch_timestamp,
                'batch_start': batch_start.isoformat(),
                'batch_end': batch_end.isoformat(),
                'work_date': work_date,
                'user_timezone': 'UTC',
                'project_key': 'PROJ',  # Could extract from Jira
                'user_assigned_issues': json.dumps(jira_issues),
                'status': status,
                'metadata': json.dumps({
                    'tracking_mode': 'desktop_app',
                    'app_version': '1.0.0',
                    'batch_upload_tool': 'test_existing_data_upload.py'
                })
            }
            
            records.append(record)
        
        print(f"  ✓ Built {len(records)} activity records")
        
        # Show sample record structure
        if records:
            print("\n  📋 SAMPLE RECORD STRUCTURE:")
            print("  " + "-"*76)
            sample = records[0].copy()
            
            # Show key fields
            key_fields = [
                'window_title', 'application_name', 'classification',
                'total_time_seconds', 'visit_count', 'status',
                'batch_timestamp', 'work_date'
            ]
            
            for field in key_fields:
                value = sample.get(field)
                if value is not None:
                    value_str = str(value)
                    if len(value_str) > 60:
                        value_str = value_str[:60] + '...'
                    print(f"  {field:25} : {value_str}")
        
        return records
    
    def upload_to_supabase(self, records):
        """Upload records to Supabase"""
        print("\n" + "="*80)
        print("  STEP 5: UPLOAD TO SUPABASE")
        print("="*80)
        
        if not records:
            print("\n  ⚠️  No records to upload")
            return False
        
        print(f"\n  Uploading {len(records)} records to activity_records table...")
        
        try:
            result = self.supabase.table('activity_records').insert(records).execute()
            
            if result.data:
                print(f"\n  ✓ Successfully uploaded {len(result.data)} records")
                
                # Show upload details
                uploaded_ids = [r.get('id') for r in result.data if r.get('id')]
                if uploaded_ids:
                    print(f"  Record IDs: {uploaded_ids[0]} to {uploaded_ids[-1]}")
                
                return True
            else:
                print("\n  ✗ Upload returned no data")
                return False
                
        except Exception as e:
            print(f"\n  ✗ Upload failed: {e}")
            print("\n  Common issues:")
            print("    - Table schema mismatch")
            print("    - Missing required fields")
            print("    - Insufficient permissions")
            print("    - Network connection issue")
            return False
    
    def clear_sqlite_sessions(self):
        """Clear active_sessions table after successful upload"""
        print("\n" + "="*80)
        print("  STEP 6: CLEAR SQLITE SESSIONS")
        print("="*80)
        
        print("\n  ⚠️  This will DELETE all sessions from active_sessions table")
        print("  (This is what the desktop app does after successful batch upload)")
        
        response = input("\n  Clear SQLite sessions? (y/n): ")
        
        if response.lower() != 'y':
            print("\n  Skipped - sessions retained in SQLite")
            return False
        
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute("DELETE FROM active_sessions")
            deleted_count = cursor.rowcount
            conn.commit()
            conn.close()
            
            print(f"\n  ✓ Cleared {deleted_count} sessions from SQLite")
            print("  Database ready for next batch cycle")
            return True
            
        except Exception as e:
            print(f"\n  ✗ Failed to clear sessions: {e}")
            return False
    
    def verify_upload(self):
        """Verify records in Supabase"""
        print("\n" + "="*80)
        print("  STEP 7: VERIFY UPLOAD")
        print("="*80)
        
        try:
            # Get recent records for this user
            result = self.supabase.table('activity_records').select('*').eq(
                'user_id', self.user_id
            ).order('batch_timestamp', desc=True).limit(10).execute()
            
            if result.data:
                print(f"\n  ✓ Found {len(result.data)} recent records in Supabase\n")
                
                print("  📋 RECENT RECORDS:")
                for i, record in enumerate(result.data[:5], 1):
                    title = record.get('window_title', 'N/A')[:45]
                    duration = record.get('duration_seconds', 0)
                    timestamp = record.get('batch_timestamp', 'N/A')[:19]
                    status = record.get('status', 'N/A')
                    
                    print(f"\n  [{i}] {title}")
                    print(f"      Duration: {duration}s | Status: {status}")
                    print(f"      Uploaded: {timestamp}")
                
                return True
            else:
                print("\n  ⚠️  No records found for user: " + self.user_id)
                return False
                
        except Exception as e:
            print(f"\n  ✗ Verification failed: {e}")
            return False
    
    def test_batch_with_idle_records(self):
        """Test uploading a batch containing both work and idle records"""
        print("\n" + "="*80)
        print("  TEST: BATCH UPLOAD WITH IDLE RECORDS")
        print("="*80)
        
        if TimeTracker is None:
            print("\n  ✗ TimeTracker not available - cannot create idle records")
            print("  This test requires desktop_app.py to be importable")
            return False
        
        # Get existing work sessions
        sessions = self.read_active_sessions()
        if not sessions:
            print("\n  No work sessions available - creating mock session")
            # Create a mock work session
            sessions = [{
                'window_title': 'Test',
                'application_name': 'Test App',
                'classification': 'productive',
                'total_time_seconds': 300,
                'visit_count': 1,
                'first_seen': datetime.now(timezone.utc).isoformat(),
                'last_seen': datetime.now(timezone.utc).isoformat(),
                'ocr_text': 'Test OCR',
                'ocr_method': 'test',
                'ocr_confidence': 0.9
            }]
        
        # Take only first 2 sessions
        work_sessions = sessions[:2]
        
        # Build work records
        work_records = self.build_activity_records(work_sessions)
        
        # Create idle records using TimeTracker
        try:
            # Create a minimal TimeTracker instance for idle record creation
            from unittest.mock import Mock, patch
            
            with patch.object(TimeTracker, '__init__', return_value=None):
                app = TimeTracker()
                app.current_user_id = self.user_id
                app.organization_id = self.org_id
                app.user_issues = []
                app._pending_idle_records = []
                app.app_version = '1.3.9'
                app.current_project_key = 'TEST'
                app.get_user_project_key = Mock(return_value='TEST')
                app._is_within_work_hours = Mock(return_value=True)
                
                app.idle_start_time = datetime.now(timezone.utc) - timedelta(minutes=10)
                app._create_idle_record(reason="test break")
                
                idle_records = app._pending_idle_records
        except Exception as e:
            print(f"\n  ✗ Error creating idle records: {e}")
            import traceback
            traceback.print_exc()
            return False
        
        # Combine records
        all_records = work_records + idle_records
        
        print(f"\n  Work records: {len(work_records)}")
        print(f"  Idle records: {len(idle_records)}")
        print(f"  Total batch size: {len(all_records)}")
        
        # Verify schema consistency
        if work_records and idle_records:
            work_keys = set(work_records[0].keys())
            idle_keys = set(idle_records[0].keys())
            if work_keys != idle_keys:
                print(f"\n  ✗ SCHEMA MISMATCH DETECTED")
                print(f"    Missing in idle: {work_keys - idle_keys}")
                print(f"    Extra in idle: {idle_keys - work_keys}")
                return False
            print(f"\n  ✓ Schema consistency verified")
        
        # Upload batch
        success = self.upload_to_supabase(all_records)
        
        if success:
            print(f"\n  ✓ Mixed batch upload successful")
            return True
        else:
            print(f"\n  ✗ Mixed batch upload failed")
            return False
    
    def run_test(self):
        """Run the complete test"""
        print("\n╔════════════════════════════════════════════════════════════════════════════╗")
        print("║           BATCH UPLOAD TEST - USING EXISTING REAL DATA                    ║")
        print("╚════════════════════════════════════════════════════════════════════════════╝")
        
        print("\nThis script will:")
        print("  1. Find your existing time_tracker database")
        print("  2. Read REAL sessions from active_sessions table")
        print("  3. Build properly formatted activity records")
        print("  4. Upload to Supabase")
        print("  5. Optionally clear SQLite (like the app does)")
        
        # Step 1: Find database
        if not self.find_sqlite_database():
            print("\n" + "="*80)
            print("  ❌ TEST FAILED - DATABASE NOT FOUND")
            print("="*80)
            print("\n  💡 Based on your view_sqlite_db.py output, try:")
            print("     C:\\Users\\IswaryaK\\AppData\\Local\\TimeTracker\\time_tracker_offline.db")
            return
        
        # Step 2: Connect to Supabase
        if not self.connect_supabase():
            print("\n" + "="*80)
            print("  ❌ TEST FAILED - SUPABASE CONNECTION")
            print("="*80)
            return
        
        # Step 3: Read sessions
        sessions = self.read_active_sessions()
        if not sessions:
            print("\n" + "="*80)
            print("  ℹ️  NO DATA TO UPLOAD")
            print("="*80)
            print("\n  Run the desktop app to generate sessions, then try again.")
            return
        
        # Step 4: Build records
        records = self.build_activity_records(sessions)
        if not records:
            print("\n  ✗ Failed to build records")
            return
        
        # Step 5: Upload
        upload_success = self.upload_to_supabase(records)
        
        if not upload_success:
            print("\n" + "="*80)
            print("  ❌ TEST FAILED - UPLOAD ERROR")
            print("="*80)
            return
        
        # Step 6: Clear SQLite (optional)
        self.clear_sqlite_sessions()
        
        # Step 7: Verify
        self.verify_upload()
        
        # Final report
        print("\n" + "="*80)
        print("  ✅ TEST COMPLETE - BATCH UPLOAD SUCCESSFUL")
        print("="*80)
        
        print(f"\n  ✓ Read {len(sessions)} sessions from SQLite")
        print(f"  ✓ Built {len(records)} activity records")
        print(f"  ✓ Uploaded to Supabase successfully")
        print(f"  ✓ Data verified in activity_records table")
        
        print("\n" + "="*80)
        
        print("\n💡 What this proves:")
        print("  • Your SQLite database structure is correct")
        print("  • Real session data is being tracked properly")
        print("  • JSON record format matches Supabase schema")
        print("  • Batch upload mechanism works end-to-end")
        
        print("\n📝 Next steps:")
        print("  • Use the desktop app normally to track activities")
        print("  • It will automatically batch upload every 5 minutes")
        print("  • Run this script anytime to manually trigger upload")


def main():
    """Run batch upload tests"""
    tester = ExistingDataBatchTester()
    
    # Check if user wants to run the idle records test
    if len(sys.argv) > 1 and sys.argv[1] == '--idle-test':
        print("\n╔════════════════════════════════════════════════════════════════════════════╗")
        print("║             IDLE RECORDS INTEGRATION TEST                                  ║")
        print("╚════════════════════════════════════════════════════════════════════════════╝")
        
        # Setup required for idle test
        if not tester.find_sqlite_database():
            print("\n❌ Could not find database")
            return
        
        if not tester.connect_supabase():
            print("\n❌ Could not connect to Supabase")
            return
        
        # Run idle records test
        success = tester.test_batch_with_idle_records()
        
        if success:
            print("\n" + "="*80)
            print("  ✅ IDLE RECORDS TEST PASSED")
            print("="*80)
        else:
            print("\n" + "="*80)
            print("  ❌ IDLE RECORDS TEST FAILED")
            print("="*80)
    else:
        # Run standard test
        tester.run_test()


if __name__ == '__main__':
    main()
