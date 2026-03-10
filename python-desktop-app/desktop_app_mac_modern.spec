# -*- mode: python ; coding: utf-8 -*-
"""
Modern PyInstaller spec for JIRAForge TimeTracker - macOS 26.3 Tahoe
Optimized for Python 3.12+ with enhanced security and modern frameworks

Key improvements:
- Support for ScreenCaptureKit (macOS 12.3+)
- Modern PyObjC 11.x framework bindings
- Enhanced security model for macOS 26.3
- Optimized bundle size and startup time
- Proper handling of modern Python dependencies
"""

import sys
import os
from pathlib import Path

block_cipher = None

# ============================================================================
# MODERN HIDDEN IMPORTS FOR macOS 26.3
# ============================================================================

# Core application modules
core_imports = [
    'json', 'base64', 'hashlib', 'secrets', 'urllib.parse',
    'tempfile', 'threading', 'webbrowser', 'socket', 'sqlite3',
]

# Flask web framework and dependencies
flask_imports = [
    'flask', 'flask_cors', 'jinja2', 'markupsafe', 'werkzeug',
    'itsdangerous', 'click', 'blinker',
    # Flask templates and rendering
    'flask.json', 'flask.templating', 'flask.sessions',
]

# Modern Supabase client stack
supabase_imports = [
    'supabase', 'postgrest', 'gotrue', 'realtime', 'storage3', 'supafunc',
    # Modern HTTP clients
    'httpx', 'httpcore', 'h11', 'h2', 'hpack', 'hyperframe',
    'anyio', 'sniffio', 'certifi',
    # HTTP transport layers
    'httpx._transports', 'httpx._transports.default',
    'httpx._transports.asgi', 'httpx._auth',
]

# Enhanced image processing with modern codecs
image_imports = [
    'PIL', 'PIL.Image', 'PIL.ImageGrab', 'PIL.ImageDraw',
    'PIL.ImageOps', 'PIL.ImageMode', 'PIL.ImageColor',
    'PIL.ImageFont', 'PIL.ImageFilter', 'PIL.ImageEnhance',
    # Modern image formats
    'PIL.WebPImagePlugin', 'PIL.AvifImagePlugin',
]

# Modern macOS frameworks (PyObjC 11.x series)
macos_frameworks = [
    # Core frameworks
    'AppKit', 'Foundation', 'Cocoa', 'CoreGraphics',
    'objc', 'PyObjC',
    
    # Screen capture and window management
    'Quartz', 'CoreImage', 'ImageIO',
    
    # NEW: Modern screen capture for macOS 12.3+
    'ScreenCaptureKit',
    
    # NEW: Enhanced notification system
    'UserNotifications',
    
    # Enhanced accessibility and automation
    'ApplicationServices', 'CoreServices',
    
    # Security and keychain
    'Security', 'LocalAuthentication',
    
    # System monitoring
    'SystemConfiguration', 'IOKit',
]

# Enhanced system tray with modern integration
tray_imports = [
    'pystray', 'pystray._darwin',
    'pystray.icon', 'pystray.menu',
]

# Modern input monitoring with enhanced permissions
input_imports = [
    'pynput', 'pynput.mouse', 'pynput.keyboard',
    'pynput._util', 'pynput._util.darwin',
    'pynput.mouse._darwin', 'pynput.keyboard._darwin',
    # Modern input event handling
    'pynput._util.darwin_vks',
]

# Enhanced cross-platform notifications
notification_imports = [
    'plyer', 'plyer.platforms', 'plyer.platforms.macosx',
    'plyer.platforms.macosx.notification',
]

# Modern secure storage with macOS Keychain integration
security_imports = [
    'keyring', 'keyring.backends', 'keyring.backends.macOS',
    'keyring.backends.OS_X', 'keyring.core',
    'cryptography', 'cryptography.fernet',
    'cryptography.hazmat', 'cryptography.hazmat.primitives',
]

# Enhanced timezone and datetime support
time_imports = [
    'tzlocal', 'zoneinfo', 'dateutil', 'dateutil.tz',
    'dateutil.parser', 'dateutil.relativedelta',
]

# Modern system monitoring with enhanced capabilities
system_imports = [
    'psutil', 'psutil._psmacos', 'psutil._common',
    'platform', 'subprocess',
]

# Enhanced JSON processing
json_imports = [
    'orjson',  # Fast JSON processing
    'json', 'simplejson',  # Fallbacks
]

# Modern logging with structured output
logging_imports = [
    'structlog', 'structlog.processors',
    'logging', 'logging.handlers',
]

# Development and debugging (commented out for production)
debug_imports = [
    # 'pytest', 'pytest_asyncio',
    # 'black', 'mypy',
    # 'bandit',
]

# Additional compatibility layer
compatibility_imports = [
    'macos_compatibility',  # Our custom compatibility module
]

# Combine all imports
all_hidden_imports = (
    core_imports + flask_imports + supabase_imports + image_imports +
    macos_frameworks + tray_imports + input_imports + notification_imports +
    security_imports + time_imports + system_imports + json_imports +
    logging_imports + compatibility_imports
)

# ============================================================================
# DATA FILES AND RESOURCES
# ============================================================================

data_files = [
    # Include modern entitlements
    ('entitlements-modern.plist', '.'),
    
    # Include compatibility module
    ('macos_compatibility.py', '.'),
    
    # Include any icon files if they exist
    # ('assets/icon.icns', 'assets'),
]

# ============================================================================
# EXCLUSIONS FOR OPTIMIZED BUNDLE SIZE
# ============================================================================

excluded_modules = [
    # Windows-specific modules
    'win32gui', 'win32process', 'win32con', 'win32event', 'win32api',
    'winerror', 'winreg', 'msvcrt',
    
    # Linux-specific modules  
    'fcntl', 'termios',
    
    # Unnecessary GUI frameworks
    'tkinter', 'tkinter.*', 'turtle',
    'wx', 'wx.*', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
    
    # Development and testing modules
    'pytest', 'test', 'tests', 'unittest.mock',
    'doctest', 'pdb', 'pydoc',
    'black', 'flake8', 'mypy', 'pylint',
    
    # Jupyter and notebook modules
    'jupyter', 'notebook', 'ipython', 'ipykernel',
    
    # Unused web frameworks
    'django', 'tornado', 'fastapi',
    
    # Large data science libraries (if not needed)
    'numpy', 'pandas', 'matplotlib', 'scipy',
    
    # Documentation modules
    'sphinx', 'docutils',
]

# ============================================================================
# PYINSTALLER ANALYSIS
# ============================================================================

a = Analysis(
    ['mac_desktop_app.py'],
    pathex=[str(Path.cwd())],
    binaries=[],
    datas=data_files,
    hiddenimports=all_hidden_imports,
    hookspath=[],
    hooksconfig={
        # Configure hooks for better compatibility
        'gi': {
            'icons': ['Adwaita'],
            'themes': ['Adwaita'],
            'languages': ['en'],
        },
    },
    runtime_hooks=[],
    excludes=excluded_modules,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
    optimize=2,  # Enable Python optimizations
)

# ============================================================================
# PYTHON BYTECODE ARCHIVE
# ============================================================================

pyz = PYZ(
    a.pure, 
    a.zipped_data,
    cipher=block_cipher
)

# ============================================================================
# EXECUTABLE CREATION
# ============================================================================

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TimeTrackerMac',
    debug=False,  # Disable debug for production
    bootloader_ignore_signals=False,
    strip=False,  # Keep symbols for debugging
    upx=True,  # Enable UPX compression
    console=False,  # Windowed application
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,  # Will be set during build
    entitlements_file=None,  # Will be set during build
    icon=None,  # Add icon path if available
)

# ============================================================================
# COLLECT DEPENDENCIES
# ============================================================================

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[
        # Exclude certain files from UPX compression
        'libcrypto*',
        'libssl*',
        'libbssl*',
    ],
    name='TimeTrackerMac',
)

# ============================================================================
# macOS APP BUNDLE CREATION
# ============================================================================

app = BUNDLE(
    coll,
    name='TimeTracker.app',
    icon=None,  # Set to icon path if available
    bundle_identifier='com.jiraforge.timetracker',
    version='2.0.0',
    info_plist={
        # ================================================================
        # BASIC APP INFORMATION
        # ================================================================
        'CFBundleName': 'JIRAForge TimeTracker',
        'CFBundleDisplayName': 'TimeTracker',
        'CFBundleIdentifier': 'com.jiraforge.timetracker',
        'CFBundleVersion': '2.0.0',
        'CFBundleShortVersionString': '2.0.0',
        'CFBundleGetInfoString': 'JIRAForge TimeTracker 2.0.0',
        'CFBundleExecutable': 'TimeTrackerMac',
        'CFBundleIconFile': 'icon.icns',  # If icon exists
        
        # ================================================================
        # macOS COMPATIBILITY AND APPEARANCE
        # ================================================================
        'NSHighResolutionCapable': True,
        'NSSupportsAutomaticGraphicsSwitching': True,
        'LSUIElement': True,  # Background application (no dock icon)
        'LSMinimumSystemVersion': '14.0',  # Minimum macOS version
        'LSApplicationCategoryType': 'public.app-category.productivity',
        
        # ================================================================
        # MODERN macOS 26.3 PRIVACY DECLARATIONS
        # ================================================================
        
        # Screen capture usage description
        'NSScreenCaptureUsageDescription': (
            'TimeTracker captures screenshots to verify your work activities '
            'and generate accurate time tracking reports. Screenshots are '
            'processed locally and only metadata is stored.'
        ),
        
        # Camera access (if needed for enhanced features)
        'NSCameraUsageDescription': (
            'TimeTracker may access the camera for enhanced activity '
            'verification features. This is optional and can be disabled.'
        ),
        
        # Automation and Apple Events
        'NSAppleEventsUsageDescription': (
            'TimeTracker needs automation access to monitor active applications '
            'and windows for accurate time tracking.'
        ),
        
        # Accessibility access
        'NSAccessibilityUsageDescription': (
            'TimeTracker needs accessibility access to monitor window focus '
            'and application switching for time tracking.'
        ),
        
        # ================================================================
        # MACOS 26.3 PRIVACY API DECLARATIONS
        # Required for App Store and notarization
        # ================================================================
        'NSPrivacyAccessedAPITypes': [
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategorySystemBootTime',
                'NSPrivacyAccessedAPITypeReasons': ['85F4.1'],  # App functionality
            },
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryFileTimestamp',
                'NSPrivacyAccessedAPITypeReasons': ['C617.1'],  # App functionality
            },
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryUserDefaults',
                'NSPrivacyAccessedAPITypeReasons': ['CA92.1'],  # App configuration
            },
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryDiskSpace',
                'NSPrivacyAccessedAPITypeReasons': ['E174.1'],  # App functionality
            },
        ],
        
        # ================================================================
        # ENHANCED SECURITY FOR macOS 26.3
        # ================================================================
        'NSAppTransportSecurity': {
            'NSAllowsArbitraryLoads': False,  # Enforce HTTPS
            'NSAllowsArbitraryLoadsForMedia': False,
            'NSAllowsLocalNetworking': True,  # Allow localhost connections
            'NSExceptionDomains': {
                # Allow specific domains if needed
                'supabase.co': {
                    'NSIncludesSubdomains': True,
                    'NSTemporaryExceptionAllowsInsecureHTTPLoads': False,
                },
                'atlassian.net': {
                    'NSIncludesSubdomains': True,
                    'NSTemporaryExceptionAllowsInsecureHTTPLoads': False,
                },
            },
        },
        
        # ================================================================
        # MODERN PLATFORM SUPPORT
        # ================================================================
        'LSMinimumSystemVersion': '14.0',
        'LSRequiresNativeExecution': True,
        'NSSupportsAutomaticTermination': True,
        'NSSupportsSuddenTermination': False,  # Save state on quit
        
        # ================================================================
        # URL SCHEMES (if needed)
        # ================================================================
        'CFBundleURLTypes': [
            {
                'CFBundleURLName': 'JIRAForge OAuth',
                'CFBundleURLSchemes': ['jiraforge', 'timetracker'],
            },
        ],
        
        # ================================================================
        # DOCUMENT TYPES (if applicable)
        # ================================================================
        'CFBundleDocumentTypes': [
            {
                'CFBundleTypeName': 'TimeTracker Data',
                'CFBundleTypeExtensions': ['ttdata'],
                'CFBundleTypeRole': 'Editor',
                'LSHandlerRank': 'Owner',
            },
        ],
    },
)