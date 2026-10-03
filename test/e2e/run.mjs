// Suíte E2E do Claude Deck: servidor real + interface no Brave (perfil temporário, sem janela)
// + "Claude falso" (test/fake-claude). Nada toca o ~/.claude, o ~/.ssh nem o Brave do dia a dia:
// tudo roda em pastas temporárias (dados do app, CLAUDE_CONFIG_DIR, ~/.ssh falso e cópia do sandbox).
//
//   node test/e2e/run.mjs              (E2E_HEADFUL=1 mostra a janela; E2E_KEEP=1 guarda as pastas)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startEnv, helpers, readZipEntries, sleep, ROOT, SANDBOX as SANDBOX_SRC } from './harness.mjs';
const SHOTS = path.join(ROOT, 'test', 'shots', 'e2e');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const env = await startEnv({
  // Modo de teste do servidor: o RPC window.open devolve a URL em vez de abrir o Brave do sistema.
  // UNSEEN_DELAY: o servidor espera 3,5 s antes de marcar "terminou e não vi"; nos testes, 300 ms.
  env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_UNSEEN_DELAY_MS: '300' },
  sandboxSrc: SANDBOX_SRC,
  sshConfig: ['Host exemplo-web', '  HostName 192.0.2.10', '  User deploy', '  ConnectTimeout 3', '', 'Host cliente prod', '  HostName 192.0.2.11', '  User root', '  Port 2222', '  ConnectTimeout 3', ''].join('\n'),
});
const { page, sandbox, uploads, claudeDir, sshDir } = env;
const h = helpers(page);
const { assert, waitText, waitFor, findByText, clickText, hotkey, typeComposer, send, clearComposer, composerValue, waitIdle, count, findTreeRow, clickTree, waitActiveFile, menu, chatTabs } = h;
fs.writeFileSync(path.join(uploads, 'upload-e2e.txt'), 'arquivo enviado pelo teste E2E\n');
console.log(`Claude Deck E2E — porta ${env.port}\n  sandbox: ${sandbox}\n`);

// ---------------------------------------------------------------- utilitários
const results = [];
let savedSecondWindow = null;
let shotN = 0;
async function shot(name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  return f;
}
async function stateDump() {
  return page
    .evaluate(() => ({
      tabs: [...document.querySelectorAll('.center .tabs .tab')].map((t) => `${t.classList.contains('active') ? '*' : ''}${t.querySelector('.tab-label')?.textContent}`),
      phase: document.querySelector('.phase-pill')?.textContent,
      dialog: document.querySelector('.dialog .dialog-head')?.textContent ?? null,
      focus: `${document.activeElement?.tagName}.${document.activeElement?.className}`,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    }))
    .catch(() => null);
}
async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms });
    console.log(`ok (${ms} ms)`);
  } catch (e) {
    const dump = await stateDump();
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e), dump });
    console.log(`FALHOU: ${String(e?.message ?? e).split('\n')[0]}\n    estado: ${JSON.stringify(dump)}`);
    await page.screenshot({ path: path.join(SHOTS, `FALHA-${name.replace(/[^\wÀ-ú-]+/g, '_')}.png`) }).catch(() => {});
    // Fecha menus/diálogos que tenham ficado abertos para não contaminar o próximo passo.
    await page.keyboard.press('Escape').catch(() => {});
  }
}
const exists = (...p) => fs.existsSync(path.join(sandbox, ...p));
const readSb = (...p) => fs.readFileSync(path.join(sandbox, ...p), 'utf8');

// ---------------------------------------------------------------- passos
await step('abre o app (tela inicial)', async () => {
  await page.waitForSelector('.empty-chat h2');
  const h2 = await page.$eval('.empty-chat h2', (e) => e.textContent);
  assert(h2 === 'Claude Deck', `título inesperado: ${h2}`);
  assert((await h.rpc('app.info')).windowRestore === true, 'servidor não anuncia suporte à restauração de janelas por pasta');
  await waitText('.statusbar', 'Local');
  await shot('tela-inicial');
});

await step('nova conversa local (Ctrl+Shift+N, digita a pasta)', async () => {
  await hotkey('Control', 'Shift', 'N');
  await waitText('.quickpick .qp-title', 'escolha o servidor');
  await shot('seletor-servidor');
  await page.keyboard.type('xyz');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter'); // "Este computador" é o primeiro
  await waitText('.quickpick .qp-title', 'escolha a pasta');
  await waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor de pasta');
  const v = await page.$eval('.quickpick input', (e) => e.value);
  assert(v === '', `a busca do passo anterior vazou para o seletor de pasta: "${v}"`);
  await page.keyboard.type(sandbox);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-header', { timeout: 10000 });
  await waitIdle();
  assert((await chatTabs()) === 1, 'deveria haver 1 aba de conversa');
  // Título: servidor + pasta das conversas, sem o título da conversa.
  await waitFor((dir) => document.title.startsWith('Local · ') && document.title.endsWith(`${dir} — Claude Deck`), 3000, 'nome da janela mostra Local e a pasta', path.basename(sandbox));
  const title = await page.evaluate(() => document.title);
  assert(!title.includes('Nova conversa'), `o título da janela não deveria ter o da conversa: ${title}`);
  assert((await h.activeChatLabel()) === 'Nova conversa', `título da aba nova: ${await h.activeChatLabel()}`);
  await findTreeRow('README.md'); // explorador abriu a pasta da conversa
  await shot('conversa-nova');
});

await step('mensagem simples com streaming', async () => {
  await send('echo Olá, mundo! Tudo certo?');
  await waitText('.msg .md', 'Olá, mundo! Tudo certo?');
  await waitText('.user-bubble', 'echo Olá, mundo!');
  await waitIdle();
  assert((await count('.result-line')) >= 1, 'sem linha de resultado (duração/custo)');
  const firstCost = await page.$eval('.result-line', (e) => e.textContent);
  assert(firstCost.includes('Sessão: US$ 0.0012') && !firstCost.includes('Desde a resposta anterior'), `primeiro total não é preço da pergunta: ${firstCost}`);
  // Tempo e tokens do turno no fim da resposta: 271 novos + 25.088 do cache = 25,4k de entrada; 6 de saída.
  await waitText('.result-line .result-tokens', '↑ 25,4k · ↓ 6 tokens');
  const tip = await page.$eval('.result-line .result-tokens', (e) => e.title);
  assert(tip.includes('Este turno') && tip.includes('25.088 lidos do cache') && tip.includes('Sessão inteira'), `dica dos tokens: ${tip}`);
  // Resposta simples (sem ferramenta): sem destaque de "resposta final".
  assert((await count('.msg-final')) === 0, 'resposta sem ferramentas não deveria ter o destaque de resposta final');
  assert((await count('.msg .msg-copy')) >= 1, 'resposta sem botão de copiar');
  await (await page.$('.msg .msg-copy')).click();
  await waitFor(() => document.querySelector('.msg-copy.copied') !== null, 2000, 'botão de copiar não mudou para copiado');
  await waitFor(() => document.querySelector('.msg-copy.copied') === null, 3000, 'botão de copiar não voltou ao normal');
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent.startsWith('Teste: echo Olá'), 5000, 'título vindo do ai-title');
});

await step('markdown (título, tabela, código, caminho clicável)', async () => {
  await send('markdown');
  await waitText('.msg .md h1', 'Título');
  await waitIdle();
  const secondCost = await page.$eval('.result-line:last-of-type', (e) => e.textContent);
  assert(secondCost.includes('Desde a resposta anterior: +US$ 0.0012') && secondCost.includes('Sessão: US$ 0.0024'), `acréscimo e sessão separados: ${secondCost}`);
  assert((await count('.msg .md table')) >= 1, 'tabela não renderizou');
  assert((await count('.msg .md .md-code .md-copy')) >= 1, 'bloco de código sem botão copiar');
  assert((await count('.msg .msg-copy')) >= 1, 'resposta markdown sem botão copiar');
  await shot('markdown-no-chat');
  await clickText('.msg .md code.path-link', 'src/app.ts:12');
  await waitActiveFile('app.ts');
  await waitFor(() => document.querySelector('.editor-panel .cm-activeLineGutter')?.textContent.trim() === '12', 5000, 'cursor na linha 12');
});

await step('Arquivo citado só pelo nome: o clique acha a subpasta certa (pasta citada no texto, busca pelo nome, escolha, aviso)', async () => {
  const dirs = ['criativos/lote-a', 'criativos/lote-b', 'unico-e2e-dir'];
  for (const d of dirs) fs.mkdirSync(path.join(sandbox, ...d.split('/')), { recursive: true });
  for (const n of ['foto-e2e.txt', 'par-e2e.txt']) for (const l of ['a', 'b']) fs.writeFileSync(path.join(sandbox, 'criativos', `lote-${l}`, n), `conteudo do lote-${l}\n`);
  fs.writeFileSync(path.join(sandbox, 'unico-e2e-dir', 'unico-e2e.txt'), 'conteudo unico da subpasta\n');
  const tabsBefore = await count('.editor-panel .tab');
  const closeActive = async () => {
    await page.click('.editor-panel .tab.active .close');
    await waitFor((n) => document.querySelectorAll('.editor-panel .tab').length === n, 5000, 'aba do arquivo fechada', tabsBefore);
  };

  // 1. Dois arquivos com o mesmo nome; o texto diz a pasta em outro trecho: abre o certo, sem perguntar.
  await send('echo Salvei em `criativos/lote-b/` os arquivos; veja `foto-e2e.txt` agora.');
  await waitText('.msg .md code.path-link', 'foto-e2e.txt', 20000);
  await waitIdle();
  await clickText('.msg .md code.path-link', 'foto-e2e.txt', true);
  await waitActiveFile('foto-e2e.txt');
  await waitText('.editor-panel .cm-content', 'conteudo do lote-b', 8000);
  assert(!(await page.$('.ctxmenu')), 'a pasta citada no texto deveria resolver sem perguntar');
  await closeActive();

  // 2. Só a pasta da conversa não tem o arquivo, e ele existe uma vez numa subpasta: acha pelo nome.
  await send('echo Gerei o arquivo `unico-e2e.txt` para você.');
  await waitText('.msg .md code.path-link', 'unico-e2e.txt', 20000);
  await waitIdle();
  await clickText('.msg .md code.path-link', 'unico-e2e.txt', true);
  await waitActiveFile('unico-e2e.txt');
  await waitText('.editor-panel .cm-content', 'conteudo unico da subpasta', 8000);
  await closeActive();

  // 3. Mesmo nome em duas pastas e nenhuma pista no texto: pergunta qual abrir (nada de abrir errado).
  await send('echo Confira o arquivo `par-e2e.txt` quando puder.');
  await waitText('.msg .md code.path-link', 'par-e2e.txt', 20000);
  await waitIdle();
  await clickText('.msg .md code.path-link', 'par-e2e.txt', true);
  await waitText('.ctxmenu', 'Há 2 arquivos com esse nome', 8000);
  await shot('arquivo-citado-varios');
  await menu('criativos/lote-a/par-e2e.txt');
  await waitActiveFile('par-e2e.txt');
  await waitText('.editor-panel .cm-content', 'conteudo do lote-a', 8000);
  await closeActive();

  // 4. Não existe em lugar nenhum: avisa, sem abrir uma aba de erro.
  await send('echo Também vale `nao-existe-e2e.txt`, mas ele não foi criado.');
  await waitText('.msg .md code.path-link', 'nao-existe-e2e.txt', 20000);
  await waitIdle();
  await clickText('.msg .md code.path-link', 'nao-existe-e2e.txt', true);
  await waitText('.toast', 'Não encontrei "nao-existe-e2e.txt"', 8000);
  assert((await count('.editor-panel .tab')) === tabsBefore, 'arquivo inexistente abriu uma aba de erro');
});

await step('Pasta citada na resposta: o clique mostra a pasta no explorador (níveis abertos, selecionada), acha pelo nome, fixa pasta de fora e avisa quando não existe', async () => {
  const tabsBefore = await count('.editor-panel .tab');
  fs.mkdirSync(path.join(sandbox, 'pasta-alvo-e2e', 'sub-e2e', 'fundo-e2e'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'pasta-alvo-e2e', 'sub-e2e', 'dentro-e2e.txt'), 'x\n');
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-fora-')));
  fs.mkdirSync(path.join(outside, 'miolo'));
  const selectedRows = () => page.$$eval('.sidebar .tree-row.selected .label', (els) => els.map((e) => e.textContent));
  const headTitles = () => page.$$eval('.sidebar .section-head .grow', (els) => els.map((e) => e.textContent));
  const clickLink = async (text) => {
    await waitText('.msg .md code.path-link', text, 20000);
    await waitIdle();
    await clickText('.msg .md code.path-link', text, true);
  };

  try {
  // 1. Caminho relativo com barra no fim, com a barra lateral em outra visão: volta para o explorador, abre os
  //    níveis até a pasta, seleciona e lista o que tem dentro. Não abre aba de arquivo.
  await page.click('.activitybar .act-btn[title^="Buscar"]');
  await waitText('.sidebar .side-title', 'Buscar em arquivos', 5000);
  await send('echo Está tudo em `pasta-alvo-e2e/sub-e2e/` agora.');
  await clickLink('pasta-alvo-e2e/sub-e2e/');
  await waitText('.sidebar .side-title', 'Explorador', 5000);
  await findTreeRow('dentro-e2e.txt'); // o conteúdo da pasta pedida já está listado
  await findTreeRow('fundo-e2e');
  await waitFor(() => [...document.querySelectorAll('.sidebar .tree-row.selected .label')].some((e) => e.textContent === 'sub-e2e'), 5000, 'pasta sub-e2e selecionada');
  await shot('pasta-citada-no-explorador');
  assert((await count('.editor-panel .tab')) === tabsBefore, 'clicar numa pasta não deveria abrir aba de arquivo');

  // 2. Só o nome da pasta (com a barra): acha pelos arquivos que ela tem dentro, como já se faz com arquivo.
  await send('echo Veja `lote-b/` quando puder.');
  await clickLink('lote-b/');
  await waitFor(() => [...document.querySelectorAll('.sidebar .tree-row.selected .label')].some((e) => e.textContent === 'lote-b'), 8000, 'pasta lote-b selecionada');
  await findTreeRow('foto-e2e.txt');

  // 3. Pasta de fora da pasta da conversa: vira pasta fixada no explorador; a raiz principal não muda.
  const rootBefore = (await headTitles())[0];
  await send(`echo Copiei tudo para \`${outside}\` agora.`);
  await clickLink(outside);
  await waitFor(() => document.querySelectorAll('.sidebar .section-head').length === 2, 8000, 'pasta de fora fixada no explorador');
  assert((await headTitles())[0] === rootBefore, `a raiz principal do explorador mudou: ${rootBefore} → ${(await headTitles())[0]}`);
  assert((await headTitles())[1].includes(path.basename(outside)), `cabeçalho da pasta fixada: ${(await headTitles())[1]}`);
  // 3b. Subpasta dela: a raiz fixada já contém, então só abre na árvore (sem criar outra raiz).
  await send(`echo E o miolo em \`${path.join(outside, 'miolo')}\` também.`);
  await clickLink(path.join(outside, 'miolo'));
  await waitFor(() => [...document.querySelectorAll('.sidebar .tree-row.selected .label')].some((e) => e.textContent === 'miolo'), 8000, 'subpasta miolo selecionada');
  assert((await count('.sidebar .section-head')) === 2, 'subpasta de uma raiz fixada não deveria criar outra raiz');
  assert((await selectedRows()).includes('miolo'), 'miolo não está selecionada');
  const unpin = await page.$$('.sidebar .section-head .icon-btn[title="Remover do explorador"]');
  await unpin[unpin.length - 1].click();
  await waitFor(() => document.querySelectorAll('.sidebar .section-head').length === 1, 5000, 'pasta fixada removida');

  // 4. Pasta que não existe em lugar nenhum: avisa, sem mexer no explorador nem abrir aba.
  await send('echo Também vale `nao-existe-dir-e2e/x/y/`, mas não foi criada.');
  await clickLink('nao-existe-dir-e2e/x/y/');
  await waitText('.toast', 'Não encontrei "nao-existe-dir-e2e/x/y"', 8000);
  assert((await count('.sidebar .section-head')) === 1, 'pasta inexistente criou uma raiz no explorador');
  assert((await count('.editor-panel .tab')) === tabsBefore, 'pasta inexistente abriu aba');

  // 5. Comando, rota e tipo MIME entre crases não viram link de pasta.
  await send('echo Não use `/clear` nem `/api/raw` nem `text/html` agora.');
  await waitText('.msg .md code', 'text/html', 20000);
  await waitIdle();
  const falsos = await page.$$eval('.msg .md code', (els) => els.filter((e) => ['/clear', '/api/raw', 'text/html'].includes(e.textContent.trim()) && e.classList.contains('path-link')).map((e) => e.textContent));
  assert(falsos.length === 0, `viraram link de pasta sem ser: ${falsos.join(', ')}`);
  } finally {
    // Deixa o explorador como estava, mesmo se uma verificação acima falhou: o passo de "arrastar para o espaço
    // vazio" mais adiante precisa ver o fim da árvore sem rolar, e um deles caía fora da tela com estas pastas abertas.
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(path.join(sandbox, 'pasta-alvo-e2e'), { recursive: true, force: true });
    for (let i = 0; i < 3; i++) {
      const b = await page.$('.sidebar .section-head .icon-btn[title="Remover do explorador"]');
      if (!b) break;
      await b.click();
      await sleep(200);
    }
    await page.click('.section-head button[title="Atualizar"]');
    await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'pasta-alvo-e2e'), 5000, 'árvore sem a pasta de teste');
    // "criativos" só estava aberta por causa deste passo (o clique alterna: recolhe).
    if ((await page.$$eval('.sidebar .tree-row .label', (els) => els.filter((e) => e.textContent === 'lote-a').length)) > 0) await clickTree('criativos');
  }
});

await step('Write: pedido de permissão → Permitir', async () => {
  await send('write novo.txt');
  await waitText('.perm-card .perm-title', 'Permitir?');
  await waitText('.statusbar', 'esperando você');
  // "1 esperando você" abre o menu (para cima, colado na barra de status) com o que a conversa pede.
  await page.click('.statusbar .sb-attn.sb-warn');
  await waitText('.attn-menu', 'Esperando você (1)');
  await waitText('.attn-menu .attn-row .attn-sub', 'Pede permissão');
  const up = await page.evaluate(() => ({ menuBottom: document.querySelector('.attn-menu').getBoundingClientRect().bottom, barTop: document.querySelector('.statusbar').getBoundingClientRect().top }));
  assert(Math.abs(up.menuBottom - up.barTop) < 2, `o menu deveria abrir para cima, colado na barra de status: ${JSON.stringify(up)}`);
  await shot('menu-esperando-voce');
  await page.keyboard.press('Escape'); // fecha só o menu: o pedido de permissão segue de pé
  await waitFor(() => !document.querySelector('.attn-menu'), 3000, 'Esc fecha o menu');
  assert((await count('.perm-card .perm-title')) >= 1, 'o pedido de permissão sumiu ao fechar o menu');
  await shot('permissao-write');
  await clickText('.perm-card .perm-actions .btn', 'Permitir', true);
  await waitText('.msg .md', 'Arquivo criado.');
  await waitIdle();
  // Depois de usar uma ferramenta, o texto que vem por último é a resposta final, com destaque.
  await waitText('.msg.msg-final', 'Arquivo criado.');
  await waitText('.msg.msg-final .final-label', 'Resposta');
  assert((await count('.msg.msg-final .msg-copy')) >= 1, 'resposta final sem botão de copiar');
  await shot('resposta-final');
  assert(exists('novo.txt'), 'novo.txt não foi criado');
  // O cartão volta minimizado depois da resposta; o diff aparece ao clicar no cabeçalho.
  assert((await count('.diff .diff-line.add')) === 0, 'o diff do Write deveria estar minimizado');
  await (await findByText('.tool .tool-head', 'novo.txt')).click();
  await waitFor(() => document.querySelectorAll('.diff .diff-line.add').length >= 3, 3000, 'diff do Write ao expandir o cartão');
  await findTreeRow('novo.txt'); // explorador atualizou sozinho
});

await step('Permissão de subagente aparece aberta e o botão Ver leva até ela', async () => {
  await send('agentperm');
  await waitText('.tool.pending-perm .perm-title', 'Permitir?');
  await waitText('.tool.pending-perm .tool-section', 'echo teste aninhado');
  const visible = await page.$eval('.tool.pending-perm', (el) => {
    const box = el.getBoundingClientRect();
    const area = document.querySelector('.messages').getBoundingClientRect();
    return box.top < area.bottom && box.bottom > area.top;
  });
  assert(visible, 'pedido do subagente não veio automaticamente para a área visível');
  await page.$eval('.messages', (el) => (el.scrollTop = 0));
  await clickText('.composer-wrap .btn', 'esperando sua permissão');
  await waitFor(() => {
    const el = document.querySelector('.messages .tool.pending-perm');
    const box = el?.getBoundingClientRect();
    const area = document.querySelector('.messages')?.getBoundingClientRect();
    return !!box && !!area && box.top < area.bottom && box.bottom > area.top;
  }, 5000, 'botão Ver rola até a permissão');
  await clickText('.tool.pending-perm .perm-actions .btn', 'Permitir', true);
  await waitText('.msg .md', 'Pedido do subagente processado.');
  await waitIdle();
});

await step('Write: Negar', async () => {
  await send('write negado.txt');
  await waitText('.perm-card .perm-title', 'Permitir?');
  await clickText('.perm-card .perm-actions .btn', 'Negar');
  await waitText('.perm-answered.denied', 'Negado');
  await waitIdle();
  assert(!exists('negado.txt'), 'negado.txt foi criado mesmo negando');
});

await step('Negar explicando o motivo', async () => {
  await send('write outro.txt');
  await waitText('.perm-card .perm-title', 'Permitir?');
  await page.type('.perm-card .perm-feedback input', 'use o nome final.txt');
  await page.keyboard.press('Enter');
  await waitText('.perm-answered.denied', 'Negado: use o nome final.txt');
  await waitText('.msg .md', 'Ok, não vou criar o arquivo.');
  await waitIdle();
});

await step('Edit com "aceitar edições" + editor recarrega sozinho', async () => {
  await clickTree('novo.txt');
  await waitActiveFile('novo.txt');
  await waitText('.editor-panel .cm-content', 'linha 2');
  await send('edit novo.txt');
  await waitText('.perm-card', 'aceitar edições automaticamente');
  await clickText('.perm-card .perm-actions .btn', 'aceitar edições automaticamente');
  await waitText('.msg .md', 'Editado.');
  await waitIdle();
  assert(readSb('novo.txt').includes('linha 2 EDITADA'), 'arquivo não foi editado');
  await waitText('.composer .pill-select', 'Aceitar edições');
  await waitText('.editor-panel .cm-content', 'linha 2 EDITADA', 8000);
  await shot('edit-diff-e-editor');
});

await step('Bash com regra "sempre permitir"', async () => {
  await send('bash');
  await waitText('.perm-card', 'Sempre permitir Bash(echo:*)');
  await waitText('.perm-card', 'em todos os projetos neste computador');
  await clickText('.perm-card .perm-actions .btn', 'Sempre permitir');
  await waitText('.msg .md', 'Comando executado.');
  await waitIdle();
  const sid = (await h.rpc('sessions.list')).find((s) => s.cwd === sandbox && s.phase === 'idle').sid;
  const applied = await h.rpc('sessions.control', { sid, request: { subtype: 'get_settings' } });
  assert(applied.lastPermissions?.[0]?.destination === 'userSettings', `regra não foi enviada para userSettings: ${JSON.stringify(applied)}`);
  const head = await findByText('.tool .tool-head', 'Testa o terminal');
  await head.click();
  await waitText('.tool .tool-section pre', 'fake-bash-ok');
});

await step('Pergunta (AskUserQuestion): prévia antes de escolher, mouse, teclado e tela estreita', async () => {
  await send('ask');
  await waitText('.question .q-text', 'Qual cor você prefere?');
  const blue = await findByText('.question .q-option', 'Azul');
  const green = await findByText('.question .q-option', 'Verde');
  await blue.hover();
  await waitText('.question-preview', 'Prévia azul');
  await green.hover();
  await waitText('.question-preview', 'Prévia verde');
  assert((await count('.question .q-option.chosen')) === 0, 'só destacar não deve escolher a opção');
  await green.focus();
  await page.keyboard.press('ArrowUp');
  await waitText('.question-preview', 'Prévia azul');
  await page.keyboard.press('ArrowDown');
  await waitText('.question-preview', 'Prévia verde');
  await shot('pergunta-previa');
  const viewport = page.viewport();
  try {
    await page.setViewport({ width: 760, height: 900 });
    assert(await page.$eval('.question-choices', (el) => getComputedStyle(el).flexDirection === 'column'), 'prévia deve ficar embaixo em tela estreita');
    await page.$eval('.question', (el) => el.scrollIntoView({ block: 'end' }));
    assert(await page.$eval('.question-choices', (el) => el.querySelector('.question-preview').getBoundingClientRect().top >= el.querySelector('.question-options').getBoundingClientRect().bottom), 'prévia não ficou abaixo das opções');
    await shot('pergunta-previa-estreita');
  } finally { await page.setViewport(viewport); }
  await green.focus();
  await page.keyboard.press('Enter');
  await clickText('.perm-card .perm-actions .btn', 'Responder');
  await waitText('.msg .md', 'Você escolheu: Verde');
  await waitIdle();
});

await step('Pergunta de múltipla escolha mostra quadradinho (escolha única segue com círculo)', async () => {
  await send('askmulti');
  await waitText('.question .q-text', 'Qual cor você prefere?');
  assert((await count('.question .q-option .q-box')) === 2, 'cada opção da múltipla escolha deve ter um quadradinho');
  assert((await count('.question .q-option .codicon-circle-large-outline, .question .q-option .codicon-circle-large-filled')) === 0, 'múltipla escolha não deve usar círculo');
  assert((await count('.question .q-box.checked')) === 0, 'nada deveria vir marcado');
  await clickText('.question .q-option', 'Azul');
  await clickText('.question .q-option', 'Verde');
  assert((await count('.question .q-box.checked .codicon-check')) === 2, 'as duas opções deveriam estar marcadas com o "check"');
  await clickText('.question .q-option', 'Azul'); // desmarca
  assert((await count('.question .q-box.checked')) === 1, 'clicar de novo deveria desmarcar a opção');
  await shot('pergunta-multipla');
  await clickText('.perm-card .perm-actions .btn', 'Responder');
  await waitText('.msg .md', 'Você escolheu: Verde');
  await waitIdle();
  // A de escolha única continua com círculo, sem quadradinho.
  await send('ask');
  await waitText('.question .q-text', 'Qual cor você prefere?');
  assert((await count('.question .q-box')) === 0, 'escolha única não deve ter quadradinho');
  assert((await count('.question .q-option .codicon-circle-large-outline')) === 2, 'escolha única deveria manter o círculo');
  await clickText('.question .q-option', 'Verde');
  await clickText('.perm-card .perm-actions .btn', 'Responder');
  await waitIdle();
});

await step('Pergunta depois de raciocínio + execução aparece FORA do grupo recolhido', async () => {
  await send('deep');
  await waitText('.question .q-text', 'Qual cor você prefere?');
  const where = await page.evaluate(() => {
    const q = document.querySelector('.question');
    const g = [...document.querySelectorAll('.work-group')].at(-1);
    return { inGroup: !!q?.closest('.work-group'), groupOpen: !!g?.classList.contains('open'), groupText: g?.querySelector('.work-group-title')?.textContent ?? null };
  });
  assert(!where.inGroup, 'a pergunta ficou dentro do grupo recolhido');
  assert(where.groupText === 'Raciocínio e 1 execução' && !where.groupOpen, `o grupo deveria estar recolhido só com o que veio antes: ${JSON.stringify(where)}`);
  await shot('pergunta-fora-do-grupo');
  await clickText('.question .q-option', 'Azul');
  await clickText('.perm-card .perm-actions .btn', 'Responder');
  await waitText('.msg .md', 'Você escolheu: Azul');
  await waitIdle();
  // Respondida, a pergunta volta para a cadeia (agora com 2 execuções) e continua recolhida.
  const after = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.work-group')].at(-1);
    return { title: g?.querySelector('.work-group-title')?.textContent ?? null, open: !!g?.classList.contains('open') };
  });
  assert(after.title === 'Raciocínio e 2 execuções' && !after.open, `depois de responder: ${JSON.stringify(after)}`);
});

await step('Plano (ExitPlanMode) → aprovar', async () => {
  await send('plan');
  await waitText('.perm-card .perm-title', 'terminou o plano');
  await waitText('.tool .tool-section', 'Corrigir o bug');
  await shot('plano');
  await clickText('.perm-card .perm-actions .btn', 'Sim, e aceitar edições automaticamente');
  await waitText('.msg .md', 'Plano aprovado. Modo agora: acceptEdits');
  await waitIdle();
});

await step('Lista de tarefas (TodoWrite)', async () => {
  await send('todo');
  await waitText('.msg .md', 'Lista criada.');
  await waitIdle();
  await waitText('.tool .tool-name', 'Tarefas');
  await waitText('.tool .tool-sum', '1/3 concluídas');
  assert((await count('.tool .todos li')) === 0, 'a lista de tarefas deveria estar minimizada');
  await (await findByText('.tool .tool-head', 'Tarefas')).click();
  await waitFor(() => document.querySelectorAll('.tool .todos li').length >= 3, 3000, 'itens da lista ao expandir o cartão');
});

await step('Ferramenta com erro chega minimizada (o ícone mostra o erro; abre ao clicar)', async () => {
  await send('bashfail');
  await waitText('.perm-card .perm-title', 'Permitir?');
  // Enquanto espera a sua resposta, o cartão fica aberto (é o que você está aprovando).
  await waitText('.tool .tool-section', 'sudo -n systemctl restart zabbix-server');
  await clickText('.perm-card .perm-actions .btn', 'Permitir', true);
  await waitText('.msg .md', 'O comando falhou.');
  await waitIdle();
  const state = await page.evaluate(() => {
    const head = [...document.querySelectorAll('.tool .tool-head')].find((h) => h.textContent.includes('Comando que falha'));
    const card = head?.closest('.tool');
    return { found: !!head, error: !!card?.querySelector('.tool-status.error'), open: !!card?.querySelector('.tool-section') };
  });
  assert(state.found, 'não achei o cartão do comando que falhou');
  assert(state.error, 'o cartão deveria mostrar o ícone de erro');
  assert(!state.open, 'o cartão com erro deveria chegar minimizado');
  await shot('ferramenta-erro-minimizada');
  await (await findByText('.tool .tool-head', 'Comando que falha')).click();
  await waitText('.tool .tool-section', 'sudo: a password is required');
  await waitText('.tool .tool-label', 'Erro');
});

await step('Interromper com Esc no meio da resposta', async () => {
  await send('slow');
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  await waitText('.chat-header .phase-pill', 'Trabalhando');
  await sleep(1200);
  await page.focus('.composer textarea');
  await page.keyboard.press('Escape');
  await waitText('.notice', 'Interrompido pelo usuário', 10000);
  await waitIdle();
  const last = await page.$$eval('.msg .md', (els) => els[els.length - 1]?.textContent ?? '');
  assert(!last.includes('600'), 'a resposta não parou');
});

await step('Mensagem de outro agente (<agent-message>) aparece como cartão recolhido, sem o XML cru, também depois de recarregar', async () => {
  const cardInfo = () =>
    page.evaluate(() => {
      const card = document.querySelector('.injected-card.agent');
      const bubbles = [...document.querySelectorAll('.user-bubble')].map((b) => b.textContent);
      return {
        has: !!card,
        head: card?.querySelector('.injected-head')?.textContent ?? '',
        body: card?.querySelector('.injected-body')?.textContent ?? null,
        raw: bubbles.some((t) => t.includes('<agent-message')) || (card?.textContent ?? '').includes('<agent-message'),
        tab: document.querySelector('.center .tabs .tab.active .tab-label')?.textContent ?? '',
      };
    });
  await send('agentmsg');
  await waitFor(() => !!document.querySelector('.injected-card.agent'), 8000, 'cartão da mensagem de agente');
  await waitText('.msg .md', 'Recebi a mensagem do outro agente');
  await waitIdle();
  let i = await cardInfo();
  assert(i.head.includes('Mensagem de outro agente') && i.head.includes('aa99c95b'), `cabeçalho do cartão: ${i.head}`);
  assert(i.head.includes('Read-only checkout search'), `sem prévia do texto no cartão recolhido: ${i.head}`);
  assert(i.body === null, 'o cartão deveria começar recolhido');
  assert(!i.raw, 'o XML <agent-message> apareceu cru na tela');
  await shot('mensagem-de-agente-recolhida');
  await page.click('.injected-card.agent .injected-head');
  await waitFor(() => !!document.querySelector('.injected-card.agent .injected-body'), 3000, 'cartão abre ao clicar');
  i = await cardInfo();
  assert(i.body.includes('MP webhook HMAC') && i.body.includes('não foi você quem escreveu'), `corpo do cartão: ${i.body}`);
  assert(!i.raw, 'o XML apareceu ao abrir o cartão');
  await shot('mensagem-de-agente-aberta');
  // O caminho de leitura do histórico (recarregar a janela relê o transcript) tem que dar o mesmo resultado.
  await page.reload({ waitUntil: 'networkidle2' });
  await waitFor(() => !!document.querySelector('.injected-card.agent'), 15000, 'cartão depois de recarregar');
  i = await cardInfo();
  assert(!i.raw, 'depois de recarregar o XML apareceu cru');
  assert(!i.tab.includes('agent-message'), `o título da aba virou a mensagem do agente: ${i.tab}`);
});

await step('Data e hora do envio aparecem embaixo de cada mensagem do usuário (ao vivo e depois de recarregar)', async () => {
  const times = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.msg.user')].map((m) => ({
        text: m.querySelector('.user-bubble')?.textContent ?? '',
        time: m.querySelector('.user-bubble + .msg-time')?.textContent ?? null,
        iso: m.querySelector('.msg-time')?.getAttribute('datetime') ?? null,
      })),
    );
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${p(d.getDate())}/${p(d.getMonth() + 1)} às ${p(d.getHours())}:${p(d.getMinutes())}`;
  const before = new Date();
  await send('echo mensagem-com-horario');
  await waitText('.msg .md', 'mensagem-com-horario');
  await waitIdle();
  const after = new Date();
  let all = await times();
  const mine = all.find((x) => x.text.includes('mensagem-com-horario'));
  assert(mine?.time, `sem data/hora embaixo da mensagem: ${JSON.stringify(mine)}`);
  assert(mine.time === fmt(before) || mine.time === fmt(after), `data/hora: "${mine.time}" (esperado ${fmt(before)})`);
  assert(all.every((x) => x.time), `mensagem do usuário sem data/hora: ${JSON.stringify(all.filter((x) => !x.time))}`);
  const tip = await page.$eval('.msg-time', (e) => e.title);
  assert(/\d{4}, \d{2}:\d{2}:\d{2}$/.test(tip), `dica com data completa e segundos: ${tip}`);
  await shot('data-hora-da-mensagem');
  // Recarregar: relida do transcript, a mesma data/hora (minuto) continua lá, em todas as mensagens.
  await page.reload({ waitUntil: 'networkidle2' });
  await waitText('.user-bubble', 'mensagem-com-horario', 15000);
  all = await times();
  const again = all.find((x) => x.text.includes('mensagem-com-horario'));
  assert(again?.time === mine.time, `depois de recarregar: "${again?.time}" (antes "${mine.time}")`);
  assert(Math.abs(Date.parse(again.iso) - Date.parse(mine.iso)) < 5000, `horário mudou ao recarregar: ${mine.iso} → ${again.iso}`);
  assert(all.every((x) => x.time), 'depois de recarregar, alguma mensagem do usuário ficou sem data/hora');
});

await step('Resumo do /compact aparece na marca "Conversa compactada", não como mensagem do usuário (ao vivo e depois de recarregar)', async () => {
  const info = () =>
    page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('.user-bubble')].map((b) => b.textContent ?? '');
      const marks = [...document.querySelectorAll('.compact-mark')];
      const details = marks.map((m) => m.parentElement?.querySelector('details')?.textContent ?? '');
      return {
        inBubble: bubbles.some((t) => t.includes('This session is being continued') || t.includes('RESUMO-DE-TESTE')),
        marks: marks.length,
        summaryInMark: details.some((t) => t.includes('RESUMO-DE-TESTE-DO-COMPACT')),
        autoCard: [...document.querySelectorAll('.injected-card')].some((c) => (c.textContent ?? '').includes('This session is being continued')),
      };
    });
  await send('compactsim');
  await waitText('.msg .md', 'Continuando depois da compactação');
  await waitIdle();
  let i = await info();
  assert(!i.inBubble, 'o resumo do compact apareceu como bolha do usuário');
  assert(!i.autoCard, 'o resumo do compact virou cartão automático em vez da marca');
  assert(i.marks === 1, `marcas de compactação: ${i.marks}`);
  assert(i.summaryInMark, 'o resumo não ficou dentro da marca de compactação');
  await shot('compact-ao-vivo');
  await page.reload({ waitUntil: 'networkidle2' });
  await waitText('.msg .md', 'Continuando depois da compactação', 15000);
  i = await info();
  assert(!i.inBubble, 'depois de recarregar o resumo do compact apareceu como bolha do usuário');
  assert(i.marks === 1 && i.summaryInMark, `depois de recarregar: marcas=${i.marks} resumo=${i.summaryInMark}`);
});

await step('Trabalhando mostra há quanto tempo (cabeçalho e linha do chat); recarregar a janela não zera a contagem', async () => {
  const secs = (sel) =>
    page.$eval(sel, (e) => {
      const m = e.textContent.match(/(?:(\d+) min )?(\d+) s/);
      return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
    }).catch(() => null);
  await send('slow 400'); // ~40 s
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  await waitFor(() => /Trabalhando\s*·\s*\d+ s/.test(document.querySelector('.chat-header .phase-pill')?.textContent ?? ''), 5000, 'tempo no cabeçalho ("Trabalhando · N s")');
  const a = await secs('.chat-header .phase-pill');
  await sleep(2600);
  const b = await secs('.chat-header .phase-pill');
  assert(a !== null && b !== null && b >= a + 2, `o contador não anda: ${a} → ${b}`);
  await shot('trabalhando-com-tempo');
  // Recarrega no meio do turno: o servidor guarda o início, então a contagem continua de onde estava.
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.chat-header .phase-pill', { timeout: 15000 });
  await waitFor(() => /Trabalhando\s*·\s*\d+ s/.test(document.querySelector('.chat-header .phase-pill')?.textContent ?? ''), 8000, 'tempo no cabeçalho depois de recarregar');
  const c = await secs('.chat-header .phase-pill');
  assert(c !== null && c >= b, `a contagem voltou a zero ao recarregar: antes ${b} s, depois ${c} s`);
  await page.focus('.composer textarea');
  await page.keyboard.press('Escape');
  await waitIdle();
  await waitFor(() => !/·\s*\d+ s/.test(document.querySelector('.chat-header .phase-pill')?.textContent ?? ''), 5000, 'tempo some quando termina');
  assert((await count('.working-time')) === 0, 'a linha de tempo continuou depois de terminar');
});

await step('Título da janela mostra a atividade: ⏳ trabalhando, ✅ terminou e não foi visto, some ao ver', async () => {
  const title = () => page.evaluate(() => document.title);
  await send('slow 30');
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  await waitFor(() => document.title.startsWith('⏳ '), 5000, 'título começa com ⏳ enquanto trabalha');
  assert((await title()).endsWith('— Claude Deck'), `o resto do título mudou: ${await title()}`);
  await page.focus('.composer textarea');
  await page.keyboard.press('Escape');
  await waitIdle();
  await waitFor(() => !document.title.includes('⏳'), 5000, 'o ⏳ some quando para de trabalhar');
  // O servidor marca "terminou e não vi" depois de uma pausa (aqui 300 ms, ver CLAUDE_DECK_UNSEEN_DELAY_MS).
  // Esta conversa está à vista: se a página tem o foco, nem chega a marcar; se não tem, marca e some ao clicar na aba.
  await sleep(900);
  if (/^[✅❌]/u.test(await title())) {
    await page.click('.center .tabs .tab.active');
    await waitFor(() => !/^[✅❌]/u.test(document.title), 3000, 'o aviso some ao abrir a conversa');
  }
  const after = await title();
  assert(after.startsWith('Local · '), `título deveria voltar ao normal: ${after}`);
});

await step('"Terminou e não vi" fica no servidor: aparece na aba e no título, sobrevive a recarregar, some ao abrir', async () => {
  const unseenOnServer = async () => (await h.rpc('sessions.list')).filter((s) => s.unseen).map((s) => s.unseen);
  const n = await chatTabs();
  const other = await page.$eval('.center .tabs .tab.active .tab-label', (e) => e.textContent); // a que fica à vista
  // Conversa nova (fica ativa), manda uma mensagem e volta para a outra antes de terminar.
  await page.click('.chat-header button[title="Nova conversa na mesma pasta"]');
  await waitFor((c) => document.querySelectorAll('.center .tabs .tab').length === c, 10000, 'conversa nova', n + 1);
  await send('echo terminei-sem-ninguem-ver');
  await clickText('.center .tabs .tab .tab-label', other, true);
  // Terminou fora da vista: bolinha na aba, ✅ no título e o servidor guarda.
  await waitFor(() => !!document.querySelector('.tab .tab-status[title="Terminou (não visto)"]'), 8000, 'bolinha "Terminou (não visto)" na aba');
  await waitFor(() => document.title.startsWith('✅ '), 3000, 'título com ✅');
  assert((await unseenOnServer()).join() === 'done', `o servidor deveria guardar 1 "done": ${await unseenOnServer()}`);
  await shot('nao-visto-aba-e-titulo');
  // Recarregar a janela não perde o aviso (antes ele vivia só na memória da página).
  await page.reload({ waitUntil: 'networkidle2' });
  await waitFor((c) => document.querySelectorAll('.center .tabs .tab').length === c, 15000, 'abas de volta', n + 1);
  await waitFor(() => !!document.querySelector('.tab .tab-status[title="Terminou (não visto)"]'), 8000, 'bolinha depois de recarregar');
  await waitFor(() => document.title.startsWith('✅ '), 3000, 'título com ✅ depois de recarregar');
  // A barra de status conta a conversa e o menu leva direto até ela (sem procurar entre as abas).
  await waitFor(() => /\b1 concluída\b/.test(document.querySelector('.statusbar .sb-attn.sb-done')?.textContent ?? ''), 5000, '"1 concluída" na barra de status');
  await page.click('.statusbar .sb-attn.sb-done');
  await waitText('.attn-menu', 'Concluídas, ainda não vistas (1)');
  await waitText('.attn-menu .attn-row .attn-sub', 'Terminou');
  await shot('menu-concluidas');
  // Abrir pelo menu apaga o aviso, aqui e no servidor (a aba que fica ativa é a da conversa, não a de antes).
  await page.click('.attn-menu .attn-row');
  await waitFor(() => !document.querySelector('.attn-menu'), 3000, 'o menu fecha ao escolher a conversa');
  assert((await page.$eval('.center .tabs .tab.active .tab-label', (e) => e.textContent)) !== other, 'o menu deveria ter aberto a conversa que terminou, não a anterior');
  await waitFor(() => !document.querySelector('.tab .tab-status[title="Terminou (não visto)"]') && !document.title.startsWith('✅'), 3000, 'aviso some ao abrir a conversa pelo menu');
  await waitFor(() => !document.querySelector('.statusbar .sb-attn.sb-done'), 3000, 'o contador de concluídas some');
  const t0 = Date.now();
  while ((await unseenOnServer()).length && Date.now() - t0 < 3000) await sleep(100);
  assert((await unseenOnServer()).length === 0, 'o servidor continuou guardando o aviso depois de abrir a aba');
  // Fecha a conversa de teste e devolve a que estava à vista.
  await hotkey('Control', 'Shift', 'W');
  await waitFor((c) => document.querySelectorAll('.center .tabs .tab').length === c, 5000, 'conversa de teste fechada', n);
  await clickText('.center .tabs .tab .tab-label', other, true);
  await waitIdle();
});

// Abas reordenam depois de recarregar (o que pede atenção sobe): localiza sempre pelo título, nunca pela posição.
const MAIN_TAB = 'Olá, mundo';
const AUX_TAB = 'pendente auxiliar';
const activeLabel = () => page.$eval('.center .tabs .tab.active .tab-label', (e) => e.textContent);
async function openTab(text) {
  await clickText('.center .tabs .tab .tab-label', text);
  await waitFor((t) => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent.includes(t), 5000, `aba "${text}" ativa`, text);
}

await step('Marcar para ver depois mantém a pendência até reabrir a aba, inclusive após F5', async () => {
  await page.click('.chat-header button[title="Nova conversa na mesma pasta"]');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 2, 8000, 'segunda aba para testar reabertura');
  // A auxiliar precisa de id de sessão: é ela que o próximo passo fecha e retoma pelo Histórico.
  await send(`echo ${AUX_TAB}`);
  await waitText('.msg .md', AUX_TAB);
  await waitIdle();
  await waitFor((t) => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent.includes(t), 8000, 'título da aba auxiliar', AUX_TAB);
  await openTab(MAIN_TAB);
  await page.click('.chat-header button[title="Marcar como pendente de visualização"]');
  await waitFor(() => !!document.querySelector('.center .tabs .tab.active .tab-manual-pending'), 5000, 'marcador na aba ativa');
  await waitFor(() => !!document.querySelector('.statusbar .sb-pending'), 5000, 'contador de pendências');
  await page.click('.center .tabs .tab.active .tab-label'); // não abre outra vez
  await sleep(300);
  assert(!!(await page.$('.center .tabs .tab.active .tab-manual-pending')), 'clicar na aba já ativa não deveria apagar a pendência');
  await page.reload({ waitUntil: 'networkidle2' });
  await waitFor((t) => [...document.querySelectorAll('.center .tabs .tab')].some((tab) => tab.querySelector('.tab-label')?.textContent.includes(t) && tab.querySelector('.tab-manual-pending')), 10000, 'pendência após F5', MAIN_TAB);
  assert((await activeLabel()).includes(MAIN_TAB), `a aba ativa restaurada deveria ser a marcada (está "${await activeLabel()}")`);
  assert((await h.rpc('pending.list', { hostId: 'local' })).length === 1, 'restaurar a janela não pode apagar a pendência');
  await openTab(AUX_TAB);
  await openTab(MAIN_TAB);
  await waitFor(() => !document.querySelector('.center .tabs .tab.active .tab-manual-pending'), 5000, 'pendência apagada ao reabrir');
  assert(!(await h.rpc('pending.list', { hostId: 'local' })).length, 'servidor ainda guarda marca após reabrir');
});

await step('Pendência de aba fechada continua no Histórico de todas as pastas e some ao retomar', async () => {
  // Usa a conversa auxiliar: a principal segue aberta para os próximos passos, como antes.
  await openTab(AUX_TAB);
  const current = await activeLabel();
  await page.click('.chat-header button[title="Marcar como pendente de visualização"]');
  await waitFor(() => !!document.querySelector('.center .tabs .tab.active .tab-manual-pending'), 5000, 'pendência na aba');
  const id = (await h.rpc('pending.list', { hostId: 'local' }))[0]?.sessionId;
  assert(!!id, 'pendência não foi persistida');
  await page.click('.center .tabs .tab.active .close');
  await waitFor((title) => ![...document.querySelectorAll('.center .tabs .tab .tab-label')].some((e) => e.textContent === title), 5000, 'aba fechada', current);
  assert((await h.rpc('pending.list', { hostId: 'local' })).some((p) => p.sessionId === id), 'fechar apagou a pendência');
  await hotkey('Control', 'Shift', 'H');
  await page.click('.sidebar .seg button:nth-child(3)');
  await waitFor(() => !!document.querySelector('.sidebar .tree-row.history-pending'), 10000, 'pendência no Histórico');
  await waitText('.sidebar .tree-row.history-pending .label', current);
  assert(!!(await page.$('.activitybar .act-btn[title*="pendente"] .act-badge.pending')), 'Histórico deveria mostrar contador da aba fechada');
  await page.click('.sidebar .tree-row.history-pending .label');
  await waitFor((title) => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === title, 10000, 'retomada pelo Histórico', current);
  await waitFor(() => !document.querySelector('.sidebar .tree-row.history-pending'), 10000, 'pendência sumiu do Histórico ao abrir');
  assert(!(await h.rpc('pending.list', { hostId: 'local' })).length, 'abrir pelo Histórico deveria limpar a marca');
  // Fecha a auxiliar e volta à aba principal, sem alterar o estado esperado pelos próximos passos.
  await page.click('.center .tabs .tab.active .close');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 1, 5000, 'aba auxiliar fechada');
  assert((await activeLabel()).includes(MAIN_TAB), 'a aba principal deveria continuar aberta');
  await hotkey('Control', 'Shift', 'E');
  await waitIdle();
});

await step('Mensagem enquanto o Claude trabalha (fila)', async () => {
  await send('slow');
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  await send('echo depois do slow');
  await sleep(500);
  await page.click('.send-btn.stop');
  await waitText('.msg .md', 'depois do slow', 15000);
  await waitIdle();
});

await step('Anexar imagem e enviar', async () => {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click('.composer button[title="Anexar imagem"]')]);
  await chooser.accept([path.join(sandbox, 'media', 'imagem.png')]);
  await page.waitForSelector('.composer .attach-row img', { timeout: 5000 });
  await send('com imagem');
  await waitText('.msg .md', 'Recebi: com imagem (+1 imagem)');
  await waitIdle();
  assert((await count('.user-bubble img')) >= 1, 'imagem não aparece na mensagem enviada');
  await (await page.$$('.user-bubble img')).at(-1).click();
  await page.waitForSelector('.overlay img', { timeout: 3000 });
  await page.click('.overlay');
});

await step('Sugestões de comandos (/)', async () => {
  await typeComposer('/');
  await waitText('.suggest .suggest-item .name', '/fake-cmd');
  await waitText('.suggest .suggest-item .name', '/clear');
  await shot('sugestoes-comandos');
  await page.keyboard.press('Escape');
  await clearComposer();
});

await step('Menção de arquivo (@)', async () => {
  await typeComposer('@app');
  await waitText('.suggest .suggest-item .desc', 'src/app.ts');
  await clickText('.suggest .suggest-item', 'src/app.ts');
  const v = await composerValue();
  assert(v === '@src/app.ts ', `menção inesperada: "${v}"`);
  await clearComposer();
});

await step('Modo de permissão: Shift+Tab e menu', async () => {
  await page.focus('.composer textarea');
  await hotkey('Shift', 'Tab');
  await waitText('.composer .pill-select', 'Planejar');
  await page.click('.composer .pill-select');
  await menu('Pedir permissão');
  await waitText('.composer .pill-select', 'Pedir permissão');
  await waitText('.statusbar', 'Pedir permissão');
});

await step('Trocar o modelo', async () => {
  await page.click('.composer .pill-select[title="Modelo desta conversa"]');
  await menu('Fake Opus');
  await waitText('.toast', 'Modelo: fake-opus');
  await waitText('.composer .pill-select[title="Modelo desta conversa"]', 'Fake Opus');
});

await step('Trocar o nível de esforço', async () => {
  await page.click('.composer .pill-select[title="Modelo desta conversa"]');
  await menu('Alto');
  await waitText('.toast', 'Esforço: high');
  await waitText('.composer .pill-select[title="Modelo desta conversa"]', 'Alto');
  await send('effort');
  await waitText('.msg .md', 'esforço=high', 20000);
  await waitIdle();
});

await step('Uso do contexto', async () => {
  await page.click('.chat-header button[title="Mais"]');
  await menu('Uso do contexto');
  await waitText('.toast', 'Contexto:');
  await waitText('.toast', '6%');
});

await step('Várias abas: Ctrl+N, Alt+1, Ctrl+Tab, renomear', async () => {
  await hotkey('Control', 'n');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 2, 8000, '2 abas');
  await waitIdle();
  await send('echo segunda aba');
  await waitText('.msg .md', 'segunda aba');
  await waitIdle();
  await hotkey('Alt', '1');
  await waitFor(() => document.querySelector('.center .tabs .tab.active') === document.querySelectorAll('.center .tabs .tab')[0], 5000, 'aba 1 ativa');
  await waitText('.msg .md', 'Olá, mundo!');
  await hotkey('Control', 'Tab');
  await waitFor(() => document.querySelector('.center .tabs .tab.active') === document.querySelectorAll('.center .tabs .tab')[1], 5000, 'aba 2 ativa');
  const tab = await page.$('.center .tabs .tab.active');
  await tab.click({ button: 'right' });
  await menu('Renomear');
  // O nome vira um campo na própria aba (sem diálogo).
  await page.waitForSelector('.center .tabs .tab.active input.tab-rename', { timeout: 5000 });
  assert(!(await page.$('.dialog')), 'renomear não deveria abrir diálogo');
  await hotkey('Control', 'a');
  await page.keyboard.type('Minha aba');
  await waitFor(() => document.querySelector('.tab-rename')?.value === 'Minha aba', 3000, 'nome digitado');
  await page.keyboard.press('Enter');
  await waitFor(() => !document.querySelector('.tab-rename'), 3000, 'campo fechado');
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Minha aba', 5000, 'aba renomeada');
  await shot('duas-abas');
});

await step('Renomear aba: duplo clique, F2, Esc cancela e nome vazio mantém o atual', async () => {
  const label = () => page.$eval('.center .tabs .tab.active .tab-label', (e) => e.textContent);
  const field = '.center .tabs .tab.active input.tab-rename';
  // Diz QUAL abertura do campo falhou (o erro do puppeteer só cita o seletor).
  const openField = async (how) => {
    try {
      await page.waitForSelector(field, { timeout: 4000 });
    } catch {
      throw new Error(`campo de renomear não abriu (${how})`);
    }
  };
  // Duplo clique abre o campo com o nome atual. (`count: 2` é o duplo clique de verdade; `clickCount: 2`
  // nesta versão do puppeteer não gera o evento dblclick.)
  await (await page.$('.center .tabs .tab.active')).click({ count: 2 });
  await openField('duplo clique');
  assert((await page.$eval(field, (e) => e.value)) === 'Minha aba', 'o campo deveria abrir com o nome atual');
  // Esc descarta o que foi digitado.
  await page.keyboard.type('descartado');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.tab-rename'), 3000, 'campo fechado com Esc');
  assert((await label()) === 'Minha aba', `Esc não deveria renomear (ficou "${await label()}")`);
  // Apagar tudo e confirmar não deixa a aba sem nome.
  await page.keyboard.press('F2');
  await openField('F2 depois do Esc');
  await hotkey('Control', 'a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await waitFor(() => !document.querySelector('.tab-rename'), 3000, 'campo fechado com nome vazio');
  await sleep(400); // tempo para um eventual nome vazio chegar do servidor
  assert((await label()) === 'Minha aba', `nome vazio apagou o nome da aba (ficou "${await label()}")`);
  // Clicar fora também grava (como no explorador).
  await page.keyboard.press('F2');
  await openField('F2 depois do nome vazio');
  await hotkey('Control', 'a');
  await page.keyboard.type('Aba F2');
  await page.click('.center .chat-header .host-chip'); // área neutra: tira o foco do campo
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Aba F2', 5000, 'renomeada ao clicar fora');
  // Volta ao nome que os passos seguintes esperam.
  await page.keyboard.press('F2');
  await openField('F2 depois de clicar fora');
  await hotkey('Control', 'a');
  await page.keyboard.type('Minha aba');
  await page.keyboard.press('Enter');
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Minha aba', 5000, 'nome restaurado');
});

await step('Agentes em execução: indicador ao lado do modelo (segundo plano, sobrevive a recarregar, some no fim)', async () => {
  const pill = '.composer-bar .agents-pill';
  const pillText = () => page.$eval(pill, (e) => e.textContent.trim());
  assert(!(await page.$(pill)), 'sem agentes rodando não deveria haver indicador');
  await send('bgagent 2');
  await waitText(pill, '2 agentes');
  await waitIdle(); // o turno acabou, mas os agentes seguem em segundo plano
  assert((await pillText()).includes('2 agentes'), `depois do fim do turno: "${await pillText()}"`);
  const tip = await page.$eval(pill, (e) => e.title);
  assert(tip.includes('2 agentes em execução') && tip.includes('Explore') && tip.includes('Tarefa 1') && tip.includes('segundo plano'), `dica do indicador: ${tip}`);
  // O indicador fica ao lado do seletor de modelo.
  const order = await page.$$eval('.composer-bar > *', (els) => els.map((e) => (e.classList.contains('agents-pill') ? 'agentes' : e.getAttribute('title') === 'Modelo desta conversa' ? 'modelo' : '')));
  assert(order.indexOf('agentes') === order.indexOf('modelo') + 1 && order.indexOf('modelo') >= 0, `posição do indicador: ${JSON.stringify(order)}`);
  const checkDetails = async () => {
    await page.click(pill);
    await waitText('.agents-dialog .dialog-head', 'Mapa de agentes e tarefas (2)');
    assert((await count('.agents-dialog .agent-run')) === 2, 'faltam agentes no painel');
    await waitText('.agents-dialog .agent-run:first-child', 'Tarefa 1');
    await waitText('.agents-dialog .agent-run:first-child', 'Explore');
    await waitText('.agents-dialog .agent-run:first-child', 'claude-haiku-4-5');
    await waitText('.agents-dialog .agent-run:first-child .agent-prompt', 'Etapa 1: não altere nada.');
    await waitText('.agents-dialog .agent-run:nth-child(2) .agent-prompt', 'Etapa 2: não altere nada.');
    await clickText('.agents-dialog .agent-run:first-child .agent-run-actions button', 'Ver transcrito');
    await waitText('.agents-dialog .agent-run:first-child .agent-transcript', 'Transcrito do agente agent1');
    await page.keyboard.press('Escape');
    await waitFor(() => !document.querySelector('.agents-dialog'), 3000, 'painel de agentes fechado');
  };
  await checkDetails();
  // Recarregar a janela: o transcript traz as chamadas e o servidor diz quando o processo começou.
  await sleep(1100);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await waitText(pill, '2 agentes', 15000);
  await checkDetails();
  // Parar um único agente pelo mapa não interrompe o outro nem a conversa.
  await page.click(pill);
  await clickText('.agents-dialog .agent-run:first-child .agent-run-actions button', 'Parar só esta tarefa');
  await waitText('.agents-dialog .agent-run', 'Parado');
  await page.keyboard.press('Escape');
  await waitText(pill, '1 agente');
  // O outro termina e fica registrado no mapa, sem falso agente em execução.
  await send('agentdone');
  await waitIdle();
  await waitFor(() => document.querySelector('.composer-bar .agents-pill')?.textContent.includes('Agentes'), 8000, 'mapa de agentes concluídos');
  await page.click(pill);
  await waitText('.agents-dialog', 'Concluído');
  await page.keyboard.press('Escape');
});

await step('/clear abre conversa nova na mesma aba', async () => {
  await typeComposer('/cle');
  await waitText('.suggest .suggest-item .name', '/clear');
  await page.keyboard.press('Enter'); // aplica a sugestão
  assert((await composerValue()) === '/clear ', 'sugestão não aplicada');
  await page.keyboard.press('Enter'); // envia
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Nova conversa', 8000, 'aba nova');
  assert((await chatTabs()) === 2, 'o /clear deveria manter 2 abas');
  await waitIdle();
  await waitText('.empty-chat h2', 'Nova conversa');
});

await step('Histórico: listar e retomar conversa antiga (--resume)', async () => {
  await hotkey('Control', 'Shift', 'H');
  await waitText('.sidebar .side-title', 'Histórico');
  await waitText('.sidebar .tree-row .label', 'Minha aba');
  // O histórico é só do servidor desta janela: sem seletor de servidor.
  assert(!(await page.$('.sidebar select')), 'o histórico não deveria deixar escolher outro servidor');
  await waitText('.sidebar .history-host', 'Este computador');
  await shot('historico');
  await clickText('.sidebar .tree-row', 'Minha aba');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 3, 8000, '3 abas');
  await waitText('.user-bubble', 'echo segunda aba');
  await send('echo retomada');
  await waitText('.msg .md', 'retomada', 20000);
  await waitIdle();
  // O transcript retomado é o mesmo arquivo (mesma sessão do CLI).
  const projDir = path.join(claudeDir, 'projects', sandbox.replace(/[^a-zA-Z0-9]/g, '-'));
  const files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
  const withBoth = files.filter((f) => {
    const t = fs.readFileSync(path.join(projDir, f), 'utf8');
    return t.includes('echo segunda aba') && t.includes('echo retomada');
  });
  assert(withBoth.length === 1, `esperava 1 transcript com as duas mensagens, achei ${withBoth.length} (de ${files.length})`);
});

await step('Conversa já aberta nunca ganha 2ª aba: clicar de novo no histórico (até duplo clique) só ativa a aba dela', async () => {
  const tabsBefore = await chatTabs();
  const listBefore = (await h.rpc('sessions.list')).length;
  // Outra aba ativa, para ver que o clique volta para a aba da conversa.
  await hotkey('Alt', '1');
  await waitFor(() => document.querySelector('.center .tabs .tab.active') === document.querySelectorAll('.center .tabs .tab')[0], 5000, 'aba 1 ativa');
  await hotkey('Control', 'Shift', 'H');
  await waitText('.sidebar .side-title', 'Histórico');
  await waitText('.sidebar .tree-row .label', 'Minha aba');
  // Dois cliques no mesmo instante (duplo clique): os dois pedidos saem antes de qualquer resposta.
  const clickTwice = () =>
    page.evaluate(() => {
      const row = [...document.querySelectorAll('.sidebar .tree-row')].find((e) => e.textContent.includes('Minha aba'));
      row.click();
      row.click();
    });
  const check = async (label) => {
    await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Minha aba', 8000, `${label}: a aba da conversa ficou ativa`);
    await sleep(700); // tempo para uma aba duplicada aparecer, se aparecesse
    const labels = await page.$$eval('.center .tabs .tab .tab-label', (e) => e.map((x) => x.textContent));
    assert(labels.filter((l) => l === 'Minha aba').length === 1, `${label}: abas ${JSON.stringify(labels)}`);
    assert((await chatTabs()) === tabsBefore, `${label}: ${tabsBefore} → ${await chatTabs()} abas`);
    assert((await h.rpc('sessions.list')).length === listBefore, `${label}: o servidor tem outra sessão para a mesma conversa`);
    await waitText('.msg .md', 'retomada');
  };
  // 1. Aberta: clicar de novo (e com duplo clique) só volta para a aba dela.
  await clickTwice();
  await check('já aberta');
  await clickText('.sidebar .tree-row', 'Minha aba');
  await check('clique simples');
  // 2. Fechada: o duplo clique retoma UMA vez (antes os dois pedidos criavam duas abas).
  await page.click('.center .tabs .tab.active .close');
  await waitFor((k) => document.querySelectorAll('.center .tabs .tab').length === k - 1, 5000, 'aba fechada', tabsBefore);
  await clickTwice();
  await check('reaberta com duplo clique');
  await shot('uma-aba-por-conversa');
});

await step('Recarregar a página mantém abas e conversas', async () => {
  const before = await chatTabs();
  const filesBefore = await count('.editor-panel .tab');
  // O layout tem debounce de 600 ms; simula um reload depois de salvar o estado.
  await sleep(1100);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await waitFor((n) => document.querySelectorAll('.center .tabs .tab').length === n, 10000, 'abas restauradas', before);
  await waitText('.msg .md', 'retomada', 15000);
  await waitFor((n) => document.querySelectorAll('.editor-panel .tab').length === n, 10000, 'arquivos restaurados', filesBefore);
});

await step('Texto colado no terminal (<pasted_content>): título limpo e bloco recolhido', async () => {
  const projDir = path.join(claudeDir, 'projects', sandbox.replace(/[^a-zA-Z0-9]/g, '-'));
  const sid = crypto.randomUUID();
  const text = 'resuma isto:\n\n<pasted_content id="ab12">\nLinha colada um\nLinha colada dois\nLinha colada três\n</pasted_content id="ab12">\n';
  const base = { sessionId: sid, cwd: sandbox, timestamp: new Date().toISOString() };
  const lines = [
    { ...base, type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } },
    { ...base, type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'Resumo pronto.' }] } },
  ];
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const activeBefore = await page.$$eval('.center .tabs .tab', (t) => t.findIndex((x) => x.classList.contains('active')));
  await hotkey('Control', 'Shift', 'H');
  await waitText('.sidebar .side-title', 'Histórico');
  await page.click('.sidebar .icon-btn[title="Atualizar"]');
  await waitText('.sidebar .tree-row .label', 'resuma isto: Linha colada um');
  const raw = await page.$$eval('.sidebar .tree-row .label', (e) => e.some((x) => x.textContent.includes('pasted_content')));
  assert(!raw, 'a marcação <pasted_content> apareceu no título do histórico');
  await clickText('.sidebar .tree-row', 'resuma isto:');
  await page.waitForSelector('.user-bubble details.pasted', { timeout: 10000 });
  const summary = await page.$eval('.user-bubble details.pasted summary', (e) => e.textContent);
  assert(/Texto colado · 3 linhas — Linha colada um/.test(summary), `resumo do bloco: ${summary}`);
  assert(!(await page.$eval('.user-bubble details.pasted', (e) => e.open)), 'o bloco colado deveria começar recolhido');
  const bubble = await page.$eval('.user-bubble details.pasted', (e) => e.closest('.user-bubble').textContent);
  assert(bubble.startsWith('resuma isto:') && !bubble.includes('<pasted_content'), `bolha: ${bubble.slice(0, 120)}`);
  await page.click('.user-bubble details.pasted summary');
  await waitFor(() => document.querySelector('.user-bubble details.pasted')?.open, 3000, 'bloco aberto');
  await waitText('.user-bubble details.pasted > div', 'Linha colada três');
  await shot('texto-colado');
  // Fecha a conversa aberta e volta para a que estava ativa.
  await hotkey('Control', 'Shift', 'W');
  await sleep(300);
  await page.evaluate((i) => document.querySelectorAll('.center .tabs .tab')[i]?.click(), activeBefore);
  await hotkey('Control', 'Shift', 'E');
});

// ------------------------------------------------ visualizadores
await step('Markdown (visualizar, imagem relativa, link, código)', async () => {
  await hotkey('Control', 'Shift', 'E');
  await clickTree('README.md');
  await waitActiveFile('README.md');
  await waitText('.md-view h1', 'Projeto de teste do Claude Deck');
  await waitFor(() => {
    const i = document.querySelector('.md-view img');
    return i && i.complete && i.naturalWidth > 0;
  }, 8000, 'imagem relativa do markdown');
  assert((await count('.md-view table')) === 1, 'tabela do markdown');
  assert((await count('.md-view .md-check')) === 2, 'lista de tarefas do markdown');
  assert((await count('.md-view .md-check.on')) === 1, 'tarefa marcada');
  await waitText('.statusbar', 'MARKDOWN · 705 B');
  await shot('visualizador-markdown');
  await clickText('.md-view a', 'o app');
  await waitActiveFile('app.ts');
  await clickText('.editor-panel .tab .tab-label', 'README.md', true);
  await waitActiveFile('README.md');
  await clickText('.editor-toolbar .seg button', 'Código');
  await page.waitForSelector('.editor-panel .cm-editor', { timeout: 5000 });
  await clickText('.editor-toolbar .seg button', 'Visualizar');
  await page.waitForSelector('.md-view h1', { timeout: 5000 });
});

await step('HTML isolado (CSS, JS, imagem com ../, sem cookies)', async () => {
  await clickTree('site');
  await clickTree('index.html');
  await waitActiveFile('index.html');
  await page.waitForSelector('.html-frame', { timeout: 8000 });
  let frame;
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('/preview/'));
    if (!frame) await sleep(100);
  }
  assert(frame, 'iframe da pré-visualização não carregou');
  await frame.waitForFunction(() => document.getElementById('js')?.textContent.startsWith('JavaScript rodou dentro'), { timeout: 8000 });
  const info = await frame.evaluate(() => ({
    cookie: document.getElementById('cookie')?.textContent ?? '',
    color: getComputedStyle(document.querySelector('h1')).color,
  }));
  assert(/bloqueado|nenhum/.test(info.cookie), `a página enxergou cookies: ${info.cookie}`);
  assert(info.color === 'rgb(255, 209, 102)', `CSS relativo não aplicou (${info.color})`);
  await frame.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0, { timeout: 5000 }).catch(() => {
    throw new Error('imagem com ../ não carregou no HTML');
  });
  // Origem opaca impede acesso a cookies e à API do app (também testada por HTTP direto).
  const origin = await frame.evaluate(() => self.origin);
  assert(origin === 'null', `pré-visualização sem origem opaca (${origin})`);
  await shot('visualizador-html');
});

await step('Imagens (PNG, JPG, SVG, zoom)', async () => {
  await clickTree('media');
  await clickTree('imagem.png');
  await waitActiveFile('imagem.png');
  await waitFor(() => document.querySelector('.image-view img')?.naturalWidth === 800, 8000, 'PNG carregado');
  await waitText('.editor-body', '800×450');
  await shot('visualizador-imagem');
  await page.click('.image-view');
  await page.waitForSelector('.image-view.zoomed', { timeout: 3000 });
  await clickTree('foto.jpg');
  await waitActiveFile('foto.jpg');
  await waitFor(() => document.querySelector('.image-view img')?.naturalWidth > 0, 8000, 'JPG carregado');
  await clickTree('logo.svg');
  await waitActiveFile('logo.svg');
  await waitFor(() => document.querySelector('.image-view img')?.naturalWidth > 0, 8000, 'SVG carregado');
});

await step('Vídeo MP4 (metadados, busca, reprodução)', async () => {
  await clickTree('teste.mp4');
  await waitActiveFile('teste.mp4');
  await page.waitForSelector('.media-view video', { timeout: 8000 });
  const v = await page.evaluate(async () => {
    const v = document.querySelector('.media-view video');
    if (v.readyState < 1)
      await new Promise((r, j) => (v.addEventListener('loadedmetadata', r, { once: true }), v.addEventListener('error', () => j(new Error('erro no vídeo')), { once: true }), setTimeout(() => j(new Error('sem metadados')), 8000)));
    const meta = { w: v.videoWidth, h: v.videoHeight, d: v.duration };
    v.muted = true;
    v.currentTime = 4;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    await v.play();
    await new Promise((r) => setTimeout(r, 800));
    const t = v.currentTime;
    v.pause();
    return { ...meta, t };
  });
  assert(v.w === 1280 && v.h === 720, `dimensões ${v.w}x${v.h}`);
  assert(Math.abs(v.d - 6) < 0.6, `duração ${v.d}`);
  assert(v.t > 4.2, `não reproduziu depois da busca (t=${v.t})`);
  await waitText('.statusbar', 'VIDEO · 2.0 MB');
  await sleep(300);
  await shot('visualizador-video');
});

await step('Áudio WAV (forma de onda, info, tocar, clicar para buscar)', async () => {
  await clickTree('tom.wav');
  await waitActiveFile('tom.wav');
  await page.waitForSelector('canvas.waveform', { timeout: 10000 });
  await waitText('.audio-meta', '44.1 kHz');
  await waitText('.audio-meta', '16 bits');
  await waitText('.audio-meta', 'estéreo');
  const t = await page.evaluate(async () => {
    const a = document.querySelector('.audio-card audio');
    a.muted = true;
    await a.play();
    const started = !a.paused && a.readyState >= 2;
    await new Promise((r) => setTimeout(r, 800));
    const t = a.currentTime;
    a.pause();
    return { t, started };
  });
  assert(t.started, `áudio não entrou em estado de reprodução (t=${t.t})`);
  // Brave headless às vezes não avança o relógio do dispositivo de áudio; o player
  // real e a busca são conferidos em seguida pelo estado do elemento e metadados.
  const box = await (await page.$('canvas.waveform')).boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await sleep(300);
  const t2 = await page.evaluate(() => {
    const a = document.querySelector('.audio-card audio');
    a.pause();
    return a.currentTime;
  });
  assert(t2 > 2.5, `clique na forma de onda não buscou (t=${t2})`);
  await shot('visualizador-audio-wav');
});

await step('Áudio MP3', async () => {
  await clickTree('ruido.mp3');
  await waitActiveFile('ruido.mp3');
  await page.waitForSelector('canvas.waveform', { timeout: 10000 });
  await waitText('.audio-meta', 'kHz');
});

await step('PDF (visualizador do navegador, sem download)', async () => {
  await clickTree('documento.pdf');
  await waitActiveFile('documento.pdf');
  await page.waitForSelector('iframe.pdf-frame', { timeout: 8000 });
  // O arquivo chega como PDF de verdade, inline (sem "attachment") e sem o CSP "sandbox",
  // que impediria o visualizador de PDF do navegador de abrir.
  const r = await page.evaluate(async () => {
    const src = document.querySelector('iframe.pdf-frame').src;
    const res = await fetch(src);
    const b = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      disp: res.headers.get('content-disposition'),
      csp: res.headers.get('content-security-policy'),
      magic: String.fromCharCode(...b.slice(0, 5)),
      size: b.length,
    };
  });
  assert(r.status === 200 && r.type === 'application/pdf', `resposta do PDF: ${r.status} ${r.type}`);
  assert(r.magic === '%PDF-' && r.size > 500, `conteúdo do PDF (${r.magic}, ${r.size} B)`);
  assert(!r.disp, `o PDF seria baixado em vez de exibido (${r.disp})`);
  assert(!r.csp || !/sandbox/.test(r.csp), `CSP bloquearia o visualizador de PDF (${r.csp})`);
  // O quadro do PDF carrega (o visualizador embutido do Chromium/Brave assume dali).
  let frame;
  for (let i = 0; i < 50 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('documento.pdf'));
    if (!frame) await sleep(100);
  }
  assert(frame, 'o quadro do PDF não carregou');
  await waitText('.statusbar', 'PDF');
  await sleep(600);
  await shot('visualizador-pdf');
});

await step('JSON em árvore (busca, expandir, copiar caminho)', async () => {
  await clickTree('data');
  await clickTree('config.json');
  await waitActiveFile('config.json');
  await waitText('.json-view .jkey', '"servidores"');
  await shot('visualizador-json');
  await page.type('.json-tools input', 'ia-manager');
  await waitFor(() => document.querySelectorAll('.json-view .jrow.hit').length >= 1, 5000, 'resultado da busca');
  await waitText('.json-tools', 'resultado');
  await shot('visualizador-json-busca');
  const row = await page.$('.json-view .jrow.hit');
  await row.hover();
  await (await row.$('.jcopy button[title="Copiar caminho"]')).click();
  await waitText('.toast', 'Caminho copiado');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clip !== null) assert(/^\$\.servidores\[1\]\.(alias|pastas\[0\])$/.test(clip), `caminho copiado inesperado: ${clip}`);
  await page.click('.json-tools input', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  const before = await count('.json-view .jrow');
  await clickText('.json-tools .btn', 'Expandir');
  await waitFor((n) => document.querySelectorAll('.json-view .jrow').length > n, 5000, 'expandir tudo', before);
  await clickText('.json-tools .btn', 'Recolher');
  // Recolher deixa só o primeiro nível: raiz + 8 chaves + fechamento.
  await waitFor(() => document.querySelectorAll('.json-view .jrow').length === 10, 5000, 'recolher tudo');
  await waitFor(() => document.querySelector('.json-tools input')?.value === '', 3000, 'busca limpa');
});

await step('JSONL (uma linha por item)', async () => {
  await clickTree('eventos.jsonl');
  await waitActiveFile('eventos.jsonl');
  await waitText('.json-view .jidx', 'linha 1');
  await waitText('.json-view .jidx', 'linha 4');
});

await step('CSV em tabela (separador ;, aspas)', async () => {
  await clickTree('clientes.csv');
  await waitActiveFile('clientes.csv');
  await page.waitForSelector('.csv-table', { timeout: 5000 });
  assert((await count('.csv-table tbody tr')) === 4, 'CSV deveria ter 4 linhas');
  await waitText('.csv-table td', 'Padaria "Pão Quente"');
  await waitText('.csv-table th', 'cidade');
  await shot('visualizador-csv');
});

await step('Binário (hexadecimal)', async () => {
  await clickTree('dados.bin');
  await waitActiveFile('dados.bin');
  await waitFor(() => (document.querySelector('.hex')?.textContent ?? '').startsWith('00000000'), 5000, 'hex');
});

await step('Arquivo de texto grande (3,6 MB, 60 mil linhas)', async () => {
  const t0 = Date.now();
  await clickTree('log-grande.log');
  await waitActiveFile('log-grande.log');
  await page.waitForSelector('.editor-panel .cm-editor', { timeout: 15000 });
  const ms = Date.now() - t0;
  assert(ms < 8000, `demorou ${ms} ms para abrir`);
  console.log(`   (abriu em ${ms} ms)`);
});

await step('Editar e salvar (Ctrl+S) + conflito com mudança externa', async () => {
  await clickTree('src');
  await clickTree('app.ts');
  await waitActiveFile('app.ts');
  await page.waitForSelector('.editor-panel .cm-content', { timeout: 5000 });
  await page.click('.editor-panel .cm-content');
  await hotkey('Control', 'End');
  await page.keyboard.type('\n// editado pelo teste E2E');
  await page.waitForSelector('.editor-panel .tab.active.dirty', { timeout: 3000 });
  await hotkey('Control', 's');
  await waitText('.toast', 'Salvo: app.ts');
  assert(readSb('src', 'app.ts').includes('// editado pelo teste E2E'), 'não gravou no disco');
  await sleep(50);
  fs.appendFileSync(path.join(sandbox, 'src', 'app.ts'), '\n// mudança externa\n');
  await page.click('.editor-panel .cm-content');
  await hotkey('Control', 'End');
  await page.keyboard.type('\n// segunda edição');
  await hotkey('Control', 's');
  await waitText('.dialog .dialog-head', 'O arquivo mudou no disco');
  await shot('conflito-ao-salvar');
  await clickText('.dialog .dialog-foot .btn', 'Sobrescrever');
  await waitFor(() => !document.querySelector('.dialog'), 5000, 'diálogo de conflito fechado');
  await waitFor(() => !document.querySelector('.editor-panel .tab.active.dirty'), 5000, 'salvar após conflito');
  const disk = readSb('src', 'app.ts');
  assert(disk.includes('// segunda edição') && !disk.includes('mudança externa'), 'conteúdo final inesperado');
});

// ------------------------------------------------ explorador
await step('Explorador: novo arquivo', async () => {
  await page.click('.section-head button[title="Novo arquivo"]');
  await page.waitForSelector('.tree-row input.rename', { timeout: 3000 });
  await page.keyboard.type('criado.md');
  await page.keyboard.press('Enter');
  await waitActiveFile('criado.md');
  assert(exists('criado.md'), 'criado.md não existe no disco');
});

await step('Explorador: renomear', async () => {
  const row = await findTreeRow('criado.md');
  await row.click({ button: 'right' });
  await menu('Renomear');
  await page.waitForSelector('.tree-row input.rename', { timeout: 3000 });
  await hotkey('Control', 'a');
  await page.keyboard.type('renomeado.md');
  await page.keyboard.press('Enter');
  await findTreeRow('renomeado.md');
  assert(exists('renomeado.md') && !exists('criado.md'), 'renomear não refletiu no disco');
});

await step('Explorador: apagar (com confirmação)', async () => {
  const row = await findTreeRow('renomeado.md');
  await row.click({ button: 'right' });
  await menu('Apagar');
  await waitText('.dialog .dialog-head', 'Apagar renomeado.md?');
  await clickText('.dialog .dialog-foot .btn', 'Apagar', true);
  await waitText('.toast', 'Apagado: renomeado.md');
  assert(!exists('renomeado.md'), 'arquivo continua no disco');
});

await step('Explorador: enviar arquivo (upload) e substituir', async () => {
  for (const round of [1, 2]) {
    const row = await findTreeRow('data');
    await row.click({ button: 'right' });
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), menu('Enviar arquivos para cá')]);
    await chooser.accept([path.join(uploads, 'upload-e2e.txt')]);
    if (round === 2) {
      await waitText('.dialog .dialog-head', 'Substituir upload-e2e.txt?');
      await clickText('.dialog .dialog-foot .btn', 'Substituir', true);
    }
    await waitText('.toast', 'Enviado: upload-e2e.txt');
    await sleep(300);
  }
  assert(readSb('data', 'upload-e2e.txt').includes('enviado pelo teste'), 'upload não gravou');
});

// ------------------------------------------------ arrastar pastas: Windows ⇄ servidor
// O arrasto do sistema é simulado pelo protocolo do navegador (CDP) com caminhos REAIS do disco:
// pasta solta chega ao app como entrada de diretório, igual ao Windows Explorer.
const dropSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-drop-'));
const dropPasta = path.join(dropSrc, 'minha-pasta');
fs.mkdirSync(path.join(dropPasta, 'sub', 'fundo'), { recursive: true });
fs.mkdirSync(path.join(dropPasta, 'vazia'));
fs.writeFileSync(path.join(dropPasta, 'a.txt'), 'A\n');
fs.writeFileSync(path.join(dropPasta, 'sub', 'b.txt'), 'B\n');
fs.writeFileSync(path.join(dropPasta, 'sub', 'fundo', 'c.txt'), 'C\n');
fs.writeFileSync(path.join(dropPasta, 'nome com espaço e açúcar.txt'), 'acentuado\n');
fs.writeFileSync(path.join(dropSrc, 'solto.txt'), 'solto\n');
fs.mkdirSync(path.join(dropSrc, 'outra'));
fs.writeFileSync(path.join(dropSrc, 'outra', 'x.txt'), 'X\n');
const untilDisk = async (fn, label, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fn()) return;
    } catch {
      /* ainda não existe */
    }
    await sleep(100);
  }
  throw new Error(`no disco: ${label}`);
};

await step('Explorador: soltar arquivo e pasta do Windows (subpastas, vazia e acentos)', async () => {
  await h.dropOs(await h.rowPoint('README.md'), [path.join(dropSrc, 'solto.txt')]);
  await untilDisk(() => exists('solto.txt'), 'solto.txt');
  assert(readSb('solto.txt') === 'solto\n', 'arquivo solto veio errado');
  await h.dropOs(await h.rowPoint('README.md'), [dropPasta]);
  await waitText('.toast', 'Enviado: minha-pasta — 4 arquivos');
  assert(readSb('minha-pasta', 'a.txt') === 'A\n' && readSb('minha-pasta', 'sub', 'b.txt') === 'B\n' && readSb('minha-pasta', 'sub', 'fundo', 'c.txt') === 'C\n', 'arquivos da pasta soltos não bateram');
  assert(readSb('minha-pasta', 'nome com espaço e açúcar.txt') === 'acentuado\n', 'nome com acento/espaço');
  assert(fs.statSync(path.join(sandbox, 'minha-pasta', 'vazia')).isDirectory(), 'a pasta vazia não foi criada');
  await findTreeRow('minha-pasta'); // a árvore já mostra o que chegou
  await shot('pasta-soltada');
});

await step('Explorador: pasta que já existe pergunta uma vez (pular existentes, cancelar, substituir)', async () => {
  fs.writeFileSync(path.join(dropPasta, 'a.txt'), 'A2\n');
  fs.writeFileSync(path.join(dropPasta, 'd.txt'), 'D\n');
  await h.dropOs(await h.rowPoint('README.md'), [dropPasta]);
  await waitText('.dialog .dialog-head', '4 arquivos já existem');
  assert((await page.$eval('.dialog .dialog-body', (e) => e.textContent)).includes('a.txt'), 'o aviso não lista os arquivos que já existem');
  await clickText('.dialog .dialog-foot .btn', 'Pular existentes');
  await untilDisk(() => exists('minha-pasta', 'd.txt'), 'd.txt (arquivo novo) enviado');
  await sleep(300);
  assert(readSb('minha-pasta', 'a.txt') === 'A\n', 'pular existentes não deveria trocar o a.txt');
  // Cancelar não envia nada.
  fs.writeFileSync(path.join(dropPasta, 'a.txt'), 'A3\n');
  fs.writeFileSync(path.join(dropPasta, 'e.txt'), 'E\n');
  await h.dropOs(await h.rowPoint('README.md'), [dropPasta]);
  await waitText('.dialog .dialog-head', 'já existem');
  await clickText('.dialog .dialog-foot .btn', 'Cancelar');
  await sleep(600);
  assert(!exists('minha-pasta', 'e.txt') && readSb('minha-pasta', 'a.txt') === 'A\n', 'cancelar não deveria enviar nada');
  // Substituir troca só o conteúdo dos existentes e completa o resto.
  await h.dropOs(await h.rowPoint('README.md'), [dropPasta]);
  await waitText('.dialog .dialog-head', 'já existem');
  await clickText('.dialog .dialog-foot .btn', 'Substituir', true);
  await untilDisk(() => exists('minha-pasta', 'e.txt') && readSb('minha-pasta', 'a.txt') === 'A3\n', 'substituir aplicado');
});

await step('Soltar .zip no espaço vazio do explorador ou fora dele envia (nunca abre "Salvar como"/download)', async () => {
  const zipSrc = path.join(dropSrc, 'pacote.zip');
  fs.writeFileSync(zipSrc, Buffer.from('504b0506000000000000000000000000000000000000', 'hex')); // zip vazio válido
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-nodl-'));
  const cdp = await page.browser().target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  const urlBefore = page.url();
  // 1) espaço vazio abaixo da árvore → pasta principal, direto.
  const fill = await page.$('.sidebar .explorer-fill');
  assert(fill, 'sem área livre abaixo da árvore');
  const fb = await fill.boundingBox();
  await h.dropOs({ x: fb.x + 40, y: fb.y + Math.min(20, fb.height / 2) }, [zipSrc]);
  await untilDisk(() => exists('pacote.zip'), 'pacote.zip na pasta principal');
  fs.rmSync(path.join(sandbox, 'pacote.zip'));
  // 2) em cima da conversa (fora do explorador) → pergunta e envia para a pasta principal.
  const chat = await (await page.$('.chat-header')).boundingBox();
  await h.dropOs({ x: chat.x + chat.width / 2, y: chat.y + chat.height + 60 }, [zipSrc]);
  await waitText('.dialog .dialog-head', 'Enviar pacote.zip para');
  await clickText('.dialog .dialog-foot .btn', 'Enviar', true);
  await untilDisk(() => exists('pacote.zip'), 'pacote.zip enviado a partir da conversa');
  await sleep(800);
  assert(page.url() === urlBefore, `a página navegou para o arquivo: ${page.url()}`);
  assert(fs.readdirSync(dlDir).length === 0, `o navegador baixou em vez de enviar: ${fs.readdirSync(dlDir).join(', ')}`);
  await cdp.detach().catch(() => {});
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, 'pacote.zip'), { force: true });
});

await step('Explorador: soltar pasta sobre uma pasta do explorador envia para dentro dela', async () => {
  await h.dropOs(await h.rowPoint('data'), [path.join(dropSrc, 'outra')]);
  await untilDisk(() => exists('data', 'outra', 'x.txt'), 'data/outra/x.txt');
  assert(!exists('outra'), 'a pasta foi para a raiz em vez de ir para dentro de data/');
  await findTreeRow('outra'); // a pasta de destino abriu e mostra a novidade
});

await step('Explorador: "Enviar pasta para cá…" (seletor de pasta) e menu da raiz', async () => {
  fs.mkdirSync(path.join(dropSrc, 'pelo-seletor', 'interna'), { recursive: true });
  fs.writeFileSync(path.join(dropSrc, 'pelo-seletor', 'interna', 'y.txt'), 'Y\n');
  fs.writeFileSync(path.join(dropSrc, 'pelo-seletor', 'z.txt'), 'Z\n');
  const row = await findTreeRow('data');
  await row.click({ button: 'right' });
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), menu('Enviar pasta para cá')]);
  await chooser.accept([path.join(dropSrc, 'pelo-seletor')]);
  await untilDisk(() => exists('data', 'pelo-seletor', 'interna', 'y.txt') && exists('data', 'pelo-seletor', 'z.txt'), 'pasta enviada pelo seletor');
});

await step('Explorador: baixar arquivo e pasta (.zip) pelo menu', async () => {
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-dl-'));
  const cdp = await page.browser().target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  const done = (name) => () => fs.existsSync(path.join(dlDir, name)) && !fs.readdirSync(dlDir).some((f) => f.endsWith('.crdownload'));
  await (await findTreeRow('solto.txt')).click({ button: 'right' });
  await menu('Baixar');
  await untilDisk(done('solto.txt'), 'download de solto.txt');
  assert(fs.readFileSync(path.join(dlDir, 'solto.txt'), 'utf8') === 'solto\n', 'arquivo baixado veio errado');
  await (await findTreeRow('minha-pasta')).click({ button: 'right' });
  await menu('Baixar pasta (.zip)');
  await untilDisk(done('minha-pasta.zip'), 'download de minha-pasta.zip');
  const es = readZipEntries(fs.readFileSync(path.join(dlDir, 'minha-pasta.zip')));
  const names = es.map((e) => e.name).sort();
  for (const n of ['minha-pasta/', 'minha-pasta/a.txt', 'minha-pasta/sub/', 'minha-pasta/sub/fundo/c.txt', 'minha-pasta/vazia/', 'minha-pasta/nome com espaço e açúcar.txt'])
    assert(names.includes(n), `o zip não tem ${n}: ${names.join(', ')}`);
  assert(es.every((e) => e.ok), 'CRC ou tamanho de alguma entrada do zip não bate');
  assert(es.find((e) => e.name === 'minha-pasta/a.txt').data.toString() === 'A3\n', 'conteúdo de a.txt no zip');
  await cdp.detach().catch(() => {});
  fs.rmSync(dlDir, { recursive: true, force: true });
});

await step('Explorador: arrastar para fora do app (link de download que o Windows Explorer usa)', async () => {
  const origin = `http://127.0.0.1:${env.port}`;
  const linkOf = (items) => {
    const it = items.find((i) => i.type.toLowerCase() === 'downloadurl');
    assert(it, `o arrasto não trouxe DownloadURL: ${JSON.stringify(items.map((i) => i.type))}`);
    const [mime, name, ...rest] = it.data.split(':');
    return { mime, name, url: rest.join(':') };
  };
  const pasta = linkOf(await h.dragOutOf('minha-pasta'));
  assert(pasta.mime === 'application/zip' && pasta.name === 'minha-pasta.zip' && pasta.url.startsWith(origin + '/dl/'), `link da pasta: ${JSON.stringify(pasta)}`);
  // O Windows busca o link sozinho, sem o cookie do app: o bilhete tem que bastar.
  const r = await fetch(pasta.url);
  assert(r.status === 200 && /zip/.test(r.headers.get('content-type') ?? ''), `GET do link da pasta: ${r.status}`);
  const es = readZipEntries(Buffer.from(await r.arrayBuffer()));
  assert(es.some((e) => e.name === 'minha-pasta/sub/fundo/c.txt') && es.every((e) => e.ok), 'zip do link inválido');
  const arq = linkOf(await h.dragOutOf('solto.txt'));
  assert(arq.mime === 'application/octet-stream' && arq.name === 'solto.txt', `link do arquivo: ${JSON.stringify(arq)}`);
  const r2 = await fetch(arq.url);
  assert(r2.status === 200 && (await r2.text()) === 'solto\n', 'GET do link do arquivo');
  // Bilhete inventado e API sem cookie continuam barrados.
  assert((await fetch(`${origin}/dl/${'0'.repeat(32)}/x`)).status === 404, 'bilhete inventado deveria dar 404');
  assert((await fetch(`${origin}/api/zip?h=local&p=${encodeURIComponent(sandbox)}`)).status === 401, '/api/zip sem cookie deveria dar 401');
});

await step('Explorador: limpeza dos itens de teste do arrasto', async () => {
  for (const p of [['minha-pasta'], ['solto.txt'], ['data', 'outra'], ['data', 'pelo-seletor']]) fs.rmSync(path.join(sandbox, ...p), { recursive: true, force: true });
  fs.rmSync(dropSrc, { recursive: true, force: true });
  await page.click('.section-head button[title="Atualizar"]');
  await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'minha-pasta'), 5000, 'árvore atualizada');
});

await step('Explorador: arrastar uma linha para outra pasta move (arquivo, pasta, aba aberta) e nunca sobrescreve', async () => {
  const sb = (...p) => path.join(sandbox, ...p);
  const atualizar = () => page.click('.section-head button[title="Atualizar"]');
  fs.mkdirSync(sb('mv-a-origem', 'mv-pasta', 'fundo'), { recursive: true });
  fs.mkdirSync(sb('mv-b-destino'));
  fs.writeFileSync(sb('mv-a-origem', 'mv-arq.txt'), 'ARQ\n');
  fs.writeFileSync(sb('mv-a-origem', 'mv-aberto.txt'), 'ABERTO\n');
  fs.writeFileSync(sb('mv-a-origem', 'mv-pasta', 'in.txt'), 'IN\n');
  fs.writeFileSync(sb('mv-a-origem', 'mv-pasta', 'fundo', 'deep.txt'), 'DEEP\n');
  await atualizar();
  await clickTree('mv-a-origem'); // abre a pasta de origem
  await findTreeRow('mv-arq.txt');

  // 1) Arquivo solto sobre uma pasta: vai para dentro dela.
  await h.dragRowTo('mv-arq.txt', await h.rowPoint('mv-b-destino'));
  await waitText('.toast', 'Movido: mv-arq.txt → mv-b-destino');
  assert(readSb('mv-b-destino', 'mv-arq.txt') === 'ARQ\n' && !exists('mv-a-origem', 'mv-arq.txt'), 'o arquivo não foi movido no disco');
  await shot('mover-arquivo');

  // 2) Arquivo aberto numa aba: a aba segue o arquivo para o caminho novo.
  await clickTree('mv-aberto.txt');
  await waitActiveFile('mv-aberto.txt');
  await h.dragRowTo('mv-aberto.txt', await h.rowPoint('mv-b-destino'));
  await waitText('.toast', 'Movido: mv-aberto.txt → mv-b-destino');
  assert(readSb('mv-b-destino', 'mv-aberto.txt') === 'ABERTO\n' && !exists('mv-a-origem', 'mv-aberto.txt'), 'o arquivo aberto não foi movido');
  await waitActiveFile('mv-aberto.txt');
  await waitFor(() => document.querySelector('.editor-panel .tab.active')?.title.includes('mv-b-destino'), 8000, 'a aba aponta para o caminho novo');

  // 3) Pasta inteira, com subpastas.
  await h.dragRowTo('mv-pasta', await h.rowPoint('mv-b-destino'));
  await waitText('.toast', 'Movido: mv-pasta → mv-b-destino');
  assert(readSb('mv-b-destino', 'mv-pasta', 'fundo', 'deep.txt') === 'DEEP\n' && readSb('mv-b-destino', 'mv-pasta', 'in.txt') === 'IN\n' && !exists('mv-a-origem', 'mv-pasta'), 'a pasta não foi movida inteira');

  // 4) Já existe o mesmo nome no destino: avisa e não mexe em nada.
  fs.writeFileSync(sb('mv-a-origem', 'mv-arq.txt'), 'NOVO\n');
  await atualizar();
  await findTreeRow('mv-arq.txt');
  await h.dragRowTo('mv-arq.txt', await h.rowPoint('mv-b-destino')); // a primeira linha "mv-arq.txt" é a da origem
  await waitText('.toast', 'Já existe "mv-arq.txt"');
  assert(readSb('mv-a-origem', 'mv-arq.txt') === 'NOVO\n' && readSb('mv-b-destino', 'mv-arq.txt') === 'ARQ\n', 'conflito não deveria trocar nenhum dos dois');

  // 5) Pasta solta dentro dela mesma (em uma subpasta sua): nada acontece.
  await h.dragRowTo('mv-b-destino', await h.rowPoint('mv-pasta'));
  await sleep(700);
  assert(exists('mv-b-destino', 'mv-pasta', 'in.txt') && !exists('mv-b-destino', 'mv-pasta', 'mv-b-destino'), 'a pasta foi movida para dentro dela mesma');

  // 6) Espaço vazio abaixo da árvore: vai para a pasta principal.
  const fill = await (await page.$('.sidebar .explorer-fill')).boundingBox();
  await h.dragRowTo('mv-pasta', { x: fill.x + 40, y: fill.y + Math.min(20, fill.height / 2) });
  await waitText('.toast', `Movido: mv-pasta → ${path.basename(sandbox)}`);
  assert(readSb('mv-pasta', 'fundo', 'deep.txt') === 'DEEP\n' && !exists('mv-b-destino', 'mv-pasta'), 'a pasta não foi para a raiz');

  // 7) Sem arrastar: "Mover para…" no menu abre o seletor de pastas.
  fs.writeFileSync(sb('mv-menu.txt'), 'MENU\n');
  await atualizar();
  await (await findTreeRow('mv-menu.txt')).click({ button: 'right' });
  await menu('Mover para…');
  await waitText('.dialog .dialog-head', 'Mover mv-menu.txt para');
  await waitText('.dialog', 'Já está nesta pasta'); // começa na pasta do próprio arquivo: não deixa confirmar
  assert(await page.$eval('.dialog .dialog-foot .btn:not(.secondary)', (b) => b.disabled), 'mover para a pasta onde já está deveria estar desabilitado');
  await page.focus('.dialog input.input');
  await hotkey('Control', 'a');
  await page.keyboard.type(sb('mv-a-origem'));
  await page.keyboard.press('Enter');
  await waitFor(() => !document.querySelector('.dialog .dialog-foot .btn:not(.secondary)')?.disabled, 5000, 'botão de mover habilitado');
  await clickText('.dialog .dialog-foot .btn', 'Mover para esta pasta');
  await waitText('.toast', 'Movido: mv-menu.txt → mv-a-origem');
  assert(readSb('mv-a-origem', 'mv-menu.txt') === 'MENU\n' && !exists('mv-menu.txt'), 'o menu não moveu o arquivo');

  for (const p of ['mv-a-origem', 'mv-b-destino', 'mv-pasta']) fs.rmSync(sb(p), { recursive: true, force: true });
  await atualizar();
  await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent.startsWith('mv-')), 5000, 'árvore sem os itens de teste');
});

await step('Explorador: mencionar arquivo na conversa', async () => {
  await clearComposer();
  const row = await findTreeRow('config.json');
  await row.click({ button: 'right' });
  await menu('Mencionar na conversa');
  await waitFor(() => document.querySelector('.composer textarea')?.value.includes('@data/config.json'), 3000, 'menção no composer');
  await clearComposer();
});

await step('Explorador: pasta extra fixada (peek em outro caminho sem trocar o workspace)', async () => {
  // Pasta bem fora do workspace (como espiar /tmp com a conversa aberta em ~/smart-ia).
  const peekDir = path.join(uploads, 'peek-extra');
  const titleBeforePeek = await page.evaluate(() => document.title);
  fs.mkdirSync(peekDir, { recursive: true });
  fs.writeFileSync(path.join(peekDir, 'so-aqui.txt'), 'só existe na pasta extra fixada\n');

  assert((await page.$$('.section-head')).length === 1, 'esperava só a raiz do workspace antes de fixar');
  await page.click('.section-head', { button: 'right' });
  await menu('Adicionar pasta ao explorador');
  await waitText('.dialog-head', 'Adicionar pasta ao explorador');
  const input = await page.$('.dialog.wide input.input');
  await input.click();
  await hotkey('Control', 'a');
  await page.keyboard.type(peekDir);
  await page.keyboard.press('Enter');
  await waitFor((base) => document.querySelector('.dialog.wide .hint')?.textContent.includes(base), 5000, 'caminho digitado resolvido', path.basename(peekDir));
  await waitFor(() => !document.querySelector('.dialog-foot .btn:not(.secondary)')?.disabled, 5000, 'botão "Adicionar esta pasta" habilitado (caminho válido)');
  await clickText('.dialog-foot .btn', 'Adicionar esta pasta', true);

  await waitFor(() => document.querySelectorAll('.section-head').length === 2, 5000, 'segunda raiz apareceu no explorador');
  await findTreeRow('so-aqui.txt'); // nome único: só existe na pasta fixada, sem ambiguidade
  await findTreeRow('README.md'); // a raiz do workspace continua listada, sem trocar
  const mainRootLabel = await page.evaluate(() => document.querySelectorAll('.section-head')[0]?.querySelector('.grow')?.textContent);
  assert(!mainRootLabel.includes('peek-extra'), `a raiz principal do explorador mudou: ${mainRootLabel}`);
  assert((await page.evaluate(() => document.title)) === titleBeforePeek, 'visualizar arquivos de outra pasta mudou o título/contexto da janela');
  await shot('explorador-pasta-extra');

  // Minimizar uma pasta aberta (clique no título ou no chevron esconde todo o conteúdo)
  let heads = await page.$$('.section-head');
  assert(await heads[0].$('button[title="Abrir outra pasta…"]'), 'botão de abrir outra pasta no cabeçalho');
  assert(await heads[0].$('button[title="Adicionar pasta ao explorador…"]'), 'botão de adicionar pasta no cabeçalho');

  // Minimiza a pasta extra fixada: o arquivo some da visão
  await (await heads[1].$('.grow')).click();
  await waitFor(() => !document.querySelector('.sidebar .tree-row .label') || ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'so-aqui.txt'), 3000, 'pasta extra minimizada');
  // Expande de volta com outro clique
  await (await heads[1].$('.grow')).click();
  await findTreeRow('so-aqui.txt');

  // Minimiza a pasta principal: o README.md some da visão
  await (await heads[0].$('.grow')).click();
  await waitFor(() => !document.querySelector('.sidebar .tree-row .label') || ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'README.md'), 3000, 'pasta principal minimizada');
  // Expande de volta
  await (await heads[0].$('.grow')).click();
  await findTreeRow('README.md');

  // Some pelo botão de remover: volta a só ter a raiz do workspace.
  heads = await page.$$('.section-head');
  assert(heads.length === 2, `esperava 2 raízes fixadas, achei ${heads.length}`);
  await (await heads[1].$('button[title="Remover do explorador"]')).click();
  await waitFor(() => document.querySelectorAll('.section-head').length === 1, 5000, 'pasta extra removida');
  await findTreeRow('README.md');
});

await step('Ctrl+P abre arquivo por nome', async () => {
  await page.click('.chat-header');
  await hotkey('Control', 'p');
  await waitText('.quickpick .qp-title', 'Abrir arquivo');
  await waitFor(() => document.querySelectorAll('.quickpick .qp-item').length > 5, 10000, 'lista de arquivos');
  await page.keyboard.type('eventos');
  await waitText('.quickpick .qp-item.active .label', 'eventos.jsonl');
  await page.keyboard.press('Enter');
  await waitActiveFile('eventos.jsonl');
});

await step('Paleta de comandos: tema claro e escuro', async () => {
  await hotkey('Control', 'Shift', 'P');
  await waitText('.quickpick .qp-title', 'Comandos');
  await page.keyboard.type('tema claro');
  await page.keyboard.press('Enter');
  await waitFor(() => document.documentElement.dataset.theme === 'light', 3000, 'tema claro');
  await clickTree('README.md');
  await sleep(400);
  await shot('tema-claro');
  await hotkey('Control', 'Shift', 'P');
  await page.keyboard.type('tema escuro');
  await page.keyboard.press('Enter');
  await waitFor(() => document.documentElement.dataset.theme === 'dark', 3000, 'tema escuro');
});

await step('Explorador: filtro ao vivo na árvore (mostra e abre só o que bate)', async () => {
  await findTreeRow('README.md');
  // Recolhe tudo primeiro: prova que o filtro força a abertura, não só aproveita o que já
  // estava aberto de passos anteriores.
  await page.click('.sidebar .icon-btn[title="Recolher tudo"]');
  await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'app.ts'), 3000, 'árvore recolhida (app.ts escondido dentro de src/)');

  const filterInput = await page.$('.sidebar .search-box input[placeholder="Filtrar arquivos"]');
  assert(filterInput, 'campo de filtro do explorador não encontrado');
  await filterInput.click();
  await page.keyboard.type('app.ts');
  await waitFor(() => [...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'app.ts'), 5000, 'app.ts apareceu com a pasta "src" aberta sozinha pelo filtro');
  await waitFor(() => [...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'src'), 3000, 'pasta "src" (ancestral do resultado) visível');
  await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'README.md'), 3000, 'README.md escondido pelo filtro (não bate)');
  await waitFor(() => ![...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === 'novo.txt'), 3000, 'novo.txt escondido pelo filtro');
  await shot('explorador-filtro');

  // Limpa o filtro: a árvore volta ao normal.
  await page.click('.sidebar .search-box button[title="Limpar filtro"]');
  await findTreeRow('README.md');
  await findTreeRow('novo.txt');
});

await step('Busca em arquivos (Ctrl+Shift+F): resultado, destaque e abrir na linha certa', async () => {
  await hotkey('Control', 'Shift', 'F');
  await waitText('.side-title', 'Buscar em arquivos');
  const input = await page.$('.sidebar .search-box input[placeholder="Buscar em arquivos"]');
  assert(input, 'campo de busca por conteúdo não encontrado');
  await input.click();
  await page.keyboard.type('descrever'); // só existe em src/app.ts (fixture de teste), 2 linhas
  await waitFor(() => [...document.querySelectorAll('.sidebar .search-hl')].some((e) => e.textContent === 'descrever'), 8000, 'trecho "descrever" destacado no resultado');
  await waitText('.sidebar .tree-empty', 'ocorrências em 1 arquivo');
  await shot('busca-conteudo');

  // Clicar num botão de alternar tira o foco do campo: antes de digitar de novo, volta para ele
  // e seleciona tudo (senão o Ctrl+A/texto vão para o botão e a busca não muda).
  const caseBtn = '.sidebar .icon-btn[title="Diferenciar maiúsculas/minúsculas"]';
  const regexBtn = '.sidebar .icon-btn[title="Usar expressão regular"]';
  const retype = async (text) => {
    await page.click('.sidebar .search-box input');
    await hotkey('Control', 'a');
    await page.keyboard.type(text);
  };

  // "Diferenciar maiúsculas": DESCREVER só bate quando o botão está desligado.
  await retype('DESCREVER');
  await waitText('.sidebar .tree-empty', 'ocorrências em 1 arquivo');
  await page.click(caseBtn);
  await waitFor((s) => document.querySelector(s)?.classList.contains('on'), 3000, 'botão de maiúsculas/minúsculas ligado', caseBtn);
  await waitText('.sidebar .tree-empty', 'Nada encontrado');
  await page.click(caseBtn);
  await waitText('.sidebar .tree-empty', 'ocorrências em 1 arquivo');

  // "Usar expressão regular": "desc.ever" só bate em "descrever" quando "." vira curinga.
  await retype('desc.ever');
  await waitText('.sidebar .tree-empty', 'Nada encontrado');
  await page.click(regexBtn);
  await waitFor(() => [...document.querySelectorAll('.sidebar .search-hl')].some((e) => e.textContent === 'descrever'), 5000, 'regex "desc.ever" bateu com "descrever"');
  // Regex inválida: mostra o erro em vez de quebrar ou ficar carregando.
  await retype('(');
  await waitText('.sidebar .tree-empty', 'Expressão regular inválida');
  await page.click(regexBtn);

  // Erro de regex inválida também no servidor (o campo acima só chega nele com o botão ligado).
  const badRegexErr = await h.rpc('fs.search', { h: 'local', root: sandbox, query: '(', caseSensitive: false, regex: true, limit: 10 }).then(() => null, (e) => e.message);
  assert(badRegexErr && badRegexErr.includes('Expressão regular inválida'), `regex inválida deveria ser recusada pelo servidor: ${badRegexErr}`);

  // Volta à busca simples e abre a 1ª ocorrência: precisa cair certinho na linha 8 do arquivo.
  await retype('descrever');
  await waitFor(() => [...document.querySelectorAll('.sidebar .search-hl')].some((e) => e.textContent === 'descrever'), 5000, 'resultado da busca simples de volta');
  await clickText('.sidebar .tree-row .label', 'export function descrever');
  await waitActiveFile('app.ts');
  await waitFor(() => document.querySelector('.editor-panel .cm-activeLineGutter')?.textContent.trim() === '8', 5000, 'cursor na linha 8 (1ª ocorrência de "descrever")');
});

await step('Configurações (Ctrl+,) e fonte do chat', async () => {
  await hotkey('Control', ',');
  await waitText('.settings h3', 'Aparência');
  await shot('configuracoes');
  const inputs = await page.$$('.settings input[type=number]');
  await inputs[1].click();
  await hotkey('Control', 'a');
  await page.keyboard.type('15');
  await waitFor(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-font-size').trim() === '15px', 3000, 'fonte 15px');
  await hotkey('Control', 'a');
  await page.keyboard.type('14');
  await waitFor(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-font-size').trim() === '14px', 3000, 'fonte 14px');

  // Modelo padrão: select com os modelos que o CLI informou (gravados para existirem já ao abrir o app).
  const modelOpts = await page.$$eval('.settings select.model-select option', (os) => os.map((o) => o.textContent.trim()));
  assert(modelOpts[0] === 'Padrão de cada servidor' && modelOpts.includes('Fake Opus') && modelOpts.includes('Fake Sonnet'), `opções do modelo padrão: ${modelOpts.join(' | ')}`);
  assert(!modelOpts.includes('Padrão'), 'o modelo "default" do CLI não deveria repetir a opção padrão');
  const settingsFile = path.join(env.dataDir, 'settings.json');
  const savedModel = async (want) => {
    for (let i = 0; i < 30; i++) {
      if (JSON.parse(fs.readFileSync(settingsFile, 'utf8')).defaultModel === want) return;
      await sleep(100);
    }
    throw new Error(`defaultModel não virou "${want}" no settings.json`);
  };
  await page.select('.settings select.model-select', 'fake-sonnet');
  await savedModel('fake-sonnet');
  await page.select('.settings select.model-select', '');
  await savedModel('');
  const savedCaps = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'hosts.json'), 'utf8')).caps?.local?.models ?? [];
  assert(savedCaps.some((m) => m.value === 'fake-opus'), 'lista de modelos não foi gravada no hosts.json');
});

await step('Servidores: lista, novo servidor, testar todos', async () => {
  await page.click('.act-btn[title="Servidores"]');
  await waitText('.sidebar .tree-row .label', 'exemplo-web');
  await waitText('.sidebar .tree-row .label', 'cliente prod');
  await clickText('.sidebar .btn', 'Novo servidor SSH');
  await page.waitForSelector('.dialog .field input', { timeout: 3000 });
  const inputs = await page.$$('.dialog .field input');
  await inputs[0].type('novo-e2e');
  await inputs[1].type('192.0.2.50');
  await shot('novo-servidor');
  await clickText('.dialog .dialog-foot .btn', 'Adicionar', true);
  await waitText('.toast', 'adicionado ao ~/.ssh/config');
  const cfg = fs.readFileSync(path.join(sshDir, 'config'), 'utf8');
  assert(/Host novo-e2e\s+HostName 192\.0\.2\.50/.test(cfg), 'bloco não foi gravado no config');
  assert(fs.existsSync(path.join(sshDir, 'config.claude-deck.bak')), 'sem cópia de segurança do config');
  await clickText('.sidebar .btn', 'Testar todos');
  await waitText('.toast', 'Teste concluído', 60000);
  assert((await count('.check-table tr')) === 3, 'tabela do teste deveria ter 3 servidores');
  await shot('servidores-teste');

  // Filtro por pasta recente: busca por caminho acha o servidor e já abre mostrando a pasta
  await h.rpc('hosts.addRecent', { id: 'exemplo-web', folder: '/var/www/meu-site-e2e' });
  const searchInput = await page.$('.sidebar .search-box input');
  assert(searchInput, 'campo de busca de servidores não encontrado');
  await searchInput.click();
  await page.keyboard.type('meu-site-e2e');
  await waitText('.sidebar .tree-row .label', 'exemplo-web');
  await waitText('.sidebar .tree-row .label', 'meu-site-e2e');
  await hotkey('Control', 'a');
  await page.keyboard.press('Backspace');
});

await step('Fechar conversa trabalhando pede confirmação', async () => {
  await hotkey('Control', 'Shift', 'E');
  await send('slow');
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  const n = await chatTabs();
  await hotkey('Control', 'Shift', 'W');
  await waitText('.dialog .dialog-head', 'Fechar conversa em andamento?');
  await clickText('.dialog .dialog-foot .btn', 'Cancelar', true);
  assert((await chatTabs()) === n, 'a aba fechou mesmo cancelando');
  await page.focus('.composer textarea');
  await page.keyboard.press('Escape');
  await waitIdle();
});

await step('Claude cai (crash) e a próxima mensagem retoma', async () => {
  await send('crash');
  await waitText('.notice', 'encerrou', 10000);
  await send('echo voltei');
  await waitText('.msg .md', 'voltei', 20000);
  await waitIdle();
});

await step('Fechar aba de conversa', async () => {
  const n = await chatTabs();
  await page.click('.center .tabs .tab.active .close');
  await waitFor((k) => document.querySelectorAll('.center .tabs .tab').length === k - 1, 5000, 'aba fechada', n);
  await shot('final');
});

await step('Uma janela por servidor+pasta: outra pasta ganha janela própria; a mesma pasta só vem para a frente', async () => {
  const tabsBefore = await chatTabs();
  const wid1 = await page.evaluate(() => sessionStorage.getItem('deck.wid'));
  assert(wid1, 'a janela principal não tem id de janela');

  // 1. A pasta da janela principal já tem janela: pedir de novo só a traz para a frente.
  const same = await h.rpc('window.open', { hostId: 'local', folder: sandbox });
  assert(same.wid === wid1 && !same.url && same.launched === false, `mesma pasta deveria focar a janela aberta: ${JSON.stringify(same)}`);

  // 2. O atalho clicado com o app aberto abre uma janela NOVA e vazia, sem servidor (pedido de 01/10), e não
  //    mexe na janela aberta. O launcher abre /auth?c=…#nova (o fragmento passa pelo redirecionamento do /auth);
  //    sem o #nova (servidor recém-trocado, página aberta à mão) o resultado é o mesmo.
  const tokenAtalho = fs.readFileSync(path.join(env.dataDir, 'token'), 'utf8').trim();
  const launchCode = async () => (await (await fetch(`http://127.0.0.1:${env.port}/launch`, { method: 'POST', headers: { 'x-deck-token': tokenAtalho } })).json()).code;
  for (const how of ['#nova', '']) {
    const fresh = await env.browser.newPage();
    try {
      await fresh.goto(`http://127.0.0.1:${env.port}/auth?c=${await launchCode()}${how}`, { waitUntil: 'networkidle2' });
      const hf = helpers(fresh);
      await hf.waitFor(() => !!sessionStorage.getItem('deck.wid'), 15000, `id da janela nova (${how || 'sem #nova'})`);
      const freshWid = await fresh.evaluate(() => sessionStorage.getItem('deck.wid'));
      assert(freshWid !== wid1, `o atalho (${how || 'sem #nova'}) com o app aberto não abriu janela nova: ficou com a ${freshWid}`);
      assert(new URL(fresh.url()).hash === '', `o #nova deveria sair da URL: ${fresh.url()}`);
      await sleep(800); // a janela nova grava o estado dela
      assert(!fresh.isClosed(), 'a janela nova do atalho se fechou sozinha');
      assert((await hf.chatTabs()) === 0, 'a janela nova do atalho deveria vir vazia');
      const rec = (await h.rpc('test.windows'))[freshWid];
      assert(rec && !rec.hostId && !rec.contextCwd, `a janela nova do atalho não deveria ter servidor/pasta: ${JSON.stringify(rec)}`);
      // Vazia de verdade: fechada sem uso, o servidor a descarta (não acumula janela fantasma para reabrir).
      assert(!rec.state.chatTabs?.length && !rec.state.fileTabs?.length && !rec.state.workspace, `a janela nova do atalho não está vazia: ${JSON.stringify(rec.state)}`);
      assert((await chatTabs()) === tabsBefore, 'a janela principal perdeu abas com o atalho');
    } finally {
      await fresh.close().catch(() => {});
    }
  }

  // 3. Outra pasta do mesmo computador: janela própria, que já abre com uma conversa nela.
  const r = await h.rpc('window.open', { hostId: 'local', folder: uploads });
  assert(r.url && r.launched === false, `outra pasta deveria abrir janela nova: ${JSON.stringify(r)}`);
  const page2 = await env.browser.newPage();
  try {
    const h2 = helpers(page2);
    await page2.goto(r.url, { waitUntil: 'networkidle2' });
    await page2.waitForSelector('.app .chat-header', { timeout: 15000 });
    await h2.waitIdle();
    const wid2 = await page2.evaluate(() => sessionStorage.getItem('deck.wid'));
    assert(wid2 && wid2 !== wid1, `a pasta nova deveria ter janela própria (${wid1} x ${wid2})`);
    assert((await h2.chatTabs()) === 1, 'a janela da pasta nova deveria ter 1 conversa');
    assert(new URL(page2.url()).search === '', `o ?open= deveria sair da URL: ${page2.url()}`);
    await sleep(500); // dá tempo de um evento vazar para a outra janela, se vazasse
    assert((await chatTabs()) === tabsBefore, `a conversa da janela nova apareceu na principal (${tabsBefore} → ${await chatTabs()})`);
    const mine = (await h.rpc('sessions.list')).filter((s) => s.wid === wid2);
    assert(mine.length === 1 && mine[0].cwd === uploads, `conversa da janela nova: ${JSON.stringify(mine.map((s) => s.cwd))}`);
    savedSecondWindow = { wid: wid2, sid: mine[0].sid, cwd: mine[0].cwd };
    await page2.screenshot({ path: path.join(SHOTS, 'janela-2.png') });

    // 4. Pedir de novo a pasta nova (duplo clique, barra no fim) devolve a janela aberta, sem abrir outra.
    const again = await h.rpc('window.open', { hostId: 'local', folder: uploads + path.sep });
    assert(again.wid === wid2 && !again.url, `segundo pedido da mesma pasta abriu outra janela: ${JSON.stringify(again)}`);

    // 5. Nesta janela, conversa na pasta da OUTRA janela não fica aqui: vai para a janela dela.
    const nSandbox = (await h.rpc('sessions.list')).filter((s) => s.cwd === sandbox).length;
    await page2.bringToFront();
    await h2.hotkey('Control', 'Shift', 'N');
    await h2.waitText('.quickpick .qp-title', 'escolha o servidor');
    await h2.waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor');
    await page2.keyboard.press('Enter');
    await h2.waitText('.quickpick .qp-title', 'escolha a pasta');
    await h2.waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor de pasta');
    await page2.keyboard.type(sandbox);
    await page2.keyboard.press('Enter');
    await sleep(800);
    assert((await h2.chatTabs()) === 1, 'a conversa de outra pasta foi aberta nesta janela');
    assert((await h.rpc('sessions.list')).filter((s) => s.cwd === sandbox).length === nSandbox, 'criou conversa da outra pasta fora da janela dela');
    assert((await chatTabs()) === tabsBefore, 'a janela da outra pasta ganhou aba sem pedir');

    // 6. Recarregar mantém a janela e a aba dela.
    await page2.reload({ waitUntil: 'networkidle2' });
    await page2.waitForSelector('.app .chat-header', { timeout: 15000 });
    assert((await page2.evaluate(() => sessionStorage.getItem('deck.wid'))) === wid2, 'o id da janela mudou ao recarregar');
    assert((await h2.chatTabs()) === 1, 'recarregar a janela nova perdeu a aba dela');
    assert((await chatTabs()) === tabsBefore, 'recarregar a janela nova mexeu na principal');
  } finally {
    await page2.close().catch(() => {});
  }
  assert((await chatTabs()) === tabsBefore, 'fechar a janela nova mexeu na principal');
});

await step('Servidores: clicar no servidor ou na pasta abre (ou traz para a frente) a janela dela; a setinha só expande', async () => {
  await page.click('.act-btn[title="Servidores"]');
  await waitText('.sidebar .tree-row .label', 'Este computador');
  const tabsBefore = await chatTabs();
  const pagesBefore = (await env.browser.pages()).length;
  const wid1 = await page.evaluate(() => sessionStorage.getItem('deck.wid'));

  // Registra o que a interface manda ao servidor (o teste não abre o Brave do sistema).
  await page.evaluate(() => {
    window.__openCalls = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try {
        const m = typeof d === 'string' && d.includes('"window.open"') ? JSON.parse(d) : null;
        if (m && m.method === 'window.open') window.__openCalls.push(m.params);
      } catch {
        /* ignora */
      }
      return orig.call(this, d);
    };
  });
  const openCalls = () => page.evaluate(() => window.__openCalls);
  const emptyRows = () => page.$$eval('.sidebar .tree-row .label', (e) => e.filter((x) => x.textContent.includes('Nova conversa em outra pasta')).length);

  // 1. A setinha só expande/recolhe: nenhum pedido de janela, nenhuma janela nova.
  const rowsBefore = await emptyRows();
  await (await page.evaluateHandle(() => [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.querySelector('.label')?.textContent === 'exemplo-web')?.querySelector('.twistie'))).click();
  await waitFor((n) => [...document.querySelectorAll('.sidebar .tree-row .label')].filter((x) => x.textContent.includes('Nova conversa em outra pasta')).length === n + 1, 3000, 'servidor expandido pela setinha', rowsBefore);
  assert((await openCalls()).length === 0, 'a setinha não deveria pedir janela');
  assert((await env.browser.pages()).length === pagesBefore, 'a setinha não deveria abrir janela');

  // 2. Clicar no nome do servidor pede a janela dele. Com uma janela do computador aberta, é ela que vem.
  await (await findByText('.sidebar .tree-row .label', 'Este computador')).click();
  await waitFor(() => window.__openCalls.length === 1, 3000, 'pedido de janela ao clicar no servidor');
  assert(JSON.stringify((await openCalls())[0]) === '{"hostId":"local"}', `pedido do servidor: ${JSON.stringify((await openCalls())[0])}`);
  const r1 = await h.rpc('window.open', { hostId: 'local' });
  assert(r1.wid === wid1 && !r1.url, `o servidor já tem janela aberta: deveria trazê-la para a frente (${JSON.stringify(r1)})`);

  // 3. A janela fechada de outra pasta volta com a conversa que tinha (mesmo id), sem conversa nova.
  const r2 = await h.rpc('window.open', { hostId: 'local', folder: savedSecondWindow?.cwd });
  assert(r2.launched === false && /\/auth\?c=[a-f0-9]{48}&open=/.test(r2.url), `URL da janela: ${r2.url}`);
  const page3 = await env.browser.newPage();
  try {
    await page3.goto(r2.url, { waitUntil: 'networkidle2' });
    await page3.waitForSelector('.app .chat-header', { timeout: 15000 });
    const h3 = helpers(page3);
    assert((await h3.chatTabs()) === 1, 'a janela restaurada deveria ter 1 conversa');
    assert(new URL(page3.url()).search === '', `o ?open= deveria sair da URL: ${page3.url()}`);
    const wid3 = await page3.evaluate(() => sessionStorage.getItem('deck.wid'));
    let mine = (await h.rpc('sessions.list')).filter((s) => s.wid === wid3);
    assert(savedSecondWindow && wid3 === savedSecondWindow.wid, `não restaurou a janela anterior (${wid3} x ${savedSecondWindow?.wid})`);
    assert(mine.length === 1 && mine[0].sid === savedSecondWindow.sid, `conversa da janela restaurada: ${JSON.stringify(mine.map((s) => [s.sid, s.cwd]))}`);
    assert((await chatTabs()) === tabsBefore, 'a conversa da janela restaurada apareceu na principal');
    await page3.screenshot({ path: path.join(SHOTS, 'janela-servidor.png') });
    // Recarregar (F5) não abre outra conversa: o destino já foi consumido.
    await page3.reload({ waitUntil: 'networkidle2' });
    await page3.waitForSelector('.app .chat-header', { timeout: 15000 });
    await sleep(700);
    mine = (await h.rpc('sessions.list')).filter((s) => s.wid === wid3);
    assert((await h3.chatTabs()) === 1 && mine.length === 1, `recarregar abriu outra conversa (${await h3.chatTabs()} abas, ${mine.length} no servidor)`);
  } finally {
    await page3.close().catch(() => {});
  }

  // 4. Clicar na pasta recente desta mesma janela não pede nada ao servidor (já está nela).
  const rowOf = (dir) => page.evaluateHandle((d) => [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.title.startsWith(d + '\n'))?.querySelector('.label'), dir);
  const n0 = (await openCalls()).length;
  await waitFor((sb) => [...document.querySelectorAll('.sidebar .tree-row')].some((r) => r.title.startsWith(sb + '\n')), 5000, 'pasta do projeto entre as recentes', sandbox);
  await (await rowOf(sandbox)).click();
  await sleep(500);
  assert((await openCalls()).length === n0, 'clicar na pasta da própria janela pediu outra janela');
  // A pasta de outra janela (fechada) pede a janela dela; o servidor a reabre.
  await waitFor((d) => [...document.querySelectorAll('.sidebar .tree-row')].some((r) => r.title.startsWith(d + '\n')), 5000, 'pasta da outra janela entre as recentes', uploads);
  await (await rowOf(uploads)).click();
  await waitFor((n) => window.__openCalls.length === n + 1, 3000, 'pedido de janela ao clicar na pasta', n0);
  const call2 = (await openCalls())[n0];
  assert(call2.hostId === 'local' && call2.folder === uploads, `pedido da pasta: ${JSON.stringify(call2)}`);
  const r3 = await h.rpc('window.open', call2);
  assert(r3.url && r3.launched === false, `a pasta da janela fechada deveria reabri-la: ${JSON.stringify(r3)}`);
  assert((await chatTabs()) === tabsBefore, 'abrir/focar janelas mexeu na de origem');

  // 5. Pedidos inválidos não abrem nada, e o destino só passa pelo /auth se for base64url puro.
  const bad1 = await h.rpc('window.open', { hostId: 'nao-existe' }).then(() => null, (e) => e.message);
  assert(bad1 && /desconhecido/i.test(bad1), `servidor inexistente deveria falhar: ${bad1}`);
  const bad2 = await h.rpc('window.open', { hostId: 'local', folder: 'a\nb' }).then(() => null, (e) => e.message);
  assert(bad2 && /inválid/i.test(bad2), `pasta com quebra de linha deveria falhar: ${bad2}`);
  const bad3 = await h.rpc('window.open', { hostId: 'local', folder: uploads, resume: '../../x y' }).then(() => null, (e) => e.message);
  assert(bad3 && /inválid/i.test(bad3), `conversa a retomar com caracteres estranhos deveria falhar: ${bad3}`);
  const token = fs.readFileSync(path.join(env.dataDir, 'token'), 'utf8').trim();
  const auth = async (open) => (await fetch(`http://127.0.0.1:${env.port}/auth?t=${token}&open=${encodeURIComponent(open)}`, { redirect: 'manual' })).headers.get('location');
  assert((await auth('eyJoIjoibG9jYWwifQ')) === '/?open=eyJoIjoibG9jYWwifQ', 'destino válido deveria passar pelo /auth');
  assert((await auth('"><script>alert(1)</script>')) === '/', 'destino com caracteres perigosos não pode ir para a URL');
  assert((await auth('a'.repeat(5000))) === '/', 'destino grande demais não pode ir para a URL');
  assert((await env.browser.pages()).length === pagesBefore, 'sobrou janela aberta pelo teste');
});

await step('Restaura 3 conversas da pasta local após fechar a janela e reiniciar o app', async () => {
  const e = await startEnv({ sandboxSrc: SANDBOX_SRC, env: { CLAUDE_DECK_TEST_HOOKS: '1' } });
  try {
    const a = e.page;
    const ha = helpers(a);
    await a.bringToFront();
    await ha.newLocalChat(e.sandbox).catch(async (err) => {
      const dump = await a.evaluate(() => ({ picker: document.querySelector('.quickpick .qp-title')?.textContent, focus: `${document.activeElement?.tagName}.${document.activeElement?.className}`, tabs: document.querySelectorAll('.center .tabs .tab').length })).catch(() => null);
      throw new Error(`primeira conversa: ${err.message}; estado=${JSON.stringify(dump)}`);
    });
    for (let i = 1; i <= 3; i++) {
      if (i > 1) {
        await a.click('.chat-header button[title="Nova conversa na mesma pasta"]');
        await ha.waitFor((n) => document.querySelectorAll('.center .tabs .tab').length === n, 10000, `abrir ${i}ª conversa da pasta`, i);
      }
      await ha.send(`echo projeto-${i}`);
      await ha.waitText('.msg .md', `projeto-${i}`);
      await ha.waitIdle();
    }
    await ha.clickTree('README.md');
    await ha.waitActiveFile('README.md');
    const projectWid = await a.evaluate(() => sessionStorage.getItem('deck.wid'));
    const projectSessions = (await ha.rpc('sessions.list')).filter((s) => s.wid === projectWid);
    assert(projectSessions.length === 3, `esperava 3 conversas na pasta local, achei ${projectSessions.length}`);
    const sids = projectSessions.map((s) => s.sid);
    const thirdSessionId = projectSessions[2].sessionId;
    assert(thirdSessionId, 'a terceira conversa não iniciou uma sessão do Claude');
    await sleep(1150); // debounce do layout (600 ms) + gravação em disco (300 ms)
    const saved = JSON.parse(fs.readFileSync(path.join(e.dataDir, 'state.json'), 'utf8'));
    assert(JSON.stringify(saved.windows[projectWid].state.chatTabs.map((t) => t.sid)) === JSON.stringify(sids), 'as 3 abas não foram salvas na mesma ordem');

    // Outra janela com outra pasta do MESMO computador continua aberta e não pode ganhar as 3 abas.
    const other = await e.browser.newPage();
    let otherWid;
    try {
      await other.goto((await ha.rpc('window.open', { hostId: 'local', folder: e.uploads })).url, { waitUntil: 'networkidle2' });
      const hb = helpers(other);
      await other.bringToFront();
      await other.waitForSelector('.app .chat-header', { timeout: 15000 });
      await hb.waitIdle();
      otherWid = await other.evaluate(() => sessionStorage.getItem('deck.wid'));
      assert(otherWid !== projectWid, 'a outra pasta deveria ter janela independente');
      await a.close();

      const url = (await hb.rpc('window.open', { hostId: 'local', folder: e.sandbox })).url;
      const reopened = await e.browser.newPage();
      try {
        await reopened.goto(url, { waitUntil: 'networkidle2' });
        const hr = helpers(reopened);
        await hr.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 3, 15000, '3 abas da pasta restauradas');
        const newWid = await reopened.evaluate(() => sessionStorage.getItem('deck.wid'));
        const now = (await hb.rpc('sessions.list')).filter((s) => s.wid === newWid);
        assert(newWid === projectWid, `não reabriu a mesma janela lógica (${projectWid} x ${newWid})`);
        assert(JSON.stringify(now.map((s) => s.sid)) === JSON.stringify(sids), 'as conversas reabertas não são as mesmas (ou ganharam uma 4ª)');
        assert((await hb.chatTabs()) === 1, 'a outra pasta foi alterada');
        await hr.waitText('.msg .md', 'projeto-3');
        await hr.waitActiveFile('README.md');
        await reopened.screenshot({ path: path.join(SHOTS, 'janela-projeto-3-abas-restauradas.png') });

        await reopened.reload({ waitUntil: 'networkidle2' });
        await hr.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 3, 15000, 'F5 mantém 3 abas');
        assert((await reopened.evaluate(() => sessionStorage.getItem('deck.wid'))) === projectWid, 'F5 trocou o id da janela');
        assert((await hb.rpc('sessions.list')).filter((s) => s.wid === projectWid).length === 3, 'F5 criou outra conversa');
      } finally {
        await reopened.close().catch(() => {});
      }
      await other.close();
    } finally {
      await other.close().catch(() => {});
    }

    // Nenhuma janela conectada e servidor Node reiniciado = equivalente a voltar amanhã após
    // desligar o PC. Abre primeiro o projeto alvo, sem sessionStorage anterior.
    await e.restartServer();
    const token = fs.readFileSync(path.join(e.dataDir, 'token'), 'utf8').trim();
    const encoded = Buffer.from(JSON.stringify({ h: 'local', f: e.sandbox })).toString('base64url');
    const afterBoot = await e.browser.newPage();
    try {
      await afterBoot.goto(`http://127.0.0.1:${e.port}/auth?t=${token}&open=${encoded}`, { waitUntil: 'networkidle2' });
      const hc = helpers(afterBoot);
      await hc.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 3, 15000, '3 abas após reiniciar PC/app');
      const bootWid = await afterBoot.evaluate(() => sessionStorage.getItem('deck.wid'));
      assert(bootWid === projectWid, `após reboot, outra janela foi escolhida (${bootWid} x ${projectWid})`);
      const bootSessions = (await hc.rpc('sessions.list')).filter((s) => s.wid === bootWid);
      assert(JSON.stringify(bootSessions.map((s) => s.sid)) === JSON.stringify(sids), 'após reboot, as sessões mudaram ou se misturaram');
      assert(bootSessions.every((s) => s.phase === 'dormant'), 'processos locais não deveriam sobreviver ao reboot');
      await hc.waitText('.msg .md', 'projeto-3');
      await hc.send('echo depois-do-reboot');
      await hc.waitText('.msg .md', 'depois-do-reboot', 20000);
      await hc.waitIdle();
      const resumed = (await hc.rpc('sessions.list')).find((s) => s.sid === sids[2]);
      assert(resumed?.sessionId === thirdSessionId, 'a conversa local não retomou o mesmo transcript');
      const raw = fs.readFileSync(path.join(e.claudeDir, 'projects', e.sandbox.replace(/[^a-zA-Z0-9]/g, '-'), `${thirdSessionId}.jsonl`), 'utf8');
      assert(raw.includes('projeto-3') && raw.includes('depois-do-reboot'), 'o transcript local não continuou de onde parou');

      // A janela da outra pasta ainda existe e é recuperável; não foi fundida à do projeto.
      const url2 = (await hc.rpc('window.open', { hostId: 'local', folder: e.uploads })).url;
      const otherAgain = await e.browser.newPage();
      try {
        await otherAgain.goto(url2, { waitUntil: 'networkidle2' });
        const ho = helpers(otherAgain);
        await ho.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 1, 15000, 'outra pasta após reboot');
        assert((await otherAgain.evaluate(() => sessionStorage.getItem('deck.wid'))) === otherWid, 'a outra pasta perdeu a janela própria');
        assert((await ho.rpc('sessions.list')).filter((s) => s.wid === otherWid)[0]?.cwd === e.uploads, 'outra pasta foi trocada ou fundida');
      } finally {
        await otherAgain.close().catch(() => {});
      }
    } finally {
      await afterBoot.close().catch(() => {});
    }
  } finally {
    await e.stop();
  }
});

await step('Desligar e ligar o PC: reabre todas as janelas que estavam abertas (e só elas), com as abas', async () => {
  const e = await startEnv({ sandboxSrc: SANDBOX_SRC, env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_CLOSE_GRACE_MS: '700' } });
  try {
    const a = e.page;
    const ha = helpers(a);
    await a.bringToFront();
    await ha.newLocalChat(e.sandbox);
    await a.click('.chat-header button[title="Nova conversa na mesma pasta"]');
    await ha.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 2, 10000, '2ª conversa do projeto');
    await ha.waitIdle();
    const widA = await a.evaluate(() => sessionStorage.getItem('deck.wid'));
    const third = path.join(e.uploads, 'terceira');
    fs.mkdirSync(third, { recursive: true });
    const openWin = async (folder) => {
      const r = await ha.rpc('window.open', { hostId: 'local', folder });
      const p = await e.browser.newPage();
      await p.goto(r.url, { waitUntil: 'networkidle2' });
      await p.waitForSelector('.app .chat-header', { timeout: 15000 });
      await helpers(p).waitIdle();
      return { p, wid: await p.evaluate(() => sessionStorage.getItem('deck.wid')) };
    };
    const B = await openWin(e.uploads);
    const C = await openWin(third);
    assert(new Set([widA, B.wid, C.wid]).size === 3, 'cada pasta deveria ter a sua janela');

    // Fecha só a C, com as outras abertas: ela não deve voltar sozinha no próximo início.
    await C.p.close();
    await sleep(1500);
    const wins = await ha.rpc('test.windows');
    assert(wins[C.wid]?.shouldRestore === false, 'a janela fechada sozinha ficou marcada para reabrir');
    assert(wins[widA]?.shouldRestore === true && wins[B.wid]?.shouldRestore === true, 'as janelas abertas deveriam estar marcadas para reabrir');
    await sleep(700); // estado gravado em disco

    // "Desliga o PC": as janelas somem juntas e o servidor morre sem aviso.
    await Promise.all([a.close(), B.p.close()]);
    await e.restartServer();

    // "Liga o PC" e clica no atalho: uma janela sem id nem destino.
    const first = await e.browser.newPage();
    try {
      await first.goto(`http://127.0.0.1:${e.port}/`, { waitUntil: 'networkidle2' });
      const hf = helpers(first);
      await hf.waitFor(() => document.querySelectorAll('.center .tabs .tab').length > 0, 20000, 'abas da primeira janela');
      const firstWid = await first.evaluate(() => sessionStorage.getItem('deck.wid'));
      assert(firstWid === widA || firstWid === B.wid, `a primeira janela não é uma das que estavam abertas (${firstWid})`);
      // O servidor reabre as outras que estavam abertas (nos testes devolve as URLs em vez de abrir o Brave).
      let launched = [];
      for (let i = 0; i < 50 && !launched.length; i++) {
        await sleep(150);
        launched = await hf.rpc('test.launches');
      }
      assert(launched.length === 1, `deveria reabrir exatamente 1 outra janela, reabriu ${launched.length}`);
      const second = await e.browser.newPage();
      try {
        await second.goto(launched[0], { waitUntil: 'networkidle2' });
        const hs = helpers(second);
        await hs.waitFor(() => document.querySelectorAll('.center .tabs .tab').length > 0, 15000, 'abas da segunda janela');
        const secondWid = await second.evaluate(() => sessionStorage.getItem('deck.wid'));
        assert(secondWid !== firstWid && [widA, B.wid].includes(secondWid), `a janela reaberta não é a outra que estava aberta (${secondWid})`);
        const byWid = { [firstWid]: await hf.chatTabs(), [secondWid]: await hs.chatTabs() };
        assert(byWid[widA] === 2 && byWid[B.wid] === 1, `abas restauradas: ${JSON.stringify(byWid)} (esperava 2 no projeto e 1 em uploads)`);
        await second.screenshot({ path: path.join(SHOTS, 'reboot-janelas-restauradas.png') });

        // Abrir de novo a mesma pasta (outra página, como um segundo clique) não cria outra janela dela.
        const r = await hs.rpc('window.open', { hostId: 'local', folder: e.uploads });
        assert(r.wid === B.wid && !r.url, `a pasta já aberta ganhou outra janela: ${JSON.stringify(r)}`);
        await sleep(3000);
        assert((await hs.rpc('test.launches')).length === 0, 'reabriu janela a mais (ou a que tinha sido fechada)');
      } finally {
        await second.close().catch(() => {});
      }
    } finally {
      await first.close().catch(() => {});
    }
  } finally {
    await e.stop();
  }
});

await step('Fechar TODAS as janelas com o programa ainda rodando e abrir pelo atalho: voltam todas (inclusive reabrindo logo em seguida)', async () => {
  // Cenário: o servidor fica rodando em segundo plano; o usuário fechou todas as janelas e
  // clicou no atalho — só a local voltou (a restauração só acontecia na 1ª janela depois de LIGAR o servidor).
  const e = await startEnv({ sandboxSrc: SANDBOX_SRC, env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_CLOSE_GRACE_MS: '2500' } });
  const pages = [];
  try {
    const a = e.page;
    const ha = helpers(a);
    await ha.newLocalChat(e.sandbox);
    const widA = await a.evaluate(() => sessionStorage.getItem('deck.wid'));
    const third = path.join(e.uploads, 'terceira');
    fs.mkdirSync(third, { recursive: true });
    const openWin = async (folder, via = ha) => {
      const r = await via.rpc('window.open', { hostId: 'local', folder });
      const p = await e.browser.newPage();
      pages.push(p);
      await p.goto(r.url, { waitUntil: 'networkidle2' });
      await p.waitForSelector('.app .chat-header', { timeout: 15000 });
      await helpers(p).waitIdle();
      return { p, wid: await p.evaluate(() => sessionStorage.getItem('deck.wid')) };
    };
    const B = await openWin(e.uploads);
    const C = await openWin(third);
    // A janela da C nasce e morre dentro dos 2,5 s da restauração agendada pela A: não pode ser "reaberta junto".
    await C.p.close(); // fechada sozinha: não volta
    await sleep(3200);

    const shortcut = async () => {
      const p = await e.browser.newPage(); // sem id de janela e sem destino = clique no atalho
      pages.push(p);
      await p.goto(`http://127.0.0.1:${e.port}/`, { waitUntil: 'networkidle2' });
      const hp = helpers(p);
      await hp.waitFor(() => document.querySelectorAll('.center .tabs .tab').length > 0, 20000, 'abas da janela do atalho');
      let launched = [];
      for (let i = 0; i < 60 && !launched.length; i++) {
        await sleep(150);
        launched = await hp.rpc('test.launches');
      }
      await sleep(1500);
      launched = launched.concat(await hp.rpc('test.launches'));
      return { p, hp, wid: await p.evaluate(() => sessionStorage.getItem('deck.wid')), launched };
    };
    const name = (w) => (w === widA ? 'A' : w === B.wid ? 'B' : w === C.wid ? 'C(fechada sozinha)' : `nova(${String(w).slice(0, 8)})`);
    const reopenAll = async (label) => {
      const s = await shortcut();
      const got = [name(s.wid)];
      for (const u of s.launched) {
        const p2 = await e.browser.newPage();
        pages.push(p2);
        await p2.goto(u, { waitUntil: 'networkidle2' });
        await helpers(p2).waitFor(() => document.querySelectorAll('.center .tabs .tab').length > 0, 15000, 'abas da janela reaberta');
        got.push(name(await p2.evaluate(() => sessionStorage.getItem('deck.wid'))));
      }
      assert(got.length === 2 && got.includes('A') && got.includes('B'), `${label}: voltaram ${JSON.stringify(got)} (esperava A e B, sem a C)`);
      return { first: s.p, all: pages.slice(-got.length) };
    };

    // 1) Fecha tudo (B e depois A, como quem fecha janela por janela bem rápido) e só depois do prazo abre o atalho.
    await B.p.close();
    await sleep(250);
    await a.close();
    await sleep(3500);
    const r1 = await reopenAll('depois do prazo');

    // 2) Fecha tudo de novo e clica no atalho IMEDIATAMENTE (antes de o servidor dar as janelas por fechadas).
    for (const p of r1.all) {
      await p.close();
      await sleep(250);
    }
    await sleep(300);
    const r2 = await reopenAll('logo em seguida');
    await sleep(3000); // os prazos das janelas fechadas vencem aqui: nada pode perder a marca nem reabrir a mais
    const wins = await helpers(r2.first).rpc('test.windows');
    assert(wins[widA]?.shouldRestore === true && wins[B.wid]?.shouldRestore === true, `marcas depois: A=${wins[widA]?.shouldRestore} B=${wins[B.wid]?.shouldRestore}`);
    assert(wins[C.wid]?.shouldRestore === false, 'a janela fechada sozinha voltou a ser marcada');
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    await e.stop();
  }
});

await step('Abas se organizam (Ctrl+Alt+O): terminou › pede resposta › trabalhando › paradas; a ativa continua ativa e a ordem é gravada', async () => {
  const e = await startEnv({ sandboxSrc: SANDBOX_SRC, env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_UNSEEN_DELAY_MS: '300' } });
  try {
    const p = e.page;
    const hp = helpers(p);
    await p.bringToFront();
    const tabsEl = () => p.$$('.center .tabs .tab');
    const clickTab = async (i) => (await tabsEl())[i].click();
    const statuses = () => p.$$eval('.center .tabs .tab', (tabs) => tabs.map((t) => t.querySelector('.tab-status')?.getAttribute('title') ?? ''));
    const newInSameFolder = async (n) => {
      await p.click('.chat-header button[title="Nova conversa na mesma pasta"]');
      await hp.waitFor((c) => document.querySelectorAll('.center .tabs .tab').length === c, 10000, `abrir a ${n}ª conversa`, n);
    };

    // 1ª: conversa já vista e parada (grupo 4).
    await hp.newLocalChat(e.sandbox);
    await hp.send('echo parada');
    await hp.waitText('.msg .md', 'parada');
    await hp.waitIdle();
    // 2ª: termina fora da vista (grupo 1: terminou e não vi).
    await newInSameFolder(2);
    await hp.send('echo terminou-sozinha');
    await clickTab(0);
    await hp.waitFor(() => [...document.querySelectorAll('.center .tabs .tab')][1]?.querySelector('.tab-status')?.getAttribute('title') === 'Terminou (não visto)', 8000, '2ª aba "Terminou (não visto)"');
    // 3ª: pedindo uma resposta (grupo 2). Nasce ANTES da que trabalha: se a abertura da janela não
    // reconhecesse o pedido pendente, a ordem por recência poria a "trabalhando" acima dela.
    await newInSameFolder(3);
    await hp.send('ask');
    await hp.waitFor(() => !!document.querySelector('.tab .tab-status[title="Esperando sua permissão"]'), 8000, '3ª aba pedindo resposta');
    await clickTab(0);
    // 4ª: trabalhando (grupo 3).
    await newInSameFolder(4);
    await hp.send('slow 600');
    await p.waitForSelector('.send-btn.stop', { timeout: 8000 });
    await clickTab(0);
    await hp.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 4, 3000, '4 abas');

    const before = await statuses();
    assert(before.join('|') === ['', 'Terminou (não visto)', 'Esperando sua permissão', 'Trabalhando'].join('|'), `estado de partida inesperado: ${JSON.stringify(before)}`);
    const wid = await p.evaluate(() => sessionStorage.getItem('deck.wid'));
    const sids = (await hp.rpc('sessions.list')).filter((s) => s.wid === wid).map((s) => s.sid); // ordem de criação
    assert(sids.length === 4, `esperava 4 conversas, achei ${sids.length}`);
    const activeBefore = await hp.activeChatLabel();

    // Não reordena sozinho a todo instante: a ordem só muda no atalho (ou no ciclo de 30 min).
    await sleep(800);
    assert(JSON.stringify(await statuses()) === JSON.stringify(before), 'as abas se reordenaram fora do ciclo');

    // Abrir a janela já organiza, sem esperar os 30 minutos. Aqui só a conversa ativa é carregada: a que
    // pede resposta (ainda não aberta nesta página) precisa ser reconhecida mesmo assim, e não cair em "trabalhando".
    const want = ['Terminou (não visto)', 'Esperando sua permissão', 'Trabalhando', ''];
    await p.reload({ waitUntil: 'networkidle2' });
    await hp.waitFor((w) => [...document.querySelectorAll('.center .tabs .tab')].map((t) => t.querySelector('.tab-status')?.getAttribute('title') ?? '').join('|') === w, 12000, 'abas já organizadas ao abrir a janela', want.join('|'));
    assert((await hp.activeChatLabel()) === activeBefore, 'a aba ativa mudou ao abrir a janela');
    assert(await p.$eval('.center .tabs .tab.active', (el) => el === [...document.querySelectorAll('.center .tabs .tab')][3]), 'a aba ativa (a parada) deveria ter ido para o fim');
    assert(!(await p.$('.toast')), 'organizar ao abrir deve ser silencioso (sem aviso na tela)');
    await sleep(1150);
    let saved = JSON.parse(fs.readFileSync(path.join(e.dataDir, 'state.json'), 'utf8'));
    assert(JSON.stringify(saved.windows[wid].state.chatTabs.map((t) => t.sid)) === JSON.stringify([sids[1], sids[2], sids[3], sids[0]]), `ordem gravada ao abrir: ${JSON.stringify(saved.windows[wid].state.chatTabs.map((t) => sids.indexOf(t.sid)))}`);

    // Já na ordem certa: o atalho não mexe em nada.
    await hp.hotkey('Control', 'Alt', 'o');
    await hp.waitText('.toast', 'já estão na ordem');
    assert(JSON.stringify(await statuses()) === JSON.stringify(want), 'organizar uma ordem que já estava certa mexeu nas abas');

    // Conversa nova (parada, mais recente que a antiga) entra no fim; o atalho a leva para cima da mais antiga.
    await newInSameFolder(5);
    await hp.waitIdle();
    const sids5 = (await hp.rpc('sessions.list')).filter((s) => s.wid === wid).map((s) => s.sid);
    assert(sids5.length === 5, `esperava 5 conversas, achei ${sids5.length}`);
    await hp.hotkey('Control', 'Alt', 'o');
    await hp.waitText('.toast', 'Abas organizadas');
    assert(await p.$eval('.center .tabs .tab.active', (el) => el === [...document.querySelectorAll('.center .tabs .tab')][3]), 'a conversa nova (ativa) deveria ficar logo acima da parada mais antiga');
    await p.screenshot({ path: path.join(SHOTS, 'abas-organizadas.png') }); // da janela deste passo (shot() fotografa a principal)
    await sleep(1150);
    saved = JSON.parse(fs.readFileSync(path.join(e.dataDir, 'state.json'), 'utf8'));
    const expected5 = [sids[1], sids[2], sids[3], sids5[4], sids[0]];
    assert(JSON.stringify(saved.windows[wid].state.chatTabs.map((t) => t.sid)) === JSON.stringify(expected5), `ordem gravada: ${JSON.stringify(saved.windows[wid].state.chatTabs.map((t) => sids5.indexOf(t.sid)))}`);
  } finally {
    await e.stop();
  }
});

await step('Sem erros no console da página', async () => {
  const errs = env.app.errors.filter((e) => !/favicon/i.test(e));
  assert(!errs.length, errs.join(' | '));
});

// ---------------------------------------------------------------- memória
let mem = null;
try {
  const m = await page.metrics();
  mem = { jsHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes };
} catch {
  /* ignora */
}

// ---------------------------------------------------------------- fim
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(SHOTS, 'relatorio.json'), JSON.stringify({ when: new Date().toISOString(), port: env.port, results, mem }, null, 2));
if (failed.length) fs.writeFileSync(path.join(SHOTS, 'server.log'), env.serverLog());
await env.stop({ keep: !!process.env.E2E_KEEP || failed.length > 0 });
console.log(`\n${results.length - failed.length}/${results.length} passos ok${mem ? ` · heap JS da página ${mem.jsHeapMB} MB, ${mem.nodes} nós DOM` : ''}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
process.exit(failed.length ? 1 : 0);
