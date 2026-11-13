// Abre uma janela nova no navegador escolhido, sempre com perfil isolado do Deck.
// Chromium usa --app; Firefox abre janela normal no mesmo perfil dedicado.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DeckError } from '../shared/protocol';
import { encodeOpen, type OpenTarget } from '../shared/openwin';
import type { BrowserId, WindowBounds } from '../shared/types';

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

// ------------------------------------------------------------------ posição das janelas (Windows)
//
// A página não serve para isso: dentro de uma janela --app, `window.moveTo` não passa de um monitor para
// outro (fica preso no monitor atual), `screenX`/`outerWidth` vêm em DIPs (errados com escalas diferentes
// por monitor) e o Chromium já aberto ignora --window-position/--window-size de um lançamento novo.
// Então o servidor lê e aplica a posição pelo Win32, em pixels físicos (DPI por monitor), achando a janela
// pela marca temporária no título (como o foco) e conferindo que é o navegador do perfil do Deck.

/** Uma operação sobre uma janela: achar pelo `hwnd` já conhecido e/ou pela `marker`; com `apply`, reposiciona antes de ler. */
export interface PlacementJob {
  marker?: string;
  hwnd?: number;
  apply?: WindowBounds;
}

export interface PlacementResult {
  hwnd: number;
  /** Posição lida depois da operação. */
  placement: WindowBounds;
  /** Resultado do `apply`: OK, PART (tamanho não ficou exato), OFF (fora de qualquer monitor), BAD, ou '-' sem apply. */
  result: string;
}

const MIN_W = 200;
const MIN_H = 150;
const MAX_COORD = 100_000;

/** Aceita só uma posição plausível (inteiros, tamanho mínimo); qualquer outra coisa vira `undefined`. */
export function validPlacement(v: unknown): WindowBounds | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const nums = [o.x, o.y, o.width, o.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const [x, y, width, height] = (nums as number[]).map((n) => Math.round(n));
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return undefined;
  if (width < MIN_W || height < MIN_H || width > MAX_COORD || height > MAX_COORD) return undefined;
  return o.maximized === true ? { x, y, width, height, maximized: true } : { x, y, width, height };
}

/** Lê a saída do script: uma linha `R <i> <hwnd> <x> <y> <w> <h> <max> <result>` ou `R <i> MISS` por operação. */
export function parsePlacementOutput(stdout: string, count: number): (PlacementResult | null)[] {
  const out: (PlacementResult | null)[] = Array.from({ length: count }, () => null);
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== 'R' || parts.length < 9) continue;
    const i = Number(parts[1]);
    if (!Number.isInteger(i) || i < 0 || i >= count) continue;
    const hwnd = Number(parts[2]);
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) continue;
    const placement = validPlacement({
      x: Number(parts[3]),
      y: Number(parts[4]),
      width: Number(parts[5]),
      height: Number(parts[6]),
      maximized: parts[7] === '1',
    });
    if (!placement) continue;
    out[i] = { hwnd, placement, result: parts[8] };
  }
  return out;
}

/**
 * C# que lê e aplica a posição. Trabalha com DPI por monitor (v2) na própria thread, para tudo sair em
 * pixels físicos. Mesma regra de `focusHelperSource`: só `ShowWindowAsync`, nunca `ShowWindow` síncrono.
 */
export function placementHelperSource(): string {
  return `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class DeckWinPlacement {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT r, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

    public struct WindowMatch { public IntPtr Handle; public uint ProcessId; }

    public static void PerMonitorDpi() {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch {}
    }

    public static List<WindowMatch> FindWindows(string marker) {
        var list = new List<WindowMatch>();
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(1024);
            if (GetWindowText(hWnd, sb, 1024) > 0 && sb.ToString().IndexOf(marker, StringComparison.Ordinal) >= 0) {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                list.Add(new WindowMatch { Handle = hWnd, ProcessId = pid });
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Janela já conhecida (hwnd guardado): ainda existe e ainda é uma janela do Deck?
    public static uint DeckProcessOf(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return 0;
        var sb = new StringBuilder(1024);
        GetWindowText(hWnd, sb, 1024);
        if (!sb.ToString().EndsWith("Claude Deck", StringComparison.Ordinal)) return 0;
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    static RECT Monitor(RECT r, uint flags, out bool found, out RECT work) {
        var mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        IntPtr mon = MonitorFromRect(ref r, flags);
        found = mon != IntPtr.Zero && GetMonitorInfo(mon, ref mi);
        work = mi.rcWork;
        return mi.rcMonitor;
    }

    // rcNormalPosition vem em coordenadas de área de trabalho: deslocadas pela barra de tarefas no topo/esquerda.
    static RECT ToScreen(RECT r) {
        bool found; RECT work;
        RECT mon = Monitor(r, 2, out found, out work);
        if (!found) return r;
        int dx = work.Left - mon.Left, dy = work.Top - mon.Top;
        r.Left += dx; r.Right += dx; r.Top += dy; r.Bottom += dy;
        return r;
    }

    // "x y largura altura max": com a janela maximizada ou minimizada, o retângulo para onde ela volta.
    public static string Read(IntPtr hWnd) {
        PerMonitorDpi();
        RECT r;
        bool max = false;
        if (IsIconic(hWnd) || IsZoomed(hWnd)) {
            var wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (!GetWindowPlacement(hWnd, ref wp)) return null;
            r = ToScreen(wp.rcNormalPosition);
            max = IsZoomed(hWnd) || (wp.flags & 2) != 0; // WPF_RESTORETOMAXIMIZED
        } else if (!GetWindowRect(hWnd, out r)) {
            return null;
        }
        return r.Left + " " + r.Top + " " + (r.Right - r.Left) + " " + (r.Bottom - r.Top) + " " + (max ? 1 : 0);
    }

    static bool Exact(IntPtr hWnd, int x, int y, int w, int h) {
        RECT c;
        return GetWindowRect(hWnd, out c) && c.Left == x && c.Top == y && c.Right - c.Left == w && c.Bottom - c.Top == h;
    }

    public static string Apply(IntPtr hWnd, int x, int y, int w, int h, bool maximized) {
        PerMonitorDpi();
        if (w < ${MIN_W} || h < ${MIN_H}) return "BAD";
        // Só se o lugar ainda existe (monitor desligado/rearranjado: deixa onde o navegador abriu).
        var t = new RECT { Left = x, Top = y, Right = x + w, Bottom = y + h };
        bool found; RECT work;
        Monitor(t, 0, out found, out work);
        if (!found) return "OFF";
        int ix = Math.Min(t.Right, work.Right) - Math.Max(t.Left, work.Left);
        int iy = Math.Min(t.Bottom, work.Bottom) - Math.Max(t.Top, work.Top);
        if (ix < 120 || iy < 60) return "OFF";
        // Barra de título fora da tela não dá para arrastar: traz o topo para dentro.
        if (y < work.Top - 16) y = work.Top;
        if (y > work.Bottom - 40) return "OFF";

        if (IsIconic(hWnd) || IsZoomed(hWnd)) {
            ShowWindowAsync(hWnd, 9); // SW_RESTORE
            for (int i = 0; i < 50 && (IsIconic(hWnd) || IsZoomed(hWnd)); i++) Thread.Sleep(20);
        }
        // Passar para um monitor de outra escala faz o navegador reescalar o tamanho (WM_DPICHANGED):
        // repete já no monitor novo até o retângulo ficar exato.
        bool exact = false;
        for (int i = 0; i < 4 && !exact; i++) {
            SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, 0x0014); // SWP_NOZORDER | SWP_NOACTIVATE
            for (int k = 0; k < 10 && !(exact = Exact(hWnd, x, y, w, h)); k++) Thread.Sleep(25);
        }
        if (maximized) {
            ShowWindowAsync(hWnd, 3); // SW_SHOWMAXIMIZED, no monitor onde a janela está agora
            for (int i = 0; i < 50 && !IsZoomed(hWnd); i++) Thread.Sleep(20);
            return IsZoomed(hWnd) ? "OK" : "PART";
        }
        return exact ? "OK" : "PART";
    }
}
`;
}

/** Script PowerShell que executa uma lista de operações de posição e imprime uma linha `R ...` por operação. */
export function buildPlacementScript(profileDir: string, jobs: PlacementJob[], browser?: BrowserSelection): string {
  const payload = jobs.map((j) => ({
    m: typeof j.marker === 'string' && j.marker.trim() ? j.marker : undefined,
    h: typeof j.hwnd === 'number' && Number.isSafeInteger(j.hwnd) && j.hwnd > 0 ? j.hwnd : undefined,
    a: j.apply ? validPlacement(j.apply) : undefined,
  }));
  const jobsB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const profileDirB64 = Buffer.from(profileDir, 'utf8').toString('base64');
  const exeCheck = browser
    ? `$expectedExe = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(browser.executable, 'utf8').toString('base64')}'))
$expectedExe = [System.IO.Path]::GetFullPath($expectedExe).ToLowerInvariant()
$expectedName = '${browser.processName}'`
    : `$expectedName = 'brave'
$expectedExe = $null`;

  return `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$jobsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${jobsB64}'))
$targetProfile = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${profileDirB64}'))
${exeCheck}

if (-not ([System.Management.Automation.PSTypeName]'DeckWinPlacement').Type) {
    Add-Type -TypeDefinition @'
${placementHelperSource()}'@
}

$parsed = ConvertFrom-Json -InputObject $jobsJson
$jobs = @($parsed)
$targetNormalized = [System.IO.Path]::GetFullPath($targetProfile).TrimEnd('\\', '/').ToLowerInvariant()
$script:pidOk = @{}

function Test-DeckPid([uint32]$procId) {
    if ($procId -eq 0) { return $false }
    if ($script:pidOk.ContainsKey($procId)) { return $script:pidOk[$procId] }
    $ok = $false
    try {
        $p = Get-Process -Id $procId -ErrorAction Stop
        if ($p.ProcessName -eq $expectedName) {
            $cmd = $null
            $procExe = $null
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop
                $cmd = $cim.CommandLine
                $procExe = $cim.ExecutablePath
            } catch {
                try {
                    $wmi = Get-WmiObject Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop
                    $cmd = $wmi.CommandLine
                    $procExe = $wmi.ExecutablePath
                } catch {}
            }
            $exeOk = (-not $expectedExe) -or ($procExe -and [System.IO.Path]::GetFullPath($procExe).ToLowerInvariant() -eq $expectedExe)
            if ($cmd -and $exeOk -and $cmd -match '--user-data-dir=(?:"([^"]+)"|''([^'']+)''|([^\\s]+))') {
                $rawDir = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }
                $procNormalized = [System.IO.Path]::GetFullPath($rawDir).TrimEnd('\\', '/').ToLowerInvariant()
                $ok = ($procNormalized -eq $targetNormalized)
            }
        }
    } catch {}
    $script:pidOk[$procId] = $ok
    return $ok
}

for ($i = 0; $i -lt $jobs.Count; $i++) {
    $job = $jobs[$i]
    try {
        $hwnd = [IntPtr]::Zero
        if ($job.h) {
            $cand = [IntPtr][Int64]$job.h
            if (Test-DeckPid ([DeckWinPlacement]::DeckProcessOf($cand))) { $hwnd = $cand }
        }
        if ($hwnd -eq [IntPtr]::Zero -and $job.m) {
            foreach ($w in [DeckWinPlacement]::FindWindows([string]$job.m)) {
                if (Test-DeckPid $w.ProcessId) { $hwnd = $w.Handle; break }
            }
        }
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "R $i MISS"; continue }
        $result = '-'
        if ($job.a) {
            $a = $job.a
            $result = [DeckWinPlacement]::Apply($hwnd, [int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height, [bool]$a.maximized)
        }
        $read = [DeckWinPlacement]::Read($hwnd)
        if ($read) { Write-Output "R $i $($hwnd.ToInt64()) $read $result" } else { Write-Output "R $i MISS" }
    } catch {
        Write-Output "R $i MISS"
    }
}
`;
}

/**
 * Lê (e, com `apply`, reposiciona) janelas do Deck no Windows. Um PowerShell por chamada, sem processo
 * residente. Devolve um resultado por operação, `null` quando a janela não foi achada ou fora do Windows.
 */
export async function runPlacement(
  profileDir: string,
  jobs: PlacementJob[],
  options?: FocusWindowOptions,
): Promise<(PlacementResult | null)[]> {
  const none = jobs.map(() => null);
  const platform = options?.platform ?? process.platform;
  if (platform !== 'win32' || !jobs.length) return none;
  if (typeof profileDir !== 'string' || !profileDir.trim()) return none;
  if (options?.browser?.id === 'firefox') return none;
  const encoded = Buffer.from(buildPlacementScript(profileDir, jobs, options?.browser), 'utf16le').toString('base64');
  const psExe = resolvePowerShellExe(options?.powerShellPath);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  const timeout = options?.timeoutMs ?? 15_000;
  const runExec = options?.execFileFn ?? execFile;
  return new Promise((resolve) => {
    try {
      runExec(psExe, args, { timeout, windowsHide: true }, (error, stdout) => {
        resolve(error ? none : parsePlacementOutput(String(stdout ?? ''), jobs.length));
      });
    } catch {
      resolve(none);
    }
  });
}
