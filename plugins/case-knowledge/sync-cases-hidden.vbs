' Executa o sync-cases.mjs sem abrir janela de console.
' Uso: wscript.exe sync-cases-hidden.vbs <node.exe> <sync-cases.mjs>
'
' A tarefa agendada (CaseKnowledge-SyncCases) roda este wrapper porque uma
' Action que executa node.exe direto em sessao interativa SEMPRE abre uma
' janela de console (flash de 1-2s a cada sync). WScript.Shell.Run com
' intWindowStyle=0 executa oculto; bWaitOnReturn=True mantem o wscript vivo
' pela duracao do sync, preservando ExecutionTimeLimit e MultipleInstances
' da task para o processo real.
Option Explicit
Dim sh, cmd
If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If
Set sh = CreateObject("WScript.Shell")
cmd = """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """"
WScript.Quit sh.Run(cmd, 0, True)
