<#
.SYNOPSIS
    Inicia o Claude Deck (servidor Node oculto + navegador em modo aplicativo ou dedicado).

.DESCRIPTION
    Verifica se o servidor local está em execução na porta configurada (padrão 47319).
    Se não estiver, inicia-o em segundo plano (janela oculta).
    Lê o token de autenticação de %APPDATA%\claude-deck\token e abre o navegador
    selecionado (Brave, Edge, Chrome ou Firefox) autenticando com segurança via
    código de uso único (/launch).
    Usa um perfil próprio do Claude Deck dentro de DataDir (browser-profile para Brave,
    browser-profile-<id> para outros), isolado do perfil do dia a dia do usuário.
    Com o app já aberto, abre uma janela nova e vazia (sem servidor escolhido).
    Com tudo fechado (ex.: depois de ligar o PC), abre uma janela e o servidor reabre as demais que
    estavam abertas, cada uma com as suas abas. Há uma janela por servidor + pasta.

.PARAMETER Port
    Porta de escuta do servidor (padrão: 47319 ou $env:CLAUDE_DECK_PORT).

.PARAMETER DataDir
    Diretório de dados persistentes do app (padrão: %APPDATA%\claude-deck).

.PARAMETER NoBrowser
    Inicia e valida o servidor, mas não abre o navegador.

.PARAMETER Headless
    Abre o navegador em modo headless com perfil temporário (para testes automatizados).

.PARAMETER TimeoutSeconds
    Tempo limite em segundos para aguardar o servidor responder ao /health.
#>

[CmdletBinding()]
param(
    [int]$Port = 47319,
    [string]$DataDir = "",
    [switch]$NoBrowser,
    [switch]$Headless,
    [int]$TimeoutSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Show-LauncherError([string]$title, [string]$message) {
    if (-not $Headless -and -not $NoBrowser -and -not $env:CLAUDE_DECK_TEST_HOOKS) {
        try {
            $ws = New-Object -ComObject WScript.Shell
            $ws.Popup($message, 12, "Claude Deck - $title", 16) | Out-Null
        } catch {}
    }
}

# Resolução de portas e diretórios
if ($Port -eq 47319 -and $env:CLAUDE_DECK_PORT) {
    $Port = [int]$env:CLAUDE_DECK_PORT
}

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $scriptDir) {
    $scriptDir = (Get-Location).Path
}
$scriptDir = (Resolve-Path $scriptDir).Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path

if (-not $DataDir) {
    if ($env:CLAUDE_DECK_DATA) {
        $DataDir = $env:CLAUDE_DECK_DATA
    } else {
        $DataDir = Join-Path $env:APPDATA "claude-deck"
    }
}

$tokenFile = Join-Path $DataDir "token"
$browserJsonPath = Join-Path $DataDir "browser.json"
$serverMjs = Join-Path $repoRoot "dist\server.mjs"
$startVbs = Join-Path $scriptDir "start-server.vbs"

function Get-BrowserCandidates([string]$id) {
    $list = @()
    switch ($id) {
        'brave' {
            if ($env:LOCALAPPDATA) { $list += "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe" }
            if ($env:ProgramFiles) { $list += "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe" }
            if (${env:ProgramFiles(x86)}) { $list += "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe" }
            if ($env:ProgramW6432) { $list += "$env:ProgramW6432\BraveSoftware\Brave-Browser\Application\brave.exe" }
        }
        'edge' {
            if ($env:ProgramFiles) { $list += "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
            if (${env:ProgramFiles(x86)}) { $list += "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
            if ($env:LOCALAPPDATA) { $list += "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe" }
            if ($env:ProgramW6432) { $list += "$env:ProgramW6432\Microsoft\Edge\Application\msedge.exe" }
        }
        'chrome' {
            if ($env:ProgramFiles) { $list += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" }
            if (${env:ProgramFiles(x86)}) { $list += "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
            if ($env:LOCALAPPDATA) { $list += "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" }
            if ($env:ProgramW6432) { $list += "$env:ProgramW6432\Google\Chrome\Application\chrome.exe" }
        }
        'firefox' {
            if ($env:ProgramFiles) { $list += "$env:ProgramFiles\Mozilla Firefox\firefox.exe" }
            if (${env:ProgramFiles(x86)}) { $list += "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe" }
            if ($env:LOCALAPPDATA) { $list += "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe" }
            if ($env:ProgramW6432) { $list += "$env:ProgramW6432\Mozilla Firefox\firefox.exe" }
        }
    }
    return $list
}

function Test-BrowserIdentity([string]$exePath, [string]$expectedName, [string]$expectedIdentity) {
    if (-not (Test-Path $exePath)) { return $false }
    $item = Get-Item $exePath -ErrorAction SilentlyContinue
    if (-not $item -or $item.PSIsContainer) { return $false }
    if ($item.Name -ne $expectedName) { return $false }
    try {
        $vi = $item.VersionInfo
        $prod = [string]$vi.ProductName
        $desc = [string]$vi.FileDescription
        return ($prod -like "*$expectedIdentity*" -or $desc -like "*$expectedIdentity*")
    } catch {
        return $false
    }
}

function Find-BrowserExecutable([string]$browserId) {
    $browserId = $browserId.ToLowerInvariant()
    $expectedName = ""
    $expectedId = ""

    switch ($browserId) {
        'brave' {
            $expectedName = "brave.exe"
            $expectedId = "Brave"
        }
        'edge' {
            $expectedName = "msedge.exe"
            $expectedId = "Edge"
        }
        'chrome' {
            $expectedName = "chrome.exe"
            $expectedId = "Chrome"
        }
        'firefox' {
            $expectedName = "firefox.exe"
            $expectedId = "Firefox"
        }
        default { return $null }
    }

    $candidates = Get-BrowserCandidates $browserId
    foreach ($p in $candidates) {
        if ($p -and (Test-BrowserIdentity $p $expectedName $expectedId)) {
            return $p
        }
    }
    return $null
}

function Get-BrowserProfileDir([string]$browserId, [string]$baseDataDir) {
    if ($browserId.ToLowerInvariant() -eq 'brave') {
        return Join-Path $baseDataDir "browser-profile"
    } else {
        return Join-Path $baseDataDir "browser-profile-$($browserId.ToLowerInvariant())"
    }
}

# Resolução do navegador a utilizar
$chosenBrowser = $null
$browserExplicit = $false

if (Test-Path $browserJsonPath) {
    try {
        $raw = Get-Content -Path $browserJsonPath -Raw -Encoding utf8 -ErrorAction Stop
        $cfg = $raw | ConvertFrom-Json
        if (-not $cfg -or -not $cfg.PSObject.Properties['browser'] -or
            [string]$cfg.browser -cnotin @('brave', 'edge', 'chrome', 'firefox')) {
            throw 'Escolha inválida'
        }
        $chosenBrowser = [string]$cfg.browser
        $browserExplicit = $true
    } catch {
        $errMsg = "browser.json inválido. Reconfigure com: launcher\install.ps1 -Apply -Browser brave|edge|chrome|firefox"
        Show-LauncherError 'Navegador Inválido' $errMsg
        throw $errMsg
    }
}

if (-not $chosenBrowser) {
    # Fallback padrão: Brave se instalado, senão Edge, Chrome, Firefox
    foreach ($cand in @('brave', 'edge', 'chrome', 'firefox')) {
        if (Find-BrowserExecutable $cand) {
            $chosenBrowser = $cand
            break
        }
    }
    if (-not $chosenBrowser) {
        $chosenBrowser = 'brave'
    }
}

$profileDir = Get-BrowserProfileDir $chosenBrowser $DataDir

function Get-ServerHealth([int]$p) {
    try {
        $uri = "http://127.0.0.1:$p/health"
        $req = [System.Net.HttpWebRequest]::Create($uri)
        $req.Timeout = 1500
        $resp = $req.GetResponse()
        $stream = $resp.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()

        if ($content -match '"app"\s*:\s*"claude-deck"') {
            return ($content | ConvertFrom-Json)
        }
    } catch {
        # Servidor não respondeu ou porta fechada
    }
    return $null
}

# 1. Verifica se o servidor já está ativo
$health = Get-ServerHealth $Port

# 1.5. O servidor fica rodando em segundo plano entre uma janela e outra. Depois de uma atualização
#      (dist\server.mjs mais novo que o programa em execução), a interface nova não conversa com o
#      servidor velho. Se ele não está trabalhando em nada, troca por um novo; se está, deixa quieto
#      (a interface avisa) para não derrubar uma conversa ou transferência no meio.
if ($health -and (Test-Path $serverMjs)) {
    $diskBuild = ([DateTimeOffset](Get-Item $serverMjs).LastWriteTimeUtc).ToUnixTimeMilliseconds()
    $hasBuild = [bool]$health.PSObject.Properties['build']
    $runBuild = if ($hasBuild) { [long]$health.build } else { 0 }
    $stale = (-not $hasBuild) -or ($runBuild -gt 0 -and [Math]::Abs($diskBuild - $runBuild) -gt 2000)
    $busyKnown = [bool]$health.PSObject.Properties['busy']
    if ($stale -and $busyKnown -and [int]$health.busy -eq 0) {
        $nodeExe = "node"
        if (Test-Path "C:\Program Files\nodejs\node.exe") { $nodeExe = "C:\Program Files\nodejs\node.exe" }
        & $nodeExe (Join-Path $scriptDir "stop-server.mjs") --port $Port --data-dir $DataDir | Out-Null
        $health = Get-ServerHealth $Port
    }
}

if (-not $health) {
    # 2. Inicia o servidor oculto
    if (-not (Test-Path $serverMjs)) {
        $errMsg = "Arquivo dist\server.mjs não encontrado. Execute 'npm run build' primeiro."
        Show-LauncherError "Compilação Necessária" $errMsg
        throw $errMsg
    }

    if (Test-Path $startVbs) {
        $vbsArgs = "`"$startVbs`""
        Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList "$vbsArgs --port $Port --data-dir `"$DataDir`"" -WorkingDirectory $repoRoot -WindowStyle Hidden
    } else {
        # Fallback direto via node.exe caso o VBS não exista
        $nodeExe = "node"
        if (Test-Path "C:\Program Files\nodejs\node.exe") {
            $nodeExe = "C:\Program Files\nodejs\node.exe"
        }
        $nodeArgs = @("`"$serverMjs`"", "--port", "$Port", "--data-dir", "`"$DataDir`"")
        Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $repoRoot -WindowStyle Hidden
    }

    # 3. Aguarda o servidor responder com sucesso
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-ServerHealth $Port
        if ($health) { break }
        Start-Sleep -Milliseconds 200
    }

    if (-not $health) {
        $errMsg = "Servidor Claude Deck não respondeu na porta $Port dentro de $TimeoutSeconds segundos."
        Show-LauncherError "Falha ao Iniciar Servidor" $errMsg
        throw $errMsg
    }
}

# 4. Obtém o token de autenticação
$token = ""
$tokenDeadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $tokenDeadline) {
    if (Test-Path $tokenFile) {
        $raw = Get-Content -Path $tokenFile -Raw -Encoding utf8 -ErrorAction SilentlyContinue
        if ($raw) {
            $trimmed = $raw.Trim()
            if ($trimmed -match '^[a-f0-9]{64}$') {
                $token = $trimmed
                break
            }
        }
    }
    Start-Sleep -Milliseconds 150
}

if (-not $token) {
    $errMsg = "Token de autenticação não encontrado ou inválido em: $tokenFile"
    Show-LauncherError "Erro de Autenticação" $errMsg
    throw $errMsg
}

# 5. Se foi pedido apenas validar o servidor sem abrir navegador
if ($NoBrowser) {
    [PSCustomObject]@{
        Status = "Ready"
        Port = $Port
        Pid = $health.pid
        Version = $health.version
    }
    return
}

# 6. Localiza o executável do navegador escolhido
$browserExe = Find-BrowserExecutable $chosenBrowser

if (-not $browserExe) {
    if ($browserExplicit) {
        $errMsg = "O navegador configurado ('$chosenBrowser') não foi encontrado nos caminhos padrão do Windows.`n`nInstale o navegador ou reconfigure executando:`npowershell -File launcher\install.ps1 -Apply -Browser <id>"
    } else {
        $errMsg = "Nenhum navegador compatível (Brave, Edge, Chrome ou Firefox) foi encontrado no sistema.`n`nInstale um dos navegadores para abrir o Claude Deck."
    }
    Show-LauncherError "Navegador Não Encontrado" $errMsg
    throw $errMsg
}

# 7. Troca o token por um código de uso único (60 s): o token não fica no histórico do navegador.
$targetUrl = $null
try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/launch")
    $req.Method = 'POST'
    $req.Timeout = 3000
    $req.ContentLength = 0
    $req.Headers.Add('x-deck-token', $token)
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    $resp.Close()
    $code = ($body | ConvertFrom-Json).code
    if ($code -match '^[a-f0-9]{48}$') { $targetUrl = "http://127.0.0.1:$Port/auth?c=$code" }
} catch {
    # Servidor de versão antiga sem endpoint /launch
}

if (-not $targetUrl) {
    if ($chosenBrowser -eq 'brave') {
        # Preserva comportamento antigo exclusivamente para o Brave
        $targetUrl = "http://127.0.0.1:$Port/auth?t=$token"
    } else {
        # Para outros navegadores, impede vazar o token mestre na URL
        $errMsg = "O servidor Claude Deck não suporta código de uso único (/launch). Para usar o navegador '$chosenBrowser' com segurança sem expor o token na URL, atualize o Claude Deck ('npm run build') e reinicie o servidor."
        Show-LauncherError "Segurança de Autenticação" $errMsg
        throw $errMsg
    }
}

if ($Headless) {
    $tempProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("deck-test-brave-" + [System.Guid]::NewGuid().ToString('N'))
    $headlessArgs = if ($chosenBrowser -eq 'firefox') {
        @("-headless", "-profile", "`"$tempProfile`"", "`"$targetUrl`"")
    } else {
        @("--headless=new", "--user-data-dir=`"$tempProfile`"", "--app=`"$targetUrl`"")
    }
    $proc = Start-Process -FilePath $browserExe -ArgumentList $headlessArgs -PassThru -WindowStyle Hidden
    [PSCustomObject]@{
        Status = "LaunchedHeadless"
        Port = $Port
        Pid = $health.pid
        BrowserPid = $proc.Id
        TestProfile = $tempProfile
        Browser = $chosenBrowser
    }
    return
} else {
    # Com o app já aberto: o atalho abre uma janela NOVA e vazia, sem servidor.
    # O "#nova" faz a página criar o próprio id de janela, o que vale até com um servidor de versão
    # anterior ainda rodando. Com tudo fechado, a URL vai sem "#nova" e o servidor reabre as janelas salvas.
    $liveCount = 0
    if ($health.PSObject.Properties['live']) { $liveCount = [int]$health.live }
    if ($liveCount -gt 0) { $targetUrl = "$targetUrl#nova" }

    if ($chosenBrowser -eq 'firefox') {
        if (-not (Test-Path $profileDir)) {
            New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        }
        # Firefox: -profile <dir> e -new-window URL (sem -no-remote, janela separada)
        $browserArgs = @(
            "-profile", "`"$profileDir`"",
            "-new-window", "`"$targetUrl`""
        )
    } else {
        # Chromium (Brave, Edge, Chrome): --app com perfil isolado --user-data-dir
        $browserArgs = @(
            "--user-data-dir=`"$profileDir`"",
            "--no-first-run",
            "--no-default-browser-check",
            "--autoplay-policy=no-user-gesture-required",
            "--lang=pt-BR"
        )
        if ($chosenBrowser -eq 'brave') {
            $browserArgs += "--disable-features=BraveRewards"
        }
        $browserArgs += "--app=`"$targetUrl`""
    }

    Start-Process -FilePath $browserExe -ArgumentList $browserArgs -WindowStyle Normal
    $status = if ($liveCount -gt 0) { "LaunchedNew" } else { "Launched" }
    [PSCustomObject]@{
        Status = $status
        Port = $Port
        Pid = $health.pid
        ProfileDir = $profileDir
        Browser = $chosenBrowser
    }
}
