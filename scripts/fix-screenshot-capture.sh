#!/bin/bash
# TimeTracker Screenshot Capture Fix Script
# Installs required dependencies for Wayland screenshot capture

set -e

echo "=========================================="
echo "TimeTracker Screenshot Capture Fix"
echo "=========================================="
echo ""
echo "This script will install required packages for OCR screenshot"
echo "capture on Wayland systems."
echo ""

# Check if running on Wayland
if [ -z "$WAYLAND_DISPLAY" ]; then
    echo "⚠️  Warning: Not running on Wayland (WAYLAND_DISPLAY not set)"
    echo "   This fix is primarily for Wayland systems."
    echo ""
fi

# Check current state
echo "📋 Checking current system state..."
echo ""

# Check PipeWire
if ps aux | grep -v grep | grep -q pipewire; then
    echo "✅ PipeWire is running"
else
    echo "❌ PipeWire is NOT running"
fi

# Check GStreamer
if command -v gst-inspect-1.0 &> /dev/null; then
    echo "✅ GStreamer tools installed"
    if gst-inspect-1.0 pipewiresrc &> /dev/null; then
        echo "✅ GStreamer pipewiresrc plugin available"
    else
        echo "❌ GStreamer pipewiresrc plugin MISSING"
    fi
else
    echo "❌ GStreamer tools NOT installed"
fi

# Check xdg-desktop-portal
if command -v xdg-desktop-portal &> /dev/null; then
    echo "✅ xdg-desktop-portal installed"
else
    echo "❌ xdg-desktop-portal NOT installed"
fi

# Check ScreenCast Portal availability
if gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop 2>/dev/null | grep -q "org.freedesktop.portal.ScreenCast"; then
    echo "✅ ScreenCast Portal is available"
else
    echo "❌ ScreenCast Portal NOT available"
fi

echo ""
echo "=========================================="
echo ""

# Ask for confirmation
read -p "Install/update required packages? (y/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 0
fi

echo ""
echo "📦 Installing required packages..."
echo ""

# Update package list
sudo apt update

# Install required packages
sudo apt install -y \
    pipewire \
    wireplumber \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-tools \
    gstreamer1.0-pipewire \
    xdg-desktop-portal \
    xdg-desktop-portal-gnome

echo ""
echo "✅ Packages installed successfully"
echo ""

# Restart PipeWire
echo "🔄 Restarting PipeWire services..."
systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null || {
    echo "⚠️  Could not restart PipeWire via systemctl"
    echo "   You may need to log out and back in"
}

echo ""
echo "=========================================="
echo "📋 Verification"
echo "=========================================="
echo ""

# Verify installation
ERRORS=0

# Check PipeWire
if ps aux | grep -v grep | grep -q pipewire; then
    echo "✅ PipeWire is running"
else
    echo "❌ PipeWire is NOT running - try logging out and back in"
    ERRORS=$((ERRORS + 1))
fi

# Check GStreamer
if gst-inspect-1.0 pipewiresrc &> /dev/null; then
    echo "✅ GStreamer pipewiresrc plugin available"
else
    echo "❌ GStreamer pipewiresrc plugin still missing"
    ERRORS=$((ERRORS + 1))
fi

# Check ScreenCast Portal
if gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop 2>/dev/null | grep -q "org.freedesktop.portal.ScreenCast"; then
    echo "✅ ScreenCast Portal is available"
else
    echo "❌ ScreenCast Portal still not available"
    echo "   Try: sudo systemctl restart xdg-desktop-portal"
    ERRORS=$((ERRORS + 1))
fi

echo ""
echo "=========================================="

if [ $ERRORS -eq 0 ]; then
    echo "✅ All checks passed!"
    echo ""
    echo "Next steps:"
    echo "1. Restart TimeTracker application"
    echo "2. When prompted, click 'Allow' on the screenshot consent dialog"
    echo "3. Check logs: tail -f ~/.local/share/TimeTracker/logs/timetracker.log"
    echo ""
    echo "Expected log messages:"
    echo "  [INFO] ScreenCast Portal available - flash-free captures enabled"
    echo "  [OCR] RapidOCR: extracted N chars (confidence: 0.XX)"
else
    echo "⚠️  Some checks failed ($ERRORS errors)"
    echo ""
    echo "Try these steps:"
    echo "1. Log out and log back in (to restart all user services)"
    echo "2. Run this script again to verify"
    echo "3. Check system logs: journalctl --user -xe | grep portal"
fi

echo ""
echo "=========================================="
echo ""

# Offer to test GStreamer pipeline
read -p "Test GStreamer ScreenCast pipeline? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Testing GStreamer pipeline (this may show a consent dialog)..."
    echo ""
    
    # Create a test pipeline that should work if everything is set up
    timeout 5 gst-launch-1.0 pipewiresrc ! videoconvert ! fakesink 2>&1 | head -20 || {
        echo ""
        echo "⚠️  Pipeline test failed or timed out"
        echo "   This is expected if consent hasn't been granted yet"
        echo "   Try running the TimeTracker app and granting consent first"
    }
fi

echo ""
echo "=========================================="
echo "Diagnostic Information"
echo "=========================================="
echo ""
echo "PipeWire processes:"
ps aux | grep -E "pipewire|wireplumber" | grep -v grep
echo ""
echo "Portal processes:"
ps aux | grep -E "xdg-desktop-portal" | grep -v grep
echo ""
echo "GStreamer plugin list (pipewiresrc):"
gst-inspect-1.0 pipewiresrc 2>&1 | head -5 || echo "Plugin not found"
echo ""
echo "=========================================="
echo ""
echo "📚 For more information, see:"
echo "   docs/OCR_FAILURE_ROOT_CAUSE_ANALYSIS.md"
echo ""
