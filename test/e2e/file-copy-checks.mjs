// Reutilizado pela suíte completa e pelo smoke focado. Somente pastas/perfis de teste.
import fs from 'node:fs';
import path from 'node:path';
import { helpers, ROOT, sleep } from './harness.mjs';

export async function latestCopy(w, state, timeout = 30000) {
  await w.h.waitFor((s) => document.querySelector('.file-copy-job .file-copy-state')?.textContent === s, timeout, `cópia mais recente: ${state}`, state);
}
export async function copyItem(w, name, keyboard = false) {
  await w.page.bringToFront(); // aba em segundo plano não roda observadores usados pelo clique do Puppeteer
  const row = await w.h.findTreeRow(name);
  if (keyboard) { await row.focus(); await w.h.hotkey('Control', 'c'); }
  else { await row.click({ button: 'right' }); await w.h.menu('Copiar'); }
  await w.h.waitText('.toast', `Copiado: ${name}`);
  await sleep(250); // evento do clipboard chega às outras janelas
}
export async function pasteRoot(w, keyboard = false) {
  await w.page.bringToFront();
  if (keyboard) { await w.page.focus('.explorer-body .section-head'); await w.h.hotkey('Control', 'v'); }
  else { await w.page.click('.explorer-body .section-head', { button: 'right' }); await w.h.menu('Colar aqui'); }
}

export async function runFileCopyChecks(env) {
  const h = helpers(env.page);
  const source = path.join(env.sandbox, 'copy-source');
  const dest = path.join(env.sandbox, 'copy-dest');
  fs.mkdirSync(path.join(source, 'pacote', 'vazia'), { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(source, 'pacote', 'açúcar.txt'), 'versão 1\n');
  fs.writeFileSync(path.join(source, 'pacote', '.oculto'), 'oculto\n');
  fs.writeFileSync(path.join(source, 'arquivo.txt'), 'origem\n');
  const shots = path.join(ROOT, 'test', 'shots', 'file-copy'); fs.mkdirSync(shots, { recursive: true });
  const pages = [];
  async function open(folder) {
    const r = await h.rpc('window.open', { hostId: 'local', folder });
    const p = await env.browser.newPage(); pages.push(p);
    await p.goto(r.url, { waitUntil: 'networkidle2' });
    await p.waitForSelector('.explorer-body', { timeout: 20000 });
    return { page: p, h: helpers(p) };
  }
  try {
    const A = await open(source), B = await open(dest);
    await copyItem(A, 'pacote', true); await pasteRoot(B, true);
    await latestCopy(B, 'Concluída');
    h.assert(fs.readFileSync(path.join(dest, 'pacote', 'açúcar.txt'), 'utf8') === 'versão 1\n', 'arquivo não chegou');
    h.assert(fs.existsSync(path.join(dest, 'pacote', 'vazia')) && fs.existsSync(path.join(dest, 'pacote', '.oculto')), 'perdeu vazio/oculto');
    h.assert(fs.existsSync(path.join(source, 'pacote', 'açúcar.txt')), 'apagou origem');
    await B.page.screenshot({ path: path.join(shots, 'local-concluida.png') });
    await B.page.keyboard.press('Escape');
    await B.h.findTreeRow('pacote'); // fs.changed atualizou árvore sem F5.

    // Conflito decidido na janela de destino.
    fs.writeFileSync(path.join(source, 'pacote', 'açúcar.txt'), 'versão 2\n');
    await pasteRoot(B);
    await B.h.waitText('.dialog-head', 'Confirmar cópia');
    await B.page.screenshot({ path: path.join(shots, 'conflito.png') });
    await B.h.clickText('.dialog-foot .btn', 'Pular existentes');
    await latestCopy(B, 'Parcial');
    h.assert(fs.readFileSync(path.join(dest, 'pacote', 'açúcar.txt'), 'utf8') === 'versão 1\n', 'pular substituiu');
    await B.page.keyboard.press('Escape');
    await pasteRoot(B); await B.h.waitText('.dialog-head', 'Confirmar cópia');
    await B.h.clickText('.dialog-foot .btn', 'Substituir arquivos existentes');
    await latestCopy(B, 'Concluída');
    h.assert(fs.readFileSync(path.join(dest, 'pacote', 'açúcar.txt'), 'utf8') === 'versão 2\n', 'substituição não aplicada');
    await B.page.keyboard.press('Escape');

    // Recarregar recupera cópias sem iniciar outra e sem mudar abas.
    const tabsBefore = await B.h.chatTabs();
    const countJobs = async () => { await B.page.bringToFront(); await B.page.click('.file-copy-status'); await B.page.waitForSelector('.file-copy-job'); const n = await B.page.$$eval('.file-copy-job', (x) => x.length); await B.page.keyboard.press('Escape'); return n; };
    const jobsBefore = await countJobs();
    await B.page.reload({ waitUntil: 'networkidle2' });
    await B.page.waitForSelector('.file-copy-status');
    h.assert((await B.h.chatTabs()) === tabsBefore, 'mudou abas ao recuperar cópias');
    h.assert((await countJobs()) === jobsBefore, 'reload criou ou perdeu cópia');

    // Destino com rascunho na janela A (outro contexto do mesmo host) impede substituir.
    await copyItem(A, 'arquivo.txt'); await pasteRoot(B); await latestCopy(B, 'Concluída'); await B.page.keyboard.press('Escape');
    const dstFile = path.join(dest, 'arquivo.txt');
    await A.page.bringToFront();
    await A.page.click('.explorer-body .section-head', { button: 'right' }); await A.h.menu('Adicionar pasta ao explorador');
    const input = await A.page.waitForSelector('.dialog.wide input.input');
    await input.click(); await A.h.hotkey('Control', 'a'); await A.page.keyboard.type(dest); await A.page.keyboard.press('Enter');
    await A.h.waitText('.dialog.wide .hint', 'copy-dest');
    await A.h.clickText('.dialog.wide .dialog-foot .btn', 'Adicionar esta pasta');
    await A.h.waitFor((p) => [...document.querySelectorAll('.sidebar .tree-row')].some((r) => r.getAttribute('data-k')?.endsWith(p)), 10000, 'arquivo na pasta fixada', dstFile);
    await A.page.evaluate((p) => [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.getAttribute('data-k')?.endsWith(p)).click(), dstFile);
    await A.h.waitActiveFile('arquivo.txt'); await A.page.waitForSelector('.cm-content');
    await A.page.click('.cm-content'); await A.h.hotkey('Control', 'End'); await A.page.keyboard.type('rascunho');
    await A.h.waitFor(() => !!document.querySelector('.editor-panel .tab.dirty'), 5000, 'rascunho marcado');
    await sleep(250); // presença dirty enviada ao daemon
    fs.writeFileSync(path.join(source, 'arquivo.txt'), 'nova versão\n');
    await pasteRoot(B); await B.h.waitText('.dialog-head', 'Confirmar cópia'); await B.h.clickText('.dialog-foot .btn', 'Substituir arquivos existentes');
    await latestCopy(B, 'Parcial');
    await B.h.waitText('.file-copy-job', 'não salvas');
    h.assert(fs.readFileSync(dstFile, 'utf8') === 'origem\n', 'alterou destino dirty');
    h.assert(await A.page.$eval('.cm-content', (el) => el.textContent.includes('rascunho')), 'apagou rascunho');
    await B.page.screenshot({ path: path.join(shots, 'dirty-outra-janela.png') });
    await B.page.keyboard.press('Escape');

    // Ctrl+C no editor continua sendo texto; o item copiado no explorador não muda.
    await A.page.bringToFront();
    await A.page.click('.cm-content'); await A.h.hotkey('Control', 'a'); await A.h.hotkey('Control', 'c');
    await sleep(150);
    h.assert((await A.page.evaluate(() => navigator.clipboard.readText())).includes('rascunho'), 'Ctrl+C do editor não copiou texto');
    await pasteRoot(B); await B.h.waitText('.dialog-head', 'Confirmar cópia');
    await B.h.waitText('.dialog-body', `copy-source${path.sep}arquivo.txt`);
    await B.h.clickText('.dialog-foot .btn', 'Cancelar');
    await latestCopy(B, 'Cancelada');
    h.assert(fs.readFileSync(dstFile, 'utf8') === 'origem\n', 'cancelar alterou destino');
    await B.page.keyboard.press('Escape');
    for (const w of [A, B]) h.assert(!(await w.page.$('.dialog')), 'diálogo ficou aberto');
  } finally {
    for (const p of pages) await p.close().catch(() => {});
  }
}
