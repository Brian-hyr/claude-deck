// Abre uma janela nova no navegador escolhido, sempre com perfil isolado do Deck.
// Chromium usa --app; Firefox abre janela normal no mesmo perfil dedicado.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DeckError } from '../shared/protocol';
import { encodeOpen, type OpenTarget } from '../shared/openwin';
import type { BrowserId } from '../shared/types';

/** Mantém a busca histórica do Brave para quem já usa o Deck. */
export function findBrave(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const rel = ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'];
  const bases = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter((b): b is string => !!b);
  for (const b of bases) {
    const p = path.join(b, ...rel);
    if (exists(p)) return p;
  }
  return null;
}

export const BROWSER_IDS: readonly BrowserId[] = ['brave', 'edge', 'chrome', 'firefox'];

const LOCATIONS: Record<BrowserId, readonly string[][]> = {
  brave: [['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']],
  edge: [['Microsoft', 'Edge', 'Application', 'msedge.exe']],
  chrome: [['Google', 'Chrome', 'Application', 'chrome.exe']],
  firefox: [['Mozilla Firefox', 'firefox.exe']],
};

export interface BrowserSelection {
  id: BrowserId;
  executable: string;
  processName: string;
  profileDir: string;
}

export function findBrowser(id: BrowserId, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (id === 'brave') return findBrave(env, exists);
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.ProgramW6432].filter((b): b is string => !!b);
  for (const base of bases) {
    for (const rel of LOCATIONS[id]) {
      const candidate = path.join(base, ...rel);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function browserProfile(dataDir: string, id: BrowserId): string {
  return path.join(dataDir, id === 'brave' ? 'browser-profile' : `browser-profile-${id}`);
}

/** Sem escolha gravada, preserva Brave; se não há Brave (instalação nova), usa outro navegador instalado. */
export function resolveBrowser(dataDir: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): BrowserSelection {
  const configFile = path.join(dataDir, 'browser.json');
  let selected: BrowserId | undefined;
  if (exists(configFile)) {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
    catch { throw new DeckError('browser', 'A escolha do navegador está inválida em browser.json. Corrija-a pelo instalador.'); }
    const id = (value as { browser?: unknown } | null)?.browser;
    if (typeof id !== 'string' || !BROWSER_IDS.includes(id as BrowserId))
      throw new DeckError('browser', 'Navegador inválido em browser.json. Escolha Brave, Edge, Chrome ou Firefox.');
    selected = id as BrowserId;
  }
  const id = selected ?? BROWSER_IDS.find((candidate) => !!findBrowser(candidate, env, exists));
  if (!id) throw new DeckError('browser', 'Não encontrei Brave, Edge, Chrome ou Firefox neste computador.');
  const executable = findBrowser(id, env, exists);
  if (!executable) throw new DeckError('browser', `Navegador ${id} não encontrado. Escolha outro navegador pelo instalador.`);
  return { id, executable, processName: path.basename(executable, '.exe'), profileDir: browserProfile(dataDir, id) };
}

/** URL de entrada da janela nova: o código de uso único autentica; `open` diz onde abrir a conversa. */
export function buildOpenUrl(port: number, code: string, target?: OpenTarget): string {
  const base = `http://127.0.0.1:${port}/auth?c=${code}`;
  return target ? `${base}&open=${encodeOpen(target)}` : base;
}

/** Os argumentos do launcher, um por item (sem aspas: o spawn cuida de espaços no caminho). */
export function braveArgs(profileDir: string, url: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=BraveRewards',
    '--autoplay-policy=no-user-gesture-required',
    '--lang=pt-BR',
    `--app=${url}`,
  ];
}

export function browserArgs(browser: BrowserSelection, url: string): string[] {
  if (browser.id === 'firefox') return ['-profile', browser.profileDir, '-new-window', url];
  return browser.id === 'brave'
    ? braveArgs(browser.profileDir, url)
    : [`--user-data-dir=${browser.profileDir}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--lang=pt-BR', `--app=${url}`];
}

export function launchWindow(dataDir: string, url: string, selected?: BrowserSelection): void {
  const browser = selected ?? resolveBrowser(dataDir);
  fs.mkdirSync(browser.profileDir, { recursive: true });
  const child = spawn(browser.executable, browserArgs(browser, url), { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    /* O navegador sumiu entre a checagem e a abertura: não derruba o servidor. */
  });
  child.unref();
}

export interface FocusWindowOptions {
  platform?: string;
  timeoutMs?: number;
  execFileFn?: typeof execFile;
  powerShellPath?: string;
  browser?: BrowserSelection;
}

export function resolvePowerShellExe(
  override?: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  if (override) return override;
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) {
    const candidate = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/**
 * Código C# que acha e foca a janela (usado pelo script de foco e, sozinho, pelo teste real no Windows).
 *
 * NUNCA chamar `ShowWindow` síncrono aqui. O PowerShell que roda isto nasce oculto (`windowsHide`), e o
 * Windows troca a PRIMEIRA chamada de `ShowWindow` desse processo pelo modo da janela do próprio processo,
 * que é "oculta" — mesmo sendo a janela de OUTRO programa. Era isso que escondia uma janela do Deck a
 * cada clique no atalho (01/10; reproduzido com janela de teste: `SW_SHOW` deixava a janela oculta).
 * `ShowWindowAsync` só manda o pedido para a thread dona da janela (o Brave), e lá a regra não vale.
 */
export function focusHelperSource(): string {
  return `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DeckWinFocusHelper {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    public struct WindowMatch {
        public IntPtr Handle;
        public uint ProcessId;
    }

    // Acha a janela pela marca no título MESMO oculta: uma janela do Deck escondida (pelo defeito antigo
    // ou por qualquer outro motivo) ainda tem a página conectada e precisa poder voltar. O script confere
    // depois que é o Brave do perfil do Deck.
    public static List<WindowMatch> FindWindows(string marker) {
        var list = new List<WindowMatch>();
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(1024);
            int len = GetWindowText(hWnd, sb, 1024);
            if (len > 0) {
                var title = sb.ToString();
                if (title.IndexOf(marker, StringComparison.Ordinal) >= 0) {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    list.Add(new WindowMatch { Handle = hWnd, ProcessId = pid });
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Deixa a janela na tela: restaura se minimizada, mostra (sem ativar) se oculta; visível fica como está.
    // Sempre ShowWindowAsync (ver o comentário de focusHelperSource). Espera até 1 s pela troca de estado.
    public static bool EnsureShown(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return false;
        if (IsIconic(hWnd)) {
            ShowWindowAsync(hWnd, 9); // SW_RESTORE: volta ao tamanho de antes (maximizada, se era)
        } else if (!IsWindowVisible(hWnd)) {
            ShowWindowAsync(hWnd, 8); // SW_SHOWNA: mostra no tamanho/posição atuais, sem ativar
        }
        for (int i = 0; i < 50 && (IsIconic(hWnd) || !IsWindowVisible(hWnd)); i++) {
            System.Threading.Thread.Sleep(20);
        }
        return IsWindowVisible(hWnd) && !IsIconic(hWnd);
    }

    public static bool TryFocus(IntPtr hWnd) {
        if (!EnsureShown(hWnd)) return false;
        IntPtr fg = GetForegroundWindow();
        if (fg == hWnd) return true;

        uint dummy;
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
        uint curThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != curThread) {
            attached = AttachThreadInput(curThread, fgThread, true);
        }

        try {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        } finally {
            if (attached) {
                AttachThreadInput(curThread, fgThread, false);
            }
        }

        for (int i = 0; i < 15; i++) {
            if (GetForegroundWindow() == hWnd) return IsWindowVisible(hWnd);
            System.Threading.Thread.Sleep(20);
        }
        return GetForegroundWindow() == hWnd && IsWindowVisible(hWnd);
    }
}
`;
}

/** Gera o script PowerShell para localizar e focar a janela pelo marker e profileDir. */
export function buildFocusScript(profileDir: string, marker: string, browser?: BrowserSelection): string {
  const markerB64 = Buffer.from(marker, 'utf8').toString('base64');
  const profileDirB64 = Buffer.from(profileDir, 'utf8').toString('base64');
  const exeCheck = browser
    ? `$expectedExe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(browser.executable, 'utf8').toString('base64')}'))
$expectedExe = [System.IO.Path]::GetFullPath($expectedExe).ToLowerInvariant()
$expectedName = '${browser.processName}'`
    : `$expectedName = 'brave'
$expectedExe = $null`;

  // O C# vai num here-string LITERAL (@' '@): o PowerShell não expande nada dentro dele.
  return `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$marker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${markerB64}'))
$targetProfile = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${profileDirB64}'))
${exeCheck}

if ([string]::IsNullOrWhiteSpace($marker) -or [string]::IsNullOrWhiteSpace($targetProfile)) {
    Write-Output "FAIL"
    exit 0
}

if (-not ([System.Management.Automation.PSTypeName]'DeckWinFocusHelper').Type) {
    Add-Type -TypeDefinition @'
${focusHelperSource()}'@
}

$windows = [DeckWinFocusHelper]::FindWindows($marker)
if (-not $windows -or $windows.Count -eq 0) {
    Write-Output "FAIL"
    exit 0
}

$targetNormalized = [System.IO.Path]::GetFullPath($targetProfile).TrimEnd('\\', '/').ToLowerInvariant()
$focused = $false

foreach ($w in $windows) {
    try {
        $p = Get-Process -Id $w.ProcessId -ErrorAction Stop
        if ($p.ProcessName -ne $expectedName) {
            continue
        }

        $cmd = $null
        $procExe = $null
        try {
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($w.ProcessId)" -ErrorAction Stop
            $cmd = $cim.CommandLine
            $procExe = $cim.ExecutablePath
        } catch {
            try {
                $wmi = Get-WmiObject Win32_Process -Filter "ProcessId = $($w.ProcessId)" -ErrorAction Stop
                $cmd = $wmi.CommandLine
                $procExe = $wmi.ExecutablePath
            } catch {}
        }

        if (-not $cmd) { continue }
        if ($expectedExe -and (-not $procExe -or [System.IO.Path]::GetFullPath($procExe).ToLowerInvariant() -ne $expectedExe)) { continue }

        if ($cmd -match '--user-data-dir=(?:"([^"]+)"|''([^'']+)''|([^\\s]+))') {
            $rawDir = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }
            try {
                $procNormalized = [System.IO.Path]::GetFullPath($rawDir).TrimEnd('\\', '/').ToLowerInvariant()
                if ($procNormalized -eq $targetNormalized) {
                    if ([DeckWinFocusHelper]::TryFocus($w.Handle)) {
                        $focused = $true
                        break
                    }
                }
            } catch {}
        }
    } catch {}
}

if ($focused) {
    Write-Output "OK"
} else {
    Write-Output "FAIL"
}
`;
}

/** Converte o script PowerShell em Base64 UTF-16LE para uso com -EncodedCommand. */
export function buildFocusEncodedCommand(profileDir: string, marker: string, browser?: BrowserSelection): string {
  const script = buildFocusScript(profileDir, marker, browser);
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Foca efetivamente uma janela Brave --app existente no Windows identificada por marker temporário no título.
 * Confirma que o processo é o Brave associado ao profileDir do Claude Deck, restaura se minimizada,
 * chama SetForegroundWindow e confirma via GetForegroundWindow.
 */
export async function focusWindow(
  profileDir: string,
  marker: string,
  options?: FocusWindowOptions,
): Promise<boolean> {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'win32') return false;

  if (typeof marker !== 'string' || !marker.trim()) return false;
  if (typeof profileDir !== 'string' || !profileDir.trim()) return false;

  if (options?.browser?.id === 'firefox') return false; // O processo filho do Firefox não identifica de forma confiável o perfil.
  const encodedCommand = buildFocusEncodedCommand(profileDir, marker, options?.browser);
  const psExe = resolvePowerShellExe(options?.powerShellPath);
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedCommand,
  ];
  const timeout = options?.timeoutMs ?? 4000;
  const runExec = options?.execFileFn ?? execFile;

  return new Promise<boolean>((resolve) => {
    try {
      runExec(psExe, args, { timeout, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        const out = String(stdout ?? '').trim();
        resolve(out === 'OK' || out.endsWith('\nOK') || out.endsWith('\r\nOK'));
      });
    } catch {
      resolve(false);
    }
  });
}
