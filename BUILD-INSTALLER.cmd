@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
if errorlevel 1 (
  echo Build FAILED. See the error above. No installer has been installed.
  pause
  exit /b 1
)
echo Installer: release\JarvisCodeSetup.exe
pause
