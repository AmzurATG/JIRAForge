"""
macOS Compatibility Layer for TimeTracker
Handles macOS-specific functionality and version compatibility
Compatible with macOS Big Sur 11.0+ and optimized for macOS Tahoe 26.3+
"""
import sys
import os
import platform
import subprocess
import threading
import ctypes
import ctypes.util
from pathlib import Path
from datetime import datetime

# macOS Framework imports
try:
    import Cocoa
    import Foundation
    import AppKit
    import Quartz
    from Cocoa import (
        NSWorkspace, NSScreen, NSApp, NSApplicationActivationPolicyAccessory,
        NSUserNotification, NSUserNotificationCenter
    )
    from Quartz import (
        CGWindowListCopyWindowInfo, CGDisplayCreateImage, CGMainDisplayID,
        CGImageSourceCreateWithData, CGImageSourceCreateImageAtIndex,
        kCGWindowListOptionOnScreenOnly, kCGNullWindowID
    )
    MACOS_FRAMEWORKS_AVAILABLE = True
except ImportError as e:
    print(f"[WARN] macOS frameworks not available: {e}")
    MACOS_FRAMEWORKS_AVAILABLE = False

# Screen Capture imports
try:
    import Quartz.CoreGraphics as CG
    SCREEN_CAPTURE_AVAILABLE = True
except ImportError:
    SCREEN_CAPTURE_AVAILABLE = False
    print("[WARN] Screen capture functionality limited")

# Global compatibility state
_compatibility_initialized = False
_system_info = {}
_permissions_checked = {}

def init_compatibility_layer():
    """Initialize macOS compatibility layer"""
    global _compatibility_initialized, _system_info
    
    if _compatibility_initialized:
        return True
        
    try:
        # Get system information
        _system_info = {
            'macos_version': platform.mac_ver()[0],
            'macos_build': subprocess.run(['sw_vers', '-buildVersion'], 
                                        capture_output=True, text=True).stdout.strip(),
            'python_version': sys.version_info,
            'architecture': platform.machine(),
            'processor': platform.processor(),
            'is_apple_silicon': platform.machine() == 'arm64',
            'is_intel': platform.machine() == 'x86_64',
            'frameworks_available': MACOS_FRAMEWORKS_AVAILABLE,
            'screen_capture_available': SCREEN_CAPTURE_AVAILABLE,
        }
        
        # Check macOS version compatibility
        macos_major = int(_system_info['macos_version'].split('.')[0])
        macos_minor = int(_system_info['macos_version'].split('.')[1]) if '.' in _system_info['macos_version'] else 0
        
        if macos_major < 11:
            print(f"[WARN] macOS {_system_info['macos_version']} may have limited compatibility")
            print("[WARN] macOS 11.0 (Big Sur) or later recommended")
        elif macos_major >= 26:  # macOS Tahoe and later
            print(f"[INFO] macOS {_system_info['macos_version']} (Tahoe+) - full compatibility")
        else:
            print(f"[INFO] macOS {_system_info['macos_version']} - good compatibility")
            
        # Set application properties for macOS
        if MACOS_FRAMEWORKS_AVAILABLE:
            try:
                # Configure app to run in background
                NSApp = AppKit.NSApplication.sharedApplication()
                NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
                print("[INFO] Configured as menu bar application")
            except Exception as e:
                print(f"[WARN] Failed to configure app properties: {e}")
                
        _compatibility_initialized = True
        print(f"[INFO] macOS compatibility layer initialized successfully")
        return True
        
    except Exception as e:
        print(f"[ERROR] Failed to initialize compatibility layer: {e}")
        return False

def get_compatibility():
    """Get comprehensive compatibility information"""
    if not _compatibility_initialized:
        init_compatibility_layer()
        
    return _system_info.copy()

def get_macos_version():
    """Get macOS version as tuple (major, minor, patch)"""
    version_str = _system_info.get('macos_version', '0.0.0')
    parts = version_str.split('.')
    
    try:
        major = int(parts[0]) if len(parts) > 0 else 0
        minor = int(parts[1]) if len(parts) > 1 else 0  
        patch = int(parts[2]) if len(parts) > 2 else 0
        return (major, minor, patch)
    except ValueError:
        return (0, 0, 0)

def is_macos_tahoe_or_later():
    """Check if running on macOS Tahoe (26.3) or later"""
    major, minor, patch = get_macos_version()
    return major > 26 or (major == 26 and minor >= 3)

def get_screen_capture():
    """Get enhanced screen capture capabilities"""
    if not _compatibility_initialized:
        init_compatibility_layer()
        
    capabilities = {
        'available': SCREEN_CAPTURE_AVAILABLE and MACOS_FRAMEWORKS_AVAILABLE,
        'permission_required': True,
        'permission_granted': False,
        'capture_methods': []
    }
    
    if SCREEN_CAPTURE_AVAILABLE:
        capabilities['capture_methods'].extend([
            'CGDisplayCreateImage',
            'PIL.ImageGrab',
            'screencapture_cli'
        ])
        
        # Check screen recording permission
        capabilities['permission_granted'] = check_screen_recording_permission()
        
    return capabilities

def check_screen_recording_permission():
    """Check if screen recording permission is granted"""
    global _permissions_checked
    
    permission_key = 'screen_recording'
    if permission_key in _permissions_checked:
        return _permissions_checked[permission_key]
        
    try:
        if not MACOS_FRAMEWORKS_AVAILABLE:
            # Fallback: try to take a test screenshot
            try:
                import PIL.ImageGrab
                test_img = PIL.ImageGrab.grab(bbox=(0, 0, 100, 100))
                granted = test_img is not None and test_img.size == (100, 100)
            except Exception:
                granted = False
        else:
            # Use CGDisplayCreateImage to test permission
            try:
                display_id = CGMainDisplayID()
                image = CGDisplayCreateImage(display_id)
                granted = image is not None
                if image:
                    Quartz.CGImageRelease(image)
            except Exception as e:
                print(f"[DEBUG] Screen capture test failed: {e}")
                granted = False
                
        _permissions_checked[permission_key] = granted
        
        if not granted:
            print("[WARN] Screen recording permission not granted")
            print("[INFO] Go to System Preferences > Security & Privacy > Privacy > Screen Recording")
            print("[INFO] Add TimeTracker to allowed applications")
            
        return granted
        
    except Exception as e:
        print(f"[ERROR] Failed to check screen recording permission: {e}")
        return False

def request_screen_recording_permission():
    """Request screen recording permission from user"""
    try:
        if not MACOS_FRAMEWORKS_AVAILABLE:
            print("[INFO] Please grant screen recording permission in System Preferences")
            return False
            
        # Try to trigger permission dialog by taking a screenshot
        display_id = CGMainDisplayID()
        image = CGDisplayCreateImage(display_id)
        
        if image:
            Quartz.CGImageRelease(image)
            _permissions_checked['screen_recording'] = True
            return True
        else:
            # Show system preferences
            subprocess.run([
                'open', 
                'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
            ])
            return False
            
    except Exception as e:
        print(f"[ERROR] Failed to request permission: {e}")
        return False

def get_notifications():
    """Get notification capabilities"""
    if not _compatibility_initialized:
        init_compatibility_layer()
        
    capabilities = {
        'available': MACOS_FRAMEWORKS_AVAILABLE,
        'user_notifications': MACOS_FRAMEWORKS_AVAILABLE,
        'notification_center': MACOS_FRAMEWORKS_AVAILABLE,
        'methods': []
    }
    
    if MACOS_FRAMEWORKS_AVAILABLE:
        capabilities['methods'].extend([
            'NSUserNotification',
            'UNUserNotificationCenter'  # For macOS 10.14+
        ])
    else:
        # Fallback methods
        capabilities['methods'].extend([
            'osascript',
            'terminal_bell'
        ])
        
    return capabilities

def show_notification(title, message, subtitle=None):
    """Show a native macOS notification"""
    try:
        if MACOS_FRAMEWORKS_AVAILABLE:
            # Use NSUserNotification
            notification = Cocoa.NSUserNotification.alloc().init()
            notification.setTitle_(title)
            notification.setInformativeText_(message)
            
            if subtitle:
                notification.setSubtitle_(subtitle)
                
            notification.setSoundName_("NSUserNotificationDefaultSoundName")
            
            center = NSUserNotificationCenter.defaultUserNotificationCenter()
            center.deliverNotification_(notification)
            
            return True
        else:
            # Fallback: use osascript
            script = f'display notification "{message}" with title "{title}"'
            subprocess.run(['osascript', '-e', script])
            return True
            
    except Exception as e:
        print(f"[ERROR] Failed to show notification: {e}")
        return False

def get_dependency_manager():
    """Get information about available dependency managers"""
    managers = {
        'available': [],
        'preferred': None
    }
    
    # Check for Homebrew
    if subprocess.run(['which', 'brew'], capture_output=True).returncode == 0:
        managers['available'].append('homebrew')
        if not managers['preferred']:
            managers['preferred'] = 'homebrew'
            
    # Check for MacPorts
    if subprocess.run(['which', 'port'], capture_output=True).returncode == 0:
        managers['available'].append('macports')
        if not managers['preferred']:
            managers['preferred'] = 'macports'
            
    # Check for pip
    if subprocess.run(['which', 'pip3'], capture_output=True).returncode == 0:
        managers['available'].append('pip')
        
    return managers

def install_dependency(package_name, manager=None):
    """Install a system dependency using available package manager"""
    managers = get_dependency_manager()
    manager = manager or managers['preferred']
    
    if not manager:
        print(f"[ERROR] No package manager available to install {package_name}")
        return False
        
    try:
        if manager == 'homebrew':
            result = subprocess.run(['brew', 'install', package_name], 
                                  capture_output=True, text=True)
        elif manager == 'macports':
            result = subprocess.run(['sudo', 'port', 'install', package_name], 
                                  capture_output=True, text=True)
        else:
            print(f"[ERROR] Unsupported package manager: {manager}")
            return False
            
        if result.returncode == 0:
            print(f"[INFO] Successfully installed {package_name} via {manager}")
            return True
        else:
            print(f"[ERROR] Failed to install {package_name}: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"[ERROR] Installation failed: {e}")
        return False

def get_active_application():
    """Get information about the currently active application"""
    try:
        if not MACOS_FRAMEWORKS_AVAILABLE:
            return None
            
        workspace = NSWorkspace.sharedWorkspace()
        active_app = workspace.activeApplication()
        
        if active_app:
            return {
                'name': active_app.get('NSApplicationName', 'Unknown'),
                'bundle_id': active_app.get('NSApplicationBundleIdentifier', ''),
                'pid': active_app.get('NSApplicationProcessIdentifier', 0),
                'path': active_app.get('NSApplicationPath', ''),
            }
        return None
        
    except Exception as e:
        print(f"[ERROR] Failed to get active application: {e}")
        return None

def get_window_list():
    """Get list of visible windows"""
    try:
        if not MACOS_FRAMEWORKS_AVAILABLE:
            return []
            
        options = kCGWindowListOptionOnScreenOnly
        window_list = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        
        windows = []
        for window_info in window_list:
            window = {
                'title': window_info.get('kCGWindowName', ''),
                'owner': window_info.get('kCGWindowOwnerName', ''),
                'pid': window_info.get('kCGWindowOwnerPID', 0),
                'bounds': window_info.get('kCGWindowBounds', {}),
                'layer': window_info.get('kCGWindowLayer', 0),
            }
            
            if window['title'] or window['owner']:
                windows.append(window)
                
        return windows
        
    except Exception as e:
        print(f"[ERROR] Failed to get window list: {e}")
        return []

def set_process_priority_background():
    """Set the current process to background priority (macOS equivalent of Windows BACKGROUND_MODE)"""
    try:
        # Use os.setpriority to lower process priority
        os.setpriority(os.PRIO_PROCESS, 0, 10)  # Nice value of 10 (lower priority)
        
        # Try to set Quality of Service to background (requires threading module)
        if hasattr(threading, 'pthread_set_qos_class_self_np'):
            # QoS class for background tasks
            QOS_CLASS_BACKGROUND = 9
            threading.pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0)
            
        print("[INFO] Process priority set to background")
        return True
        
    except Exception as e:
        print(f"[WARN] Failed to set background priority: {e}")
        return False

def create_compatibility_report():
    """Create a comprehensive compatibility report"""
    if not _compatibility_initialized:
        init_compatibility_layer()
        
    report = {
        'timestamp': datetime.now().isoformat(),
        'system_info': _system_info.copy(),
        'permissions': _permissions_checked.copy(),
        'capabilities': {
            'screen_capture': get_screen_capture(),
            'notifications': get_notifications(),
            'dependency_manager': get_dependency_manager(),
        },
        'recommendations': []
    }
    
    # Add recommendations based on findings
    if not report['capabilities']['screen_capture']['permission_granted']:
        report['recommendations'].append(
            "Grant screen recording permission in System Preferences > Security & Privacy"
        )
        
    if not report['capabilities']['dependency_manager']['available']:
        report['recommendations'].append(
            "Install Homebrew for better dependency management: /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        )
        
    major, _, _ = get_macos_version()
    if major < 11:
        report['recommendations'].append(
            "Consider upgrading to macOS Big Sur 11.0 or later for best compatibility"
        )
        
    return report

# Convenience functions for common tasks
def is_compatible():
    """Check if the system is compatible with TimeTracker"""
    major, _, _ = get_macos_version()
    return major >= 11

def get_app_data_directory():
    """Get the appropriate directory for app data storage"""
    home = Path.home()
    app_support = home / "Library" / "Application Support" / "TimeTracker"
    app_support.mkdir(parents=True, exist_ok=True)
    return str(app_support)

def get_launch_agent_path():
    """Get the path for the Launch Agent plist"""
    home = Path.home()
    launch_agents = home / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True, exist_ok=True)
    return str(launch_agents / "com.amzur.timetracker.plist")

# Initialize on import
init_compatibility_layer()