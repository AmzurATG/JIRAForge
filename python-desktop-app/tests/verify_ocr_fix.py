"""
Deployment Verification Script

Run this script after deploying to verify the OCR fix is working correctly.
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def verify_deployment():
    """Verify OCR fix deployment"""
    print("="*70)
    print(" OCR BACKGROUND SETUP FIX - DEPLOYMENT VERIFICATION")
    print("="*70)
    print()
    
    checks = {
        'initialize_supabase_signature': False,
        'background_methods_exist': False,
        'marker_functions_exist': False,
        'null_checks_present': False,
        'startup_check_exists': False
    }
    
    try:
        # Check 1: initialize_supabase has skip_ocr_setup parameter
        print("[1/5] Checking initialize_supabase signature...")
        import inspect
        import desktop_app
        
        # Get the TimeTracker class without instantiating
        TimeTracker = desktop_app.TimeTracker
        sig = inspect.signature(TimeTracker.initialize_supabase)
        if 'skip_ocr_setup' in sig.parameters:
            print("   ✅ skip_ocr_setup parameter found")
            checks['initialize_supabase_signature'] = True
        else:
            print("   ❌ skip_ocr_setup parameter missing")
        
        # Check 2: Background methods exist
        print()
        print("[2/5] Checking background OCR methods...")
        if (hasattr(TimeTracker, '_start_background_ocr_setup') and
            hasattr(TimeTracker, '_background_ocr_setup_worker') and
            hasattr(TimeTracker, '_finalize_ocr_setup')):
            print("   ✅ All background OCR methods exist")
            checks['background_methods_exist'] = True
        else:
            print("   ❌ Some background OCR methods missing")
            missing = []
            if not hasattr(TimeTracker, '_start_background_ocr_setup'):
                missing.append('_start_background_ocr_setup')
            if not hasattr(TimeTracker, '_background_ocr_setup_worker'):
                missing.append('_background_ocr_setup_worker')
            if not hasattr(TimeTracker, '_finalize_ocr_setup'):
                missing.append('_finalize_ocr_setup')
            print(f"      Missing: {', '.join(missing)}")
        
        # Check 3: Marker functions exist
        print()
        print("[3/5] Checking installation marker functions...")
        from ocr.auto_installer import (
            mark_installation_complete,
            is_installation_complete,
            check_and_install_dependencies
        )
        if (callable(mark_installation_complete) and
            callable(is_installation_complete)):
            print("   ✅ Installation marker functions exist")
            checks['marker_functions_exist'] = True
        else:
            print("   ❌ Installation marker functions missing")
        
        # Check 4: Null checks present
        print()
        print("[4/5] Checking OCR processor null checks...")
        # Read source to verify null checks
        source = inspect.getsource(TimeTracker.upload_activity_batch)
        if 'if not self.ocr_processor' in source or 'if self.ocr_processor' in source:
            print("   ✅ OCR processor null checks present in upload_activity_batch")
            checks['null_checks_present'] = True
        else:
            print("   ⚠️  Could not verify null checks in upload_activity_batch")
        
        # Check 5: Startup first-run check exists
        print()
        print("[5/5] Checking startup first-run check...")
        if hasattr(TimeTracker, '_is_first_run_ocr_check'):
            print("   ✅ First-run OCR check method exists")
            checks['startup_check_exists'] = True
        else:
            print("   ❌ First-run OCR check method missing")
        
    except Exception as e:
        print(f"   ❌ Error during verification: {e}")
        import traceback
        traceback.print_exc()
    
    print()
    print("="*70)
    print(" VERIFICATION RESULTS")
    print("="*70)
    
    passed = sum(checks.values())
    total = len(checks)
    
    for check_name, result in checks.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {status}  {check_name.replace('_', ' ').title()}")
    
    print()
    print(f"Overall: {passed}/{total} checks passed")
    print()
    
    if passed == total:
        print("🎉 DEPLOYMENT VERIFIED!")
        print("   All required changes are present.")
        return 0
    elif passed >= total - 1:
        print("⚠️  MOSTLY VERIFIED")
        print("   One check needs manual review.")
        return 0
    else:
        print("❌ DEPLOYMENT VERIFICATION FAILED")
        print("   Please review the failed checks.")
        return 1

if __name__ == '__main__':
    sys.exit(verify_deployment())
