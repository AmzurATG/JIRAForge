# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Time Tracker Desktop App - macOS Version
Generates a macOS .app bundle with all dependencies bundled.
Compatible with macOS Big Sur 11.0+ and optimized for macOS Tahoe 26.3+
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

# Try to find Tesseract on macOS (common locations)
tesseract_binaries = []
tesseract_locations = [
    '/opt/homebrew/bin/tesseract',  # Apple Silicon Homebrew
    '/usr/local/bin/tesseract',     # Intel Homebrew
    '/usr/bin/tesseract'            # System install
]

for tesseract_path in tesseract_locations:
    if os.path.exists(tesseract_path):
        print(f"[INFO] Found Tesseract at: {tesseract_path}")
        tesseract_binaries.append((tesseract_path, 'tesseract'))
        
        # Also include tessdata if available
        tessdata_dirs = [
            '/opt/homebrew/share/tessdata',
            '/usr/local/share/tessdata', 
            '/usr/share/tessdata'
        ]
        for tessdata_dir in tessdata_dirs:
            if os.path.exists(os.path.join(tessdata_dir, 'eng.traineddata')):
                print(f"[INFO] Found Tesseract data at: {tessdata_dir}")
                tesseract_binaries.append((os.path.join(tessdata_dir, 'eng.traineddata'), 'tesseract/tessdata'))
                break
        break

if not tesseract_binaries:
    print(f"[WARN] Tesseract not found - OCR will use PaddleOCR only")

# Extra submodules used dynamically at runtime
dynamic_hiddenimports = []
dynamic_hiddenimports += collect_submodules('ocr')
dynamic_hiddenimports += collect_submodules('privacy')
dynamic_hiddenimports += collect_submodules('supabase')
dynamic_hiddenimports += collect_submodules('keyring')
dynamic_hiddenimports += collect_submodules('pynput')
dynamic_hiddenimports += collect_submodules('pystray')
dynamic_hiddenimports += collect_submodules('flask')
dynamic_hiddenimports += collect_submodules('flask_cors')
dynamic_hiddenimports += collect_submodules('werkzeug')

# Runtime data files needed by some dependencies
runtime_datas = []
runtime_datas += collect_data_files('certifi')
runtime_datas += collect_data_files('tzdata')

a = Analysis(
    ['mac_desktop_app.py'],
    pathex=[],
    binaries=tesseract_binaries,
    datas=[
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
        # System tray (macOS)
        'pystray',
        'pystray._darwin',
        # macOS frameworks (PyObjC)
        'objc',
        'Foundation',
        'AppKit',
        'Cocoa',
        'Quartz',
        'CoreGraphics',
        'LaunchServices',
        # Input monitoring
        'pynput',
        'pynput.mouse',
        'pynput.keyboard',
        'pynput.mouse._darwin',
        'pynput.keyboard._darwin',
        # Desktop notifications (cross-platform)
        'plyer',
        'plyer.platforms.macosx',
        'plyer.platforms.macosx.notification',
        # Secure storage
        'keyring',
        'keyring.backends',
        'keyring.backends.macOS',
        'keyring.backends.OS_X',
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
        'ocr.engines.dynamic_engine',
        # Legacy OCR modules (backward compatibility)
        'ocr.ocr_engine',
        'ocr.text_extractor',
        # PaddleOCR (optimized for macOS)
        'paddleocr',
        'paddleocr.ppocr',
        'paddleocr.ppocr.utils',
        'paddleocr.ppocr.data',
        'paddlepaddle',
        'paddle',
        'paddle.inference',
        # Tesseract
        'pytesseract',
        # Image/Math (optimized versions)
        'cv2',
        'numpy',
        'numpy.core',
        'numpy.core.multiarray',
        # macOS compatibility modules
        'mac_auto_updater',
        'macos_compatibility',
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
        # Windows-specific modules
        'win32gui',
        'win32process', 
        'win32con',
        'win32event',
        'win32api',
        'winerror',
        'pywintypes',
        'pythoncom',
        'winotify',
        'pystray._win32',
        'pynput.mouse._win32',
        'pynput.keyboard._win32',
        'keyring.backends.Windows',
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
    [],
    exclude_binaries=True,
    name='TimeTracker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # Disabled for macOS compatibility
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=True,  # Important for macOS .app launching
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,  # Disabled for macOS compatibility
    upx_exclude=[],
    name='TimeTracker'
)

# macOS .app bundle configuration
app = BUNDLE(
    coll,
    name='TimeTracker.app',
    icon=None,  # Add icon path here if you have one: icon='icon.icns'
    bundle_identifier='com.amzur.timetracker',
    version='1.2.1',
    info_plist={
        'CFBundleName': 'TimeTracker',
        'CFBundleDisplayName': 'TimeTracker',
        'CFBundleIdentifier': 'com.amzur.timetracker',
        'CFBundleVersion': '1.2.1',
        'CFBundleShortVersionString': '1.2.1',
        'CFBundlePackageType': 'APPL',
        'CFBundleSignature': '????',
        'CFBundleExecutable': 'TimeTracker',
        'NSHumanReadableCopyright': '© 2024 Amzur Technologies. All rights reserved.',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '11.0',  # macOS Big Sur minimum
        'LSApplicationCategoryType': 'public.app-category.productivity',
        'LSBackgroundOnly': False,
        'LSUIElement': True,  # This makes it a menu bar app without dock icon
        
        # Privacy permissions
        'NSScreenCaptureDescription': 'TimeTracker needs screen capture access to take screenshots for time tracking.',
        'NSSystemAdministrationUsageDescription': 'TimeTracker needs system administration access to monitor applications.',
        
        # macOS Tahoe compatibility
        'LSMinimumSystemVersionByArchitecture': {
            'arm64': '11.0',
            'x86_64': '11.0'
        },
        
        # URL scheme for OAuth
        'CFBundleURLTypes': [{
            'CFBundleURLName': 'TimeTracker OAuth',
            'CFBundleURLSchemes': ['brd-time-tracker']
        }],
        
        # Auto-start capability
        'LSSharedFileListGlobalLoginItems': True,
        
        # Hardened runtime entitlements
        'com.apple.security.cs.allow-jit': True,
        'com.apple.security.cs.allow-unsigned-executable-memory': True,
        'com.apple.security.cs.disable-library-validation': True,
    }
)