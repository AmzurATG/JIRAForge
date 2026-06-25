#!/usr/bin/env python3
"""
Linux Startup Capability Router

Computes a deterministic compatibility signature and selects an optimized
runtime profile for screen capture, window title tracking, and OCR engines.
Reduces startup failures and provides structured log diagnostics.
"""

import os
import sys
import re
import time
import subprocess
import logging
from typing import Dict, Any, List, Optional
import json

from os_diagnostics import collect_os_diagnostics
from ocr.config import OCRConfig, apply_platform_filters
from ocr.facade import get_facade

logger = logging.getLogger(__name__)

# Global cached router plan
_ROUTER_PLAN: Optional[Dict[str, Any]] = None
_ROUTER_SIGNATURE: Optional[Dict[str, Any]] = None


def get_package_version(package_name: str) -> Optional[str]:
    """Retrieve version of an installed Python package."""
    try:
        mod = __import__(package_name)
        if hasattr(mod, '__version__'):
            return mod.__version__
        import importlib.metadata
        return importlib.metadata.version(package_name)
    except Exception:
        return None


def get_tesseract_version() -> Optional[str]:
    """Retrieve version of system tesseract binary if available."""
    try:
        res = subprocess.run(['tesseract', '--version'], capture_output=True, text=True, timeout=2)
        if res.returncode == 0:
            first_line = res.stdout.split('\n')[0]
            m = re.search(r'tesseract\s+(\S+)', first_line)
            if m:
                return m.group(1)
            return first_line.strip()
    except Exception:
        pass
    return None


def check_ocr_compatibility(package_versions: Dict[str, str]) -> Dict[str, Any]:
    """
    Check package versions against known compatibility constraints (Phase 3).
    """
    overrides = {}
    warnings = []
    
    ro_ver = package_versions.get('rapidocr_onnxruntime')
    ort_ver = package_versions.get('onnxruntime')
    cv2_ver = package_versions.get('cv2')
    easy_ver = package_versions.get('easyocr')
    torch_ver = package_versions.get('torch')
    
    if ro_ver and not ort_ver:
        overrides['rapidocr'] = 'disabled'
        warnings.append("rapidocr_onnxruntime is installed but onnxruntime is missing.")
        
    if ro_ver and not cv2_ver:
        overrides['rapidocr'] = 'disabled'
        warnings.append("rapidocr_onnxruntime is installed but opencv-python (cv2) is missing.")
        
    if easy_ver and not torch_ver:
        overrides['easyocr'] = 'disabled'
        warnings.append("easyocr is installed but pytorch (torch) is missing.")
        
    # Check for known bad combinations: onnxruntime >= 1.16.0 with rapidocr_onnxruntime < 1.3.0
    if ro_ver and ort_ver:
        try:
            def parse_ver(v):
                return [int(x) for x in re.sub(r'[^0-9.]', '', v).split('.')[:3] if x]
            
            ro_parts = parse_ver(ro_ver)
            ort_parts = parse_ver(ort_ver)
            
            if ort_parts >= [1, 16, 0] and ro_parts < [1, 3, 0]:
                overrides['rapidocr'] = 'disabled'
                warnings.append(
                    f"Known incompatible combination: rapidocr_onnxruntime {ro_ver} "
                    f"is incompatible with onnxruntime {ort_ver}. Disabling rapidocr."
                )
        except Exception:
            pass
            
    return {
        'engine_overrides': overrides,
        'warnings': warnings,
        'details': {
            'rapidocr_onnxruntime': ro_ver,
            'onnxruntime': ort_ver,
            'cv2': cv2_ver,
            'easyocr': easy_ver,
            'torch': torch_ver
        }
    }


def collect_capability_signature(config: Optional[OCRConfig] = None) -> Dict[str, Any]:
    """
    Collect all system, capture, window, and OCR capabilities into one startup report (Phase 1).
    """
    # 1. Gather OS diagnostics
    report = collect_os_diagnostics()
    
    # 2. Get OCR config
    if config is None:
        config = OCRConfig.from_env()
    config = apply_platform_filters(config)
    
    # 3. Instantiate facade to trigger engine detection/errors
    facade = get_facade(config)
    available_engines = facade.get_available_engines()
    
    # 4. Check package versions
    package_names = ['rapidocr_onnxruntime', 'onnxruntime', 'cv2', 'torch', 'easyocr', 'pytesseract']
    package_versions = {}
    for p in package_names:
        ver = get_package_version(p)
        if ver:
            package_versions[p] = ver
            
    # 5. Build capability signature
    sig = {
        'app': {
            'app_version': '1.0.2',
            'packaging_mode': 'AppImage' if os.environ.get('APPIMAGE') else ('frozen' if getattr(sys, 'frozen', False) else 'python'),
            'executable_path': sys.executable,
        },
        'os': {
            'distro_id': report.os_info.distro_id,
            'distro_version': report.os_info.distro_version,
            'desktop_name': report.desktop.name,
            'desktop_version': report.desktop.version,
            'desktop_version_major': report.desktop.version_major,
            'session_type': report.desktop.session_type,
            'is_wayland': report.desktop.is_wayland,
            'xwayland_present': report.desktop.is_xwayland_available,
        },
        'capture': {
            'portal_screencast': report.dbus.freedesktop_portal_screencast,
            'portal_screenshot': report.dbus.freedesktop_portal_screenshot,
            'gstreamer': report.capabilities.gstreamer_available,
            'gst_pipewiresrc': report.capabilities.gst_pipewiresrc_available,
            'pipewire_running': report.capabilities.pipewire_running,
            'wireplumber_running': report.capabilities.wireplumber_running,
        },
        'window': {
            'gnome_shell_introspect': report.dbus.gnome_shell_introspect,
            'atspi_bus': report.dbus.atspi_bus,
            'atspi_python_bindings': False,
            'xdotool_available': report.capabilities.xdotool_available,
        },
        'ocr': {
            'configured_primary_engine': config.primary_engine,
            'configured_fallback_engines': config.fallback_engines,
            'available_engines': available_engines,
            'engine_init_errors': facade._engine_init_errors,
            'package_versions': package_versions,
            'tesseract_binary_version': get_tesseract_version(),
        },
        'capabilities': {
            'gnome_screenshot_available': report.capabilities.gnome_screenshot_available,
            'scrot_available': report.capabilities.scrot_available,
        },
        'dbus': {
            'gnome_shell': report.dbus.gnome_shell,
        }
    }
    
    # Determine AT-SPI bindings
    try:
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        sig['window']['atspi_python_bindings'] = True
    except (ImportError, ValueError):
        pass
        
    return sig


def route_capabilities(sig: Dict[str, Any]) -> Dict[str, Any]:
    """
    Evaluate signature against decision matrix policy and return target execution plan (Phase 2).
    """
    is_linux = sys.platform.startswith('linux')
    
    if not is_linux:
        # Non-Linux routing: Windows / macOS standard
        if sys.platform == 'win32':
            return {
                'profile_id': 'win32_standard',
                'capture_mode': 'focused_monitor',
                'window_mode': 'win32_native',
                'ocr_mode': sig['ocr']['configured_primary_engine'] or 'winrtocr',
                'fallback_chain': sig['ocr']['configured_fallback_engines'] or ['rapidocr'],
                'preprocessing_profile': 'lightweight',
                'health_grade': 'full',
                'blocker_codes': [],
                'recommendations': []
            }
        else:
            return {
                'profile_id': 'darwin_standard',
                'capture_mode': 'darwin_native',
                'window_mode': 'darwin_native',
                'ocr_mode': sig['ocr']['configured_primary_engine'] or 'rapidocr',
                'fallback_chain': sig['ocr']['configured_fallback_engines'] or [],
                'preprocessing_profile': 'lightweight',
                'health_grade': 'full',
                'blocker_codes': [],
                'recommendations': []
            }

    # Linux Routing Policy
    capture_mode = 'disabled'
    window_mode = 'unknown_only'
    ocr_mode = 'metadata_only'
    fallback_chain = []
    preprocessing_profile = 'lightweight'
    health_grade = 'full'
    blocker_codes = []
    recommendations = []
    
    # 1. Capture Routing (Section 5.1)
    is_wayland = sig['os']['is_wayland']
    
    if is_wayland:
        if sig['capture']['portal_screencast'] and sig['capture']['gst_pipewiresrc'] and sig['capture']['pipewire_running']:
            capture_mode = 'screencast_portal'
        elif sig['capture']['portal_screenshot']:
            capture_mode = 'screenshot_portal'
            health_grade = 'partial'
            recommendations.append("Screenshot Portal used (dialog prompt risk). Install gstreamer1.0-pipewire.")
        elif sig['capabilities']['gnome_screenshot_available']:
            capture_mode = 'gnome_screenshot_cli'
            health_grade = 'partial'
            recommendations.append("gnome-screenshot CLI used (possible flash). Consider setting up ScreenCast.")
        elif sig['dbus']['gnome_shell']:
            capture_mode = 'gnome_dbus'
            health_grade = 'partial'
        else:
            capture_mode = 'disabled'
            health_grade = 'limited'
            blocker_codes.append('SC_PORTAL_UNAVAILABLE')
            recommendations.append("No Wayland screenshot method available. Please install xdg-desktop-portal.")
    else:
        # X11 capture fallback
        if sig['capabilities']['scrot_available']:
            capture_mode = 'gnome_screenshot_cli' # scrot fallback routed through cli path
        else:
            capture_mode = 'gnome_screenshot_cli'
            
    # 2. Window Title Routing (Section 5.2)
    desktop_name = sig['os']['desktop_name']
    gnome_major = sig['os']['desktop_version_major']
    
    if is_wayland:
        if desktop_name == 'GNOME' and gnome_major >= 40 and sig['window']['gnome_shell_introspect']:
            window_mode = 'gnome_introspect'
        elif sig['window']['atspi_bus'] and sig['window']['atspi_python_bindings']:
            window_mode = 'atspi'
        elif sig['window']['xdotool_available'] and sig['os']['xwayland_present']:
            window_mode = 'xdotool_xwayland'
            health_grade = 'partial'
            recommendations.append("xdotool active window tracking limited to XWayland on Wayland.")
        else:
            window_mode = 'unknown_only'
            if health_grade != 'limited':
                health_grade = 'partial'
            blocker_codes.append('WINDOW_BACKEND_UNAVAILABLE')
            recommendations.append("No active window backend available. Install python3-gi-atspi.")
    else:
        # X11 window title options
        if sig['window']['xdotool_available']:
            window_mode = 'xdotool_xwayland'
        elif sig['window']['gnome_shell_introspect']:
            window_mode = 'gnome_introspect'
        elif sig['window']['atspi_bus'] and sig['window']['atspi_python_bindings']:
            window_mode = 'atspi'
        else:
            window_mode = 'unknown_only'
            if health_grade != 'limited':
                health_grade = 'partial'
            blocker_codes.append('WINDOW_BACKEND_UNAVAILABLE')
            
    # 3. OCR Engine Routing (Section 5.3)
    primary = sig['ocr']['configured_primary_engine']
    fallbacks = sig['ocr']['configured_fallback_engines']
    
    comp_res = check_ocr_compatibility(sig['ocr']['package_versions'])
    engine_overrides = comp_res['engine_overrides']
    if comp_res['warnings']:
        recommendations.extend(comp_res['warnings'])
        
    def is_engine_healthy(eng: str) -> bool:
        if engine_overrides.get(eng) == 'disabled':
            return False
        init_err = sig['ocr']['engine_init_errors'].get(eng)
        if init_err and 'not registered' not in init_err.lower():
            return False
        return sig['ocr']['available_engines'].get(eng, False)

    routed_ocr = None
    if primary and is_engine_healthy(primary):
        routed_ocr = primary
    else:
        for fb in fallbacks:
            if is_engine_healthy(fb):
                routed_ocr = fb
                break
                
    if not routed_ocr:
        # Fall back to any engine that is healthy
        for eng, healthy in sig['ocr']['available_engines'].items():
            if healthy and engine_overrides.get(eng) != 'disabled':
                routed_ocr = eng
                break
                
    if routed_ocr:
        ocr_mode = routed_ocr
        fallback_chain = [fb for fb in fallbacks if fb != routed_ocr and is_engine_healthy(fb)]
        
        # Preprocessing profile assignment
        if ocr_mode in ('rapidocr', 'winrtocr'):
            preprocessing_profile = 'lightweight'
        elif ocr_mode == 'easyocr':
            preprocessing_profile = 'grayscale_contrast'
        elif ocr_mode == 'tesseract':
            preprocessing_profile = 'high_contrast_resize'
        else:
            preprocessing_profile = 'lightweight'
    else:
        ocr_mode = 'metadata_only'
        fallback_chain = []
        preprocessing_profile = 'none'
        if health_grade != 'limited':
            health_grade = 'partial'
        blocker_codes.append('OCR_NO_ENGINE_AVAILABLE')
        recommendations.append("No active OCR engine. Using metadata-only tracking.")

    # Profile ID construction
    if is_wayland:
        profile_id = f"linux_wayland_{capture_mode}_{window_mode}"
    else:
        profile_id = f"linux_x11_{capture_mode}_{window_mode}"
        
    return {
        'profile_id': profile_id,
        'capture_mode': capture_mode,
        'window_mode': window_mode,
        'ocr_mode': ocr_mode,
        'fallback_chain': fallback_chain,
        'preprocessing_profile': preprocessing_profile,
        'health_grade': health_grade,
        'blocker_codes': blocker_codes,
        'recommendations': recommendations
    }


def get_router_plan(config: Optional[OCRConfig] = None, force_refresh: bool = False) -> Dict[str, Any]:
    """
    Get the cached runtime routing plan or compute a new one on demand.
    """
    global _ROUTER_PLAN, _ROUTER_SIGNATURE
    if _ROUTER_PLAN is None or force_refresh:
        try:
            logger.info("Initializing Startup Capability Router...")
            _ROUTER_SIGNATURE = collect_capability_signature(config)
            _ROUTER_PLAN = route_capabilities(_ROUTER_SIGNATURE)
            
            # Emit the single "selected runtime profile" log event (Phase 1/2)
            logger.info(
                f"[CapabilityRouter] Selected Runtime Plan -> "
                f"profile_id: {_ROUTER_PLAN['profile_id']}, "
                f"capture_mode: {_ROUTER_PLAN['capture_mode']}, "
                f"window_mode: {_ROUTER_PLAN['window_mode']}, "
                f"ocr_mode: {_ROUTER_PLAN['ocr_mode']}, "
                f"health_grade: {_ROUTER_PLAN['health_grade']}"
            )
            if _ROUTER_PLAN['blocker_codes']:
                logger.warning(f"[CapabilityRouter] Blockers active: {_ROUTER_PLAN['blocker_codes']}")
            if _ROUTER_PLAN['recommendations']:
                for rec in _ROUTER_PLAN['recommendations']:
                    logger.info(f"[CapabilityRouter] Rec: {rec}")
                    
        except Exception as e:
            logger.error(f"Capability router failed to resolve plan: {e}", exc_info=True)
            # Safe basic fallback plan
            _ROUTER_PLAN = {
                'profile_id': 'safe_fallback',
                'capture_mode': 'disabled',
                'window_mode': 'unknown_only',
                'ocr_mode': 'metadata_only',
                'fallback_chain': [],
                'preprocessing_profile': 'none',
                'health_grade': 'limited',
                'blocker_codes': ['ROUTER_EXCEPTION'],
                'recommendations': [str(e)]
            }
    return _ROUTER_PLAN


def get_router_signature() -> Optional[Dict[str, Any]]:
    """Retrieve raw capability signature if populated."""
    return _ROUTER_SIGNATURE


if __name__ == '__main__':
    # CLI mode for testing / validation (Phase 5)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
    plan = get_router_plan(force_refresh=True)
    print("\n=== CAPABILITY SIGNATURE ===")
    print(json.dumps(get_router_signature(), indent=2))
    print("\n=== ROUTER RUNTIME PLAN ===")
    print(json.dumps(plan, indent=2))
