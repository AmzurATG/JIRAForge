"""
macOS Compatibility Layer for JIRAForge TimeTracker
Handles missing dependencies and provides fallback functionality for macOS 26.3 Tahoe

This module ensures the application works across different macOS versions and
handles cases where Python/Node or other dependencies might not exist.
"""

import sys
import platform
import subprocess
import logging
from typing import Optional, Tuple, Any, Dict
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================================
# SYSTEM COMPATIBILITY CHECKS
# ============================================================================

class MacOSCompatibility:
    """Handles macOS version compatibility and feature detection."""
    
    def __init__(self):
        self.macos_version = self._get_macos_version()
        self.python_version = self._get_python_version()
        self.capabilities = self._detect_capabilities()
        
    def _get_macos_version(self) -> Tuple[int, int, int]:
        """Get macOS version as tuple (major, minor, patch)."""
        try:
            version_str = platform.mac_ver()[0]
            parts = version_str.split('.')
            return (
                int(parts[0]),
                int(parts[1]) if len(parts) > 1 else 0,
                int(parts[2]) if len(parts) > 2 else 0
            )
        except Exception as e:
            logger.error(f"Failed to detect macOS version: {e}")
            return (10, 15, 0)  # Safe fallback
    
    def _get_python_version(self) -> Tuple[int, int, int]:
        """Get Python version as tuple."""
        return sys.version_info[:3]
    
    def _detect_capabilities(self) -> Dict[str, bool]:
        """Detect available system capabilities."""
        capabilities = {
            'modern_screen_capture': False,
            'user_notifications': False,
            'modern_pyobjc': False,
            'node_available': False,
            'python312_plus': False,
        }
        
        # Check Python 3.12+
        capabilities['python312_plus'] = self.python_version >= (3, 12, 0)
        
        # Check modern screen capture (macOS 12.3+)
        if self.macos_version >= (12, 3, 0):
            try:
                import ScreenCaptureKit
                capabilities['modern_screen_capture'] = True
            except ImportError:
                pass
        
        # Check modern notifications (macOS 10.14+)
        if self.macos_version >= (10, 14, 0):
            try:
                import UserNotifications
                capabilities['user_notifications'] = True
            except ImportError:
                pass
        
        # Check modern PyObjC
        try:
            import PyObjC
            version = PyObjC.__version__ if hasattr(PyObjC, '__version__') else '0.0.0'
            major_version = int(version.split('.')[0])
            capabilities['modern_pyobjc'] = major_version >= 10
        except (ImportError, ValueError):
            pass
        
        # Check Node.js availability
        capabilities['node_available'] = self._check_node_availability()
        
        return capabilities
    
    def _check_node_availability(self) -> bool:
        """Check if Node.js is available and working."""
        try:
            result = subprocess.run(['node', '--version'], 
                                  capture_output=True, text=True, timeout=5)
            return result.returncode == 0
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False
    
    def is_compatible(self) -> bool:
        """Check if system meets minimum requirements."""
        return (
            self.macos_version >= (14, 0, 0) and
            self.python_version >= (3, 10, 0)
        )
    
    def get_compatibility_report(self) -> str:
        """Generate a detailed compatibility report."""
        report = f"""
macOS Compatibility Report
=========================
macOS Version: {'.'.join(map(str, self.macos_version))}
Python Version: {'.'.join(map(str, self.python_version))}
Compatible: {'✅ Yes' if self.is_compatible() else '❌ No'}

Capabilities:
"""
        for capability, available in self.capabilities.items():
            status = '✅' if available else '❌'
            report += f"  {status} {capability.replace('_', ' ').title()}: {available}\n"
        
        return report

# ============================================================================
# FRAMEWORK COMPATIBILITY WRAPPERS
# ============================================================================

class ScreenCaptureCompat:
    """Screen capture with fallback for different macOS versions."""
    
    def __init__(self):
        self.use_modern = False
        self.use_legacy = False
        self._initialize()
    
    def _initialize(self):
        """Initialize the best available screen capture method."""
        # Try modern ScreenCaptureKit first (macOS 12.3+)
        try:
            import ScreenCaptureKit
            self.use_modern = True
            logger.info("Using modern ScreenCaptureKit for screen capture")
            return
        except ImportError:
            pass
        
        # Fallback to legacy Quartz
        try:
            import Quartz
            self.use_legacy = True
            logger.info("Using legacy Quartz for screen capture")
            return
        except ImportError:
            logger.error("No screen capture framework available")
    
    def capture_screen(self, display_id: int = 0) -> Optional[Any]:
        """Capture screen using the best available method."""
        if self.use_modern:
            return self._capture_modern(display_id)
        elif self.use_legacy:
            return self._capture_legacy(display_id)
        else:
            logger.error("No screen capture method available")
            return None
    
    def _capture_modern(self, display_id: int) -> Optional[Any]:
        """Capture using modern ScreenCaptureKit."""
        try:
            import ScreenCaptureKit as SCK
            # Modern implementation would go here
            logger.debug("Modern screen capture executed")
            return None  # Placeholder
        except Exception as e:
            logger.error(f"Modern screen capture failed: {e}")
            return None
    
    def _capture_legacy(self, display_id: int) -> Optional[Any]:
        """Capture using legacy Quartz framework."""
        try:
            from Quartz import CGDisplayCreateImage, CGMainDisplayID
            image = CGDisplayCreateImage(CGMainDisplayID())
            return image
        except Exception as e:
            logger.error(f"Legacy screen capture failed: {e}")
            return None

class NotificationCompat:
    """Cross-version notification system."""
    
    def __init__(self):
        self.use_modern = False
        self.use_legacy = False
        self.use_fallback = False
        self._initialize()
    
    def _initialize(self):
        """Initialize the best available notification method."""
        # Try modern UserNotifications first
        try:
            import UserNotifications
            self.use_modern = True
            logger.info("Using modern UserNotifications framework")
            return
        except ImportError:
            pass
        
        # Try NSUserNotification (deprecated but still works)
        try:
            from Cocoa import NSUserNotification, NSUserNotificationCenter
            self.use_legacy = True
            logger.info("Using legacy NSUserNotification")
            return
        except ImportError:
            pass
        
        # Fallback to print/log
        self.use_fallback = True
        logger.warning("No notification framework available - using fallback")
    
    def send_notification(self, title: str, message: str, sound: bool = True):
        """Send notification using the best available method."""
        if self.use_modern:
            self._send_modern(title, message, sound)
        elif self.use_legacy:
            self._send_legacy(title, message, sound)
        else:
            self._send_fallback(title, message)
    
    def _send_modern(self, title: str, message: str, sound: bool):
        """Send using modern UserNotifications."""
        try:
            # Modern implementation would go here
            logger.info(f"Modern notification: {title} - {message}")
        except Exception as e:
            logger.error(f"Modern notification failed: {e}")
    
    def _send_legacy(self, title: str, message: str, sound: bool):
        """Send using legacy NSUserNotification."""
        try:
            from Cocoa import NSUserNotification, NSUserNotificationCenter
            notification = NSUserNotification.alloc().init()
            notification.setTitle_(title)
            notification.setInformativeText_(message)
            if sound:
                notification.setSoundName_("NSUserNotificationDefaultSoundName")
            
            center = NSUserNotificationCenter.defaultUserNotificationCenter()
            center.deliverNotification_(notification)
        except Exception as e:
            logger.error(f"Legacy notification failed: {e}")
    
    def _send_fallback(self, title: str, message: str):
        """Fallback notification to console."""
        print(f"NOTIFICATION: {title} - {message}")

# ============================================================================
# DEPENDENCY MANAGEMENT
# ============================================================================

class DependencyManager:
    """Manages missing dependencies and provides alternatives."""
    
    def __init__(self):
        self.missing_deps = []
        self.available_deps = {}
        self._check_dependencies()
    
    def _check_dependencies(self):
        """Check availability of key dependencies."""
        deps_to_check = {
            'flask': 'Web framework',
            'supabase': 'Database client',
            'PIL': 'Image processing', 
            'pystray': 'System tray',
            'keyring': 'Secure storage',
            'requests': 'HTTP client',
            'psutil': 'System monitoring',
            'pynput': 'Input monitoring',
        }
        
        for dep_name, description in deps_to_check.items():
            try:
                __import__(dep_name)
                self.available_deps[dep_name] = description
            except ImportError:
                self.missing_deps.append((dep_name, description))
                logger.warning(f"Missing dependency: {dep_name} ({description})")
    
    def get_missing_dependencies(self) -> list:
        """Get list of missing dependencies."""
        return self.missing_deps
    
    def has_critical_deps(self) -> bool:
        """Check if critical dependencies are available."""
        critical = ['flask', 'PIL', 'requests']
        missing_critical = [dep for dep in critical 
                          if dep not in self.available_deps]
        return len(missing_critical) == 0
    
    def install_missing_deps(self, auto_install: bool = False) -> bool:
        """Install missing dependencies if possible."""
        if not self.missing_deps or not auto_install:
            return True
        
        try:
            import subprocess
            for dep_name, _ in self.missing_deps:
                logger.info(f"Attempting to install {dep_name}")
                result = subprocess.run([
                    sys.executable, '-m', 'pip', 'install', dep_name
                ], capture_output=True, text=True)
                
                if result.returncode == 0:
                    logger.info(f"Successfully installed {dep_name}")
                else:
                    logger.error(f"Failed to install {dep_name}: {result.stderr}")
                    
            # Re-check after installation
            self._check_dependencies()
            return len(self.missing_deps) == 0
            
        except Exception as e:
            logger.error(f"Auto-installation failed: {e}")
            return False

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def check_language_availability() -> Dict[str, Dict[str, Any]]:
    """Check availability of different programming languages."""
    languages = {}
    
    # Python
    python_info = {
        'available': True,
        'version': f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        'executable': sys.executable,
        'modern': sys.version_info >= (3, 12, 0)
    }
    languages['python'] = python_info
    
    # Node.js
    node_info = {'available': False, 'version': None, 'executable': None}
    try:
        result = subprocess.run(['node', '--version'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            node_info.update({
                'available': True,
                'version': result.stdout.strip().lstrip('v'),
                'executable': 'node'
            })
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    languages['node'] = node_info
    
    # Java
    java_info = {'available': False, 'version': None, 'executable': None}
    try:
        result = subprocess.run(['java', '-version'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            java_info.update({
                'available': True,
                'version': result.stderr.split('\n')[0],  # Java version is in stderr
                'executable': 'java'
            })
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    languages['java'] = java_info
    
    return languages

def create_compatibility_report() -> str:
    """Create a comprehensive compatibility report."""
    compat = MacOSCompatibility()
    deps = DependencyManager()
    languages = check_language_availability()
    
    report = f"""
JIRAForge TimeTracker - System Compatibility Report
===================================================

{compat.get_compatibility_report()}

Dependencies Status:
===================
Available Dependencies: {len(deps.available_deps)}
Missing Dependencies: {len(deps.missing_deps)}
Critical Dependencies OK: {'✅ Yes' if deps.has_critical_deps() else '❌ No'}

Language Runtime Status:
=======================
"""
    
    for lang_name, lang_info in languages.items():
        status = '✅' if lang_info['available'] else '❌'
        version = lang_info['version'] or 'Not Available'
        report += f"  {status} {lang_name.title()}: {version}\n"
    
    if deps.missing_deps:
        report += f"\nMissing Dependencies:\n"
        for dep_name, description in deps.missing_deps:
            report += f"  ❌ {dep_name}: {description}\n"
        
        report += f"\nTo install missing dependencies:\n"
        report += f"pip install " + " ".join([dep[0] for dep in deps.missing_deps])
    
    return report

# ============================================================================
# INITIALIZATION
# ============================================================================

# Global instances for easy access
_compat_instance = None
_screen_capture = None
_notifications = None
_deps_manager = None

def init_compatibility_layer():
    """Initialize the compatibility layer."""
    global _compat_instance, _screen_capture, _notifications, _deps_manager
    
    if _compat_instance is None:
        _compat_instance = MacOSCompatibility()
        _screen_capture = ScreenCaptureCompat()
        _notifications = NotificationCompat()
        _deps_manager = DependencyManager()
        
        logger.info("macOS compatibility layer initialized")
        
        # Show warning if system is not fully compatible
        if not _compat_instance.is_compatible():
            logger.warning("System does not meet minimum requirements")
            
        if not _deps_manager.has_critical_deps():
            logger.error("Critical dependencies missing - app may not function properly")

def get_compatibility() -> MacOSCompatibility:
    """Get the compatibility checker instance."""
    if _compat_instance is None:
        init_compatibility_layer()
    return _compat_instance

def get_screen_capture() -> ScreenCaptureCompat:
    """Get the screen capture compatibility wrapper.""" 
    if _screen_capture is None:
        init_compatibility_layer()
    return _screen_capture

def get_notifications() -> NotificationCompat:
    """Get the notifications compatibility wrapper."""
    if _notifications is None:
        init_compatibility_layer()
    return _notifications

def get_dependency_manager() -> DependencyManager:
    """Get the dependency manager instance."""
    if _deps_manager is None:
        init_compatibility_layer()
    return _deps_manager

# ============================================================================
# MODULE ENTRY POINT
# ============================================================================

if __name__ == '__main__':
    # If run directly, show compatibility report
    init_compatibility_layer()
    print(create_compatibility_report())