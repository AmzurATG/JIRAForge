#!/usr/bin/env python3
"""
System Dependency Checker for TimeTracker
Detects missing dependencies and provides distro-aware installation guidance.
"""

import os
import sys
import subprocess
import logging
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------

def detect_distro() -> dict:
    """
    Parse /etc/os-release to identify the distro family and package manager.

    Returns a dict with keys:
        'id'          – lowercase distro ID (e.g. 'ubuntu', 'fedora', 'arch')
        'id_like'     – space-separated parent families (may be empty)
        'pkg_manager' – one of 'apt' | 'dnf' | 'zypper' | 'pacman'
        'install_cmd' – the sudo install prefix (e.g. 'sudo apt install -y')
    """
    info = {'id': '', 'id_like': '', 'pkg_manager': 'apt',
            'install_cmd': 'sudo apt install -y'}

    try:
        with open('/etc/os-release', 'r') as fh:
            for line in fh:
                line = line.strip()
                if line.startswith('ID='):
                    info['id'] = line.split('=', 1)[1].strip('"').lower()
                elif line.startswith('ID_LIKE='):
                    info['id_like'] = line.split('=', 1)[1].strip('"').lower()
    except OSError:
        logger.debug("Could not read /etc/os-release — defaulting to apt")
        return info

    combined = f"{info['id']} {info['id_like']}"

    if any(x in combined for x in ('ubuntu', 'debian', 'linuxmint', 'pop',
                                    'elementary', 'zorin', 'neon')):
        info['pkg_manager'] = 'apt'
        info['install_cmd'] = 'sudo apt install -y'
    elif any(x in combined for x in ('fedora', 'rhel', 'centos', 'rocky',
                                      'alma', 'ol', 'scientific')):
        info['pkg_manager'] = 'dnf'
        info['install_cmd'] = 'sudo dnf install -y'
    elif any(x in combined for x in ('opensuse', 'sles', 'sle')):
        info['pkg_manager'] = 'zypper'
        info['install_cmd'] = 'sudo zypper install -y'
    elif any(x in combined for x in ('arch', 'manjaro', 'endeavouros',
                                      'garuda', 'artix')):
        info['pkg_manager'] = 'pacman'
        info['install_cmd'] = 'sudo pacman -S --noconfirm'

    return info


# Package name mapping per logical component per package manager
_PACKAGE_MAP: Dict[str, Dict[str, List[str]]] = {
    'pipewire': {
        'apt':    ['pipewire', 'wireplumber'],
        'dnf':    ['pipewire', 'wireplumber'],
        'zypper': ['pipewire', 'wireplumber'],
        'pacman': ['pipewire', 'wireplumber'],
    },
    'gstreamer_base': {
        'apt':    ['gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good',
                   'gstreamer1.0-tools'],
        'dnf':    ['gstreamer1-plugins-base', 'gstreamer1-plugins-good',
                   'gstreamer1-devel'],
        'zypper': ['gstreamer-plugins-base', 'gstreamer-plugins-good'],
        'pacman': ['gst-plugins-base', 'gst-plugins-good'],
    },
    'gstreamer_pipewire': {
        'apt':    ['gstreamer1.0-pipewire'],
        'dnf':    ['gstreamer1-plugin-pipewire'],
        'zypper': ['gstreamer-plugin-pipewire'],
        'pacman': ['gst-plugin-pipewire'],
    },
    'xdg_portal': {
        'apt':    ['xdg-desktop-portal'],
        'dnf':    ['xdg-desktop-portal'],
        'zypper': ['xdg-desktop-portal'],
        'pacman': ['xdg-desktop-portal'],
    },
    'xdg_portal_backend': {
        'apt':    ['xdg-desktop-portal-gnome'],
        'dnf':    ['xdg-desktop-portal-gnome'],
        'zypper': ['xdg-desktop-portal-gnome'],
        'pacman': ['xdg-desktop-portal-gnome'],
    },
}

# Restart command after installation
_RESTART_CMD = 'systemctl --user restart pipewire pipewire-pulse wireplumber'


def get_distro_packages(missing_checks: Dict[str, bool],
                         pkg_manager: str) -> List[str]:
    """
    Return the list of packages to install for the given failing checks.

    Args:
        missing_checks: dict of check_name → False for each failing check.
        pkg_manager: one of 'apt' | 'dnf' | 'zypper' | 'pacman'.

    Returns:
        Ordered, de-duplicated list of package names.
    """
    needed_components: List[str] = []

    if not missing_checks.get('pipewire', True):
        needed_components.append('pipewire')

    if not missing_checks.get('gstreamer_pipewiresrc', True):
        needed_components.append('gstreamer_base')
        needed_components.append('gstreamer_pipewire')

    if not missing_checks.get('screencast_portal', True):
        needed_components.append('xdg_portal')
        needed_components.append('xdg_portal_backend')

    packages: List[str] = []
    seen = set()
    pm = pkg_manager if pkg_manager in ('apt', 'dnf', 'zypper', 'pacman') else 'apt'
    for component in needed_components:
        for pkg in _PACKAGE_MAP.get(component, {}).get(pm, []):
            if pkg not in seen:
                seen.add(pkg)
                packages.append(pkg)

    return packages


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
    
    def check_gstreamer_pipewire_installable(self) -> dict:
        """
        Phase 1 (OCR fix): Distinguish between missing plugin vs daemon not running.

        Returns a diagnostic dict:
            {
                'plugin_installed': bool,   # gstreamer1.0-pipewire pkg detected
                'plugin_loadable': bool,    # gst-inspect-1.0 pipewiresrc succeeds
                'pipewire_running': bool,   # pipewire process in ps output
                'action': str               # 'install' | 'restart' | 'ok' | 'unknown'
            }
        """
        plugin_loadable = self.check_gstreamer_plugin('pipewiresrc')
        pipewire_running = self.check_pipewire()

        # Try to determine if the package is installed but plugin not loadable
        plugin_installed = plugin_loadable  # conservative default
        try:
            result = subprocess.run(
                ['dpkg', '-l', 'gstreamer1.0-pipewire'],
                capture_output=True, text=True, timeout=3
            )
            # dpkg output line starts with 'ii' when installed
            plugin_installed = any(
                line.startswith('ii') and 'gstreamer1.0-pipewire' in line
                for line in result.stdout.splitlines()
            )
        except (FileNotFoundError, Exception):
            # dpkg not available (non-Debian distro) — fall back to plugin loadable
            plugin_installed = plugin_loadable

        if plugin_loadable and pipewire_running:
            action = 'ok'
        elif not plugin_installed:
            action = 'install'
        elif not pipewire_running:
            action = 'restart'
        elif plugin_installed and not plugin_loadable:
            action = 'restart'  # installed but not loadable → PipeWire restart may help
        else:
            action = 'unknown'

        logger.debug(
            f"[GStreamerPipeWire] plugin_installed={plugin_installed} "
            f"plugin_loadable={plugin_loadable} pipewire_running={pipewire_running} "
            f"action={action}"
        )
        return {
            'plugin_installed': plugin_installed,
            'plugin_loadable': plugin_loadable,
            'pipewire_running': pipewire_running,
            'action': action,
        }

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
        Get distro-aware installation instructions for missing dependencies.

        Returns:
            Formatted string with installation commands (for logs / STDERR).
        """
        data = self.get_installation_instructions_dict()
        lines = []
        lines.append("=" * 60)
        lines.append("SCREENSHOT CAPTURE DEPENDENCIES MISSING")
        lines.append("=" * 60)
        lines.append("")
        lines.append("TimeTracker requires system packages for screenshot capture.")
        lines.append(f"Detected distro family: {data['distro']}  "
                     f"(package manager: {data['pkg_manager']})")
        lines.append("")
        lines.append("INSTALL COMMAND:")
        lines.append(f"  {data['install_command']}")
        lines.append("")
        lines.append("AFTER INSTALLATION:")
        lines.append(f"  1. Restart PipeWire: {data['restart_command']}")
        lines.append("  2. Restart TimeTracker")
        lines.append("  3. Grant screenshot permission when prompted")
        lines.append("")
        lines.append("CURRENT STATUS: Running in METADATA-ONLY mode")
        lines.append("  - Window titles tracked: YES")
        lines.append("  - Screen content (OCR): NO")
        lines.append("=" * 60)
        return "\n".join(lines)

    def get_installation_instructions_dict(self) -> dict:
        """
        Return installation data as a structured dict (used by the web UI).

        Returns:
            {
              'distro': str,
              'pkg_manager': str,
              'install_command': str,  # single runnable command
              'restart_command': str,
              'missing': {
                  'pipewire': bool,
                  'gstreamer_pipewiresrc': bool,
                  'screencast_portal': bool,
              },
              'packages': [str, ...]   # only the packages actually needed
            }
        """
        distro_info = detect_distro()
        pm = distro_info['pkg_manager']

        # Re-run check to know which items are missing
        results = self.check_all()
        missing = {
            'pipewire': not results.get('pipewire', True),
            'gstreamer_pipewiresrc': not results.get('gstreamer_pipewiresrc', True),
            'screencast_portal': not results.get('screencast_portal', True),
        }

        packages = get_distro_packages(results, pm)
        if packages:
            install_command = f"{distro_info['install_cmd']} {' '.join(packages)}"
        else:
            install_command = "(no packages needed)"

        return {
            'distro': distro_info['id'] or 'linux',
            'pkg_manager': pm,
            'install_command': install_command,
            'restart_command': _RESTART_CMD,
            'missing': missing,
            'packages': packages,
        }

    def recheck(self) -> Tuple[bool, List[str]]:
        """
        Re-run all dependency checks at runtime (e.g. after the user installs
        packages mid-session).  Does NOT reinitialise GStreamer — a full app
        restart is still required to activate capture; this only refreshes
        the UI state.

        Returns:
            Tuple[bool, List[str]] — (all_ok, remaining_missing_dep_names)
        """
        self.missing_deps = []
        results = self.check_all()

        if not results.get('pipewire', True):
            self.missing_deps.append("PipeWire")
        if not results.get('gstreamer_pipewiresrc', True):
            self.missing_deps.append("GStreamer plugins")
        if not results.get('screencast_portal', True):
            self.missing_deps.append("XDG Desktop Portal")

        return results['all_checks_passed'], self.missing_deps
    
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
        Tuple[bool, List[str], SystemDependencyChecker]
            - all_ok: True when all checks pass
            - missing_deps: human-readable list of what is missing
            - checker: the live SystemDependencyChecker instance (kept for
              later recheck() calls without creating a new subprocess chain)
    """
    checker = SystemDependencyChecker()
    all_ok = checker.check_and_warn()
    return all_ok, checker.missing_deps, checker


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
