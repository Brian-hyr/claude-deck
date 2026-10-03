// Selo numérico no botão do Claude Deck na barra de tarefas do Windows (como o do WhatsApp).
//
// Conta as conversas que pedem você: terminaram e ainda não foram vistas, terminaram com erro, ou
// esperam uma resposta (permissão, pergunta, plano). Conversa trabalhando não conta.
//
// O Windows junta as janelas do mesmo programa num botão só e mostra nele o selo de UMA delas (testado
// com duas janelas, 2 e 5: apareceu só o 5). Por isso o servidor soma tudo e grava o MESMO número em
// todas as janelas do Deck: qualquer uma que o Windows escolha mostra o total.
//
// Por que PowerShell de fora e não `navigator.setAppBadge`: o atalho abre o Brave com `--app`, que não é um
// PWA instalado, e ali a API resolve mas nenhum selo aparece. `ITaskbarList3::SetOverlayIcon`, chamado por
// outro processo sobre o HWND da janela, funciona (conferido com captura da barra de tarefas).
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { resolvePowerShellExe, type BrowserSelection } from './browser';

export type BadgeKind = 'waiting' | 'error' | 'pending' | 'done';

/** O que o selo precisa saber de cada conversa. */
export interface BadgeConversation {
  /** Janela do app dona da conversa. */
  wid?: string;
  phase: string;
  unseen?: 'done' | 'error';
  /** Marca manual que permanece até abrir deliberadamente esta conversa. */
  manualPending?: boolean;
  /** Há permissão, pergunta ou plano esperando resposta. */
  waiting: boolean;
}

export interface BadgeSummary {
  count: number;
  /** O estado mais urgente presente (define a cor); `null` sem nada a mostrar. */
  kind: BadgeKind | null;
  waiting: number;
  error: number;
  pending: number;
  done: number;
  /** Texto para leitores de tela e dica do botão, ex.: `2 concluídas, 1 marcada para depois, 1 esperando você`. */
  description: string;
}

/**
 * Soma as conversas que pedem você. Cada conversa conta uma vez, pelo estado mais urgente: esperando
 * resposta > terminou com erro > terminou. Só entram conversas de janelas abertas agora: as de janela
 * fechada não têm onde ser vistas (nem onde o número poderia ser baixado sem reabrir a janela).
 *
 * "Erro" são as duas formas de a execução ter parado: o turno terminou em erro (`unseen: 'error'`, some ao
 * abrir a conversa) e o Claude que não subiu ou caiu (`phase: 'error'`). A segunda NÃO some ao ser vista:
 * fica até a conversa ser retomada ou fechada, igual ao ícone vermelho da aba. É o que se quer: execução
 * interrompida continua precisando de você.
 */
export function summarizeBadge(list: readonly BadgeConversation[], liveWids: ReadonlySet<string>): BadgeSummary {
  let waiting = 0;
  let error = 0;
  let pending = 0;
  let done = 0;
  for (const c of list) {
    if (!c.wid || !liveWids.has(c.wid) || c.phase === 'ended') continue;
    // Uma conversa aparece uma vez: o pedido explícito vem antes do aviso automático de fim.
    if (c.waiting) waiting++;
    else if (c.phase === 'error' || c.unseen === 'error') error++;
    else if (c.manualPending) pending++;
    else if (c.unseen === 'done') done++;
  }
  const parts: string[] = [];
  if (done) parts.push(`${done} ${done === 1 ? 'concluída' : 'concluídas'}`);
  if (pending) parts.push(`${pending} ${pending === 1 ? 'marcada para depois' : 'marcadas para depois'}`);
  if (error) parts.push(`${error} com erro`);
  if (waiting) parts.push(`${waiting} esperando você`);
  return {
    count: waiting + error + pending + done,
    kind: waiting ? 'waiting' : error ? 'error' : pending ? 'pending' : done ? 'done' : null,
    waiting,
    error,
    pending,
    done,
    description: parts.join(', '),
  };
}

/** O que muda o desenho do selo: número, cor e texto da dica. */
function keyOf(s: BadgeSummary): string {
  return `${s.count}|${s.kind}|${s.description}`;
}

/** O que o script desenha. `count: 0` apaga o selo. */
export interface BadgePayload {
  count: number;
  label: string;
  fill: string;
  text: string;
  description: string;
}

// Fundos escuros o bastante para o número branco ler bem num ícone de 16 px. Mesma família das cores das
// abas (var(--ok-fg), var(--err) do tema claro e o âmbar da permissão); no âmbar o número é escuro.
const COLORS: Record<BadgeKind, { fill: string; text: string }> = {
  waiting: { fill: '#e2a700', text: '#1f1f1f' },
  error: { fill: '#d1242f', text: '#ffffff' },
  pending: { fill: '#0969da', text: '#ffffff' },
  done: { fill: '#1a7f37', text: '#ffffff' },
};

export function badgePayload(s: BadgeSummary): BadgePayload {
  if (!s.kind || s.count <= 0) return { count: 0, label: '', fill: '', text: '', description: '' };
  const c = COLORS[s.kind];
  return { count: s.count, label: s.count > 99 ? '99+' : String(s.count), fill: c.fill, text: c.text, description: s.description };
}

/**
 * Script PowerShell que acha as janelas do Deck (Brave com o perfil próprio dele, título terminando em
 * "Claude Deck") e põe/tira o selo em cada uma. Perfil e dados vão em Base64 UTF-8, nunca soltos no texto
 * (mesma proteção do `buildFocusScript`). Imprime `OK <janelas atingidas>`.
 */
export function buildBadgeScript(profileDir: string, payload: BadgePayload, browser?: BrowserSelection): string {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const processName = browser?.processName ?? 'brave';
  const expectedExe = browser ? b64(browser.executable) : '';
  // String.raw: as barras invertidas do PowerShell e do C# ficam como estão. O bloco do Add-Type é
  // literal (@' '@): o PowerShell não expande nada dentro dele, e o fechamento fica na coluna 0.
  return String.raw`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
function FromB64([string]$s) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s)) }
try {
$targetProfile = FromB64 '${b64(profileDir)}'
$badge = (FromB64 '${b64(JSON.stringify(payload))}') | ConvertFrom-Json

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList3 {
    [PreserveSig] int HrInit();
    [PreserveSig] int AddTab(IntPtr hwnd);
    [PreserveSig] int DeleteTab(IntPtr hwnd);
    [PreserveSig] int ActivateTab(IntPtr hwnd);
    [PreserveSig] int SetActiveAlt(IntPtr hwnd);
    [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
    [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
    [PreserveSig] int SetProgressState(IntPtr hwnd, int flags);
    [PreserveSig] int RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
    [PreserveSig] int UnregisterTab(IntPtr hwndTab);
    [PreserveSig] int SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    [PreserveSig] int SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint reserved);
    [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint count, IntPtr buttons);
    [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint count, IntPtr buttons);
    [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
    [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string description);
    [PreserveSig] int SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string tip);
    [PreserveSig] int SetThumbnailClip(IntPtr hwnd, IntPtr clip);
}

public class DeckBadge {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);

    static ITaskbarList3 tb;

    public static List<IntPtr> Find(HashSet<uint> pids, string suffix) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) && !IsIconic(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid)) return true;
            var t = new StringBuilder(1024);
            GetWindowText(h, t, 1024);
            if (t.ToString().EndsWith(suffix, StringComparison.Ordinal)) found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static int Overlay(IntPtr hwnd, IntPtr icon, string description) {
        if (tb == null) {
            var t = Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11d0-958A-006097C9A090"));
            tb = (ITaskbarList3)Activator.CreateInstance(t);
            tb.HrInit();
        }
        return tb.SetOverlayIcon(hwnd, icon, description);
    }
}
'@

function New-BadgeIcon($b) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($b.fill))
    $g.FillEllipse($fill, 0, 0, 31, 31)
    $len = $b.label.Length
    $px = if ($len -ge 3) { 13 } elseif ($len -eq 2) { 18 } else { 22 }
    $font = New-Object System.Drawing.Font('Segoe UI', [single]$px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($b.text))
    $g.DrawString($b.label, $font, $ink, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $sf)
    $h = $bmp.GetHicon()
    $g.Dispose(); $bmp.Dispose(); $fill.Dispose(); $ink.Dispose(); $font.Dispose(); $sf.Dispose()
    return $h
}

# Processos do navegador selecionado com o perfil dedicado do Deck (o perfil pessoal fica de fora).
$targetNormalized = [System.IO.Path]::GetFullPath($targetProfile).TrimEnd('\', '/').ToLowerInvariant()
$expectedExe = '${expectedExe}'
if ($expectedExe) { $expectedExe = [System.IO.Path]::GetFullPath((FromB64 $expectedExe)).ToLowerInvariant() }
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($proc in Get-CimInstance Win32_Process -Filter "Name='${processName}.exe'") {
    $cmd = $proc.CommandLine
    if (-not $cmd -or ($expectedExe -and (-not $proc.ExecutablePath -or [System.IO.Path]::GetFullPath($proc.ExecutablePath).ToLowerInvariant() -ne $expectedExe))) { continue }
    if ($cmd -match '--user-data-dir=(?:"([^"]+)"|([^\s]+))') {
        $raw = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        try {
            if ([System.IO.Path]::GetFullPath($raw).TrimEnd('\', '/').ToLowerInvariant() -eq $targetNormalized) { [void]$pids.Add([uint32]$proc.ProcessId) }
        } catch {}
    }
}

$wins = [DeckBadge]::Find($pids, 'Claude Deck')
$done = 0
if ($badge.count -le 0) {
    foreach ($w in $wins) { if ([DeckBadge]::Overlay($w, [IntPtr]::Zero, $null) -eq 0) { $done++ } }
} elseif ($wins.Count -gt 0) {
    $ico = New-BadgeIcon $badge
    foreach ($w in $wins) { if ([DeckBadge]::Overlay($w, $ico, [string]$badge.description) -eq 0) { $done++ } }
    [void][DeckBadge]::DestroyIcon($ico)
}
Write-Output ('OK ' + $done)
} catch {
    Write-Output ('FAIL ' + $_.Exception.Message)
}
`;
}

export interface TaskbarBadgeOptions {
  /** Pasta do perfil do Brave do Deck (`<dados>/browser-profile`). */
  profileDir: string;
  /** Navegador verificado desta instalação; Firefox não recebe selo nativo sem identificação segura da janela. */
  browser?: () => BrowserSelection | null;
  /** Calcula o resumo na hora de aplicar (não na hora do aviso): o que vale é o estado de agora. */
  compute: () => BadgeSummary;
  /** Padrão: só no Windows e fora dos testes automáticos (que não mexem na barra de tarefas de quem testa). */
  enabled?: boolean;
  /** Junta uma rajada de avisos numa só aplicação. */
  delayMs?: number;
  timeoutMs?: number;
  execFileFn?: typeof execFile;
  powerShellPath?: string;
  /** Para testar sem disco. */
  exists?: (p: string) => boolean;
  log?: (m: string) => void;
}

/**
 * Mantém o selo da barra de tarefas igual ao resumo. Um PowerShell por aplicação (não fica nenhum residente,
 * porque o app existe para gastar pouca memória e as mudanças são poucas), nunca dois ao mesmo tempo, e só
 * quando número, cor ou dica mudaram.
 */
export class TaskbarBadge {
  private readonly enabled: boolean;
  private readonly delayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** Chegou aviso (ou pedido de reaplicar) enquanto o PowerShell rodava: roda de novo no fim. */
  private again = false;
  private force = false;
  private disposed = false;
  /** O que está na barra de tarefas agora; `null` = desconhecido (o selo sobrevive ao daemon, então a 1ª aplicação sempre grava). */
  private applied: string | null = null;

  constructor(private opts: TaskbarBadgeOptions) {
    this.enabled = opts.enabled ?? (process.platform === 'win32' && process.env.CLAUDE_DECK_TEST_HOOKS !== '1');
    this.delayMs = opts.delayMs ?? 400;
  }

  /** O resumo de agora (para os testes automáticos conferirem sem mexer na barra de tarefas). */
  current(): BadgeSummary {
    return this.opts.compute();
  }

  /** Algo mudou nas conversas: reaplica daqui a pouco (uma rajada vira uma aplicação só). */
  touch() {
    if (!this.enabled || this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Reaplica mesmo sem mudança (janela nova: o botão dela ainda não tem o selo). Várias chamadas seguidas viram uma. */
  refresh(delayMs = 1500) {
    if (!this.enabled || this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.force = true;
      void this.run();
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.timer = null;
    this.refreshTimer = null;
  }

  private async run() {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const summary = this.opts.compute();
        const key = keyOf(summary);
        if (!this.force && key === this.applied) continue;
        this.force = false;
        const ok = await this.apply(summary);
        // Falhou ou não achou a janela: não finge que aplicou, a próxima mudança tenta de novo.
        this.applied = ok ? key : null;
      } while (this.again && !this.disposed);
    } finally {
      this.running = false;
    }
  }

  private apply(summary: BadgeSummary): Promise<boolean> {
    const browser = this.opts.browser?.();
    if (this.opts.browser && !browser) return Promise.resolve(true);
    if (browser?.id === 'firefox') return Promise.resolve(true);
    const profileDir = browser?.profileDir ?? this.opts.profileDir;
    // Perfil inexistente: estes dados nunca abriram uma janela do Deck neste navegador.
    if (!(this.opts.exists ?? fs.existsSync)(profileDir)) return Promise.resolve(true);
    const payload = badgePayload(summary);
    const encoded = Buffer.from(buildBadgeScript(profileDir, payload, browser ?? undefined), 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const runExec = this.opts.execFileFn ?? execFile;
    return new Promise<boolean>((resolve) => {
      try {
        runExec(resolvePowerShellExe(this.opts.powerShellPath), args, { timeout: this.opts.timeoutMs ?? 15_000, windowsHide: true }, (error, stdout) => {
          if (error) {
            this.opts.log?.(`selo da barra de tarefas: PowerShell falhou: ${error.message}`);
            resolve(false);
            return;
          }
          const out = String(stdout ?? '').trim();
          const m = /OK (\d+)\s*$/.exec(out);
          if (!m) {
            this.opts.log?.(`selo da barra de tarefas: resposta inesperada: ${out.slice(0, 200)}`);
            resolve(false);
            return;
          }
          // Para apagar, nenhuma janela achada também está certo (não há selo a apagar).
          resolve(Number(m[1]) > 0 || payload.count === 0);
        });
      } catch (e) {
        this.opts.log?.(`selo da barra de tarefas: não consegui chamar o PowerShell: ${(e as Error).message}`);
        resolve(false);
      }
    });
  }
}
