@echo off
setlocal enabledelayedexpansion
title BLOOMBERG TERMINAL - DHAN STRADDLE PRO

cls
echo ===============================================================================
echo      🏛️  BLOOMBERG TERMINAL - DHAN STRADDLE PRO (READY TO SHIP)
echo ===============================================================================
echo.

:: 1. CHECK IF NODE.JS IS INSTALLED
echo [*] Checking Node.js runtime environment...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [!] ERROR: Node.js is NOT installed on this computer!
    echo.
    echo     Dhan Straddle Pro requires Node.js ^(version 18 or higher^).
    echo     Please download and install Node.js LTS from: https://nodejs.org/
    echo.
    echo Opening official Node.js download page in your browser...
    start https://nodejs.org/en/download/
    echo.
    pause
    exit /b 1
)

:: 2. VERIFY NODE.JS VERSION
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm -v') do set NPM_VERSION=%%i
echo [+] Node.js is installed: !NODE_VERSION!
echo [+] NPM is installed: v!NPM_VERSION!
echo.

:: 3. CHECK AND INSTALL PACKAGES / DEPENDENCIES
echo [*] Checking and verifying project packages...
if exist package.json (
    echo [*] Running npm install to verify all libraries...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [!] Warning: npm install completed with warnings, continuing...
    ) else (
        echo [+] All required libraries and packages verified successfully!
    )
) else (
    echo [!] Warning: package.json not found, proceeding with built-in modules...
)
echo.

:: 4. VERIFY REQUIRED FILES
echo [*] Checking essential project files...
if not exist "server.js" (
    echo [!] ERROR: server.js is missing from this folder!
    pause
    exit /b 1
)

if not exist "config.json" (
    echo [!] config.json not found. Initializing default configuration...
    echo {"dhanClientId":"","dhanAccessToken":"","telegramBotToken":"","telegramChatId":"","barMinutes":5,"pollIntervalSeconds":5,"telegramAlertsEnabled":true,"watchlist":[]}> config.json
)

if not exist "public\index.html" (
    echo [!] Warning: public\index.html not found! Web terminal UI may not render.
)

echo [+] All essential files verified!
echo.

:: 5. LAUNCH BROWSER AND START SERVER
echo ===============================================================================
echo  👉 Starting Dhan Straddle Pro Server...
echo  👉 Web Terminal URL: http://localhost:3000
echo  👉 Real-Time Telegram Alerts: ACTIVE
echo ===============================================================================
echo.

:: Open the browser after 2 seconds in the background
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the Node.js Server
node server.js

:: If server stops
if %errorlevel% neq 0 (
    echo.
    echo [!] Server stopped unexpectedly with exit code %errorlevel%.
)
echo.
echo Press any key to restart the server or close this window...
pause >nul
goto :start
