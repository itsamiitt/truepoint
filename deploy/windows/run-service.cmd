@echo off
rem run-service.cmd <package-filter> — native Windows service entry for one TruePoint workspace app.
rem Loads .env.production the way compose env_file does (first '=' splits, value taken literally),
rem then execs `bun run --filter <pkg> start`. Extra per-service env comes in via NSSM AppEnvironmentExtra.
cd /d C:\Users\Administrator\Downloads\DuskWolf
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env.production") do set "%%A=%%B"
set "NODE_ENV=production"
"C:\Users\Administrator\.bun\bin\bun.exe" run --filter %1 start
