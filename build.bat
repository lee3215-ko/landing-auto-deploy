@echo off
setlocal
cd /d "%~dp0"
echo [build] npm run dist:dir
call npm run dist:dir
if errorlevel 1 exit /b 1
if not exist "dist-publish\win-unpacked\Landing Auto Deploy.exe" (
  echo [build] ERROR: dist-publish\win-unpacked missing
  exit /b 1
)
echo [build] prepare release\LandingAutoDeploy
if exist "release\LandingAutoDeploy" rmdir /s /q "release\LandingAutoDeploy"
mkdir "release\LandingAutoDeploy" 2>nul
xcopy /e /i /y /q "dist-publish\win-unpacked\*" "release\LandingAutoDeploy\"
if errorlevel 1 exit /b 1
echo [build] OK
exit /b 0