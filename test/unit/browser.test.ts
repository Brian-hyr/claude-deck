import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import {
  braveArgs,
  browserArgs,
  browserProfile,
  findBrowser,
  resolveBrowser,
  buildFocusEncodedCommand,
  buildFocusScript,
  buildOpenUrl,
  findBrave,
  focusHelperSource,
  focusWindow,
  resolvePowerShellExe,
} from '../../src/server/browser';
import { OPEN_RE, decodeOpen, encodeOpen, isValidTarget } from '../../src/shared/openwin';

describe('destino da janela nova (?open=)', () => {
  it('vai e volta, inclusive com acentos, espaços e caminho do Windows', () => {
    for (const t of [
      { h: 'local' },
      { h: 'srv-remoto', f: '~/Projeto/App' },
      { h: 'cliente prod', f: '/home/usuário/projeção final' },
      { h: 'local', f: 'C:\\Users\\usuario\\Área de Trabalho' },
    ]) {
      const s = encodeOpen(t);
      expect(s).toMatch(OPEN_RE); // só base64url: nada que a URL precise escapar
      expect(decodeOpen(s)).toEqual(t);
    }
  });

  it('não carrega + / = (quebrariam a URL)', () => {
    // Bytes que geram "+" e "/" no base64 comum.
    const s = encodeOpen({ h: 'x', f: '>>>???~~~' });
    expect(s).not.toMatch(/[+/=]/);
    expect(decodeOpen(s)).toEqual({ h: 'x', f: '>>>???~~~' });
  });

  it('rejeita lixo sem lançar erro', () => {
    expect(decodeOpen(null)).toBeNull();
    expect(decodeOpen('')).toBeNull();
    expect(decodeOpen('não é base64!')).toBeNull();
    expect(decodeOpen('%%%')).toBeNull();
    expect(decodeOpen('AAAA')).toBeNull(); // base64 válido, mas não é JSON
    expect(decodeOpen(btoa('{"h":1}'))).toBeNull(); // servidor com tipo errado
    expect(decodeOpen(btoa('{"h":"a","f":""}'))).toBeNull(); // pasta vazia
    expect(decodeOpen(btoa('{"h":"a","f":"x\\ny"}'))).toBeNull(); // quebra de linha na pasta
    expect(decodeOpen('A'.repeat(5000))).toBeNull(); // grande demais
  });

  it('isValidTarget confere tipos e tamanhos', () => {
    expect(isValidTarget({ h: 'local' })).toBe(true);
    expect(isValidTarget({ h: 'local', f: '/tmp' })).toBe(true);
    expect(isValidTarget({ h: '' })).toBe(false);
    expect(isValidTarget({ h: 'a', f: 'x'.repeat(1001) })).toBe(false);
    expect(isValidTarget({ h: 'a', f: 5 })).toBe(false);
    expect(isValidTarget(null)).toBe(false);
    expect(isValidTarget('local')).toBe(false);
  });
});

describe('abrir o Brave em janela nova', () => {
  it('a URL leva o código de uso único e o destino', () => {
    const url = buildOpenUrl(47319, 'ab12', { h: 'local', f: '/tmp' });
    const u = new URL(url);
    expect(u.origin).toBe('http://127.0.0.1:47319');
    expect(u.pathname).toBe('/auth');
    expect(u.searchParams.get('c')).toBe('ab12');
    expect(decodeOpen(u.searchParams.get('open'))).toEqual({ h: 'local', f: '/tmp' });
    // Sem destino: só o código.
    expect(buildOpenUrl(47319, 'ab12')).toBe('http://127.0.0.1:47319/auth?c=ab12');
  });

  it('usa os mesmos argumentos do atalho, um por item e sem aspas', () => {
    const profile = 'C:\\Users\\Maria Silva\\AppData\\Roaming\\claude-deck\\browser-profile';
    const args = braveArgs(profile, 'http://127.0.0.1:1/auth?c=x');
    expect(args).toContain(`--user-data-dir=${profile}`); // perfil próprio do Claude Deck
    expect(args).toContain('--app=http://127.0.0.1:1/auth?c=x');
    expect(args).toContain('--lang=pt-BR');
    expect(args.some((a) => a.includes('"'))).toBe(false); // o spawn cuida dos espaços do caminho
  });

  it('procura o Brave nos mesmos três lugares do atalho, na mesma ordem', () => {
    const env = { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P', 'ProgramFiles(x86)': 'C:\\P86' } as NodeJS.ProcessEnv;
    const exe = (b: string) => path.join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    expect(findBrave(env, () => true)).toBe(exe('C:\\L'));
    expect(findBrave(env, (p) => p === exe('C:\\P'))).toBe(exe('C:\\P'));
    expect(findBrave(env, (p) => p === exe('C:\\P86'))).toBe(exe('C:\\P86'));
    expect(findBrave(env, () => false)).toBeNull();
    expect(findBrave({} as NodeJS.ProcessEnv, () => true)).toBeNull(); // sem variáveis, sem chute
  });
});

describe('seleção local de navegador', () => {
  const env = { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P', 'ProgramFiles(x86)': 'C:\\P86' } as NodeJS.ProcessEnv;

  it('encontra somente executáveis instalados nas pastas esperadas', () => {
    expect(findBrowser('edge', env, (p) => p === path.join('C:\\P', 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
      .toBe(path.join('C:\\P', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    expect(findBrowser('firefox', env, (p) => p === path.join('C:\\P86', 'Mozilla Firefox', 'firefox.exe')))
      .toBe(path.join('C:\\P86', 'Mozilla Firefox', 'firefox.exe'));
    expect(findBrowser('chrome', env, () => false)).toBeNull();
  });

  it('mantém perfil Brave antigo e separa perfis dos outros navegadores', () => {
    expect(browserProfile('C:\\deck', 'brave')).toBe(path.join('C:\\deck', 'browser-profile'));
    expect(browserProfile('C:\\deck', 'edge')).toBe(path.join('C:\\deck', 'browser-profile-edge'));
    expect(browserProfile('C:\\deck', 'firefox')).toBe(path.join('C:\\deck', 'browser-profile-firefox'));
  });

  it('Brave padrão e fallback para Edge em instalação nova', () => {
    const brave = path.join('C:\\L', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    const edge = path.join('C:\\P', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    expect(resolveBrowser('C:\\deck', env, (p) => p === brave || p === edge).id).toBe('brave');
    expect(resolveBrowser('C:\\deck', env, (p) => p === edge).id).toBe('edge');
  });

  it('respeita seleção gravada e não troca silenciosamente um navegador ausente', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-browser-unit-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'browser.json'), '{"browser":"firefox"}', 'utf8');
      const firefox = path.join('C:\\P', 'Mozilla Firefox', 'firefox.exe');
      expect(resolveBrowser(dataDir, env, (p) => p === firefox || fs.existsSync(p)).id).toBe('firefox');
      expect(() => resolveBrowser(dataDir, env, (p) => p !== firefox && fs.existsSync(p))).toThrow('Navegador firefox não encontrado');
      fs.writeFileSync(path.join(dataDir, 'browser.json'), '{"browser":"unknown"}', 'utf8');
      expect(() => resolveBrowser(dataDir, env, fs.existsSync)).toThrow('Navegador inválido');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('não passa flags Brave para Edge nem flags Chromium para Firefox', () => {
    const edge = { id: 'edge', executable: 'C:\\edge.exe', processName: 'msedge', profileDir: 'C:\\Meu perfil' } as const;
    const firefox = { id: 'firefox', executable: 'C:\\firefox.exe', processName: 'firefox', profileDir: 'C:\\Meu perfil' } as const;
    expect(browserArgs(edge, 'http://127.0.0.1:1/auth?c=x')).toContain('--app=http://127.0.0.1:1/auth?c=x');
    expect(browserArgs(edge, 'x')).not.toContain('--disable-features=BraveRewards');
    expect(browserArgs(firefox, 'http://127.0.0.1:1/auth?c=x')).toEqual(['-profile', 'C:\\Meu perfil', '-new-window', 'http://127.0.0.1:1/auth?c=x']);
  });
});

describe('focusWindow (foco por marker temporário e verificação Win32)', () => {
  const sampleProfile = 'C:\\Users\\Maria Silva\\AppData\\Roaming\\claude-deck\\browser-profile';
  const sampleMarker = 'deck-focus-xyz-987';

  it('buildFocusScript embute marker e profileDir em Base64 UTF-8 seguro contra injeção', () => {
    const maliciousMarker = '"; Remove-Item -Recurse C:\\; Write-Output "$((Get-Process).Name)" `';
    const trickyProfile = 'C:\\Users\\José ` $weird "path"\\AppData\\Roaming\\claude-deck';

    const script = buildFocusScript(trickyProfile, maliciousMarker);

    // O script não pode conter os caracteres perigosos sem codificação
    expect(script).not.toContain(maliciousMarker);
    expect(script).not.toContain(trickyProfile);

    // Extrai o base64 do marker do script e decodifica para validar fidelidade byte-a-byte
    const markerMatch = script.match(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
    expect(markerMatch).not.toBeNull();
    const decodedMarker = Buffer.from(markerMatch![1], 'base64').toString('utf8');
    expect(decodedMarker).toBe(maliciousMarker);

    // Extrai o base64 do profile do script e valida acentos e aspas intactos
    const matches = Array.from(script.matchAll(/\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/g));
    expect(matches).toHaveLength(2);
    const decodedProfile = Buffer.from(matches[1][1], 'base64').toString('utf8');
    expect(decodedProfile).toBe(trickyProfile);

    // Confirma que não há caracteres de escape fora do padrão Base64 dentro dos literais
    for (const m of matches) {
      expect(m[1]).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });

  it('buildFocusEncodedCommand codifica o script em UTF-16LE Base64 para -EncodedCommand', () => {
    const encoded = buildFocusEncodedCommand(sampleProfile, sampleMarker);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);

    // Decodifica UTF-16LE do base64 gerado e compara com o script original
    const decodedScript = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decodedScript).toBe(buildFocusScript(sampleProfile, sampleMarker));
    expect(decodedScript).toContain('DeckWinFocusHelper');
    expect(decodedScript).toContain('SetForegroundWindow');
    expect(decodedScript).toContain('GetForegroundWindow');
    expect(decodedScript).toContain('IsIconic');
    expect(decodedScript).toContain('ShowWindow');
  });

  it('foco de Edge exige nome, caminho do executável e perfil da instalação', () => {
    const browser = { id: 'edge', executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', processName: 'msedge', profileDir: 'C:\\deck\\browser-profile-edge' } as const;
    const script = buildFocusScript(browser.profileDir, sampleMarker, browser);
    expect(script).toContain("$expectedName = 'msedge'");
    expect(script).toContain('$cim.ExecutablePath');
    expect(script).toContain('$procNormalized -eq $targetNormalized');
    expect(script).not.toContain(browser.executable);
  });

  it('Firefox não tenta focar janelas sem identificação nativa confiável', async () => {
    let called = false;
    const browser = { id: 'firefox', executable: 'C:\\Firefox\\firefox.exe', processName: 'firefox', profileDir: 'C:\\deck\\browser-profile-firefox' } as const;
    expect(await focusWindow(browser.profileDir, sampleMarker, { platform: 'win32', browser, execFileFn: (() => { called = true; }) as any })).toBe(false);
    expect(called).toBe(false);
  });

  it('resolvePowerShellExe prioriza override e System32 antes de fallback', () => {
    expect(resolvePowerShellExe('custom-ps.exe')).toBe('custom-ps.exe');

    const existsSystem32 = (p: string) => p.includes('System32');
    const resolved = resolvePowerShellExe(undefined, existsSystem32);
    expect(resolved.toLowerCase()).toContain('system32');

    const notFound = resolvePowerShellExe(undefined, () => false);
    expect(notFound).toBe('powershell.exe');
  });

  it('rejeita parâmetros vazios ou inválidos sem chamar PowerShell', async () => {
    let called = false;
    const fakeExec = (() => {
      called = true;
      return {} as ChildProcess;
    }) as any;

    expect(await focusWindow('', sampleMarker, { execFileFn: fakeExec })).toBe(false);
    expect(await focusWindow('   ', sampleMarker, { execFileFn: fakeExec })).toBe(false);
    expect(await focusWindow(sampleProfile, '', { execFileFn: fakeExec })).toBe(false);
    expect(await focusWindow(sampleProfile, '   ', { execFileFn: fakeExec })).toBe(false);
    expect(await focusWindow(null as any, sampleMarker, { execFileFn: fakeExec })).toBe(false);
    expect(await focusWindow(sampleProfile, null as any, { execFileFn: fakeExec })).toBe(false);
    expect(called).toBe(false);
  });

  it('retorna false imediatamente em sistemas que não sejam win32', async () => {
    let called = false;
    const fakeExec = (() => {
      called = true;
      return {} as ChildProcess;
    }) as any;

    const result = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'linux',
      execFileFn: fakeExec,
    });
    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  it('retorna true quando PowerShell responde OK e envia argumentos seguros', async () => {
    let capturedCmd = '';
    let capturedArgs: readonly string[] = [];
    let capturedOpts: ExecFileOptions | undefined;

    const fakeExec = ((cmd: string, args: readonly string[], opts: ExecFileOptions, cb: Function) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      cb(null, 'OK\r\n', '');
      return {} as ChildProcess;
    }) as any;

    const res = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'win32',
      execFileFn: fakeExec,
      timeoutMs: 3500,
    });

    expect(res).toBe(true);
    expect(capturedCmd).toBe(resolvePowerShellExe());
    expect(capturedArgs[0]).toBe('-NoProfile');
    expect(capturedArgs[1]).toBe('-NonInteractive');
    expect(capturedArgs[2]).toBe('-ExecutionPolicy');
    expect(capturedArgs[3]).toBe('Bypass');
    expect(capturedArgs[4]).toBe('-EncodedCommand');
    expect(capturedArgs[5]).toBe(buildFocusEncodedCommand(sampleProfile, sampleMarker));
    expect(capturedOpts?.timeout).toBe(3500);
    expect((capturedOpts as any)?.windowsHide).toBe(true);
  });

  it('retorna true mesmo com avisos ou quebras de linha antes do OK final', async () => {
    const fakeExec = ((_cmd: string, _args: readonly string[], _opts: any, cb: Function) => {
      cb(null, '#< CLIXML ...\r\nOK\r\n', '');
      return {} as ChildProcess;
    }) as any;

    const res = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'win32',
      execFileFn: fakeExec,
    });
    expect(res).toBe(true);
  });

  it('retorna false quando PowerShell responde FAIL (janela não encontrada ou bloqueio)', async () => {
    const fakeExec = ((_cmd: string, _args: readonly string[], _opts: any, cb: Function) => {
      cb(null, 'FAIL\r\n', '');
      return {} as ChildProcess;
    }) as any;

    const res = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'win32',
      execFileFn: fakeExec,
    });
    expect(res).toBe(false);
  });

  it('retorna false quando PowerShell falha por timeout ou erro', async () => {
    const fakeExec = ((_cmd: string, _args: readonly string[], _opts: any, cb: Function) => {
      const err = new Error('timed out') as any;
      err.killed = true;
      cb(err, '', '');
      return {} as ChildProcess;
    }) as any;

    const res = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'win32',
      execFileFn: fakeExec,
    });
    expect(res).toBe(false);
  });

  it('retorna false se execFile disparar exceção síncrona', async () => {
    const fakeExec = (() => {
      throw new Error('spawn failure');
    }) as any;

    const res = await focusWindow(sampleProfile, sampleMarker, {
      platform: 'win32',
      execFileFn: fakeExec,
    });
    expect(res).toBe(false);
  });

  it('nunca chama ShowWindow síncrono (no PowerShell oculto ele ESCONDE a janela do Deck)', () => {
    const script = buildFocusScript(sampleProfile, sampleMarker);
    expect(script).toContain('ShowWindowAsync');
    expect(script).not.toMatch(/\bShowWindow\s*\(/);
    // O C# vai num here-string literal: o PowerShell não expande nada dentro dele.
    expect(script).toContain("Add-Type -TypeDefinition @'\n");
    expect(script).toMatch(/\n'@\n/);
  });

  it('janela real no Windows: visível continua visível; oculta é achada pela marca e volta à tela', async () => {
    if (process.platform !== 'win32') return;
    const ps = resolvePowerShellExe();
    const enc = (s: string) => Buffer.from(s, 'utf16le').toString('base64');
    const marker = `deck-show-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Janela de OUTRO processo, sem dono (como a do Brave), fora da tela e sem botão na barra de tarefas.
    const target = spawn(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        enc(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DeckShowTestWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
$f = New-Object System.Windows.Forms.Form
$f.Text = '${marker} - Claude Deck'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-4000, -4000)
$f.Size = New-Object System.Drawing.Size(200, 100)
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::SizableToolWindow
$f.ShowInTaskbar = $true
$h = $f.Handle
for ($i = 0; $i -lt 5 -and -not [DeckShowTestWin]::IsWindowVisible($h); $i++) { [void][DeckShowTestWin]::ShowWindow($h, 8) }
[Console]::Out.WriteLine('HWND ' + $h.ToInt64())
[Console]::Out.Flush()
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 30000
$t.add_Tick({ [System.Windows.Forms.Application]::ExitThread() })
$t.Start()
[System.Windows.Forms.Application]::Run()
`),
      ],
      { windowsHide: true },
    );
    try {
      const hwnd = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const to = setTimeout(() => reject(new Error(`a janela de teste não abriu: ${buf}`)), 20000);
        const onData = (d: Buffer) => {
          buf += d;
          const m = /HWND (\d+)/.exec(buf);
          if (m) {
            clearTimeout(to);
            resolve(m[1]);
          }
        };
        target.stdout.on('data', onData);
        target.stderr.on('data', (d: Buffer) => (buf += d));
      });
      // Mesmas condições do servidor: PowerShell novo, oculto, chamado pelo Node, mexendo na janela de outro processo.
      const check = `Add-Type -TypeDefinition @'
${focusHelperSource()}'@
$h = [IntPtr]${hwnd}
function St { if ([DeckWinFocusHelper]::IsIconic($h)) { 'min' } elseif ([DeckWinFocusHelper]::IsWindowVisible($h)) { 'vis' } else { 'hid' } }
$out = @()
[void][DeckWinFocusHelper]::EnsureShown($h)
Start-Sleep -Milliseconds 300
$out += 'visivel=' + (St)
[void][DeckWinFocusHelper]::ShowWindowAsync($h, 0)
for ($i = 0; $i -lt 50 -and [DeckWinFocusHelper]::IsWindowVisible($h); $i++) { Start-Sleep -Milliseconds 20 }
$out += 'escondida=' + (St)
$out += 'achada=' + @([DeckWinFocusHelper]::FindWindows('${marker}') | Where-Object { $_.Handle -eq $h }).Count
[void][DeckWinFocusHelper]::EnsureShown($h)
Start-Sleep -Milliseconds 300
$out += 'depois=' + (St)
Write-Output ($out -join ' ')
`;
      const out = await new Promise<string>((resolve, reject) => {
        execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(check)], { windowsHide: true, timeout: 25000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`${err.message}\n${stderr}`));
          else resolve(String(stdout).trim());
        });
      });
      expect(out).toBe('visivel=vis escondida=hid achada=1 depois=vis');
    } finally {
      target.kill();
    }
  }, 60000);

  it('execução real em win32 com marker inexistente retorna false sem erros ou travamento', async () => {
    if (process.platform !== 'win32') return;

    // Executa PowerShell real no sistema procurando um marker aleatório que não existe
    const nonExistentMarker = `deck-marker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const start = Date.now();
    const focused = await focusWindow(sampleProfile, nonExistentMarker, { timeoutMs: 4000 });
    const elapsed = Date.now() - start;

    expect(focused).toBe(false);
    expect(elapsed).toBeLessThan(4000);
  });
});

