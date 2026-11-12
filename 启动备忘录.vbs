Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' --no-sandbox: on some Windows machines Chromium's sandbox fails to initialize,
' causing electron.exe to exit silently (exit code 3, no error, no window).
' This app only loads local HTML (no remote content), so disabling the
' renderer sandbox has no practical security cost here.
' Keep this flag on EVERY launch entry, incl. autostart and desktop shortcut
' (both point to this file).
shell.Run """" & here & "\node_modules\electron\dist\electron.exe"" . --no-sandbox", 0, False
