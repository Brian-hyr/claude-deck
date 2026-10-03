// Atalhos numa janela --app VISÍVEL do Brave (perfil temporário, processo separado do Brave do
// dia a dia). As teclas vão pelo Windows (SendInput), pelo mesmo caminho do teclado físico —
// incluindo os atalhos reservados do próprio navegador (Ctrl+W, Ctrl+N, Ctrl+T…).
//
// Segurança: cada tecla só sai se a janela em primeiro plano for do Brave DE TESTE (conferido pelo
// PID do processo que este script abriu) e todas vão numa única chamada SendInput (atômica). Se o
// foco não estiver lá, nada é enviado — um Ctrl+W nunca cai no Brave do dia a dia nem no VS Code.
//
//   node test/e2e/shortcuts-headful.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { ROOT, FAKE, sleep, SANDBOX } from './harness.mjs';
import { BRAVE } from './browser.mjs';

const SANDBOX_SRC = SANDBOX;
const port = 47900 + Math.floor(Math.random() * 90);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dataDir = tmp('deck-kb-data-');
const claudeDir = tmp('deck-kb-claude-');
const sshDir = tmp('deck-kb-ssh-');
const sandbox = tmp('deck-kb-sb-');
const profile = tmp('deck-kb-brave-');
fs.cpSync(SANDBOX_SRC, sandbox, { recursive: true });
fs.writeFileSync(path.join(sshDir, 'config'), '');
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ localClaudePath: FAKE, defaultPermissionMode: 'default', notifications: false }));

const health = () =>
  new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => (r.resume(), res(r.statusCode === 200))).on('error', () => res(false)));
const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.mjs'), '--port', String(port), '--data-dir', dataDir, '--no-import', '--quiet'], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_DECK_SSH_DIR: sshDir },
  stdio: 'ignore',
  windowsHide: true,
});
for (let i = 0; i < 100 && !(await health()); i++) await sleep(100);
const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();

let brave = null;
let browser = null;
function cleanup() {
  for (const p of [brave?.pid, server.pid]) {
    if (!p) continue;
    try {
      execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* já fechado */
    }
  }
}
process.on('exit', cleanup);

// Janela --app de verdade (como o atalho abre), com depuração só nesta instância temporária.
brave = spawn(
  BRAVE,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=BraveRewards',
    '--window-size=1400,900',
    '--window-position=60,40',
    `--app=http://127.0.0.1:${port}/auth?t=${token}`,
  ],
  { stdio: 'ignore' },
);
let wsUrl = null;
for (let i = 0; i < 150 && !wsUrl; i++) {
  try {
    const line = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
    if (line[1]) wsUrl = `ws://127.0.0.1:${line[0].trim()}${line[1].trim()}`;
  } catch {
    /* ainda não */
  }
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) throw new Error('Brave de teste não abriu a porta de depuração');
browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
let page = null;
for (let i = 0; i < 100 && !page; i++) {
  page = (await browser.pages()).find((p) => p.url().startsWith(`http://127.0.0.1:${port}`)) ?? null;
  if (!page) await sleep(100);
}
await page.waitForSelector('.app', { timeout: 20000 });

// ------------------------------------------------------------------ teclado real do Windows
const PS_SEND = String.raw`
param([int]$BravePid, [string]$Keys)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class K {
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct IN { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr FindFor(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = GetWindowThreadProcessId(fg, out dummy);
    uint me = GetCurrentThreadId();
    bool att = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (att) AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == h;
  }
  public static bool SendAll(uint pid, ushort[] codes) {
    var a = new IN[codes.Length * 2];
    for (int i = 0; i < codes.Length; i++) { a[i].type = 1; a[i].ki.vk = codes[i]; }
    for (int i = 0; i < codes.Length; i++) { var j = codes.Length + i; a[j].type = 1; a[j].ki.vk = codes[codes.Length - 1 - i]; a[j].ki.flags = 2; }
    if (PidOf(GetForegroundWindow()) != pid) return false;
    return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(IN))) == a.Length;
  }
}
"@
$h = [K]::FindFor([uint32]$BravePid)
if ($h -eq [IntPtr]::Zero) { Write-Output "SEMJANELA"; exit 0 }
if ([K]::PidOf([K]::GetForegroundWindow()) -ne [uint32]$BravePid) {
  [void][K]::Focus($h)
  Start-Sleep -Milliseconds 200
  if ([K]::PidOf([K]::GetForegroundWindow()) -ne [uint32]$BravePid) { [void][K]::Focus($h); Start-Sleep -Milliseconds 300 }
}
if ([K]::PidOf([K]::GetForegroundWindow()) -ne [uint32]$BravePid) { Write-Output "SEMFOCO"; exit 0 }
$vk = @{ ctrl = 0x11; shift = 0x10; alt = 0x12; tab = 0x09; esc = 0x1B; enter = 0x0D }
$codes = [uint16[]]@(foreach ($k in $Keys.Split('+')) { if ($vk.ContainsKey($k)) { $vk[$k] } elseif ($k.Length -eq 1) { [int][char]$k.ToUpper() } else { throw "tecla $k" } })
if ([K]::SendAll([uint32]$BravePid, $codes)) { Write-Output "OK" } else { Write-Output "SEMFOCO" }
`;
const psFile = path.join(profile, 'send.ps1');
fs.writeFileSync(psFile, '\ufeff' + PS_SEND, 'utf8');
async function press(keys) {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-BravePid', String(brave.pid), '-Keys', keys], { encoding: 'utf8' }).trim();
  if (out !== 'OK') throw new Error(`não mandei ${keys} (${out}) — nenhuma tecla saiu`);
  await sleep(500);
}

const tabs = () => page.$$eval('.center .tabs .tab', (e) => e.length).catch(() => -1);
const activeIdx = () => page.$$eval('.center .tabs .tab', (e) => e.findIndex((x) => x.classList.contains('active'))).catch(() => -1);
const pagesCount = async () => (await browser.pages()).length;
const alive = async () => {
  try {
    return (await page.evaluate(() => 1)) === 1;
  } catch {
    return false;
  }
};
const focusComposer = () => page.evaluate(() => document.querySelector('.composer textarea')?.focus());

const results = [];
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: true, r });
    console.log(`• ${name}: ok${r ? ` — ${r}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, e: e.message });
    console.log(`• ${name}: FALHOU — ${e.message}`);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).catch(() => {});
  }
}

// Conversa inicial — pela API do app (não depende do foco da janela nem de animações).
try {
  await page.evaluate(async (cwd) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    ws.send(JSON.stringify({ id: 1, method: 'sessions.create', params: { hostId: 'local', cwd } }));
    await new Promise((r) => (ws.onmessage = (e) => JSON.parse(e.data).id === 1 && r()));
    ws.close();
  }, sandbox);
  // Conversa criada por outro cliente entra como aba sem roubar o foco: ativa clicando.
  await page.waitForSelector('.center .tabs .tab', { timeout: 10000 });
  await page.click('.center .tabs .tab');
  await page.waitForSelector('.chat-header', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.phase-pill.idle'), { timeout: 15000 });
  await page.evaluate(() => {
    // Explorador na pasta da conversa (para o teste do Ctrl+W no arquivo).
    const b = document.querySelector('.act-btn[title^="Explorador"]');
    if (!document.querySelector('.sidebar .tree-row')) b?.click();
  });
  await focusComposer();
} catch (e) {
  const dump = await page.evaluate(() => ({
    vis: document.visibilityState,
    focus: document.hasFocus(),
    qp: document.querySelector('.quickpick .qp-title')?.textContent ?? null,
    tabs: document.querySelectorAll('.center .tabs .tab').length,
    phase: document.querySelector('.phase-pill')?.textContent ?? null,
  }));
  console.log('preparo falhou:', e.message, JSON.stringify(dump));
  throw e;
}
console.log(`janela: visível=${await page.evaluate(() => document.visibilityState)}`);

await check('controle: tecla real chega ao app (Ctrl+Shift+P abre a paleta)', async () => {
  await press('ctrl+shift+p');
  await page.waitForSelector('.quickpick', { timeout: 3000 });
  await press('esc');
  await page.waitForFunction(() => !document.querySelector('.quickpick'), { timeout: 3000 });
});

await check('Ctrl+N: nova conversa na mesma pasta (não abre janela do navegador)', async () => {
  const [t0, p0] = [await tabs(), await pagesCount()];
  await press('ctrl+n');
  await page.waitForFunction((n) => document.querySelectorAll('.center .tabs .tab').length === n + 1, { timeout: 5000 }, t0);
  const p1 = await pagesCount();
  if (p1 !== p0) throw new Error(`abriu ${p1 - p0} janela(s) do navegador`);
  return `${t0} → ${await tabs()} abas`;
});

await check('Ctrl+T: nova conversa (não abre aba do navegador)', async () => {
  const [t0, p0] = [await tabs(), await pagesCount()];
  await press('ctrl+t');
  await page.waitForFunction((n) => document.querySelectorAll('.center .tabs .tab').length === n + 1, { timeout: 5000 }, t0);
  const p1 = await pagesCount();
  if (p1 !== p0) throw new Error(`abriu ${p1 - p0} aba(s)/janela(s) do navegador`);
  return `${t0} → ${await tabs()} abas`;
});

await check('Ctrl+Tab / Ctrl+Shift+Tab: troca de conversa', async () => {
  const i0 = await activeIdx();
  await press('ctrl+tab');
  const i1 = await activeIdx();
  await press('ctrl+shift+tab');
  const i2 = await activeIdx();
  if (i1 === i0 || i2 !== i0) throw new Error(`índices ${i0} → ${i1} → ${i2}`);
  return `aba ${i0} → ${i1} → ${i2}`;
});

await check('Alt+1: primeira conversa', async () => {
  await press('alt+1');
  const i = await activeIdx();
  if (i !== 0) throw new Error(`ativa: ${i}`);
});

await check('Ctrl+W fora do editor: não fecha a janela do app', async () => {
  await focusComposer();
  await page.click('.composer textarea');
  await press('ctrl+w');
  await sleep(700);
  if (!(await alive())) throw new Error('A JANELA DO APP FECHOU');
  return `janela aberta, ${await tabs()} abas`;
});

await check('Ctrl+W depois de clicar na visualização de um arquivo: fecha só o arquivo', async () => {
  await page.evaluate(() => [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.querySelector('.label')?.textContent === 'README.md')?.click());
  await page.waitForFunction(() => document.querySelector('.editor-panel .tab.active .tab-label')?.textContent === 'README.md', { timeout: 5000 });
  await page.waitForSelector('.md-view', { timeout: 5000 });
  await page.click('.md-view');
  const f0 = await page.$$eval('.editor-panel .tab', (e) => e.length);
  await press('ctrl+w');
  await sleep(500);
  if (!(await alive())) throw new Error('A JANELA DO APP FECHOU');
  const f1 = await page.$$eval('.editor-panel .tab', (e) => e.length).catch(() => 0);
  if (f1 !== f0 - 1) throw new Error(`arquivos ${f0} → ${f1}`);
  return `arquivos ${f0} → ${f1}`;
});

await check('Ctrl+Shift+W: fecha a conversa atual (não a janela)', async () => {
  await page.click('.composer textarea');
  const t0 = await tabs();
  await press('ctrl+shift+w');
  await sleep(700);
  if (!(await alive())) throw new Error('A JANELA DO APP FECHOU');
  const t1 = await tabs();
  if (t1 !== t0 - 1) throw new Error(`abas ${t0} → ${t1}`);
  return `abas ${t0} → ${t1}`;
});

await check('Ctrl+Shift+N: seletor de nova conversa (não janela anônima)', async () => {
  const p0 = await pagesCount();
  await press('ctrl+shift+n');
  await page.waitForSelector('.quickpick', { timeout: 3000 });
  await press('esc');
  const p1 = await pagesCount();
  if (p1 !== p0) throw new Error(`abriu ${p1 - p0} janela(s)`);
});

await check('Ctrl+P, Ctrl+B e Ctrl+Shift+E', async () => {
  await press('ctrl+p');
  await page.waitForSelector('.quickpick', { timeout: 3000 });
  await press('esc');
  await press('ctrl+b');
  const hidden = await page.$('.sidebar').then((x) => !x);
  await press('ctrl+shift+e');
  const shown = !!(await page.$('.sidebar'));
  if (!hidden || !shown) throw new Error(`barra lateral: escondeu=${hidden} voltou=${shown}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} atalhos ok`);
await browser.close().catch(() => {});
cleanup();
await sleep(700);
for (const d of [dataDir, claudeDir, sshDir, sandbox, profile]) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* o Brave ainda segurando algum arquivo: fica para a limpeza do sistema */
  }
}
process.exit(failed.length ? 1 : 0);
