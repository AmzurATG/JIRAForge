#!/bin/bash
# ============================================================================
# Wayland Window Detection Integration Test
# ============================================================================
# Quick diagnostic script to test all window detection methods on Wayland.
# Run this while switching between different applications to verify detection.
#
# Usage:
#   ./test_wayland_integration.sh
#   ./test_wayland_integration.sh --verbose
#   ./test_wayland_integration.sh --continuous 10
#
# Author: TimeTracker Team
# Date: 2026-06-11
# ============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Parse arguments
VERBOSE=false
CONTINUOUS=0

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -c|--continuous)
            CONTINUOUS="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -v, --verbose        Show detailed output"
            echo "  -c, --continuous N   Run N continuous tests"
            echo "  -h, --help           Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Header
echo -e "${BOLD}=============================================="
echo "Wayland Window Detection Integration Test"
echo -e "==============================================${NC}"
echo ""

# ============================================================================
# Environment Detection
# ============================================================================
echo -e "${BOLD}1. Environment Detection${NC}"
echo "-------------------------------------------"

# Check if on Wayland
if [ -n "$WAYLAND_DISPLAY" ]; then
    echo -e "  ${GREEN}✓${NC} Running on Wayland (WAYLAND_DISPLAY=$WAYLAND_DISPLAY)"
elif [ "$XDG_SESSION_TYPE" = "wayland" ]; then
    echo -e "  ${GREEN}✓${NC} Running on Wayland (XDG_SESSION_TYPE=wayland)"
else
    echo -e "  ${YELLOW}⚠${NC} Not running on Wayland"
    echo "    WAYLAND_DISPLAY: ${WAYLAND_DISPLAY:-<not set>}"
    echo "    XDG_SESSION_TYPE: ${XDG_SESSION_TYPE:-<not set>}"
fi

# Check GNOME version
GNOME_VERSION=$(gnome-shell --version 2>/dev/null | grep -oP '\d+\.\d+' || echo "N/A")
echo "  GNOME Shell: $GNOME_VERSION"

# Check KDE version
KDE_VERSION=$(plasmashell --version 2>/dev/null | grep -oP '\d+\.\d+' || echo "N/A")
if [ "$KDE_VERSION" != "N/A" ]; then
    echo "  KDE Plasma: $KDE_VERSION"
fi

echo "  Desktop: ${XDG_CURRENT_DESKTOP:-Unknown}"
echo ""

# ============================================================================
# Method 1: GNOME Introspect API (GetWindows)
# ============================================================================
echo -e "${BOLD}2. GNOME Introspect API (GetWindows)${NC}"
echo "-------------------------------------------"

INTROSPECT_OK=false

# Check if interface exists
if gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Introspect 2>/dev/null | grep -q GetWindows; then
    echo -e "  ${GREEN}✓${NC} Introspect interface available"
    
    # Try to call GetWindows (may fail with AccessDenied on GNOME 46+)
    WINDOWS_OUTPUT=$(gdbus call --session \
        --dest org.gnome.Shell \
        --object-path /org/gnome/Shell/Introspect \
        --method org.gnome.Shell.Introspect.GetWindows 2>&1 || true)
    WINDOWS_RC=$?
    
    if echo "$WINDOWS_OUTPUT" | grep -q "AccessDenied"; then
        echo -e "  ${RED}✗${NC} GetWindows blocked (AccessDenied)"
        echo "    Note: GNOME 46+ may restrict this API for security"
    elif [ $WINDOWS_RC -eq 0 ] && echo "$WINDOWS_OUTPUT" | grep -q "'title':"; then
        echo -e "  ${GREEN}✓${NC} GetWindows call succeeded"
        
        # Check for focused window
        if echo "$WINDOWS_OUTPUT" | grep -q "'has-focus': <true>"; then
            echo -e "  ${GREEN}✓${NC} Focused window found"
            
            # Extract focused window title (simplified parsing)
            # Look for title before has-focus: <true>
            TITLE=$(echo "$WINDOWS_OUTPUT" | grep -oP "'title': <'[^']*'>[^}]*'has-focus': <true>" | head -1 | grep -oP "'title': <'\K[^']*" || echo "")
            
            if [ -n "$TITLE" ]; then
                echo -e "  ${GREEN}✓${NC} Focused title: '$TITLE'"
                INTROSPECT_OK=true
            fi
        else
            echo -e "  ${YELLOW}⚠${NC} No focused window found in response"
            echo "    (Try clicking on a window and re-run)"
        fi
        
        if [ "$VERBOSE" = true ]; then
            echo "  Response length: ${#WINDOWS_OUTPUT} chars"
            WINDOW_COUNT=$(echo "$WINDOWS_OUTPUT" | grep -o "'title':" | wc -l)
            echo "  Total windows: $WINDOW_COUNT"
        fi
    else
        echo -e "  ${RED}✗${NC} GetWindows call failed"
        if [ "$VERBOSE" = true ]; then
            echo "  Error: ${WINDOWS_OUTPUT:0:200}"
        fi
    fi
else
    echo -e "  ${RED}✗${NC} Introspect interface not available"
    echo "    (This may indicate GNOME Shell is not running)"
fi
echo ""

# ============================================================================
# Method 2: Shell.Eval (may be disabled on GNOME 45+)
# ============================================================================
echo -e "${BOLD}3. GNOME Shell.Eval API${NC}"
echo "-------------------------------------------"

EVAL_OK=false

EVAL_RESULT=$(gdbus call --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval \
    "let w=global.display.focus_window;w?(w.title+'|||'+w.wm_class):'|||'" 2>&1)

if echo "$EVAL_RESULT" | grep -q "(true,"; then
    echo -e "  ${GREEN}✓${NC} Shell.Eval is enabled and working"
    
    # Extract title
    TITLE=$(echo "$EVAL_RESULT" | grep -oP "\(true, '\K[^|]*" || echo "")
    APP=$(echo "$EVAL_RESULT" | grep -oP "\|\|\|\K[^']*" || echo "")
    
    echo "  Focused: '$TITLE' / '$APP'"
    EVAL_OK=true
else
    echo -e "  ${YELLOW}⚠${NC} Shell.Eval is disabled (expected on GNOME 45+)"
    echo "    To enable: gsettings set org.gnome.shell development-tools true"
    
    if [ "$VERBOSE" = true ] && echo "$EVAL_RESULT" | grep -q "(false,"; then
        echo "    Response: $(echo "$EVAL_RESULT" | head -c 100)"
    fi
fi
echo ""

# ============================================================================
# Method 3: AT-SPI2 Accessibility
# ============================================================================
echo -e "${BOLD}4. AT-SPI2 Accessibility API${NC}"
echo "-------------------------------------------"

ATSPI_OK=false

# Check if AT-SPI2 bus is running
if gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} AT-SPI2 D-Bus service running"
else
    echo -e "  ${YELLOW}⚠${NC} AT-SPI2 D-Bus service not running"
    echo "    Start with: systemctl --user start at-spi-dbus-bus.service"
fi

# Check Python bindings - try both python3 and /usr/bin/python3 (for venv/AppImage compatibility)
PYTHON_PATH=""
for PYPATH in python3 /usr/bin/python3; do
    if $PYPATH -c "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi" 2>/dev/null; then
        PYTHON_PATH=$PYPATH
        break
    fi
done

if [ -n "$PYTHON_PATH" ]; then
    echo -e "  ${GREEN}✓${NC} Python AT-SPI2 bindings available ($PYTHON_PATH)"
    ATSPI_OK=true
    
    # Try to get focused window
    ATSPI_RESULT=$($PYTHON_PATH -c "
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()
desktop = Atspi.get_desktop(0)
ACTIVE = Atspi.StateType.ACTIVE
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if not app or app.get_name() == 'gnome-shell':
        continue
    for j in range(app.get_child_count()):
        win = app.get_child_at_index(j)
        if win and win.get_state_set().contains(ACTIVE):
            print(f'{win.get_name()}|||{app.get_name()}')
            exit(0)
print('|||')
" 2>/dev/null)
    
    if [ -n "$ATSPI_RESULT" ] && [ "$ATSPI_RESULT" != "|||" ]; then
        TITLE=$(echo "$ATSPI_RESULT" | cut -d'|' -f1)
        APP=$(echo "$ATSPI_RESULT" | cut -d'|' -f4)
        echo -e "  ${GREEN}✓${NC} Focused window: '$TITLE' / '$APP'"
    else
        echo -e "  ${YELLOW}⚠${NC} Could not detect focused window via AT-SPI2"
    fi
else
    echo -e "  ${RED}✗${NC} Python AT-SPI2 bindings not available"
    echo "    Install: sudo apt install python3-gi gir1.2-atspi-2.0"
fi
echo ""

# ============================================================================
# Method 4: xdotool (XWayland)
# ============================================================================
echo -e "${BOLD}5. xdotool (XWayland fallback)${NC}"
echo "-------------------------------------------"

XDOTOOL_OK=false

if command -v xdotool &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} xdotool installed"
    
    WID=$(xdotool getactivewindow 2>/dev/null)
    if [ -n "$WID" ]; then
        echo -e "  ${GREEN}✓${NC} Active XWayland window found (ID: $WID)"
        
        TITLE=$(xdotool getwindowname "$WID" 2>/dev/null || echo "Unknown")
        echo "  Title: '$TITLE'"
        
        PID=$(xdotool getwindowpid "$WID" 2>/dev/null || echo "")
        if [ -n "$PID" ]; then
            APP=$(ps -p "$PID" -o comm= 2>/dev/null || echo "Unknown")
            echo "  Process: $APP (PID: $PID)"
        fi
        
        XDOTOOL_OK=true
    else
        echo -e "  ${YELLOW}⚠${NC} No active XWayland window"
        echo "    (Focused app may be running as native Wayland)"
    fi
else
    echo -e "  ${RED}✗${NC} xdotool not installed"
    echo "    Install: sudo apt install xdotool"
fi
echo ""

# ============================================================================
# Summary
# ============================================================================
echo -e "${BOLD}=============================================="
echo "SUMMARY"
echo -e "==============================================${NC}"

WORKING_METHODS=0
[ "$INTROSPECT_OK" = true ] && WORKING_METHODS=$((WORKING_METHODS + 1))
[ "$EVAL_OK" = true ] && WORKING_METHODS=$((WORKING_METHODS + 1))
[ "$ATSPI_OK" = true ] && WORKING_METHODS=$((WORKING_METHODS + 1))
[ "$XDOTOOL_OK" = true ] && WORKING_METHODS=$((WORKING_METHODS + 1))

echo ""
echo "Working methods: $WORKING_METHODS/4"
echo ""

if [ "$INTROSPECT_OK" = true ]; then
    echo -e "  ${GREEN}✓${NC} gnome_introspect - ${GREEN}WORKING${NC} (preferred)"
else
    echo -e "  ${RED}✗${NC} gnome_introspect - NOT WORKING"
fi

if [ "$ATSPI_OK" = true ]; then
    echo -e "  ${GREEN}✓${NC} atspi - ${GREEN}WORKING${NC}"
else
    echo -e "  ${RED}✗${NC} atspi - NOT WORKING"
fi

if [ "$EVAL_OK" = true ]; then
    echo -e "  ${GREEN}✓${NC} gdbus (Shell.Eval) - ${GREEN}WORKING${NC}"
else
    echo -e "  ${YELLOW}⚠${NC} gdbus (Shell.Eval) - DISABLED (normal)"
fi

if [ "$XDOTOOL_OK" = true ]; then
    echo -e "  ${GREEN}✓${NC} xdotool - ${GREEN}WORKING${NC} (XWayland only)"
else
    echo -e "  ${YELLOW}⚠${NC} xdotool - NO XWAYLAND FOCUS"
fi

echo ""

# ============================================================================
# Recommendations
# ============================================================================
echo -e "${BOLD}RECOMMENDATIONS${NC}"
echo "-------------------------------------------"

if [ "$INTROSPECT_OK" = true ]; then
    echo -e "  ${GREEN}✓${NC} Primary method (gnome_introspect) is working."
    echo "    TimeTracker should detect windows correctly."
else
    echo -e "  ${RED}✗${NC} Primary method (gnome_introspect) is NOT working."
    echo "    This needs investigation. Check:"
    echo "      - GNOME Shell version compatibility"
    echo "      - D-Bus session bus accessibility"
fi

if [ "$ATSPI_OK" = false ]; then
    echo ""
    echo "  To enable AT-SPI2 fallback:"
    echo "    sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core"
    echo "    systemctl --user enable --now at-spi-dbus-bus.service"
    echo "    gsettings set org.gnome.desktop.interface toolkit-accessibility true"
fi

if [ "$WORKING_METHODS" -lt 2 ]; then
    echo ""
    echo -e "  ${YELLOW}WARNING:${NC} Less than 2 methods working."
    echo "    Window detection may be unreliable."
fi

echo ""
echo "For detailed diagnostics, run:"
echo "  python tests/test_wayland_window_detection.py"
echo ""

# ============================================================================
# Continuous Test (if requested)
# ============================================================================
if [ "$CONTINUOUS" -gt 0 ]; then
    echo -e "${BOLD}=============================================="
    echo "CONTINUOUS TEST ($CONTINUOUS iterations)"
    echo -e "==============================================${NC}"
    echo "Switch between windows during the test..."
    echo "Press Ctrl+C to stop"
    echo ""
    
    for i in $(seq 1 $CONTINUOUS); do
        # Quick test using gnome_introspect
        RESULT=$(gdbus call --session \
            --dest org.gnome.Shell \
            --object-path /org/gnome/Shell/Introspect \
            --method org.gnome.Shell.Introspect.GetWindows 2>&1)
        
        if [ $? -eq 0 ]; then
            # Extract focused window title
            TITLE=$(echo "$RESULT" | grep -oP "'title': <'[^']*'>[^}]*'has-focus': <true>" | head -1 | grep -oP "'title': <'\K[^']*" || echo "Unknown")
            if [ -n "$TITLE" ] && [ "$TITLE" != "Unknown" ]; then
                echo -e "  [$i] ${GREEN}✓${NC} $TITLE"
            else
                echo -e "  [$i] ${RED}✗${NC} Unknown"
            fi
        else
            echo -e "  [$i] ${RED}✗${NC} Method failed"
        fi
        
        [ $i -lt $CONTINUOUS ] && sleep 2
    done
    echo ""
fi

# Exit with appropriate code
if [ "$WORKING_METHODS" -ge 2 ]; then
    exit 0
else
    exit 1
fi
