# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Time Tracker Desktop App
Generates a single-file Windows executable with all dependencies bundled.
"""

import sys
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

sys.setrecursionlimit(sys.getrecursionlimit() * 5)

block_cipher = None

# Collect OCR module files
ocr_datas = []
spec_dir = os.path.abspath('.')
ocr_dir = os.path.join(spec_dir, 'ocr')
if os.path.exists(ocr_dir):
    for root, dirs, files in os.walk(ocr_dir):
        for file in files:
            # Only include Python files, exclude config and env files
            if (
                file.endswith('.py')
                and not file.startswith('.env')
                and file not in ('easyocr_engine.py', 'mock_engine.py', 'demo_engine.py')
            ):
                src = os.path.join(root, file)
                # Preserve directory structure in ocr/
                rel_path = os.path.relpath(root, os.path.dirname(ocr_dir))
                ocr_datas.append((src, rel_path))

# Collect PaddleOCR models (if they exist in user's cache)
paddleocr_models = []
paddleocr_cache = os.path.join(os.path.expanduser('~'), '.paddleocr')
if os.path.exists(paddleocr_cache):
    print(f"[INFO] Found PaddleOCR models at: {paddleocr_cache}")
    # Include the entire .paddleocr directory
    paddleocr_models.append((paddleocr_cache, '.paddleocr'))
else:
    print(f"[WARN] PaddleOCR models not found at: {paddleocr_cache}")
    print(f"[WARN] Models will be downloaded on first run")

# Extra submodules used dynamically at runtime
dynamic_hiddenimports = []
dynamic_hiddenimports += collect_submodules('ocr')
dynamic_hiddenimports += collect_submodules('privacy')
dynamic_hiddenimports += collect_submodules('supabase')
dynamic_hiddenimports += collect_submodules('keyring')
dynamic_hiddenimports += collect_submodules('pynput')
dynamic_hiddenimports += collect_submodules('pystray')

# Runtime data files needed by some dependencies
runtime_datas = []
runtime_datas += collect_data_files('certifi')
runtime_datas += collect_data_files('tzdata')


a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[
        # Tesseract OCR binary (for local OCR processing)
        # Adjust path based on Tesseract installation location
        (r'C:\Program Files\Tesseract-OCR\tesseract.exe', 'tesseract'),
        (r'C:\Program Files\Tesseract-OCR\*.dll', 'tesseract'),
    ],
    datas=[
        # Tesseract language data files
        (r'C:\Program Files\Tesseract-OCR\tessdata\eng.traineddata', 'tesseract/tessdata'),
        *ocr_datas,
        *paddleocr_models,
        *runtime_datas,
    ],
   
    hiddenimports=[
        # Flask and web
        'flask',
        'flask_cors',
        'jinja2',
        'markupsafe',
        'werkzeug',
        'itsdangerous',
        'click',
        'blinker',
        # Supabase and related
        'supabase',
        'postgrest',
        'gotrue',
        'realtime',
        'storage3',
        'supafunc',
        'httpx',
        'httpcore',
        'h11',
        'anyio',
        'sniffio',
        'certifi',
        'httpx._transports',
        'httpx._transports.default',
        # Image handling
        'PIL',
        'PIL.Image',
        'PIL.ImageGrab',
        'PIL.ImageDraw',
        # System tray
        'pystray',
        'pystray._win32',
        # Windows APIs
        'win32gui',
        'win32process',
        'win32con',
        'win32event',
        'win32api',
        'winerror',
        'pywintypes',
        'pythoncom',
        # Input monitoring
        'pynput',
        'pynput.mouse',
        'pynput.keyboard',
        'pynput.mouse._win32',
        'pynput.keyboard._win32',
        # Desktop notifications
        'winotify',
        # Secure storage
        'keyring',
        'keyring.backends',
        'keyring.backends.Windows',
        # Timezone
        'tzlocal',
        'tzdata',
        # Networking
        'requests',
        'urllib3',
        'charset_normalizer',
        'idna',
        'certifi',
        # Environment
        'dotenv',
        # Crypto
        'cryptography',
        # Process management
        'psutil',
        # Tkinter (for pause popup)
        'tkinter',
        'tkinter.ttk',
        # SQLite
        'sqlite3',
        # jaraco (required by pkg_resources)
        'jaraco',
        'jaraco.text',
        'jaraco.functools',
        'jaraco.context',
        # OCR dependencies - New Facade Architecture v2.0
        'ocr',
        'ocr.facade',
        'ocr.config',
        'ocr.engine_factory',
        'ocr.base_engine',
        'ocr.image_processor',
        'ocr.auto_installer',
        # OCR Engines
        'ocr.engines',
        'ocr.engines.paddle_engine',
        'ocr.engines.tesseract_engine',
        'ocr.engines.dynamic_engine',  # NEW: Dynamic engine for any OCR library
        # Legacy OCR modules (backward compatibility)
        'ocr.ocr_engine',
        'ocr.text_extractor',
        # PaddleOCR
        'paddleocr',
        'paddleocr.ppocr',
        'paddleocr.ppocr.utils',
        'paddleocr.ppocr.data',
        'paddlepaddle',
        'paddle',
        'paddle.inference',
        # Tesseract
        'pytesseract',
        # Image/Math
        'cv2',
        'numpy',
        'numpy.core',
        'numpy.core.multiarray',
        # Standard library
        'ctypes',
        'json',
        'threading',
        'webbrowser',
        'tempfile',
        'secrets',
        'hashlib',
        'base64',
        'socket',
        'logging',
    ] + dynamic_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary packages to reduce size
        'matplotlib',  # Not needed for OCR (PaddleOCR imports it but doesn't require it)
        'pandas',
        'scipy',
        'test',
        'unittest',
        'xmlrpc',
        # Exclude optional heavy OCR/ML dependencies not used in production build
        'easyocr',
        'torch',
        'torchvision',
        'torchaudio',
        'tensorboard',
        'torch.utils.tensorboard',
        'detect_secrets',
        'privacy.detectors.secrets_detector',
        'spacy',
        'spacy_legacy',
        'spacy_loggers',
        'thinc',
        'en_core_web_sm',
        'en_core_web_md',
        'en_core_web_lg',
        'ocr.engines.easyocr_engine',
        'ocr.engines.mock_engine',
        'ocr.engines.demo_engine',
        # SECURITY: Exclude .env file to prevent credential leaks
        '.env',
        '.env.local',
        '.env.production',
    ],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='TimeTracker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
