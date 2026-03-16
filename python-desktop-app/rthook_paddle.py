"""
PyInstaller runtime hook for PaddlePaddle/PaddleOCR.

This hook runs BEFORE the main application and sets up the environment
for paddle to work correctly in a frozen executable.

CRITICAL: PaddleOCR uses bare 'from ppocr.utils import ...' imports.
In normal Python, paddleocr.__init__ adds its own directory to sys.path.
In frozen EXE, we must replicate this by finding the bundled paddleocr
directory and adding it to sys.path.
"""
import os
import sys
import site


def setup_paddle_environment():
    """Configure environment for PaddlePaddle in PyInstaller bundle."""
    
    # Determine base path (frozen exe or development)
    if getattr(sys, 'frozen', False):
        # Running as frozen exe
        if hasattr(sys, '_MEIPASS'):
            base_path = sys._MEIPASS
        else:
            base_path = os.path.dirname(sys.executable)
        
        # CRITICAL: Disable user site-packages to prevent conflicts with
        # system-wide paddle/paddleocr installations on the end user's machine.
        # The frozen exe must only use its bundled packages.
        site.ENABLE_USER_SITE = False
        
        # Remove any user site-packages from sys.path
        user_site = site.getusersitepackages() if hasattr(site, 'getusersitepackages') else None
        if user_site:
            sys.path = [p for p in sys.path if not p.startswith(user_site)]
    else:
        # Development mode
        return  # No special setup needed
    
    # Add paddle libs to DLL search path (Windows)
    if sys.platform == 'win32':
        paddle_libs = os.path.join(base_path, 'paddle', 'libs')
        if os.path.isdir(paddle_libs):
            # Add to PATH for DLL loading
            current_path = os.environ.get('PATH', '')
            if paddle_libs not in current_path:
                os.environ['PATH'] = paddle_libs + os.pathsep + current_path
            
            # Also use os.add_dll_directory (Python 3.8+)
            try:
                os.add_dll_directory(paddle_libs)
            except (AttributeError, OSError):
                pass  # Not available or failed
    
    # CRITICAL: PaddleOCR uses bare imports like "from ppocr.utils import ..."
    # In normal Python, paddleocr.paddleocr.py does: sys.path.append(__dir__)
    # In frozen EXE, we must find the bundled paddleocr directory and add it
    # to sys.path so ppocr, ppstructure, and tools packages can be resolved.
    paddleocr_dir = os.path.join(base_path, 'paddleocr')
    if os.path.isdir(paddleocr_dir):
        if paddleocr_dir not in sys.path:
            sys.path.insert(0, paddleocr_dir)
    else:
        # Try to find paddleocr in the frozen modules and get its path
        try:
            import paddleocr as _poc
            poc_dir = os.path.dirname(_poc.__file__)
            if poc_dir and os.path.isdir(poc_dir) and poc_dir not in sys.path:
                sys.path.insert(0, poc_dir)
        except (ImportError, AttributeError):
            pass
    
    # Ensure CUDA environment (if bundled)
    cuda_path = os.path.join(base_path, 'cuda')
    if os.path.isdir(cuda_path):
        cuda_bin = os.path.join(cuda_path, 'bin')
        if os.path.isdir(cuda_bin):
            current_path = os.environ.get('PATH', '')
            if cuda_bin not in current_path:
                os.environ['PATH'] = cuda_bin + os.pathsep + current_path
    
    # Disable paddle's model download prompts in frozen mode
    # (models should be bundled or pre-downloaded)
    os.environ.setdefault('PPOCR_HOME', os.path.join(os.path.expanduser('~'), '.paddleocr'))
    
    # Stability settings for Windows
    if sys.platform == 'win32':
        os.environ.setdefault('FLAGS_use_mkldnn', '0')
        cpu_count = os.cpu_count() or 4
        thread_count = str(min(2, max(1, cpu_count // 4)))
        os.environ.setdefault('OMP_NUM_THREADS', thread_count)
        os.environ.setdefault('MKL_NUM_THREADS', thread_count)
        os.environ.setdefault('OPENBLAS_NUM_THREADS', thread_count)


# Run setup immediately when hook is loaded
setup_paddle_environment()
