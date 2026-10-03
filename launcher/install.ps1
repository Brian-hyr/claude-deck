<#
.SYNOPSIS
    Instalador de atalhos e configuração de navegador do Claude Deck para Windows.

.DESCRIPTION
    Cria ou atualiza com segurança os atalhos do Claude Deck na Área de Trabalho
    e no Menu Iniciar. Inspeciona atalhos existentes antes de sobrescrever e
    garante isolamento total sem tocar em outros aplicativos instalados.
    Permite selecionar o navegador (Brave, Edge, Chrome ou Firefox) com perfil
    dedicado e isolado em %APPDATA%\claude-deck.

.PARAMETER Apply
    Executa a criação real dos atalhos e gravação da configuração. Por padrão (sem -Apply),
    roda em modo DryRun/Inspeção para validação e revisão segura.

.PARAMETER DryRun
    Força modo somente-inspeção (não faz alterações em disco).

.PARAMETER TargetDesktopDir
    Diretório alternativo para o atalho da Área de Trabalho (usado para testes).

.PARAMETER TargetStartMenuDir
    Diretório alternativo para o atalho do Menu Iniciar (usado para testes).

.PARAMETER TargetStartupDir
    Diretório alternativo para o atalho de Inicialização (usado para testes).

.PARAMETER EnableAutostart
    Também cria o atalho do servidor na pasta Inicializar do Windows.

.PARAMETER Browser
    Navegador a ser configurado para abrir o Claude Deck: brave, edge, chrome ou firefox.
    Quando especificado junto com -Apply, grava DataDir\browser.json de forma atômica (UTF-8 sem BOM).

.PARAMETER DataDir
    Diretório de dados persistentes do app (padrão: %APPDATA%\claude-deck).
#>

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$DryRun,
    [string]$TargetDesktopDir = "",
    [string]$TargetStartMenuDir = "",
    [string]$TargetStartupDir = "",
    [switch]$EnableAutostart,
    [string]$Browser = "",
    [string]$DataDir = ""
)

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

# Resolução dos diretórios de destino
$desktopDir = if ($TargetDesktopDir) { $TargetDesktopDir } else { [Environment]::GetFolderPath('Desktop') }
$startMenuDir = if ($TargetStartMenuDir) { $TargetStartMenuDir } else { [Environment]::GetFolderPath('Programs') }
$startupDir = if ($TargetStartupDir) { $TargetStartupDir } else { [Environment]::GetFolderPath('Startup') }

if (-not $DataDir) {
    if ($env:CLAUDE_DECK_DATA) {
        $DataDir = $env:CLAUDE_DECK_DATA
    } else {
        $DataDir = Join-Path $env:APPDATA "claude-deck"
    }
}
$browserJsonPath = Join-Path $DataDir "browser.json"

$desktopShortcut = Join-Path $desktopDir "Claude Deck.lnk"
$startMenuShortcut = Join-Path $startMenuDir "Claude Deck.lnk"
$startupShortcut = Join-Path $startupDir "Claude Deck (servidor).lnk"

$iconPath = Join-Path $scriptDir "icon.ico"
if (-not (Test-Path $iconPath)) {
    $iconPath = Join-Path $repoRoot "src\web\public\icons\icon.ico"
}

$launcherVbs = Join-Path $scriptDir "open-app.vbs"
$startServerVbs = Join-Path $scriptDir "start-server.vbs"

$wscriptExe = "$env:WINDIR\System32\wscript.exe"

$wsh = New-Object -ComObject WScript.Shell

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

function Write-AtomicUtf8NoBom([string]$filePath, [string]$content) {
    $dir = Split-Path -Parent $filePath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmpPath = $filePath + ".tmp." + [System.Guid]::NewGuid().ToString('N')
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpPath, $content, $utf8NoBom)
    if (Test-Path $filePath) {
        try {
            [System.IO.File]::Replace($tmpPath, $filePath, $null)
        } catch {
            Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
            throw
        }
    } else {
        [System.IO.File]::Move($tmpPath, $filePath)
    }
}

function Inspect-Shortcut([string]$path) {
    if (-not (Test-Path $path)) {
        return $null
    }
    try {
        $sc = $wsh.CreateShortcut($path)
        return [PSCustomObject]@{
            Path = $path
            Exists = $true
            TargetPath = $sc.TargetPath
            Arguments = $sc.Arguments
            WorkingDirectory = $sc.WorkingDirectory
            IconLocation = $sc.IconLocation
            Description = $sc.Description
        }
    } catch {
        return [PSCustomObject]@{
            Path = $path
            Exists = $true
            Error = $_.Exception.Message
        }
    }
}

# 1. Inspeção de atalhos existentes do Claude Deck
$existingDesktop = Inspect-Shortcut $desktopShortcut
$existingStartMenu = Inspect-Shortcut $startMenuShortcut
$existingStartup = Inspect-Shortcut $startupShortcut

# 2. Varredura de outros atalhos para garantir que não serão afetados
$otherDesktopShortcuts = @()
if (Test-Path $desktopDir) {
    $otherDesktopShortcuts = @(Get-ChildItem -Path $desktopDir -Filter "*.lnk" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "Claude Deck.lnk" } |
        Select-Object -ExpandProperty Name)
}

$otherStartMenuShortcuts = @()
if (Test-Path $startMenuDir) {
    $otherStartMenuShortcuts = @(Get-ChildItem -Path $startMenuDir -Filter "*.lnk" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "Claude Deck.lnk" } |
        Select-Object -ExpandProperty Name)
}

# 3. Resolução do navegador
$normalizedBrowser = ""
if ($Browser) {
    $normalizedBrowser = $Browser.Trim().ToLowerInvariant()
    if ($normalizedBrowser -notin @('brave', 'edge', 'chrome', 'firefox')) {
        throw "Navegador inválido: '$Browser'. Escolha um dos seguintes: brave, edge, chrome, firefox."
    }
}

$existingBrowserConfig = $null
if (Test-Path $browserJsonPath) {
    try {
        $raw = Get-Content -Path $browserJsonPath -Raw -Encoding utf8 -ErrorAction SilentlyContinue
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.PSObject.Properties['browser']) {
            $bVal = [string]$cfg.browser
            $bVal = $bVal.Trim().ToLowerInvariant()
            if ($bVal -in @('brave', 'edge', 'chrome', 'firefox')) {
                $existingBrowserConfig = $bVal
            }
        }
    } catch {}
}

$selectedBrowser = $null
$browserSource = ""
if ($normalizedBrowser) {
    $selectedBrowser = $normalizedBrowser
    $browserSource = "ExplicitParameter"
} elseif ($existingBrowserConfig) {
    $selectedBrowser = $existingBrowserConfig
    $browserSource = "ExistingConfig"
} else {
    foreach ($cand in @('brave', 'edge', 'chrome', 'firefox')) {
        if (Find-BrowserExecutable $cand) {
            $selectedBrowser = $cand
            $browserSource = "AutoDetect"
            break
        }
    }
    if (-not $selectedBrowser) {
        $selectedBrowser = 'brave'
        $browserSource = "Default"
    }
}

$browserExe = Find-BrowserExecutable $selectedBrowser
$profileDir = Get-BrowserProfileDir $selectedBrowser $DataDir

if ($Apply -and -not $DryRun -and -not $browserExe) {
    throw "O executável do navegador '$selectedBrowser' não foi encontrado nos caminhos padrão do Windows. Instale um dos navegadores suportados antes de criar o atalho."
}

$plan = [PSCustomObject]@{
    Action = if ($Apply -and -not $DryRun) { "APPLY" } else { "DRY_RUN" }
    DesktopShortcutPath = $desktopShortcut
    DesktopExists = ($existingDesktop -ne $null)
    StartMenuShortcutPath = $startMenuShortcut
    StartMenuExists = ($existingStartMenu -ne $null)
    StartupShortcutPath = $startupShortcut
    StartupExists = ($existingStartup -ne $null)
    EnableAutostart = [bool]$EnableAutostart
    ShortcutTarget = $wscriptExe
    ShortcutArguments = "`"$launcherVbs`""
    ShortcutWorkingDir = $repoRoot
    ShortcutIcon = "$iconPath,0"
    ProtectedDesktopAppsCount = $otherDesktopShortcuts.Count
    ProtectedDesktopApps = ($otherDesktopShortcuts | Select-Object -First 10)
    ProtectedStartMenuAppsCount = $otherStartMenuShortcuts.Count
    SelectedBrowser = $selectedBrowser
    BrowserSource = $browserSource
    BrowserPath = $browserExe
    BrowserProfileDir = $profileDir
    BrowserConfigPath = $browserJsonPath
    BrowserConfigExists = ($existingBrowserConfig -ne $null)
    WillWriteBrowserConfig = [bool]$normalizedBrowser
}

if (-not $Apply -or $DryRun) {
    Write-Output $plan
    return
}

# Se um navegador foi especificado explicitamente, grava DataDir\browser.json de forma atômica (UTF-8 sem BOM)
if ($normalizedBrowser) {
    $jsonPayload = "{`"browser`":`"$selectedBrowser`"}"
    Write-AtomicUtf8NoBom $browserJsonPath $jsonPayload
}

# Aplicação real (apenas se -Apply foi passado explicitamente)
function Create-Or-Update-Shortcut(
    [string]$path,
    [string]$target,
    [string]$shortcutArgs,
    [string]$workDir,
    [string]$icon,
    [string]$desc
) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $sc = $wsh.CreateShortcut($path)
    $sc.TargetPath = $target
    $sc.Arguments = $shortcutArgs
    $sc.WorkingDirectory = $workDir
    if ($icon -and (Test-Path ($icon.Split(',')[0]))) {
        $sc.IconLocation = $icon
    }
    $sc.Description = $desc
    $sc.Save()
}

# Cria atalho da Área de Trabalho
Create-Or-Update-Shortcut `
    -path $desktopShortcut `
    -target $wscriptExe `
    -shortcutArgs "`"$launcherVbs`"" `
    -workDir $repoRoot `
    -icon "$iconPath,0" `
    -desc "Claude Deck - Claude Code local e em servidores SSH"

# Cria atalho do Menu Iniciar
Create-Or-Update-Shortcut `
    -path $startMenuShortcut `
    -target $wscriptExe `
    -shortcutArgs "`"$launcherVbs`"" `
    -workDir $repoRoot `
    -icon "$iconPath,0" `
    -desc "Claude Deck - Claude Code local e em servidores SSH"

# Opcional: Cria atalho de Inicialização
if ($EnableAutostart) {
    Create-Or-Update-Shortcut `
        -path $startupShortcut `
        -target $wscriptExe `
        -shortcutArgs "`"$startServerVbs`"" `
        -workDir $scriptDir `
        -icon "$iconPath,0" `
        -desc "Claude Deck (servidor local)"
}

[PSCustomObject]@{
    Status = "Installed"
    DesktopShortcut = $desktopShortcut
    StartMenuShortcut = $startMenuShortcut
    AutostartInstalled = [bool]$EnableAutostart
    Browser = $selectedBrowser
    BrowserConfigWritten = [bool]$normalizedBrowser
    BrowserPath = $browserExe
    BrowserProfileDir = $profileDir
    Timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
}
