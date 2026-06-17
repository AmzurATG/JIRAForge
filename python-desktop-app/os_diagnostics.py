#!/usr/bin/env python3
"""
OS Diagnostics Module for TimeTracker

Collects and logs comprehensive system information at startup to help
diagnose OS compatibility issues from log files alone.

Usage:
    from os_diagnostics import collect_os_diagnostics, log_os_diagnostics
    
    diagnostics = collect_os_diagnostics()
    log_os_diagnostics(diagnostics, logger)

Version: 1.0.0
Date: 2026-06-17
"""

import os
import sys
import re
import subprocess
import logging
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime


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
    
    dbus.gdbus_available = True
    
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
        from gi.repository import AppIndicator3
        caps.appindicator_available = True
    except (ImportError, ValueError):
        try:
            import gi
            gi.require_version('AyatanaAppIndicator3', '0.1')
            from gi.repository import AyatanaAppIndicator3
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
            "Install gstreamer1.0-pipewire for Wayland screenshot support: sudo apt install gstreamer1.0-pipewire"
        )
    
    if report.desktop.name == 'GNOME' and report.desktop.version_major >= 45:
        if not report.dbus.gnome_shell_introspect:
            report.recommendations.append(
                "GNOME 45+: Consider enabling Development Tools in Settings for Shell.Eval access"
            )
    
    if not report.capabilities.atspi_available and report.dbus.atspi_bus:
        report.recommendations.append(
            "Install python3-gi and gir1.2-atspi-2.0 for AT-SPI2 window detection"
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
            logger.warning(f"  [WARN] {warning}")
    
    # Recommendations
    if report.recommendations:
        logger.info("-" * 70)
        logger.info("RECOMMENDATIONS:")
        for rec in report.recommendations:
            logger.info(f"  [REC] {rec}")
    
    # Blockers
    if report.blockers:
        logger.info("-" * 70)
        logger.error("BLOCKERS (features will not work):")
        for blocker in report.blockers:
            logger.error(f"  [BLOCKER] {blocker}")
    
    logger.info("=" * 70)


def get_diagnostics_summary(report: CompatibilityReport) -> Dict[str, Any]:
    """
    Get diagnostics as a dictionary for JSON serialization (e.g., for server upload).
    """
    return {
        'timestamp': datetime.now().isoformat(),
        'os': {
            'distro_id': report.os_info.distro_id,
            'distro_name': report.os_info.distro_name,
            'distro_version': report.os_info.distro_version,
            'distro_codename': report.os_info.distro_codename,
            'kernel': report.os_info.kernel_version,
        },
        'desktop': {
            'name': report.desktop.name,
            'version': report.desktop.version,
            'version_major': report.desktop.version_major,
            'is_wayland': report.desktop.is_wayland,
            'is_xwayland': report.desktop.is_xwayland_available,
            'session_type': report.desktop.session_type,
        },
        'dbus': {
            'gnome_shell': report.dbus.gnome_shell,
            'gnome_introspect': report.dbus.gnome_shell_introspect,
            'mutter_idle': report.dbus.gnome_mutter_idle_monitor,
            'screensaver': report.dbus.freedesktop_screensaver,
            'portal_screencast': report.dbus.freedesktop_portal_screencast,
            'portal_screenshot': report.dbus.freedesktop_portal_screenshot,
            'atspi': report.dbus.atspi_bus,
        },
        'capabilities': {
            'xdotool': report.capabilities.xdotool_available,
            'gdbus': report.capabilities.gdbus_available,
            'atspi': report.capabilities.atspi_available,
            'gst_pipewiresrc': report.capabilities.gst_pipewiresrc_available,
            'pipewire': report.capabilities.pipewire_running,
            'appindicator': report.capabilities.appindicator_available,
        },
        'compatibility': {
            'window_detection': report.window_detection_level.value,
            'idle_detection': report.idle_detection_level.value,
            'screenshot': report.screenshot_level.value,
            'overall': report.overall_level.value,
        },
        'warnings': report.warnings,
        'recommendations': report.recommendations,
        'blockers': report.blockers,
    }


def print_diagnostics_summary(report: CompatibilityReport) -> None:
    """Print a brief summary to stdout for terminal users."""
    print("\n" + "=" * 60)
    print("TIMETRACKER OS COMPATIBILITY CHECK")
    print("=" * 60)
    print(f"OS: {report.os_info.distro_name} {report.os_info.distro_version}")
    print(f"Desktop: {report.desktop.name} {report.desktop.version}")
    print(f"Session: {'Wayland' if report.desktop.is_wayland else 'X11'}")
    print("-" * 60)
    print(f"Window Detection: {report.window_detection_level.value.upper()}")
    print(f"Idle Detection: {report.idle_detection_level.value.upper()}")
    print(f"Screenshot Capture: {report.screenshot_level.value.upper()}")
    print(f"Overall: {report.overall_level.value.upper()}")
    
    if report.blockers:
        print("-" * 60)
        print("BLOCKERS:")
        for blocker in report.blockers:
            print(f"  ✗ {blocker}")
    
    if report.recommendations:
        print("-" * 60)
        print("RECOMMENDATIONS:")
        for rec in report.recommendations:
            print(f"  → {rec}")
    
    print("=" * 60 + "\n")


# CLI interface for standalone testing
if __name__ == '__main__':
    import argparse
    import json
    
    parser = argparse.ArgumentParser(description='TimeTracker OS Diagnostics')
    parser.add_argument('--json', '-j', action='store_true', 
                        help='Output as JSON')
    parser.add_argument('--output', '-o', metavar='FILE',
                        help='Save output to file')
    args = parser.parse_args()
    
    report = collect_os_diagnostics()
    
    if args.json:
        summary = get_diagnostics_summary(report)
        output = json.dumps(summary, indent=2)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(output)
            print(f"Saved to {args.output}")
        else:
            print(output)
    else:
        print_diagnostics_summary(report)
        
        if args.output:
            summary = get_diagnostics_summary(report)
            with open(args.output, 'w') as f:
                json.dump(summary, f, indent=2)
            print(f"Saved JSON to {args.output}")
