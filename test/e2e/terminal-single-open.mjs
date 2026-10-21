// Abrir o terminal (atalho, barra de status, de novo depois de fechar) cria exatamente UM terminal.
// Regressão: o atalho e o próprio painel, ao montar, pediam `term.open` ao mesmo tempo e apareciam 2 abas.
import assert from 'node:assert/strict';
import { startEnv, helpers, sleep, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX });
const { page } = env;
const h = helpers(page);

const tabCount = () => page.$$eval('.terminal-panel .terminal-tab', (tabs) => tabs.length);
/** Espera o painel aparecer e dá tempo para uma segunda abertura (se houver bug) chegar antes de contar. */
async function settledTabCount() {
  await page.waitForSelector('.terminal-panel .terminal-tab', { timeout: 15000 });
  await sleep(1500);
  return tabCount();
}
async function ctrlBackquote() {
  await page.keyboard.down('Control');
  await page.keyboard.press('Backquote');
  await page.keyboard.up('Control');
}

try {
  await page.waitForSelector('.empty-chat');

  await ctrlBackquote();
  assert.equal(await settledTabCount(), 1, 'Ctrl+` abriu mais de um terminal');
  console.log('PASS: Ctrl+` abre 1 terminal');

  await page.click('.terminal-panel .terminal-tab .tab-close');
  await h.waitFor(() => !document.querySelector('.terminal-panel'), 10000, 'painel fechar após fechar a única aba');
  console.log('PASS: fechar a única aba esconde o painel');

  await page.click('.statusbar .sb-item[title^="Alternar terminal"]');
  assert.equal(await settledTabCount(), 1, 'a barra de status abriu mais de um terminal');
  console.log('PASS: barra de status abre 1 terminal');

  // Botão "Novo terminal" continua criando um segundo de propósito.
  await page.click('.terminal-panel .icon-btn[title="Novo terminal"]');
  await h.waitFor(() => document.querySelectorAll('.terminal-panel .terminal-tab').length === 2, 10000, 'segunda aba pelo botão Novo terminal');
  assert.equal(await tabCount(), 2);
  console.log('PASS: botão Novo terminal continua abrindo outro');
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
