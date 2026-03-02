# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Time Tracker Desktop App - macOS Version
Generates a macOS .app bundle with all dependencies bundled.
"""

import sys

block_cipher = None

a = Analysis(
    ['mac_desktop_app.py'],  # Your macOS version
    pathex=[],
    binaries=[],
    datas=[],
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
        'PIL.ImageOps',     # For image operations like color conversion
        'PIL.ImageMode',    # For mode constants
        'PIL.ImageColor',   # For color handling
        # System tray
        'pystray',
        'pystray._darwin',  # macOS system tray implementation
        # macOS-specific frameworks (replaces Windows win32 modules)
        'AppKit',           # macOS native GUI framework
        'Quartz',          # For screen capture and window management
        'Foundation',      # macOS Foundation framework
        'Cocoa',           # macOS Cocoa framework
        'CoreGraphics',    # For graphics operations
        'objc',            # Objective-C bridge
        'PyObjC',          # Python-Objective-C bridge
        # Input monitoring
        'pynput',
        'pynput.mouse',
        'pynput.keyboard',
        'pynput._util',
        'pynput._util.darwin',
        'pynput.mouse._darwin',
        'pynput.keyboard._darwin',
        # Cross-platform notifications (replaces winotify)
        'plyer',
        'plyer.platforms',
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
        'cryptography.hazmat',
        'cryptography.hazmat.primitives',
        'cryptography.hazmat.backends',
        'cryptography.hazmat.backends.openssl',
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
        # Standard library modules
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
        'traceback',
        'io',
        # macOS specific system libraries
        'Security',        # macOS Security framework
        'SystemConfiguration', # Network configuration
        'CoreFoundation',  # Core Foundation
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
        'xmlrpc',
        # Windows-specific modules to exclude
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
    name='TimeTrackerMac',
    debug=False,           # Set to True for debugging during development
    bootloader_ignore_signals=False,
    strip=True,           # Strip symbols for smaller size
    upx=False,            # UPX often causes issues on macOS, keep disabled
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,        # GUI app, no console window
    disable_windowed_traceback=False,
    target_arch=None,     # Universal binary support
    codesign_identity=None,  # Add your Apple Developer ID here for signing
    entitlements_file='entitlements.plist',  # Required for macOS permissions
    argv_emulation=False,  # Disable argv emulation for better compatibility
    optimize=2,           # Python bytecode optimization level
)

app = BUNDLE(
    exe,
    name='TimeTracker.app',
    icon=None,  # macOS icon file (you'll need to create this)
    bundle_identifier='com.jiraforge.timetracker',
    version='1.3.0',  # This will be updated by build script
    info_plist={
        'CFBundleName': 'Time Tracker',
        'CFBundleDisplayName': 'JIRAForge Time Tracker',
        'CFBundleShortVersionString': '1.3.0',
        'CFBundleVersion': '1.3.0',
        'NSHighResolutionCapable': True,
        'NSRequiresAquaSystemAppearance': False,
        'NSSupportsAutomaticGraphicsSwitching': True,
        
        # Privacy permissions - required for macOS 10.14+
        'NSScreenCaptureDescription': 'This app captures screenshots to track work time and analyze productivity.',
        'NSSystemAdministrationUsageDescription': 'This app needs admin access to monitor applications and system activity.',
        'NSAppleEventsUsageDescription': 'This app uses AppleEvents to interact with other applications for time tracking.',
        'NSAccessibilityUsageDescription': 'This app needs accessibility access to monitor window titles and application focus.',
        'NSMicrophoneUsageDescription': 'This app may use microphone for advanced productivity analysis (optional).',
        'NSCameraUsageDescription': 'This app may use camera for advanced productivity analysis (optional).',
        
        # App behavior
        'LSUIElement': False,  # Set to True to hide from dock initially
        'LSMultipleInstancesProhibited': True,  # Prevent multiple instances
        'LSMinimumSystemVersion': '10.14',  # Minimum macOS version (Mojave)
        
        # File associations (optional)
        'CFBundleDocumentTypes': [
            {
                'CFBundleTypeName': 'Time Tracker Data',
                'CFBundleTypeExtensions': ['ttd'],
                'CFBundleTypeRole': 'Editor'
            }
        ],
        
        # URL scheme for OAuth callbacks
        'CFBundleURLTypes': [
            {
                'CFBundleURLName': 'com.jiraforge.timetracker.oauth',
                'CFBundleURLSchemes': ['timetracker']
            }
        ]
    },
)