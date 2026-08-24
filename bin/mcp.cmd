@echo off
rem MCP server entry point (Windows). Never invokes bare `bash` (WSL stub trap).
rem Prefers the plugin's staged bun, then the cached bun that survives updates,
rem then an explicitly located Git Bash running bun.sh.
set "ROOT=%~dp0.."
if exist "%ROOT%\runtime\bun.exe" (
  "%ROOT%\runtime\bun.exe" "%ROOT%\src\mcp-launch.ts"
  exit /b
)
for /d %%D in ("%USERPROFILE%\.recall\runtime\bun-v*") do (
  if exist "%%D\bun.exe" (
    "%%D\bun.exe" "%ROOT%\src\mcp-launch.ts"
    exit /b
  )
)
for %%B in ("%ProgramFiles%\Git\bin\bash.exe" "%ProgramFiles(x86)%\Git\bin\bash.exe" "%LocalAppData%\Programs\Git\bin\bash.exe") do (
  if exist "%%~B" (
    "%%~B" "%ROOT%/bin/bun.sh" "%ROOT%/src/mcp-launch.ts"
    exit /b
  )
)
echo recall: no Bun runtime found; start one Claude Code session to stage it, then reconnect. 1>&2
exit /b 1
