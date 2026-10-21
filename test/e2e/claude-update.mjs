// E2E do botão "Atualizar Claude Code": interface real + servidor de teste (DECK_TEST_HOST) por SSH.
// No servidor entra um "claude" FALSO em ~/bin/claude (nunca sobrescreve um que já exista): responde
// --version e update como um Claude Code de verdade e, para o resto, repassa ao Claude falso de conversa.
// A versão "mais nova" é forçada em 99.0.0 (ganchos de teste). O Claude de verdade do servidor não é tocado.
//
//   node test/e2e/claude-update.mjs        (DECK_TEST_HOST=<alias>; E2E_HEADFUL=1 mostra a janela)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startEnv, helpers, ROOT } from './harness.mjs';

const HOST = process.env.DECK_TEST_HOST;
if (!HOST) {
  console.log('DECK_TEST_HOST não definido. Pulando o E2E do botão de atualizar o Claude Code.');
  process.exit(0);
}
if (process.env.DECK_SKIP_HOSTS && new RegExp(process.env.DECK_SKIP_HOSTS, 'i').test(HOST)) {
  throw new Error('Servidor marcado em DECK_SKIP_HOSTS: não usar para testes.');
}
const SHOTS = path.join(ROOT, 'test', 'shots', 'e2e-claude-update');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const RAND = crypto.randomBytes(4).toString('hex');
const BASE = `/tmp/deck-e2e-upd-${RAND}`;
const PROJ = `${BASE}/proj`;
const FAKE_CHAT = `${BASE}/fake-claude.mjs`;
const STATE = '$HOME/.cache/claude-deck-it-e2e';
const PROJ_KEY = PROJ.replace(/[^a-zA-Z0-9]/g, '-');

const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, cmd], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
const scp = (cwd, src, dst) => execFileSync('scp', ['-q', '-r', '-o', 'BatchMode=yes', src, `${HOST}:${dst}`], { cwd, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
const setFake = (ver, mode, target = '99.0.0') => ssh(`printf %s ${ver} > ${STATE}/ver; printf %s ${mode} > ${STATE}/mode; printf %s ${target} > ${STATE}/target`);
const fakeVersion = () => ssh(`cat ${STATE}/ver`).trim();

let createdBinDir = false;
function cleanupRemote() {
  try {
    ssh(
      `for d in "$HOME"/.cache/claude-deck/s/*; do [ -f "$d/cwd" ] && grep -q '^${BASE}' "$d/cwd" && { kill $(cat "$d/pid" 2>/dev/null) 2>/dev/null; rm -rf "$d"; }; done; ` +
        `rm -rf '${BASE}' "$HOME/.claude/projects/${PROJ_KEY}" ${STATE} "$HOME/bin/claude"; ${createdBinDir ? 'rmdir "$HOME/bin" 2>/dev/null;' : ''} echo limpo`,
    );
    return true;
  } catch (e) {
    console.log(`  (limpeza remota falhou: ${String(e.message).split('\n')[0]})`);
    return false;
  }
}

// ---------------------------------------------------------------- preparação no servidor
if (ssh(`[ -e "$HOME/bin/claude" ] && echo SIM || echo NAO`).trim() === 'SIM') throw new Error(`~/bin/claude já existe em ${HOST}; o teste não vai sobrescrever.`);
createdBinDir = ssh(`[ -d "$HOME/bin" ] && echo SIM || echo NAO`).trim() === 'NAO';
const HOME_DIR = ssh('printf %s "$HOME"').trim();
ssh(`mkdir -p '${BASE}' '${PROJ}' "$HOME/bin" ${STATE} && chmod 700 '${BASE}'`);
scp(path.join(ROOT, 'test', 'fake-claude'), 'fake-claude.mjs', FAKE_CHAT);
const WRAPPER = `#!/bin/sh
D="$HOME/.cache/claude-deck-it-e2e"
case "$1" in
  --version) echo "$(cat "$D/ver") (Claude Code)"; exit 0 ;;
  update)
    echo x >> "$D/calls"
    case "$(cat "$D/mode")" in
      ok) echo "Updating..."; sleep 2; cp "$D/target" "$D/ver"; echo "Updated"; exit 0 ;;
      noop) echo "Already up to date"; exit 0 ;;
      fail) echo "EACCES: permission denied, rename /usr/lib/node_modules" >&2; exit 1 ;;
    esac ;;
esac
exec "${FAKE_CHAT}" "$@"
`;
execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, `cat > "$HOME/bin/claude" && chmod 755 "$HOME/bin/claude" "${FAKE_CHAT}" && : > ${STATE}/calls`], { input: WRAPPER, timeout: 60_000 });
setFake('2.1.205', 'ok');
console.log(`Claude Deck E2E atualizar Claude Code — ${HOST}:${BASE}`);

const env = await startEnv({
  useRealSsh: true,
  settings: { hostClaudePath: { [HOST]: `${HOME_DIR}/bin/claude` } },
  env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_TEST_LATEST: '99.0.0' },
});
const { page } = env;
const h = helpers(page);
const { assert, waitText, waitFor, clickText, hotkey, waitIdle } = h;
console.log(`  porta ${env.port}\n`);

const results = [];
let shotN = 0;
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) });
async function step(name, fn) {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`ok (${Date.now() - t} ms)`);
  } catch (e) {
    const dump = await page
      .evaluate(() => ({
        status: document.querySelector('.statusbar')?.textContent,
        dialog: document.querySelector('.dialog')?.textContent?.slice(0, 200) ?? null,
        toasts: [...document.querySelectorAll('.toast')].map((x) => x.textContent),
      }))
      .catch(() => null);
    results.push({ name, ok: false, ms: Date.now() - t, error: String(e?.message ?? e), dump });
    console.log(`FALHOU: ${String(e?.message ?? e).split('\n')[0]}\n    estado: ${JSON.stringify(dump)}`);
    await shot(`FALHA-${name.replace(/[^\wÀ-ú-]+/g, '_').slice(0, 40)}`).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}
const statusText = () => page.evaluate(() => document.querySelector('.statusbar')?.textContent ?? '');
const hasUpdateBtn = () => page.evaluate(() => !!document.querySelector('.statusbar .sb-claude-update'));
const reconnect = () => h.rpc('hosts.connect', { id: process.env.DECK_TEST_HOST, force: true });
const clickUpdate = async () => {
  await page.click('.statusbar .sb-claude-update');
  await waitText('.dialog .dialog-head', 'Atualizar o Claude Code em');
};

await step('ao abrir o servidor já avisa: Claude 2.1.205 → 99.0.0 · Atualizar', async () => {
  await page.waitForSelector('.empty-chat, .chat-header');
  await hotkey('Control', 'Shift', 'N');
  await waitText('.quickpick .qp-title', 'escolha o servidor');
  await page.keyboard.type(HOST);
  await waitFor((n) => document.querySelector('.quickpick .qp-item.active .label')?.textContent === n, 5000, 'servidor filtrado', HOST);
  await page.keyboard.press('Enter');
  await waitText('.quickpick .qp-title', 'escolha a pasta');
  await page.keyboard.type(PROJ);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.chat-header', { timeout: 30000 });
  await waitIdle(60000);
  await waitText('.statusbar .sb-claude-update', '2.1.205 → 99.0.0');
  await waitText('.statusbar .sb-claude-update', 'Atualizar');
  await shot('aviso-na-barra');
});

await step('o ícone aparece na linha do servidor e o menu tem "Atualizar Claude Code…"', async () => {
  await page.click('.statusbar .sb-remote');
  await page.waitForSelector('.side-body .claude-update-btn', { timeout: 8000 });
  const title = await page.$eval('.side-body .claude-update-btn', (b) => b.title);
  assert(title.includes('2.1.205') && title.includes('99.0.0'), `dica do ícone sem as versões: ${title}`);
  await shot('aviso-na-lista');
});

await step('cancelar a confirmação não atualiza nada', async () => {
  await clickUpdate();
  await waitText('.dialog', '2.1.205 → 99.0.0');
  await clickText('.dialog .dialog-foot .btn', 'Cancelar');
  await waitFor(() => !document.querySelector('.dialog'), 5000, 'diálogo fechado');
  assert(fakeVersion() === '2.1.205', 'cancelou, mas a versão no servidor mudou');
  assert((await hasUpdateBtn()) === true, 'o aviso sumiu sem atualizar');
});

await step('confirmar: mostra "Atualizando…", sobe a versão no servidor e o aviso some', async () => {
  await clickUpdate();
  await clickText('.dialog .dialog-foot .btn', 'Atualizar');
  await waitText('.statusbar .sb-claude-update', 'Atualizando…'); // o claude falso dorme 2 s
  await shot('atualizando');
  await waitText('.toast', '2.1.205 → 99.0.0', 30000);
  await waitFor(() => !document.querySelector('.statusbar .sb-claude-update'), 15000, 'aviso some');
  await waitText('.statusbar', 'Claude 99.0.0');
  assert(fakeVersion() === '99.0.0', `versão no servidor: ${fakeVersion()}`);
  assert(ssh(`wc -l < ${STATE}/calls`).trim() === '1', 'o claude update deveria ter rodado uma vez');
  await shot('atualizado');
});

await step('servidor numa versão que o canal dele não passa: avisa "já está na mais nova" e para de oferecer', async () => {
  setFake('2.1.206', 'noop');
  await reconnect();
  await waitText('.statusbar .sb-claude-update', '2.1.206 → 99.0.0');
  await clickUpdate();
  await clickText('.dialog .dialog-foot .btn', 'Atualizar');
  await waitText('.toast', 'já está na versão mais nova disponível para ele (2.1.206)', 30000);
  await waitFor(() => !document.querySelector('.statusbar .sb-claude-update'), 10000, 'aviso some');
});

await step('erro no claude update: mostra o motivo e o aviso continua', async () => {
  setFake('2.1.207', 'fail');
  await reconnect();
  await waitText('.statusbar .sb-claude-update', '2.1.207 → 99.0.0');
  await clickUpdate();
  await clickText('.dialog .dialog-foot .btn', 'Atualizar');
  await waitText('.toast', 'EACCES', 30000);
  await waitText('.toast', 'Não atualizei o Claude Code em', 5000);
  assert((await hasUpdateBtn()) === true, 'o aviso deveria continuar depois de um erro');
  assert(fakeVersion() === '2.1.207', 'a versão mudou mesmo com erro');
  await shot('erro');
});

await step('Sem erros no console da página', async () => {
  const errs = env.app.errors.filter((e) => !/favicon/i.test(e));
  assert(!errs.length, errs.join(' | '));
});

// ---------------------------------------------------------------- fim
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(SHOTS, 'relatorio.json'), JSON.stringify({ when: new Date().toISOString(), host: HOST, results }, null, 2));
if (failed.length) fs.writeFileSync(path.join(SHOTS, 'server.log'), env.serverLog());
await env.stop({ keep: failed.length > 0 });
const cleaned = cleanupRemote();
console.log(`\n${results.length - failed.length}/${results.length} passos ok · limpeza no servidor: ${cleaned ? 'ok' : 'FALHOU'}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
process.exit(failed.length ? 1 : 0);
