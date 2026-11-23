@echo off
setlocal
cd /d "%~dp0"
set PORT=8000
set URL=http://localhost:%PORT%

:menu
cls
echo ==========================================
echo    Disaster SOS and Triage PWA - Launcher
echo ==========================================
echo  1. Install everything (Python + dependencies)
echo  2. Start server and open citizen page
echo  3. Start server and open dashboard
echo  4. Stop server
echo  5. Reset database (delete all reports)
echo  6. Exit
echo ==========================================
set /p choice=Choose an option (1-6): 
if "%choice%"=="1" goto install
if "%choice%"=="2" goto citizen
if "%choice%"=="3" goto dashboard
if "%choice%"=="4" goto stop
if "%choice%"=="5" goto reset
if "%choice%"=="6" exit /b
goto menu

:install
call :ensure_all
pause
goto menu

:citizen
set "PAGE=index-online.html"
goto start

:dashboard
set "PAGE=dashboard.html"
goto start

:start
call :check_venv
if errorlevel 1 (
  echo First run: setting everything up...
  call :ensure_all
  if errorlevel 1 ( pause & goto menu )
  call :check_venv
  if errorlevel 1 ( pause & goto menu )
)
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if errorlevel 1 (
  start "SOS Server" /D "%~dp0backend" cmd /k "..\.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port %PORT%"
  echo Starting server...
  timeout /t 3 /nobreak >nul
) else (
  echo Server already running on port %PORT%.
)
start "" "%URL%/%PAGE%"
echo Opened %URL%/%PAGE%
timeout /t 2 /nobreak >nul
goto menu

:ensure_all
call :find_python
if not defined PY (
  echo Python not found. Installing Python 3.12 for the current user...
  call :install_python
  call :find_python
)
if not defined PY (
  echo.
  echo Could not install Python automatically.
  echo Install it from https://www.python.org/downloads/ and run this file again.
  exit /b 1
)
echo Using Python: %PY%
call :check_venv
if errorlevel 1 (
  if exist ".venv" rmdir /s /q ".venv"
  %PY% -m venv .venv
)
call :check_venv
if errorlevel 1 (
  echo Failed to create the virtual environment.
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt
if errorlevel 1 (
  echo Dependency installation failed. Check your internet connection.
  exit /b 1
)
echo.
echo Everything is installed.
exit /b 0

:find_python
set "PY="
where py >nul 2>&1
if not errorlevel 1 (
  py -3 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 (
    python --version >nul 2>&1
    if not errorlevel 1 set "PY=python"
  )
)
if not defined PY (
  for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$keys=@('HKCU:\Software\Python\PythonCore\*\InstallPath','HKLM:\Software\Python\PythonCore\*\InstallPath','HKLM:\Software\WOW6432Node\Python\PythonCore\*\InstallPath'); foreach($k in $keys){ Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { $p=Join-Path $_.PSPath 'python.exe'; if(Test-Path $p){ $p; exit } } }" 2^>nul') do if not defined PY set "PY=%%P"
)
if defined PY if exist "%PY%" set "PY=""%PY%""
exit /b 0

:check_venv
if not exist ".venv\Scripts\python.exe" exit /b 1
".venv\Scripts\python.exe" --version >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:install_python
where winget >nul 2>&1
if not errorlevel 1 (
  winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
)
call :find_python
if defined PY exit /b 0
echo Downloading the Python installer from python.org...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile '%TEMP%\py-setup.exe'"
if exist "%TEMP%\py-setup.exe" (
  start /wait "" "%TEMP%\py-setup.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=0
  del /q "%TEMP%\py-setup.exe" 2>nul
)
exit /b 0

:stop
taskkill /FI "WINDOWTITLE eq SOS Server*" /T /F >nul 2>&1
echo Server stopped if it was running.
pause
goto menu

:reset
set /p sure=Delete all stored SOS reports? Type YES to confirm: 
if /I not "%sure%"=="YES" goto menu
taskkill /FI "WINDOWTITLE eq SOS Server*" /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
del /q backend\sos.db 2>nul
echo Database deleted. A new one is created on next start.
pause
goto menu
