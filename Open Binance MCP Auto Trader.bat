@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "APP_URL=http://127.0.0.1:3001"
set "APP_PORT=3001"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Install Node.js with npm, then run this launcher again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo Creating .env from .env.example...
  copy ".env.example" ".env" >nul
)

if not exist "dist\server\http.js" (
  echo Building the app...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %APP_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo Starting Binance MCP Auto Trader...
  start "Binance MCP Auto Trader API" cmd /k "chcp 65001 >nul && cd /d ""%~dp0"" && npm run start"
  timeout /t 5 /nobreak >nul
) else (
  echo Server is already running on port %APP_PORT%.
)

echo Opening %APP_URL%
start "" "%APP_URL%"

endlocal
