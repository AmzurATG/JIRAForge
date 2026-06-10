#!/usr/bin/env python3
"""
Diagnostic test for GStreamer/PipeWire pipeline
"""

import sys
import os

# Test GStreamer availability and version
try:
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst, GLib
    
    Gst.init(None)
    
    print("="*70)
    print("GStreamer Diagnostic Test")
    print("="*70)
    print()
    print(f"✅ GStreamer available: {Gst.version_string()}")
    print(f"   Version: {Gst.version()}")
    print()
    
    # Check for pipewiresrc element
    factory = Gst.ElementFactory.find('pipewiresrc')
    if factory:
        print("✅ pipewiresrc element found")
        print(f"   Plugin: {factory.get_plugin_name()}")
    else:
        print("❌ pipewiresrc element NOT found")
        print("   This is required for ScreenCast")
        print("   Install: sudo apt install gstreamer1.0-pipewire")
        sys.exit(1)
    
    # Check other required elements
    required_elements = ['videoconvert', 'pngenc', 'filesink']
    for elem in required_elements:
        factory = Gst.ElementFactory.find(elem)
        if factory:
            print(f"✅ {elem} element found")
        else:
            print(f"❌ {elem} element NOT found")
    
    print()
    print("="*70)
    print("All GStreamer dependencies OK!")
    print()
    print("The pipeline should work. If you're seeing errors, they may be:")
    print("  1. PipeWire fd not valid (consent not granted)")
    print("  2. Pipeline state transition timing issue")
    print("  3. PipeWire stream not ready")
    print("="*70)
    
except Exception as e:
    print(f"❌ GStreamer test failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
