' Claude Deck - Atalho silencioso para abrir o aplicativo sem piscar tela preta de console
Option Explicit

Dim fso, shell, scriptDir, ps1File, cmd, i, args

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1File = fso.BuildPath(scriptDir, "open-app.ps1")

If Not fso.FileExists(ps1File) Then
  WScript.Echo "Erro: open-app.ps1 nao encontrado em " & scriptDir
  WScript.Quit 1
End If

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & """" & WScript.Arguments(i) & """"
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1File & """" & args

' 0 = Janela oculta, False = Assincrono
shell.Run cmd, 0, False
