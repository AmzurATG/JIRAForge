#!/bin/bash
#
# Quick test script for screenshot capture methods
# Run this to see which methods work on your system
#
# Usage: ./test_screenshot_methods.sh
#

set -e

echo ""
echo "=========================================="
echo "  SCREENSHOT CAPTURE TEST"
echo "  Testing flash behavior on your system"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect environment
echo "🔍 Environment Detection:"
echo "   Session Type: $XDG_SESSION_TYPE"
echo "   Desktop: $XDG_CURRENT_DESKTOP"
echo "   Wayland Display: ${WAYLAND_DISPLAY:-not set}"
echo ""

if [[ "$XDG_SESSION_TYPE" == "wayland" ]] || [[ -n "$WAYLAND_DISPLAY" ]]; then
    echo -e "${YELLOW}⚠️  Running on WAYLAND${NC}"
    IS_WAYLAND=true
else
    echo -e "${GREEN}✅ Running on X11${NC}"
    IS_WAYLAND=false
fi
echo ""

# Test GNOME version
echo "🔍 GNOME Version:"
if command -v gnome-shell &> /dev/null; then
    GNOME_VERSION=$(gnome-shell --version)
    echo "   $GNOME_VERSION"
    
    # Extract major version number
    MAJOR_VERSION=$(echo "$GNOME_VERSION" | grep -oP '\d+' | head -1)
    if [[ "$MAJOR_VERSION" -ge 46 ]]; then
        echo -e "   ${YELLOW}⚠️  GNOME 46+ - D-Bus may be blocked${NC}"
    fi
else
    echo "   GNOME Shell not found"
fi
echo ""

# Test 1: GNOME D-Bus (should be silent - no flash)
echo "=========================================="
echo "TEST 1: GNOME D-Bus Screenshot (flash=false)"
echo "        This should be SILENT - no flash"
echo "=========================================="

DBUS_RESULT=$(gdbus call --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot \
    false false /tmp/test_dbus_$$.png 2>&1) || true

if echo "$DBUS_RESULT" | grep -q "(true,"; then
    echo -e "${GREEN}✅ SUCCESS - D-Bus works (no flash)${NC}"
    rm -f /tmp/test_dbus_$$.png
    DBUS_WORKS=true
else
    echo -e "${RED}❌ BLOCKED${NC}"
    if echo "$DBUS_RESULT" | grep -q "AccessDenied"; then
        echo "   Reason: Access denied (GNOME 46+ security)"
    else
        echo "   Error: ${DBUS_RESULT:0:80}"
    fi
    DBUS_WORKS=false
fi
echo ""

# Test 2: XDG Desktop Portal
echo "=========================================="
echo "TEST 2: XDG Desktop Portal Availability"
echo "=========================================="

PORTAL_RESULT=$(gdbus introspect --session \
    --dest org.freedesktop.portal.Desktop \
    --object-path /org/freedesktop/portal/desktop 2>&1) || true

if echo "$PORTAL_RESULT" | grep -q "org.freedesktop.portal.Screenshot"; then
    echo -e "${GREEN}✅ XDG Portal AVAILABLE${NC}"
    echo "   Can be used for flash-free capture"
    PORTAL_AVAILABLE=true
else
    echo -e "${RED}❌ XDG Portal NOT available${NC}"
    PORTAL_AVAILABLE=false
fi
echo ""

# Test 3: scrot
echo "=========================================="
echo "TEST 3: scrot (X11 tool)"
echo "=========================================="

if command -v scrot &> /dev/null; then
    echo -e "${GREEN}✅ scrot INSTALLED${NC}"
    
    if [[ "$IS_WAYLAND" == true ]]; then
        echo -e "${RED}❌ BUT: Will produce BLACK image on Wayland${NC}"
        echo ""
        echo "   ROOT CAUSE (why scrot can't work on Wayland):"
        echo "   ┌─────────────────────────────────────────────────────┐"
        echo "   │ 1. scrot uses X11 protocol (XGetImage)              │"
        echo "   │ 2. On Wayland, X11 apps see XWayland layer only    │"
        echo "   │ 3. XWayland root window is EMPTY by design          │"
        echo "   │ 4. This is a SECURITY FEATURE of Wayland           │"
        echo "   │ 5. Cannot be fixed - it's a protocol limitation     │"
        echo "   └─────────────────────────────────────────────────────┘"
        SCROT_WORKS=false
    else
        echo "   scrot should work on X11"
        SCROT_WORKS=true
    fi
else
    echo -e "${YELLOW}⚠️  scrot NOT installed${NC}"
    echo "   Install with: sudo apt install scrot"
    SCROT_WORKS=false
fi
echo ""

# Summary
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo ""

if [[ "$IS_WAYLAND" == true ]]; then
    echo "You are on WAYLAND. Available methods:"
    echo ""
    
    if [[ "$PORTAL_AVAILABLE" == true ]]; then
        echo -e "  1. ${GREEN}✅ XDG Portal${NC} - Flash-free (after consent)"
    else
        echo -e "  1. ${RED}❌ XDG Portal${NC} - Not available"
    fi
    
    if [[ "$DBUS_WORKS" == true ]]; then
        echo -e "  2. ${GREEN}✅ GNOME D-Bus${NC} - Flash-free"
    else
        echo -e "  2. ${RED}❌ GNOME D-Bus${NC} - Blocked by GNOME 46+"
    fi
    
    echo -e "  3. ${YELLOW}⚠️  gnome-screenshot${NC} - Works but CAUSES FLASH"
    echo -e "  4. ${RED}❌ scrot${NC} - Black image (can't work on Wayland)"
    echo ""
    
    if [[ "$DBUS_WORKS" == true ]]; then
        echo -e "${GREEN}RECOMMENDATION: Current D-Bus method works!${NC}"
    elif [[ "$PORTAL_AVAILABLE" == true ]]; then
        echo -e "${YELLOW}RECOMMENDATION: Implement XDG Portal for flash-free capture${NC}"
    else
        echo -e "${RED}WARNING: Only gnome-screenshot works, flash will occur${NC}"
    fi
else
    echo "You are on X11. All methods should work without flash."
    echo "  • scrot (recommended)"
    echo "  • Pillow ImageGrab"
    echo "  • GNOME D-Bus"
fi

echo ""
echo "=========================================="
echo "TEST COMPLETE"
echo "=========================================="
echo ""
