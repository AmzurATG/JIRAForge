"""
OCR Dependency Auto-Installer

Automatically installs missing OCR engine dependencies when configured in .env
Works only in development mode (not in bundled EXE)
Supports cross-platform installation (Windows, Linux, macOS)

Usage:
    from ocr.auto_installer import check_and_install_dependencies
    
    # At app startup
    check_and_install_dependencies()
"""

import os
import sys
import subprocess
import logging
import platform
from typing import Dict, List, Optional, Tuple
from pathlib import Path

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    # Load from the python-desktop-app directory first
    env_path = Path(__file__).parent.parent / '.env'
    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
    else:
        # Fallback: load from ai-server/.env (source of truth for OCR config)
        ai_server_env = Path(__file__).parent.parent.parent / 'ai-server' / '.env'
        if ai_server_env.exists():
            load_dotenv(dotenv_path=ai_server_env)
except ImportError:
    pass  # dotenv not available, will use system environment variables

logger = logging.getLogger(__name__)


def get_os_type() -> str:
    """
    Detect operating system.
    
    Returns:
        'windows', 'linux', or 'macos'
    """
    system = platform.system().lower()
    if system == 'darwin':
        return 'macos'
    elif system == 'linux':
        return 'linux'
    elif system == 'windows':
        return 'windows'
    else:
        logger.warning(f"Unknown OS: {system}, defaulting to linux")
        return 'linux'


def get_cpu_architecture() -> str:
    """
    Detect CPU architecture (for M1/M2 Mac detection).
    
    Returns:
        'x86_64', 'arm64', 'aarch64', etc.
    """
    return platform.machine().lower()


def is_apple_silicon() -> bool:
    """Check if running on Apple Silicon (M1/M2/M3)"""
    return get_os_type() == 'macos' and get_cpu_architecture() in ['arm64', 'aarch64']


# Map OCR engine names to their pip packages (OS-specific)
def get_engine_dependencies(engine_name: str) -> List[str]:
    """
    Get platform-specific dependencies for an OCR engine.
    
    Args:
        engine_name: Engine name ('paddle', 'tesseract', 'easyocr', etc.)
    
    Returns:
        List of pip package specifications for the current platform
    """
    os_type = get_os_type()
    is_m1_mac = is_apple_silicon()
    
    if engine_name == 'paddle':
        deps = ['paddleocr>=2.8.1', 'opencv-python>=4.10.0']
        
        if os_type == 'windows':
            # Windows: Standard PaddlePaddle
            deps.insert(0, 'paddlepaddle>=3.0.0b1')
        elif os_type == 'linux':
            # Linux: Standard PaddlePaddle
            deps.insert(0, 'paddlepaddle>=3.0.0b1')
        elif os_type == 'macos':
            if is_m1_mac:
                # Apple Silicon: No official GPU support yet, use CPU version
                logger.info("Apple Silicon detected - using CPU-only PaddlePaddle")
                deps.insert(0, 'paddlepaddle>=3.0.0b1')
            else:
                # Intel Mac: Standard CPU version
                deps.insert(0, 'paddlepaddle>=3.0.0b1')
        
        return deps
    
    elif engine_name == 'tesseract':
        # pytesseract is cross-platform
        # System tesseract binary must be installed separately on each OS
        return ['pytesseract>=0.3.10']
    
    elif engine_name == 'easyocr':
        # EasyOCR dependencies vary by platform
        base_deps = [
            'scipy',
            'numpy',
            'Pillow',
            'scikit-image',
            'python-bidi',
            'PyYAML',
            'Shapely',
            'pyclipper',
        ]
        
        if os_type == 'windows':
            # Windows: Standard PyTorch
            torch_deps = ['torch>=2.0.0', 'torchvision>=0.15.0']
        elif os_type == 'linux':
            # Linux: Standard PyTorch (may need CUDA for GPU)
            torch_deps = ['torch>=2.0.0', 'torchvision>=0.15.0']
        elif os_type == 'macos':
            if is_m1_mac:
                # Apple Silicon: Use MPS (Metal Performance Shaders) support
                logger.info("Apple Silicon detected - using PyTorch with MPS support")
                torch_deps = ['torch>=2.0.0', 'torchvision>=0.15.0']
            else:
                # Intel Mac: Standard PyTorch
                torch_deps = ['torch>=2.0.0', 'torchvision>=0.15.0']
        
        # Add ninja on non-Windows for EasyOCR build requirements
        if os_type != 'windows':
            base_deps.append('ninja')
        
        return torch_deps + base_deps + ['easyocr>=1.7.0']
    
    elif engine_name in ['mock', 'demo']:
        return []  # No dependencies, built-in
    
    else:
        # Unknown engine - check for OCR_<ENGINE>_PACKAGE in environment
        package_env_var = f'OCR_{engine_name.upper()}_PACKAGE'
        package_name = os.getenv(package_env_var)
        
        if package_name:
            logger.info(f"Found custom package for '{engine_name}': {package_name}")
            return [package_name]
        
        # Try to guess the package name using dynamic engine logic
        try:
            from ocr.engines.dynamic_engine import _guess_package_name
            guessed = _guess_package_name(engine_name)
            if guessed:
                logger.info(f"Auto-detected package '{guessed}' for engine '{engine_name}'")
                return [guessed]
        except ImportError:
            pass
        
        logger.warning(
            f"Unknown engine: {engine_name}. "
            f"Set {package_env_var} in .env to specify the pip package."
        )
        return []


# Legacy mapping (for backward compatibility)
# NOTE: Actual dependencies are resolved dynamically by get_engine_dependencies()
# For unknown engines, set OCR_<ENGINE>_PACKAGE=<pip-package> in .env
ENGINE_DEPENDENCIES: Dict[str, List[str]] = {
    'paddle': [],  # Use get_engine_dependencies() instead
    'tesseract': [],
    'easyocr': [],
    'mock': [],
    'demo': [],
}

# Special handling for packages with conflicts
CONFLICTING_PACKAGES = {
    'opencv-python-headless': 'opencv-python',  # Use opencv-python instead
}


def is_development_mode() -> bool:
    """
    Check if running in development mode (not bundled EXE).
    
    Returns:
        True if in development, False if frozen (bundled)
    """
    return not getattr(sys, 'frozen', False)


def is_package_installed(package_name: str) -> bool:
    """
    Check if a Python package is installed.
    
    Args:
        package_name: Package name (e.g., 'paddleocr', 'pytesseract')
    
    Returns:
        True if installed, False otherwise
    """
    # Remove version specifier if present
    package = package_name.split('>=')[0].split('==')[0].split('<')[0]
    
    try:
        __import__(package)
        return True
    except ImportError:
        return False


def get_configured_engines() -> List[str]:
    """
    Get OCR engines from environment configuration.
    
    Reads from environment variables:
    - OCR_PRIMARY_ENGINE: Primary OCR engine (default: rapidocr)
    - OCR_FALLBACK_ENGINES: Comma-separated fallback engines (default: winrtocr)
    
    Returns:
        List of engine names (e.g., ['rapidocr', 'winrtocr'])
    """
    engines = []
    
    # Primary engine from env (default: rapidocr)
    primary = os.getenv('OCR_PRIMARY_ENGINE', 'rapidocr')
    engines.append(primary.lower())
    
    # Fallback engines from env (default: winrtocr)
    fallbacks = os.getenv('OCR_FALLBACK_ENGINES', 'winrtocr')
    if fallbacks:
        for engine in fallbacks.split(','):
            engine = engine.strip().lower()
            if engine and engine not in engines:
                engines.append(engine)
    
    return engines


def install_package(package: str, silent: bool = False) -> bool:
    """
    Install a Python package using pip.
    
    Args:
        package: Package specification (e.g., 'paddleocr>=2.8.1')
        silent: If True, suppress output
    
    Returns:
        True if installation successful, False otherwise
    """
    try:
        if not silent:
            print(f"  📦 Installing {package}...")
        
        cmd = [sys.executable, '-m', 'pip', 'install', package]
        
        if silent:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
        else:
            result = subprocess.run(cmd, check=True)
        
        if not silent:
            print(f"  ✅ Successfully installed {package}")
        
        return True
        
    except subprocess.CalledProcessError as e:
        if not silent:
            print(f"  ❌ Failed to install {package}: {e}")
        logger.error(f"Failed to install {package}: {e}")
        return False


def uninstall_package(package: str, silent: bool = False) -> bool:
    """
    Uninstall a Python package using pip.
    
    Args:
        package: Package name (e.g., 'opencv-python-headless')
        silent: If True, suppress output
    
    Returns:
        True if uninstallation successful, False otherwise
    """
    try:
        if not silent:
            print(f"  🗑️  Uninstalling conflicting package: {package}...")
        
        cmd = [sys.executable, '-m', 'pip', 'uninstall', '-y', package]
        
        if silent:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )
        else:
            result = subprocess.run(cmd, check=True)
        
        if not silent:
            print(f"  ✅ Successfully uninstalled {package}")
        
        return True
        
    except subprocess.CalledProcessError as e:
        if not silent:
            print(f"  ⚠️  Could not uninstall {package}: {e}")
        logger.warning(f"Could not uninstall {package}: {e}")
        return False


def resolve_opencv_conflict(silent: bool = False) -> bool:
    """
    Resolve conflict between opencv-python and opencv-python-headless.
    Keeps opencv-python (more feature-complete) and removes headless version.
    
    Args:
        silent: If True, suppress output
    
    Returns:
        True if conflict resolved, False otherwise
    """
    if is_package_installed('opencv-python-headless') and is_package_installed('opencv-python'):
        if not silent:
            print("  ⚠️  Detected OpenCV conflict (opencv-python and opencv-python-headless)")
            print("  🔧 Resolving: Keeping opencv-python, removing opencv-python-headless...")
        
        return uninstall_package('opencv-python-headless', silent=silent)
    
    return True


def get_missing_dependencies(engine_name: str) -> List[str]:
    """
    Get list of missing dependencies for an OCR engine (OS-specific).
    
    Args:
        engine_name: Engine name (e.g., 'paddle', 'tesseract')
    
    Returns:
        List of missing package specifications for current platform
    """
    # Get platform-specific dependencies
    dependencies = get_engine_dependencies(engine_name)
    
    # If no dependencies found, check for dynamic engine
    if not dependencies:
        # Check if it's a dynamic engine with package configured
        package_env_var = f'OCR_{engine_name.upper()}_PACKAGE'
        package_name = os.getenv(package_env_var)
        
        if not package_name:
            # Try to guess the package name using dynamic engine logic
            try:
                from ocr.engines.dynamic_engine import _guess_package_name
                package_name = _guess_package_name(engine_name)
                if package_name:
                    logger.debug(f"Auto-detected package '{package_name}' for engine '{engine_name}'")
            except ImportError:
                logger.debug("Could not import dynamic_engine for package detection")
                pass
        
        if package_name:
            logger.debug(f"Unknown engine '{engine_name}' but found package: {package_name}")
            # Check if the package is installed
            if not is_package_installed(package_name):
                return [package_name]
            return []
        
        logger.warning(f"Unknown engine: {engine_name}. Set {package_env_var} in .env to specify the package.")
        return []
    
    # Check which packages are missing
    missing = []
    for package in dependencies:
        package_name = package.split('>=')[0].split('==')[0].split('<')[0]
        if not is_package_installed(package_name):
            missing.append(package)
    
    return missing


def check_system_dependencies() -> Dict[str, Tuple[bool, str]]:
    """
    Check for system-level OCR dependencies (non-Python).
    
    Returns:
        Dict mapping engine to (installed: bool, install_cmd: str)
    """
    os_type = get_os_type()
    results = {}
    
    # Check Tesseract system binary
    try:
        subprocess.run(
            ['tesseract', '--version'],
            capture_output=True,
            check=True
        )
        results['tesseract_binary'] = (True, '')
    except (subprocess.CalledProcessError, FileNotFoundError):
        if os_type == 'windows':
            install_cmd = 'Download from: https://github.com/UB-Mannheim/tesseract/wiki'
        elif os_type == 'linux':
            install_cmd = 'sudo apt-get install tesseract-ocr'  # Debian/Ubuntu
        elif os_type == 'macos':
            install_cmd = 'brew install tesseract'
        
        results['tesseract_binary'] = (False, install_cmd)
    
    return results


def check_and_install_dependencies(
    auto_install: bool = True,
    silent: bool = False
) -> Dict[str, bool]:
    """
    Check OCR engines from environment config and install missing dependencies.
    Platform-aware: installs correct packages for Windows, Linux, and macOS.
    
    Reads engine configuration from environment variables:
    - OCR_PRIMARY_ENGINE (default: rapidocr)
    - OCR_FALLBACK_ENGINES (default: winrtocr)
    
    Args:
        auto_install: If True, automatically install missing packages
                     If False, only report missing packages
        silent: If True, suppress console output
    
    Returns:
        Dict mapping engine names to installation success status
    """
    # Skip in production (bundled EXE)
    if not is_development_mode():
        logger.debug("Running in production mode, skipping dependency check")
        return {}
    
    # Get engines from environment config
    engines = get_configured_engines()
    
    os_type = get_os_type()
    cpu_arch = get_cpu_architecture()
    
    if not silent:
        print(f"\n{'='*70}")
        print(" 🔍 Checking OCR Engine Dependencies")
        print(f"{'='*70}")
        print(f"Operating System: {os_type.upper()} ({cpu_arch})")
        if is_apple_silicon():
            print(f"Apple Silicon detected: Using optimized dependencies")
        print(f"OCR engines (from env config): {', '.join(engines)}\n")
    
    results = {}
    
    # Check system-level dependencies first
    if 'tesseract' in engines and not silent:
        sys_deps = check_system_dependencies()
        if 'tesseract_binary' in sys_deps:
            installed, install_cmd = sys_deps['tesseract_binary']
            if not installed:
                print(f"⚠️  Tesseract system binary not found")
                print(f"   Install with: {install_cmd}\n")
    
    for engine in engines:
        if not silent:
            print(f"[{engine.upper()}]")
        
        # Special handling for EasyOCR (opencv conflict)
        if engine == 'easyocr':
            resolve_opencv_conflict(silent=silent)
        
        missing = get_missing_dependencies(engine)
        
        if not missing:
            if not silent:
                print(f"  ✅ All Python dependencies installed\n")
            results[engine] = True
            continue
        
        if not silent:
            print(f"  ⚠️  Missing dependencies:")
            for pkg in missing:
                print(f"     - {pkg}")
        
        if auto_install:
            if not silent:
                print(f"  🔧 Installing missing packages...")
            
            success = True
            for pkg in missing:
                if not install_package(pkg, silent=silent):
                    success = False
            
            results[engine] = success
            
            if success and not silent:
                print(f"  ✅ {engine.upper()} ready to use!\n")
            elif not silent:
                print(f"  ❌ Installation failed. Install manually:\n")
                print(f"     pip install {' '.join(missing)}\n")
        else:
            if not silent:
                print(f"  💡 To install, run:")
                print(f"     pip install {' '.join(missing)}\n")
            results[engine] = False
    
    if not silent:
        print(f"{'='*70}\n")
    
    return results


def add_engine_to_env(engine_name: str, as_primary: bool = False) -> bool:
    """
    Add an OCR engine to .env file and install its dependencies.
    Platform-aware: installs correct packages for current OS.
    
    Args:
        engine_name: Engine name (e.g., 'easyocr')
        as_primary: If True, set as primary engine
    
    Returns:
        True if successful
    """
    if not is_development_mode():
        print("❌ Cannot modify .env in production mode")
        return False
    
    # Get platform-specific dependencies
    os_type = get_os_type()
    dependencies = get_engine_dependencies(engine_name)
    
    if not dependencies and engine_name not in ['mock', 'demo']:
        print(f"⚠️  No known dependencies for engine: {engine_name}")
        print(f"   Known engines: paddle, tesseract, easyocr, mock, demo")
        print(f"   For custom engines, set OCR_{engine_name.upper()}_PACKAGE in .env")
        print(f"   Proceeding anyway (engine may use dynamic adapter)...")
    
    print(f"\n🔧 Adding {engine_name} to .env file...")
    print(f"Platform: {os_type.upper()}  ({get_cpu_architecture()})")
    
    # Check system-level dependencies
    if engine_name == 'tesseract':
        sys_deps = check_system_dependencies()
        if 'tesseract_binary' in sys_deps:
            installed, install_cmd = sys_deps['tesseract_binary']
            if not installed:
                print(f"\n⚠️  Warning: Tesseract system binary not found")
                print(f"   You need to install it separately:")
                print(f"   {install_cmd}\n")
    
    # Install dependencies first
    missing = get_missing_dependencies(engine_name)
    if missing:
        print(f"📦 Installing platform-specific dependencies...")
        for pkg in missing:
            print(f"   - {pkg}")
            if not install_package(pkg):
                print(f"❌ Failed to install {pkg}")
                return False
    
    # Update .env file
    env_path = '.env'
    if not os.path.exists(env_path):
        print(f"❌ .env file not found")
        return False
    
    with open(env_path, 'r') as f:
        lines = f.readlines()
    
    # Update or add configuration
    primary_found = False
    fallback_found = False
    
    for i, line in enumerate(lines):
        if line.startswith('OCR_PRIMARY_ENGINE=') and as_primary:
            lines[i] = f"OCR_PRIMARY_ENGINE={engine_name}\n"
            primary_found = True
        elif line.startswith('OCR_FALLBACK_ENGINES='):
            # Add to fallback list if not already present
            current = line.split('=')[1].strip()
            engines = [e.strip() for e in current.split(',')]
            if engine_name not in engines:
                engines.append(engine_name)
                lines[i] = f"OCR_FALLBACK_ENGINES={','.join(engines)}\n"
            fallback_found = True
    
    # Add lines if not found
    if as_primary and not primary_found:
        lines.append(f"OCR_PRIMARY_ENGINE={engine_name}\n")
    elif not fallback_found:
        lines.append(f"OCR_FALLBACK_ENGINES={engine_name}\n")
    
    with open(env_path, 'w') as f:
        f.writelines(lines)
    
    print(f"✅ {engine_name} configured successfully!")
    return True


if __name__ == "__main__":
    # CLI usage
    import argparse
    
    parser = argparse.ArgumentParser(description='OCR Dependency Manager')
    parser.add_argument(
        '--check',
        action='store_true',
        help='Check dependencies without installing'
    )
    parser.add_argument(
        '--add',
        type=str,
        help='Add OCR engine (e.g., --add easyocr)'
    )
    parser.add_argument(
        '--primary',
        action='store_true',
        help='Set as primary engine (use with --add)'
    )
    
    args = parser.parse_args()
    
    if args.add:
        add_engine_to_env(args.add, as_primary=args.primary)
    else:
        check_and_install_dependencies(auto_install=not args.check)
