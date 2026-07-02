#!/bin/bash
# Non-interactive pytest runner for the desktop app test suite.
# Prefers the project's .venv interpreter if present, else falls back to
# whatever `python` is on PATH. Extra args pass through, e.g.:
#   ./run_pytest.sh tests/test_email_chat_body_redaction.py -v
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PY="python"
if [ -x "$DIR/.venv/Scripts/python.exe" ]; then
    PY="$DIR/.venv/Scripts/python.exe"   # Windows venv layout
elif [ -x "$DIR/.venv/bin/python" ]; then
    PY="$DIR/.venv/bin/python"           # POSIX venv layout
fi

if [ "$#" -eq 0 ]; then
    echo "Running full pytest suite in tests/ ..."
    "$PY" -m pytest "$DIR/tests" -v
else
    "$PY" -m pytest "$@"
fi
