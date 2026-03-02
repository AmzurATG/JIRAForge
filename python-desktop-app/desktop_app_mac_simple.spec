# -*- mode: python ; coding: utf-8 -*-
"""
Simplified PyInstaller spec file for Mac - focuses on core functionality
"""

import sys

block_cipher = None

a = Analysis(
    ['mac_desktop_app.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # Core dependencies only
        'flask',
        'flask_cors',
        'supabase',
        'PIL',
        'PIL.Image',
        'PIL.ImageGrab', 
        'PIL.ImageDraw',
        'pystray',
        'pynput',
        'AppKit',
        'Quartz',
        'Foundation',
        'UserNotifications',  # For native Mac notifications
        'requests',
        'keyring',
        'psutil',
        'tkinter',
        'sqlite3',
        'json',
        'threading',
        'webbrowser',
        'logging',
        'io',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
        'numpy', 
        'pandas',
        'scipy',
        'test',
        'unittest',
        # Windows modules
        'win32gui',
        'win32process',
        'win32api',
        'winotify',
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
    name='TimeTrackerMac',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='TimeTrackerMac'
)

app = BUNDLE(
    coll,
    name='TimeTracker.app',
    icon=None,
    bundle_identifier='com.jiraforge.timetracker',
    version='1.3.0',
    info_plist={
        'CFBundleName': 'Time Tracker',
        'CFBundleDisplayName': 'JIRAForge Time Tracker',
        'CFBundleShortVersionString': '1.3.0',
        'CFBundleVersion': '1.3.0',
        'NSHighResolutionCapable': True,
        'NSRequiresAquaSystemAppearance': False,
        
        # Essential permissions only
        'NSCameraUsageDescription': 'This app captures screenshots to track work time.',
        'NSScreenCaptureDescription': 'This app captures screenshots to track work time.',
        'NSAccessibilityUsageDescription': 'This app monitors window activity for time tracking.',
        
        'LSUIElement': False,
        'LSMultipleInstancesProhibited': True,
        'LSMinimumSystemVersion': '10.14',
        
        'CFBundleURLTypes': [
            {
                'CFBundleURLName': 'com.jiraforge.timetracker.oauth',
                'CFBundleURLSchemes': ['timetracker']
            }
        ]
    },
)