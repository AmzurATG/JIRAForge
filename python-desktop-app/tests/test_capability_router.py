#!/usr/bin/env python3
"""
Unit tests for the Linux Startup Capability Router
"""

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

# Add parent directory to imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Remove mock stubs from conftest.py if present to import the real modules
for mod_name in ['capability_router', 'ocr']:
    if mod_name in sys.modules:
        if not hasattr(sys.modules[mod_name], '__file__') or 'mock' in type(sys.modules[mod_name]).__name__.lower():
            del sys.modules[mod_name]

from capability_router import (
    check_ocr_compatibility,
    route_capabilities,
    get_router_plan,
    get_router_signature
)


class TestCapabilityRouter(unittest.TestCase):
    """Test suite for capability routing policies and diagnostics signature."""

    def test_check_ocr_compatibility_valid(self):
        """No overrides or warnings when package versions are compatible."""
        versions = {
            'rapidocr_onnxruntime': '1.3.0',
            'onnxruntime': '1.16.0',
            'cv2': '4.8.0',
            'easyocr': '1.7.0',
            'torch': '2.0.1'
        }
        res = check_ocr_compatibility(versions)
        self.assertEqual(res['engine_overrides'], {})
        self.assertEqual(res['warnings'], [])

    def test_check_ocr_compatibility_missing_deps(self):
        """Should disable engines when essential dependencies are missing."""
        # Missing onnxruntime and cv2 for rapidocr
        versions = {
            'rapidocr_onnxruntime': '1.3.0',
        }
        res = check_ocr_compatibility(versions)
        self.assertEqual(res['engine_overrides'].get('rapidocr'), 'disabled')
        self.assertTrue(any("onnxruntime is missing" in w for w in res['warnings']))

        # Missing torch for easyocr
        versions = {
            'easyocr': '1.7.0',
        }
        res = check_ocr_compatibility(versions)
        self.assertEqual(res['engine_overrides'].get('easyocr'), 'disabled')
        self.assertTrue(any("pytorch (torch) is missing" in w for w in res['warnings']))

    def test_check_ocr_compatibility_bad_combination(self):
        """Should disable rapidocr on incompatible onnxruntime >= 1.16.0 and rapidocr < 1.3.0."""
        versions = {
            'rapidocr_onnxruntime': '1.2.9',
            'onnxruntime': '1.16.0',
            'cv2': '4.8.0'
        }
        res = check_ocr_compatibility(versions)
        self.assertEqual(res['engine_overrides'].get('rapidocr'), 'disabled')
        self.assertTrue(any("Known incompatible combination" in w for w in res['warnings']))

    def test_route_capabilities_win32(self):
        """Should route standard win32 profiles on Windows."""
        sig = {
            'ocr': {
                'configured_primary_engine': 'rapidocr',
                'configured_fallback_engines': []
            }
        }
        with patch('sys.platform', 'win32'):
            plan = route_capabilities(sig)
            self.assertEqual(plan['profile_id'], 'win32_standard')
            self.assertEqual(plan['capture_mode'], 'focused_monitor')
            self.assertEqual(plan['window_mode'], 'win32_native')

    def test_route_capabilities_darwin(self):
        """Should route standard darwin profiles on macOS."""
        sig = {
            'ocr': {
                'configured_primary_engine': 'rapidocr',
                'configured_fallback_engines': []
            }
        }
        with patch('sys.platform', 'darwin'):
            plan = route_capabilities(sig)
            self.assertEqual(plan['profile_id'], 'darwin_standard')
            self.assertEqual(plan['capture_mode'], 'darwin_native')
            self.assertEqual(plan['window_mode'], 'darwin_native')

    def test_route_capabilities_linux_wayland_screencast(self):
        """Should route to screencast_portal on Wayland when all PipeWire prerequisites are met."""
        sig = {
            'os': {
                'is_wayland': True,
                'desktop_name': 'GNOME',
                'desktop_version_major': 46,
                'xwayland_present': True
            },
            'capture': {
                'portal_screencast': True,
                'portal_screenshot': True,
                'gstreamer': True,
                'gst_pipewiresrc': True,
                'pipewire_running': True,
                'wireplumber_running': True
            },
            'window': {
                'gnome_shell_introspect': True,
                'atspi_bus': True,
                'atspi_python_bindings': True,
                'xdotool_available': True
            },
            'ocr': {
                'configured_primary_engine': 'rapidocr',
                'configured_fallback_engines': ['easyocr'],
                'available_engines': {'rapidocr': True, 'easyocr': True},
                'engine_init_errors': {},
                'package_versions': {
                    'rapidocr_onnxruntime': '1.3.0',
                    'onnxruntime': '1.15.0',
                    'cv2': '4.8.0'
                }
            },
            'capabilities': {
                'gnome_screenshot_available': True,
                'scrot_available': False
            },
            'dbus': {
                'gnome_shell': True
            }
        }
        with patch('sys.platform', 'linux'):
            plan = route_capabilities(sig)
            self.assertEqual(plan['capture_mode'], 'screencast_portal')
            self.assertEqual(plan['window_mode'], 'gnome_introspect')
            self.assertEqual(plan['ocr_mode'], 'rapidocr')
            self.assertEqual(plan['preprocessing_profile'], 'lightweight')
            self.assertEqual(plan['health_grade'], 'full')
            self.assertEqual(plan['blocker_codes'], [])

    def test_route_capabilities_linux_wayland_screenshot_portal(self):
        """Should fall back to screenshot_portal when PipeWire gst-plugin is missing."""
        sig = {
            'os': {
                'is_wayland': True,
                'desktop_name': 'GNOME',
                'desktop_version_major': 46,
                'xwayland_present': True
            },
            'capture': {
                'portal_screencast': True,
                'portal_screenshot': True,
                'gstreamer': True,
                'gst_pipewiresrc': False, # Missing
                'pipewire_running': True,
                'wireplumber_running': True
            },
            'window': {
                'gnome_shell_introspect': False,
                'atspi_bus': True,
                'atspi_python_bindings': True,
                'xdotool_available': True
            },
            'ocr': {
                'configured_primary_engine': 'rapidocr',
                'configured_fallback_engines': [],
                'available_engines': {'rapidocr': True},
                'engine_init_errors': {},
                'package_versions': {}
            },
            'capabilities': {},
            'dbus': {}
        }
        with patch('sys.platform', 'linux'):
            plan = route_capabilities(sig)
            self.assertEqual(plan['capture_mode'], 'screenshot_portal')
            self.assertEqual(plan['window_mode'], 'atspi')
            self.assertEqual(plan['health_grade'], 'partial')

    def test_route_capabilities_linux_x11(self):
        """Should resolve xdotool/scrot/tesseract profiles on X11 with tesseract engine."""
        sig = {
            'os': {
                'is_wayland': False,
                'desktop_name': 'XFCE',
                'desktop_version_major': 0,
                'xwayland_present': False
            },
            'capture': {
                'portal_screencast': False,
                'portal_screenshot': False,
                'gstreamer': False,
                'gst_pipewiresrc': False,
                'pipewire_running': False,
                'wireplumber_running': False
            },
            'window': {
                'gnome_shell_introspect': False,
                'atspi_bus': False,
                'atspi_python_bindings': False,
                'xdotool_available': True
            },
            'ocr': {
                'configured_primary_engine': 'tesseract',
                'configured_fallback_engines': [],
                'available_engines': {'tesseract': True},
                'engine_init_errors': {},
                'package_versions': {}
            },
            'capabilities': {
                'scrot_available': True,
                'gnome_screenshot_available': False
            },
            'dbus': {}
        }
        with patch('sys.platform', 'linux'):
            plan = route_capabilities(sig)
            self.assertEqual(plan['capture_mode'], 'gnome_screenshot_cli') # Routed via scrot CLI fallback
            self.assertEqual(plan['window_mode'], 'xdotool_xwayland')
            self.assertEqual(plan['ocr_mode'], 'tesseract')
            self.assertEqual(plan['preprocessing_profile'], 'high_contrast_resize')


if __name__ == '__main__':
    unittest.main()
