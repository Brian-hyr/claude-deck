// E2E remoto: interface real + servidor de teste (via DECK_TEST_HOST) por SSH/SFTP.
// Copia o sandbox e o "Claude falso" para /tmp/deck-e2e-<aleatório> no servidor, conversa pelo
// runner, testa arquivos por SFTP, queda de rede, reinício do app, histórico e limpa tudo no fim.
//
//   node test/e2e/remote.mjs        (DECK_TEST_HOST=<alias> troca o servidor; E2E_HEADFUL=1 mostra a janela)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startEnv, helpers, readZipEntries, sleep, ROOT, SANDBOX } from './harness.mjs';

const HOST = process.env.DECK_TEST_HOST;
if (!HOST) {
  console.log('DECK_TEST_HOST não definido. Pulando testes E2E remotos via SSH.');
  process.exit(0);
}
if (process.env.DECK_SKIP_HOSTS && new RegExp(process.env.DECK_SKIP_HOSTS, 'i').test(HOST)) {
  throw new Error('Servidor marcado em DECK_SKIP_HOSTS: não usar para testes.');
}
const SANDBOX_SRC = SANDBOX;
const SHOTS = path.join(ROOT, 'test', 'shots', 'e2e-remote');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const RAND = crypto.randomBytes(4).toString('hex');
const BASE = `/tmp/deck-e2e-${RAND}`;
const PROJ = `${BASE}/proj`;
const FAKE_REMOTE = `${BASE}/fake-claude.mjs`;
const PROJ_KEY = PROJ.replace(/[^a-zA-Z0-9]/g, '-');
/** Segunda pasta no mesmo servidor: tem janela própria (uma janela por servidor+pasta). */
const OUTRA = `${BASE}/outra`;
const OUTRA_KEY = OUTRA.replace(/[^a-zA-Z0-9]/g, '-');

const ssh = (cmd) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, cmd], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
const scp = (cwd, src, dst) =>
  execFileSync('scp', ['-q', '-r', '-o', 'BatchMode=yes', src, `${HOST}:${dst}`], { cwd, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });

function cleanupRemote() {
  try {
    ssh(
      `for d in "$HOME"/.cache/claude-deck/s/*; do [ -f "$d/cwd" ] && grep -q '^${BASE}' "$d/cwd" && { kill $(cat "$d/pid" 2>/dev/null) 2>/dev/null; rm -rf "$d"; }; done; ` +
        `rm -rf '${BASE}' "$HOME/.claude/projects/${PROJ_KEY}" "$HOME/.claude/projects/${OUTRA_KEY}"; echo limpo`,
    );
    return true;
  } catch (e) {
    console.log(`  (limpeza remota falhou: ${String(e.message).split('\n')[0]})`);
    return false;
  }
}

// ---------------------------------------------------------------- preparação no servidor
const t0 = Date.now();
ssh(`mkdir -p '${BASE}' && chmod 700 '${BASE}'`);
scp(path.dirname(SANDBOX_SRC), path.basename(SANDBOX_SRC), PROJ);
scp(path.join(ROOT, 'test', 'fake-claude'), 'fake-claude.mjs', FAKE_REMOTE);
ssh(`chmod 755 '${FAKE_REMOTE}' && test -f '${PROJ}/README.md' && command -v node >/dev/null && echo pronto`);
console.log(`Claude Deck E2E remoto — ${HOST}:${BASE} (preparado em ${Date.now() - t0} ms)`);

const env = await startEnv({
  useRealSsh: true,
  settings: { hostClaudePath: { [HOST]: FAKE_REMOTE } },
  env: { CLAUDE_DECK_TEST_HOOKS: '1' },
});
const { page } = env;
const h = helpers(page);
const { assert, waitText, waitFor, clickText, hotkey, send, waitIdle, count, findTreeRow, clickTree, waitActiveFile, menu, chatTabs } = h;
console.log(`  porta ${env.port}\n`);

// ---------------------------------------------------------------- utilitários
const results = [];
let shotN = 0;
async function shot(name) {
  await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) });
}
async function step(name, fn) {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    const note = await fn();
    const ms = Date.now() - t;
    results.push({ name, ok: true, ms, note });
    console.log(`ok (${ms} ms)${note ? ` — ${note}` : ''}`);
  } catch (e) {
    const dump = await page
      .evaluate(() => ({
        tabs: [...document.querySelectorAll('.center .tabs .tab')].map((x) => x.querySelector('.tab-label')?.textContent),
        phase: document.querySelector('.phase-pill')?.textContent,
        notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent).slice(-3),
        toasts: [...document.querySelectorAll('.toast')].map((x) => x.textContent),
      }))
      .catch(() => null);
    results.push({ name, ok: false, ms: Date.now() - t, error: String(e?.message ?? e), dump });
    console.log(`FALHOU: ${String(e?.message ?? e).split('\n')[0]}\n    estado: ${JSON.stringify(dump)}`);
    await page.screenshot({ path: path.join(SHOTS, `FALHA-${name.replace(/[^\wÀ-ú-]+/g, '_')}.png`) }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}
// Resposta ao ÚLTIMO pedido do usuário: só os blocos de texto depois da última bolha do usuário
// (a resposta anterior também tem números e não pode ser confundida com a nova).
const REPLY_FN = `(() => {
  const els = [...document.querySelectorAll('.msg.user, .msg .md')];
  let i = els.length - 1;
  while (i >= 0 && !els[i].classList.contains('user')) i--;
  return els.slice(i + 1).map((e) => e.textContent).join('\\n');
})()`;
/** Números (1, 2, 3…) da resposta ao último pedido: confere sequência sem repetição. */
const lastNumbers = () => page.evaluate((f) => (eval(f).match(/\d+/g) ?? []).map(Number), REPLY_FN);
const isSeq = (nums) => nums.every((n, i) => n === i + 1);
async function waitNumber(n, timeout) {
  await waitFor((k, f) => new RegExp(`(^|\\D)${k}(\\D|$)`).test(eval(f)), timeout, `chegar ao número ${n}`, n, REPLY_FN);
}
/** Logo depois da bolha do último pedido não pode haver linha de resultado (turno anterior relido). */
const staleResultAfterLastUser = () =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll('.msg.user, .msg .md, .result-line')];
    let i = els.length - 1;
    while (i >= 0 && !els[i].classList.contains('user')) i--;
    return i >= 0 && !!els[i + 1]?.classList.contains('result-line');
  });

// ---------------------------------------------------------------- passos
await step('nova conversa remota (servidor + pasta digitada)', async () => {
  const t = Date.now();
  await page.waitForSelector('.empty-chat, .chat-header');
  await hotkey('Control', 'Shift', 'N');
  await waitText('.quickpick .qp-title', 'escolha o servidor');
  await waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor');
  await page.keyboard.type(HOST);
  await waitFor((n) => document.querySelector('.quickpick .qp-item.active .label')?.textContent === n, 5000, 'servidor filtrado', HOST);
  await page.keyboard.press('Enter');
  await waitText('.quickpick .qp-title', 'escolha a pasta');
  await waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor de pasta');
  await page.keyboard.type(PROJ);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-header', { timeout: 30000 });
  await waitIdle(60000);
  // Título: servidor + pasta das conversas (com ~ quando está na home), sem o título da conversa.
  await waitFor((host, dir) => document.title.startsWith(`${host} · `) && document.title.endsWith(`${dir} — Claude Deck`), 5000, 'nome da janela mostra o servidor e a pasta', HOST, PROJ);
  const ms = Date.now() - t;
  await findTreeRow('README.md');
  await shot('conversa-remota');
  return `conectou, instalou o runner e iniciou o Claude em ${ms} ms`;
});

await step('mensagem remota com streaming + título do transcript remoto', async () => {
  await send('echo Olá do servidor de teste');
  await waitText('.msg .md', 'Olá do servidor de teste', 20000);
  await waitIdle(20000);
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent.startsWith('Teste: echo Olá do servidor'), 20000, 'título vindo do ai-title remoto');
});

await step('Write remoto: permissão → Permitir', async () => {
  await send('write novo-remoto.txt');
  await waitText('.perm-card .perm-title', 'Permitir?', 20000);
  await clickText('.perm-card .perm-actions .btn', 'Permitir', true);
  await waitText('.msg .md', 'Arquivo criado.', 20000);
  await waitIdle();
  await findTreeRow('novo-remoto.txt');
  assert(ssh(`test -f '${PROJ}/novo-remoto.txt' && echo sim`).trim() === 'sim', 'arquivo não existe no servidor');
});

await step('Sempre permitir usa userSettings do servidor remoto, não do notebook', async () => {
  await send('bash');
  await waitText('.perm-card', `em todos os projetos em ${HOST}`, 20000);
  await clickText('.perm-card .perm-actions .btn', 'Sempre permitir');
  await waitText('.msg .md', 'Comando executado.', 20000);
  await waitIdle();
  const sid = (await h.rpc('sessions.list')).find((s) => s.hostId === HOST && s.cwd === PROJ).sid;
  const applied = await h.rpc('sessions.control', { sid, request: { subtype: 'get_settings' } });
  assert(applied.lastPermissions?.[0]?.destination === 'userSettings', `destino errado: ${JSON.stringify(applied)}`);
});

await step('Mapa remoto: transcrito por SFTP e parar só um agente, sem parar a conversa ou o outro', async () => {
  await send('bgagent 2');
  await waitText('.msg .md', '2 em segundo plano.', 20000);
  await waitIdle();
  await page.click('.agents-pill');
  await waitText('.agents-dialog', 'Mapa de agentes e tarefas (2)');
  await clickText('.agents-dialog .btn', 'Ver transcrito');
  await waitText('.agent-transcript', 'Transcrito do agente agent1', 20000);
  await clickText('.agents-dialog .btn', 'Parar só esta tarefa');
  await waitText('.agents-dialog .agent-run-state', 'Parado', 20000);
  await shot('mapa-agentes-remoto');
  await page.keyboard.press('Escape');
  await waitText('.agents-pill', '1 agente');
  await send('agentdone');
  await waitText('.msg .md', 'Agentes terminaram.', 20000);
  await waitIdle();
  await page.click('.agents-pill');
  await waitText('.agents-dialog .agent-run-state', 'Concluído');
  await page.keyboard.press('Escape');
});

await step('Arquivo remoto citado só pelo nome: o clique acha a subpasta no servidor', async () => {
  ssh(`mkdir -p '${PROJ}/sub-e2e/img' && printf 'conteudo remoto da subpasta\\n' > '${PROJ}/sub-e2e/img/remoto-e2e.txt'`);
  const tabsBefore = await count('.editor-panel .tab');
  await send('echo Gerei o arquivo `remoto-e2e.txt` para você.');
  await waitText('.msg .md code.path-link', 'remoto-e2e.txt', 20000);
  await waitIdle(20000);
  await clickText('.msg .md code.path-link', 'remoto-e2e.txt', true);
  await waitActiveFile('remoto-e2e.txt', 20000);
  await waitText('.editor-panel .cm-content', 'conteudo remoto da subpasta', 15000);
  await page.click('.editor-panel .tab.active .close');
  await waitFor((n) => document.querySelectorAll('.editor-panel .tab').length === n, 5000, 'aba do arquivo fechada', tabsBefore);
});

await step('Markdown remoto (imagem relativa por SFTP)', async () => {
  await clickTree('README.md');
  await waitActiveFile('README.md');
  await waitText('.md-view h1', 'Projeto de teste do Claude Deck');
  await waitFor(() => {
    const i = document.querySelector('.md-view img');
    return i && i.complete && i.naturalWidth > 0;
  }, 15000, 'imagem relativa do markdown');
  await shot('markdown-remoto');
});

await step('Vídeo MP4 remoto (Range por SFTP, busca, reprodução)', async () => {
  await clickTree('media');
  const t = Date.now();
  await clickTree('teste.mp4');
  await waitActiveFile('teste.mp4');
  await page.waitForSelector('.media-view video', { timeout: 15000 });
  const v = await page.evaluate(async () => {
    const v = document.querySelector('.media-view video');
    if (v.readyState < 1)
      await new Promise((r, j) => (v.addEventListener('loadedmetadata', r, { once: true }), v.addEventListener('error', () => j(new Error('erro no vídeo')), { once: true }), setTimeout(() => j(new Error('sem metadados')), 15000)));
    const t1 = performance.now();
    const meta = { w: v.videoWidth, h: v.videoHeight, d: v.duration };
    v.muted = true;
    v.currentTime = 4;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    const seekMs = Math.round(performance.now() - t1);
    await v.play();
    await new Promise((r) => setTimeout(r, 800));
    const t = v.currentTime;
    v.pause();
    return { ...meta, t, seekMs };
  });
  assert(v.w === 1280 && v.h === 720, `dimensões ${v.w}x${v.h}`);
  assert(v.t > 4.2, `não reproduziu depois da busca (t=${v.t})`);
  await shot('video-remoto');
  return `metadados em ${Date.now() - t - 800 - v.seekMs} ms (aprox.), busca em ${v.seekMs} ms`;
});

await step('Áudio WAV remoto (forma de onda e info)', async () => {
  await clickTree('tom.wav');
  await waitActiveFile('tom.wav');
  await page.waitForSelector('canvas.waveform', { timeout: 20000 });
  await waitText('.audio-meta', '44.1 kHz');
  await waitText('.audio-meta', 'estéreo');
});

await step('JSON remoto em árvore', async () => {
  await clickTree('data');
  await clickTree('config.json');
  await waitActiveFile('config.json');
  await waitText('.json-view .jkey', '"servidores"');
});

await step('Busca em arquivos remota (rg/grep por SSH): resultado, pasta ignorada e sem injeção de comando', async () => {
  // Pasta ignorada aninhada (com a palavra buscada) e um arquivo com aspas/$/crase na linha.
  ssh(`mkdir -p '${PROJ}/src/node_modules/pkg' && printf 'descrever isto nao pode aparecer\\n' > '${PROJ}/src/node_modules/pkg/x.js'`);
  ssh(`cat > '${PROJ}/aspas.txt' <<'EOF'\nele disse it's "quoted" $HOME \`id\` fim\nEOF`);

  await hotkey('Control', 'Shift', 'F');
  await waitText('.side-title', 'Buscar em arquivos');
  await page.click('.sidebar .search-box input');
  await page.keyboard.type('descrever');
  await waitFor(() => [...document.querySelectorAll('.sidebar .search-hl')].some((e) => e.textContent === 'descrever'), 20000, 'trecho "descrever" destacado (busca remota)');
  await waitText('.sidebar .tree-empty', '2 ocorrências em 1 arquivo');
  assert(!(await page.evaluate(() => document.body.textContent.includes('nao pode aparecer'))), 'achou conteúdo dentro de node_modules (deveria ser ignorado)');
  await shot('busca-remota');

  // Aspas, $ e crase na consulta chegam literais: acha a linha e não expande nada.
  const lit = await h.rpc('fs.search', { h: HOST, root: PROJ, query: `it's "quoted" $HOME \`id\``, caseSensitive: true, regex: false, limit: 50 });
  assert(lit.matches.length === 1 && lit.matches[0].file === 'aspas.txt' && lit.matches[0].line === 1, `busca literal com aspas/$/crase: ${JSON.stringify(lit.matches)}`);
  const hl = lit.matches[0];
  assert(hl.text.substr(hl.hlStart, hl.hlLen) === `it's "quoted" $HOME \`id\``, `trecho destacado errado: "${hl.text.substr(hl.hlStart, hl.hlLen)}"`);

  // Tentativa de injeção: o marcador NÃO pode ser criado no servidor.
  const marker = `${BASE}/injetado`;
  for (const [query, regex] of [[`x'; touch ${marker}; echo 'y`, false], [`$(touch ${marker})`, false], [`\`touch ${marker}\``, false], [`x'; touch ${marker}; echo 'y`, true]]) {
    await h.rpc('fs.search', { h: HOST, root: PROJ, query, caseSensitive: false, regex, limit: 50 }).catch(() => {});
  }
  assert(ssh(`test -e '${marker}' && echo criou || echo ok`).trim() === 'ok', 'INJEÇÃO: a busca executou comando arbitrário no servidor');

  // Raiz inexistente: erro claro em vez de resultado vazio.
  const badRoot = await h.rpc('fs.search', { h: HOST, root: `${BASE}/nao-existe`, query: 'x', caseSensitive: false, regex: false, limit: 5 }).then(() => null, (e) => e.message);
  assert(badRoot && badRoot.includes('Não encontrado'), `raiz inexistente deveria dar erro: ${badRoot}`);

  await hotkey('Control', 'Shift', 'E'); // volta ao explorador para os passos seguintes
  await findTreeRow('src');
});

await step('Arquivo grande remoto (3,6 MB)', async () => {
  const t = Date.now();
  await clickTree('log-grande.log');
  await waitActiveFile('log-grande.log');
  await page.waitForSelector('.editor-panel .cm-editor', { timeout: 30000 });
  return `abriu em ${Date.now() - t} ms`;
});

await step('Pasta do Windows ⇄ servidor: soltar no explorador, baixar .zip e arrastar para fora', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-rdrop-'));
  const pasta = path.join(src, 'pasta-win');
  fs.mkdirSync(path.join(pasta, 'sub', 'fundo'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'vazia'));
  fs.writeFileSync(path.join(pasta, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(pasta, 'sub', 'fundo', 'c.txt'), 'C\n');
  fs.writeFileSync(path.join(pasta, 'açúcar e café.txt'), 'acentuado\n');
  const grande = crypto.randomBytes(6 * 1024 * 1024 + 123); // passa de várias janelas de SFTP
  fs.writeFileSync(path.join(pasta, 'grande.bin'), grande);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

  // Windows → servidor.
  await h.dropOs(await h.rowPoint('README.md'), [pasta]);
  await waitText('.toast', 'Enviado: pasta-win — 4 arquivos', 60000);
  const listing = ssh(`cd '${PROJ}/pasta-win' && find . | sort`).trim().split('\n');
  for (const n of ['./a.txt', './sub/fundo/c.txt', './vazia', './açúcar e café.txt', './grande.bin']) assert(listing.includes(n), `no servidor faltou ${n}: ${listing.join(' | ')}`);
  assert(ssh(`test -d '${PROJ}/pasta-win/vazia' && echo sim`).trim() === 'sim', 'pasta vazia não foi criada no servidor');
  assert(ssh(`sha256sum '${PROJ}/pasta-win/grande.bin' | cut -d' ' -f1`).trim() === sha(grande), 'arquivo grande chegou diferente no servidor');
  await findTreeRow('pasta-win');

  // Servidor → Windows: baixar a pasta (.zip) pelo menu. Inclui link para arquivo, ignora link para pasta e
  // arquivo sem permissão vira aviso dentro do zip (se o usuário do teste não for root).
  ssh(`cd '${PROJ}/pasta-win' && ln -s a.txt link-arq && ln -s . laco && printf x > naolegivel.txt && chmod 000 naolegivel.txt`);
  const root = ssh('id -u').trim() === '0';
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-rdl-'));
  const cdp = await page.browser().target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  await (await findTreeRow('pasta-win')).click({ button: 'right' });
  await menu('Baixar pasta (.zip)');
  const zipPath = path.join(dlDir, 'pasta-win.zip');
  for (let i = 0; i < 300 && !(fs.existsSync(zipPath) && !fs.readdirSync(dlDir).some((f) => f.endsWith('.crdownload'))); i++) await sleep(100);
  assert(fs.existsSync(zipPath), 'o .zip não foi baixado');
  const zipCheck = (buf) => {
    const es = readZipEntries(buf);
    const by = Object.fromEntries(es.map((e) => [e.name, e]));
    assert(es.every((e) => e.ok), 'CRC/tamanho de alguma entrada não bate');
    assert(by['pasta-win/vazia/']?.dir && by['pasta-win/sub/fundo/c.txt']?.data.toString() === 'C\n', `estrutura do zip: ${es.map((e) => e.name).join(', ')}`);
    assert(sha(by['pasta-win/grande.bin'].data) === sha(grande), 'grande.bin veio diferente no zip');
    assert(by['pasta-win/açúcar e café.txt']?.data.toString() === 'acentuado\n', 'nome acentuado no zip');
    assert(by['pasta-win/link-arq']?.data.toString() === 'A\n', 'link para arquivo deveria entrar como o arquivo');
    assert(!es.some((e) => e.name.startsWith('pasta-win/laco')), 'link para pasta (laço) não deveria entrar no zip');
    if (!root) assert(by['LEIA-ME-itens-nao-incluidos.txt']?.data.toString().includes('naolegivel.txt'), 'o arquivo sem permissão deveria ser listado no LEIA-ME do zip');
  };
  zipCheck(fs.readFileSync(zipPath));

  // Arrastar para fora: o link do bilhete entrega o mesmo zip, sem cookie.
  const items = await h.dragOutOf('pasta-win');
  const it = items.find((i) => i.type.toLowerCase() === 'downloadurl');
  assert(it, `sem DownloadURL: ${JSON.stringify(items.map((i) => i.type))}`);
  const url = it.data.split(':').slice(2).join(':');
  const r = await fetch(url);
  assert(r.status === 200, `GET do link: ${r.status}`);
  zipCheck(Buffer.from(await r.arrayBuffer()));

  await cdp.detach().catch(() => {});
  ssh(`chmod 644 '${PROJ}/pasta-win/naolegivel.txt'; rm -rf '${PROJ}/pasta-win'`);
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dlDir, { recursive: true, force: true });
  await page.click('.section-head button[title="Atualizar"]');
});

await step('Editar e salvar remoto + conflito com mudança externa (mesmo segundo)', async () => {
  await clickTree('src');
  await clickTree('app.ts');
  await waitActiveFile('app.ts');
  await page.waitForSelector('.editor-panel .cm-content', { timeout: 10000 });
  await page.click('.editor-panel .cm-content');
  await hotkey('Control', 'End');
  await page.keyboard.type('\n// editado remoto');
  await hotkey('Control', 's');
  await waitText('.toast', 'Salvo: app.ts');
  assert(ssh(`grep -c 'editado remoto' '${PROJ}/src/app.ts'`).trim() === '1', 'não gravou no servidor');
  ssh(`printf '\\n// mudanca externa\\n' >> '${PROJ}/src/app.ts'`);
  await page.click('.editor-panel .cm-content');
  await hotkey('Control', 'End');
  await page.keyboard.type('\n// segunda remota');
  await waitFor(() => document.querySelector('.editor-panel .cm-content')?.textContent.includes('// segunda remota'), 5000, 'edição remota chegou ao editor antes de salvar');
  await hotkey('Control', 's');
  await waitText('.dialog .dialog-head', 'O arquivo mudou no disco');
  await clickText('.dialog .dialog-foot .btn', 'Sobrescrever');
  await waitFor(() => !document.querySelector('.dialog'), 5000, 'diálogo fechado');
  await waitFor(() => !document.querySelector('.editor-panel .tab.active.dirty'), 8000, 'salvo após conflito');
  const disk = ssh(`cat '${PROJ}/src/app.ts'`);
  assert(disk.includes('// segunda remota') && !disk.includes('mudanca externa'), `conteúdo final inesperado no servidor (marcadores: segunda=${disk.includes('// segunda remota')}, externo=${disk.includes('mudanca externa')})`);
});

await step('Renomear aba grava o nome no transcript remoto', async () => {
  const tab = await page.$('.center .tabs .tab.active');
  await tab.click({ button: 'right' });
  await menu('Renomear');
  await page.waitForSelector('.center .tabs .tab.active input.tab-rename', { timeout: 5000 });
  await hotkey('Control', 'a');
  await page.keyboard.type('Remota renomeada');
  await page.keyboard.press('Enter');
  await waitFor(() => document.querySelector('.center .tabs .tab.active .tab-label')?.textContent === 'Remota renomeada', 5000, 'aba renomeada');
  let found = '';
  for (let i = 0; i < 20 && !found.includes('Remota renomeada'); i++) {
    found = ssh(`grep -h '"custom-title"' "$HOME/.claude/projects/${PROJ_KEY}"/*.jsonl 2>/dev/null || true`);
    if (!found.includes('Remota renomeada')) await sleep(500);
  }
  assert(found.includes('Remota renomeada'), 'custom-title não foi gravado no transcript remoto');
});

/** Espera a resposta ao último pedido passar de `k` números (dados novos chegando). */
const waitMoreThan = (k, timeout, label) => waitFor((n, f) => (eval(f).match(/\d+/g) ?? []).length > n, timeout, label, k, REPLY_FN);

await step('Queda de rede no meio da resposta: reanexa sem perder nem duplicar', async () => {
  await send('slow 80');
  await waitNumber(8, 15000);
  const before = (await lastNumbers()).length;
  const t = Date.now();
  await h.rpc('test.dropHost', { id: HOST });
  let sawReconnecting = false;
  for (let i = 0; i < 30; i++) {
    const p = await page.$eval('.phase-pill', (e) => e.textContent).catch(() => '');
    if (/Reconectando/.test(p)) {
      sawReconnecting = true;
      break;
    }
    await sleep(50);
  }
  await waitMoreThan(before + 3, 20000, 'dados novos depois da queda');
  const resumeMs = Date.now() - t;
  // A fase volta a "Trabalhando" já com os dados chegando (sem esperar o fim do turno).
  await waitFor(() => /Trabalhando/.test(document.querySelector('.phase-pill')?.textContent ?? ''), 3000, 'fase "Trabalhando" após reanexar');
  const mid = await lastNumbers();
  assert(isSeq(mid), `sequência com falha ou repetição após reconectar: ${mid.slice(0, 60).join(',')}`);
  await waitNumber(80, 30000);
  await waitIdle(30000);
  const nums = await lastNumbers();
  assert(nums.length === 80 && isSeq(nums), `resposta final inesperada (${nums.length} números)`);
  assert((await count('.user-bubble')) === (await page.$$eval('.user-bubble', (e) => new Set(e.map((x) => x.textContent)).size)), 'mensagem do usuário duplicada');
  return `${sawReconnecting ? 'mostrou "Reconectando"; ' : ''}dados voltaram ${resumeMs} ms após a queda`;
});

await step('App reinicia no meio de uma resposta remota: reanexa e completa', async () => {
  await send('slow 60');
  await waitNumber(6, 15000);
  const before = (await lastNumbers()).length;
  const t = Date.now();
  await env.restartServer();
  const restartMs = Date.now() - t;
  await waitMoreThan(before + 3, 30000, 'dados novos depois do reinício');
  const resumeMs = Date.now() - t;
  await waitNumber(60, 60000);
  await waitIdle(30000);
  const nums = await lastNumbers();
  assert(nums.length === 60 && isSeq(nums), `resposta após reinício inesperada (${nums.length} números: ${nums.slice(0, 20).join(',')}…)`);
  const bubbles = await page.$$eval('.user-bubble', (e) => e.map((x) => x.textContent.trim()));
  assert(bubbles.filter((b) => b.includes('slow 60')).length === 1, `"slow 60" aparece ${bubbles.filter((b) => b.includes('slow 60')).length}x`);
  assert(!(await staleResultAfterLastUser()), 'resultado do turno anterior reapareceu depois do novo pedido');
  await shot('apos-reinicio');
  return `servidor do app voltou em ${restartMs} ms; conversa voltou a receber ${resumeMs} ms após o reinício`;
});

await step('Mensagem depois do reinício segue na mesma sessão', async () => {
  await send('echo depois do reinício');
  await waitText('.msg .md', 'depois do reinício', 20000);
  await waitIdle();
  const n = ssh(`grep -l 'depois do rein' "$HOME/.claude/projects/${PROJ_KEY}"/*.jsonl | xargs grep -l 'slow 60' | wc -l`).trim();
  assert(n === '1', `esperava 1 transcript com as duas mensagens, achei ${n}`);
});

let closedSid = null;
await step('Fechar conversa remota encerra o processo no servidor', async () => {
  const list = await h.rpc('sessions.list');
  const s = list.find((x) => x.hostId === HOST);
  closedSid = s?.sid;
  assert(closedSid, 'sessão remota não encontrada');
  assert(ssh(`test -d "$HOME/.cache/claude-deck/s/${s.runnerId ?? closedSid}" && echo sim || echo nao`).trim() === 'sim', 'runner não existia no servidor');
  await page.click('.center .tabs .tab.active .close');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 0, 8000, 'aba fechada');
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    gone = ssh(`test -d "$HOME/.cache/claude-deck/s/${s.runnerId ?? closedSid}" && echo sim || echo nao`).trim() === 'nao';
    if (!gone) await sleep(300);
  }
  assert(gone, 'o runner continuou no servidor depois de fechar a aba');
});

await step('Histórico remoto: listar e retomar (--resume)', async () => {
  await hotkey('Control', 'Shift', 'H');
  await waitText('.sidebar .side-title', 'Histórico');
  await waitText('.sidebar .tree-row .label', 'Remota renomeada', 20000);
  assert(!(await page.$('.sidebar select')), 'o histórico não deveria deixar escolher outro servidor');
  await waitText('.sidebar .history-host', HOST);
  await shot('historico-remoto');
  await clickText('.sidebar .tree-row', 'Remota renomeada');
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 1, 10000, 'aba aberta');
  await waitText('.user-bubble', 'echo depois do reinício', 20000);
  await send('echo retomada remota');
  await waitText('.msg .md', 'retomada remota', 30000);
  await waitIdle();
  const n = ssh(`grep -l 'retomada remota' "$HOME/.claude/projects/${PROJ_KEY}"/*.jsonl | xargs grep -l 'depois do rein' | wc -l`).trim();
  assert(n === '1', `a retomada não continuou o mesmo transcript (${n})`);
  await page.click('.center .tabs .tab.active .close');
});

await step('Reabre conversas da mesma pasta SSH após fechar a janela e reiniciar o app', async () => {
  await waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 0, 8000, 'aba anterior fechada');
  ssh(`mkdir -p '${OUTRA}'`);
  const mainWid = await page.evaluate(() => sessionStorage.getItem('deck.wid'));
  // A pasta do projeto é a da janela principal (mesmo sem abas): pedir de novo só a traz para a frente.
  const same = await h.rpc('window.open', { hostId: HOST, folder: PROJ });
  assert(same.wid === mainWid && !same.url, `a pasta da janela principal ganhou outra janela: ${JSON.stringify(same)}`);
  // Outra pasta no mesmo servidor: janela própria.
  const url = (await h.rpc('window.open', { hostId: HOST, folder: OUTRA })).url;
  assert(url, 'outra pasta do mesmo servidor deveria abrir janela própria');
  const p2 = await env.browser.newPage();
  let wid;
  let sids;
  try {
    await p2.goto(url, { waitUntil: 'networkidle2' });
    const h2 = helpers(p2);
    await p2.waitForSelector('.chat-header', { timeout: 20000 });
    await h2.waitIdle(30000);
    await p2.bringToFront();
    await h2.send('echo projeto-ssh-1');
    await h2.waitText('.msg .md', 'projeto-ssh-1', 20000);
    await h2.waitIdle(30000);
    await p2.click('.chat-header button[title="Nova conversa na mesma pasta"]');
    await h2.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 2, 12000, 'segunda conversa remota');
    await h2.send('echo projeto-ssh-2');
    await h2.waitText('.msg .md', 'projeto-ssh-2', 20000);
    await h2.waitIdle(30000);
    wid = await p2.evaluate(() => sessionStorage.getItem('deck.wid'));
    const mine = (await h.rpc('sessions.list')).filter((s) => s.wid === wid);
    assert(mine.length === 2 && mine.every((s) => s.hostId === HOST && s.cwd === OUTRA), 'as duas conversas devem estar na mesma pasta e janela do servidor de teste');
    sids = mine.map((s) => s.sid);
    // Com ela aberta, pedir a mesma pasta não abre segunda janela.
    const again = await h.rpc('window.open', { hostId: HOST, folder: OUTRA });
    assert(again.wid === wid && !again.url, `a mesma pasta SSH ganhou segunda janela: ${JSON.stringify(again)}`);
    await sleep(1100);
  } finally {
    await p2.close().catch(() => {});
  }

  // O runner remoto continua, mas a janela fechou e o servidor do app reiniciou.
  await env.restartServer();
  const url2 = (await h.rpc('window.open', { hostId: HOST, folder: OUTRA })).url;
  const p3 = await env.browser.newPage();
  try {
    await p3.goto(url2, { waitUntil: 'networkidle2' });
    const h3 = helpers(p3);
    await h3.waitFor(() => document.querySelectorAll('.center .tabs .tab').length === 2, 20000, 'duas conversas remotas restauradas');
    const wid3 = await p3.evaluate(() => sessionStorage.getItem('deck.wid'));
    assert(wid3 === wid, `janela remota mudou de identidade (${wid} x ${wid3})`);
    const mine = (await h.rpc('sessions.list')).filter((s) => s.wid === wid3);
    assert(JSON.stringify(mine.map((s) => s.sid)) === JSON.stringify(sids), 'abriu conversa SSH nova ou perdeu uma das duas anteriores');
    await h3.waitText('.msg .md', 'projeto-ssh-2', 20000);
    await p3.screenshot({ path: path.join(SHOTS, 'janela-remota-restaurada.png') });
  } finally {
    await p3.close().catch(() => {});
  }
});

await step('Sem erros no console da página', async () => {
  const errs = env.app.errors.filter((e) => !/favicon/i.test(e));
  assert(!errs.length, errs.join(' | '));
});

// ---------------------------------------------------------------- fim
let mem = null;
try {
  const m = await page.metrics();
  mem = { jsHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes };
} catch {
  /* ignora */
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(SHOTS, 'relatorio.json'), JSON.stringify({ when: new Date().toISOString(), host: HOST, results, mem }, null, 2));
if (failed.length) fs.writeFileSync(path.join(SHOTS, 'server.log'), env.serverLog());
await env.stop({ keep: !!process.env.E2E_KEEP || failed.length > 0 });
const cleaned = cleanupRemote();
console.log(`\n${results.length - failed.length}/${results.length} passos ok${mem ? ` · heap JS da página ${mem.jsHeapMB} MB` : ''} · limpeza no servidor: ${cleaned ? 'ok' : 'FALHOU'}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
process.exit(failed.length ? 1 : 0);
