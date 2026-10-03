// Copiar/colar em janelas Brave isoladas. `--remote`: SFTP remoto via DECK_TEST_HOST, com Claude falso.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startEnv, helpers, SANDBOX, ROOT } from './harness.mjs';
import { copyItem, latestCopy, pasteRoot, runFileCopyChecks } from './file-copy-checks.mjs';

const remote = process.argv.includes('--remote');
const HOST = process.env.DECK_TEST_HOST || 'srv-teste';
const SECOND = 'COPY-TEST-SECOND';
if (remote && !process.env.DECK_TEST_HOST) {
  console.log('DECK_TEST_HOST não definido. Pulando testes de cópia remota via SSH.');
  process.exit(0);
}
const base = `/tmp/deck-copy-e2e-${crypto.randomBytes(6).toString('hex')}`;
const fake = `${base}/fake-claude.mjs`;
const ssh = (command) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, command], { encoding: 'utf8', timeout: 90000 });
let config = '', remoteReady = false;
if (remote) {
  const resolved = execFileSync('ssh', ['-G', HOST], { encoding: 'utf8' });
  const values = (k) => resolved.split(/\r?\n/).filter((s) => s.startsWith(`${k} `)).map((s) => s.slice(k.length + 1));
  if (values('proxyjump').some((v) => v !== 'none')) throw new Error('ProxyJump não suportado no teste de cópia.');
  const home = (p) => p.replace(/^~/, os.homedir());
  const block = (alias) => {
    const lines = [`Host ${alias}`, ` HostName ${values('hostname')[0]}`, ` User ${values('user')[0]}`, ` Port ${values('port')[0]}`, ' StrictHostKeyChecking yes', ` UserKnownHostsFile "${path.join(os.homedir(), '.ssh', 'known_hosts')}"`];
    for (const key of values('identityfile').map(home)) if (fs.existsSync(key)) lines.push(` IdentityFile "${key}"`);
    return lines.join('\n');
  };
  config = `${block(HOST)}\n\n${block(SECOND)}\n`;
  ssh(`mkdir -p '${base}/A/sub' '${base}/B' && chmod 700 '${base}'`); remoteReady = true;
  execFileSync('scp', ['-q', '-o', 'BatchMode=yes', path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs'), `${HOST}:${fake}`], { timeout: 90000 });
  ssh(`chmod 755 '${fake}'`);
}
const env = await startEnv({
  sandboxSrc: SANDBOX, sshConfig: config, env: { CLAUDE_DECK_TEST_HOOKS: '1' },
  settings: remote ? { hostClaudePath: { [HOST]: fake, [SECOND]: fake } } : {},
});
const shots = path.join(ROOT, 'test', 'shots', 'file-copy'); fs.mkdirSync(shots, { recursive: true });
try {
  const h = helpers(env.page);
  await h.newLocalChat(env.sandbox);
  await runFileCopyChecks(env);
  console.log('OK: local entre janelas, Ctrl+C/V, conflito, reload, cancelamento e rascunho preservado');
  if (remote) {
    const data = crypto.randomBytes(6 * 1024 * 1024);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    fs.writeFileSync(path.join(env.sandbox, 'sftp.bin'), data);
    const windows = [];
    async function open(hostId, folder) {
      const target = await h.rpc('window.open', { hostId, folder });
      const page = await env.browser.newPage(); windows.push(page);
      await page.goto(target.url, { waitUntil: 'networkidle2' });
      await page.waitForSelector('.explorer-body', { timeout: 60000 });
      return { page, h: helpers(page) };
    }
    try {
      const local = { page: env.page, h };
      await env.page.bringToFront();
      await env.page.click('.explorer-body .icon-btn[title="Atualizar"]');
      const A = await open(HOST, `${base}/A`), B = await open(SECOND, `${base}/B`);
      await copyItem(local, 'sftp.bin'); await pasteRoot(A); await latestCopy(A, 'Concluída', 90000); await A.page.keyboard.press('Escape');
      h.assert(ssh(`sha256sum '${base}/A/sftp.bin'`).startsWith(hash), 'hash local→SSH errado');
      await copyItem(A, 'sftp.bin'); await pasteRoot(B); await latestCopy(B, 'Concluída', 90000); await B.page.keyboard.press('Escape');
      h.assert(ssh(`sha256sum '${base}/B/sftp.bin'`).startsWith(hash), 'hash entre duas conexões SFTP errado');
      // Alias diferente para o mesmo endpoint não contorna a guarda de "dentro da origem".
      const inside = await open(SECOND, `${base}/A/sub`);
      await A.page.bringToFront();
      await A.page.focus('.explorer-body .section-head'); await A.h.hotkey('Control', 'c'); await A.h.waitText('.toast', 'Copiado: A');
      await pasteRoot(inside); await latestCopy(inside, 'Falhou', 60000);
      await inside.h.waitText('.file-copy-error', 'dentro da própria pasta');
      h.assert(ssh(`find '${base}/A/sub' -mindepth 1 | wc -l`).trim() === '0', 'escreveu dentro da origem');
      await inside.page.keyboard.press('Escape');
      const L = await open('local', env.uploads);
      await copyItem(B, 'sftp.bin'); await pasteRoot(L); await latestCopy(L, 'Concluída', 90000); await L.page.keyboard.press('Escape');
      h.assert(crypto.createHash('sha256').update(fs.readFileSync(path.join(env.uploads, 'sftp.bin'))).digest('hex') === hash, 'hash SSH→local errado');
      h.assert(fs.existsSync(path.join(env.sandbox, 'sftp.bin')), 'origem local apagada');
      ssh(`printf 'novo\\n' > '${base}/A/sftp.bin'`);
      await A.page.bringToFront();
      await A.page.click('.explorer-body .icon-btn[title="Atualizar"]');
      await copyItem(A, 'sftp.bin'); await pasteRoot(B);
      await B.h.waitText('.dialog-head', 'Confirmar cópia'); await B.h.clickText('.dialog-foot .btn', 'Substituir arquivos existentes');
      await latestCopy(B, 'Concluída', 60000);
      h.assert(ssh(`cat '${base}/B/sftp.bin'`) === 'novo\n', 'substituição SFTP não aplicada');
      h.assert(ssh(`find '${base}' -name '.deck-copy-*' | wc -l`).trim() === '0', 'sobrou temporário de cópia');
      await B.page.screenshot({ path: path.join(shots, 'sftp-duas-janelas.png') });
      console.log('OK: local→SSH→SSH→local com SHA-256, alias equivalente bloqueado e substituição SFTP');
    } finally { for (const p of windows) await p.close().catch(() => {}); }
  }
  if (env.app.errors.length) throw new Error(env.app.errors.join('\n'));
} catch (e) {
  await env.page.screenshot({ path: path.join(shots, 'falha.png') }).catch(() => {});
  console.error(env.serverLog().slice(-12000)); throw e;
} finally {
  await env.stop();
  if (remoteReady) ssh(`for d in "$HOME"/.cache/claude-deck/s/*; do [ -f "$d/cwd" ] && grep -q '^${base}' "$d/cwd" && { kill $(cat "$d/pid" 2>/dev/null) 2>/dev/null; rm -rf "$d"; }; done; rm -rf -- '${base}'; for k in '${base}/A' '${base}/B' '${base}/A/sub'; do rm -rf "$HOME/.claude/projects/$(printf %s "$k" | sed 's/[^a-zA-Z0-9]/-/g')"; done; echo limpo`);
}
