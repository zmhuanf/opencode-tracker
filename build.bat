@echo off
setlocal

set ROOT=%~dp0

if exist "%ROOT%out" rmdir /s /q "%ROOT%out"
mkdir "%ROOT%out"

echo [1/3] Building frontend...
pushd "%ROOT%web"
call npm run build
if errorlevel 1 (
    echo Frontend build failed.
    popd
    exit /b 1
)
popd

mkdir "%ROOT%out\web"
xcopy /e /i /y "%ROOT%web\dist" "%ROOT%out\web\dist" >nul

echo [2/3] Building backend...
pushd "%ROOT%"
go build -o out\opencode-tracker.exe
if errorlevel 1 (
    echo Backend build failed.
    popd
    exit /b 1
)
popd

echo [3/3] Copying assets...
copy /y "%ROOT%pricing.json" "%ROOT%out\" >nul

echo Done. Output: out
endlocal
