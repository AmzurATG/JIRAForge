"""
Quick OCR Test - Minimal Setup
Captures current screen and tests OCR + Supabase saving
"""

import os
import sys
import time
import base64
from datetime import datetime, timezone
from io import BytesIO

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import ImageGrab
from supabase import create_client
from dotenv import load_dotenv
from ocr import extract_text_from_image

# Load environment
load_dotenv()

def main():
    print("\n" + "="*80)
    print(" 🧪 QUICK OCR TEST")
    print("="*80)
    
    # Check configuration
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    
    if not supabase_url or not supabase_key:
        print("\n❌ ERROR: Missing Supabase configuration")
        print("   Add to .env file:")
        print("     SUPABASE_URL=your_url")
        print("     SUPABASE_SERVICE_ROLE_KEY=your_key")
        return
    
    print("\n📸 Taking screenshot in 3 seconds...")
    print("   (Switch to a window with text to test OCR)")
    time.sleep(3)
    
    # Capture screenshot
    print("\n[1/4] Capturing screenshot...")
    screenshot = ImageGrab.grab()
    print(f"      ✓ Captured {screenshot.size[0]}x{screenshot.size[1]} pixels")
    
    # Convert screenshot to base64 for storage
    img_buffer = BytesIO()
    screenshot.save(img_buffer, format='PNG')
    img_bytes = img_buffer.getvalue()
    screenshot_base64 = base64.b64encode(img_bytes).decode('utf-8')
    
    # Create thumbnail and convert to base64
    thumbnail = screenshot.copy()
    thumbnail.thumbnail((400, 300))
    thumb_buffer = BytesIO()
    thumbnail.save(thumb_buffer, format='JPEG', quality=70)
    thumb_bytes = thumb_buffer.getvalue()
    thumbnail_base64 = base64.b64encode(thumb_bytes).decode('utf-8')
    
    # Extract text with OCR
    print("\n[2/4] Extracting text with OCR...")
    start_time = time.time()
    result = extract_text_from_image(
        screenshot,
        window_title='Quick Test',
        app_name='Test Script',
        use_preprocessing=True
    )
    processing_time = int((time.time() - start_time) * 1000)
    
    print(f"      ✓ Method: {result.get('method', 'unknown')}")
    print(f"      ✓ Confidence: {result.get('confidence', 0):.2f}")
    print(f"      ✓ Lines: {result.get('line_count', 0)}")
    print(f"      ✓ Time: {processing_time}ms")
    
    if result.get('text'):
        print(f"\n      Extracted text preview (first 150 chars):")
        preview = result['text'][:150].replace('\n', ' ')
        print(f"      \"{preview}...\"")
    else:
        print(f"      ⚠ No text extracted")
    
    # Save to Supabase
    print("\n[3/4] Saving to Supabase...")
    supabase = create_client(supabase_url, supabase_key)
    
    data = {
        'user_id': os.getenv('TEST_USER_ID', '00000000-0000-0000-0000-000000000001'),
        'organization_id': os.getenv('TEST_ORG_ID', '00000000-0000-0000-0000-000000000001'),
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'window_title': 'Quick Test',
        'application_name': 'Test Script',
        'extracted_text': result.get('text', ''),
        'ocr_confidence': float(result.get('confidence', 0.0)),
        'ocr_method': result.get('method', 'unknown'),
        'ocr_line_count': result.get('line_count', 0),
        'screenshot_base64': screenshot_base64,
        'thumbnail_base64': thumbnail_base64,
        'preprocessing_enabled': True,
        'processing_time_ms': processing_time,
        'image_width': screenshot.size[0],
        'image_height': screenshot.size[1],
        'success': result.get('success', False),
        'test_name': 'quick_test'
    }
    
    try:
        db_result = supabase.table('ocr_test_results').insert(data).execute()
        if db_result.data:
            record_id = db_result.data[0]['id']
            print(f"      ✓ Saved with ID: {record_id[:8]}...")
        else:
            print(f"      ❌ Save failed - no data returned")
            return
    except Exception as e:
        print(f"      ❌ Save failed: {e}")
        return
    
    # Verify
    print("\n[4/4] Verifying save...")
    try:
        verify = supabase.table('ocr_test_results').select('*').eq('id', record_id).execute()
        if verify.data:
            print(f"      ✓ Verified - record exists in database")
        else:
            print(f"      ❌ Verification failed - record not found")
    except Exception as e:
        print(f"      ❌ Verification error: {e}")
    
    # Show recent tests
    print("\n📊 Last 3 tests in database:")
    try:
        recent = supabase.table('ocr_test_results').select('created_at,ocr_method,ocr_confidence,success').order('created_at', desc=True).limit(3).execute()
        for i, record in enumerate(recent.data, 1):
            status = "✅" if record['success'] else "❌"
            print(f"   {i}. {record['created_at'][:19]} | {record['ocr_method']:10} | {record['ocr_confidence']:.2f} | {status}")
    except Exception as e:
        print(f"   ❌ Could not fetch recent tests: {e}")
    
    print("\n" + "="*80)
    print(" ✅ TEST COMPLETE")
    print("="*80)
    print("\n💡 View results in Supabase:")
    print(f"   Table: ocr_test_results")
    print(f"   Latest ID: {record_id}")
    print()

if __name__ == '__main__':
    main()
