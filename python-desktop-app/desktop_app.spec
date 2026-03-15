# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Time Tracker Desktop App
Generates a single-file Windows executable with all dependencies bundled.

OCR engines are now DYNAMICALLY detected from .env configuration:
- Reads OCR_PRIMARY_ENGINE and OCR_FALLBACK_ENGINES from .env
- Only bundles engines that are configured and installed
- Automatically discovers hidden imports for each engine

MANUAL INSTALLATION (if auto-install fails):
1. Tesseract OCR - Install from https://github.com/UB-Mannheim/tesseract/wiki
2. PaddleOCR models - Run `python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='en')"` 
   to download models to ~/.paddleocr/
"""

import sys
import os
import glob
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_dynamic_libs

sys.setrecursionlimit(sys.getrecursionlimit() * 5)

block_cipher = None

# ==============================================================================
# READ OCR ENGINE CONFIGURATION FROM .env
# Dynamically determine which engines to bundle
# ==============================================================================
def read_env_file(env_path):
    """Read .env file and return dict of key=value pairs."""
    env_vars = {}
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, _, value = line.partition('=')
                    env_vars[key.strip()] = value.strip()
    return env_vars

env_config = read_env_file(os.path.join(os.path.abspath('.'), '.env'))
# Fall back to ai-server/.env, then .env.example
if not env_config or 'OCR_PRIMARY_ENGINE' not in env_config:
    ai_server_env = read_env_file(os.path.join(os.path.abspath('.'), '..', 'ai-server', '.env'))
    if ai_server_env:
        # Merge: ai-server values fill in gaps
        for k, v in ai_server_env.items():
            if k not in env_config:
                env_config[k] = v
if 'OCR_PRIMARY_ENGINE' not in env_config:
    env_config.update(read_env_file(os.path.join(os.path.abspath('.'), '.env.example')))

primary_engine = env_config.get('OCR_PRIMARY_ENGINE', 'rapidocr').lower()
fallback_engines_str = env_config.get('OCR_FALLBACK_ENGINES', 'winrtocr')
fallback_engines = [e.strip().lower() for e in fallback_engines_str.split(',') if e.strip()]
configured_engines = [primary_engine] + [e for e in fallback_engines if e != primary_engine]

# Remove mock/demo from EXE builds (no real OCR value)
configured_engines = [e for e in configured_engines if e not in ('mock', 'demo')]

print(f"[INFO] Configured OCR engines from .env: {configured_engines}")

# ==============================================================================
# ENGINE-SPECIFIC BUNDLING LOGIC
# Each engine registers its binaries, datas, hidden imports, and excludes
# ==============================================================================
engine_binaries = []
engine_datas = []
engine_hiddenimports = []
engine_excludes = []

# ==============================================================================
# PADDLE/PADDLEOCR DETECTION AND BUNDLING (only if configured)
# ==============================================================================
paddle_binaries = []
paddle_datas = []
paddleocr_pathex = []
paddleocr_models = []
use_paddle_rthook = False

if 'paddle' in configured_engines:
    print("[INFO] PaddleOCR engine configured - bundling Paddle dependencies...")
    try:
        import paddle
        paddle_path = os.path.dirname(paddle.__file__)
        paddle_libs = os.path.join(paddle_path, 'libs')
        
        if os.path.isdir(paddle_libs):
            print(f"[INFO] Found Paddle libs at: {paddle_libs}")
            for dll in glob.glob(os.path.join(paddle_libs, '*.dll')):
                paddle_binaries.append((dll, 'paddle/libs'))
                print(f"[INFO]   Bundling: {os.path.basename(dll)}")
        
        paddle_binaries += collect_dynamic_libs('paddle')
        paddle_datas += collect_data_files('paddle')
        
    except ImportError:
        print("[WARN] Paddle not installed - PaddleOCR engine will not work")

    try:
        import paddleocr
        paddleocr_dir = os.path.dirname(paddleocr.__file__)
        paddleocr_pathex.append(paddleocr_dir)
        print(f"[INFO] PaddleOCR package dir added to pathex: {paddleocr_dir}")
        paddle_datas += collect_data_files('paddleocr')
    except ImportError:
        print("[WARN] PaddleOCR not installed")

    # PaddleOCR models
    paddleocr_cache = os.path.join(os.path.expanduser('~'), '.paddleocr')
    if os.path.exists(paddleocr_cache):
        whl_dir = os.path.join(paddleocr_cache, 'whl')
        if os.path.isdir(whl_dir):
            print(f"[INFO] Found PaddleOCR models at: {paddleocr_cache}")
            paddleocr_models.append((paddleocr_cache, '.paddleocr'))
        else:
            print(f"[WARN] PaddleOCR cache exists but whl/ folder missing at: {whl_dir}")
    else:
        print(f"[WARN] PaddleOCR models not found at: {paddleocr_cache}")

    # Paddle hidden imports
    engine_hiddenimports += [
        'paddleocr',
        'ppocr', 'ppocr.utils', 'ppocr.utils.utility', 'ppocr.utils.logging',
        'ppocr.data', 'ppocr.data.imaug', 'ppocr.postprocess',
        'tools', 'tools.infer', 'tools.infer.utility',
        'tools.infer.predict_det', 'tools.infer.predict_rec',
        'tools.infer.predict_cls', 'tools.infer.predict_system',
        'ppstructure', 'ppstructure.predict_system', 'ppstructure.layout', 'ppstructure.table',
        'paddle', 'paddle.base', 'paddle.base.core', 'paddle.base.framework',
        'paddle.framework', 'paddle.inference', 'paddle.nn',
        'paddle.nn.functional', 'paddle.vision', 'paddle.vision.transforms',
        'paddle.utils', 'paddle.utils.cpp_extension', 'paddle.tensor',
        'paddle.device', 'paddle.static', 'paddle.jit', 'paddle.amp',
        'paddle.optimizer', 'paddle.io', 'paddle.distributed',
        'ocr.engines.paddle_engine',
    ]
    engine_hiddenimports += collect_submodules('ppocr')
    engine_hiddenimports += collect_submodules('ppstructure')
    use_paddle_rthook = True

    engine_binaries += paddle_binaries
    engine_datas += paddle_datas + paddleocr_models
else:
    print("[INFO] PaddleOCR engine NOT configured - skipping Paddle bundling")
    engine_excludes += ['paddleocr', 'paddle', 'ppocr', 'ppstructure',
                        'ocr.engines.paddle_engine']

# ==============================================================================
# TESSERACT OCR DETECTION (only if configured)
# ==============================================================================
tesseract_binaries = []
tesseract_datas = []
tesseract_path = None

if 'tesseract' in configured_engines:
    print("[INFO] Tesseract engine configured - searching for binaries...")
    TESSERACT_SEARCH_PATHS = [
        r'C:\Program Files\Tesseract-OCR',
        r'C:\Program Files (x86)\Tesseract-OCR',
        r'C:\Tesseract-OCR',
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Programs', 'Tesseract-OCR'),
        os.path.join(os.path.expanduser('~'), 'Tesseract-OCR'),
    ]

    for search_path in TESSERACT_SEARCH_PATHS:
        tesseract_exe = os.path.join(search_path, 'tesseract.exe')
        if os.path.exists(tesseract_exe):
            tesseract_path = search_path
            print(f"[INFO] Found Tesseract at: {search_path}")
            break

    if tesseract_path:
        tesseract_binaries = [
            (os.path.join(tesseract_path, 'tesseract.exe'), 'tesseract'),
        ]
        dll_pattern = os.path.join(tesseract_path, '*.dll')
        for dll in glob.glob(dll_pattern):
            tesseract_binaries.append((dll, 'tesseract'))
        
        tessdata_dir = os.path.join(tesseract_path, 'tessdata')
        if os.path.isdir(tessdata_dir):
            eng_traineddata = os.path.join(tessdata_dir, 'eng.traineddata')
            if os.path.exists(eng_traineddata):
                tesseract_datas.append((eng_traineddata, 'tesseract/tessdata'))
                print(f"[INFO] Found eng.traineddata at: {eng_traineddata}")
            else:
                print(f"[WARN] eng.traineddata not found in {tessdata_dir}")
        else:
            print(f"[WARN] tessdata directory not found at: {tessdata_dir}")
    else:
        print("[WARN] Tesseract binary not found - OCR fallback will not work")

    engine_binaries += tesseract_binaries
    engine_datas += tesseract_datas
    engine_hiddenimports += ['pytesseract', 'ocr.engines.tesseract_engine']
else:
    print("[INFO] Tesseract engine NOT configured - skipping Tesseract bundling")
    engine_excludes += ['pytesseract', 'ocr.engines.tesseract_engine']

# ==============================================================================
# EASYOCR DETECTION (only if configured)
# ==============================================================================
if 'easyocr' in configured_engines:
    print("[INFO] EasyOCR engine configured - bundling EasyOCR dependencies...")
    try:
        import easyocr
        engine_hiddenimports += collect_submodules('easyocr')
        engine_hiddenimports += ['ocr.engines.easyocr_engine']
        engine_datas += collect_data_files('easyocr')
        # EasyOCR requires torch
        try:
            engine_hiddenimports += collect_submodules('torch')
            engine_hiddenimports += collect_submodules('torchvision')
            engine_datas += collect_data_files('torch')
        except Exception:
            print("[WARN] PyTorch not found - EasyOCR may not work")
        print("[INFO] EasyOCR bundled successfully")
    except ImportError:
        print("[WARN] EasyOCR not installed - engine will not work")
else:
    print("[INFO] EasyOCR engine NOT configured - skipping EasyOCR bundling")
    engine_excludes += ['easyocr', 'torch', 'torchvision', 'torchaudio',
                        'tensorboard', 'torch.utils.tensorboard',
                        'ocr.engines.easyocr_engine']

# ==============================================================================
# DYNAMIC ENGINE DETECTION (for any other configured engine)
# Attempts to collect submodules/data for arbitrary OCR packages
# ==============================================================================
known_engines = {'paddle', 'tesseract', 'easyocr', 'mock', 'demo'}
dynamic_engines = [e for e in configured_engines if e not in known_engines]

for engine_name in dynamic_engines:
    print(f"[INFO] Dynamic engine '{engine_name}' configured - attempting to bundle...")
    # Check for explicit package name in env
    package_name = env_config.get(f'OCR_{engine_name.upper()}_PACKAGE', engine_name)
    try:
        mod = __import__(package_name)
        engine_hiddenimports += collect_submodules(package_name)
        engine_datas += collect_data_files(package_name)
        engine_hiddenimports += [f'ocr.engines.{engine_name}_engine']
        print(f"[INFO] Dynamic engine '{engine_name}' (package: {package_name}) bundled")
    except ImportError:
        print(f"[WARN] Package '{package_name}' not installed for engine '{engine_name}'")
    except Exception as e:
        print(f"[WARN] Error bundling '{engine_name}': {e}")

# Always include the dynamic engine adapter
engine_hiddenimports.append('ocr.engines.dynamic_engine')

# ==============================================================================
# COLLECT OCR MODULE FILES
# ==============================================================================
ocr_datas = []
spec_dir = os.path.abspath('.')
ocr_dir = os.path.join(spec_dir, 'ocr')

# Determine which engine files to exclude based on configuration
engine_file_excludes = set()
if 'easyocr' not in configured_engines:
    engine_file_excludes.add('easyocr_engine.py')
if 'mock' not in configured_engines:
    engine_file_excludes.add('mock_engine.py')
if 'demo' not in configured_engines:
    engine_file_excludes.add('demo_engine.py')
if 'paddle' not in configured_engines:
    engine_file_excludes.add('paddle_engine.py')
if 'tesseract' not in configured_engines:
    engine_file_excludes.add('tesseract_engine.py')

if os.path.exists(ocr_dir):
    for root, dirs, files in os.walk(ocr_dir):
        for file in files:
            if (
                file.endswith('.py')
                and not file.startswith('.env')
                and file not in engine_file_excludes
            ):
                src = os.path.join(root, file)
                rel_path = os.path.relpath(root, os.path.dirname(ocr_dir))
                ocr_datas.append((src, rel_path))

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
# PaddleOCR data files (only if configured)
if 'paddle' in configured_engines:
    try:
        runtime_datas += collect_data_files('paddleocr')
    except Exception:
        pass

# ==============================================================================
# BUILD SUMMARY
# ==============================================================================
print("")
print("=" * 70)
print("BUILD CONFIGURATION SUMMARY")
print("=" * 70)
print(f"  Configured engines: {', '.join(configured_engines)}")
if 'tesseract' in configured_engines:
    print(f"  Tesseract OCR:     {'FOUND - Will be bundled' if tesseract_path else 'NOT FOUND'}")
if 'paddle' in configured_engines:
    print(f"  PaddleOCR models:  {'FOUND - Will be bundled' if paddleocr_models else 'NOT FOUND'}")
print(f"  OCR Python files:  {len(ocr_datas)} files")
print(f"  Engine imports:    {len(engine_hiddenimports)} hidden imports")
if engine_excludes:
    print(f"  Excluded engines:  {', '.join(set(engine_excludes))}")
print("=" * 70)
print("")

# Determine runtime hooks based on configured engines
runtime_hooks_list = []
if use_paddle_rthook:
    runtime_hooks_list.append('rthook_paddle.py')

a = Analysis(
    ['desktop_app.py'],
    pathex=paddleocr_pathex,
    binaries=engine_binaries,
    datas=[
        *engine_datas,
        *ocr_datas,
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
        # OCR core (always needed)
        'ocr',
        'ocr.facade',
        'ocr.config',
        'ocr.engine_factory',
        'ocr.base_engine',
        'ocr.image_processor',
        'ocr.auto_installer',
        'ocr.runtime_installer',
        'ocr.engines',
        # Legacy OCR modules (backward compatibility)
        'ocr.ocr_engine',
        'ocr.text_extractor',
        # unittest (needed by paddle.utils.cpp_extension if paddle is bundled)
        'unittest',
        'unittest.mock',
        'unittest.util',
        # setuptools internals (needed by some engines at build-time analysis)
        'setuptools',
        'setuptools._distutils',
        'setuptools._distutils.command',
        'setuptools._distutils.command.sdist',
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
    ] + dynamic_hiddenimports + engine_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=runtime_hooks_list,
    excludes=[
        # Exclude unnecessary packages to reduce size
        'matplotlib',
        'pandas',
        'xmlrpc',
        # Security: spacy/NLP not needed
        'detect_secrets',
        'privacy.detectors.secrets_detector',
        'spacy',
        'spacy_legacy',
        'spacy_loggers',
        'thinc',
        'en_core_web_sm',
        'en_core_web_md',
        'en_core_web_lg',
        # Mock/demo engines never needed in EXE
        'ocr.engines.mock_engine',
        'ocr.engines.demo_engine',
        # SECURITY: Exclude .env file to prevent credential leaks
        '.env',
        '.env.local',
        '.env.production',
    ] + engine_excludes,
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
