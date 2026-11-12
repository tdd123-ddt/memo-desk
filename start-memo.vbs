' ASCII-named launcher: cmd / batch files can safely reference this file
' without CJK encoding issues. Same behaviour as 启动备忘录.vbs.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' --no-sandbox is required on this machine (Chromium sandbox init fails silently)
shell.Run """" & here & "\node_modules\electron\dist\electron.exe"" . --no-sandbox", 0, False
