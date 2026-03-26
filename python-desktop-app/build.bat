@echo off
REM ============================================================================
REM Time Tracker - Build Script for Windows
REM Creates a compressed standalone executable with embedded credentials
REM No .env file needed for distribution - credentials are embedded in code
REM ============================================================================

echo.
echo ============================================
echo  Time Tracker - Build Script
echo ============================================
echo.
echo NOTE: Credentials are embedded in desktop_app.py
echo       No .env file needed for distribution!
echo.

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH
    echo Please install Python 3.8+ and try again
    pause
    exit /b 1
)

REM Check if we're in the right directory
if not exist "desktop_app.py" (
    echo [ERROR] desktop_app.py not found
    echo Please run this script from the python-desktop-app directory
    pause
    exit /b 1
)

REM Check for virtual environment and set Python/pip paths
set "VENV_PYTHON=python"
set "VENV_PIP=pip"
if exist "venv\Scripts\activate.bat" (
    echo [INFO] Activating virtual environment...
    call venv\Scripts\activate.bat
    set "VENV_PYTHON=%~dp0venv\Scripts\python.exe"
    set "VENV_PIP=%~dp0venv\Scripts\pip.exe"
) else (
    echo [INFO] No virtual environment found, using system Python
)

REM Install/update dependencies
echo.
echo [STEP 1/6] Installing Python dependencies...
"%VENV_PIP%" install -r requirements.txt --quiet
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

REM ============================================================================
REM STEP 2: DYNAMICALLY INSTALL OCR DEPENDENCIES FROM .env
REM ============================================================================
echo.
echo [STEP 2/6] Reading OCR engine configuration...

REM Read OCR_PRIMARY_ENGINE and OCR_FALLBACK_ENGINES from .env files
REM Priority: local .env > ai-server/.env > defaults
set "OCR_PRIMARY_ENGINE="
set "OCR_FALLBACK_ENGINES="

REM Try local .env first
if exist ".env" (
    echo [INFO] Reading OCR config from local .env...
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        if "%%A"=="OCR_PRIMARY_ENGINE" set "OCR_PRIMARY_ENGINE=%%B"
        if "%%A"=="OCR_FALLBACK_ENGINES" set "OCR_FALLBACK_ENGINES=%%B"
    )
)

REM If not found locally, try ai-server/.env
if not defined OCR_PRIMARY_ENGINE (
    if exist "..\ai-server\.env" (
        echo [INFO] Reading OCR config from ai-server/.env...
        for /f "usebackq eol=# tokens=1,* delims==" %%A in ("..\ai-server\.env") do (
            if "%%A"=="OCR_PRIMARY_ENGINE" set "OCR_PRIMARY_ENGINE=%%B"
            if "%%A"=="OCR_FALLBACK_ENGINES" set "OCR_FALLBACK_ENGINES=%%B"
        )
    )
)

REM Also load engine-specific settings (PACKAGE, CLASS, METHOD, MIN_CONFIDENCE)
if exist "..\ai-server\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("..\ai-server\.env") do (
        echo %%A | findstr /r "^OCR_" >nul 2>&1
        if not errorlevel 1 (
            set "%%A=%%B"
        )
    )
)

REM Final defaults if nothing found
if not defined OCR_PRIMARY_ENGINE (
    echo [INFO] No OCR config found in any .env file - using defaults: rapidocr + winrtocr
    set "OCR_PRIMARY_ENGINE=rapidocr"
    set "OCR_FALLBACK_ENGINES=winrtocr"
)
echo [INFO] Primary engine: %OCR_PRIMARY_ENGINE%
echo [INFO] Fallback engines: %OCR_FALLBACK_ENGINES%

REM Use Python auto_installer to install all configured engines dynamically
echo.
echo [STEP 3/6] Installing OCR engine dependencies (dynamic)...
"%VENV_PYTHON%" -c "from ocr.auto_installer import check_and_install_dependencies; check_and_install_dependencies(auto_install=True, silent=False)"
if errorlevel 1 (
    echo [WARN] Some OCR dependencies may have failed to install.
    echo [WARN] The exe will still build - check output above for details.
) else (
    echo [OK] OCR engine dependencies installed
)

REM Check if Tesseract is needed and install system binary
echo %OCR_PRIMARY_ENGINE% %OCR_FALLBACK_ENGINES% | findstr /i "tesseract" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [INFO] Tesseract engine configured - checking system binary...
    where tesseract >nul 2>&1
    if errorlevel 1 (
        echo [INFO] Tesseract OCR not found in PATH - checking common install locations...
        
        set "TESSERACT_FOUND="
        if exist "C:\Program Files\Tesseract-OCR\tesseract.exe" (
            set "TESSERACT_PATH=C:\Program Files\Tesseract-OCR"
            set "TESSERACT_FOUND=1"
        )
        if exist "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe" (
            set "TESSERACT_PATH=C:\Program Files (x86)\Tesseract-OCR"
            set "TESSERACT_FOUND=1"
        )
        if exist "%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe" (
            set "TESSERACT_PATH=%LOCALAPPDATA%\Programs\Tesseract-OCR"
            set "TESSERACT_FOUND=1"
        )
        
        if defined TESSERACT_FOUND (
            echo [INFO] Found Tesseract at: %TESSERACT_PATH%
            set "PATH=%TESSERACT_PATH%;%PATH%"
            echo [OK] Tesseract OCR configured for build
            goto :tesseract_done
        )
        
        echo [INFO] Tesseract not installed - attempting auto-install...
        where winget >nul 2>&1
        if not errorlevel 1 (
            echo [INFO] Installing Tesseract via winget...
            winget install --id UB-Mannheim.TesseractOCR -e --silent --accept-source-agreements --accept-package-agreements
            if exist "C:\Program Files\Tesseract-OCR\tesseract.exe" (
                echo [OK] Tesseract installed via winget
                set "PATH=C:\Program Files\Tesseract-OCR;%PATH%"
                goto :tesseract_done
            )
        )
        where choco >nul 2>&1
        if not errorlevel 1 (
            echo [INFO] Trying Chocolatey...
            echo Y | choco install tesseract -y --no-progress
            if exist "C:\Program Files\Tesseract-OCR\tesseract.exe" (
                echo [OK] Tesseract installed via Chocolatey
                set "PATH=C:\Program Files\Tesseract-OCR;%PATH%"
                goto :tesseract_done
            )
        )
        where scoop >nul 2>&1
        if not errorlevel 1 (
            echo [INFO] Trying Scoop...
            scoop install tesseract
            if exist "%USERPROFILE%\scoop\apps\tesseract\current\tesseract.exe" (
                echo [OK] Tesseract installed via Scoop
                set "PATH=%USERPROFILE%\scoop\apps\tesseract\current;%PATH%"
                goto :tesseract_done
            )
        )
        
        echo [WARN] Could not auto-install Tesseract.
        echo [WARN] Please install manually from: https://github.com/UB-Mannheim/tesseract/wiki
    ) else (
        echo [OK] Tesseract OCR found in PATH
    )
)
:tesseract_done

REM ============================================================================
REM STEP 4: Download PaddleOCR models if paddle engine is configured
REM ============================================================================
echo.
echo [STEP 4/6] Checking OCR model downloads...

REM Only download PaddleOCR models if paddle is a configured engine
echo %OCR_PRIMARY_ENGINE% %OCR_FALLBACK_ENGINES% | findstr /i "paddle" >nul 2>&1
if not errorlevel 1 (
    echo [INFO] PaddleOCR engine configured - checking models...
    set "PADDLEOCR_CACHE=%USERPROFILE%\.paddleocr\whl"
    if exist "%PADDLEOCR_CACHE%" (
        echo [OK] PaddleOCR models found at %PADDLEOCR_CACHE%
    ) else (
        echo [INFO] PaddleOCR models not found - downloading...
        echo [INFO] This may take a few minutes on first run...
        "%VENV_PYTHON%" -c "from paddleocr import PaddleOCR; ocr = PaddleOCR(lang='en', use_angle_cls=True, show_log=False); print('Models downloaded successfully')"
        if errorlevel 1 (
            echo [WARN] Failed to download PaddleOCR models.
        ) else (
            echo [OK] PaddleOCR models downloaded successfully
        )
    )
) else (
    echo [INFO] PaddleOCR not configured - skipping model download
)

REM Check for UPX compression (optional)
echo.
echo [STEP 5/6] Checking for UPX compression tool...
where upx >nul 2>&1
if errorlevel 1 (
    echo [INFO] UPX not found - attempting auto-install...
    where winget >nul 2>&1
    if not errorlevel 1 (
        winget install --id UPX.UPX -e --silent --accept-source-agreements --accept-package-agreements >nul 2>&1
    )

    where upx >nul 2>&1
    if errorlevel 1 (
        where choco >nul 2>&1
        if not errorlevel 1 (
            choco install upx -y >nul 2>&1
        )
    )

    where upx >nul 2>&1
    if errorlevel 1 (
        where scoop >nul 2>&1
        if not errorlevel 1 (
            scoop install upx >nul 2>&1
        )
    )

    where upx >nul 2>&1
    if errorlevel 1 (
        echo [WARN] UPX install failed or unavailable - executable will not be compressed
        echo       Install manually from https://github.com/upx/upx/releases and add to PATH
    ) else (
        echo [OK] UPX installed and found in PATH - compression enabled
    )
) else (
    echo [OK] UPX found - compression enabled
)

REM Clean previous builds
echo.
echo [STEP 6/6] Building executable...

REM Remove problematic packages that conflict with PyInstaller
echo [INFO] Removing packages incompatible with PyInstaller...
"%VENV_PIP%" uninstall -y pathlib >nul 2>&1

if exist "dist" rmdir /s /q dist
if exist "build" rmdir /s /q build

REM Build the executable
echo [INFO] Running PyInstaller...
echo This may take a few minutes...
echo.

REM CRITICAL: Disable user site-packages to prevent PyInstaller from picking up
REM system-wide paddle/paddleocr installations that conflict with the venv versions
set PYTHONNOUSERSITE=1
"%VENV_PYTHON%" -m PyInstaller desktop_app.spec

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed! Check the output above for errors.
    pause
    exit /b 1
)

REM Check if build was successful
if exist "dist\TimeTracker.exe" (
    echo.
    echo ============================================
    echo  BUILD SUCCESSFUL!
    echo ============================================
    echo.

    REM Get file size
    for %%A in ("dist\TimeTracker.exe") do (
        set /a size=%%~zA / 1024 / 1024
        echo Executable: dist\TimeTracker.exe
        echo Size: ~%%~zA bytes
    )

    echo.
    echo ============================================
    echo  DISTRIBUTION READY
    echo ============================================
    echo.
    echo The executable is ready to distribute!
    echo.
    echo Features included:
    echo   - Credentials embedded - no .env file needed
    echo   - Auto-start on Windows boot via registry
    echo   - Uninstaller generated on first run
    echo   - Data stored in: %%LOCALAPPDATA%%\TimeTracker
    echo.
    echo Users simply:
    echo   1. Double-click TimeTracker.exe
    echo   2. Login with Atlassian
    echo   3. Done!
    echo.
) else (
    echo.
    echo [ERROR] Build completed but executable not found
    pause
    exit /b 1
)

echo Build complete! Press any key to exit...
pause >nul
