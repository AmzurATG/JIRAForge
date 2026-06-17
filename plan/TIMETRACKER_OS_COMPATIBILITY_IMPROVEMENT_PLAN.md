# TimeTracker OS Compatibility Improvement Plan

**Date Created:** 2026-06-17  
**Priority:** High  
**Status:** Planning  
**Estimated Effort:** 2-3 weeks

---

## Executive Summary

This document outlines a comprehensive plan to make TimeTracker fully compatible across different Linux distributions and GNOME/KDE versions. The plan addresses the root cause of failures observed on newer systems (Ubuntu 25.04 / GNOME 49) while maintaining compatibility with older systems (Ubuntu 24.04 LTS / GNOME 46).

### Key Problems Identified

| Issue | Ubuntu 24.04 (GNOME 46) | Ubuntu 25.04+ (GNOME 49) |
|-------|-------------------------|--------------------------|
| Window Detection | ✅ Works | ❌ All methods fail |
| Idle Detection | ✅ gnome_mutter | ⚠️ Falls back to pynput |
| Screenshot Capture | ⚠️ Partially works | ❌ Dependencies missing |
| System Tray | ✅ Full AppIndicator | ⚠️ Limited (_xorg backend) |

---

## Table of Contents

1. [Phase 1: Enhanced OS Diagnostics Logging](#phase-1-enhanced-os-diagnostics-logging)
2. [Phase 2: Window Detection Improvements](#phase-2-window-detection-improvements)
3. [Phase 3: Idle Detection Improvements](#phase-3-idle-detection-improvements)
4. [Phase 4: Screenshot Capture Improvements](#phase-4-screenshot-capture-improvements)
5. [Phase 5: Comprehensive Test Suite](#phase-5-comprehensive-test-suite)
6. [Phase 6: Runtime Compatibility Checks](#phase-6-runtime-compatibility-checks)
7. [Implementation Timeline](#implementation-timeline)
8. [Test Scripts](#test-scripts)

---

## Phase 1: Enhanced OS Diagnostics Logging

### Goal
Add comprehensive logging at startup to identify OS compatibility issues immediately from log files.

### 1.1 New Module: `os_diagnostics.py`

Create a dedicated module for OS environment detection and logging.

```python
# File: python-desktop-app/os_diagnostics.py
"""
OS Diagnostics Module for TimeTracker

Collects and logs comprehensive system information at startup to help
diagnose OS compatibility issues from log files alone.

Usage:
    from os_diagnostics import collect_os_diagnostics, log_os_diagnostics
    
    diagnostics = collect_os_diagnostics()
    log_os_diagnostics(diagnostics, logger)
"""

import os
import sys
import re
import subprocess
import logging
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field
from enum import Enum


class CompatibilityLevel(Enum):
    """Compatibility assessment levels."""
    FULL = "full"           # All features should work
    PARTIAL = "partial"     # Some features may have issues
    LIMITED = "limited"     # Many features will not work
    UNKNOWN = "unknown"     # Cannot determine


@dataclass
class OSInfo:
    """Operating system information."""
    kernel_version: str = ""
    kernel_full: str = ""
    distro_id: str = ""
    distro_name: str = ""
    distro_version: str = ""
    distro_codename: str = ""
    distro_id_like: str = ""  # Parent distro family


@dataclass
class DesktopEnvironment:
    """Desktop environment information."""
    name: str = ""                    # GNOME, KDE, etc.
    version: str = ""                 # e.g., "49.0"
    version_major: int = 0            # e.g., 49
    wayland_display: str = ""         # WAYLAND_DISPLAY env var
    x_display: str = ""               # DISPLAY env var
    session_type: str = ""            # XDG_SESSION_TYPE
    current_desktop: str = ""         # XDG_CURRENT_DESKTOP
    is_wayland: bool = False
    is_xwayland_available: bool = False


@dataclass
class DBusServices:
    """D-Bus service availability."""
    session_bus_available: bool = False
    system_bus_available: bool = False
    gnome_shell: bool = False
    gnome_shell_introspect: bool = False
    gnome_mutter_idle_monitor: bool = False
    freedesktop_screensaver: bool = False
    freedesktop_portal_desktop: bool = False
    freedesktop_portal_screencast: bool = False
    freedesktop_portal_screenshot: bool = False
    atspi_bus: bool = False


@dataclass
class SystemCapabilities:
    """System capabilities and tools."""
    # Screenshot tools
    gnome_screenshot_available: bool = False
    scrot_available: bool = False
    grim_available: bool = False  # wlroots/Sway screenshot tool
    
    # Window detection tools
    xdotool_available: bool = False
    gdbus_available: bool = False
    python_gi_available: bool = False
    atspi_available: bool = False
    
    # GStreamer
    gstreamer_available: bool = False
    gst_pipewiresrc_available: bool = False
    
    # PipeWire
    pipewire_running: bool = False
    wireplumber_running: bool = False
    
    # System tray
    appindicator_available: bool = False


@dataclass
class CompatibilityReport:
    """Full compatibility assessment."""
    os_info: OSInfo = field(default_factory=OSInfo)
    desktop: DesktopEnvironment = field(default_factory=DesktopEnvironment)
    dbus: DBusServices = field(default_factory=DBusServices)
    capabilities: SystemCapabilities = field(default_factory=SystemCapabilities)
    
    # Assessments
    window_detection_level: CompatibilityLevel = CompatibilityLevel.UNKNOWN
    idle_detection_level: CompatibilityLevel = CompatibilityLevel.UNKNOWN
    screenshot_level: CompatibilityLevel = CompatibilityLevel.UNKNOWN
    overall_level: CompatibilityLevel = CompatibilityLevel.UNKNOWN
    
    # Recommendations
    warnings: List[str] = field(default_factory=list)
    recommendations: List[str] = field(default_factory=list)
    blockers: List[str] = field(default_factory=list)


def _run_cmd(cmd: List[str], timeout: int = 5) -> Tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return -1, "", "Command not found"
    except subprocess.TimeoutExpired:
        return -2, "", "Timeout"
    except Exception as e:
        return -3, "", str(e)


def _check_dbus_service(bus_type: str, dest: str, path: str, 
                        interface: str = None) -> bool:
    """Check if a D-Bus service is available."""
    cmd = ['gdbus', 'introspect', f'--{bus_type}', '--dest', dest, '--object-path', path]
    rc, stdout, _ = _run_cmd(cmd, timeout=3)
    if rc != 0:
        return False
    if interface:
        return interface in stdout
    return True


def collect_os_info() -> OSInfo:
    """Collect operating system information."""
    info = OSInfo()
    
    # Kernel version
    rc, stdout, _ = _run_cmd(['uname', '-r'])
    if rc == 0:
        info.kernel_version = stdout.strip()
    
    rc, stdout, _ = _run_cmd(['uname', '-a'])
    if rc == 0:
        info.kernel_full = stdout.strip()
    
    # Parse /etc/os-release
    try:
        with open('/etc/os-release', 'r') as f:
            for line in f:
                line = line.strip()
                if '=' in line:
                    key, value = line.split('=', 1)
                    value = value.strip('"\'')
                    if key == 'ID':
                        info.distro_id = value.lower()
                    elif key == 'NAME':
                        info.distro_name = value
                    elif key == 'VERSION_ID':
                        info.distro_version = value
                    elif key == 'VERSION_CODENAME':
                        info.distro_codename = value
                    elif key == 'ID_LIKE':
                        info.distro_id_like = value.lower()
    except OSError:
        pass
    
    return info


def collect_desktop_environment() -> DesktopEnvironment:
    """Collect desktop environment information."""
    de = DesktopEnvironment()
    
    # Environment variables
    de.wayland_display = os.environ.get('WAYLAND_DISPLAY', '')
    de.x_display = os.environ.get('DISPLAY', '')
    de.session_type = os.environ.get('XDG_SESSION_TYPE', '')
    de.current_desktop = os.environ.get('XDG_CURRENT_DESKTOP', '')
    
    # Determine if Wayland
    de.is_wayland = bool(de.wayland_display or de.session_type.lower() == 'wayland')
    
    # Check XWayland
    if de.is_wayland:
        rc, stdout, _ = _run_cmd(['pgrep', '-x', 'Xwayland'])
        de.is_xwayland_available = (rc == 0 and bool(stdout.strip()))
    
    # GNOME Shell version
    rc, stdout, _ = _run_cmd(['gnome-shell', '--version'])
    if rc == 0:
        de.name = 'GNOME'
        match = re.search(r'(\d+)\.(\d+)', stdout)
        if match:
            de.version = f"{match.group(1)}.{match.group(2)}"
            de.version_major = int(match.group(1))
    
    # KDE Plasma version
    if not de.name:
        rc, stdout, _ = _run_cmd(['plasmashell', '--version'])
        if rc == 0:
            de.name = 'KDE'
            match = re.search(r'(\d+)\.(\d+)', stdout)
            if match:
                de.version = f"{match.group(1)}.{match.group(2)}"
                de.version_major = int(match.group(1))
    
    # Other desktops
    if not de.name:
        current = de.current_desktop.lower()
        if 'sway' in current:
            de.name = 'Sway'
        elif 'hyprland' in current:
            de.name = 'Hyprland'
        elif 'wlroots' in current:
            de.name = 'wlroots-based'
        elif 'xfce' in current:
            de.name = 'XFCE'
        elif 'mate' in current:
            de.name = 'MATE'
        elif 'cinnamon' in current:
            de.name = 'Cinnamon'
        else:
            de.name = de.current_desktop or 'Unknown'
    
    return de


def collect_dbus_services() -> DBusServices:
    """Check availability of D-Bus services."""
    dbus = DBusServices()
    
    # Check if gdbus is available first
    rc, _, _ = _run_cmd(['which', 'gdbus'])
    if rc != 0:
        return dbus  # Can't check services without gdbus
    
    # Session bus
    dbus.session_bus_available = _check_dbus_service(
        'session', 'org.freedesktop.DBus', '/org/freedesktop/DBus'
    )
    
    # System bus
    dbus.system_bus_available = _check_dbus_service(
        'system', 'org.freedesktop.DBus', '/org/freedesktop/DBus'
    )
    
    # GNOME Shell
    dbus.gnome_shell = _check_dbus_service(
        'session', 'org.gnome.Shell', '/org/gnome/Shell'
    )
    
    # GNOME Shell Introspect (GNOME 40+)
    dbus.gnome_shell_introspect = _check_dbus_service(
        'session', 'org.gnome.Shell',
        '/org/gnome/Shell/Introspect',
        'org.gnome.Shell.Introspect'
    )
    
    # GNOME Mutter IdleMonitor
    dbus.gnome_mutter_idle_monitor = _check_dbus_service(
        'session', 'org.gnome.Mutter.IdleMonitor',
        '/org/gnome/Mutter/IdleMonitor/Core',
        'org.gnome.Mutter.IdleMonitor'
    )
    
    # FreeDesktop ScreenSaver
    dbus.freedesktop_screensaver = _check_dbus_service(
        'session', 'org.freedesktop.ScreenSaver',
        '/org/freedesktop/ScreenSaver',
        'org.freedesktop.ScreenSaver'
    )
    
    # XDG Desktop Portal
    dbus.freedesktop_portal_desktop = _check_dbus_service(
        'session', 'org.freedesktop.portal.Desktop',
        '/org/freedesktop/portal/desktop'
    )
    
    if dbus.freedesktop_portal_desktop:
        # Check specific portal interfaces
        rc, stdout, _ = _run_cmd([
            'gdbus', 'introspect', '--session',
            '--dest', 'org.freedesktop.portal.Desktop',
            '--object-path', '/org/freedesktop/portal/desktop'
        ])
        if rc == 0:
            dbus.freedesktop_portal_screencast = 'org.freedesktop.portal.ScreenCast' in stdout
            dbus.freedesktop_portal_screenshot = 'org.freedesktop.portal.Screenshot' in stdout
    
    # AT-SPI2 Accessibility Bus
    dbus.atspi_bus = _check_dbus_service(
        'session', 'org.a11y.Bus', '/org/a11y/bus'
    )
    
    return dbus


def collect_capabilities() -> SystemCapabilities:
    """Check system capabilities and available tools."""
    caps = SystemCapabilities()
    
    # Screenshot tools
    caps.gnome_screenshot_available = (_run_cmd(['which', 'gnome-screenshot'])[0] == 0)
    caps.scrot_available = (_run_cmd(['which', 'scrot'])[0] == 0)
    caps.grim_available = (_run_cmd(['which', 'grim'])[0] == 0)
    
    # Window detection tools
    caps.xdotool_available = (_run_cmd(['which', 'xdotool'])[0] == 0)
    caps.gdbus_available = (_run_cmd(['which', 'gdbus'])[0] == 0)
    
    # Python GI (GObject Introspection)
    try:
        import gi
        caps.python_gi_available = True
        try:
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi
            caps.atspi_available = True
        except (ValueError, ImportError):
            pass
    except ImportError:
        pass
    
    # GStreamer
    caps.gstreamer_available = (_run_cmd(['which', 'gst-launch-1.0'])[0] == 0)
    if caps.gstreamer_available:
        caps.gst_pipewiresrc_available = (_run_cmd(['gst-inspect-1.0', 'pipewiresrc'])[0] == 0)
    
    # PipeWire
    rc, stdout, _ = _run_cmd(['pgrep', '-x', 'pipewire'])
    caps.pipewire_running = (rc == 0 and bool(stdout.strip()))
    
    rc, stdout, _ = _run_cmd(['pgrep', '-x', 'wireplumber'])
    caps.wireplumber_running = (rc == 0 and bool(stdout.strip()))
    
    # AppIndicator
    try:
        import gi
        gi.require_version('AppIndicator3', '0.1')
        caps.appindicator_available = True
    except (ImportError, ValueError):
        try:
            import gi
            gi.require_version('AyatanaAppIndicator3', '0.1')
            caps.appindicator_available = True
        except (ImportError, ValueError):
            pass
    
    return caps


def assess_window_detection(desktop: DesktopEnvironment, 
                           dbus: DBusServices,
                           caps: SystemCapabilities) -> Tuple[CompatibilityLevel, List[str]]:
    """Assess window detection compatibility."""
    warnings = []
    
    if not desktop.is_wayland:
        # X11 session - xdotool should work
        if caps.xdotool_available:
            return CompatibilityLevel.FULL, warnings
        warnings.append("xdotool not installed - window detection may be limited on X11")
        return CompatibilityLevel.PARTIAL, warnings
    
    # Wayland session
    methods_available = 0
    
    # Method 1: GNOME Shell Introspect (best for GNOME 40+)
    if dbus.gnome_shell_introspect:
        methods_available += 1
    else:
        warnings.append("GNOME Shell Introspect API not available")
    
    # Method 2: AT-SPI2
    if dbus.atspi_bus and caps.atspi_available:
        methods_available += 1
    elif dbus.atspi_bus:
        warnings.append("AT-SPI2 D-Bus available but python3-gi-atspi not installed")
    else:
        warnings.append("AT-SPI2 accessibility bus not running")
    
    # Method 3: Shell.Eval (disabled in GNOME 45+)
    if desktop.name == 'GNOME' and desktop.version_major >= 45:
        warnings.append(f"GNOME {desktop.version_major}: Shell.Eval disabled by default (security)")
    elif dbus.gnome_shell:
        methods_available += 1
    
    # Method 4: xdotool (XWayland only)
    if caps.xdotool_available and desktop.is_xwayland_available:
        methods_available += 1
        warnings.append("xdotool only detects XWayland apps, not native Wayland apps")
    
    if methods_available >= 2:
        return CompatibilityLevel.FULL, warnings
    elif methods_available >= 1:
        return CompatibilityLevel.PARTIAL, warnings
    else:
        return CompatibilityLevel.LIMITED, warnings


def assess_idle_detection(desktop: DesktopEnvironment,
                          dbus: DBusServices) -> Tuple[CompatibilityLevel, List[str]]:
    """Assess idle detection compatibility."""
    warnings = []
    
    # Tier 1: FreeDesktop ScreenSaver
    if dbus.freedesktop_screensaver:
        return CompatibilityLevel.FULL, warnings
    
    # Tier 2: GNOME Mutter IdleMonitor
    if dbus.gnome_mutter_idle_monitor:
        return CompatibilityLevel.FULL, warnings
    
    # Tier 3: pynput (requires X11/XWayland)
    if not desktop.is_wayland:
        return CompatibilityLevel.FULL, warnings  # pynput works on X11
    
    if desktop.is_xwayland_available:
        warnings.append("Idle detection using pynput via XWayland (may be unreliable)")
        return CompatibilityLevel.PARTIAL, warnings
    
    warnings.append("No reliable idle detection backend available on pure Wayland")
    return CompatibilityLevel.LIMITED, warnings


def assess_screenshot(desktop: DesktopEnvironment,
                      dbus: DBusServices,
                      caps: SystemCapabilities) -> Tuple[CompatibilityLevel, List[str]]:
    """Assess screenshot capture compatibility."""
    warnings = []
    
    if not desktop.is_wayland:
        # X11 - most methods work
        return CompatibilityLevel.FULL, warnings
    
    # Wayland - need ScreenCast portal with PipeWire
    if dbus.freedesktop_portal_screencast:
        if caps.gst_pipewiresrc_available and caps.pipewire_running:
            return CompatibilityLevel.FULL, warnings
        if not caps.gst_pipewiresrc_available:
            warnings.append("gstreamer1.0-pipewire not installed - ScreenCast unavailable")
        if not caps.pipewire_running:
            warnings.append("PipeWire not running")
        return CompatibilityLevel.PARTIAL, warnings
    
    # Fallback to Screenshot portal (shows dialog each time)
    if dbus.freedesktop_portal_screenshot:
        warnings.append("Using Screenshot Portal - permission dialog required each time")
        return CompatibilityLevel.PARTIAL, warnings
    
    warnings.append("No Wayland screenshot method available")
    return CompatibilityLevel.LIMITED, warnings


def collect_os_diagnostics() -> CompatibilityReport:
    """
    Collect comprehensive OS diagnostics and assess compatibility.
    
    Returns:
        CompatibilityReport with all collected information and assessments.
    """
    report = CompatibilityReport()
    
    # Collect information
    report.os_info = collect_os_info()
    report.desktop = collect_desktop_environment()
    report.dbus = collect_dbus_services()
    report.capabilities = collect_capabilities()
    
    # Assess compatibility
    report.window_detection_level, win_warnings = assess_window_detection(
        report.desktop, report.dbus, report.capabilities
    )
    report.warnings.extend(win_warnings)
    
    report.idle_detection_level, idle_warnings = assess_idle_detection(
        report.desktop, report.dbus
    )
    report.warnings.extend(idle_warnings)
    
    report.screenshot_level, screenshot_warnings = assess_screenshot(
        report.desktop, report.dbus, report.capabilities
    )
    report.warnings.extend(screenshot_warnings)
    
    # Overall assessment
    levels = [
        report.window_detection_level,
        report.idle_detection_level,
        report.screenshot_level
    ]
    if all(l == CompatibilityLevel.FULL for l in levels):
        report.overall_level = CompatibilityLevel.FULL
    elif any(l == CompatibilityLevel.LIMITED for l in levels):
        report.overall_level = CompatibilityLevel.LIMITED
    elif any(l == CompatibilityLevel.PARTIAL for l in levels):
        report.overall_level = CompatibilityLevel.PARTIAL
    else:
        report.overall_level = CompatibilityLevel.UNKNOWN
    
    # Generate recommendations
    if not report.dbus.gnome_shell_introspect and report.desktop.name == 'GNOME':
        report.recommendations.append(
            "Install GNOME Shell extension 'Window List' or ensure Shell Introspect is enabled"
        )
    
    if not report.capabilities.gst_pipewiresrc_available:
        report.recommendations.append(
            "Install gstreamer1.0-pipewire for Wayland screenshot support"
        )
    
    if report.desktop.name == 'GNOME' and report.desktop.version_major >= 45:
        if not report.dbus.gnome_shell_introspect:
            report.recommendations.append(
                "GNOME 45+: Consider enabling Development Tools in Settings for Shell.Eval access"
            )
    
    # Identify blockers
    if report.overall_level == CompatibilityLevel.LIMITED:
        if report.window_detection_level == CompatibilityLevel.LIMITED:
            report.blockers.append("Window detection: No working method available")
        if report.screenshot_level == CompatibilityLevel.LIMITED:
            report.blockers.append("Screenshot: No Wayland capture method available")
    
    return report


def log_os_diagnostics(report: CompatibilityReport, logger: logging.Logger) -> None:
    """
    Log OS diagnostics to the provided logger.
    
    Logs at INFO level for normal operation, WARNING for compatibility issues.
    """
    # Banner
    logger.info("=" * 70)
    logger.info("TIMETRACKER OS DIAGNOSTICS REPORT")
    logger.info("=" * 70)
    
    # OS Info
    logger.info(f"OS: {report.os_info.distro_name} {report.os_info.distro_version} "
                f"({report.os_info.distro_codename})")
    logger.info(f"Distro ID: {report.os_info.distro_id} "
                f"(like: {report.os_info.distro_id_like or 'N/A'})")
    logger.info(f"Kernel: {report.os_info.kernel_version}")
    
    # Desktop Environment
    logger.info("-" * 70)
    logger.info(f"Desktop: {report.desktop.name} {report.desktop.version}")
    logger.info(f"Session Type: {report.desktop.session_type}")
    logger.info(f"Wayland: {report.desktop.is_wayland} "
                f"(WAYLAND_DISPLAY='{report.desktop.wayland_display}')")
    logger.info(f"XWayland Available: {report.desktop.is_xwayland_available}")
    logger.info(f"X Display: {report.desktop.x_display}")
    
    # D-Bus Services
    logger.info("-" * 70)
    logger.info("D-Bus Services:")
    logger.info(f"  Session Bus: {report.dbus.session_bus_available}")
    logger.info(f"  GNOME Shell: {report.dbus.gnome_shell}")
    logger.info(f"  GNOME Shell Introspect: {report.dbus.gnome_shell_introspect}")
    logger.info(f"  GNOME Mutter IdleMonitor: {report.dbus.gnome_mutter_idle_monitor}")
    logger.info(f"  FreeDesktop ScreenSaver: {report.dbus.freedesktop_screensaver}")
    logger.info(f"  Portal Desktop: {report.dbus.freedesktop_portal_desktop}")
    logger.info(f"  Portal ScreenCast: {report.dbus.freedesktop_portal_screencast}")
    logger.info(f"  Portal Screenshot: {report.dbus.freedesktop_portal_screenshot}")
    logger.info(f"  AT-SPI2 Bus: {report.dbus.atspi_bus}")
    
    # Capabilities
    logger.info("-" * 70)
    logger.info("System Capabilities:")
    logger.info(f"  gdbus: {report.capabilities.gdbus_available}")
    logger.info(f"  xdotool: {report.capabilities.xdotool_available}")
    logger.info(f"  python-gi: {report.capabilities.python_gi_available}")
    logger.info(f"  atspi: {report.capabilities.atspi_available}")
    logger.info(f"  gnome-screenshot: {report.capabilities.gnome_screenshot_available}")
    logger.info(f"  scrot: {report.capabilities.scrot_available}")
    logger.info(f"  GStreamer: {report.capabilities.gstreamer_available}")
    logger.info(f"  GStreamer pipewiresrc: {report.capabilities.gst_pipewiresrc_available}")
    logger.info(f"  PipeWire running: {report.capabilities.pipewire_running}")
    logger.info(f"  WirePlumber running: {report.capabilities.wireplumber_running}")
    logger.info(f"  AppIndicator: {report.capabilities.appindicator_available}")
    
    # Compatibility Assessment
    logger.info("-" * 70)
    logger.info("COMPATIBILITY ASSESSMENT:")
    logger.info(f"  Window Detection: {report.window_detection_level.value.upper()}")
    logger.info(f"  Idle Detection: {report.idle_detection_level.value.upper()}")
    logger.info(f"  Screenshot Capture: {report.screenshot_level.value.upper()}")
    logger.info(f"  Overall: {report.overall_level.value.upper()}")
    
    # Warnings
    if report.warnings:
        logger.info("-" * 70)
        logger.warning("COMPATIBILITY WARNINGS:")
        for warning in report.warnings:
            logger.warning(f"  ⚠ {warning}")
    
    # Recommendations
    if report.recommendations:
        logger.info("-" * 70)
        logger.info("RECOMMENDATIONS:")
        for rec in report.recommendations:
            logger.info(f"  → {rec}")
    
    # Blockers
    if report.blockers:
        logger.info("-" * 70)
        logger.error("BLOCKERS (features will not work):")
        for blocker in report.blockers:
            logger.error(f"  ✗ {blocker}")
    
    logger.info("=" * 70)


def get_diagnostics_summary(report: CompatibilityReport) -> Dict[str, Any]:
    """
    Get diagnostics as a dictionary for JSON serialization (e.g., for server upload).
    """
    return {
        'timestamp': __import__('datetime').datetime.now().isoformat(),
        'os': {
            'distro_id': report.os_info.distro_id,
            'distro_name': report.os_info.distro_name,
            'distro_version': report.os_info.distro_version,
            'kernel': report.os_info.kernel_version,
        },
        'desktop': {
            'name': report.desktop.name,
            'version': report.desktop.version,
            'is_wayland': report.desktop.is_wayland,
            'is_xwayland': report.desktop.is_xwayland_available,
        },
        'dbus': {
            'gnome_shell': report.dbus.gnome_shell,
            'gnome_introspect': report.dbus.gnome_shell_introspect,
            'mutter_idle': report.dbus.gnome_mutter_idle_monitor,
            'screensaver': report.dbus.freedesktop_screensaver,
            'portal_screencast': report.dbus.freedesktop_portal_screencast,
            'atspi': report.dbus.atspi_bus,
        },
        'capabilities': {
            'xdotool': report.capabilities.xdotool_available,
            'gst_pipewiresrc': report.capabilities.gst_pipewiresrc_available,
            'pipewire': report.capabilities.pipewire_running,
        },
        'compatibility': {
            'window_detection': report.window_detection_level.value,
            'idle_detection': report.idle_detection_level.value,
            'screenshot': report.screenshot_level.value,
            'overall': report.overall_level.value,
        },
        'warnings': report.warnings,
        'blockers': report.blockers,
    }
```

### 1.2 Integration into desktop_app.py

Add the following to `TimeTracker.__init__()`:

```python
# In TimeTracker.__init__() after logger initialization:

from os_diagnostics import collect_os_diagnostics, log_os_diagnostics, get_diagnostics_summary

# Collect and log OS diagnostics
self.os_diagnostics = collect_os_diagnostics()
log_os_diagnostics(self.os_diagnostics, self.logger)

# Store for later use (e.g., sending to server)
self._os_diagnostics_summary = get_diagnostics_summary(self.os_diagnostics)

# Log overall compatibility status
if self.os_diagnostics.overall_level.value == 'limited':
    self.logger.error("[COMPAT] System has LIMITED compatibility - some features WILL NOT work")
    print("[ERROR] TimeTracker has limited compatibility with this system. Check logs for details.")
elif self.os_diagnostics.overall_level.value == 'partial':
    self.logger.warning("[COMPAT] System has PARTIAL compatibility - some features may not work reliably")
    print("[WARN] TimeTracker has partial compatibility with this system. Check logs for details.")
```

---

## Phase 2: Window Detection Improvements

### Goal
Improve window detection to work reliably on GNOME 45+ and other Wayland compositors.

### 2.1 GNOME 49-Specific Fixes

The `gnome_introspect` method is the primary method for GNOME 40+ but may have issues on GNOME 49 due to:
1. Timing changes in D-Bus responses
2. Changed permission model
3. Different output format

**Proposed Changes:**

```python
def _from_gnome_introspect_v2():
    """Enhanced GNOME Shell Introspect API for GNOME 45+.
    
    Changes from v1:
    - Increased timeout (5s → 10s) for slower D-Bus on GNOME 49
    - Better error handling for permission denied scenarios
    - Handles changed output format in GNOME 49
    - Falls back to simpler parsing if regex fails
    """
    try:
        _log_debug("gnome_introspect_v2: Starting (GNOME 45+ optimized)...")
        
        # Step 1: Verify interface with explicit timeout
        check_result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell/Introspect'],
            capture_output=True, text=True, timeout=5
        )
        
        if check_result.returncode != 0:
            stderr = check_result.stderr.strip()[:200]
            # Check for permission errors (GNOME 49 security)
            if 'permission' in stderr.lower() or 'access' in stderr.lower():
                _log_warning("gnome_introspect: Permission denied - may need GNOME Development Tools enabled")
            _log_debug(f"gnome_introspect: Interface check failed: {stderr}")
            return None
        
        if 'GetWindows' not in check_result.stdout:
            _log_debug("gnome_introspect: GetWindows method not found")
            return None
        
        # Step 2: Call GetWindows with increased timeout
        _log_debug("gnome_introspect_v2: Calling GetWindows (10s timeout)...")
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect',
                '--method', 'org.gnome.Shell.Introspect.GetWindows',
            ],
            capture_output=True, text=True, timeout=10  # Increased from 5s
        )
        
        if result.returncode != 0:
            stderr = result.stderr.strip()[:200]
            _log_debug(f"gnome_introspect_v2: GetWindows failed: {stderr}")
            
            # Special handling for GNOME 49 specific errors
            if 'timeout' in stderr.lower():
                _log_warning("gnome_introspect: D-Bus timeout - GNOME Shell may be busy")
            elif 'not allowed' in stderr.lower():
                _log_warning("gnome_introspect: Not allowed - Shell Introspect may be disabled")
            return None
        
        stdout = result.stdout
        if not stdout:
            _log_debug("gnome_introspect_v2: Empty response")
            return None
        
        _log_debug(f"gnome_introspect_v2: Got {len(stdout)} bytes response")
        
        # Step 3: Parse response (with GNOME 49 compatibility)
        import re as _re
        
        # Try multiple parsing strategies
        focused_window = None
        
        # Strategy 1: Standard regex (works for most versions)
        for title_m in _re.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
            title = title_m.group(1)
            ahead_start = title_m.end()
            lookahead = stdout[ahead_start:ahead_start + 800]  # Increased lookahead
            
            hf_m = _re.search(r"'has-focus':\s*<\s*(true|false)\s*>", lookahead)
            if hf_m and hf_m.group(1) == 'true':
                block = stdout[title_m.start():ahead_start + 800]
                
                # Try app-id
                app_m = _re.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                app_id = (app_m.group(1) if app_m else '') or ''
                
                # Try wm-class
                if not app_id:
                    wm_m = _re.search(r"'wm-class':\s*<\s*'([^']*)'\s*>", block)
                    app_id = (wm_m.group(1) if wm_m else '') or 'Unknown'
                
                if title:
                    _log_debug(f"gnome_introspect_v2: SUCCESS - title='{title}', app='{app_id}'")
                    return title, app_id or 'Unknown'
        
        # Strategy 2: Alternative format (GNOME 49 may use different quoting)
        for title_m in _re.finditer(r'"title":\s*<\s*"([^"]*)"\s*>', stdout):
            title = title_m.group(1)
            ahead_start = title_m.end()
            lookahead = stdout[ahead_start:ahead_start + 800]
            
            hf_m = _re.search(r'"has-focus":\s*<\s*(true|false)\s*>', lookahead)
            if hf_m and hf_m.group(1) == 'true':
                _log_debug(f"gnome_introspect_v2: Found via alt format: '{title}'")
                return title, 'Unknown'
        
        _log_debug("gnome_introspect_v2: No focused window found in response")
        return None
        
    except subprocess.TimeoutExpired:
        _log_warning("gnome_introspect_v2: Timeout (10s) - GNOME Shell unresponsive")
        return None
    except FileNotFoundError:
        _log_debug("gnome_introspect_v2: gdbus not installed")
        return None
    except Exception as e:
        _log_debug(f"gnome_introspect_v2: {type(e).__name__}: {e}")
        return None
```

### 2.2 AT-SPI2 Improvements for GNOME 49

```python
def _from_atspi_v2():
    """Enhanced AT-SPI2 for GNOME 49 compatibility.
    
    Changes:
    - Handles GNOME 49 accessibility changes
    - Better focused window detection
    - Improved error messages
    """
    _log_debug("atspi_v2: Starting enhanced AT-SPI2 query...")
    
    # Pre-check: Verify AT-SPI2 registry is accessible
    try:
        atspi_check = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.a11y.Bus',
             '--object-path', '/org/a11y/bus',
             '--method', 'org.a11y.Bus.GetAddress'],
            capture_output=True, text=True, timeout=3
        )
        if atspi_check.returncode != 0:
            _log_debug("atspi_v2: AT-SPI2 bus not accessible")
            return None
    except Exception as e:
        _log_debug(f"atspi_v2: Bus check failed: {e}")
        return None
    
    # Use external Python to avoid AppImage bundling issues
    code = '''
import gi
import sys
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

Atspi.init()
desktop = Atspi.get_desktop(0)
ACTIVE = Atspi.StateType.ACTIVE
FOCUSED = Atspi.StateType.FOCUSED
SHOWING = Atspi.StateType.SHOWING

# Skip these system processes
SKIP = {
    'gnome-shell', 'gnome-software', 'ibus-daemon', 'ibus-x11',
    'gsd-color', 'gsd-keyboard', 'gsd-wacom', 'gsd-power',
    'gsd-media-keys', 'gsd-xsettings', 'ibus-extension-gtk3',
    'xdg-desktop-portal-gtk', 'xdg-desktop-portal-gnome',
    'update-notifier', 'gjs', 'evolution-alarm-notify',
    'gnome-panel', 'goa-daemon', 'tracker-miner-fs-3'
}

best = None
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if not app:
        continue
    app_name = app.get_name() or ''
    if app_name in SKIP:
        continue
    
    for j in range(app.get_child_count()):
        win = app.get_child_at_index(j)
        if not win:
            continue
        try:
            ss = win.get_state_set()
            if not ss:
                continue
            title = win.get_name() or ''
            if not title:
                continue
            
            # GNOME 49: Check SHOWING state as well (some apps use it)
            is_focused = ss.contains(FOCUSED)
            is_active = ss.contains(ACTIVE)
            is_showing = ss.contains(SHOWING)
            
            # Priority: FOCUSED > ACTIVE+SHOWING > ACTIVE
            if is_focused:
                print(f"{title}|||{app_name or 'Unknown'}")
                sys.exit(0)
            elif is_active and is_showing and not best:
                best = (title, app_name)
            elif is_active and not best:
                best = (title, app_name)
        except:
            pass

if best:
    print(f"{best[0]}|||{best[1] or 'Unknown'}")
'''
    
    try:
        result = subprocess.run(
            ['/usr/bin/python3', '-c', code],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and '|||' in result.stdout:
            parts = result.stdout.strip().split('|||', 1)
            title = parts[0].strip()
            app = parts[1].strip() if len(parts) > 1 else 'Unknown'
            if title:
                _log_debug(f"atspi_v2: SUCCESS - title='{title}', app='{app}'")
                return title, app
        elif result.stderr:
            _log_debug(f"atspi_v2: Python script error: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        _log_debug("atspi_v2: Timeout (5s)")
    except Exception as e:
        _log_debug(f"atspi_v2: Error: {e}")
    
    return None
```

### 2.3 Add Version-Specific Method Selection

```python
def _get_window_detection_methods(self, desktop_env: str, version_major: int, is_wayland: bool):
    """Get ordered list of window detection methods based on OS/DE version.
    
    Returns list of (method_name, method_function) tuples in priority order.
    """
    if not is_wayland:
        # X11: xdotool is most reliable
        return [
            ('xdotool', self._from_xdotool),
            ('gdbus', self._from_gdbus),
            ('gnome_introspect', self._from_gnome_introspect),
            ('atspi', self._from_atspi),
        ]
    
    if desktop_env == 'GNOME':
        if version_major >= 49:
            # GNOME 49+: Shell.Eval disabled, Introspect may have issues
            return [
                ('atspi_v2', self._from_atspi_v2),          # Often most reliable on 49
                ('gnome_introspect_v2', self._from_gnome_introspect_v2),
                ('xdotool', self._from_xdotool),            # XWayland fallback
            ]
        elif version_major >= 45:
            # GNOME 45-48: Shell.Eval disabled by default
            return [
                ('gnome_introspect', self._from_gnome_introspect),
                ('atspi', self._from_atspi),
                ('xdotool', self._from_xdotool),
            ]
        else:
            # GNOME 40-44: Shell.Eval works
            return [
                ('gnome_introspect', self._from_gnome_introspect),
                ('gdbus', self._from_gdbus),
                ('atspi', self._from_atspi),
                ('xdotool', self._from_xdotool),
            ]
    
    elif desktop_env == 'KDE':
        return [
            ('atspi', self._from_atspi),
            ('xdotool', self._from_xdotool),
        ]
    
    elif desktop_env in ('Sway', 'Hyprland', 'wlroots-based'):
        # wlroots compositors
        return [
            ('sway_ipc', self._from_sway_ipc),  # New method for Sway
            ('hyprland_ipc', self._from_hyprland_ipc),  # New method for Hyprland
            ('atspi', self._from_atspi),
        ]
    
    # Default Wayland
    return [
        ('gnome_introspect', self._from_gnome_introspect),
        ('atspi', self._from_atspi),
        ('xdotool', self._from_xdotool),
    ]
```

---

## Phase 3: Idle Detection Improvements

### Goal
Ensure idle detection works reliably across GNOME versions.

### 3.1 Enhanced Backend Selection

```python
def _detect_idle_backend_v2(self) -> Tuple[str, str]:
    """Enhanced idle detection backend selection with diagnostics.
    
    Returns:
        Tuple of (backend_name, diagnostic_message)
    """
    diagnostics = []
    
    # Tier 1: D-Bus ScreenSaver
    try:
        import dbus
        bus = dbus.SessionBus()
        ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
        iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
        idle_time = iface.GetSessionIdleTime()
        diagnostics.append(f"dbus_screensaver: AVAILABLE (current idle: {idle_time}ms)")
        return 'dbus_screensaver', '\n'.join(diagnostics)
    except ImportError:
        diagnostics.append("dbus_screensaver: UNAVAILABLE (python-dbus not installed)")
    except Exception as e:
        diagnostics.append(f"dbus_screensaver: UNAVAILABLE ({type(e).__name__}: {str(e)[:50]})")
    
    # Tier 2: GNOME Mutter IdleMonitor
    try:
        import dbus
        bus = dbus.SessionBus()
        obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                             '/org/gnome/Mutter/IdleMonitor/Core')
        iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
        idle_time = iface.GetIdletime()
        diagnostics.append(f"gnome_mutter: AVAILABLE (current idle: {idle_time}ms)")
        return 'gnome_mutter', '\n'.join(diagnostics)
    except ImportError:
        diagnostics.append("gnome_mutter: UNAVAILABLE (python-dbus not installed)")
    except Exception as e:
        diagnostics.append(f"gnome_mutter: UNAVAILABLE ({type(e).__name__}: {str(e)[:50]})")
    
    # Tier 3: evdev
    import glob
    evdev_devices = glob.glob('/dev/input/event*')
    readable = [d for d in evdev_devices if os.access(d, os.R_OK)]
    if readable:
        diagnostics.append(f"evdev: AVAILABLE ({len(readable)}/{len(evdev_devices)} devices readable)")
        return 'evdev', '\n'.join(diagnostics)
    else:
        diagnostics.append(f"evdev: UNAVAILABLE (0/{len(evdev_devices)} devices readable - need 'input' group)")
    
    # Tier 4: pynput
    is_wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
    try:
        import pynput
        if is_wayland:
            diagnostics.append("pynput: AVAILABLE (WARNING: may not work reliably on Wayland)")
        else:
            diagnostics.append("pynput: AVAILABLE")
        return 'pynput', '\n'.join(diagnostics)
    except ImportError:
        diagnostics.append("pynput: UNAVAILABLE (not installed)")
    
    diagnostics.append("RESULT: No idle detection backend available")
    return 'none', '\n'.join(diagnostics)
```

---

## Phase 4: Screenshot Capture Improvements

### Goal
Reliable screenshot capture on Wayland with proper fallbacks.

### 4.1 Enhanced ScreenCast with Better Errors

See [monitor_capture.py](python-desktop-app/monitor_capture.py) for current implementation.

Key improvements needed:
1. Better error messages when pipewiresrc is missing
2. Auto-detect and report required packages
3. Implement alternative methods for non-GNOME Wayland

---

## Phase 5: Comprehensive Test Suite

### 5.1 Test Script: `test_os_compatibility.py`

```python
#!/usr/bin/env python3
"""
TimeTracker OS Compatibility Test Suite

Tests all TimeTracker features across different Linux distributions
and desktop environment versions.

Usage:
    python tests/test_os_compatibility.py
    python tests/test_os_compatibility.py --json output.json
    python tests/test_os_compatibility.py --verbose
"""

import os
import sys
import json
import argparse
import subprocess
import time
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

# Add parent directory for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'


def colored(text: str, color: str) -> str:
    if sys.stdout.isatty():
        return f"{color}{text}{Colors.END}"
    return text


class OSCompatibilityTester:
    """Comprehensive OS compatibility test suite for TimeTracker."""
    
    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.results: Dict[str, Any] = {
            'timestamp': datetime.now().isoformat(),
            'system': {},
            'tests': [],
            'summary': {}
        }
    
    def log(self, message: str, level: str = "INFO"):
        if self.verbose or level in ("ERROR", "WARN"):
            prefix = {
                "INFO": colored("ℹ", Colors.BLUE),
                "PASS": colored("✓", Colors.GREEN),
                "FAIL": colored("✗", Colors.RED),
                "WARN": colored("⚠", Colors.YELLOW),
                "ERROR": colored("✗", Colors.RED),
            }.get(level, "")
            print(f"  {prefix} {message}")
    
    def record_test(self, name: str, passed: bool, details: str = "", 
                    category: str = "general"):
        self.results['tests'].append({
            'name': name,
            'category': category,
            'passed': passed,
            'details': details,
            'timestamp': datetime.now().isoformat()
        })
        
        status = colored("PASS", Colors.GREEN) if passed else colored("FAIL", Colors.RED)
        print(f"  [{status}] {name}")
        if details and (self.verbose or not passed):
            for line in details.split('\n'):
                print(f"         {line}")
    
    # =========================================================================
    # System Information Collection
    # =========================================================================
    
    def collect_system_info(self) -> Dict[str, Any]:
        """Collect comprehensive system information."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("COLLECTING SYSTEM INFORMATION", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        info = {}
        
        # Kernel
        try:
            result = subprocess.run(['uname', '-r'], capture_output=True, text=True)
            info['kernel'] = result.stdout.strip()
            self.log(f"Kernel: {info['kernel']}")
        except:
            info['kernel'] = 'Unknown'
        
        # OS Release
        try:
            with open('/etc/os-release') as f:
                for line in f:
                    if '=' in line:
                        key, value = line.strip().split('=', 1)
                        info[f'os_{key.lower()}'] = value.strip('"')
            self.log(f"OS: {info.get('os_name', 'Unknown')} {info.get('os_version_id', '')}")
        except:
            pass
        
        # GNOME Version
        try:
            result = subprocess.run(['gnome-shell', '--version'], 
                                    capture_output=True, text=True, timeout=3)
            if result.returncode == 0:
                import re
                match = re.search(r'(\d+)\.(\d+)', result.stdout)
                if match:
                    info['gnome_version'] = f"{match.group(1)}.{match.group(2)}"
                    info['gnome_major'] = int(match.group(1))
                    self.log(f"GNOME Shell: {info['gnome_version']}")
        except:
            pass
        
        # Display server
        info['wayland_display'] = os.environ.get('WAYLAND_DISPLAY', '')
        info['x_display'] = os.environ.get('DISPLAY', '')
        info['session_type'] = os.environ.get('XDG_SESSION_TYPE', '')
        info['is_wayland'] = bool(info['wayland_display'] or 
                                   info['session_type'].lower() == 'wayland')
        
        self.log(f"Session: {'Wayland' if info['is_wayland'] else 'X11'}")
        self.log(f"WAYLAND_DISPLAY: '{info['wayland_display']}'")
        self.log(f"DISPLAY: '{info['x_display']}'")
        
        self.results['system'] = info
        return info
    
    # =========================================================================
    # Window Detection Tests
    # =========================================================================
    
    def test_window_detection(self):
        """Test all window detection methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("WINDOW DETECTION TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        # Test 1: xdotool
        self._test_xdotool()
        
        # Test 2: gdbus Shell.Eval
        self._test_gdbus_shell_eval()
        
        # Test 3: GNOME Introspect
        self._test_gnome_introspect()
        
        # Test 4: AT-SPI2
        self._test_atspi()
    
    def _test_xdotool(self):
        """Test xdotool window detection."""
        try:
            # Check if installed
            result = subprocess.run(['which', 'xdotool'], capture_output=True)
            if result.returncode != 0:
                self.record_test("xdotool available", False, 
                                "xdotool not installed", "window_detection")
                return
            
            # Try to get active window
            result = subprocess.run(['xdotool', 'getactivewindow'],
                                    capture_output=True, text=True, timeout=3)
            if result.returncode == 0:
                wid = result.stdout.strip()
                # Get window name
                name_result = subprocess.run(['xdotool', 'getwindowname', wid],
                                             capture_output=True, text=True, timeout=3)
                title = name_result.stdout.strip() if name_result.returncode == 0 else 'Unknown'
                self.record_test("xdotool window detection", True,
                                f"Window ID: {wid}, Title: {title[:50]}",
                                "window_detection")
            else:
                self.record_test("xdotool window detection", False,
                                f"getactivewindow failed: {result.stderr.strip()[:100]}",
                                "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("xdotool window detection", False,
                            "Timeout", "window_detection")
        except Exception as e:
            self.record_test("xdotool window detection", False,
                            str(e), "window_detection")
    
    def _test_gdbus_shell_eval(self):
        """Test GNOME Shell.Eval method."""
        try:
            result = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell',
                '--method', 'org.gnome.Shell.Eval',
                "let w=global.display.focus_window;w?w.title:'none'"
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0 and 'true' in result.stdout.lower():
                self.record_test("Shell.Eval window detection", True,
                                f"Response: {result.stdout.strip()[:100]}",
                                "window_detection")
            else:
                # Check if disabled (GNOME 45+)
                if 'false' in result.stdout.lower():
                    self.record_test("Shell.Eval window detection", False,
                                    "Disabled (expected on GNOME 45+)",
                                    "window_detection")
                else:
                    self.record_test("Shell.Eval window detection", False,
                                    f"Failed: {result.stderr.strip()[:100]}",
                                    "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("Shell.Eval window detection", False,
                            "Timeout", "window_detection")
        except FileNotFoundError:
            self.record_test("Shell.Eval window detection", False,
                            "gdbus not installed", "window_detection")
        except Exception as e:
            self.record_test("Shell.Eval window detection", False,
                            str(e), "window_detection")
    
    def _test_gnome_introspect(self):
        """Test GNOME Shell Introspect API."""
        try:
            # First check if interface exists
            check = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect'
            ], capture_output=True, text=True, timeout=3)
            
            if check.returncode != 0 or 'GetWindows' not in check.stdout:
                self.record_test("GNOME Introspect API", False,
                                "Interface not available", "window_detection")
                return
            
            # Call GetWindows
            result = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Introspect',
                '--method', 'org.gnome.Shell.Introspect.GetWindows',
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0:
                window_count = result.stdout.count("'title':")
                has_focus = "'has-focus': <true>" in result.stdout
                self.record_test("GNOME Introspect API", True,
                                f"Windows: {window_count}, Has focused: {has_focus}",
                                "window_detection")
            else:
                self.record_test("GNOME Introspect API", False,
                                f"GetWindows failed: {result.stderr.strip()[:100]}",
                                "window_detection")
        except subprocess.TimeoutExpired:
            self.record_test("GNOME Introspect API", False,
                            "Timeout (10s)", "window_detection")
        except Exception as e:
            self.record_test("GNOME Introspect API", False,
                            str(e), "window_detection")
    
    def _test_atspi(self):
        """Test AT-SPI2 accessibility API."""
        try:
            # Check if AT-SPI2 bus is available
            check = subprocess.run([
                'gdbus', 'call', '--session',
                '--dest', 'org.a11y.Bus',
                '--object-path', '/org/a11y/bus',
                '--method', 'org.a11y.Bus.GetAddress'
            ], capture_output=True, text=True, timeout=3)
            
            if check.returncode != 0:
                self.record_test("AT-SPI2 D-Bus", False,
                                "Bus not running", "window_detection")
                return
            
            self.record_test("AT-SPI2 D-Bus", True,
                            "Bus available", "window_detection")
            
            # Try to query windows via python3
            code = '''
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()
d = Atspi.get_desktop(0)
count = d.get_child_count()
print(f"Apps: {count}")
for i in range(min(count, 5)):
    app = d.get_child_at_index(i)
    if app:
        print(f"  - {app.get_name()}")
'''
            result = subprocess.run(['/usr/bin/python3', '-c', code],
                                    capture_output=True, text=True, timeout=5)
            
            if result.returncode == 0:
                self.record_test("AT-SPI2 window enumeration", True,
                                result.stdout.strip()[:200], "window_detection")
            else:
                self.record_test("AT-SPI2 window enumeration", False,
                                f"Error: {result.stderr.strip()[:100]}",
                                "window_detection")
        except Exception as e:
            self.record_test("AT-SPI2 test", False, str(e), "window_detection")
    
    # =========================================================================
    # Idle Detection Tests
    # =========================================================================
    
    def test_idle_detection(self):
        """Test all idle detection methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("IDLE DETECTION TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        self._test_freedesktop_screensaver()
        self._test_gnome_mutter_idle()
        self._test_evdev()
        self._test_pynput()
    
    def _test_freedesktop_screensaver(self):
        """Test FreeDesktop ScreenSaver idle API."""
        try:
            import dbus
            bus = dbus.SessionBus()
            ss = bus.get_object('org.freedesktop.ScreenSaver', 
                               '/org/freedesktop/ScreenSaver')
            iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
            idle_time = iface.GetSessionIdleTime()
            self.record_test("FreeDesktop ScreenSaver", True,
                            f"Current idle: {idle_time}ms", "idle_detection")
        except ImportError:
            self.record_test("FreeDesktop ScreenSaver", False,
                            "python-dbus not installed", "idle_detection")
        except Exception as e:
            self.record_test("FreeDesktop ScreenSaver", False,
                            str(e)[:100], "idle_detection")
    
    def _test_gnome_mutter_idle(self):
        """Test GNOME Mutter IdleMonitor."""
        try:
            import dbus
            bus = dbus.SessionBus()
            obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                '/org/gnome/Mutter/IdleMonitor/Core')
            iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
            idle_time = iface.GetIdletime()
            self.record_test("GNOME Mutter IdleMonitor", True,
                            f"Current idle: {idle_time}ms", "idle_detection")
        except ImportError:
            self.record_test("GNOME Mutter IdleMonitor", False,
                            "python-dbus not installed", "idle_detection")
        except Exception as e:
            self.record_test("GNOME Mutter IdleMonitor", False,
                            str(e)[:100], "idle_detection")
    
    def _test_evdev(self):
        """Test evdev input device access."""
        import glob
        devices = glob.glob('/dev/input/event*')
        readable = [d for d in devices if os.access(d, os.R_OK)]
        
        if readable:
            self.record_test("evdev access", True,
                            f"{len(readable)}/{len(devices)} devices readable",
                            "idle_detection")
        else:
            self.record_test("evdev access", False,
                            f"No devices readable (need 'input' group)",
                            "idle_detection")
    
    def _test_pynput(self):
        """Test pynput availability."""
        try:
            import pynput
            is_wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
            if is_wayland:
                self.record_test("pynput", True,
                                "Available (WARNING: unreliable on Wayland)",
                                "idle_detection")
            else:
                self.record_test("pynput", True,
                                "Available", "idle_detection")
        except ImportError:
            self.record_test("pynput", False,
                            "Not installed", "idle_detection")
    
    # =========================================================================
    # Screenshot Capture Tests
    # =========================================================================
    
    def test_screenshot_capture(self):
        """Test screenshot capture methods."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("SCREENSHOT CAPTURE TESTS", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        self._test_gstreamer_pipewiresrc()
        self._test_screencast_portal()
        self._test_screenshot_portal()
        self._test_gnome_screenshot()
        self._test_scrot()
    
    def _test_gstreamer_pipewiresrc(self):
        """Test GStreamer pipewiresrc plugin."""
        try:
            result = subprocess.run(['gst-inspect-1.0', 'pipewiresrc'],
                                    capture_output=True, timeout=3)
            if result.returncode == 0:
                self.record_test("GStreamer pipewiresrc", True,
                                "Plugin available", "screenshot")
            else:
                self.record_test("GStreamer pipewiresrc", False,
                                "Plugin not installed (needed for Wayland)",
                                "screenshot")
        except FileNotFoundError:
            self.record_test("GStreamer pipewiresrc", False,
                            "gst-inspect-1.0 not found", "screenshot")
        except Exception as e:
            self.record_test("GStreamer pipewiresrc", False, str(e), "screenshot")
    
    def _test_screencast_portal(self):
        """Test ScreenCast Portal availability."""
        try:
            result = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop'
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0:
                has_screencast = 'org.freedesktop.portal.ScreenCast' in result.stdout
                self.record_test("ScreenCast Portal", has_screencast,
                                "Available" if has_screencast else "Interface not found",
                                "screenshot")
            else:
                self.record_test("ScreenCast Portal", False,
                                "Portal daemon not running", "screenshot")
        except Exception as e:
            self.record_test("ScreenCast Portal", False, str(e), "screenshot")
    
    def _test_screenshot_portal(self):
        """Test Screenshot Portal availability."""
        try:
            result = subprocess.run([
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop'
            ], capture_output=True, text=True, timeout=3)
            
            if result.returncode == 0:
                has_screenshot = 'org.freedesktop.portal.Screenshot' in result.stdout
                self.record_test("Screenshot Portal", has_screenshot,
                                "Available" if has_screenshot else "Interface not found",
                                "screenshot")
            else:
                self.record_test("Screenshot Portal", False,
                                "Portal daemon not running", "screenshot")
        except Exception as e:
            self.record_test("Screenshot Portal", False, str(e), "screenshot")
    
    def _test_gnome_screenshot(self):
        """Test gnome-screenshot tool."""
        try:
            result = subprocess.run(['which', 'gnome-screenshot'], capture_output=True)
            self.record_test("gnome-screenshot", result.returncode == 0,
                            "Available" if result.returncode == 0 else "Not installed",
                            "screenshot")
        except Exception as e:
            self.record_test("gnome-screenshot", False, str(e), "screenshot")
    
    def _test_scrot(self):
        """Test scrot tool."""
        try:
            result = subprocess.run(['which', 'scrot'], capture_output=True)
            is_wayland = bool(os.environ.get('WAYLAND_DISPLAY'))
            if result.returncode == 0:
                msg = "Available (WARNING: X11 only)" if is_wayland else "Available"
                self.record_test("scrot", True, msg, "screenshot")
            else:
                self.record_test("scrot", False, "Not installed", "screenshot")
        except Exception as e:
            self.record_test("scrot", False, str(e), "screenshot")
    
    # =========================================================================
    # Summary
    # =========================================================================
    
    def generate_summary(self):
        """Generate test summary."""
        print(f"\n{colored('=' * 60, Colors.BOLD)}")
        print(colored("TEST SUMMARY", Colors.BOLD))
        print(colored('=' * 60, Colors.BOLD))
        
        # Count results by category
        categories = {}
        for test in self.results['tests']:
            cat = test['category']
            if cat not in categories:
                categories[cat] = {'passed': 0, 'failed': 0}
            if test['passed']:
                categories[cat]['passed'] += 1
            else:
                categories[cat]['failed'] += 1
        
        total_passed = sum(c['passed'] for c in categories.values())
        total_failed = sum(c['failed'] for c in categories.values())
        total = total_passed + total_failed
        
        print(f"\n  Total: {total_passed}/{total} tests passed\n")
        
        for cat, counts in categories.items():
            cat_total = counts['passed'] + counts['failed']
            status = colored("✓", Colors.GREEN) if counts['failed'] == 0 else colored("✗", Colors.RED)
            print(f"  {status} {cat}: {counts['passed']}/{cat_total}")
        
        self.results['summary'] = {
            'total_tests': total,
            'passed': total_passed,
            'failed': total_failed,
            'categories': categories
        }
        
        # Overall assessment
        sys_info = self.results['system']
        print(f"\n{colored('-' * 60, Colors.BOLD)}")
        
        if total_failed == 0:
            print(colored("  ✓ FULL COMPATIBILITY", Colors.GREEN))
            print("    All features should work correctly.")
        elif total_failed <= 2:
            print(colored("  ⚠ PARTIAL COMPATIBILITY", Colors.YELLOW))
            print("    Most features will work, some may have issues.")
        else:
            print(colored("  ✗ LIMITED COMPATIBILITY", Colors.RED))
            print("    Several features may not work correctly.")
            print("\n  Recommendations:")
            
            # Generate specific recommendations
            if sys_info.get('gnome_major', 0) >= 45:
                print("    - GNOME 45+: Shell.Eval is disabled by default")
                print("      Consider enabling Development Tools in Settings")
            
            # Check for missing packages
            for test in self.results['tests']:
                if not test['passed'] and 'not installed' in test['details'].lower():
                    print(f"    - Install missing package for: {test['name']}")
    
    def run_all_tests(self) -> Dict[str, Any]:
        """Run all compatibility tests."""
        print(colored("\n╔════════════════════════════════════════════════════════════╗", Colors.CYAN))
        print(colored("║     TIMETRACKER OS COMPATIBILITY TEST SUITE                ║", Colors.CYAN))
        print(colored("╚════════════════════════════════════════════════════════════╝", Colors.CYAN))
        
        self.collect_system_info()
        self.test_window_detection()
        self.test_idle_detection()
        self.test_screenshot_capture()
        self.generate_summary()
        
        return self.results


def main():
    parser = argparse.ArgumentParser(
        description='TimeTracker OS Compatibility Test Suite'
    )
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Show detailed output')
    parser.add_argument('--json', '-j', metavar='FILE',
                        help='Save results to JSON file')
    
    args = parser.parse_args()
    
    tester = OSCompatibilityTester(verbose=args.verbose)
    results = tester.run_all_tests()
    
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\n  Results saved to: {args.json}")
    
    # Exit code based on results
    if results['summary']['failed'] == 0:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == '__main__':
    main()
```

---

## Phase 6: Runtime Compatibility Checks

### 6.1 Add Startup Warnings

When TimeTracker starts and detects compatibility issues, show clear warnings:

```python
def _check_and_warn_compatibility(self):
    """Check OS compatibility and warn user if issues detected."""
    from os_diagnostics import collect_os_diagnostics
    
    report = collect_os_diagnostics()
    
    warnings = []
    
    # Window detection warning
    if report.window_detection_level.value == 'limited':
        warnings.append(
            "Window title detection may not work on this system. "
            f"Running {report.desktop.name} {report.desktop.version} which has "
            "security restrictions on window access."
        )
    
    # Screenshot warning
    if report.screenshot_level.value in ('limited', 'partial'):
        if not report.capabilities.gst_pipewiresrc_available:
            warnings.append(
                "Screenshot capture requires gstreamer1.0-pipewire. "
                "Install with: sudo apt install gstreamer1.0-pipewire"
            )
    
    # Idle detection warning
    if report.idle_detection_level.value == 'limited':
        warnings.append(
            "Idle detection may not work reliably. "
            "Consider installing python3-dbus for better support."
        )
    
    if warnings:
        print("\n" + "=" * 60)
        print("TIMETRACKER COMPATIBILITY WARNINGS")
        print("=" * 60)
        for warning in warnings:
            print(f"⚠ {warning}")
        print("=" * 60 + "\n")
```

---

## Implementation Timeline

| Phase | Description | Estimated Time | Priority |
|-------|-------------|----------------|----------|
| 1 | Enhanced OS Diagnostics Logging | 2 days | HIGH |
| 2 | Window Detection Improvements | 3 days | HIGH |
| 3 | Idle Detection Improvements | 1 day | MEDIUM |
| 4 | Screenshot Capture Improvements | 2 days | MEDIUM |
| 5 | Comprehensive Test Suite | 2 days | HIGH |
| 6 | Runtime Compatibility Checks | 1 day | MEDIUM |

**Total Estimated Time: 11 days (2-3 weeks with testing)**

---

## Files to Create/Modify

### New Files
1. `python-desktop-app/os_diagnostics.py` - OS diagnostics module
2. `python-desktop-app/tests/test_os_compatibility.py` - Compatibility test suite

### Files to Modify
1. `python-desktop-app/desktop_app.py`:
   - Import and call OS diagnostics at startup
   - Add v2 versions of window detection methods
   - Add version-specific method selection
   - Add enhanced idle backend detection

2. `python-desktop-app/system_check.py`:
   - Integrate with os_diagnostics module
   - Add more detailed package recommendations

3. `python-desktop-app/monitor_capture.py`:
   - Better error messages for missing dependencies
   - Support for non-GNOME Wayland compositors

---

## Success Criteria

1. **Logging**: OS compatibility issues identifiable from logs without user intervention
2. **Window Detection**: Works on GNOME 46, 47, 48, 49 and KDE Plasma
3. **Idle Detection**: Falls back gracefully with clear warnings
4. **Screenshot**: Clear error messages when dependencies missing
5. **Tests**: Automated test suite passes on Ubuntu 24.04 LTS and Ubuntu 25.04

---

## Appendix: Quick Reference Commands

### Check GNOME Version
```bash
gnome-shell --version
```

### Check Available D-Bus Services
```bash
gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Introspect
```

### Check GStreamer Plugin
```bash
gst-inspect-1.0 pipewiresrc
```

### Check PipeWire Status
```bash
systemctl --user status pipewire
```

### Enable GNOME Development Tools (for Shell.Eval)
```
Settings → Privacy & Security → Device Security → Development Tools → Enable
```
