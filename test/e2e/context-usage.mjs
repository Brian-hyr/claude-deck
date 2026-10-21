// /context e pizza: modal detalhado com dados reais do Claude falso, sem compactação involuntária.
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { FAKE_CONTEXT_WINDOW: '100000' } });
const { page } = env;
const h = helpers(page);
const shots = path.join(ROOT, 'test', 'shots', 'context-usage');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
let failed = false;

async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL: ${name}\n    ${String(e?.message ?? e).split('\n')[0]}`);
    await page.screenshot({ path: path.join(shots, `FALHA-${Date.now()}.png`) }).catch(() => {});
  }
}
const bubbles = () => page.$$eval('.user-bubble', (els) => els.map((e) => e.textContent.trim()));

try {
  await step('conversa nova: a pizza aparece e não compacta no clique', async () => {
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
    h.assert((await page.$eval('.ctx-pie', (el) => el.getAttribute('aria-label'))).includes('clique para ver o detalhamento'), 'a pizza deve abrir o contexto');
    await page.click('.ctx-pie');
    await page.waitForSelector('.context-modal', { timeout: 5000 });
    await h.waitText('.context-modal .ctx-section-title', 'Categorias');
    h.assert(!(await bubbles()).includes('/compact'), 'clique na pizza disparou /compact');
    await page.screenshot({ path: path.join(shots, 'contexto-escuro.png') });
    await page.keyboard.press('Escape');
    await h.waitFor(() => !document.querySelector('.context-modal'), 5000, 'fechar modal com Esc');
  });

  await step('/context digitado abre o mesmo modal sem enviar uma mensagem', async () => {
    const before = await bubbles();
    await h.send('/context');
    // O primeiro Enter aceita a sugestão do autocomplete; o segundo envia o comando.
    if ((await h.composerValue()).trim() === '/context') await page.keyboard.press('Enter');
    await page.waitForSelector('.context-modal', { timeout: 5000 });
    h.assert((await h.composerValue()) === '', 'comando permaneceu no compositor');
    h.assert(JSON.stringify(await bubbles()) === JSON.stringify(before), '/context virou mensagem na conversa');
    await h.waitText('.context-modal .ctx-name', 'System prompt');
    await h.waitText('.context-modal .ctx-detail-name', 'Explore');
    h.assert((await page.$$('.context-modal .ctx-seg')).length >= 4, 'barra não foi segmentada');
    await page.click('.context-modal .btn.secondary');
    await h.waitFor(() => !document.querySelector('.context-modal'), 5000, 'fechar modal');
  });

  await step('o modal permanece legível no tema claro', async () => {
    await h.hotkey('Control', 'Shift', 'P');
    await h.waitText('.quickpick .qp-title', 'Comandos');
    await page.keyboard.type('tema claro');
    await page.keyboard.press('Enter');
    await h.waitFor(() => document.documentElement.dataset.theme === 'light', 3000, 'tema claro');
    await page.click('.ctx-pie');
    await h.waitText('.context-modal .ctx-name', 'System prompt');
    await page.screenshot({ path: path.join(shots, 'contexto-claro.png') });
    await page.keyboard.press('Escape');
    await h.hotkey('Control', 'Shift', 'P');
    await page.keyboard.type('tema escuro');
    await page.keyboard.press('Enter');
    await h.waitFor(() => document.documentElement.dataset.theme === 'dark', 3000, 'tema escuro');
  });

  await step('o botão /compact compacta só quando acionado explicitamente', async () => {
    await h.send('ctx 60000');
    await h.waitText('.msg .md', 'contexto simulado: 60000');
    await h.waitIdle();
    await page.click('.ctx-pie');
    await page.waitForSelector('.context-modal .dialog-foot .btn:not(.secondary)');
    h.assert(!(await bubbles()).includes('/compact'), 'abertura do modal compactou');
    await page.click('.context-modal .dialog-foot .btn:not(.secondary)');
    await h.waitFor(() => [...document.querySelectorAll('.user-bubble')].some((el) => el.textContent.trim() === '/compact'), 8000, 'mensagem /compact');
    await h.waitIdle();
    h.assert((await bubbles()).filter((text) => text === '/compact').length === 1, 'botão enviou /compact mais de uma vez');
  });

  await step('o botão deixa /compact na fila enquanto Claude trabalha e bloqueia repetição', async () => {
    await h.send('slow 40');
    await h.waitFor(() => !!document.querySelector('.send-btn.stop'), 8000, 'turno começar');
    await page.click('.ctx-pie');
    await h.waitText('.context-modal .dialog-foot', 'Deixar /compact na fila');
    await page.click('.context-modal .dialog-foot .btn:not(.secondary)');
    await h.waitFor(() => [...document.querySelectorAll('.user-bubble')].filter((el) => el.textContent.trim() === '/compact').length === 2, 8000, 'compactação enfileirada');
    await page.click('.ctx-pie');
    await h.waitText('.context-modal .dialog-foot', 'Compactação na fila');
    h.assert(await page.$eval('.context-modal .dialog-foot .btn:not(.secondary)', (el) => el.disabled), 'botão permite duplicar /compact');
    await page.keyboard.press('Escape');
    await h.waitIdle(30000);
    h.assert((await bubbles()).filter((text) => text === '/compact').length === 2, 'compactação duplicada');
  });

  await step('sem erros no console da página', async () => {
    h.assert(env.app.errors.length === 0, env.app.errors.join('\n'));
  });
} finally {
  await env.stop();
}
console.log(failed ? 'RESULTADO: FALHOU' : 'RESULTADO: tudo certo');
process.exit(failed ? 1 : 0);
