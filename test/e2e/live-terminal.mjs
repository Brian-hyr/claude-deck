// Real browser + actual PTY + fake CLI using the MCP control protocol. No model inference.
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { CLAUDE_DECK_TEST_HOOKS: '1' } });
const { page } = env;
const h = helpers(page);
const shots = path.join(ROOT, 'test', 'shots', 'live-terminal');
fs.mkdirSync(shots, { recursive: true });
const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`PASS: ${name}`);
}
async function terminalText() {
  return page.$$eval('.terminal-panel .xterm-rows', (rows) => rows.map((r) => r.textContent).join('\n'));
}
let checkedManualLock = false;
async function run(command, token) {
  await h.send(`term ${command}`);
  await h.waitText('.perm-card .perm-title', 'Permitir?');
  if (!checkedManualLock) {
    await page.focus('.terminal-panel .xterm-helper-textarea');
    await page.keyboard.type('BLOCKED_MANUAL');
    await h.waitText('.toast', 'Pare o Claude');
    h.assert(!(await terminalText()).includes('BLOCKED_MANUAL'), 'manual text collided with live turn');
    await h.waitFor(() => ![...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('Pare o Claude')), 6000, 'old terminal lock warning to clear');
    await page.evaluate(() => navigator.clipboard.writeText("Write-Output 'BLOCKED_PASTE'\r"));
    await page.click('.terminal-panel .xterm-screen', { button: 'right' });
    await h.waitText('.toast', 'Pare o Claude');
    h.assert(!(await terminalText()).includes('BLOCKED_PASTE'), 'right-click paste bypassed the live terminal lock');
    checkedManualLock = true;
  }
  await h.clickText('.perm-card .perm-actions .btn', 'Permitir', true);
  await h.waitIdle(30000);
  // Expand the newest tool result. It is the text given back to the CLI, not a simulated echo.
  const tools = await page.$$('.tool .tool-head');
  await tools.at(-1).click();
  await h.waitText('.tool .pre', token, 15000);
  await h.waitFor((t) => [...document.querySelectorAll('.terminal-panel .xterm-rows')].some((e) => e.textContent.includes(t)), 15000, 'real terminal output', token);
}
try {
  await step('conversation starts silently with MCP available', async () => {
    await page.waitForSelector('.empty-chat');
    await h.hotkey('Control', 'Shift', 'N');
    await h.waitText('.quickpick .qp-title', 'escolha o servidor');
    await h.clickText('.quickpick .qp-item', 'Este computador');
    await h.waitText('.quickpick .qp-title', 'escolha a pasta');
    await page.focus('.quickpick input');
    await page.keyboard.type(env.sandbox);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.chat-header', { timeout: 15000 });
    await h.waitIdle();
    await h.waitText('.composer .pill-select', 'Silencioso');
    await h.send('termtools');
    await h.waitText('.msg .md', 'mcp__deck_terminal__run');
    await h.waitIdle();
    h.assert((await page.$('.terminal-panel')) === null, 'silent startup opened a terminal');
  });
  await step('live switch binds a terminal docked right of the chat', async () => {
    await h.clickText('.composer .pill-select', 'Silencioso', true);
    await page.waitForSelector('.terminal-panel.dock-right .xterm');
    await h.waitText('.composer .pill-select', 'Terminal ao Vivo');
    const boxes = await page.evaluate(() => {
      const c = document.querySelector('.center').getBoundingClientRect();
      const t = document.querySelector('.terminal-panel').getBoundingClientRect();
      return { chatRight: c.right, terminalLeft: t.left, width: t.width, height: t.height };
    });
    h.assert(boxes.terminalLeft >= boxes.chatRight - 2 && boxes.width > 300 && boxes.height > 400, JSON.stringify(boxes));
    await page.waitForSelector('.terminal-tab.claude');
  });
  await step('computed output reaches the visible terminal AND the Claude tool result', async () => {
    await run("Write-Output ('BROWSER-' + (6 * 7)); Write-Output 'Connected 10.2.3.4'", 'BROWSER-42');
    await page.screenshot({ path: path.join(shots, 'command-and-result.png') });
    const colored = await page.$$eval('.terminal-panel .xterm-rows span', (spans) => spans.some((s) => /Connected/.test(s.textContent) && getComputedStyle(s).color !== 'rgb(204, 204, 204)'));
    h.assert(colored, 'custom highlighting missing from Connected output');
  });
  await step('shell state persists across Claude tool calls', async () => {
    await run("$deckLiveProof = 81; Write-Output ('SET-' + $deckLiveProof)", 'SET-81');
    await run("Write-Output ('PERSIST-' + ($deckLiveProof + 1))", 'PERSIST-82');
  });
  await step('permission denial does not reach the PTY', async () => {
    await h.send("term Write-Output ('DENIED-' + (5 * 9))");
    await h.waitText('.perm-card .perm-title', 'Permitir?');
    await h.clickText('.perm-card .perm-actions .btn', 'Negar');
    await h.waitIdle();
    h.assert(!(await terminalText()).includes('DENIED-45'), 'denied command executed');
  });
  await step('moving the panel down and back preserves its session and output', async () => {
    await page.click('button[title="Mover o terminal para baixo"]');
    await h.waitFor(() => document.querySelector('.terminal-panel') && !document.querySelector('.terminal-panel.dock-right'), 5000, 'bottom dock');
    h.assert((await terminalText()).includes('PERSIST-82'), 'buffer lost moving panel');
    await page.click('button[title="Mover o terminal para a direita"]');
    await page.waitForSelector('.terminal-panel.dock-right');
  });
  await step('page reload restores binding and terminal output', async () => {
    await page.reload({ waitUntil: 'networkidle2' });
    await h.waitIdle();
    await h.waitText('.composer .pill-select', 'Terminal ao Vivo');
    if (!(await page.$('.terminal-panel'))) await h.hotkey('Control', 'j');
    await h.waitFor(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.includes('PERSIST-82'), 15000, 'restored PTY output');
    await run("Write-Output ('RELOAD-' + ($deckLiveProof + 2))", 'RELOAD-83');
  });
  await step('returning to silent blocks terminal writes without losing its shell', async () => {
    await h.clickText('.composer .pill-select', 'Terminal ao Vivo', true);
    await h.waitText('.composer .pill-select', 'Silencioso');
    await h.send("term Write-Output ('SILENT-' + (7 * 9))");
    await h.waitText('.perm-card .perm-title', 'Permitir?');
    await h.clickText('.perm-card .perm-actions .btn', 'Permitir', true);
    await h.waitIdle();
    const tools = await page.$$('.tool .tool-head');
    await tools.at(-1).click();
    await h.waitText('.tool .pre', 'DESLIGADO');
    h.assert(!(await terminalText()).includes('SILENT-63'), 'silent command entered live PTY');
  });
  await step('selecting copies and right-clicking pastes in the terminal', async () => {
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const row = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.terminal-panel .xterm-rows > div')].find((r) => r.textContent.includes('PERSIST-82'));
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + 25, y: rect.top + rect.height / 2 };
    });
    h.assert(row, 'terminal output to select was not visible');
    await page.mouse.move(row.x - 22, row.y);
    await page.mouse.down();
    await page.mouse.move(row.x + 115, row.y, { steps: 8 });
    await page.mouse.up();
    await h.waitFor(async () => (await navigator.clipboard.readText()).includes('PERSIST-82'), 5000, 'selected terminal text copied');

    await page.evaluate(() => navigator.clipboard.writeText("Write-Output ('DECK_PASTE_' + (50 + 8))"));
    await page.mouse.click(row.x, row.y, { button: 'right' });
    await page.focus('.terminal-panel .xterm-helper-textarea');
    await page.keyboard.press('Enter');
    await h.waitFor(() => document.querySelector('.terminal-panel .xterm-rows')?.textContent.includes('DECK_PASTE_58'), 10000, 'right-click pasted into the PTY');
  });
  h.assert(env.app.errors.length === 0, env.app.errors.join('\n'));
  console.log(`Live terminal browser checks: ${results.length} passed. Screenshot: ${path.join(shots, 'command-and-result.png')}`);
} catch (e) {
  await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  console.error(e);
  console.error('Browser errors:', env.app.errors);
  console.error('Server log:', env.serverLog());
  process.exitCode = 1;
} finally {
  await env.stop();
}
