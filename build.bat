@echo off
setlocal
cd /d "%~dp0"
REM 실행 중인 로컬 앱(dist-publish\win-unpacked)을 덮어쓰지 않도록 별도 폴더에 빌드
set BUILD_OUT=dist-publish-build
echo [build] npm run sync:engine + build:cli + electron-builder -^> %BUILD_OUT%
call npm run sync:engine
if errorlevel 1 exit /b 1
call npm run build:cli
if errorlevel 1 exit /b 1
call npx electron-builder --win --dir -c.directories.output=%BUILD_OUT%
if errorlevel 1 exit /b 1
if not exist "%BUILD_OUT%\win-unpacked\Landing Auto Deploy.exe" (
  echo [build] ERROR: %BUILD_OUT%\win-unpacked missing
  exit /b 1
)
echo [build] prepare release\LandingAutoDeploy
if exist "release\LandingAutoDeploy" rmdir /s /q "release\LandingAutoDeploy"
mkdir "release\LandingAutoDeploy" 2>nul
xcopy /e /i /y /q "%BUILD_OUT%\win-unpacked\*" "release\LandingAutoDeploy\"
if errorlevel 1 exit /b 1
echo [build] OK (running dist-publish app was not overwritten)
exit /b 0
