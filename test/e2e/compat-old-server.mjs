// Interface nova + servidor de versão anterior (sem fs.mkdirp, fs.existsMany, dl.ticket).
// Acontece de verdade: o programa em segundo plano só é trocado quando nenhuma conversa está trabalhando,
// e a interface (que vem dos arquivos em disco) atualiza antes dele. Enviar pasta tem que continuar funcionando;
// o que depende do servidor novo (.zip, arrastar para fora) tem que avisar em vez de baixar uma página HTML.
//
//   node test/e2e/compat-old-server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEnv, helpers, sleep, SANDBOX } from './harness.mjs';

const env = await startEnv({ env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_TEST_OLD_SERVER: '1' }, sandboxSrc: SANDBOX });
const { page, sandbox } = env;
const h = helpers(page);
const { assert, waitText, clickText, findTreeRow, menu } = h;
const exists = (...p) => fs.existsSync(path.join(sandbox, ...p));
const readSb = (...p) => fs.readFileSync(path.join(sandbox, ...p), 'utf8');
const results = [];
async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok');
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FALHOU: ${String(e?.message ?? e).split('\n')[0]}`);
    console.log('    toasts:', JSON.stringify(await page.$$eval('.toast', (t) => t.map((x) => x.textContent)).catch(() => null)));
    await page.keyboard.press('Escape').catch(() => {});
  }
}
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return;
    } catch {
      /* ainda não */
    }
    await sleep(100);
  }
  throw new Error(`no disco: ${label}`);
}

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-compat-'));
const pasta = path.join(src, 'minha-pasta');
fs.mkdirSync(path.join(pasta, 'sub', 'fundo'), { recursive: true });
fs.mkdirSync(path.join(pasta, 'vazia'));
fs.writeFileSync(path.join(pasta, 'a.txt'), 'A\n');
fs.writeFileSync(path.join(pasta, 'sub', 'b.txt'), 'B\n');
fs.writeFileSync(path.join(pasta, 'sub', 'fundo', 'c.txt'), 'C\n');

try {
  await h.newLocalChat(sandbox);
  await findTreeRow('README.md');

  await step('o servidor de teste realmente se apresenta como versão anterior', async () => {
    const info = await h.rpc('app.info');
    assert(info.folderTransfer === false, `folderTransfer: ${info.folderTransfer}`);
    const err = await h.rpc('fs.mkdirp', { h: 'local', p: path.join(sandbox, 'x') }).then(() => null, (e) => e.message);
    assert(err && /desconhecido/i.test(err), `fs.mkdirp deveria não existir: ${err}`);
  });

  await step('mapa abre com daemon antigo, mas parar/ler avisa que precisa do novo (não finge funcionar)', async () => {
    await h.send('bgagent 1');
    await waitText('.msg .md', '1 em segundo plano.');
    await h.waitIdle();
    await page.click('.agents-pill');
    await waitText('.agents-dialog', 'Mapa de agentes e tarefas (1)');
    await clickText('.agents-dialog .btn', 'Ver transcrito');
    await waitText('.agent-transcript', 'exige a versão nova do servidor');
    await clickText('.agents-dialog .btn', 'Parar só esta tarefa');
    await waitText('.toast', 'exige a versão nova do servidor');
    await page.keyboard.press('Escape');
    await waitText('.agents-pill', '1 agente'); // o clique que falhou não tirou o agente da contagem
    await h.send('agentdone');
    await waitText('.msg .md', 'Agentes terminaram.');
    await h.waitIdle();
  });

  await step('copiar/colar entre servidores avisa que precisa do daemon novo, sem copiar por outro caminho', async () => {
    assert((await h.rpc('app.info')).fileCopy === 0, 'servidor antigo anunciou cópia');
    await (await findTreeRow('README.md')).click({ button: 'right' });
    await menu('Copiar');
    await waitText('.toast', 'exige a versão nova do servidor');
    assert(!(await page.$('.file-copy-status')), 'criou cópia com servidor antigo');
  });

  await step('soltar pasta do Windows funciona mesmo com o servidor anterior', async () => {
    await h.dropOs(await h.rowPoint('README.md'), [pasta]);
    await waitText('.toast', 'Enviado: minha-pasta — 3 arquivos');
    assert(readSb('minha-pasta', 'sub', 'fundo', 'c.txt') === 'C\n' && readSb('minha-pasta', 'a.txt') === 'A\n', 'arquivos não chegaram');
    assert(fs.statSync(path.join(sandbox, 'minha-pasta', 'vazia')).isDirectory(), 'pasta vazia não foi criada');
    const toasts = await page.$$eval('.toast', (t) => t.map((x) => x.textContent));
    assert(!toasts.some((t) => /desconhecido|Falha/i.test(t)), `avisos de erro: ${JSON.stringify(toasts)}`);
  });

  await step('pasta que já existe: pergunta e "Pular existentes" só envia o novo', async () => {
    fs.writeFileSync(path.join(pasta, 'a.txt'), 'A2\n');
    fs.writeFileSync(path.join(pasta, 'novo.txt'), 'N\n');
    await h.dropOs(await h.rowPoint('README.md'), [pasta]);
    await waitText('.dialog .dialog-head', '3 arquivos já existem');
    await clickText('.dialog .dialog-foot .btn', 'Pular existentes');
    await until(() => exists('minha-pasta', 'novo.txt'), 'novo.txt');
    await sleep(300);
    assert(readSb('minha-pasta', 'a.txt') === 'A\n', 'não deveria ter trocado a.txt');
  });

  await step('sobre uma pasta da árvore + seletor de pasta', async () => {
    await h.dropOs(await h.rowPoint('data'), [pasta]);
    await until(() => exists('data', 'minha-pasta', 'sub', 'fundo', 'c.txt') && exists('data', 'minha-pasta', 'vazia'), 'pasta dentro de data/');
  });

  await step('baixar arquivo funciona; baixar pasta e arrastar para fora avisam que precisam do servidor novo', async () => {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-compat-dl-'));
    const cdp = await page.browser().target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await (await findTreeRow('README.md')).click({ button: 'right' });
    await menu('Baixar');
    await until(() => fs.existsSync(path.join(dlDir, 'README.md')) && !fs.readdirSync(dlDir).some((f) => f.endsWith('.crdownload')), 'README.md baixado');
    await (await findTreeRow('minha-pasta')).click({ button: 'right' });
    await menu('Baixar pasta (.zip)');
    await waitText('.toast', 'versão nova do Claude Deck');
    await sleep(500);
    assert(fs.readdirSync(dlDir).join(',') === 'README.md', `não deveria baixar mais nada: ${fs.readdirSync(dlDir).join(',')}`);
    const items = await h.dragOutOf('minha-pasta');
    assert(!items.some((i) => i.type.toLowerCase() === 'downloadurl'), 'sem bilhete no servidor anterior: o arrasto não deveria trazer DownloadURL');
    await cdp.detach().catch(() => {});
    fs.rmSync(dlDir, { recursive: true, force: true });
  });
} finally {
  fs.rmSync(src, { recursive: true, force: true });
  await env.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passos ok`);
process.exit(failed.length ? 1 : 0);
