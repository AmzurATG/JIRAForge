# -*- mode: python ; coding: utf-8 -*-
"""Distribution-optimized PyInstaller spec for TimeTracker macOS"""

import sys
import os
from pathlib import Path

block_cipher = None

# Essential OCR files only (no test/debug files)
ocr_datas = []
ocr_dir = 'ocr'
if os.path.exists(ocr_dir):
    for root, dirs, files in os.walk(ocr_dir):
        for file in files:
            if (file.endswith('.py') and 
                not file.startswith('.') and
                'test' not in file and 
                'debug' not in file and
                'mock' not in file):
                src = os.path.join(root, file)
                rel_path = os.path.relpath(root, '.')
                ocr_datas.append((src, rel_path))

# Find Tesseract (required for reliability)
tesseract_binaries = []
tesseract_locations = [
    '/opt/homebrew/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/usr/bin/tesseract'
]

for tess_path in tesseract_locations:
    if os.path.exists(tess_path):
        tesseract_binaries.append((tess_path, 'tesseract'))
        # Include English language data
        tessdata_dirs = [
            '/opt/homebrew/share/tessdata',
            '/usr/local/share/tessdata'
        ]
        for tessdata_dir in tessdata_dirs:
            eng_data = os.path.join(tessdata_dir, 'eng.traineddata')
            if os.path.exists(eng_data):
                tesseract_binaries.append((eng_data, 'tesseract/tessdata'))
                break
        break

a = Analysis(
    ['mac_desktop_app.py'],
    pathex=[],
    binaries=tesseract_binaries,
    datas=[
        *ocr_datas,
        ('TimeTracker.icns', '.'),  # Include icon in bundle
        ('.env.example', '.'),       # Include env template
    ],
    hiddenimports=[
        # Essential imports only
        'ocr', 'privacy', 'supabase', 'keyring', 'pynput', 'pystray',
        'PIL._tkinter_finder', 'tkinter', 'tkinter.ttk',
        'requests.packages.urllib3.util.retry',
        'certifi', 'charset_normalizer',
        # macOS specific
        'Foundation', 'AppKit', 'objc', 'mac_performance'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary packages to reduce size
        'test', 'tests', 'unittest', 'pytest', 'setuptools',
        'distutils', 'pip', 'wheel', 'pkg_resources',
        'matplotlib', 'scipy', 'pandas', 'jupyter',
        'IPython', 'notebook', 'tornado'
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# Remove duplicate and unnecessary files
a.datas = [x for x in a.datas if not any([
    'test' in x[0].lower(),
    'example' in x[0].lower() and 'env.example' not in x[0],
    '.pyc' in x[0],
    '__pycache__' in x[0]
])]

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TimeTracker',
    debug=False,           # No debug for distribution
    bootloader_ignore_signals=False,
    strip=True,            # Strip debug symbols
    upx=False,             # UPX can cause issues on macOS
    console=False,         # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch='universal2',  # Universal binary
    codesign_identity=None,    # Will be set during signing
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=True,
    upx=False,
    upx_exclude=[],
    name='TimeTracker',
)

app = BUNDLE(
    coll,
    name='TimeTracker.app',
    icon='TimeTracker.icns',
    bundle_identifier='com.amzur.timetracker',
    version='1.2.1',
    info_plist={
        'NSPrincipalClass': 'NSApplication',
        'NSHighResolutionCapable': True,
        'LSApplicationCategoryType': 'public.app-category.productivity',
        'LSUIElement': True,
        'LSMinimumSystemVersion': '11.0',
        'NSHumanReadableCopyright': '© 2024 Amzur Technologies. All rights reserved.',
        
        # Security permissions
        'NSScreenCaptureDescription': 'TimeTracker needs screen access to analyze productivity patterns.',
        'NSSystemAdministrationUsageDescription': 'TimeTracker needs system access to monitor activity.',
        'NSAppleEventsUsageDescription': 'TimeTracker needs to interact with applications for time tracking.',
        
        # Networking
        'NSAppTransportSecurity': {
            'NSAllowsArbitraryLoads': True,  # For API access
            'NSExceptionDomains': {
                'forgesync.amzur.com': {
                    'NSIncludesSubdomains': True,
                    'NSTemporaryExceptionAllowsInsecureHTTPLoads': True
                }
            }
        },
        
        # Auto-start capability
        'LSSharedFileListGlobalLoginItems': True,
        'SMLoginItemSetEnabledKey': True,
        
        # Required for distribution
        'NSRequiresAquaSystemAppearance': False,
        'NSSupportsAutomaticGraphicsSwitching': True,
    }
)
