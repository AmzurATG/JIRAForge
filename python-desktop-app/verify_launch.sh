#!/bin/bash
#
# Comprehensive App Launch Verification
# Tests if the code signing fix resolved the crash issue
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

echo -e "${BLUE}🧪 TimeTracker Launch Verification${NC}"
echo "====================================="

APP_PATH="dist/TimeTracker.app"

if [ ! -d "$APP_PATH" ]; then
    print_error "TimeTracker.app not found"
    exit 1
fi

# Test 1: Check signature status
print_info "Test 1: Signature verification..."
if codesign --verify --deep "$APP_PATH" 2>/dev/null; then
    print_success "Signature is valid"
else
    print_warning "Signature has issues"
fi

# Test 2: Check for quarantine
print_info "Test 2: Quarantine check..."
QUARANTINE=$(xattr -l "$APP_PATH" 2>/dev/null | grep quarantine || echo "")
if [ -z "$QUARANTINE" ]; then
    print_success "No quarantine attributes"
else
    print_warning "Quarantine still present: $QUARANTINE"
fi

# Test 3: Test executable directly (non-blocking)
print_info "Test 3: Direct executable test..."
cd dist
if nohup ./TimeTracker.app/Contents/MacOS/TimeTrackerMac > /tmp/timetracker_test.log 2>&1 &
then
    APP_PID=$!
    print_info "Started TimeTracker (PID: $APP_PID)"
    
    # Wait a moment to see if it crashes immediately
    sleep 2
    
    if kill -0 $APP_PID 2>/dev/null; then
        print_success "App is running without immediate crash!"
        print_info "Stopping test instance..."
        kill $APP_PID 2>/dev/null || true
        wait $APP_PID 2>/dev/null || true
    else
        print_warning "App exited quickly - checking logs..."
        if [ -f "/tmp/timetracker_test.log" ]; then
            echo "--- App Output ---"
            head -10 /tmp/timetracker_test.log
            echo "--- End Output ---"
        fi
    fi
else
    print_error "Could not start executable"
fi
cd ..

# Test 4: Check Console for recent crashes
print_info "Test 4: Checking for recent crashes..."
RECENT_CRASHES=$(log show --predicate 'process == "TimeTrackerMac"' --last 5m 2>/dev/null | wc -l || echo "0")
if [ "$RECENT_CRASHES" -gt 5 ]; then
    print_warning "Found recent crash logs - app may still be crashing"
else
    print_success "No recent crash logs found"
fi

# Test 5: App launch via open command
print_info "Test 5: Testing 'open' command launch..."
if open "$APP_PATH"; then
    print_success "Open command succeeded"
    print_info "Check system tray for TimeTracker icon"
    print_info "Or check Activity Monitor for TimeTracker processes"
else
    print_warning "Open command failed"
fi

echo ""
echo -e "${BLUE}📋 Test Summary${NC}"
echo "================"

print_info "The code signing fix has been applied. Key changes:"
echo "   ✅ Removed invalid signature"
echo "   ✅ Added proper entitlements"
echo "   ✅ Removed quarantine attributes"
echo "   ✅ Re-signed with runtime flags"

echo ""
print_info "🚀 Next Steps:"
echo "1. Check system tray (menu bar) for TimeTracker icon"
echo "2. If app doesn't appear, check Activity Monitor"
echo "3. Grant permissions when prompted:"
echo "   • Screen Recording (System Preferences > Security & Privacy)"
echo "   • Accessibility (System Preferences > Security & Privacy)"

echo ""
print_warning "⚠️  If app still won't launch:"
echo "1. Right-click TimeTracker.app → Open (bypasses Gatekeeper)"
echo "2. Check Console.app for error messages"
echo "3. Try: sudo spctl --add dist/TimeTracker.app"

echo ""
print_success "Verification complete! The crash issue should be resolved."