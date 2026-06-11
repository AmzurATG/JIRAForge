#!/usr/bin/env python3
"""
System Dependency Checker for TimeTracker
Detects missing dependencies and provides installation guidance.
"""

import os
import sys
import subprocess
import logging
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


class SystemDependencyChecker:
    """Check for required system dependencies at startup."""
    
    def __init__(self):
        self.is_wayland = self._is_wayland_session()
        self.missing_deps = []
        self.warnings = []
        
    def _is_wayland_session(self) -> bool:
        """Check if running on Wayland."""
        return bool(os.environ.get('WAYLAND_DISPLAY'))
    
    def check_pipewire(self) -> bool:
        """Check if PipeWire is running."""
        try:
            result = subprocess.run(
                ['ps', 'aux'],
                capture_output=True,
                text=True,
                timeout=2
            )
            return 'pipewire' in result.stdout
        except Exception as e:
            logger.debug(f"PipeWire check failed: {e}")
            return False
    
    def check_gstreamer_plugin(self, plugin_name: str) -> bool:
        """Check if a GStreamer plugin is available."""
        try:
            result = subprocess.run(
                ['gst-inspect-1.0', plugin_name],
                capture_output=True,
                timeout=3
            )
            return result.returncode == 0
        except FileNotFoundError:
            logger.debug("gst-inspect-1.0 not found")
            return False
        except Exception as e:
            logger.debug(f"GStreamer plugin check failed: {e}")
            return False
    
    def check_screencast_portal(self) -> bool:
        """Check if ScreenCast Portal is available."""
        try:
            result = subprocess.run(
                ['gdbus', 'introspect', '--session',
                 '--dest', 'org.freedesktop.portal.Desktop',
                 '--object-path', '/org/freedesktop/portal/desktop'],
                capture_output=True,
                text=True,
                timeout=3
            )
            return (result.returncode == 0 and 
                    'org.freedesktop.portal.ScreenCast' in result.stdout)
        except FileNotFoundError:
            logger.debug("gdbus not found")
            return False
        except Exception as e:
            logger.debug(f"ScreenCast Portal check failed: {e}")
            return False
    
    def check_all(self) -> Dict[str, bool]:
        """
        Run all dependency checks.
        
        Returns:
            Dict mapping check name to pass/fail status
        """
        if not self.is_wayland:
            logger.info("Running on X11 - Wayland dependencies not required")
            return {
                'wayland': False,
                'pipewire': True,  # Not needed on X11
                'gstreamer_pipewiresrc': True,
                'screencast_portal': True,
                'all_checks_passed': True
            }
        
        results = {
            'wayland': True,
            'pipewire': self.check_pipewire(),
            'gstreamer_pipewiresrc': self.check_gstreamer_plugin('pipewiresrc'),
            'screencast_portal': self.check_screencast_portal(),
        }
        
        results['all_checks_passed'] = all([
            results['pipewire'],
            results['gstreamer_pipewiresrc'],
            results['screencast_portal']
        ])
        
        return results
    
    def get_installation_instructions(self) -> str:
        """
        Get installation instructions for missing dependencies.
        
        Returns:
            Formatted string with installation commands
        """
        instructions = []
        
        instructions.append("=" * 60)
        instructions.append("SCREENSHOT CAPTURE DEPENDENCIES MISSING")
        instructions.append("=" * 60)
        instructions.append("")
        instructions.append("TimeTracker requires system packages for screenshot capture.")
        instructions.append("")
        instructions.append("QUICK FIX:")
        instructions.append("  Run our automated fix script:")
        instructions.append("  ./scripts/fix-screenshot-capture.sh")
        instructions.append("")
        instructions.append("MANUAL INSTALLATION:")
        instructions.append("  sudo apt install -y \\")
        instructions.append("    pipewire \\")
        instructions.append("    wireplumber \\")
        instructions.append("    gstreamer1.0-plugins-base \\")
        instructions.append("    gstreamer1.0-plugins-good \\")
        instructions.append("    gstreamer1.0-pipewire \\")
        instructions.append("    xdg-desktop-portal \\")
        instructions.append("    xdg-desktop-portal-gnome")
        instructions.append("")
        instructions.append("AFTER INSTALLATION:")
        instructions.append("  1. Restart PipeWire: systemctl --user restart pipewire")
        instructions.append("  2. Restart TimeTracker")
        instructions.append("  3. Grant screenshot permission when prompted")
        instructions.append("")
        instructions.append("CURRENT STATUS: Running in METADATA-ONLY mode")
        instructions.append("  - Window titles tracked: YES")
        instructions.append("  - Screen content (OCR): NO")
        instructions.append("")
        instructions.append("See docs/USER_FIX_GUIDE_OCR_ISSUE.md for details")
        instructions.append("=" * 60)
        
        return "\n".join(instructions)
    
    def check_and_warn(self) -> bool:
        """
        Run checks and log warnings if dependencies missing.
        
        Returns:
            True if all checks passed, False otherwise
        """
        if not self.is_wayland:
            logger.info("X11 session detected - screenshot capture should work")
            return True
        
        results = self.check_all()
        
        if results['all_checks_passed']:
            logger.info("All screenshot capture dependencies present")
            return True
        
        # Log specific failures
        if not results['pipewire']:
            logger.warning("PipeWire is not running")
            self.missing_deps.append("PipeWire")
        
        if not results['gstreamer_pipewiresrc']:
            logger.warning("GStreamer pipewiresrc plugin not available")
            self.missing_deps.append("GStreamer plugins")
        
        if not results['screencast_portal']:
            logger.warning("ScreenCast Portal not available")
            self.missing_deps.append("XDG Desktop Portal")
        
        # Print installation instructions
        print(self.get_installation_instructions(), file=sys.stderr)
        
        return False


def check_dependencies_startup():
    """
    Entry point for startup dependency check.
    Call this during application initialization.
    
    Returns:
        Tuple[bool, List[str]] - (all_ok, missing_deps)
    """
    checker = SystemDependencyChecker()
    all_ok = checker.check_and_warn()
    
    return all_ok, checker.missing_deps


if __name__ == '__main__':
    # Standalone test
    print("TimeTracker Dependency Checker")
    print("=" * 60)
    
    checker = SystemDependencyChecker()
    results = checker.check_all()
    
    print(f"\nWayland session: {checker.is_wayland}")
    print(f"PipeWire running: {results.get('pipewire', 'N/A')}")
    print(f"GStreamer pipewiresrc: {results.get('gstreamer_pipewiresrc', 'N/A')}")
    print(f"ScreenCast Portal: {results.get('screencast_portal', 'N/A')}")
    print(f"\nAll checks passed: {results['all_checks_passed']}")
    
    if not results['all_checks_passed']:
        print("\n" + checker.get_installation_instructions())
        sys.exit(1)
    else:
        print("\n✅ All dependencies present!")
        sys.exit(0)
