@echo off
REM Starts the console's worker. Point a Windows scheduled task at this file
REM to run it at logon (e.g. "hbs-chief-of-staff worker", repeating every ten
REM minutes with "do not start a new instance"); it is also safe to
REM double-click to start it by hand. Paths are relative to this file (%~dp0),
REM so it works wherever the project lives.
REM
REM Node is invoked by full path rather than relying on PATH: a scheduled task
REM at logon can run before the user environment is fully assembled, and "npm
REM is not recognised" was the very first thing that went wrong on this machine.

setlocal

set "PROJECT=%~dp0.."
cd /d "%PROJECT%" || exit /b 1

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%PROJECT%\worker\logs" mkdir "%PROJECT%\worker\logs"

REM One rolling log, appended. Dating the filename from %DATE% is a trap:
REM its format follows the machine's locale, and the first attempt produced
REM "worker-21-Mon-09.log". The loop timestamps every line anyway.
"%NODE%" worker\loop.mjs >> "%PROJECT%\worker\logs\worker.log" 2>&1

endlocal
