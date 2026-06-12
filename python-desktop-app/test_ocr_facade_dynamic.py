"""
Test OCR Facade with Dynamic Engine Names
Tests that all engines (paddle, tesseract, demo, mock) work with ocr_test_results table
"""

import os
import sys
import time
from datetime import datetime, timezone
from io import BytesIO
import base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
import numpy as np
from supabase import create_client
from dotenv import load_dotenv
from ocr import extract_text_from_image, get_facade, reset_facade

load_dotenv()

def test_engine(engine_name, supabase, user_id, org_id):
    """Test a specific OCR engine and save to database"""
    print(f"\n{'='*70}")
    print(f"Testing: {engine_name.upper()}")
    print(f"{'='*70}")
    
    # Reset facade to pick up new env var
    os.environ['OCR_PRIMARY_ENGINE'] = engine_name
    reset_facade()
    
    # Create test image
    img = np.zeros((200, 400, 3), dtype=np.uint8)
    # Add some text-like patterns
    img[50:70, 50:350] = 255  # White rectangle
    img[90:110, 50:300] = 255
    img[130:150, 50:380] = 255
    
    # Convert to PIL
    pil_img = Image.fromarray(img)
    
    # Extract text
    print(f"  [1/3] Extracting text...")
    start_time = time.time()
    result = extract_text_from_image(
        pil_img,
        window_title=f'Test {engine_name}',
        app_name='OCR Facade Test',
        use_preprocessing=True
    )
    processing_time = int((time.time() - start_time) * 1000)
    
    method = result.get('method', 'unknown')
    confidence = result.get('confidence', 0.0)
    success = result.get('success', False)
    text = result.get('text', '')
    
    print(f"        ✓ Method: {method}")
    print(f"        ✓ Confidence: {confidence:.2f}")
    print(f"        ✓ Success: {success}")
    print(f"        ✓ Time: {processing_time}ms")
    if text:
        print(f"        ✓ Text: {text[:80]}...")
    
    # Convert image to base64
    img_buffer = BytesIO()
    pil_img.save(img_buffer, format='PNG')
    img_bytes = img_buffer.getvalue()
    screenshot_base64 = base64.b64encode(img_bytes).decode('utf-8')
    
    # Create thumbnail
    thumbnail = pil_img.copy()
    thumbnail.thumbnail((400, 300))
    thumb_buffer = BytesIO()
    thumbnail.save(thumb_buffer, format='JPEG', quality=70)
    thumb_bytes = thumb_buffer.getvalue()
    thumbnail_base64 = base64.b64encode(thumb_bytes).decode('utf-8')
    
    # Save to database
    print(f"  [2/3] Saving to database...")
    data = {
        'user_id': user_id,
        'organization_id': org_id,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'window_title': f'Test {engine_name}',
        'application_name': 'OCR Facade Test',
        'extracted_text': text,
        'ocr_confidence': float(confidence),
        'ocr_method': method,  # This is the critical field - can be ANY engine now
        'ocr_line_count': result.get('line_count', 0),
        'screenshot_base64': screenshot_base64,
        'thumbnail_base64': thumbnail_base64,
        'preprocessing_enabled': True,
        'processing_time_ms': processing_time,
        'image_width': pil_img.size[0],
        'image_height': pil_img.size[1],
        'success': success,
        'test_name': f'facade_test_{engine_name}'
    }
    
    try:
        db_result = supabase.table('ocr_test_results').insert(data).execute()
        if db_result.data:
            record_id = db_result.data[0]['id']
            print(f"        ✓ Saved with ID: {record_id[:8]}...")
            
            # Verify
            print(f"  [3/3] Verifying...")
            verify = supabase.table('ocr_test_results').select('*').eq('id', record_id).execute()
            if verify.data and verify.data[0]['ocr_method'] == method:
                print(f"        ✓ Verified - ocr_method '{method}' stored correctly")
                return True
            else:
                print(f"        ❌ Verification failed")
                return False
        else:
            print(f"        ❌ Save failed - no data returned")
            return False
    except Exception as e:
        print(f"        ❌ Database error: {e}")
        if "ocr_test_results_ocr_method_check" in str(e):
            print(f"        💡 Run migration: 20260219_update_ocr_method_constraint_dynamic.sql")
        return False

def main():
    print("\n" + "="*70)
    print(" 🧪 OCR FACADE - DYNAMIC ENGINE TEST")
    print("="*70)
    print("\nThis test verifies:")
    print("  • New OCR facade works with any engine name")
    print("  • ocr_test_results table accepts dynamic engine names")
    print("  • Tests paddle, tesseract, demo, mock engines")
    
    # Check configuration
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    
    if not supabase_url or not supabase_key:
        print("\n❌ ERROR: Missing Supabase configuration")
        print("   Add to .env file:")
        print("     SUPABASE_URL=your_url")
        print("     SUPABASE_SERVICE_ROLE_KEY=your_key")
        return
    
    supabase = create_client(supabase_url, supabase_key)
    user_id = os.getenv('TEST_USER_ID', '00000000-0000-0000-0000-000000000001')
    org_id = os.getenv('TEST_ORG_ID', '00000000-0000-0000-0000-000000000001')
    
    # Get available engines
    from ocr import EngineFactory
    available = EngineFactory.get_available_engines()
    print(f"\n📦 Available Engines: {', '.join(available.keys())}")
    
    # Test each engine
    results = {}
    for engine in ['paddle', 'tesseract', 'demo', 'mock']:
        try:
            success = test_engine(engine, supabase, user_id, org_id)
            results[engine] = success
            time.sleep(1)  # Brief pause between tests
        except Exception as e:
            print(f"\n❌ Test failed for {engine}: {e}")
            results[engine] = False
    
    # Summary
    print(f"\n{'='*70}")
    print(" 📊 TEST RESULTS SUMMARY")
    print(f"{'='*70}")
    
    for engine, success in results.items():
        status = "✅ PASSED" if success else "❌ FAILED"
        print(f"  {engine:12s} : {status}")
    
    passed = sum(1 for s in results.values() if s)
    total = len(results)
    
    print(f"\n  Total: {passed}/{total} tests passed")
    
    # Show recent database records
    print(f"\n{'='*70}")
    print(" 📋 RECENT DATABASE RECORDS")
    print(f"{'='*70}")
    
    try:
        recent = supabase.table('ocr_test_results') \
            .select('created_at,ocr_method,ocr_confidence,success,test_name') \
            .order('created_at', desc=True) \
            .limit(10) \
            .execute()
        
        print(f"\n  {'Time':<20} {'Engine':<12} {'Confidence':>10} {'Status':>8} {'Test Name'}")
        print(f"  {'-'*68}")
        
        for record in recent.data:
            status = "✅" if record.get('success') else "❌"
            time_str = record['created_at'][:19].replace('T', ' ')
            engine = record.get('ocr_method', 'unknown')
            conf = record.get('ocr_confidence', 0.0)
            test = record.get('test_name', 'N/A')[:20]
            
            print(f"  {time_str:20} {engine:<12} {conf:>10.2f} {status:>8} {test}")
        
    except Exception as e:
        print(f"  ❌ Could not fetch recent records: {e}")
    
    print(f"\n{'='*70}")
    if all(results.values()):
        print(" ✅ ALL TESTS PASSED - Dynamic engine names work!")
    else:
        print(" ⚠️  SOME TESTS FAILED - Check migration status")
    print(f"{'='*70}\n")

if __name__ == "__main__":
    main()
