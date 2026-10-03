// Conferência SÓ DE LEITURA da primeira execução real: o app já rodando na porta padrão com a
// pasta de dados de verdade (%APPDATA%\claude-deck). Abre um Brave separado (perfil temporário),
// olha servidores, histórico local e explorador, tira capturas e fecha. Não abre conversa, não
// conecta em servidor nenhum e não altera arquivos. Imprime só contagens (nada de nomes/IPs).
//
//   node test/e2e/real-data-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openApp } from './browser.mjs';

const PORT = Number(process.env.CLAUDE_DECK_PORT || 47319);
const DATA = path.join(process.env.APPDATA, 'claude-deck');
const SHOTS = path.resolve('test/shots/real');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await openApp({ port: PORT, dataDir: DATA, width: 1600, height: 940 });
const { page } = app;
const out = {};
/** Mostra a vista da barra lateral sem alternar (clicar na vista já ativa a esconderia). */
const showView = async (titlePrefix) => {
  const active = await page.$eval(`.act-btn.active[title^="${titlePrefix}"]`, () => true).catch(() => false);
  if (!active) await page.click(`.act-btn[title^="${titlePrefix}"]`);
  await sleep(300);
};
try {
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  await sleep(800);
  await shot('01-inicio');

  // Servidores: quantos aparecem e quantos favoritos (sem conectar).
  await showView('Servidores');
  await page.waitForSelector('.sidebar .tree-row', { timeout: 10000 });
  await sleep(400);
  out.servidoresNaLista = await page.$$eval('.sidebar .tree-row', (r) => r.length);
  out.hosts = await page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    const r = await new Promise((res, rej) => {
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'hosts.list', params: {} }));
      ws.onmessage = (e) => {
        const x = JSON.parse(e.data);
        if (x.id === 1) (ws.close(), x.error ? rej(new Error(x.error.message)) : res(x.result));
      };
      ws.onerror = () => rej(new Error('ws'));
    });
    return { total: r.length, favoritos: r.filter((h) => h.favorite).length, comPastasRecentes: r.filter((h) => h.recentFolders?.length).length };
  });
  await shot('02-servidores');

  // Histórico local (todas as pastas): projetos e conversas da pasta pessoal.
  await showView('Histórico');
  const seg = await page.$$('.sidebar .seg button');
  if (seg[1]) await seg[1].click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar .tree-row').length > 0 || document.querySelector('.sidebar .tree-empty'), { timeout: 60000 });
  await sleep(300);
  out.historicoProjetosLocais = await page.$$eval('.sidebar .tree-row', (r) => r.length);
  await shot('03-historico-projetos');
  // Abre a lista da pasta com mais conversas (só lista; não abre nenhuma conversa).
  const idx = await page.$$eval('.sidebar .tree-row .desc', (d) => {
    let best = 0, n = -1;
    d.forEach((e, i) => {
      const c = parseInt(e.textContent, 10) || 0;
      if (c > n) (n = c), (best = i);
    });
    return best;
  });
  const rows = await page.$$('.sidebar .tree-row');
  await rows[idx].click();
  await page.waitForFunction(() => document.querySelector('.sidebar .tree-row .codicon-arrow-left'), { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar .tree-loading'), { timeout: 120000 });
  await sleep(500);
  out.conversasNaMaiorPasta = await page.$$eval('.sidebar .tree-row', (r) => r.length - 1);
  out.arquivadasOcultas = await page.$eval('.sidebar .tree-empty a', (a) => a.textContent.replace(/\D+/g, '')).catch(() => '0');
  await shot('04-historico-conversas');

  // Explorador (pasta pessoal local, só listar).
  await showView('Explorador');
  await sleep(900);
  out.explorador = await page.$$eval('.sidebar .tree-row', (r) => r.length);
  await shot('05-explorador');
  out.errosNoConsole = app.errors.length;
  if (app.errors.length) out.primeiroErro = app.errors[0].slice(0, 200);
} finally {
  await app.close();
}
console.log(JSON.stringify(out, null, 2));
