@echo off
rem atelier for cmd.exe and PowerShell, which cannot run the extensionless
rem bin/atelier. Runs node on the script next to this file.
rem
rem cmd.exe parses a command line before the batch file on it starts.
rem PowerShell, when you type atelier, starts this file itself and quotes
rem arguments for a program and not for cmd, so cmd used to cut a URL at its
rem first ampersand, expand percent variables, drop carets and run the rest
rem of the line as a command. For PowerShell and other .NET programs Windows
rem starts cmd.exe as
rem     cmd.exe /c ""this file" arguments"
rem with /c as the only switch. In exactly that case the arguments are read
rem unparsed from CMDCMDLINE and handed to node as they are, and cmd.exe
rem exits before it runs anything it split off. A line of that form written
rem by hand is treated the same. Put /d before /c to keep cmd syntax there.
rem
rem Still open, because cmd acts on it before this file runs: a pipe or
rem redirection character in an argument that has no space in it. From
rem PowerShell, run node with the path of bin/atelier for such an argument.
rem
rem Every other caller gets the plain forward at the end, where cmd syntax
rem applies: a cmd prompt, a batch file, cmd /d /s /c. Quote arguments there.
rem Git Bash also lands there when it is given atelier.cmd by name. Plain
rem atelier runs the node script without this file.
setlocal EnableExtensions DisableDelayedExpansion
set "ATELIER_SHIM_SELF=%~0"
set "ATELIER_SHIM_BIN=%~dp0atelier"
setlocal EnableDelayedExpansion
rem A copy first: a substitution made on CMDCMDLINE itself rewrites it for the
rem rest of the cmd.exe session. Then the line from its first switch on, what
rem follows the quoted name of this file, and that without the closing quote.
set "ATELIER_SHIM_LINE=!CMDCMDLINE!"
set "ATELIER_SHIM_LINE=!ATELIER_SHIM_LINE:* /=!"
set "ATELIER_SHIM_ARGS=!ATELIER_SHIM_LINE:*%~nx0"=!"
set "ATELIER_SHIM_ARGS=!ATELIER_SHIM_ARGS:~0,-1!"
if /i "!ATELIER_SHIM_LINE!"=="c ""!ATELIER_SHIM_SELF!"!ATELIER_SHIM_ARGS!"" goto direct
endlocal
set "ATELIER_SHIM_SELF="
set "ATELIER_SHIM_BIN="
node "%~dp0atelier" %*
exit /b %errorlevel%

:direct
set "ATELIER_SHIM_SELF="
set "ATELIER_SHIM_LINE="
node "!ATELIER_SHIM_BIN!"!ATELIER_SHIM_ARGS!
exit %errorlevel%
