<#
.SYNOPSIS
    Desinstalador seguro de atalhos do Claude Deck.

.DESCRIPTION
    Remove os atalhos criados pelo instalador na Área de Trabalho, Menu Iniciar
    e Inicializar, garantindo que nenhum outro arquivo ou atalho de aplicativo seja tocado.

.PARAMETER Apply
    Executa a remoção real. Sem este parâmetro, roda em modo DryRun.
#>

[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$TargetDesktopDir = "",
    [string]$TargetStartMenuDir = "",
    [string]$TargetStartupDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopDir = if ($TargetDesktopDir) { $TargetDesktopDir } else { [Environment]::GetFolderPath('Desktop') }
$startMenuDir = if ($TargetStartMenuDir) { $TargetStartMenuDir } else { [Environment]::GetFolderPath('Programs') }
$startupDir = if ($TargetStartupDir) { $TargetStartupDir } else { [Environment]::GetFolderPath('Startup') }

$targets = @(
    (Join-Path $desktopDir "Claude Deck.lnk"),
    (Join-Path $startMenuDir "Claude Deck.lnk"),
    (Join-Path $startupDir "Claude Deck (servidor).lnk")
)

$found = @($targets | Where-Object { Test-Path $_ })

if (-not $Apply) {
    [PSCustomObject]@{
        Mode = "DRY_RUN"
        FoundShortcuts = $found
        Action = if ($found.Count -gt 0) { "Would remove listed shortcuts" } else { "No Claude Deck shortcuts found" }
    }
    return
}

$removed = @()
foreach ($f in $found) {
    Remove-Item -Path $f -Force
    $removed += $f
}

[PSCustomObject]@{
    Status = "Uninstalled"
    Removed = $removed
}
