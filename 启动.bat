@echo off
rem Pi 桌面版启动脚本：先构建渲染端 bundle，再启动 Electron
cd /d "%~dp0"
call npx esbuild renderer/app.js --bundle --format=iife --outfile=renderer/app.bundle.js
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
