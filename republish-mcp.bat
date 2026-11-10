@echo off
REM SAAX Protocol — MCP Registry re-publish helper.
REM Eliminates the 5-minute JWT race: login must be immediately followed by publish.
REM Run this from the project root. Complete the GitHub device code when prompted.
cd /d "%~dp0"
echo [1/3] Validating server.json...
.\mcp-publisher.exe validate || (echo VALIDATE FAILED & pause & exit /b 1)
echo [2/3] Logging in via GitHub (complete the device code, then wait)...
.\mcp-publisher.exe login github || (echo LOGIN FAILED & pause & exit /b 1)
echo [3/3] Publishing immediately (within the JWT window)...
.\mcp-publisher.exe publish
echo.
echo Done. Check the output above for the listing result.
pause