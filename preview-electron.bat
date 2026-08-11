@echo off
rem 以 PinK 的 Electron Node 模式启动 cocos-cli preview（ABI 146，与 CocosHost 一致）
rem 用法: preview-electron.bat [cli.js 参数...]
setlocal
set ELECTRON_RUN_AS_NODE=1
set "PINK_ELECTRON=C:\Users\Administrator\Code\SUD-GLOBAL\PinK\.build\electron\PinK.exe"
set "CLI_JS=%~dp0..\dist\cli.js"
if not exist "%PINK_ELECTRON%" (
    echo [ERROR] Electron not found: %PINK_ELECTRON%
    exit /b 1
)
"%PINK_ELECTRON%" "%CLI_JS%" preview %*
exit /b %errorlevel%
