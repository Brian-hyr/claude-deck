' Claude Deck - Inicia o servidor Node em segundo plano (oculto)
' Suporta execucao pelo atalho da pasta Inicializar (autostart) ou manual
Option Explicit

Dim fso, shell, scriptDir, repoRoot, serverMjs, nodeExe, cmd, i, args

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
serverMjs = fso.BuildPath(repoRoot, "dist\server.mjs")

If Not fso.FileExists(serverMjs) Then
  WScript.Echo "Erro: dist\server.mjs nao encontrado. Execute 'npm run build' primeiro."
  WScript.Quit 1
End If

' Localiza o executavel do Node.js
nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\node\node.exe")) Then
  nodeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\node\node.exe")
End If

' Repassa argumentos opcionais passados ao VBS (ex: --port 47319 --data-dir ...)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & """" & WScript.Arguments(i) & """"
Next

shell.CurrentDirectory = repoRoot
cmd = """" & nodeExe & """ """ & serverMjs & """" & args

' 0 = Janela oculta (sem janela de console preta)
' False = Executa de forma assincrona (nao trava o chamador)
shell.Run cmd, 0, False
