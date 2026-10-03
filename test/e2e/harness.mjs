// Ambiente isolado para os testes de interface: servidor real do Claude Deck + Brave (perfil
// temporário) + "Claude falso". Nada toca o ~/.claude, o ~/.ssh nem o Brave do dia a dia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openApp } from './browser.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
/** Projeto de teste (copiado para uma pasta temporária a cada execução; o original nunca muda). */
export const SANDBOX = process.env.E2E_SANDBOX || path.join(ROOT, 'test', 'fixtures', 'sandbox');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function health(port) {
  return new Promise((res) =>
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
        r.resume();
        res(r.statusCode === 200);
      })
      .on('error', () => res(false)),
  );
}

/**
 * Sobe servidor + navegador.
 * opts: sandboxSrc (pasta copiada como projeto de teste), settings, sshConfig (texto),
 *       env (variáveis extras do servidor), headless, width, height, useRealSsh (usa ~/.ssh de verdade)
 */
export async function startEnv(opts = {}) {
  const port = opts.port || 47500 + Math.floor(Math.random() * 400);
  const dataDir = tmp('deck-e2e-data-');
  const claudeDir = tmp('deck-e2e-claude-');
  const sshDir = opts.useRealSsh ? path.join(os.homedir(), '.ssh') : tmp('deck-e2e-ssh-');
  const sandbox = tmp('deck-e2e-sb-');
  const uploads = tmp('deck-e2e-up-');
  if (opts.sandboxSrc) fs.cpSync(opts.sandboxSrc, sandbox, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ localClaudePath: FAKE, defaultPermissionMode: 'default', notifications: false, ...(opts.settings ?? {}) }),
  );
  if (!opts.useRealSsh) fs.writeFileSync(path.join(sshDir, 'config'), opts.sshConfig ?? '');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, ...(opts.useRealSsh ? {} : { CLAUDE_DECK_SSH_DIR: sshDir }), ...(opts.env ?? {}) };
  let serverOut = '';
  const spawnServer = async () => {
    // E2E_WEB_DIR: serve uma interface compilada em outra pasta (ex.: `vite build --outDir`), sem mexer no dist/web em uso.
    const webDir = process.env.E2E_WEB_DIR ? ['--web-dir', process.env.E2E_WEB_DIR] : [];
    const s = spawn(process.execPath, [process.env.E2E_SERVER_FILE || path.join(ROOT, 'dist', 'server.mjs'), '--port', String(port), '--data-dir', dataDir, '--no-import', '--quiet', ...webDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    s.stdout.on('data', (d) => (serverOut += d));
    s.stderr.on('data', (d) => (serverOut += d));
    for (let i = 0; i < 100 && !(await health(port)); i++) await sleep(100);
    if (!(await health(port))) throw new Error('O servidor não subiu:\n' + serverOut);
    return s;
  };
  const killServer = (s) => {
    try {
      execFileSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      s.kill();
    }
  };
  let server = await spawnServer();
  const app = await openApp({ port, dataDir, headless: opts.headless ?? !process.env.E2E_HEADFUL, width: opts.width, height: opts.height });
  await app.browser
    .defaultBrowserContext()
    .overridePermissions(`http://127.0.0.1:${port}`, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
    .catch(() => {});
  const dirs = [dataDir, claudeDir, sandbox, uploads, ...(opts.useRealSsh ? [] : [sshDir])];
  return {
    port,
    app,
    page: app.page,
    browser: app.browser,
    get server() {
      return server;
    },
    /** Mata o servidor sem aviso (como uma queda) e sobe de novo com os mesmos dados. */
    async restartServer() {
      killServer(server);
      for (let i = 0; i < 50 && (await health(port)); i++) await sleep(100);
      server = await spawnServer();
    },
    dataDir,
    claudeDir,
    sshDir,
    sandbox,
    uploads,
    serverLog: () => serverOut + (fs.existsSync(path.join(dataDir, 'server.log')) ? fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8') : ''),
    async stop({ keep = false } = {}) {
      await app.close().catch(() => {});
      killServer(server);
      if (!keep)
        for (const d of dirs) {
          try {
            fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          } catch {
            /* arquivo ainda em uso: fica para a limpeza do sistema */
          }
        }
    },
  };
}

/**
 * Leitor de .zip independente do gerador do app (percorre o diretório central e confere CRC/tamanho).
 * Devolve [{ name, dir, data, ok }] — `ok` é false se o CRC ou o tamanho não bater.
 */
export function readZipEntries(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 70000; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('não é um zip (sem fim de diretório central)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('diretório central corrompido');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.push({ name, dir: name.endsWith('/'), data, ok: data.length === usize && zlib.crc32(data) === crc });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Ajudantes de interação com a página. */
export function helpers(page) {
  const h = {
    assert(cond, msg) {
      if (!cond) throw new Error(msg);
    },
    /** Simula o arrasto do sistema (Windows Explorer → janela): solta arquivos/pastas reais no ponto dado. */
    async dropOs(point, files) {
      const data = { items: [], files, dragOperationsMask: 1 };
      await page.mouse.dragEnter(point, data);
      await page.mouse.dragOver(point, data);
      await page.mouse.drop(point, data);
    },
    /** Ponto sobre a linha do explorador com esse nome. */
    async rowPoint(name) {
      const b = await (await h.findTreeRow(name)).boundingBox();
      return { x: b.x + 30, y: b.y + b.height / 2 };
    },
    /**
     * Começa a arrastar uma linha do explorador com o mouse de verdade (interceptando o arrasto) e devolve
     * os dados que sairiam para o sistema — inclusive o `DownloadURL` que o Windows Explorer usaria ao soltar.
     */
    async dragOutOf(name) {
      const from = await h.rowPoint(name);
      await page.mouse.move(from.x, from.y);
      await sleep(500); // deixa o link de download ser preparado ao passar o mouse
      await page.setDragInterception(true);
      // Termina o arrasto dentro da própria janela, num lugar que não reage a ele: a barra de status.
      // (Soltar sobre uma pasta do explorador MOVE o item, e sobre a conversa vira @menção.)
      const sb = await (await page.$('.statusbar')).boundingBox();
      const to = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
      const data = await page.mouse.drag(from, to);
      await page.mouse.dragEnter(to, data);
      await page.mouse.dragOver(to, data);
      await page.mouse.drop(to, data);
      await page.mouse.up();
      await page.setDragInterception(false);
      return data.items.map((i) => ({ type: i.mimeType, data: i.data }));
    },
    /**
     * Arrasta uma linha do explorador (com o mouse de verdade) e solta no ponto dado: outra linha, o espaço vazio...
     * É o arrasto interno do app (mover de pasta), não o do Windows.
     */
    async dragRowTo(name, point) {
      const from = await h.rowPoint(name);
      await page.mouse.move(from.x, from.y);
      await sleep(300);
      await page.setDragInterception(true);
      const data = await page.mouse.drag(from, point);
      await page.mouse.dragEnter(point, data);
      await page.mouse.dragOver(point, data);
      await page.mouse.drop(point, data);
      await page.mouse.up();
      await page.setDragInterception(false);
    },
    async waitText(sel, text, timeout = 15000) {
      await page
        .waitForFunction((s, t) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(t)), { timeout, polling: 100 }, sel, text)
        .catch(() => {
          throw new Error(`não apareceu "${text}" em ${sel}`);
        });
    },
    async waitFor(fn, timeout = 15000, label = 'condição', ...args) {
      await page.waitForFunction(fn, { timeout, polling: 100 }, ...args).catch(() => {
        throw new Error(`tempo esgotado esperando ${label}`);
      });
    },
    async findByText(sel, text, exact = false) {
      const handle = await page.evaluateHandle(
        (s, t, ex) => [...document.querySelectorAll(s)].find((e) => (ex ? e.textContent.trim() === t : e.textContent.includes(t))) ?? null,
        sel,
        text,
        exact,
      );
      const el = handle.asElement();
      if (!el) throw new Error(`não achei "${text}" em ${sel}`);
      return el;
    },
    async clickText(sel, text, exact = false) {
      await (await h.findByText(sel, text, exact)).click();
    },
    async hotkey(...keys) {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
    },
    async typeComposer(text) {
      await page.focus('.composer textarea');
      await page.keyboard.type(text);
    },
    async send(text) {
      await h.typeComposer(text);
      await page.keyboard.press('Enter');
    },
    async clearComposer() {
      await page.focus('.composer textarea');
      await h.hotkey('Control', 'a');
      await page.keyboard.press('Backspace');
    },
    composerValue: () => page.$eval('.composer textarea', (e) => e.value),
    async waitIdle(timeout = 20000) {
      await h.waitFor(
        () =>
          (document.querySelector('.phase-pill.idle') && !document.querySelector('.send-btn.stop')) ||
          (document.querySelector('.composer-bar .agents-pill') && !document.querySelector('.stream-caret-wrap')),
        timeout,
        'conversa ficar pronta',
      );
    },
    count: (sel) => page.$$eval(sel, (e) => e.length),
    async findTreeRow(name) {
      await h.waitFor((n) => [...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent === n), 10000, `"${name}" no explorador`, name);
      const handle = await page.evaluateHandle((n) => [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.querySelector('.label')?.textContent === n), name);
      return handle.asElement();
    },
    async clickTree(name) {
      await (await h.findTreeRow(name)).click();
    },
    async waitActiveFile(name, timeout = 10000) {
      await h.waitFor((n) => document.querySelector('.editor-panel .tab.active .tab-label')?.textContent === n, timeout, `arquivo ativo ${name}`, name);
    },
    async menu(text) {
      await page.waitForSelector('.ctxmenu', { visible: true, timeout: 5000 });
      await h.clickText('.ctxmenu .mi', text);
    },
    /** Chamada RPC direta ao servidor (conexão WebSocket própria, com o cookie da página). */
    rpc: (method, params) =>
      page.evaluate(
        (m, p) =>
          new Promise((res, rej) => {
            const ws = new WebSocket(`ws://${location.host}/ws`);
            const t = setTimeout(() => (ws.close(), rej(new Error(`rpc ${m}: tempo esgotado`))), 60000);
            ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: m, params: p }));
            ws.onmessage = (e) => {
              const x = JSON.parse(e.data);
              if (x.id !== 1) return;
              clearTimeout(t);
              ws.close();
              x.error ? rej(new Error(x.error.message)) : res(x.result);
            };
            ws.onerror = () => (clearTimeout(t), rej(new Error(`rpc ${m}: erro no WebSocket`)));
          }),
        method,
        params,
      ),
    chatTabs: () => page.$$eval('.center .tabs .tab', (e) => e.length),
    activeChatLabel: () => page.$eval('.center .tabs .tab.active .tab-label', (e) => e.textContent).catch(() => null),
    /** Nova conversa local numa pasta (pelo seletor Ctrl+Shift+N). */
    async newLocalChat(folder) {
      await page.waitForSelector('.empty-chat, .chat-header');
      await h.hotkey('Control', 'Shift', 'N');
      await h.waitText('.quickpick .qp-title', 'escolha o servidor');
      await h.waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor');
      await page.keyboard.press('Enter');
      await h.waitText('.quickpick .qp-title', 'escolha a pasta');
      await h.waitFor(() => document.activeElement === document.querySelector('.quickpick input'), 3000, 'foco no seletor de pasta');
      await page.keyboard.type(folder);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.chat-header', { timeout: 10000 });
      await h.waitIdle();
    },
  };
  return h;
}
