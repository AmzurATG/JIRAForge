@echo off
REM Non-interactive pytest runner for the desktop app test suite (Windows).
REM Prefers the project's .venv interpreter if present, else falls back to
REM whatever `python` is on PATH. Pass extra args through, e.g.:
REM   run_pytest.bat tests\test_email_chat_body_redaction.py -v
setlocal
set PY=python
if exist "%~dp0.venv\Scripts\python.exe" set PY="%~dp0.venv\Scripts\python.exe"

if "%~1"=="" (
    echo Running full pytest suite in tests\ ...
    %PY% -m pytest "%~dp0tests" -v
) else (
    %PY% -m pytest %*
)
endlocal
