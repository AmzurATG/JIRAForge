"""
Comprehensive OCR Engine Test Suite
Tests all available OCR engines and stores results in ocr_test_results table

Features:
  - Automatically checks and installs OCR dependencies from .env config
  - Captures actual window title and application name during screenshot tests
  - Tests paddle, tesseract, easyocr, and other configured engines
  - Stores results in Supabase ocr_test_results table

Usage:
    # Test engines configured in .env (OCR_PRIMARY_ENGINE + fallbacks)
    python -m tests.test_ocr_engines
    python -m tests.test_ocr_engines --screenshot
    
    # Test specific engine
    python -m tests.test_ocr_engines --engine paddle
    
    # Test all registered engines (not just .env ones)
    python -m tests.test_ocr_engines --all
    
    # Test with custom image
    python -m tests.test_ocr_engines --image path/to/image.png
    
    # Test with real screenshot (captures window title & app name)
    python -m tests.test_ocr_engines --screenshot
    
    # Skip database storage (dry run)
    python -m tests.test_ocr_engines --no-db
    
    # Skip dependency check
    python -m tests.test_ocr_engines --skip-deps
"""

import os
import sys
import time
import argparse
from datetime import datetime, timezone
from io import BytesIO
import base64
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from PIL import Image, ImageDraw, ImageFont, ImageGrab
import numpy as np
from supabase import create_client
from dotenv import load_dotenv

# Import OCR facade
from ocr import extract_text_from_image, get_facade, reset_facade, EngineFactory

load_dotenv()

# Try to import Windows APIs for window title capture
WIN32_AVAILABLE = False
try:
    import win32gui
    import win32process
    import psutil
    WIN32_AVAILABLE = True
except ImportError:
    pass  # Will use fallback values


class OCRTester:
    """Comprehensive OCR testing with database storage"""
    
    def __init__(self, save_to_db=True):
        self.save_to_db = save_to_db
        self.supabase = None
        self.user_id = None
        self.org_id = None
        self.results = {}
        
        if save_to_db:
            self._init_database()
    
    def _init_database(self):
        """Initialize Supabase connection"""
        supabase_url = os.getenv('SUPABASE_URL')
        supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
        
        if not supabase_url or not supabase_key:
            print("⚠️  WARNING: Supabase not configured - results won't be saved to database")
            print("   Add to .env file:")
            print("     SUPABASE_URL=your_url")
            print("     SUPABASE_SERVICE_ROLE_KEY=your_key")
            self.save_to_db = False
            return
        
        self.supabase = create_client(supabase_url, supabase_key)
        self.user_id = os.getenv('TEST_USER_ID', '00000000-0000-0000-0000-000000000001')
        self.org_id = os.getenv('TEST_ORG_ID', '00000000-0000-0000-0000-000000000001')
        
        print(f"✓ Database connected: {supabase_url[:30]}...")
        print(f"✓ Test User ID: {self.user_id}")
    
    def create_test_image(self, text="Test OCR Text", width=800, height=200):
        """Create a test image with text"""
        # Create white background
        img = Image.new('RGB', (width, height), color='white')
        draw = ImageDraw.Draw(img)
        
        # Try to use a good font
        try:
            font = ImageFont.truetype("arial.ttf", 40)
        except:
            # Fallback to default font
            font = ImageFont.load_default()
        
        # Add text
        text_bbox = draw.textbbox((0, 0), text, font=font)
        text_width = text_bbox[2] - text_bbox[0]
        text_height = text_bbox[3] - text_bbox[1]
        
        position = ((width - text_width) // 2, (height - text_height) // 2)
        draw.text(position, text, fill='black', font=font)
        
        # Add some noise for realism
        np_img = np.array(img)
        noise = np.random.randint(-10, 10, np_img.shape, dtype=np.int16)
        np_img = np.clip(np_img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        
        return Image.fromarray(np_img)
    
    def load_image(self, image_path):
        """Load image from file"""
        try:
            img = Image.open(image_path)
            if img.mode != 'RGB':
                img = img.convert('RGB')
            return img
        except Exception as e:
            print(f"❌ Error loading image {image_path}: {e}")
            return None
    
    def capture_screenshot(self):
        """Capture current screen and active window info"""
        try:
            print("📸 Capturing screenshot in 3 seconds...")
            print("   (Switch to the window you want to capture)")
            time.sleep(3)
            
            # Capture window info BEFORE screenshot
            window_info = self._get_active_window()
            
            screenshot = ImageGrab.grab()
            if screenshot.mode != 'RGB':
                screenshot = screenshot.convert('RGB')
            
            print(f"✓ Captured: {screenshot.size[0]}x{screenshot.size[1]} pixels")
            
            if window_info:
                print(f"✓ Window Title: {window_info['title'][:50]}..." if len(window_info['title']) > 50 else f"✓ Window Title: {window_info['title']}")
                print(f"✓ Application: {window_info['app']}")
            
            return screenshot, window_info
        except Exception as e:
            print(f"❌ Screenshot capture failed: {e}")
            return None, None
    
    def _get_active_window(self):
        """Get active window title and application name"""
        if not WIN32_AVAILABLE:
            return None
        
        try:
            hwnd = win32gui.GetForegroundWindow()
            title = win32gui.GetWindowText(hwnd)
            
            # Get process name
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            process = psutil.Process(pid)
            app_name = process.name()
            
            # Clean up app name (remove .exe)
            if app_name.lower().endswith('.exe'):
                app_name = app_name[:-4]
            
            return {
                'title': title or 'Unknown Window',
                'app': app_name or 'Unknown Application'
            }
        except Exception as e:
            print(f"⚠️  Could not get window info: {e}")
            return None
    
    def test_engine(self, engine_name, test_image=None, test_name=None, window_info=None):
        """Test a specific OCR engine
        
        Args:
            engine_name: Name of the engine to test
            test_image: Optional PIL Image to test with
            test_name: Optional test name for database
            window_info: Optional dict with 'title' and 'app' keys for actual window info
        """
        print(f"\n{'='*80}")
        print(f" 🧪 Testing: {engine_name.upper()}")
        print(f"{'='*80}")
        
        # Save original environment settings
        original_primary = os.environ.get('OCR_PRIMARY_ENGINE', '')
        original_fallbacks = os.environ.get('OCR_FALLBACK_ENGINES', '')
        
        try:
            # Set engine as primary AND disable fallbacks for isolated testing
            os.environ['OCR_PRIMARY_ENGINE'] = engine_name
            os.environ['OCR_FALLBACK_ENGINES'] = ''  # Disable fallbacks to test only this engine
            reset_facade()
            
            # Create or use test image
            if test_image is None:
                test_image = self.create_test_image(f"Testing {engine_name} OCR Engine")
            
            # Determine window title and app name
            if window_info:
                actual_window_title = window_info.get('title', f'OCR Test - {engine_name}')
                actual_app_name = window_info.get('app', 'OCR Engine Test Suite')
            else:
                actual_window_title = f'OCR Test - {engine_name}'
                actual_app_name = 'OCR Engine Test Suite'
            
            # Display image info
            print(f"  📷 Image: {test_image.size[0]}x{test_image.size[1]} pixels")
            
            # Extract text
            print(f"  [1/4] Extracting text with {engine_name}...")
            start_time = time.time()
            
            try:
                result = extract_text_from_image(
                    test_image,
                    window_title=actual_window_title,
                    app_name=actual_app_name,
                    use_preprocessing=True
                    )
                processing_time = int((time.time() - start_time) * 1000)
                
                method = result.get('method', 'unknown')
                confidence = result.get('confidence', 0.0)
                success = result.get('success', False)
                text = result.get('text', '')
                line_count = result.get('line_count', 0)
                error = result.get('error')
                
                # Validate that the correct engine was used (no fallback should occur in tests)
                if method != engine_name:
                    print(f"        ⚠️  WARNING: Expected engine '{engine_name}' but got '{method}'")
                    print(f"        ⚠️  This indicates the primary engine failed and fallback occurred!")
                    success = False
                    error = f"Wrong engine used: expected {engine_name}, got {method}"
                
                print(f"        ✓ Method Used: {method}")
                print(f"        ✓ Confidence: {confidence:.2%}")
                print(f"        ✓ Success: {'✅ Yes' if success else '❌ No'}")
                print(f"        ✓ Processing Time: {processing_time}ms")
                print(f"        ✓ Lines Detected: {line_count}")
                
                if text:
                    display_text = text[:100] + '...' if len(text) > 100 else text
                    print(f"        ✓ Text Preview: {repr(display_text)}")
                
                if error:
                    print(f"        ⚠️  Error: {error}")
                
            except Exception as e:
                print(f"        ❌ Extraction failed: {e}")
                result = {
                    'method': engine_name,
                    'confidence': 0.0,
                    'success': False,
                    'text': '',
                    'line_count': 0,
                    'error': str(e)
                }
                processing_time = int((time.time() - start_time) * 1000)
                method = engine_name
                confidence = 0.0
                success = False
                text = ''
                line_count = 0
            
            # Prepare image data
            print(f"  [2/4] Encoding image data...")
            img_buffer = BytesIO()
            test_image.save(img_buffer, format='PNG')
            img_bytes = img_buffer.getvalue()
            screenshot_base64 = base64.b64encode(img_bytes).decode('utf-8')
            
            # Create thumbnail
            thumbnail = test_image.copy()
            thumbnail.thumbnail((400, 300))
            thumb_buffer = BytesIO()
            thumbnail.save(thumb_buffer, format='JPEG', quality=70)
            thumb_bytes = thumb_buffer.getvalue()
            thumbnail_base64 = base64.b64encode(thumb_bytes).decode('utf-8')
            
            print(f"        ✓ Screenshot: {len(img_bytes)} bytes")
            print(f"        ✓ Thumbnail: {len(thumb_bytes)} bytes")
            
            # Save to database
            db_record_id = None
            if self.save_to_db and self.supabase:
                print(f"  [3/4] Saving to ocr_test_results table...")
                
                data = {
                    'user_id': self.user_id,
                    'organization_id': self.org_id,
                    'timestamp': datetime.now(timezone.utc).isoformat(),
                    'window_title': actual_window_title,
                    'application_name': actual_app_name,
                    'extracted_text': text,
                    'ocr_confidence': float(confidence),
                    'ocr_method': method,
                    'ocr_line_count': line_count,
                    'screenshot_base64': screenshot_base64,
                    'thumbnail_base64': thumbnail_base64,
                    'preprocessing_enabled': True,
                    'processing_time_ms': processing_time,
                    'image_width': test_image.size[0],
                    'image_height': test_image.size[1],
                    'success': success,
                    'error_message': result.get('error'),
                    'test_name': test_name or f'engine_test_{engine_name}',
                    'test_notes': f'Automated test of {engine_name} engine'
                }
                
                try:
                    db_result = self.supabase.table('ocr_test_results').insert(data).execute()
                    if db_result.data:
                        db_record_id = db_result.data[0]['id']
                        print(f"        ✓ Saved with ID: {db_record_id[:8]}...")
                    else:
                        print(f"        ❌ Save failed - no data returned")
                except Exception as e:
                    print(f"        ❌ Database error: {e}")
                    if "ocr_test_results_ocr_method_check" in str(e):
                        print(f"        💡 TIP: Run migration 20260219_update_ocr_method_constraint_dynamic.sql")
            else:
                print(f"  [3/4] Skipping database save (dry run mode)")
            
            # Verify
            if db_record_id and self.supabase:
                print(f"  [4/4] Verifying database record...")
                try:
                    verify = self.supabase.table('ocr_test_results') \
                        .select('id,ocr_method,ocr_confidence,success') \
                        .eq('id', db_record_id) \
                        .execute()
                    
                    if verify.data and verify.data[0]['ocr_method'] == method:
                        print(f"        ✓ Verified - ocr_method '{method}' stored correctly")
                    else:
                        print(f"        ❌ Verification failed")
                        success = False
                except Exception as e:
                    print(f"        ❌ Verification error: {e}")
                    success = False
            else:
                print(f"  [4/4] Skipping verification")
            
            # Store result
            self.results[engine_name] = {
                'success': success,
                'method': method,
                'confidence': confidence,
                'processing_time': processing_time,
                'text_length': len(text),
                'line_count': line_count,
                'db_record_id': db_record_id
            }
            
            return success
            
        finally:
            # Restore original environment settings
            print(f"  [Cleanup] Restoring original OCR settings...")
            os.environ['OCR_PRIMARY_ENGINE'] = original_primary
            os.environ['OCR_FALLBACK_ENGINES'] = original_fallbacks
            reset_facade()
            print(f"        ✓ Primary engine restored to: {original_primary}")
            print(f"        ✓ Fallback engines restored to: {original_fallbacks}")
    
    def test_configured_engines(self, test_image=None, window_info=None):
        """Test engines configured in .env (OCR_PRIMARY_ENGINE and OCR_FALLBACK_ENGINES)
        
        Args:
            test_image: Optional PIL Image to test with
            window_info: Optional dict with 'title' and 'app' keys for actual window info
        """
        print("\n" + "="*80)
        print(" 🔍 TESTING CONFIGURED ENGINES FROM .env")
        print("="*80)
        
        # Get configured engines from .env
        primary_engine = os.getenv('OCR_PRIMARY_ENGINE', 'paddle').lower()
        fallback_engines_str = os.getenv('OCR_FALLBACK_ENGINES', '')
        fallback_engines = [e.strip().lower() for e in fallback_engines_str.split(',') if e.strip()]
        
        # Combine primary + fallbacks (maintaining order)
        configured_engines = [primary_engine]
        for engine in fallback_engines:
            if engine not in configured_engines:
                configured_engines.append(engine)
        
        print(f"\n📝 Configuration from .env:")
        print(f"   • OCR_PRIMARY_ENGINE: {primary_engine}")
        print(f"   • OCR_FALLBACK_ENGINES: {', '.join(fallback_engines) if fallback_engines else '(none)'}")
        print(f"\n🎯 Testing {len(configured_engines)} engine(s): {', '.join(configured_engines)}")
        
        # Check if engines are registered
        registered = EngineFactory.get_registered_engines()
        missing_engines = [eng for eng in configured_engines if eng not in registered]
        
        if missing_engines:
            print(f"\n⚠️  Warning: Configured engines not registered: {', '.join(missing_engines)}")
            print(f"   Available engines: {', '.join(registered)}")
            print(f"   Create engine adapter files in ocr/engines/ to add support")
        
        # Filter to only registered engines
        engines_to_test = [eng for eng in configured_engines if eng in registered]
        
        if not engines_to_test:
            print("\n❌ No configured engines are available!")
            print("   Either:")
            print("     1. Install dependencies: python -m ocr.auto_installer")
            print("     2. Create engine adapters in ocr/engines/")
            print(f"     3. Update .env to use available engines: {', '.join(registered)}")
            return
        
        # Test each configured engine
        print(f"\n🧪 Running Tests...")
        for engine_name in engines_to_test:
            try:
                self.test_engine(engine_name, test_image, window_info=window_info)
                time.sleep(1)  # Brief pause between tests
            except Exception as e:
                print(f"\n❌ Test crashed for {engine_name}: {e}")
                self.results[engine_name] = {
                    'success': False,
                    'method': engine_name,
                    'confidence': 0.0,
                    'processing_time': 0,
                    'text_length': 0,
                    'line_count': 0,
                    'error': str(e)
                }
        
        # Show summary
        self._print_summary()
    
    def test_all_engines(self, test_image=None, window_info=None):
        """Test all available engines
        
        Args:
            test_image: Optional PIL Image to test with
            window_info: Optional dict with 'title' and 'app' keys for actual window info
        """
        print("\n" + "="*80)
        print(" 🚀 OCR ENGINE COMPREHENSIVE TEST SUITE")
        print("="*80)
        
        # Get registered engines
        registered = EngineFactory.get_registered_engines()
        print(f"\n📦 Registered Engines: {len(registered)}")
        for name in registered:
            engine_class = EngineFactory._registry[name]
            print(f"   • {name}: {engine_class.__name__}")
        
        if not registered:
            print("\n❌ No OCR engines available!")
            print("   Install at least one engine:")
            print("     pip install paddlepaddle paddleocr")
            print("     pip install pytesseract")
            return
        
        # Test each engine
        print(f"\n🧪 Running Tests...")
        for engine_name in registered:
            try:
                self.test_engine(engine_name, test_image, window_info=window_info)
                time.sleep(1)  # Brief pause between tests
            except Exception as e:
                print(f"\n❌ Test crashed for {engine_name}: {e}")
                self.results[engine_name] = {
                    'success': False,
                    'method': engine_name,
                    'confidence': 0.0,
                    'processing_time': 0,
                    'text_length': 0,
                    'line_count': 0,
                    'error': str(e)
                }
        
        # Show summary
        self._print_summary()
    
    def _print_summary(self):
        """Print test results summary"""
        print(f"\n{'='*80}")
        print(" 📊 TEST RESULTS SUMMARY")
        print(f"{'='*80}")
        
        if not self.results:
            print("  No results to display")
            return
        
        # Table header
        print(f"\n  {'Engine':<15} {'Status':<10} {'Method':<15} {'Confidence':>11} {'Time':>8} {'Lines':>6}")
        print(f"  {'-'*78}")
        
        # Results
        for engine, data in self.results.items():
            status = "✅ PASSED" if data['success'] else "❌ FAILED"
            method = data['method'][:14]
            conf = f"{data['confidence']:.2%}"
            time_ms = f"{data['processing_time']}ms"
            lines = data['line_count']
            
            print(f"  {engine:<15} {status:<10} {method:<15} {conf:>11} {time_ms:>8} {lines:>6}")
        
        # Statistics
        passed = sum(1 for r in self.results.values() if r['success'])
        total = len(self.results)
        avg_time = sum(r['processing_time'] for r in self.results.values()) / total if total > 0 else 0
        avg_conf = sum(r['confidence'] for r in self.results.values()) / total if total > 0 else 0
        
        print(f"\n  {'Summary':<15} {'Pass Rate':<10} {'Avg Confidence':<15} {'Avg Time':>11}")
        print(f"  {'-'*78}")
        print(f"  {f'{passed}/{total}':<15} {f'{passed/total:.1%}':<10} {f'{avg_conf:.2%}':<15} {f'{avg_time:.0f}ms':>11}")
        
        # Recent database records
        if self.save_to_db and self.supabase:
            self._show_recent_records()
        
        print(f"\n{'='*80}")
        if passed == total:
            print(" ✅ ALL TESTS PASSED - All engines working correctly!")
        elif passed > 0:
            print(f" ⚠️  PARTIAL SUCCESS - {passed}/{total} engines working")
        else:
            print(" ❌ ALL TESTS FAILED - Check configuration and dependencies")
        print(f"{'='*80}\n")
    
    def _show_recent_records(self):
        """Show recent database records"""
        print(f"\n {'='*78}")
        print(" 📋 RECENT DATABASE RECORDS (Last 10)")
        print(f" {'='*78}")
        
        try:
            recent = self.supabase.table('ocr_test_results') \
                .select('created_at,ocr_method,ocr_confidence,success,test_name,processing_time_ms') \
                .order('created_at', desc=True) \
                .limit(10) \
                .execute()
            
            if not recent.data:
                print("  No records found")
                return
            
            print(f"\n  {'Time':<20} {'Engine':<12} {'Confidence':>11} {'Time':>8} {'Status':>8} {'Test'}")
            print(f"  {'-'*78}")
            
            for record in recent.data:
                time_str = record['created_at'][:19].replace('T', ' ')
                engine = record.get('ocr_method', 'unknown')[:11]
                conf = record.get('ocr_confidence', 0.0)
                proc_time = record.get('processing_time_ms', 0)
                status = "✅" if record.get('success') else "❌"
                test = record.get('test_name', 'N/A')[:20]
                
                print(f"  {time_str} {engine:<12} {conf:>10.2%} {proc_time:>7}ms {status:>8} {test}")
            
        except Exception as e:
            print(f"  ❌ Could not fetch records: {e}")


def main():
    """Main test runner"""
    parser = argparse.ArgumentParser(
        description='Test OCR engines and store results in database',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test engines from .env (OCR_PRIMARY_ENGINE + fallbacks)
  python -m tests.test_ocr_engines
  python -m tests.test_ocr_engines --screenshot
  
  # Test specific engine
  python -m tests.test_ocr_engines --engine paddle
  
  # Test all registered engines (not just .env)
  python -m tests.test_ocr_engines --all
  
  # Test with custom image
  python -m tests.test_ocr_engines --image screenshot.png
  
  # Test with real screenshot (captures in 3 seconds)
  python -m tests.test_ocr_engines --screenshot --engine paddle
  
  # Dry run (no database storage)
  python -m tests.test_ocr_engines --no-db
  
  # Combine options
  python -m tests.test_ocr_engines --screenshot --all
        """
    )
    
    parser.add_argument(
        '--engine',
        type=str,
        help='Test specific engine (paddle, tesseract, mock, demo, etc.)'
    )
    
    parser.add_argument(
        '--image',
        type=str,
        help='Path to custom test image'
    )
    
    parser.add_argument(
        '--screenshot',
        action='store_true',
        help='Capture real screenshot from current screen'
    )
    
    parser.add_argument(
        '--no-db',
        action='store_true',
        help='Skip database storage (dry run)'
    )
    
    parser.add_argument(
        '--list',
        action='store_true',
        help='List available engines and exit'
    )
    
    parser.add_argument(
        '--skip-deps',
        action='store_true',
        help='Skip automatic dependency installation check'
    )
    
    parser.add_argument(
        '--all',
        action='store_true',
        help='Test all registered engines (default: test only engines from .env)'
    )
    
    args = parser.parse_args()
    
    # Check and install OCR dependencies (unless skipped or listing)
    if not args.skip_deps and not args.list:
        try:
            from ocr.auto_installer import check_and_install_dependencies
            
            print("\n" + "="*70)
            print(" 🔧 Checking OCR Dependencies from .env")
            print("="*70)
            
            # This checks OCR_PRIMARY_ENGINE and OCR_FALLBACK_ENGINES from .env
            result = check_and_install_dependencies(auto_install=True, silent=False)
            
            if result:
                success_engines = [eng for eng, success in result.items() if success]
                failed_engines = [eng for eng, success in result.items() if not success]
                
                if success_engines:
                    print(f"\n✅ Ready: {', '.join(success_engines)}")
                if failed_engines:
                    print(f"\n❌ Failed: {', '.join(failed_engines)}")
                    print("   You may need to install these manually")
            
            print("="*70 + "\n")
            
        except Exception as e:
            print(f"\n⚠️  Warning: Dependency check failed: {e}")
            print("   Continuing with existing packages...\n")
    
    # List engines only
    if args.list:
        print("\n📦 Available OCR Engines:")
        # Get registered engines and their availability
        for name in EngineFactory.get_registered_engines():
            try:
                engine_class = EngineFactory._registry[name]
                engine = EngineFactory.get_or_create(name)
                available_status = "✅" if engine.is_available() else "❌"
                print(f"  {available_status} {name}: {engine_class.__name__}")
                
                if engine.is_available():
                    caps = engine.get_capabilities()
                    if caps and caps.get('features'):
                        print(f"       Features: {', '.join(caps.get('features', []))}")
            except Exception as e:
                print(f"  ❌ {name}: Error - {e}")
        return
    
    # Initialize tester
    tester = OCRTester(save_to_db=not args.no_db)
    
    # Get test image from screenshot, file, or generate
    test_image = None
    window_info = None
    
    if args.screenshot:
        test_image, window_info = tester.capture_screenshot()
        if test_image is None:
            print(f"❌ Could not capture screenshot")
            return
    elif args.image:
        test_image = tester.load_image(args.image)
        if test_image is None:
            print(f"❌ Could not load image: {args.image}")
            return
        print(f"✓ Loaded custom image: {args.image} ({test_image.size[0]}x{test_image.size[1]})")
    
    # Run tests
    if args.engine:
        # Test specific engine
        tester.test_engine(args.engine, test_image, window_info=window_info)
        tester._print_summary()
    elif args.all:
        # Test all registered engines
        tester.test_all_engines(test_image, window_info=window_info)
    else:
        # Test engines configured in .env (default behavior)
        tester.test_configured_engines(test_image, window_info=window_info)


if __name__ == "__main__":
    main()
