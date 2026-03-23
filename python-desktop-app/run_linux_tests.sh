#!/usr/bin/env bash
# =============================================================================
# JIRAForge — Linux Adaptation Test Runner
# =============================================================================
# Runs all automated tests for the Linux codebase modifications.
#
# Usage:
#   chmod +x run_linux_tests.sh
#   ./run_linux_tests.sh           # Run all tests
#   ./run_linux_tests.sh -v        # Verbose output
#   ./run_linux_tests.sh -k sqlite # Run only tests matching 'sqlite'
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo " JIRAForge Linux Adaptation Test Suite"
echo "=========================================="
echo ""

# Check for pytest
if command -v python3 -m pytest &>/dev/null || python3 -c "import pytest" 2>/dev/null; then
    echo -e "${GREEN}[OK]${NC} pytest found"
else
    echo -e "${YELLOW}[WARN]${NC} pytest not found, installing..."
    pip3 install pytest
fi

echo ""
echo "Running test modules:"
echo "  1. test_platform.py           — Platform detection & routing"
echo "  2. test_linux_functions.py     — Linux-specific functions"
echo "  3. test_sqlite_manager.py      — SQLite local storage"
echo "  4. test_session_tracker.py     — Session time accumulator"
echo "  5. test_batch_uploader.py      — Batch upload logic"
echo "  6. test_ocr_auto_switch.py     — OCR engine auto-switching"
echo "  7. test_config_manager.py      — XDG config compliance"
echo "  8. test_wayland_screenshot.py  — Wayland screenshot capture"
echo ""

# Pass through any extra args (e.g., -v, -k, --tb)
EXTRA_ARGS="${*:---tb=short}"

python3 -m pytest tests/test_platform.py \
                  tests/test_linux_functions.py \
                  tests/test_sqlite_manager.py \
                  tests/test_session_tracker.py \
                  tests/test_batch_uploader.py \
                  tests/test_ocr_auto_switch.py \
                  tests/test_config_manager.py \
                  tests/test_wayland_screenshot.py \
                  $EXTRA_ARGS

EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}=========================================="
    echo -e " ALL TESTS PASSED"
    echo -e "==========================================${NC}"
else
    echo -e "${RED}=========================================="
    echo -e " SOME TESTS FAILED (exit code: $EXIT_CODE)"
    echo -e "==========================================${NC}"
fi

exit $EXIT_CODE
