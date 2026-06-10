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
if exist ".venv\Scripts\activate.bat" (
    echo [INFO] Activating virtual environment .venv...
    call .venv\Scripts\activate.bat
    set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
    set "VENV_PIP=%~dp0.venv\Scripts\pip.exe"
) else (
    if exist "venv\Scripts\activate.bat" (
        echo [INFO] Activating virtual environment venv...
        call venv\Scripts\activate.bat
        set "VENV_PYTHON=%~dp0venv\Scripts\python.exe"
        set "VENV_PIP=%~dp0venv\Scripts\pip.exe"
    ) else (
        echo [INFO] No virtual environment found, using system Python
    )
)

REM Check if Python is available (using venv if available, otherwise system)
"%VENV_PYTHON%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not available
    echo Please ensure Python 3.8+ is installed or virtual environment is properly configured
    pause
    exit /b 1
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

REM ============================================================================
REM STEP 5: Code-signing readiness  (UPX is intentionally DISABLED)
REM ----------------------------------------------------------------------------
REM UPX compression is disabled in desktop_app.spec (upx=False): packed binaries
REM hurt SmartScreen / Smart App Control reputation. Do NOT re-enable it.
REM
REM To Authenticode-sign the build + installer, install signtool (Windows SDK)
REM and set, before running this script:
REM     set SIGN_PFX=C:\path\to\codesign.pfx
REM     set SIGN_PFX_PASSWORD=yourpassword
REM Without a certificate the build still works and passes PATH-based policies
REM (Program Files); a certificate is only needed for PUBLISHER-based policies.
REM See installer\README.md.
REM ============================================================================
echo.
echo [STEP 5/7] Code-signing readiness check...
where signtool >nul 2>&1
if errorlevel 1 (
    echo [INFO] signtool not found in PATH - signing pass will be skipped.
    echo        ^(Install the Windows SDK to get signtool; see installer\README.md^)
) else (
    if defined SIGN_PFX (
        echo [OK] signtool found and SIGN_PFX set - build/installer will be signed.
    ) else (
        echo [INFO] signtool found but SIGN_PFX not set - signing pass will be skipped.
    )
)

REM Clean previous builds
echo.
echo [STEP 6/7] Building application (one-folder)...

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

REM Check if build was successful (one-folder output)
if not exist "dist\TimeTracker\TimeTracker.exe" (
    echo.
    echo [ERROR] Build completed but dist\TimeTracker\TimeTracker.exe not found
    pause
    exit /b 1
)

echo.
echo ============================================
echo  BUILD SUCCESSFUL (one-folder)
echo ============================================
echo   Output folder: dist\TimeTracker\
echo.

REM ----------------------------------------------------------------------------
REM Optional: Authenticode-sign every exe/dll in the build BEFORE packaging.
REM Enabled only when signtool is on PATH and SIGN_PFX is set (see STEP 5).
REM ----------------------------------------------------------------------------
where signtool >nul 2>&1
if not errorlevel 1 if defined SIGN_PFX (
    echo [INFO] Signing build artifacts in dist\TimeTracker ...
    for /r "dist\TimeTracker" %%F in (*.exe *.dll) do (
        signtool sign /fd SHA256 /f "%SIGN_PFX%" /p "%SIGN_PFX_PASSWORD%" /tr http://timestamp.digicert.com /td SHA256 "%%F" >nul 2>&1
    )
    echo [OK] Build artifacts signed.
)

REM ----------------------------------------------------------------------------
REM STEP 7: Compile the Windows installer (Inno Setup)
REM ----------------------------------------------------------------------------
echo.
echo [STEP 7/7] Building installer (Inno Setup)...

REM Determine app version from desktop_app.py (fallback 1.4.7).
REM The Python one-liner uses chr(34)/chr(39) and single quotes only, so there
REM are NO embedded double quotes to confuse cmd's quote parsing.
set "APP_VER=1.4.13"
"%VENV_PYTHON%" -c "import io;print(next(l.split('=',1)[1].strip().strip(chr(34)).strip(chr(39)) for l in io.open('desktop_app.py',encoding='utf-8') if l.strip().startswith('APP_VERSION') and '=' in l))" > "%TEMP%\tt_ver.txt" 2>nul
if exist "%TEMP%\tt_ver.txt" (
    set /p APP_VER=<"%TEMP%\tt_ver.txt"
    del /f /q "%TEMP%\tt_ver.txt" >nul 2>&1
)
echo [INFO] Installer version: %APP_VER%

REM Locate the Inno Setup command-line compiler (ISCC.exe)
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC (
    where iscc >nul 2>&1
    if not errorlevel 1 set "ISCC=iscc"
)

if not defined ISCC (
    echo [WARN] Inno Setup ^(ISCC.exe^) not found - installer NOT built.
    echo        Install Inno Setup 6 from https://jrsoftware.org/isdl.php then re-run.
    echo        The one-folder build in dist\TimeTracker\ is still ready.
    goto :done
)

"%ISCC%" /DMyAppVersion=%APP_VER% "installer\TimeTracker.iss"
if errorlevel 1 (
    echo.
    echo [ERROR] Installer build failed. See Inno Setup output above.
    pause
    exit /b 1
)

REM Optional: sign the installer itself
where signtool >nul 2>&1
if not errorlevel 1 if defined SIGN_PFX (
    if exist "installer\Output\TimeTrackerSetup.exe" (
        echo [INFO] Signing installer...
        signtool sign /fd SHA256 /f "%SIGN_PFX%" /p "%SIGN_PFX_PASSWORD%" /tr http://timestamp.digicert.com /td SHA256 "installer\Output\TimeTrackerSetup.exe" >nul 2>&1
        echo [OK] Installer signed.
    )
)

echo.
echo ============================================
echo  DISTRIBUTION READY
echo ============================================
echo   Installer: installer\Output\TimeTrackerSetup.exe
echo.
echo Distribute TimeTrackerSetup.exe. Users run it once (it asks for admin),
echo which installs into C:\Program Files\TimeTracker and registers the silent
echo SYSTEM auto-update task. Per-user data stays in %%LOCALAPPDATA%%\TimeTracker.
echo.
echo IMPORTANT one-time server step: point the /api/app-version/check
echo downloadUrl at TimeTrackerSetup.exe and set its SHA256 as the checksum,
echo so the SYSTEM updater installs the right artifact. See installer\README.md.
echo.

:done
echo Build complete! Press any key to exit...
pause >nul
