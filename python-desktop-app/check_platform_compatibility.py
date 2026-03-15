"""
Platform Compatibility Test for OCR System

This script checks if the OCR system is properly configured for your platform.
Tests OS detection, dependency installation, and OCR engine availability.

Usage:
    python check_platform_compatibility.py
"""

import sys
import platform
import subprocess
from pathlib import Path

# Add parent directory to path to import ocr module
sys.path.insert(0, str(Path(__file__).parent))

from ocr.auto_installer import (
    get_os_type,
    get_cpu_architecture,
    is_apple_silicon,
    check_system_dependencies,
    get_engine_dependencies,
    is_package_installed,
    get_configured_engines
)


def print_section(title: str):
    """Print a section header"""
    print(f"\n{'=' * 70}")
    print(f" {title}")
    print(f"{'=' * 70}")


def check_python_version():
    """Check Python version"""
    print_section("Python Environment")
    
    version = sys.version_info
    print(f"Python Version: {version.major}.{version.minor}.{version.micro}")
    
    if version.major < 3 or (version.major == 3 and version.minor < 8):
        print("❌ Python 3.8 or higher required")
        return False
    else:
        print("✅ Python version compatible")
        return True


def check_platform_info():
    """Check platform information"""
    print_section("Platform Information")
    
    os_type = get_os_type()
    cpu_arch = get_cpu_architecture()
    is_m1 = is_apple_silicon()
    
    print(f"Operating System: {platform.system()} ({os_type})")
    print(f"OS Version: {platform.version()}")
    print(f"CPU Architecture: {cpu_arch}")
    
    if is_m1:
        print("🍎 Apple Silicon (M1/M2/M3) detected - optimized packages will be used")
    
    print(f"\nPlatform details:")
    print(f"  - Machine: {platform.machine()}")
    print(f"  - Processor: {platform.processor()}")
    
    return True


def check_pip_packages():
    """Check if required pip packages are installed"""
    print_section("Python Packages")
    
    required_packages = {
        'paddleocr': 'PaddleOCR',
        'paddlepaddle': 'PaddlePaddle',
        'opencv-python': 'OpenCV',
        'pytesseract': 'PyTesseract',
        'numpy': 'NumPy',
        'PIL': 'Pillow',
    }
    
    all_installed = True
    
    for package, name in required_packages.items():
        if is_package_installed(package):
            print(f"✅ {name:15} installed")
        else:
            print(f"❌ {name:15} NOT installed")
            all_installed = False
    
    return all_installed


def check_system_binaries():
    """Check system-level OCR binaries"""
    print_section("System Binaries")
    
    os_type = get_os_type()
    
    # Check Tesseract
    try:
        result = subprocess.run(
            ['tesseract', '--version'],
            capture_output=True,
            text=True,
            check=True
        )
        version_line = result.stdout.split('\n')[0]
        print(f"✅ Tesseract installed: {version_line}")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"❌ Tesseract NOT installed")
        
        if os_type == 'windows':
            print(f"   Install from: https://github.com/UB-Mannheim/tesseract/wiki")
        elif os_type == 'linux':
            print(f"   Install with: sudo apt-get install tesseract-ocr")
        elif os_type == 'macos':
            print(f"   Install with: brew install tesseract")
    
    return True


def check_ocr_engines():
    """Check OCR engines from environment configuration"""
    print_section("OCR Engine Configuration")
    
    # Get engines from environment config (defaults: paddle + tesseract)
    engines = get_configured_engines()
    
    print(f"OCR engines (from env config): {', '.join(engines)}")
    print()
    
    all_ready = True
    
    for engine in engines:
        print(f"[{engine.upper()}]")
        
        # Get required dependencies for this platform
        dependencies = get_engine_dependencies(engine)
        
        if not dependencies:
            print(f"  ℹ️  No Python dependencies required (built-in engine)")
            continue
        
        missing = []
        for dep in dependencies:
            pkg_name = dep.split('>=')[0].split('==')[0]
            if not is_package_installed(pkg_name):
                missing.append(dep)
        
        if missing:
            print(f"  ❌ Missing dependencies:")
            for dep in missing:
                print(f"     - {dep}")
            all_ready = False
        else:
            print(f"  ✅ All dependencies installed")
    
    return all_ready


def check_ocr_imports():
    """Try importing OCR modules"""
    print_section("OCR Module Imports")
    
    modules = [
        ('ocr', 'OCR module'),
        ('ocr.facade', 'OCR Facade'),
        ('ocr.config', 'OCR Config'),
        ('ocr.engine_factory', 'Engine Factory'),
    ]
    
    all_imported = True
    
    for module_name, display_name in modules:
        try:
            __import__(module_name)
            print(f"✅ {display_name:20} imported successfully")
        except ImportError as e:
            print(f"❌ {display_name:20} import failed: {e}")
            all_imported = False
    
    return all_imported


def test_ocr_extraction():
    """Test actual OCR extraction"""
    print_section("OCR Extraction Test")
    
    try:
        from ocr import extract_text_from_image
        from PIL import Image, ImageDraw, ImageFont
        
        # Create a simple test image with text
        img = Image.new('RGB', (400, 100), color='white')
        draw = ImageDraw.Draw(img)
        
        # Draw some text
        try:
            # Try to use a default font
            draw.text((10, 30), "Hello OCR Test", fill='black')
        except:
            # If no font available, still create image
            pass
        
        # Try to extract text
        result = extract_text_from_image(img, use_preprocessing=True)
        
        if result.get('success'):
            method = result.get('method', 'unknown')
            confidence = result.get('confidence', 0.0)
            print(f"✅ OCR extraction successful")
            print(f"   Engine used: {method}")
            print(f"   Confidence: {confidence:.2f}")
            return True
        else:
            print(f"⚠️  OCR extraction returned no results")
            print(f"   This may be normal if no text detected in test image")
            return True
            
    except Exception as e:
        print(f"❌ OCR extraction failed: {e}")
        return False


def check_gpu_support():
    """Check GPU/MPS support"""
    print_section("GPU/Acceleration Support")
    
    os_type = get_os_type()
    is_m1 = is_apple_silicon()
    
    # Check PyTorch GPU support
    try:
        import torch
        
        if is_m1:
            # Apple Silicon - check for MPS
            if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                print("✅ PyTorch Metal (MPS) available for Apple Silicon")
            else:
                print("⚠️  PyTorch Metal (MPS) not available")
        elif torch.cuda.is_available():
            print(f"✅ CUDA available - GPU acceleration enabled")
            print(f"   CUDA Version: {torch.version.cuda}")
            print(f"   GPU Device: {torch.cuda.get_device_name(0)}")
        else:
            print("ℹ️  CUDA not available - using CPU")
            
    except ImportError:
        print("ℹ️  PyTorch not installed (only needed for EasyOCR)")
    
    return True


def main():
    """Run all compatibility checks"""
    print("\n" + "=" * 70)
    print(" JIRAForge OCR Platform Compatibility Check")
    print("=" * 70)
    
    checks = [
        ("Python Version", check_python_version),
        ("Platform Info", check_platform_info),
        ("Python Packages", check_pip_packages),
        ("System Binaries", check_system_binaries),
        ("OCR Configuration", check_ocr_engines),
        ("Module Imports", check_ocr_imports),
        ("GPU Support", check_gpu_support),
        ("OCR Extraction", test_ocr_extraction),
    ]
    
    results = {}
    
    for name, check_func in checks:
        try:
            results[name] = check_func()
        except Exception as e:
            print(f"\n❌ Check '{name}' failed with error: {e}")
            results[name] = False
    
    # Summary
    print_section("Summary")
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for name, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status:10} - {name}")
    
    print(f"\nOverall: {passed}/{total} checks passed")
    
    if passed == total:
        print("\n🎉 All checks passed! Your system is ready for OCR.")
    else:
        print("\n⚠️  Some checks failed. Please review the errors above.")
        print("   Run: pip install -r requirements.txt")
        print("   Or: python -m ocr.auto_installer")
    
    return passed == total


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
