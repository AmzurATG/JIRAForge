"""
OCR Runtime Installer for Bundled EXE

This module handles automatic OCR dependency setup when the bundled EXE runs
on end-user machines. Unlike auto_installer.py (development only), this works
in production/frozen mode.

Responsibilities:
1. Read configured engines from environment (OCR_PRIMARY_ENGINE, OCR_FALLBACK_ENGINES)
2. Check if PaddleOCR models are present (if paddle is configured)
3. Download models if missing (with progress indication)
4. Optionally install Tesseract as fallback engine (if tesseract is configured)
5. Provide user-friendly error messages

Usage:
    from ocr.runtime_installer import ensure_ocr_ready
    
    # At app startup (before OCR is used)
    result = ensure_ocr_ready(callback=progress_callback)
"""

import os
import sys
import shutil
import logging
import subprocess
import urllib.request
import zipfile
import tempfile
from pathlib import Path
from typing import Callable, Dict, Any, Optional, Tuple, List

logger = logging.getLogger(__name__)


def get_configured_engines() -> List[str]:
    """
    Read configured OCR engines from environment variables.
    
    Returns:
        List of engine names (e.g., ['paddle', 'tesseract'])
    """
    engines = []
    primary = os.environ.get('OCR_PRIMARY_ENGINE', 'rapidocr').lower()
    engines.append(primary)
    
    fallbacks = os.environ.get('OCR_FALLBACK_ENGINES', 'winrtocr')
    if fallbacks:
        for engine in fallbacks.split(','):
            engine = engine.strip().lower()
            if engine and engine not in engines:
                engines.append(engine)
    
    return engines


# PaddleOCR model URLs (official release links)
# These are the default models that PaddleOCR downloads
PADDLEOCR_MODEL_URLS = {
    'det': {
        'name': 'Detection Model (en_PP-OCRv3_det)',
        'url': 'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
        'target_dir': 'det/en/en_PP-OCRv3_det_infer',
    },
    'rec': {
        'name': 'Recognition Model (en_PP-OCRv4_rec)',
        'url': 'https://paddleocr.bj.bcebos.com/PP-OCRv4/english/en_PP-OCRv4_rec_infer.tar',
        'target_dir': 'rec/en/en_PP-OCRv4_rec_infer',
    },
    'cls': {
        'name': 'Classification Model (ch_ppocr_mobile_v2.0_cls)',
        'url': 'https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_cls_infer.tar',
        'target_dir': 'cls/ch_ppocr_mobile_v2.0_cls_infer',
    },
}

# Tesseract installer URLs
TESSERACT_INSTALLERS = {
    'windows': {
        'url': 'https://github.com/UB-Mannheim/tesseract/releases/download/v5.3.3/tesseract-ocr-w64-setup-5.3.3.20231005.exe',
        'filename': 'tesseract-ocr-setup.exe',
        'install_cmd': None,  # GUI installer
    },
    'winget': 'UB-Mannheim.TesseractOCR',
    'choco': 'tesseract',
    'scoop': 'tesseract',
}


def get_paddleocr_models_dir() -> Path:
    """Get the PaddleOCR models directory path."""
    return Path.home() / '.paddleocr' / 'whl'


def get_bundled_models_dir() -> Optional[Path]:
    """Get bundled models directory if running as frozen EXE."""
    if not getattr(sys, 'frozen', False):
        return None
    
    if hasattr(sys, '_MEIPASS'):
        base_path = Path(sys._MEIPASS)
    else:
        base_path = Path(sys.executable).parent
    
    bundled = base_path / '.paddleocr' / 'whl'
    return bundled if bundled.exists() else None


def check_paddleocr_models() -> Dict[str, bool]:
    """
    Check which PaddleOCR models are present.
    
    Returns:
        Dict mapping model type to presence (True/False)
    """
    models_dir = get_paddleocr_models_dir()
    results = {}
    
    for model_type, info in PADDLEOCR_MODEL_URLS.items():
        model_path = models_dir / info['target_dir']
        results[model_type] = model_path.exists() and any(model_path.iterdir()) if model_path.exists() else False
    
    return results


def check_tesseract_installed() -> Tuple[bool, Optional[str]]:
    """
    Check if Tesseract is installed and accessible.
    
    Returns:
        Tuple of (installed: bool, path: Optional[str])
    """
    # Check common installation paths on Windows
    common_paths = [
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
        os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe'),
    ]
    
    # Check PATH first
    try:
        result = subprocess.run(
            ['tesseract', '--version'],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return True, 'tesseract'  # Found in PATH
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    
    # Check common paths
    for path in common_paths:
        if os.path.exists(path):
            return True, path
    
    return False, None


def download_file_with_progress(
    url: str,
    dest_path: Path,
    callback: Optional[Callable[[str, int, int], None]] = None
) -> bool:
    """
    Download a file with progress callback.
    
    Args:
        url: URL to download from
        dest_path: Destination file path
        callback: Optional callback(status_msg, bytes_downloaded, total_bytes)
    
    Returns:
        True if successful, False otherwise
    """
    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        
        request = urllib.request.Request(url, headers={'User-Agent': 'TimeTracker/1.0'})
        
        with urllib.request.urlopen(request, timeout=60) as response:
            total_size = int(response.headers.get('Content-Length', 0))
            downloaded = 0
            chunk_size = 8192
            
            with open(dest_path, 'wb') as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    
                    if callback:
                        callback(f"Downloading... {downloaded / 1024 / 1024:.1f}MB", downloaded, total_size)
        
        return True
        
    except Exception as e:
        logger.error(f"Download failed from {url}: {e}")
        if dest_path.exists():
            dest_path.unlink()
        return False


def extract_tar_file(tar_path: Path, extract_to: Path) -> bool:
    """Extract a .tar file to the specified directory."""
    try:
        import tarfile
        extract_to.mkdir(parents=True, exist_ok=True)
        
        with tarfile.open(tar_path, 'r:*') as tar:
            tar.extractall(path=extract_to)
        
        return True
    except Exception as e:
        logger.error(f"Failed to extract {tar_path}: {e}")
        return False


def download_paddleocr_models(
    callback: Optional[Callable[[str, int, int], None]] = None,
    models_to_download: Optional[list] = None
) -> Dict[str, bool]:
    """
    Download missing PaddleOCR models.
    
    Args:
        callback: Progress callback(status_msg, current_step, total_steps)
        models_to_download: List of model types to download, or None for all missing
    
    Returns:
        Dict mapping model type to download success
    """
    models_dir = get_paddleocr_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)
    
    # Determine which models to download
    if models_to_download is None:
        existing = check_paddleocr_models()
        models_to_download = [m for m, present in existing.items() if not present]
    
    if not models_to_download:
        logger.info("All PaddleOCR models already present")
        return {m: True for m in PADDLEOCR_MODEL_URLS.keys()}
    
    results = {}
    total_models = len(models_to_download)
    
    for idx, model_type in enumerate(models_to_download, 1):
        if model_type not in PADDLEOCR_MODEL_URLS:
            logger.warning(f"Unknown model type: {model_type}")
            results[model_type] = False
            continue
        
        info = PADDLEOCR_MODEL_URLS[model_type]
        model_name = info['name']
        url = info['url']
        target_dir = models_dir / info['target_dir']
        
        if callback:
            callback(f"Downloading {model_name} ({idx}/{total_models})...", idx, total_models)
        
        logger.info(f"Downloading PaddleOCR model: {model_name}")
        
        # Download to temp file
        with tempfile.NamedTemporaryFile(suffix='.tar', delete=False) as tmp:
            tmp_path = Path(tmp.name)
        
        try:
            # Download
            def download_progress(msg, downloaded, total):
                if callback:
                    callback(f"{model_name}: {msg}", idx, total_models)
            
            if not download_file_with_progress(url, tmp_path, download_progress):
                results[model_type] = False
                continue
            
            # Extract
            if callback:
                callback(f"Extracting {model_name}...", idx, total_models)
            
            # Create parent directory for the model
            target_dir.parent.mkdir(parents=True, exist_ok=True)
            
            # Extract to a temp location first, then move
            with tempfile.TemporaryDirectory() as extract_tmp:
                extract_path = Path(extract_tmp)
                if not extract_tar_file(tmp_path, extract_path):
                    results[model_type] = False
                    continue
                
                # Find the extracted directory (usually named after the model)
                extracted_dirs = list(extract_path.iterdir())
                if extracted_dirs:
                    # Move the extracted content to target
                    if target_dir.exists():
                        shutil.rmtree(target_dir)
                    shutil.move(str(extracted_dirs[0]), str(target_dir))
            
            logger.info(f"Successfully installed {model_name} to {target_dir}")
            results[model_type] = True
            
        except Exception as e:
            logger.error(f"Failed to install {model_name}: {e}")
            results[model_type] = False
        
        finally:
            # Clean up temp file
            if tmp_path.exists():
                tmp_path.unlink()
    
    return results


def copy_bundled_models(
    callback: Optional[Callable[[str, int, int], None]] = None
) -> bool:
    """
    Copy bundled models from EXE to user's home directory.
    
    Args:
        callback: Progress callback
    
    Returns:
        True if models were copied or already exist, False on error
    """
    bundled_dir = get_bundled_models_dir()
    if not bundled_dir:
        logger.debug("No bundled models directory found")
        return False
    
    target_dir = get_paddleocr_models_dir()
    
    if target_dir.exists() and any(target_dir.iterdir()):
        logger.info(f"PaddleOCR models already exist at {target_dir}")
        return True
    
    try:
        if callback:
            callback("Copying bundled OCR models...", 1, 2)
        
        logger.info(f"Copying bundled models from {bundled_dir} to {target_dir}")
        
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(bundled_dir, target_dir, dirs_exist_ok=True)
        
        if callback:
            callback("OCR models ready!", 2, 2)
        
        logger.info("Successfully copied bundled PaddleOCR models")
        return True
        
    except Exception as e:
        logger.error(f"Failed to copy bundled models: {e}")
        return False


def install_tesseract_windows(
    method: str = 'auto',
    callback: Optional[Callable[[str, int, int], None]] = None
) -> bool:
    """
    Install Tesseract on Windows using available package managers.
    
    Args:
        method: 'auto', 'winget', 'choco', 'scoop', or 'download'
        callback: Progress callback
    
    Returns:
        True if installation successful
    """
    if callback:
        callback("Checking Tesseract installation...", 1, 3)
    
    # Check if already installed
    installed, path = check_tesseract_installed()
    if installed:
        logger.info(f"Tesseract already installed at: {path}")
        return True
    
    if method == 'auto':
        # Try each method in order
        for m in ['winget', 'choco', 'scoop']:
            if install_tesseract_windows(m, callback):
                return True
        # Fall back to direct download
        method = 'download'
    
    if callback:
        callback(f"Installing Tesseract via {method}...", 2, 3)
    
    try:
        if method == 'winget':
            result = subprocess.run(
                ['winget', 'install', '-e', '--id', TESSERACT_INSTALLERS['winget'], '--accept-source-agreements', '--accept-package-agreements'],
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode == 0:
                logger.info("Tesseract installed via winget")
                if callback:
                    callback("Tesseract installed successfully!", 3, 3)
                return True
                
        elif method == 'choco':
            result = subprocess.run(
                ['choco', 'install', TESSERACT_INSTALLERS['choco'], '-y'],
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode == 0:
                logger.info("Tesseract installed via Chocolatey")
                if callback:
                    callback("Tesseract installed successfully!", 3, 3)
                return True
                
        elif method == 'scoop':
            result = subprocess.run(
                ['scoop', 'install', TESSERACT_INSTALLERS['scoop']],
                capture_output=True,
                text=True,
                timeout=300
            )
            if result.returncode == 0:
                logger.info("Tesseract installed via Scoop")
                if callback:
                    callback("Tesseract installed successfully!", 3, 3)
                return True
                
        elif method == 'download':
            # Download and run installer
            if callback:
                callback("Downloading Tesseract installer...", 2, 3)
            
            installer_url = TESSERACT_INSTALLERS['windows']['url']
            installer_name = TESSERACT_INSTALLERS['windows']['filename']
            
            with tempfile.TemporaryDirectory() as tmp_dir:
                installer_path = Path(tmp_dir) / installer_name
                
                if download_file_with_progress(installer_url, installer_path, callback):
                    if callback:
                        callback("Running Tesseract installer...", 3, 3)
                    
                    # Run installer (this will show GUI)
                    subprocess.run([str(installer_path)], check=False)
                    
                    # Check if installation succeeded
                    installed, _ = check_tesseract_installed()
                    if installed:
                        logger.info("Tesseract installed successfully")
                        return True
                        
    except subprocess.TimeoutExpired:
        logger.warning(f"Tesseract installation via {method} timed out")
    except FileNotFoundError:
        logger.debug(f"Package manager '{method}' not found")
    except Exception as e:
        logger.error(f"Failed to install Tesseract via {method}: {e}")
    
    return False


def ensure_ocr_ready(
    callback: Optional[Callable[[str, int, int], None]] = None,
    download_if_missing: bool = True,
    install_tesseract: bool = False
) -> Dict[str, Any]:
    """
    Ensure OCR engines are ready to use.
    
    This is the main entry point for runtime OCR setup. Call this at app startup.
    
    Args:
        callback: Progress callback(status_msg, current_step, total_steps)
        download_if_missing: If True, download PaddleOCR models if not present
        install_tesseract: If True, attempt to install Tesseract as fallback
    
    Returns:
        Dict with status information:
            - configured_engines: List[str]
            - paddleocr_ready: bool
            - paddleocr_models: Dict[str, bool]
            - tesseract_ready: bool
            - tesseract_path: Optional[str]
            - errors: List[str]
    """
    configured = get_configured_engines()
    
    result = {
        'configured_engines': configured,
        'paddleocr_ready': False,
        'paddleocr_models': {},
        'tesseract_ready': False,
        'tesseract_path': None,
        'errors': [],
    }
    
    total_steps = 1  # At least summary step
    if 'paddle' in configured:
        total_steps += 1
    if 'tesseract' in configured:
        total_steps += 1
    
    current_step = 0
    
    if callback:
        callback(f"Checking OCR engines: {', '.join(configured)}...", 0, total_steps)
    
    # Step: Check/setup PaddleOCR models (only if paddle is configured)
    if 'paddle' in configured:
        current_step += 1
        logger.info("PaddleOCR engine configured - checking models...")
        
        # First try to copy bundled models
        bundled_copied = copy_bundled_models(callback)
        
        # Check what models we have
        models_status = check_paddleocr_models()
        result['paddleocr_models'] = models_status
        
        all_models_present = all(models_status.values())
        
        if not all_models_present and download_if_missing:
            logger.info("Some PaddleOCR models missing, attempting download...")
            
            if callback:
                callback("Downloading missing OCR models...", current_step, total_steps)
            
            download_results = download_paddleocr_models(callback)
            
            # Update status
            models_status = check_paddleocr_models()
            result['paddleocr_models'] = models_status
            
            if not all(download_results.values()):
                failed = [m for m, ok in download_results.items() if not ok]
                result['errors'].append(f"Failed to download models: {', '.join(failed)}")
        
        result['paddleocr_ready'] = all(models_status.values())
        
        if result['paddleocr_ready']:
            logger.info("PaddleOCR models ready")
        else:
            missing = [m for m, present in models_status.items() if not present]
            logger.warning(f"PaddleOCR models missing: {missing}")
    else:
        logger.info("PaddleOCR engine not configured - skipping model check")
    
    # Step: Check Tesseract (only if tesseract is configured)
    if 'tesseract' in configured:
        current_step += 1
        if callback:
            callback("Checking Tesseract...", current_step, total_steps)
        
        tesseract_installed, tesseract_path = check_tesseract_installed()
        result['tesseract_ready'] = tesseract_installed
        result['tesseract_path'] = tesseract_path
        
        if tesseract_installed:
            logger.info(f"Tesseract available at: {tesseract_path}")
        elif install_tesseract:
            logger.info("Tesseract not found, attempting installation...")
            if install_tesseract_windows('auto', callback):
                result['tesseract_ready'] = True
                _, result['tesseract_path'] = check_tesseract_installed()
            else:
                result['errors'].append("Failed to install Tesseract automatically")
        else:
            logger.info("Tesseract not installed (optional fallback engine)")
    else:
        logger.info("Tesseract engine not configured - skipping check")
    
    # Summary step
    current_step += 1
    if callback:
        all_ready = True
        if 'paddle' in configured and not result['paddleocr_ready']:
            all_ready = False
        if 'tesseract' in configured and not result['tesseract_ready']:
            all_ready = False
        
        if all_ready:
            callback("OCR engines ready!", current_step, total_steps)
        else:
            callback("OCR setup incomplete - some engines may be unavailable", current_step, total_steps)
    
    return result


def get_ocr_status_summary() -> str:
    """Get a human-readable summary of OCR engine status."""
    configured = get_configured_engines()
    lines = [f"OCR Engine Status (configured: {', '.join(configured)}):"]
    
    # PaddleOCR
    if 'paddle' in configured:
        models = check_paddleocr_models()
        paddle_ok = all(models.values())
        lines.append(f"  PaddleOCR: {'Ready' if paddle_ok else 'Missing models'}")
        for model, present in models.items():
            lines.append(f"    - {model}: {'OK' if present else 'MISSING'}")
    
    # Tesseract
    if 'tesseract' in configured:
        tesseract_ok, tesseract_path = check_tesseract_installed()
        if tesseract_ok:
            lines.append(f"  Tesseract: Ready ({tesseract_path})")
        else:
            lines.append("  Tesseract: Not installed")
    
    # Other configured engines
    other_engines = [e for e in configured if e not in ('paddle', 'tesseract', 'mock', 'demo')]
    for engine_name in other_engines:
        try:
            from .engine_factory import EngineFactory
            if EngineFactory.is_registered(engine_name):
                lines.append(f"  {engine_name}: Registered")
            else:
                lines.append(f"  {engine_name}: Not registered (may use dynamic adapter)")
        except Exception:
            lines.append(f"  {engine_name}: Status unknown")
    
    return '\n'.join(lines)


if __name__ == '__main__':
    # Test the installer
    logging.basicConfig(level=logging.INFO)
    
    def progress(msg, current, total):
        print(f"[{current}/{total}] {msg}")
    
    print("\n" + "=" * 60)
    print("OCR Runtime Installer Test")
    print("=" * 60 + "\n")
    
    result = ensure_ocr_ready(callback=progress, download_if_missing=True)
    
    print("\nResult:")
    for key, value in result.items():
        print(f"  {key}: {value}")
    
    print("\n" + get_ocr_status_summary())
