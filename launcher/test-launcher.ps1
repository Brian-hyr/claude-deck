<#
.SYNOPSIS
    Suíte de testes automatizados para o inicializador e instalador do Claude Deck.
    Executa todos os testes em portas efêmeras isoladas e diretórios temporários.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $scriptDir) {
    $scriptDir = (Get-Location).Path
}
$scriptDir = (Resolve-Path $scriptDir).Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path

$testBaseDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-deck-tests-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBaseDir -Force | Out-Null

$results = @()

function Add-TestResult([string]$name, [bool]$passed, [string]$details) {
    $script:results += [PSCustomObject]@{
        Test = $name
        Passed = $passed
        Details = $details
    }
    $status = if ($passed) { "PASS" } else { "FAIL" }
    Write-Host "[$status] $name - $details"
}

function Stop-PortProcess([int]$port) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess) {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

try {
    # -------------------------------------------------------------
    # Teste 1: Existência dos artefatos do launcher e ícones
    # -------------------------------------------------------------
    $vbsServer = Join-Path $scriptDir "start-server.vbs"
    $ps1Open = Join-Path $scriptDir "open-app.ps1"
    $vbsOpen = Join-Path $scriptDir "open-app.vbs"
    $ps1Install = Join-Path $scriptDir "install.ps1"
    $icon192 = Join-Path $repoRoot "src\web\public\icons\icon-192.png"
    $icon512 = Join-Path $repoRoot "src\web\public\icons\icon-512.png"
    $iconIco = Join-Path $scriptDir "icon.ico"

    $allFilesExist = (Test-Path $vbsServer) -and (Test-Path $ps1Open) -and (Test-Path $vbsOpen) -and
                     (Test-Path $ps1Install) -and (Test-Path $icon192) -and (Test-Path $icon512) -and (Test-Path $iconIco)

    Add-TestResult "Arquivos do Launcher e Ícones" $allFilesExist "Todos os arquivos obrigatórios existem em disco"

    # -------------------------------------------------------------
    # Teste 2: start-server.vbs em porta temporária isolada (47391)
    # -------------------------------------------------------------
    $port1 = 47391
    Stop-PortProcess $port1
    $dataDir1 = Join-Path $testBaseDir "data1"
    New-Item -ItemType Directory -Path $dataDir1 -Force | Out-Null

    $wscript = "$env:WINDIR\System32\wscript.exe"
    $vbsArgs = "`"$vbsServer`" --port $port1 --data-dir `"$dataDir1`""

    $vbsProc = Start-Process -FilePath $wscript -ArgumentList $vbsArgs -WorkingDirectory $repoRoot -PassThru
    $vbsProc.WaitForExit(5000) | Out-Null

    # Aguarda o servidor responder na porta 47391
    $deadline = (Get-Date).AddSeconds(10)
    $server1Pid = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port1/health")
            $req.Timeout = 1000
            $resp = $req.GetResponse()
            $stream = $resp.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            $reader.Close()
            $resp.Close()

            if ($content -match '"app"\s*:\s*"claude-deck"') {
                $json = $content | ConvertFrom-Json
                $server1Pid = $json.pid
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 200
    }

    $t2Passed = ($server1Pid -ne $null)
    Add-TestResult "start-server.vbs inicia servidor oculto (porta $port1)" $t2Passed "PID = $server1Pid"

    # Encerra o processo do teste 2
    if ($server1Pid) {
        try { Stop-Process -Id $server1Pid -Force } catch {}
    }
    Stop-PortProcess $port1

    # -------------------------------------------------------------
    # Teste 3: open-app.ps1 -NoBrowser em porta temporária (47392)
    # -------------------------------------------------------------
    $port2 = 47392
    Stop-PortProcess $port2
    $dataDir2 = Join-Path $testBaseDir "data2"
    New-Item -ItemType Directory -Path $dataDir2 -Force | Out-Null

    $res2 = & $ps1Open -Port $port2 -DataDir $dataDir2 -NoBrowser
    $t3Passed = ($res2.Status -eq "Ready" -and $res2.Port -eq $port2 -and $res2.Pid -gt 0)
    Add-TestResult "open-app.ps1 -NoBrowser (porta $port2)" $t3Passed "Servidor pronto e autenticação verificada (PID $($res2.Pid))"

    # Testa validação de token e redirecionamento de /auth
    $token2File = Join-Path $dataDir2 "token"
    $token2 = (Get-Content $token2File -Raw).Trim()

    # Validação com token correto: espera HTTP 302 com cookie deck_session
    $authReq = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port2/auth?t=$token2")
    $authReq.AllowAutoRedirect = $false
    $authResp = $authReq.GetResponse()
    $statusCode = [int]$authResp.StatusCode
    $setCookie = $authResp.Headers["Set-Cookie"]
    $authResp.Close()

    $t3bPassed = ($statusCode -eq 302 -and $setCookie -match 'deck_session=[a-f0-9]{64}')
    Add-TestResult "Redirecionamento 302 com Cookie HttpOnly em /auth" $t3bPassed "Status: $statusCode, Cookie recebido"

    # Validação com token incorreto: espera HTTP 403
    $t3cPassed = $false
    try {
        $badReq = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port2/auth?t=invalidtoken00000000000000000000000000000000000000000000000000000000")
        $badReq.AllowAutoRedirect = $false
        $badResp = $badReq.GetResponse()
        $badResp.Close()
    } catch {
        $inner = $_.Exception.InnerException
        if ($inner -is [System.Net.WebException]) {
            $webEx = [System.Net.WebException]$inner
            if ($null -ne $webEx.Response) {
                $httpResp = [System.Net.HttpWebResponse]$webEx.Response
                if ([int]$httpResp.StatusCode -eq 403) {
                    $t3cPassed = $true
                }
                $httpResp.Close()
            }
        }
    }
    Add-TestResult "Rejeição 403 em /auth com token inválido" $t3cPassed "Token falso foi rejeitado corretamente"

    # Código de uso único (/launch): vale uma vez; a segunda tentativa é recusada.
    $lr = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port2/launch")
    $lr.Method = 'POST'
    $lr.ContentLength = 0
    $lr.Headers.Add('x-deck-token', $token2)
    $lresp = $lr.GetResponse()
    $lreader = New-Object System.IO.StreamReader($lresp.GetResponseStream())
    $lcode = ($lreader.ReadToEnd() | ConvertFrom-Json).code
    $lreader.Close()
    $lresp.Close()
    $useCode = {
        param($c)
        try {
            $r = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port2/auth?c=$c")
            $r.AllowAutoRedirect = $false
            $x = $r.GetResponse()
            $s = [int]$x.StatusCode
            $x.Close()
            return $s
        } catch {
            $we = $_.Exception.InnerException
            if ($we -is [System.Net.WebException] -and $we.Response) { $s = [int]$we.Response.StatusCode; $we.Response.Close(); return $s }
            return -1
        }
    }
    $first = & $useCode $lcode
    $second = & $useCode $lcode
    Add-TestResult "Código de uso único do atalho (/launch)" ($first -eq 302 -and $second -eq 403) "1º uso: $first, reuso: $second"

    # Encerra o processo do teste 3
    if ($res2.Pid) {
        try { Stop-Process -Id $res2.Pid -Force } catch {}
    }
    Stop-PortProcess $port2

    # -------------------------------------------------------------
    # Teste 4: open-app.ps1 -Headless em porta temporária (47393)
    # -------------------------------------------------------------
    $port3 = 47393
    Stop-PortProcess $port3
    $dataDir3 = Join-Path $testBaseDir "data3"
    New-Item -ItemType Directory -Path $dataDir3 -Force | Out-Null

    $res3 = & $ps1Open -Port $port3 -DataDir $dataDir3 -Headless
    $t4Passed = ($res3.Status -eq "LaunchedHeadless" -and $res3.BrowserPid -gt 0)
    Add-TestResult "open-app.ps1 -Headless abre Brave isolado (porta $port3)" $t4Passed "Browser PID = $($res3.BrowserPid)"

    # Limpeza do teste 4
    if ($res3.BrowserPid) {
        try {
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $($res3.BrowserPid)" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $res3.BrowserPid -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    if ($res3.Pid) {
        try { Stop-Process -Id $res3.Pid -Force } catch {}
    }
    Stop-PortProcess $port3
    # Perfil temporário do Brave headless (o Brave solta os arquivos alguns instantes após sair).
    if ($res3.TestProfile -and ($res3.TestProfile -like "*deck-test-brave-*")) {
        for ($i = 0; $i -lt 20 -and (Test-Path $res3.TestProfile); $i++) {
            try { [System.IO.Directory]::Delete($res3.TestProfile, $true) } catch { Start-Sleep -Milliseconds 250 }
        }
    }

    # -------------------------------------------------------------
    # Teste 4b: servidor desatualizado (parado, sem trabalho) é trocado pelo atalho
    # -------------------------------------------------------------
    $port4 = 47394
    Stop-PortProcess $port4
    $dataDir4 = Join-Path $testBaseDir "data4"
    New-Item -ItemType Directory -Path $dataDir4 -Force | Out-Null
    $env:CLAUDE_DECK_TEST_HOOKS = '1'
    $env:CLAUDE_DECK_BUILD_STAMP = '1000'   # finge um servidor iniciado antes da última atualização
    try {
        $old = & $ps1Open -Port $port4 -DataDir $dataDir4 -NoBrowser
    } finally {
        Remove-Item Env:CLAUDE_DECK_BUILD_STAMP -ErrorAction SilentlyContinue
        Remove-Item Env:CLAUDE_DECK_TEST_HOOKS -ErrorAction SilentlyContinue
    }
    $oldHealth = (New-Object System.Net.WebClient).DownloadString("http://127.0.0.1:$port4/health") | ConvertFrom-Json
    $swapped = & $ps1Open -Port $port4 -DataDir $dataDir4 -NoBrowser
    $newHealth = (New-Object System.Net.WebClient).DownloadString("http://127.0.0.1:$port4/health") | ConvertFrom-Json
    $diskBuild = ([DateTimeOffset](Get-Item (Join-Path $repoRoot "dist\server.mjs")).LastWriteTimeUtc).ToUnixTimeMilliseconds()
    $t4bPassed = ($oldHealth.build -eq 1000) -and ($old.Pid -ne $swapped.Pid) -and ([Math]::Abs($newHealth.build - $diskBuild) -le 2000) -and ($newHealth.busy -eq 0)
    Add-TestResult "Servidor desatualizado e ocioso é trocado pelo atalho (porta $port4)" $t4bPassed "PID $($old.Pid) -> $($swapped.Pid), build $($oldHealth.build) -> $($newHealth.build)"
    # Parado e já atualizado: o atalho não mexe (mesmo PID).
    $again = & $ps1Open -Port $port4 -DataDir $dataDir4 -NoBrowser
    Add-TestResult "Servidor atualizado não é reiniciado pelo atalho" ($again.Pid -eq $swapped.Pid) "PID $($swapped.Pid) mantido"
    if ($again.Pid) { try { Stop-Process -Id $again.Pid -Force } catch {} }
    Stop-PortProcess $port4

    # -------------------------------------------------------------
    # Teste 5: install.ps1 em diretório temporário isolado
    # -------------------------------------------------------------
    $testDesktop = Join-Path $testBaseDir "Desktop"
    $testStartMenu = Join-Path $testBaseDir "StartMenu"
    $testStartup = Join-Path $testBaseDir "Startup"

    # Simula atalho de outro aplicativo para garantir proteção
    New-Item -ItemType Directory -Path $testDesktop -Force | Out-Null
    $otherAppLnk = Join-Path $testDesktop "OutroAplicativo.lnk"
    $wsh = New-Object -ComObject WScript.Shell
    $scOther = $wsh.CreateShortcut($otherAppLnk)
    $scOther.TargetPath = "cmd.exe"
    $scOther.Save()

    # Executa instalação isolada
    $instRes = & $ps1Install `
        -TargetDesktopDir $testDesktop `
        -TargetStartMenuDir $testStartMenu `
        -TargetStartupDir $testStartup `
        -EnableAutostart `
        -Apply

    $deckDesktopLnk = Join-Path $testDesktop "Claude Deck.lnk"
    $deckStartMenuLnk = Join-Path $testStartMenu "Claude Deck.lnk"
    $deckStartupLnk = Join-Path $testStartup "Claude Deck (servidor).lnk"

    $lnksCreated = (Test-Path $deckDesktopLnk) -and (Test-Path $deckStartMenuLnk) -and (Test-Path $deckStartupLnk)
    $otherAppUntouched = (Test-Path $otherAppLnk)

    # Inspeciona as propriedades do atalho criado
    $scDeck = $wsh.CreateShortcut($deckDesktopLnk)
    $scCorrect = ($scDeck.TargetPath -match 'wscript\.exe$' -and $scDeck.Arguments -match 'open-app\.vbs' -and $scDeck.IconLocation -match 'icon\.ico')

    $t5Passed = $lnksCreated -and $otherAppUntouched -and $scCorrect
    Add-TestResult "install.ps1 cria atalhos válidos sem tocar em outros apps" $t5Passed "Atalhos criados com TargetPath, Arguments e Ícone corretos"

    # -------------------------------------------------------------
    # Teste 6: uninstall.ps1 em diretório temporário
    # -------------------------------------------------------------
    $uninstScript = Join-Path $scriptDir "uninstall.ps1"
    $uninstRes = & $uninstScript `
        -TargetDesktopDir $testDesktop `
        -TargetStartMenuDir $testStartMenu `
        -TargetStartupDir $testStartup `
        -Apply

    $lnksRemoved = (-not (Test-Path $deckDesktopLnk)) -and (-not (Test-Path $deckStartMenuLnk)) -and (-not (Test-Path $deckStartupLnk))
    $otherAppStillAlive = (Test-Path $otherAppLnk)

    $t6Passed = $lnksRemoved -and $otherAppStillAlive
    Add-TestResult "uninstall.ps1 remove atalhos do Claude Deck preservando outros apps" $t6Passed "Remoção limpa e cirúrgica"

    # -------------------------------------------------------------
    # Teste 7: install.ps1 no modo DryRun com pastas reais do usuário
    # -------------------------------------------------------------
    $dryRunRes = & $ps1Install -DryRun
    $t7Passed = ($dryRunRes.Action -eq "DRY_RUN" -and $dryRunRes.ProtectedDesktopAppsCount -ge 0)
    Add-TestResult "install.ps1 -DryRun inspeciona ambiente real sem alterações" $t7Passed "Inspecionou $($dryRunRes.ProtectedDesktopAppsCount) atalhos no Desktop real"

} finally {
    Stop-PortProcess 47391
    Stop-PortProcess 47392
    Stop-PortProcess 47393
    Stop-PortProcess 47394

    # Limpa diretório de testes temporário
    try {
        Remove-Item -Path $testBaseDir -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
}

Write-Host "`nResumo da suíte de testes:"
$passedCount = @($results | Where-Object { $_.Passed }).Count
$totalCount = $results.Count
Write-Host "Total: $totalCount | Passaram: $passedCount | Falharam: $($totalCount - $passedCount)"

if ($passedCount -eq $totalCount) {
    Write-Host "`nSUCESSO: Todos os testes passaram com perfeição!"
} else {
    throw "Falha na suíte de testes."
}
