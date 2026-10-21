// Colar com o botão direito no terminal quando o NAVEGADOR nega a leitura da área de transferência.
// Regressão: no perfil real do app a permissão ficou "bloqueada" (setting=2) e o toast "Não foi possível ler a
// área de transferência" aparecia sempre. O servidor (mesma máquina) lê a área de transferência do Windows.
//
// ATENÇÃO: este teste usa a área de transferência REAL do Windows (o servidor lê de lá, não do navegador de
// teste). Ele guarda o texto atual e o restaura no fim; se havia imagem/arquivos copiados, eles se perdem.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startEnv, helpers, SANDBOX } from './harness.mjs';

const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const readWinClipboard = () => {
  const out = ps("$t = Get-Clipboard -Raw -Format Text; if ($null -ne $t) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t))) }").trim();
  return out ? Buffer.from(out, 'base64').toString('utf8') : null;
};
const writeWinClipboard = (text) => {
  const b64 = Buffer.from(text ?? '', 'utf8').toString('base64');
  ps(`$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); ${text ? 'Set-Clipboard -Value $v' : 'Set-Clipboard -Value $null'}`);
};

const previous = readWinClipboard();
/** Último texto que o teste pôs na área de transferência (null = ainda não mexeu). */
let lastSet = null;
const setClipboard = (text) => {
  lastSet = text;
  writeWinClipboard(text);
};
const env = await startEnv({ sandboxSrc: SANDBOX });
const { page } = env;
const h = helpers(page);
const terminalText = () => page.$$eval('.terminal-panel .xterm-rows', (rows) => rows.map((r) => r.textContent).join('\n'));

try {
  await page.waitForSelector('.empty-chat');
  // O navegador passa a negar a leitura, como no perfil real com a permissão bloqueada.
  await env.browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${env.port}`, []);
  const denied = await page.evaluate(() => navigator.clipboard.readText().then(() => 'ok', (e) => e.name));
  assert.equal(denied, 'NotAllowedError', 'a pré-condição falhou: o navegador de teste ainda permite ler a área de transferência');
  console.log('PASS: navegador nega readText (pré-condição)');

  await page.keyboard.down('Control');
  await page.keyboard.press('Backquote');
  await page.keyboard.up('Control');
  await page.waitForSelector('.terminal-panel .xterm-helper-textarea', { timeout: 15000 });
  await h.waitFor(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.trim().length > 0, 15000, 'prompt do terminal');

  setClipboard("Write-Output ('DECK_DENIED_' + (40 + 2))");
  await page.click('.terminal-panel .xterm-screen', { button: 'right' });
  // O servidor chama o PowerShell para ler: o texto chega depois do clique, então espera ele aparecer antes do Enter.
  await h.waitFor(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.includes("'DECK_DENIED_' + (40 + 2)"), 15000, 'texto colado pelo servidor aparecer na linha de comando');
  await page.focus('.terminal-panel .xterm-helper-textarea');
  await page.keyboard.press('Enter');
  await h.waitFor(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.includes('DECK_DENIED_42'), 15000, 'comando colado executado no PTY');
  assert.ok(!(await page.$('.toast.error')),'apareceu um toast de erro mesmo com o servidor lendo a área de transferência');
  console.log('PASS: botão direito cola pelo servidor quando o navegador nega');

  // Área de transferência vazia: não cola nada e não dá erro.
  const before = await terminalText();
  setClipboard('');
  await page.click('.terminal-panel .xterm-screen', { button: 'right' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await terminalText(), before, 'colar com a área de transferência vazia alterou o terminal');
  console.log('PASS: área de transferência vazia não cola nem avisa erro');
} catch (e) {
  console.error(e);
  console.error('Toasts:', await page.$$eval('.toast', (t) => t.map((x) => x.textContent)).catch(() => []));
  console.error('Terminal:', await terminalText().catch(() => ''));
  console.error('Windows clipboard:', JSON.stringify(readWinClipboard()));
  console.error('Browser errors:', env.app.errors);
  console.error('Server log:', env.serverLog());
  process.exitCode = 1;
} finally {
  // Só restaura se a área de transferência ainda é a do teste: se a pessoa copiou algo nesse meio tempo, não pisa.
  try { if (lastSet !== null && (readWinClipboard() ?? '') === lastSet) writeWinClipboard(previous); } catch { /* melhor esforço */ }
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
