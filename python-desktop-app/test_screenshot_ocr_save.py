"""
Real Test Script: Screenshot → OCR → Supabase Save

This script actually saves data to the activity_records table in Supabase.
Unlike test_screenshot_ocr_flow.py (which only simulates), this one makes real inserts.

Usage:
    python test_screenshot_ocr_save.py
    python test_screenshot_ocr_save.py --mock-productive  # Use mock data
"""

import os
import sys
import argparse
import sqlite3
import requests
from datetime import datetime, timezone
from PIL import ImageGrab, Image, ImageDraw, ImageFont
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import OCR facade
from ocr.text_extractor import extract_text_from_image

# Import Supabase
try:
    from supabase import create_client
except ImportError:
    print("❌ supabase-py not installed")
    print("   Install: pip install supabase")
    sys.exit(1)

# Import the real AppClassificationManager from desktop_app
from desktop_app import AppClassificationManager, get_app_data_dir


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def get_active_window():
    """Get the currently active window title and process name."""
    try:
        import win32gui
        import win32process
        import psutil
        
        # Get active window
        hwnd = win32gui.GetForegroundWindow()
        window_title = win32gui.GetWindowText(hwnd)
        
        # Get process name
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        try:
            process = psutil.Process(pid)
            app_name = process.name()
        except:
            app_name = "unknown.exe"
        
        return window_title, app_name
    except ImportError:
        print("⚠ win32gui/psutil not installed. Install: pip install pywin32 psutil")
        return "Mock Window Title - VSCode", "code.exe"
    except Exception as e:
        print(f"⚠ Could not get active window: {e}")
        return "Mock Window Title - VSCode", "code.exe"


def get_db_path():
    """Get the SQLite database path"""
    return os.path.join(get_app_data_dir(), 'time_tracker_offline.db')


def classify_window(classification_manager, app_name, window_title, ocr_text=None, supabase=None):
    """
    Classify window using the REAL classification logic
    
    Flow:
    1. Check Supabase application_classifications table (central source of truth)
    2. If not found -> Check local app_classifications_cache (SQLite)
    3. If not found -> Try LLM classification via AI server
    4. LLM saves to Supabase application_classifications table
    5. If LLM unavailable -> return 'unknown' (admin will review later)
    
    Args:
        classification_manager: AppClassificationManager instance
        app_name: Process name (e.g., 'Code.exe')
        window_title: Window title
        ocr_text: Optional OCR text for LLM context
        supabase: Optional Supabase client for checking/saving classifications
    
    Returns:
        str: Classification ('productive', 'non_productive', 'private', 'unknown')
    """
    # Get organization ID for filtering
    org_id = os.getenv('TEST_ORGANIZATION_ID')
    
    # Step 1: Check Supabase application_classifications table first
    if supabase:
        try:
            print(f"  🔍 Checking Supabase application_classifications table...")
            
            # Try matching by process name first
            query = supabase.table('application_classifications').select('classification').eq('identifier', app_name).eq('match_by', 'process')
            if org_id:
                query = query.eq('organization_id', org_id)
            
            response = query.limit(1).execute()
            
            if response.data and len(response.data) > 0:
                classification = response.data[0]['classification']
                print(f"  ✓ Found in Supabase: {classification} (match_by: process)")
                return classification
            
            # For browsers, try matching by URL/title
            if any(browser in app_name.lower() for browser in ['chrome', 'firefox', 'edge', 'safari']):
                query = supabase.table('application_classifications').select('classification').eq('identifier', window_title).eq('match_by', 'url')
                if org_id:
                    query = query.eq('organization_id', org_id)
                
                response = query.limit(1).execute()
                
                if response.data and len(response.data) > 0:
                    classification = response.data[0]['classification']
                    print(f"  ✓ Found in Supabase: {classification} (match_by: url)")
                    return classification
            
            print(f"  ⊘ Not found in Supabase application_classifications")
            
        except Exception as e:
            print(f"  ⚠ Error checking Supabase: {e}")
            # Continue to local cache check
    
    # Step 2: Check local cache using AppClassificationManager
    print(f"  🔍 Checking local app_classifications_cache...")
    classification, match_type = classification_manager.classify(app_name, window_title)
    
    if classification != 'unknown':
        print(f"  ✓ Found in local cache: {classification} (match_type: {match_type})")
        return classification
    
    # Step 3: Not in any cache - try LLM classification
    print(f"  ⚠ Not in cache - checking LLM classification")
    
    ai_server_url = os.getenv('AI_SERVER_URL', '')
    if not ai_server_url:
        print(f"  ✗ AI_SERVER_URL not configured - returning 'unknown'")
        return 'unknown'
    
    try:
        # Call AI server for classification
        print(f"  → Sending to AI server: {ai_server_url}/api/classify-app")
        response = requests.post(
            f"{ai_server_url}/api/classify-app",
            json={
                'application_name': app_name,
                'window_title': window_title,
                'ocr_text': ocr_text or ''
            },
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            llm_classification = data.get('classification', 'unknown')
            reasoning = data.get('reasoning', '')
            
            print(f"  ✓ LLM classified as: {llm_classification}")
            if reasoning:
                print(f"    Reasoning: {reasoning[:80]}...")
            
            # Step 3: Save LLM result to Supabase application_classifications table
            if supabase and llm_classification != 'unknown':
                try:
                    # Get organization ID (optional for testing)
                    org_id = os.getenv('TEST_ORGANIZATION_ID')
                    
                    # Determine match_by type
                    match_by = 'url' if 'chrome' in app_name.lower() or 'firefox' in app_name.lower() else 'process'
                    identifier = window_title if match_by == 'url' else app_name
                    
                    classification_record = {
                        'organization_id': org_id,
                        'identifier': identifier,
                        'display_name': window_title[:50] if match_by == 'url' else app_name,
                        'classification': llm_classification,
                        'match_by': match_by,
                        'created_by': 'ai_server'
                    }
                    
                    supabase.table('application_classifications').insert(classification_record).execute()
                    print(f"  ✓ Saved to Supabase application_classifications table")
                    
                    # Also update local cache
                    db_path = get_db_path()
                    conn = sqlite3.connect(db_path)
                    cursor = conn.cursor()
                    cursor.execute('''
                        INSERT OR REPLACE INTO app_classifications_cache
                        (organization_id, project_key, identifier, display_name, classification, match_by)
                        VALUES (?, NULL, ?, ?, ?, ?)
                    ''', (org_id, identifier, classification_record['display_name'], llm_classification, match_by))
                    conn.commit()
                    conn.close()
                    print(f"  ✓ Updated local cache")
                    
                except Exception as e:
                    print(f"  ⚠ Failed to save classification to database: {e}")
            
            return llm_classification
        else:
            print(f"  ✗ AI server returned status {response.status_code}")
            return 'unknown'
            
    except requests.exceptions.Timeout:
        print(f"  ✗ AI server timeout - returning 'unknown'")
        return 'unknown'
    except requests.exceptions.ConnectionError:
        print(f"  ✗ AI server not reachable - returning 'unknown'")
        return 'unknown'
    except Exception as e:
        print(f"  ✗ LLM classification failed: {e}")
        return 'unknown'


def create_mock_screenshot():
    """Create a mock screenshot with text for testing OCR."""
    print("\n📸 Creating mock screenshot...")
    
    # Create image with text
    img = Image.new('RGB', (1920, 1080), color='white')
    draw = ImageDraw.Draw(img)
    
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except:
        font = ImageFont.load_default()
    
    # Draw some text that OCR should detect
    text = """
    Productivity Tracking Test - REAL SAVE
    
    JIRA-123: Implement OCR feature
    - Extract text from screenshots
    - Save to activity_records table
    - Test the complete flow with Supabase
    
    Status: In Progress
    Time: 2 hours 30 minutes
    
    This record will be saved to Supabase!
    """
    
    draw.text((100, 100), text, fill='black', font=font)
    
    return img


def get_supabase_client():
    """Create and return Supabase client"""
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY') or os.getenv('SUPABASE_ANON_KEY')
    
    if not supabase_url or not supabase_key:
        print("\n❌ Supabase credentials not found in .env file")
        print("   Required: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)")
        print("\n   Check your .env file:")
        print("   SUPABASE_URL=https://your-project.supabase.co")
        print("   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key")
        return None
    
    try:
        client = create_client(supabase_url, supabase_key)
        return client
    except Exception as e:
        print(f"\n❌ Failed to create Supabase client: {e}")
        return None


def get_current_user_id(supabase):
    """Get the current user ID (simplified for testing)"""
    # In production, this comes from authentication
    # For testing, we'll try to get it from environment or use a test value
    user_id = os.getenv('TEST_USER_ID')
    
    if not user_id:
        print("\n⚠ TEST_USER_ID not in .env - attempting to fetch from users table...")
        try:
            # Try to get any user from the database
            response = supabase.table('users').select('id').limit(1).execute()
            if response.data and len(response.data) > 0:
                user_id = response.data[0]['id']
                print(f"   Using user ID: {user_id}")
            else:
                print("\n❌ No users found in database. Please:")
                print("   1. Run desktop_app.py to authenticate and create a user, OR")
                print("   2. Add TEST_USER_ID=<your-user-uuid> to .env file")
                return None
        except Exception as e:
            print(f"   Error fetching user: {e}")
            return None
    
    return user_id


def save_to_activity_records(supabase, user_id, window_title, app_name, classification, ocr_result):
    """
    Actually save the activity record to Supabase.
    """
    print("\n💾 Saving to activity_records table in Supabase...")
    print("=" * 70)
    
    # Get organization ID (optional for testing)
    org_id = os.getenv('TEST_ORGANIZATION_ID')
    
    # Build the record (matching the database schema)
    now = datetime.now(timezone.utc)
    record = {
        'user_id': user_id,
        'organization_id': org_id,
        'window_title': window_title,
        'application_name': app_name,
        'classification': classification,
        'ocr_text': ocr_result['text'] if ocr_result else None,
        'ocr_method': ocr_result['method'] if ocr_result else None,
        'ocr_confidence': ocr_result['confidence'] if ocr_result else 0.0,
        'ocr_error_message': ocr_result.get('error_message') if ocr_result else None,
        'total_time_seconds': 0,
        'visit_count': 1,
        'start_time': now.isoformat(),
        'end_time': now.isoformat(),
        'duration_seconds': 0,
        'batch_timestamp': now.isoformat(),
        'batch_start': now.isoformat(),
        'batch_end': now.isoformat(),
        'work_date': now.date().isoformat(),
        'user_timezone': 'UTC',
        'status': 'pending_classification' if classification == 'unknown' else ('pending' if classification == 'productive' else 'analyzed'),
        'metadata': {
            'source': 'test_script',
            'test_mode': True,
            'requires_admin_review': classification == 'unknown'
        }
    }
    
    # Print record details
    print("Record to be saved:")
    for key, value in record.items():
        if key == 'ocr_text' and value:
            # Truncate long text for display
            display_value = value[:100] + '...' if len(value) > 100 else value
            print(f"  {key}: {display_value}")
        else:
            print(f"  {key}: {value}")
    
    print("\n" + "-" * 70)
    print("Inserting into Supabase...")
    
    try:
        # Actually insert the record
        response = supabase.table('activity_records').insert(record).execute()
        
        if response.data and len(response.data) > 0:
            saved_record = response.data[0]
            record_id = saved_record.get('id')
            print(f"\n✅ SUCCESS! Record saved to Supabase")
            print(f"   Record ID: {record_id}")
            return saved_record
        else:
            print("\n❌ No data returned from Supabase insert.")
            return None
            
    except Exception as e:
        print(f"\n❌ ERROR saving to Supabase: {e}")
        print("\nTroubleshooting:")
        print("  • Check RLS policies on activity_records table")
        print("  • Verify you're using SERVICE_ROLE_KEY (not ANON_KEY)")
        print("  • Check that all required fields are present")
        print("=" * 70)
        return None


# ============================================================================
# MAIN TEST FLOW
# ============================================================================

def test_complete_flow_with_save(use_mock=False):
    """
    Test the complete screenshot → OCR → Supabase save flow.
    
    Args:
        use_mock: If True, use mock data. Otherwise, use real screen capture.
    """
    
    print("=" * 70)
    print("  SCREENSHOT → OCR → SUPABASE SAVE TEST")
    print("  (This will create a REAL record in your database)")
    print("=" * 70)
    
    # STEP 0: Connect to Supabase
    print("\n🔌 STEP 0: Connect to Supabase")
    print("-" * 70)
    
    supabase = get_supabase_client()
    if not supabase:
        print("\n❌ Cannot proceed without Supabase connection")
        return None
    
    print(f"  ✓ Connected to: {os.getenv('SUPABASE_URL')}")
    
    # Get user ID
    user_id = get_current_user_id(supabase)
    if not user_id:
        print("\n❌ Cannot proceed without user ID")
        return None
    
    # STEP 1: Get currently active window
    print("\n🪟 STEP 1: Get Active Window")
    print("-" * 70)
    
    if use_mock:
        window_title = "test_screenshot_ocr_save.py - Visual Studio Code"
        app_name = "Code.exe"
        print(f"  Window Title: {window_title} (MOCK)")
        print(f"  App Name: {app_name} (MOCK)")
    else:
        window_title, app_name = get_active_window()
        print(f"  Window Title: {window_title}")
        print(f"  App Name: {app_name}")
    
    # STEP 2: Classify the window using REAL logic
    print("\n🔍 STEP 2: Classify Window (Using Real Logic)")
    print("-" * 70)
    print(f"  Checking app_classifications_cache table...")
    
    # Initialize AppClassificationManager with real SQLite database
    db_path = get_db_path()

    # Create a lightweight db_manager for testing
    class _TestDbManager:
        def __init__(self, path):
            self.db_path = path
            self._conn = None
        def get_connection(self):
            if self._conn is None:
                self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            return self._conn
    _test_db_mgr = _TestDbManager(db_path)
    classification_manager = AppClassificationManager(_test_db_mgr)
    
    # Initial classification without OCR text
    classification = classify_window(classification_manager, app_name, window_title, ocr_text=None, supabase=supabase)
    
    print(f"  Initial Classification: {classification}")
    
    # STEP 3: Capture screenshot
    print("\n📸 STEP 3: Capture Screenshot")
    print("-" * 70)
    
    if use_mock:
        screenshot = create_mock_screenshot()
        print("  Screenshot: Created mock image (1920x1080)")
    else:
        try:
            screenshot = ImageGrab.grab()
            print(f"  Screenshot: Captured ({screenshot.width}x{screenshot.height})")
        except Exception as e:
            print(f"  ⚠ Failed to capture screenshot: {e}")
            print("  Using mock screenshot instead...")
            screenshot = create_mock_screenshot()
    
    # STEP 4: Run OCR (productive or unknown apps get OCR)
    print("\n🔤 STEP 4: Extract Text with OCR")
    print("-" * 70)
    
    ocr_result = None
    
    if classification in ('productive', 'unknown'):
        print(f"  Running OCR ({classification} app)...")
        
        try:
            # Use the OCR facade (respects .env configuration)
            result = extract_text_from_image(
                screenshot,
                window_title=window_title,
                app_name=app_name,
                use_preprocessing=True
            )
            
            ocr_result = {
                'text': result.get('text', ''),
                'method': result.get('method', 'unknown'),
                'confidence': result.get('confidence', 0.0),
                'error_message': None if result.get('success') else 'OCR failed'
            }
            
            print(f"  ✓ OCR completed")
            print(f"    Method: {ocr_result['method']}")
            print(f"    Confidence: {ocr_result['confidence']:.2f}")
            print(f"    Text Length: {len(ocr_result['text'])} characters")
            
            if ocr_result['text']:
                preview = ocr_result['text'][:150].replace('\n', ' ')
                print(f"    Preview: {preview}...")
            
            # If classification was 'unknown', retry LLM with OCR text
            if classification == 'unknown' and ocr_result['text']:
                print(f"\n  🔄 Retrying LLM classification with OCR text...")
                new_classification = classify_window(
                    classification_manager, 
                    app_name, 
                    window_title, 
                    ocr_text=ocr_result['text'],
                    supabase=supabase
                )
                if new_classification != 'unknown':
                    classification = new_classification
                    print(f"  ✓ Updated classification to: {classification}")
            
        except Exception as e:
            print(f"  ✗ OCR failed: {e}")
            ocr_result = {
                'text': None,
                'method': 'error',
                'confidence': 0.0,
                'error_message': str(e)
            }
    
    elif classification in ('non_productive', 'private'):
        print(f"  ⊘ Skipping OCR ({classification} app)")
        ocr_result = {
            'text': None,
            'method': 'skipped',
            'confidence': 0.0,
            'error_message': f'Skipped for {classification} app'
        }
    

    
    # STEP 5: Save to Supabase (THE REAL DEAL!)
    print("\n💾 STEP 5: Save to Supabase")
    print("-" * 70)
    
    saved_record = save_to_activity_records(
        supabase, user_id, window_title, app_name, classification, ocr_result
    )
    
    # SUMMARY
    print("\n" + ("✅" if saved_record else "❌") + " TEST COMPLETE")
    print("=" * 70)
    print(f"Window: {window_title[:50]}...")
    print(f"App: {app_name}")
    print(f"Classification: {classification}")
    print(f"OCR Method: {ocr_result['method'] if ocr_result else 'N/A'}")
    print(f"OCR Success: {'Yes' if ocr_result and ocr_result.get('text') else 'No'}")
    print(f"Saved to Supabase: {'Yes' if saved_record else 'No'}")
    if saved_record:
        print(f"Record ID: {saved_record.get('id')}")
    print("=" * 70)
    
    return saved_record


# ============================================================================
# COMMAND LINE INTERFACE
# ============================================================================

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Test screenshot → OCR → Supabase save flow (creates REAL records!)'
    )
    parser.add_argument(
        '--mock-productive',
        action='store_true',
        help='Use mock screenshot data (bypasses  real screen capture)'
    )
    parser.add_argument(
        '--yes', '-y',
        action='store_true',
        help='Skip confirmation prompt'
    )
    
    args = parser.parse_args()
    
    # Confirm before proceeding (unless --yes flag)
    if not args.yes:
        print("\n⚠️  WARNING: This will create a REAL record in your Supabase database!")
        response = input("Continue? [y/N]: ")
        
        if response.lower() != 'y':
            print("Cancelled.")
            sys.exit(0)
    
    # Run the test
    try:
        record = test_complete_flow_with_save(use_mock=args.mock_productive)
        if record:
            print("\n✅ Test completed successfully!")
            print("\n💡 Verify the record:")
            print("   python view_activity_records.py --limit 1")
        else:
            print("\n❌ Test failed - record was not saved")
            sys.exit(1)
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
