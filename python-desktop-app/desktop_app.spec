# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Time Tracker Desktop App
Generates a single-file Windows executable with all dependencies bundled.

OCR engines are now DYNAMICALLY detected from .env configuration:
- Reads OCR_PRIMARY_ENGINE and OCR_FALLBACK_ENGINES from .env
- Only bundles engines that are configured and installed
- Automatically discovers hidden imports for each engine

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

engine_excludes += ['paddleocr', 'paddle', 'ppocr', 'ppstructure',
                    'ocr.engines.paddle_engine',
                    'pytesseract', 'ocr.engines.tesseract_engine']

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
                        'onnxruntime.transformers',
                        'ocr.engines.easyocr_engine']

# ==============================================================================
# WINRTOCR DETECTION (only if configured) — Windows-only OCR via WinRT
# ==============================================================================
if 'winrtocr' in configured_engines or 'winrt' in configured_engines:
    print("[INFO] WinRTocr engine configured - bundling WinRT dependencies...")
    # Our native winrtocr_engine.py uses winsdk directly — always try to bundle it
    try:
        import winsdk
        engine_hiddenimports += collect_submodules('winsdk')
        engine_datas += collect_data_files('winsdk')
        engine_binaries += collect_dynamic_libs('winsdk')
        print("[INFO] winsdk submodules collected for native WinRT engine")
    except ImportError:
        print("[WARN] winsdk not installed — native WinRT engine will not work in EXE")
        # Manually list the critical winsdk submodules
        engine_hiddenimports += [
            'winsdk',
            'winsdk._winrt',
            'winsdk.windows.media.ocr',
            'winsdk.windows.globalization',
            'winsdk.windows.graphics.imaging',
            'winsdk.windows.storage.streams',
            'winsdk.windows.foundation',
        ]
    except Exception as e:
        print(f"[WARN] Could not collect winsdk submodules: {e}")
    # Also bundle the winrtocr library and its deps (for kthread_sleep used by native engine)
    try:
        import winrtocr
        engine_hiddenimports += collect_submodules('winrtocr')
        engine_datas += collect_data_files('winrtocr')
        # winrtocr/winsdk shared dependencies
        for dep_pkg in ['kthread_sleep', 'flatten_everything',
                        'a_cv_imwrite_imread_plus', 'pathos', 'callpyfile',
                        'kthread', 'PrettyColorPrinter', 'tolerant_isinstance',
                        'touchtouch', 'cprinter', 'isiter', 'dill',
                        'multiprocess', 'pox', 'ppft']:
            try:
                engine_hiddenimports += collect_submodules(dep_pkg)
            except Exception:
                engine_hiddenimports.append(dep_pkg)
        print("[INFO] winrtocr library bundled")
    except ImportError:
        print("[INFO] winrtocr library not installed (native winsdk engine will be used)")
    # winrtocr get_ocr_df() needs pandas; native engine does not
    try:
        engine_hiddenimports += collect_submodules('pandas')
        engine_datas += collect_data_files('pandas')
    except Exception:
        pass
    # Always include the native engine module
    engine_hiddenimports.append('ocr.engines.winrtocr_engine')
    print("[INFO] WinRTocr bundled successfully")
else:
    print("[INFO] WinRTocr engine NOT configured - skipping WinRT bundling")
    engine_excludes += ['winrtocr']

# ==============================================================================
# DYNAMIC ENGINE DETECTION (for any other configured engine)
# Attempts to collect submodules/data for arbitrary OCR packages
# ==============================================================================
known_engines = {'easyocr', 'winrtocr', 'winrt', 'mock', 'demo'}
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

# ==============================================================================
# NUMPY BINARY DEPENDENCIES (critical for C-extensions)
# ==============================================================================
# NumPy's C-extensions need proper DLL bundling to work on target systems
print("[INFO] Collecting NumPy binary dependencies...")
try:
    numpy_binaries = collect_dynamic_libs('numpy')
    if numpy_binaries:
        engine_binaries += numpy_binaries
        print(f"[INFO] Collected {len(numpy_binaries)} NumPy binary dependencies")
    else:
        print("[INFO] No dynamic NumPy binaries returned by hook; using explicit numpy.libs scan")
except Exception as e:
    print(f"[WARN] Could not collect NumPy binaries: {e}")

# Also explicitly ensure NumPy libs are bundled
try:
    import numpy as np
    # On Windows wheels, NumPy DLLs live in sibling folder: site-packages/numpy.libs
    numpy_libs_path = os.path.abspath(
        os.path.join(os.path.dirname(np.__file__), '..', 'numpy.libs')
    )
    if os.path.exists(numpy_libs_path):
        numpy_dll_files = glob.glob(os.path.join(numpy_libs_path, '*.dll'))
        if numpy_dll_files:
            for dll in numpy_dll_files:
                engine_binaries.append((dll, 'numpy.libs'))
            print(f"[INFO] Explicitly added {len(numpy_dll_files)} NumPy DLLs from numpy.libs")
        else:
            print("[WARN] numpy.libs exists but no DLLs were found")
    else:
        print(f"[WARN] NumPy libs directory not found: {numpy_libs_path}")
except Exception as e:
    print(f"[WARN] Could not explicitly bundle NumPy .libs DLLs: {e}")

# Include VC runtime DLLs from the Python installation as a defensive fallback.
try:
    python_dir = os.path.dirname(sys.executable)
    vc_runtime_dlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']
    added_runtime = 0
    for dll_name in vc_runtime_dlls:
        dll_path = os.path.join(python_dir, dll_name)
        if os.path.exists(dll_path):
            engine_binaries.append((dll_path, '.'))
            added_runtime += 1
    if added_runtime:
        print(f"[INFO] Added {added_runtime} VC runtime DLL(s) from Python installation")
except Exception as e:
    print(f"[WARN] Could not add VC runtime DLL fallback: {e}")

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
try:
    dynamic_hiddenimports += collect_submodules('presidio_analyzer')
    dynamic_hiddenimports += collect_submodules('presidio_anonymizer')
except Exception:
    print("[WARN] Could not collect presidio submodules")
dynamic_hiddenimports += collect_submodules('supabase')
dynamic_hiddenimports += collect_submodules('keyring')
dynamic_hiddenimports += collect_submodules('pynput')
dynamic_hiddenimports += collect_submodules('pystray')
# NumPy submodules - critical for C-extension imports
try:
    dynamic_hiddenimports += collect_submodules('numpy')
    print("[INFO] NumPy submodules collected")
except Exception as e:
    print(f"[WARN] Could not collect NumPy submodules: {e}")
# Collect pkg_resources dependencies (platformdirs required at runtime)
try:
    dynamic_hiddenimports += collect_submodules('platformdirs')
except Exception:
    print("[WARN] Could not collect platformdirs submodules")

# Runtime data files needed by some dependencies
runtime_datas = []
runtime_datas += collect_data_files('certifi')
runtime_datas += collect_data_files('tzdata')
# NumPy data files and binary dependencies - critical for C-extension imports
try:
    runtime_datas += collect_data_files('numpy')
    print("[INFO] NumPy data files collected")
except Exception as e:
    print(f"[WARN] Could not collect NumPy data files: {e}")
try:
    runtime_datas += collect_data_files('presidio_analyzer')
    runtime_datas += collect_data_files('presidio_anonymizer')
except Exception:
    print("[WARN] Could not collect presidio data files")
try:
    runtime_datas += collect_data_files('platformdirs')
except Exception:
    print("[WARN] Could not collect platformdirs data files")
# ==============================================================================
# BUILD SUMMARY
# ==============================================================================
print("")
print("=" * 70)
print("BUILD CONFIGURATION SUMMARY")
print("=" * 70)
print(f"  Configured engines: {', '.join(configured_engines)}")
print(f"  OCR Python files:  {len(ocr_datas)} files")
print(f"  Engine imports:    {len(engine_hiddenimports)} hidden imports")
if engine_excludes:
    print(f"  Excluded engines:  {', '.join(set(engine_excludes))}")
print("=" * 70)
print("")

runtime_hooks_list = []

a = Analysis(
    ['desktop_app.py'],
    pathex=[os.path.abspath('.')],
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
        # Privacy / PII detection
        'presidio_analyzer',
        'presidio_anonymizer',
        # Process management
        'psutil',
        # Tkinter (for pause popup)
        'tkinter',
        'tkinter.ttk',
        # SQLite / SQLCipher (encrypted SQLite)
        'sqlite3',
        'sqlcipher3',
        'sqlcipher3.dbapi2',
        # Database connection manager
        'db_connection',
        # jaraco (required by pkg_resources)
        'jaraco',
        'jaraco.text',
        'jaraco.functools',
        'jaraco.context',
        # platformdirs (required by pkg_resources via setuptools)
        'platformdirs',
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
        # unittest (needed by some engine build-time analysis)
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
        ] + (['pandas'] if ('winrtocr' not in configured_engines and 'winrt' not in configured_engines) else []) + [
        # Exclude pandas test modules (dramatically speeds up build)
        'pandas.tests',
        'pandas.tests.test_algos',
        'pandas.tests.frame',
        'pandas.tests.indexes',
        'pandas.tests.groupby',
        'pandas.tests.series',
        'pandas.tests.plotting',
        'pandas.tests.io',
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
