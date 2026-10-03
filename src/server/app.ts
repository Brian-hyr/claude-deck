// Servidor local do Claude Deck: HTTP (interface, arquivos, mídia) + WebSocket (RPC e eventos).
// Escuta só em 127.0.0.1, exige cookie de sessão (obtido com o token do atalho) e confere Host/Origin.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppPaths } from './config';
import { Store, loadOrCreateToken, writeJsonAtomic } from './config';
import { PromptBroker } from './prompts';
import { HostRegistry } from './hosts/registry';
import { SessionManager, type ClaudeSession, type TerminalBinder } from './claude/session';
import { HistoryCache, HistoryService, UNTITLED } from './claude/history';
import { importFromVscode } from './vscode/import';
import { formatHostBlock, listEntries, loadSshConfig } from './hosts/sshconfig';
import { FsConflictError, looksBinary, mkdirp, sortEntries, type HostFs } from './fs/hostfs';
import { walkZipItems, zipChunks } from './fs/zip';
import { FileTransfers } from './fs/transfers';
import { FileEditGuards } from './fs/editguards';
import { copyPath } from './fs/copyfs';
import { receivesSessionMsg } from './routing';
import { WID_RE, attachWindow, contextKey, getWindowContext, migrateLegacyWindows, pruneWindows, reconcileWindowSessions, sameContext, saveWindowState } from './windows';
import { buildOpenUrl, launchWindow, focusWindow, BROWSER_IDS, findBrowser, resolveBrowser, type BrowserSelection } from './browser';
import { TaskbarBadge, summarizeBadge } from './taskbar';
import { OPEN_RE, isValidTarget, type OpenTarget } from '../shared/openwin';
import { DeckError, type RpcRequest } from '../shared/protocol';
import { LOCAL_HOST_ID, type BrowserId, type FileEntry, type ManualPendingConversation, type ReadResult, type SearchResult, type UiState } from '../shared/types';
import { isAbsolute, relativeTo } from '../shared/paths';
import { contentTypeFor } from './mime';
import { TerminalManager } from './terminal/manager';
import { TerminalAgent } from './terminal/agent';
import { isFocusReport, isTerminalReport } from '../shared/terminalProtocol';

export const APP_VERSION = '1.0.0';
const BOOT_ID = crypto.randomUUID();
/** Métodos que uma versão anterior do servidor não tinha (ver `on`, modo de teste). */
const OLD_SERVER_MISSING = new Set(['fs.mkdirp', 'fs.existsMany', 'dl.ticket', 'history.agent', 'sessions.stopTask', 'fileClipboard.set', 'fileClipboard.get', 'fileClipboard.clear', 'fileCopy.start', 'fileCopy.list', 'fileCopy.get', 'fileCopy.resolve', 'fileCopy.cancel', 'fileCopy.edits', 'fileCopy.ack']);

export interface ServerOptions {
  port: number;
  paths: AppPaths;
  webDir: string;
  /** Desliga a importação do VS Code (testes). */
  skipVscodeImport?: boolean;
  quiet?: boolean;
}

type Handler = (params: any, client: Client) => Promise<any> | any;

interface Client {
  ws: WebSocket;
  id: number;
  /** Janela do app a que esta conexão pertence (definido em `window.attach`). */
  wid?: string;
}

export class DeckServer {
  store: Store;
  prompts = new PromptBroker();
  registry: HostRegistry;
  sessions: SessionManager;
  history: HistoryService;
  historyCache: HistoryCache;
  terminalManager: TerminalManager;
  transfers: FileTransfers;
  private editGuards: FileEditGuards;
  token: string;
  private cookieValue: string;
  /** Códigos de uso único do atalho (código → vencimento). */
  private launchCodes = new Map<string, number>();
  private http: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private clientSeq = 0;
  private handlers = new Map<string, Handler>();
  private previews = new Map<string, { hostId: string; root: string; expires: number }>();
  /** Links de download que não dependem do cookie (arrastar para fora do app: o navegador baixa sozinho). */
  private dlTickets = new Map<string, { hostId: string; path: string; zip: boolean; expires: number }>();
  private logStream: fs.WriteStream;
  private wakeTimer: NodeJS.Timeout | null = null;
  /** Aberturas de janela em andamento (contexto → vencimento): dois cliques não abrem duas janelas. */
  private pendingOpens = new Map<string, number>();
  /** Quando cada janela desconectou (para distinguir "fechei esta janela" de "fechei o app/desliguei"). */
  private closedAt = new Map<string, number>();
  private startedAt = Date.now();
  /** Desde quando cada janela está conectada sem interrupção (para saber quem "ficou aberta"). */
  private liveSince = new Map<string, number>();
  private stopping = false;
  /** Só nos testes: janelas que o servidor teria aberto no navegador selecionado. */
  private testLaunches: string[] = [];
  /** Data (ms) do arquivo do servidor que está rodando: o atalho compara com o do disco. */
  private buildStamp = 0;
  /** Selo numérico no botão do app na barra de tarefas (concluídas, com erro, esperando você). */
  private taskbarBadge: TaskbarBadge;
  /** Troca de navegador feita na interface só passa a valer após todas as janelas antigas fecharem. */
  private activeBrowser: BrowserSelection | null = null;
  port: number;

  constructor(private opts: ServerOptions) {
    const { paths } = opts;
    this.port = opts.port;
    try {
      this.buildStamp = Math.round(fs.statSync(process.argv[1]).mtimeMs);
    } catch {
      /* sem data do arquivo: o atalho não troca este servidor sozinho */
    }
    // Só nos testes automáticos: finge um servidor de versão antiga.
    if (process.env.CLAUDE_DECK_TEST_HOOKS === '1' && process.env.CLAUDE_DECK_BUILD_STAMP) this.buildStamp = Number(process.env.CLAUDE_DECK_BUILD_STAMP) || 0;
    try {
      if (fs.statSync(paths.logFile).size > 5 * 1024 * 1024) fs.renameSync(paths.logFile, paths.logFile + '.old');
    } catch {
      /* sem log anterior */
    }
    this.logStream = fs.createWriteStream(paths.logFile, { flags: 'a' });
    this.store = new Store(paths);
    try { this.activeBrowser = resolveBrowser(paths.dataDir); } catch { /* Seleção inexistente/inválida: o RPC informa; servidor continua acessível. */ }
    this.token = loadOrCreateToken(paths);
    this.cookieValue = crypto.createHmac('sha256', this.token).update('deck-cookie').digest('hex');
    this.registry = new HostRegistry(this.store, this.prompts, (m) => this.log(m));
    this.editGuards = new FileEditGuards({
      identity: (h) => this.registry.copyIdentity(h),
      platform: (h) => this.registry.get(h).platform,
      participants: (identity) => {
        const peers: { wid: string; hostId: string; path: string }[] = [];
        for (const c of this.clients) {
          if (!c.wid || c.ws.readyState !== 1) continue;
          for (const f of this.store.windows[c.wid]?.state.fileTabs ?? [])
            if (f.hostId && this.registry.exists(f.hostId) && this.registry.copyIdentity(f.hostId) === identity) peers.push({ wid: c.wid, hostId: f.hostId, path: f.path });
        }
        return peers;
      },
      send: (wid, event, data) => this.emitToWindow(wid, event, data),
      live: () => this.liveWids(),
    });
    this.transfers = new FileTransfers({
      platform: (h) => this.registry.get(h).platform,
      resolve: async (h) => ({ fs: await (await this.fsFor(h)).fs.copyFs(), identity: this.registry.copyIdentity(h) }),
      update: (job, wids) => { for (const wid of wids) this.emitToWindow(wid, 'fileCopy.state', job); },
      clipboard: (value) => this.broadcast('fileClipboard.changed', value),
      changed: (hostId, p) => {
        const identity = this.registry.copyIdentity(hostId);
        // Somente aliases do endpoint afetado, sem conectar a servidor nenhum por causa do aviso.
        const aliases = this.registry.list().filter((h) => this.registry.copyIdentity(h.id) === identity).map((h) => h.id);
        this.broadcast('fs.changed', { hostIds: aliases, path: p });
      },
      reserve: (identity, fsx, p) => this.editGuards.reserve(identity, fsx.platform, p),
    });
    this.historyCache = new HistoryCache(paths.historyCacheFile);
    this.history = new HistoryService(
      this.historyCache,
      () => new Set(this.store.hosts.archivedSessions),
      process.env.CLAUDE_CONFIG_DIR || undefined,
      // Identidade é servidor + sessão: a grafia da pasta (maiúsculas, barras) não pode esconder a marca.
      (hostId, sessionId) => this.store.isManualPending({ hostId, sessionId, cwd: '' }),
    );
    this.sessions = new SessionManager(
      this.registry,
      this.store,
      (m) => this.log(m),
      (s) => this.readSessionTitle(s),
      (s, t) => this.writeSessionTitle(s, t),
      (s) => this.readSessionProvisionalTitle(s),
    );
    this.terminalManager = new TerminalManager(this.registry, (m) => this.log(m));
    this.sessions.terminals = this.terminalBinder;
    this.taskbarBadge = new TaskbarBadge({
      profileDir: path.join(paths.dataDir, 'browser-profile'),
      browser: () => this.activeBrowser,
      compute: () =>
        summarizeBadge(
          [...this.sessions.sessions.values()].map((s) => ({
            wid: s.state.wid,
            phase: s.state.phase,
            unseen: s.state.unseen,
            manualPending: !!s.state.sessionId && this.store.isManualPending({ hostId: s.state.hostId, sessionId: s.state.sessionId, cwd: s.state.cwd }),
            waiting: s.pendingPermissions.size > 0,
          })),
          this.badgeWids(),
        ),
      log: (m) => this.log(m),
    });
    this.http = http.createServer((req, res) => this.onHttp(req, res).catch((e) => this.httpError(res, e)));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.http.on('upgrade', (req, socket, head) => {
      if (!this.checkHost(req) || !this.checkOrigin(req) || !this.hasCookie(req) || !req.url?.startsWith('/ws')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onWs(ws));
    });
    this.wire();
    this.registerHandlers();
  }

  log(msg: string) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    this.logStream.write(line);
    if (!this.opts.quiet) process.stdout.write(line);
  }

  async start(): Promise<void> {
    if (!this.opts.skipVscodeImport && !this.store.hosts.importedFromVscode) await this.importVscode().catch((e) => this.log(`importação do VS Code falhou: ${e.message}`));
    this.sessions.load();
    this.migrateLegacyState();
    this.reconcileSavedWindows(new Set());
    this.startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, '127.0.0.1', () => {
        const addr = this.http.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve();
      });
    });
    // Detecção de "acordou do sono": o relógio pula muito entre dois ticks.
    let last = Date.now();
    this.wakeTimer = setInterval(() => {
      const now = Date.now();
      if (now - last > 30_000) {
        this.log(`retomada após ${Math.round((now - last) / 1000)}s parado (sono?): testando conexões`);
        this.registry.probeAll().finally(() => this.sessions.onWake());
      }
      last = now;
    }, 5000);
    this.wakeTimer.unref();
    this.log(`Claude Deck ${APP_VERSION} ouvindo em http://127.0.0.1:${this.port}`);
  }

  async stop() {
    this.stopping = true;
    await this.transfers.shutdown();
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.taskbarBadge.dispose();
    this.terminalManager.closeAll();
    this.sessions.shutdown();
    this.historyCache.flush();
    try {
      this.store.flush();
    } catch {
      /* ignora */
    }
    for (const c of this.clients) c.ws.close();
    this.registry.closeAll();
    await new Promise<void>((r) => this.http.close(() => r()));
    this.logStream.end();
  }

  // ---------------------------------------------------------------- importação

  async importVscode() {
    const imp = await importFromVscode();
    const known = new Set(listEntries(loadSshConfig(this.store.paths.sshDir)).map((e) => e.alias));
    const hosts = this.store.hosts;
    // Mais recente por último, para que addRecent deixe o mais recente no topo.
    for (const f of [...imp.folders].reverse()) {
      if (f.hostId !== LOCAL_HOST_ID && !known.has(f.hostId)) continue;
      const list = (hosts.recentFolders[f.hostId] ?? []).filter((p) => p !== f.path);
      list.unshift(f.path);
      hosts.recentFolders[f.hostId] = list.slice(0, 15);
    }
    const favOrder: string[] = [];
    for (const f of imp.folders) if (f.hostId !== LOCAL_HOST_ID && known.has(f.hostId) && !favOrder.includes(f.hostId)) favOrder.push(f.hostId);
    hosts.favorites = [...new Set([...hosts.favorites, ...favOrder])];
    hosts.archivedSessions = [...new Set([...hosts.archivedSessions, ...imp.archivedSessions])];
    if (!hosts.recentFolders[LOCAL_HOST_ID]?.length) hosts.recentFolders[LOCAL_HOST_ID] = [os.homedir()];
    hosts.importedFromVscode = true;
    this.store.saveHosts();
    if (imp.defaultPermissionMode) this.store.setSettings({ defaultPermissionMode: imp.defaultPermissionMode });
    this.log(`importado do VS Code: ${imp.folders.length} pastas, ${favOrder.length} servidores favoritos, ${imp.archivedSessions.length} conversas arquivadas`);
  }

  // ---------------------------------------------------------------- eventos

  private wire() {
    this.registry.on('status', (st) => this.broadcast('host.status', st));
    this.prompts.on('prompt', (p) => this.broadcast('auth.prompt', p));
    this.prompts.on('closed', (id) => this.broadcast('auth.closed', { promptId: id }));
    this.sessions.on('state', (st) => {
      this.broadcast('session.state', st);
      this.taskbarBadge.touch();
    });
    this.sessions.on('msg', (sid: string, m) => {
      // Só a janela dona da conversa precisa do fluxo de mensagens (as demais descartam); ver routing.ts.
      const owner = this.sessions.sessions.get(sid)?.state.wid;
      const text = JSON.stringify({ event: 'session.msg', data: { sid, seq: m.seq, msg: m.msg } });
      for (const c of this.clients) if (c.ws.readyState === 1 && receivesSessionMsg(owner, c.wid)) c.ws.send(text);
      // Responder uma permissão não muda o estado da conversa: quem avisa que o pedido sumiu é o eco do
      // `control_response`, que chega aqui. Mensagens de texto/stream não mexem no selo, e `touch` só agenda
      // (e o valor igual ao que já está na barra não chama o PowerShell), então o custo por mensagem é um timer.
      if (m.msg?.type === 'control_request' || m.msg?.type === 'control_response' || m.msg?.type === 'control_cancel_request') this.taskbarBadge.touch();
    });
    this.sessions.on('caps', (hostId: string, caps) => this.broadcast('caps', { hostId, caps }));
    this.sessions.on('attention', (st, a) => {
      this.broadcast('session.attention', { sid: st.sid, ...a });
      if (!this.clients.size) this.toast(st, a);
      this.taskbarBadge.touch();
    });
    // `pos` = posição do pedaço desde a abertura: a interface que reabre a aba com o histórico
    // (term.replay) ignora o que já veio nele.
    this.terminalManager.on('data', (id: string, data: string, pos: number) => {
      const t = this.terminalManager.info(id);
      if (t) this.emitToWindow(t.wid, 'term.data', { id, data, pos });
    });
    this.terminalManager.on('exit', (id: string, exitCode: number) => {
      for (const s of this.sessions.sessions.values()) if (s.state.terminalId === id) s.setTerminal(undefined);
      this.broadcast('term.exit', { id, exitCode });
    });
  }

  /** Notificação do Windows quando nenhuma janela do app está aberta. */
  private toast(st: { title?: string; hostId: string }, a: { kind: string; tool?: string }) {
    if (process.platform !== 'win32' || !this.store.settings.notifications) return;
    const title = a.kind === 'permission' ? 'Claude pede permissão' : 'Claude terminou';
    const body = `${st.hostId === LOCAL_HOST_ID ? 'Local' : st.hostId}: ${(st.title ?? 'conversa').slice(0, 80)}${a.tool ? ` (${a.tool})` : ''}`;
    const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>')
$t = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.Explorer').Show($t)`;
    import('node:child_process').then(({ execFile }) =>
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }, () => {}),
    );
  }

  private broadcast(event: string, data: any) {
    const text = JSON.stringify({ event, data });
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(text);
  }

  // ---------------------------------------------------------------- segurança HTTP

  private checkHost(req: http.IncomingMessage) {
    const h = (req.headers.host ?? '').toLowerCase();
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
  }

  private checkOrigin(req: http.IncomingMessage) {
    const o = req.headers.origin;
    return !o || o === `http://127.0.0.1:${this.port}` || o === `http://localhost:${this.port}`;
  }

  private hasCookie(req: http.IncomingMessage) {
    const c = req.headers.cookie ?? '';
    const m = c.match(/(?:^|;\s*)deck_session=([a-f0-9]{64})/);
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(this.cookieValue);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private httpError(res: http.ServerResponse, e: any) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const code = e?.code === 'notfound' || e?.code === 'ENOENT' ? 404 : e?.code === 'denied' || e?.code === 'EACCES' ? 403 : 500;
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e?.message ?? e));
  }

  // ---------------------------------------------------------------- HTTP

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.checkHost(req)) {
      res.writeHead(421, { 'content-type': 'text/plain' });
      res.end('Host não permitido');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const p = url.pathname;
    if (p === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // `build` (data do arquivo em execução) e `busy` (conversas trabalhando) deixam o atalho
      // trocar um servidor desatualizado por um novo sem derrubar trabalho em andamento.
      const conversationsBusy = [...this.sessions.sessions.values()].filter((s) => s.state.phase === 'running').length;
      const transfersBusy = this.transfers.busy;
      const busy = conversationsBusy + transfersBusy;
      res.end(JSON.stringify({ app: 'claude-deck', version: APP_VERSION, pid: process.pid, build: this.buildStamp, busy, conversationsBusy, transfersBusy, live: this.liveWids().size }));
      return;
    }
    if (p === '/launch' && req.method === 'POST') {
      // O atalho troca o token (arquivo local) por um código de uso único que vale 60 s: assim o
      // token não fica gravado no histórico do navegador (só o código, já usado e vencido).
      const t = String(req.headers['x-deck-token'] ?? '');
      const ok = !req.headers.origin && t.length === this.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
      if (!ok) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Token inválido.');
        return;
      }
      const code = crypto.randomBytes(24).toString('hex');
      const now = Date.now();
      for (const [k, exp] of this.launchCodes) if (exp < now) this.launchCodes.delete(k);
      this.launchCodes.set(code, now + 60_000);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ code }));
      return;
    }
    if (p === '/auth') {
      const t = url.searchParams.get('t') ?? '';
      const c = url.searchParams.get('c') ?? '';
      const exp = c ? this.launchCodes.get(c) : undefined;
      if (c) this.launchCodes.delete(c); // uso único, valendo ou não
      const ok = (exp !== undefined && exp >= Date.now()) || (t.length === this.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token)));
      if (!ok) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Token inválido. Abra o Claude Deck pelo atalho.');
        return;
      }
      // `open` (janela nova para um servidor/pasta) só passa adiante se for base64url puro.
      const open = url.searchParams.get('open') ?? '';
      res.writeHead(302, {
        'set-cookie': `deck_session=${this.cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        location: OPEN_RE.test(open) ? `/?open=${open}` : '/',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    if (p.startsWith('/preview/')) return this.servePreview(req, res, p);
    if (p.startsWith('/dl/')) return this.serveTicket(req, res, p);
    // Arquivos públicos (o navegador busca o manifesto/ícones sem cookie).
    if (p === '/manifest.webmanifest' || p.startsWith('/icons/') || p === '/favicon.svg' || p === '/favicon.ico') return this.serveStatic(req, res, p);
    if (!this.hasCookie(req)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Claude Deck</title><body style="font:14px system-ui;background:#1f1f1f;color:#ccc;padding:40px">' +
          '<h2>Claude Deck</h2><p>Abra pelo atalho <b>Claude Deck</b> (Área de Trabalho ou Menu Iniciar).</p></body>',
      );
      return;
    }
    if (p === '/api/raw') return this.serveRaw(req, res, url);
    if (p === '/api/zip') return this.serveZip(req, res, url);
    if (p === '/api/upload' && req.method === 'POST') return this.handleUpload(req, res, url);
    return this.serveStatic(req, res, p);
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
    const root = this.opts.webDir;
    let rel = decodeURIComponent(p).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    let file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root))) {
      res.writeHead(403);
      res.end();
      return;
    }
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
      if (st.isDirectory()) throw new Error('dir');
    } catch {
      // Rotas da interface caem no index.html.
      file = path.join(root, 'index.html');
      try {
        st = await fsp.stat(file);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Interface não compilada (rode npm run build).');
        return;
      }
    }
    const immutable = /[\\/]assets[\\/]/.test(file);
    res.writeHead(200, {
      'content-type': contentTypeFor(file),
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  private async serveRaw(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const hostId = url.searchParams.get('h') ?? '';
    const p = url.searchParams.get('p') ?? '';
    const host = this.registry.get(hostId);
    if (hostId !== LOCAL_HOST_ID) await this.registry.connect(hostId);
    return this.streamFile(req, res, host.fs, p, {
      download: url.searchParams.get('dl') === '1',
      sandbox: true,
    });
  }

  /** Baixa uma pasta inteira como .zip, montado em fluxo (começa a chegar antes de varrer tudo). */
  private async serveZip(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const hostId = url.searchParams.get('h') ?? '';
    const p = url.searchParams.get('p') ?? '';
    const host = this.registry.get(hostId);
    if (hostId !== LOCAL_HOST_ID) await this.registry.connect(hostId);
    return this.sendZip(req, res, host.fs, p);
  }

  private async sendZip(req: http.IncomingMessage, res: http.ServerResponse, fsx: HostFs, p: string) {
    const st = await fsx.stat(p);
    if (st.type !== 'dir') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Não é uma pasta.');
      return;
    }
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/:$/, '') || 'raiz';
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}.zip`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const skipped: string[] = [];
    const stream = Readable.from(zipChunks(walkZipItems(fsx, p, base, skipped), skipped), { objectMode: false });
    res.on('close', () => stream.destroy());
    try {
      await pipeline(stream, res);
    } catch (e: any) {
      // Já enviamos o cabeçalho 200: só resta cortar a conexão (o navegador marca o download como falho).
      this.log(`zip de ${p} interrompido: ${e?.message ?? e}`);
      res.destroy();
    }
  }

  /** Link de download com bilhete (curta duração, sem cookie): `/dl/<bilhete>/<nome>`. */
  private async serveTicket(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
    const m = p.match(/^\/dl\/([a-f0-9]{32})\//);
    const t = m ? this.dlTickets.get(m[1]) : undefined;
    if (!m || !t || t.expires < Date.now()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Link de download expirado. Tente arrastar de novo.');
      return;
    }
    const host = this.registry.get(t.hostId);
    if (t.hostId !== LOCAL_HOST_ID) await this.registry.connect(t.hostId);
    if (t.zip) return this.sendZip(req, res, host.fs, t.path);
    return this.streamFile(req, res, host.fs, t.path, { download: true, sandbox: true });
  }

  private async streamFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    fsx: import('./fs/hostfs').HostFs,
    p: string,
    o: { download?: boolean; sandbox?: boolean; csp?: string },
  ) {
    const st = await fsx.stat(p);
    if (st.type !== 'file') {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = contentTypeFor(p);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtime).toString(16)}"`;
    const headers: Record<string, string | number> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      etag,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
    };
    if (o.csp) headers['content-security-policy'] = o.csp;
    else if (o.sandbox && !/pdf/.test(type)) headers['content-security-policy'] = 'sandbox';
    if (o.download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p.replace(/\\/g, '/')))}`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && st.size > 0) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      if (m) {
        if (m[1] === '' && m[2] !== '') {
          start = Math.max(0, st.size - Number(m[2]));
        } else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1);
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          res.end();
          return;
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
      }
    }
    headers['content-length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = await fsx.createReadStream(p, start, end);
    req.on('close', () => stream.destroy());
    try {
      await pipeline(stream, res);
    } catch {
      /* navegador cancelou (ex.: busca no vídeo) */
    }
  }

  private async servePreview(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
    const m = p.match(/^\/preview\/([a-f0-9]{32})\/(.*)$/);
    const entry = m ? this.previews.get(m[1]) : undefined;
    if (!m || !entry || entry.expires < Date.now()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Pré-visualização expirada. Reabra o arquivo.');
      return;
    }
    const host = this.registry.get(entry.hostId);
    const rel = decodeURIComponent(m[2]);
    const sep = host.platform === 'win32' ? '\\' : '/';
    const parts: string[] = [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    const full = entry.root.replace(/[\\/]+$/, '') + sep + parts.join(sep);
    return this.streamFile(req, res, host.fs, full, {
      csp: 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    });
  }

  private async handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (req.headers['x-deck-upload'] !== '1' || !this.checkOrigin(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const hostId = url.searchParams.get('h') ?? '';
    const p = url.searchParams.get('p') ?? '';
    const overwrite = url.searchParams.get('overwrite') === '1';
    const host = this.registry.get(hostId);
    if (hostId !== LOCAL_HOST_ID) await this.registry.connect(hostId);
    if (!overwrite && (await host.fs.exists(p))) {
      res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Já existe um arquivo com esse nome.');
      return;
    }
    const ws = await host.fs.createWriteStream(p);
    await pipeline(req, ws);
    const st = await host.fs.stat(p);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, size: st.size, mtime: st.mtime }));
  }

  // ---------------------------------------------------------------- WebSocket / RPC

  private onWs(ws: WebSocket) {
    const client: Client = { ws, id: ++this.clientSeq };
    this.clients.add(client);
    ws.on('message', async (data) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(String(data));
      } catch {
        return;
      }
      const h = this.handlers.get(req.method);
      if (!h) {
        ws.send(JSON.stringify({ id: req.id, error: { message: `Método desconhecido: ${req.method}`, code: 'nomethod' } }));
        return;
      }
      try {
        if (this.stopping) throw new DeckError('busy', 'O servidor está encerrando.');
        const result = await h(req.params ?? {}, client);
        if (ws.readyState === 1) ws.send(JSON.stringify({ id: req.id, result: result ?? null }));
      } catch (e: any) {
        if (!(e instanceof DeckError) && !(e instanceof FsConflictError)) this.log(`erro em ${req.method}: ${e?.stack ?? e}`);
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              id: req.id,
              error: { message: String(e?.message ?? e), code: e?.code ?? 'error', currentMtime: e?.currentMtime },
            }),
          );
      }
    });
    const gone = () => {
      if (!this.clients.delete(client) || !client.wid) return;
      const wid = client.wid;
      if (this.liveWids().has(wid)) return; // outra conexão da mesma janela continua
      this.editGuards.disconnected(wid);
      const at = Date.now();
      this.closedAt.set(wid, at);
      // O selo considera só conexões vivas; não espera a folga usada para decidir restauração da janela.
      this.taskbarBadge.touch();
      // Quem mais estava aberto quando esta janela saiu.
      const othersAtClose = this.liveWids();
      // Recarregar (F5) ou queda breve não é fechar: a janela volta com o mesmo id logo em seguida.
      const grace = this.closeGraceMs();
      setTimeout(() => {
        if (this.stopping) return;
        const live = this.liveWids();
        if (!live.has(wid)) {
          this.log(`janela: ${this.winLabel(wid)} fechada (abertas agora: ${live.size})`);
          this.liveSince.delete(wid);
          this.terminalManager.closeForWindow(wid);
          // Fechou só esta janela (as outras ficaram abertas) = não reabre sozinha no próximo início.
          // Se todas saíram juntas (fechou o Brave, desligou o PC) ou era a última, continua marcada.
          // Uma janela que também fechou e já foi REABERTA (atalho logo depois de fechar tudo) não conta
          // como "ficou aberta": senão esta perderia a marca antes de ser reaberta junto.
          const stayedOpen = (o: string) => live.has(o) && (this.liveSince.get(o) ?? 0) <= at;
          const closedAlone = [...othersAtClose].some((o) => stayedOpen(o) || (this.closedAt.get(o) ?? 0) - at > 5000);
          const rec = this.store.windows[wid];
          if (rec && closedAlone) rec.shouldRestore = false;
          // A folga só decide restauração; o selo já foi atualizado ao desconectar a última conexão da janela.
        }
        this.reconcileSavedWindows(live);
        pruneWindows(this.store.windows, live, this.sessionWids());
        this.store.saveWindows();
      }, grace).unref();
    };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  /** Quanto uma janela desconectada espera para voltar (F5, queda breve) antes de contar como fechada. */
  private closeGraceMs(): number {
    return Number(process.env.CLAUDE_DECK_TEST_HOOKS === '1' && process.env.CLAUDE_DECK_CLOSE_GRACE_MS) || 30_000;
  }

  /** Só abas em janelas conectadas agora entram no selo; pendências fechadas continuam no Histórico. */
  private badgeWids(): Set<string> {
    return this.liveWids();
  }

  /** Ids das janelas com conexão aberta agora (menos a de `except`). */
  private liveWids(except?: Client): Set<string> {
    const s = new Set<string>();
    for (const c of this.clients) if (c !== except && c.wid) s.add(c.wid);
    return s;
  }

  private browserForWindow(): BrowserSelection {
    if (this.activeBrowser && this.liveWids().size > 0) return this.activeBrowser;
    const current = resolveBrowser(this.opts.paths.dataDir);
    this.activeBrowser = current;
    return current;
  }

  private sessionWids(): Set<string> {
    return new Set([...this.sessions.sessions.values()].map((s) => s.state.wid).filter((wid): wid is string => !!wid));
  }

  private reconcileSavedWindows(live: Set<string>): void {
    const states = [...this.sessions.sessions.values()].map((s) => s.state);
    const { owners, changed } = reconcileWindowSessions(this.store.windows, states, live);
    if (changed) this.store.saveWindows();
    if (owners.size) {
      for (const [sid, wid] of owners) this.sessions.get(sid).setOwner(wid);
      this.sessions.persistNow();
    }
  }

  /**
   * Formato antigo (janelas por pasta, podendo repetir): junta as repetidas numa janela por
   * servidor+pasta. Guarda cópia dos arquivos antes. O formato antigo não sabe quais janelas
   * estavam abertas, então nenhuma reabre sozinha até ser aberta uma vez no formato novo.
   */
  private migrateLegacyState(): void {
    if (this.store.stateVersion >= 2) return;
    const dir = path.dirname(this.store.paths.stateFile);
    for (const [src, name] of [
      [this.store.paths.stateFile, 'state.antes-janela-por-pasta.json'],
      [this.store.paths.sessionsFile, 'sessions.antes-janela-por-pasta.json'],
    ] as const) {
      try {
        const dst = path.join(dir, name);
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      } catch (e) {
        this.log(`cópia de segurança de ${src} falhou: ${(e as Error).message}`);
      }
    }
    const migrated = migrateLegacyWindows(this.store.windows, [...this.sessions.sessions.values()].map((s) => s.state));
    for (const rec of Object.values(migrated.windows)) rec.shouldRestore = false;
    this.store.windows = migrated.windows;
    this.store.aliases = { ...this.store.aliases, ...migrated.aliases };
    for (const [sid, wid] of migrated.owners) this.sessions.sessions.get(sid)?.setOwner(wid);
    if (migrated.owners.size) this.sessions.persistNow();
    this.store.stateVersion = 2;
    this.store.saveWindows();
    this.log(`janelas migradas para uma por servidor+pasta: ${Object.keys(migrated.windows).length} janelas, ${Object.keys(migrated.aliases).length} juntadas`);
  }

  /** "SERVIDOR:pasta [id]" para o log de janelas. */
  private winLabel(wid: string): string {
    const ctx = this.store.windows[wid] ? getWindowContext(this.store.windows[wid]) : null;
    return `${ctx ? `${ctx.hostId}:${ctx.cwd}` : '(sem pasta)'} [${wid.slice(0, 8)}]`;
  }

  private clientOfWid(wid: string): Client | undefined {
    for (const c of this.clients) if (c.wid === wid) return c;
    return undefined;
  }

  private sendTo(c: Client, event: string, data: unknown) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ event, data }));
  }

  /** Janela dona do par servidor+pasta (a aberta, se houver; senão a salva mais recente). */
  private contextOwner(hostId: string, folder: string, except?: string): string | undefined {
    const live = this.liveWids();
    const all = Object.entries(this.store.windows)
      .filter(([id, w]) => id !== except && (() => {
        const ctx = getWindowContext(w);
        return !!ctx && sameContext(ctx.hostId, ctx.cwd, hostId, folder);
      })())
      .sort((a, b) => Number(live.has(b[0])) - Number(live.has(a[0])) || b[1].updatedAt - a[1].updatedAt);
    return all[0]?.[0];
  }

  /**
   * Traz a janela para a frente. A página põe uma marca no título por alguns instantes; o Windows
   * acha a janela do navegador do Deck com essa marca (duas janelas do mesmo servidor têm o
   * mesmo título) e a ativa, restaurando se estiver minimizada.
   */
  private async focusClient(c: Client, extra: Record<string, unknown> = {}): Promise<boolean> {
    const marker = `deck-${crypto.randomBytes(6).toString('hex')}`;
    this.sendTo(c, 'window.focus', { marker, ...extra });
    // Nos testes automáticos não mexe no foco do Windows de quem roda os testes.
    let ok = process.env.CLAUDE_DECK_TEST_HOOKS === '1';
    if (process.platform === 'win32' && !ok) {
      await new Promise((r) => setTimeout(r, 200));
      const browser = this.browserForWindow();
      ok = await focusWindow(browser.profileDir, marker, { browser }).catch(() => false);
    }
    this.sendTo(c, 'window.unmark', { marker });
    return ok;
  }

  /** Abre a janela de um servidor+pasta no navegador selecionado (sem duplicar cliques). */
  private launchTarget(target: OpenTarget): { launched: boolean; url?: string; pending?: boolean } {
    const key = contextKey(target.h, target.f ?? '~');
    const now = Date.now();
    const test = process.env.CLAUDE_DECK_TEST_HOOKS === '1';
    if (!test && (this.pendingOpens.get(key) ?? 0) > now) return { launched: false, pending: true };
    const code = crypto.randomBytes(24).toString('hex');
    for (const [k, exp] of this.launchCodes) if (exp < now) this.launchCodes.delete(k);
    this.launchCodes.set(code, now + 60_000);
    const url = buildOpenUrl(this.port, code, target);
    // Nos testes automáticos não abre o Brave do sistema: devolve a URL e o teste abre a janela.
    if (test) return { launched: false, url };
    if (process.platform !== 'win32') throw new DeckError('unsupported', 'Abrir janela nova só funciona no Windows.');
    this.pendingOpens.set(key, now + 20_000);
    try {
      launchWindow(this.opts.paths.dataDir, url, this.browserForWindow());
    } catch (e) {
      this.pendingOpens.delete(key);
      throw e;
    }
    return { launched: true };
  }

  /**
   * Primeira janela depois de ligar o app: reabre também as outras janelas que estavam abertas
   * quando ele foi fechado/desligado (as fechadas uma a uma pelo usuário não voltam).
   */
  private restoreOtherWindows(firstWid: string, closedAtTrigger: Set<string>): void {
    const live = this.liveWids();
    for (const [wid, rec] of Object.entries(this.store.windows)) {
      if (wid === firstWid || live.has(wid) || rec.shouldRestore !== true || !closedAtTrigger.has(wid)) continue;
      const ctx = getWindowContext(rec);
      if (!ctx) continue;
      if (this.contextOwner(ctx.hostId, ctx.cwd) !== wid) continue; // só a dona do contexto
      try {
        this.log(`reabrindo a janela de ${ctx.hostId}:${ctx.cwd} (junto com ${firstWid.slice(0, 8)}; abertas: ${[...live].map((x) => x.slice(0, 8)).join(',') || 'nenhuma'})`);
        const r = this.launchTarget({ h: ctx.hostId, f: ctx.cwd });
        if (r.url) this.testLaunches.push(r.url);
      } catch (e) {
        this.log(`não reabri a janela de ${ctx.hostId}:${ctx.cwd}: ${(e as Error).message}`);
      }
    }
  }

  private on(method: string, h: Handler) {
    // Só nos testes: imita um servidor de versão anterior (sem os métodos de envio/baixa de pastas) para provar
    // que a interface nova continua funcionando quando o programa em segundo plano ainda não foi reiniciado.
    if (process.env.CLAUDE_DECK_TEST_HOOKS === '1' && process.env.CLAUDE_DECK_TEST_OLD_SERVER === '1' && OLD_SERVER_MISSING.has(method)) return;
    this.handlers.set(method, h);
  }

  private async fsFor(hostId: string) {
    const host = this.registry.get(hostId);
    if (hostId !== LOCAL_HOST_ID) await this.registry.connect(hostId);
    return host;
  }

  private copyWindow(client: Client, hostId?: unknown): string {
    const rec = client.wid ? this.store.windows[client.wid] : undefined;
    if (!client.wid || !rec) throw new DeckError('otherwindow', 'A janela precisa estar anexada antes de copiar/colar.');
    if (hostId !== undefined) {
      if (typeof hostId !== 'string' || !this.registry.exists(hostId)) throw new DeckError('nohost', 'Servidor desconhecido.');
      const ctx = getWindowContext(rec);
      const current = ctx?.hostId ?? rec.state.workspace?.hostId ?? LOCAL_HOST_ID;
      if (current !== hostId) throw new DeckError('otherwindow', 'O destino/origem precisa ser o servidor desta janela.');
    }
    return client.wid;
  }

  private async homeOf(hostId: string): Promise<string> {
    if (hostId === LOCAL_HOST_ID) return os.homedir();
    const st = await this.registry.connect(hostId);
    if (!st.home) throw new DeckError('ssh', 'Pasta pessoal desconhecida.');
    return st.home;
  }

  /** Validação compartilhada dos RPCs de pendência: nunca aceita uma chave de outro servidor. */
  private pendingHostId(value: unknown): string {
    if (typeof value !== 'string' || !this.registry.exists(value)) throw new DeckError('nohost', 'Servidor desconhecido.');
    return value;
  }

  private pendingRecord(params: unknown): ManualPendingConversation {
    const p = params as Partial<ManualPendingConversation> | null;
    const hostId = this.pendingHostId(p?.hostId);
    if (typeof p?.sessionId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(p.sessionId))
      throw new DeckError('bad', 'Id da conversa inválido.');
    const host = this.registry.get(hostId);
    if (typeof p.cwd !== 'string' || !p.cwd || p.cwd.length > 32_768 || /[\x00-\x1f\x7f]/.test(p.cwd) || !isAbsolute(host.platform, p.cwd))
      throw new DeckError('bad', 'Pasta da conversa inválida.');
    return { hostId, sessionId: p.sessionId, cwd: p.cwd };
  }

  /** Liga/desliga o início automático do servidor com o Windows (atalho na pasta Inicializar). */
  private async autostart(enable?: boolean): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const startup = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const lnk = path.join(startup, 'Claude Deck (servidor).lnk');
    if (enable === undefined) return fs.existsSync(lnk);
    if (!enable) {
      try {
        fs.unlinkSync(lnk);
      } catch {
        /* já não existia */
      }
      return false;
    }
    const vbs = path.resolve(this.opts.webDir, '..', '..', 'launcher', 'start-server.vbs');
    const q = (s: string) => s.replace(/'/g, "''");
    const script =
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}'); ` +
      `$s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"; $s.Arguments = '"${q(vbs)}"'; ` +
      `$s.WorkingDirectory = '${q(path.dirname(vbs))}'; $s.Description = 'Claude Deck (servidor local)'; $s.Save()`;
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) =>
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (e) => (e ? reject(e) : resolve())),
    );
    return fs.existsSync(lnk);
  }

  private async readSessionTitle(s: ClaudeSession): Promise<string | undefined> {
    if (!s.state.sessionId) return undefined;
    const host = this.registry.get(s.state.hostId);
    const home = await this.homeOf(s.state.hostId);
    const file = await this.history.findFile(host, home, s.state.sessionId, s.state.cwd);
    return file ? this.history.readTitle(host, file) : undefined;
  }

  /** Sem nome do Claude nem do usuário no transcript: o começo do 1º pedido, como o histórico mostra. */
  private async readSessionProvisionalTitle(s: ClaudeSession): Promise<string | undefined> {
    if (!s.state.sessionId) return undefined;
    const host = this.registry.get(s.state.hostId);
    const home = await this.homeOf(s.state.hostId);
    const file = await this.history.findFile(host, home, s.state.sessionId, s.state.cwd);
    if (!file) return undefined;
    const st = await host.fs.stat(file);
    const sum = await this.history.summarizeFile(host, file, st.size, st.mtime);
    return sum.title && sum.title !== UNTITLED ? sum.title : undefined;
  }

  private async writeSessionTitle(s: ClaudeSession, title: string): Promise<boolean> {
    if (!s.state.sessionId) return false;
    const host = await this.fsFor(s.state.hostId);
    const file = await this.history.findFile(host, await this.homeOf(s.state.hostId), s.state.sessionId, s.state.cwd);
    if (!file) return false;
    await this.history.writeCustomTitle(host, file, s.state.sessionId, title);
    return true;
  }

  private registerHandlers() {
    // --- app
    this.on('app.info', () => ({
      version: APP_VERSION,
      windowRestore: true,
      fileCopy: this.handlers.has('fileCopy.start') ? 1 : 0,
      // Enviar pasta inteira, baixar pasta em .zip e arrastar para fora dependem destes métodos.
      folderTransfer: this.handlers.has('dl.ticket'),
      // Conversas marcadas pelo usuário para voltar depois (independente de turnos automáticos não vistos).
      manualPending: true,
      browserSelection: true,
      browser: (() => { try { return resolveBrowser(this.opts.paths.dataDir).id; } catch { return null; } })(),
      bootId: BOOT_ID,
      platform: process.platform,
      hostname: os.hostname(),
      home: os.homedir(),
      settings: this.store.settings,
      caps: Object.fromEntries(this.sessions.caps),
      prompts: this.prompts.list(),
      port: this.port,
    }));
    this.on('app.quit', () => {
      if (this.transfers.busy || [...this.sessions.sessions.values()].some((s) => s.state.phase === 'running' || s.state.phase === 'starting' || s.state.phase === 'reconnecting' || s.pendingPermissions.size > 0))
        throw new DeckError('busy', 'Não encerro enquanto houver conversa ou transferência em andamento.');
      this.stopping = true;
      setTimeout(() => this.stop().then(() => process.exit(0)), 100);
      return true;
    });
    this.on('app.log', () => {
      try {
        const buf = fs.readFileSync(this.store.paths.logFile);
        return buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString('utf8');
      } catch {
        return '';
      }
    });
    this.on('app.stats', () => {
      const mem = process.memoryUsage();
      const all = [...this.sessions.sessions.values()];
      return {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        sessions: all.length,
        running: all.filter((s) => s.state.phase === 'running').length,
        alive: all.filter((s) => s.alive).length,
        hostsConnected: this.registry.allStatuses().filter((h) => h.id !== LOCAL_HOST_ID && h.state === 'ready').length,
        channels: this.registry.allStatuses().reduce((n, h) => n + (h.channels ?? 0), 0),
        uptime: process.uptime(),
      };
    });
    this.on('app.autostart', async ({ enable }) => this.autostart(enable));
    this.on('browser.list', () => ({
      selected: (() => { try { return resolveBrowser(this.opts.paths.dataDir).id; } catch { return null; } })(),
      available: BROWSER_IDS.map((id) => ({ id, installed: !!findBrowser(id) })),
      restartWindows: this.liveWids().size > 0,
    }));
    this.on('browser.select', ({ browser }: { browser?: BrowserId }) => {
      if (!browser || !BROWSER_IDS.includes(browser) || !findBrowser(browser)) throw new DeckError('browser', 'Navegador inválido ou não instalado.');
      if (this.liveWids().size > 1) throw new DeckError('busy', 'Feche as outras janelas do Deck antes de mudar de navegador.');
      writeJsonAtomic(this.opts.paths.browserFile, { browser });
      return { browser, restartWindows: true };
    });
    this.on('fs.roots', ({ h }) => {
      if (h !== LOCAL_HOST_ID || process.platform !== 'win32') return ['/'];
      const roots: string[] = [];
      for (let c = 67; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try {
          fs.accessSync(d);
          roots.push(d);
        } catch {
          /* unidade ausente */
        }
      }
      return roots;
    });
    this.on('settings.set', (p) => this.store.setSettings(p ?? {}));
    // Janelas: uma por servidor+pasta das conversas, cada uma com o seu estado de tela.
    this.on('window.attach', async ({ wid, target }, client) => {
      const open = target === undefined ? undefined : isValidTarget(target) && this.registry.exists(target.h) ? (target as OpenTarget) : null;
      if (open === null) throw new DeckError('bad', 'Servidor ou pasta inválidos.');
      let known = typeof wid === 'string' && WID_RE.test(wid) ? wid : undefined;
      if (known && this.store.aliases[known]) known = this.store.aliases[known];
      // Id que a própria página acabou de criar (atalho com o app aberto, `#nova`): é uma janela nova,
      // não uma janela salva reconectando.
      const freshId = !!known && !this.store.windows[known];
      // Logo que o servidor sobe, as janelas que já estavam abertas reconectam com o próprio id; uma
      // janela nova (atalho) espera esse instante para não ficar com a janela salva de outra.
      if ((!known || freshId) && !open) {
        const wait = this.startedAt + 4000 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      const live = this.liveWids(client);
      // Atalho clicado com o app aberto (pedido de 01/10): abre uma janela NOVA e vazia, sem servidor.
      // Não traz outra janela para a frente nem fecha a nova; só com tudo fechado ele reabre as salvas.
      this.reconcileSavedWindows(live);
      const r = attachWindow(this.store.windows, known, live, Date.now(), open);
      if (r.duplicate) {
        // Este servidor+pasta já está aberto em outra janela: traz aquela para a frente e esta não
        // vira uma segunda dona do mesmo contexto.
        this.log(`janela: pedido de ${this.winLabel(r.wid)} já aberta em outra janela — a nova se fecha`);
        const other = this.clientOfWid(r.wid);
        if (other) void this.focusClient(other, open?.r && open.f ? { hostId: open.h, folder: open.f, resume: open.r } : {});
        return { duplicate: true, wid: r.wid };
      }
      if (!this.liveWids().size) this.browserForWindow();
      client.wid = r.wid;
      // Janela nova: as conversas dela passam a contar e o botão dela ainda não tem o selo.
      this.taskbarBadge.touch();
      this.taskbarBadge.refresh();
      const rec = this.store.windows[r.wid];
      rec.shouldRestore = true;
      this.closedAt.delete(r.wid);
      if (open) this.pendingOpens.delete(contextKey(open.h, open.f ?? '~'));
      // "Aberta desde": a mesma aba reconectando/recarregando mantém o horário; uma aba nova assumindo a
      // janela (atalho, janela reaberta) conta como aberta agora.
      if (known !== r.wid || !this.liveSince.has(r.wid)) this.liveSince.set(r.wid, Date.now());
      const how = open ? 'aberta para a pasta' : live.size > 0 && (freshId || !known) ? 'janela nova vazia, atalho com o app aberto' : known === r.wid && !freshId ? 'mesma aba' : 'atalho';
      this.log(`janela: ${this.winLabel(r.wid)} conectou (${how}; abertas agora: ${this.liveWids().size})`);
      pruneWindows(this.store.windows, this.liveWids(), this.sessionWids());
      this.store.saveWindows();
      // Primeira janela com o app todo fechado (sem id salvo, sem destino, nenhuma outra aberta): reabre as
      // outras que estavam abertas. Vale depois de ligar o PC E quando o programa em segundo plano continuou
      // rodando e o usuário fechou todas as janelas e clicou no atalho (antes só valia no primeiro caso).
      if (live.size === 0 && (!known || freshId) && !open) {
        // Só as que já estavam fechadas AGORA: uma janela aberta e fechada nesses 2,5 s não é "reaberta junto".
        const closedNow = new Set(Object.keys(this.store.windows).filter((id) => id !== r.wid));
        setTimeout(() => {
          if (!this.stopping) this.restoreOtherWindows(r.wid, closedNow);
        }, 2500).unref();
      }
      return { wid: r.wid, state: r.state, context: getWindowContext(rec) ?? null };
    });
    this.on('state.set', (p, client) => {
      const win = client.wid ? this.store.windows[client.wid] : undefined;
      if (!win) return false;
      const st = { ...(p ?? {}) } as UiState;
      const ctx = getWindowContext(win);
      // Aba de conversa de outro servidor/pasta nunca fica nesta janela (arquivos de qualquer pasta, sim).
      let tabs = Array.isArray(st.chatTabs) ? st.chatTabs : [];
      if (ctx) tabs = tabs.filter((t) => t && sameContext(ctx.hostId, ctx.cwd, t.hostId, t.cwd));
      // Uma interface que ainda não conhece todas as abas desta janela (versão antiga, recém-juntada)
      // não apaga as outras: só sai a aba cuja conversa foi fechada de fato.
      const inPayload = new Set(tabs.map((t) => t.sid));
      const kept = win.state.chatTabs.filter((t) => !inPayload.has(t.sid) && this.sessions.sessions.get(t.sid)?.state.wid === client.wid);
      st.chatTabs = [...tabs, ...kept];
      if (saveWindowState(this.store.windows, client.wid!, st)) this.store.saveWindows();
      return true;
    });
    if (process.env.CLAUDE_DECK_TEST_HOOKS === '1') {
      this.on('test.launches', () => this.testLaunches.splice(0));
      this.on('test.windows', () => this.store.windows);
      // O que o selo da barra de tarefas mostraria agora (nos testes ele não é desenhado de verdade).
      this.on('test.badge', () => this.taskbarBadge.current());
    }
    // Abre uma janela nova do app já no servidor/pasta escolhidos (aba Servidores). Autentica a
    // janela com um código de uso único (o mesmo esquema do atalho) e leva o destino na URL.
    // Abre a janela de um servidor+pasta (aba Servidores, conversa de outra pasta, histórico).
    // Se ela já está aberta, só a traz para a frente: nunca duas janelas do mesmo servidor+pasta.
    this.on('window.open', async ({ hostId, folder, resume }) => {
      const target: OpenTarget = { h: hostId, ...(folder === undefined ? {} : { f: folder }), ...(resume === undefined ? {} : { r: resume }) };
      if (!isValidTarget(target)) throw new DeckError('bad', 'Servidor ou pasta inválidos.');
      if (!this.registry.exists(target.h)) throw new DeckError('nohost', 'Servidor desconhecido.');
      const live = this.liveWids();
      if (target.f === undefined) {
        // Só o servidor: a janela dele que está aberta (a usada por último); senão a última salva;
        // senão uma janela nova na pasta pessoal.
        const mine = Object.entries(this.store.windows)
          .filter(([, w]) => getWindowContext(w)?.hostId === target.h)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
        const open = mine.find(([id]) => live.has(id));
        if (open) {
          const focused = await this.focusClient(this.clientOfWid(open[0])!);
          return { launched: false, focused, wid: open[0] };
        }
        if (mine[0]) target.f = getWindowContext(mine[0][1])!.cwd;
      }
      if (target.f !== undefined) {
        const owner = this.contextOwner(target.h, target.f);
        if (owner && live.has(owner)) {
          const extra = target.r ? { hostId: target.h, folder: target.f, resume: target.r } : {};
          const focused = await this.focusClient(this.clientOfWid(owner)!, extra);
          this.log(`janela: abrir ${target.h}:${target.f} — já aberta ${this.winLabel(owner)}, ${focused ? 'trazida para a frente' : 'NÃO consegui trazer para a frente'}`);
          return { launched: false, focused, wid: owner };
        }
      }
      const res = this.launchTarget(target);
      this.log(`janela: abrir ${target.h}:${target.f ?? '~'} — ${res.pending ? 'já estava abrindo (ignorado)' : 'nova janela do navegador'}`);
      return res;
    });

    // --- servidores
    this.on('hosts.list', () => this.registry.list());
    this.on('hosts.statuses', () => this.registry.allStatuses());
    this.on('hosts.connect', ({ id, force }) => this.registry.connect(id, !!force));
    this.on('hosts.disconnect', ({ id }) => {
      this.registry.disconnect(id);
      return true;
    });
    this.on('hosts.favorite', ({ id, favorite }) => {
      const f = this.store.hosts.favorites.filter((x) => x !== id);
      if (favorite) f.push(id);
      this.store.hosts.favorites = f;
      this.store.saveHosts();
      return true;
    });
    this.on('hosts.addRecent', ({ id, folder }) => {
      this.store.addRecentFolder(id, folder);
      this.broadcast('hosts.update', this.registry.list());
      return true;
    });
    this.on('hosts.removeRecent', ({ id, folder }) => {
      this.store.hosts.recentFolders[id] = (this.store.hosts.recentFolders[id] ?? []).filter((f) => f !== folder);
      this.store.saveHosts();
      this.broadcast('hosts.update', this.registry.list());
      return true;
    });
    this.on('hosts.add', ({ alias, hostName, user, port, identityFile }) => {
      if (!alias || !hostName || /[\r\n]/.test(alias + hostName + (user ?? '') + (identityFile ?? ''))) throw new DeckError('bad', 'Dados inválidos.');
      if (this.registry.exists(alias)) throw new DeckError('exists', `Já existe um servidor chamado "${alias}".`);
      const cfgFile = path.join(this.store.paths.sshDir, 'config');
      fs.mkdirSync(this.store.paths.sshDir, { recursive: true });
      let cur = '';
      try {
        cur = fs.readFileSync(cfgFile, 'utf8');
        fs.copyFileSync(cfgFile, cfgFile + '.claude-deck.bak');
      } catch {
        /* config novo */
      }
      const block = formatHostBlock({ alias, hostName, user, port: Number(port) || 22, identityFile });
      fs.appendFileSync(cfgFile, (cur && !cur.endsWith('\n') ? '\n' : '') + '\n' + block, 'utf8');
      this.store.hosts.favorites = [...this.store.hosts.favorites.filter((x) => x !== alias), alias];
      this.store.saveHosts();
      return this.registry.list();
    });
    // Teste sem interação e só de leitura (não pede senha, não grava nada): "Testar todos".
    this.on('hosts.check', ({ id }) => this.registry.check(id));
    // Só nos testes automáticos (variável de ambiente): simula a queda da rede com um servidor.
    if (process.env.CLAUDE_DECK_TEST_HOOKS === '1') {
      this.on('test.dropHost', ({ id }) => {
        this.registry.get(id).ssh?.destroyForTest();
        return true;
      });
    }
    this.on('auth.respond', ({ promptId, ok, values }) => this.prompts.respond(promptId, ok ? { ok: true, values: values ?? [] } : { ok: false }));

    // --- clipboard e cópias entre janelas (nunca transporta bytes no RPC)
    this.on('fileClipboard.get', (_p, c) => { this.copyWindow(c); return this.transfers.clipboard; });
    this.on('fileClipboard.set', ({ hostId, path }, c) => this.transfers.setClipboard(this.copyWindow(c, hostId), hostId, path));
    this.on('fileClipboard.clear', (_p, c) => { this.copyWindow(c); this.transfers.clearClipboard(); return true; });
    this.on('fileCopy.start', (p, c) => this.transfers.start(this.copyWindow(c, p.hostId), p));
    this.on('fileCopy.list', (_p, c) => this.transfers.list(this.copyWindow(c)));
    this.on('fileCopy.get', ({ id, requestId, offset }, c) => {
      const wid = this.copyWindow(c);
      const job = this.transfers.get(wid, id, requestId);
      return offset === undefined ? job : this.transfers.issues(wid, job.id, Number.isSafeInteger(offset) && offset >= 0 ? offset : 0);
    });
    this.on('fileCopy.resolve', ({ id, revision, decision }, c) => this.transfers.decide(this.copyWindow(c), id, revision, decision));
    this.on('fileCopy.cancel', ({ id }, c) => this.transfers.cancel(this.copyWindow(c), id));
    this.on('fileCopy.edits', ({ revision, files }, c) => { this.editGuards.sync(this.copyWindow(c), c.id, revision, files); return true; });
    this.on('fileCopy.ack', ({ id, clean }, c) => { this.editGuards.acknowledge(this.copyWindow(c), id, clean); return true; });

    // --- arquivos
    this.on('fs.home', ({ h }) => this.homeOf(h));
    this.on('fs.list', async ({ h, p }) => {
      const host = await this.fsFor(h);
      const items: FileEntry[] = await host.fs.list(p);
      return sortEntries(items);
    });
    this.on('fs.stat', async ({ h, p }) => (await this.fsFor(h)).fs.stat(p));
    this.on('fs.exists', async ({ h, p }) => (await this.fsFor(h)).fs.exists(p));
    this.on('fs.read', async ({ h, p, max, asText }): Promise<ReadResult> => {
      const host = await this.fsFor(h);
      const limit = Math.min(Number(max) || this.store.settings.maxOpenFileMB * 1024 * 1024, 200 * 1024 * 1024);
      const r = await host.fs.read(p, limit);
      const binary = !asText && looksBinary(r.data);
      return {
        content: binary ? r.data.toString('base64') : r.data.toString('utf8'),
        encoding: binary ? 'base64' : 'utf8',
        size: r.size,
        mtime: r.mtime,
        binary,
        truncated: r.truncated,
      };
    });
    this.on('fs.write', async ({ h, p, content, encoding, expectedMtime, expectedSize, createOnly }) => {
      const host = await this.fsFor(h);
      const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(String(content ?? ''), 'utf8');
      const release = this.editGuards.beginWrite(h, copyPath(host.platform, p));
      try { return await host.fs.write(p, data, { expectedMtime, expectedSize: typeof expectedSize === 'number' ? expectedSize : undefined, createOnly }); }
      finally { release(); }
    });
    this.on('fs.mkdir', async ({ h, p }) => {
      await (await this.fsFor(h)).fs.mkdir(p);
      return true;
    });
    // Cria a pasta e os níveis que faltam (envio de pasta inteira). Já existir uma pasta não é erro.
    this.on('fs.mkdirp', async ({ h, p }) => {
      await mkdirp((await this.fsFor(h)).fs, String(p));
      return true;
    });
    // Dos caminhos pedidos, quais já existem (uma ida só para checar um envio de muitos arquivos).
    this.on('fs.existsMany', async ({ h, paths }) => {
      const fsx = (await this.fsFor(h)).fs;
      const list: string[] = Array.isArray(paths) ? paths.map(String).slice(0, 5000) : [];
      const found: string[] = [];
      let i = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (i < list.length) {
            const p = list[i++];
            if (await fsx.exists(p)) found.push(p);
          }
        }),
      );
      return found;
    });
    // Bilhete de download para arrastar arquivo/pasta para fora do app (o navegador busca a URL sozinho).
    this.on('dl.ticket', async ({ h, p, zip }) => {
      const host = await this.fsFor(h);
      const st = await host.fs.stat(String(p));
      const wantZip = !!zip;
      if (wantZip ? st.type !== 'dir' : st.type !== 'file') throw new DeckError('bad', wantZip ? 'Não é uma pasta.' : 'Não é um arquivo.');
      const now = Date.now();
      for (const [k, v] of this.dlTickets) if (v.expires < now) this.dlTickets.delete(k);
      const token = crypto.randomBytes(16).toString('hex');
      this.dlTickets.set(token, { hostId: String(h), path: String(p), zip: wantZip, expires: now + 10 * 60_000 });
      const base = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'raiz';
      return { url: `/dl/${token}/${encodeURIComponent(base)}${wantZip ? '.zip' : ''}` };
    });
    // Renomeia ou move dentro do mesmo servidor (`to` pode estar em outra pasta). Nunca sobrescreve.
    this.on('fs.rename', async ({ h, from, to }) => {
      const fsx = (await this.fsFor(h)).fs;
      if (relativeTo(fsx.platform, String(from), String(to))) throw new DeckError('bad', 'Não dá para mover uma pasta para dentro dela mesma.');
      await fsx.rename(from, to);
      return true;
    });
    this.on('fs.remove', async ({ h, p }) => {
      const home = await this.homeOf(h);
      const norm = String(p).replace(/[\\/]+$/, '');
      if (!norm || norm === home || /^[A-Za-z]:$/.test(norm) || norm === '/') throw new DeckError('bad', 'Recusado: não apago a pasta pessoal nem a raiz.');
      await (await this.fsFor(h)).fs.remove(p);
      return true;
    });
    this.on('fs.realpath', async ({ h, p }) => (await this.fsFor(h)).fs.realpath(p));
    this.on('fs.findFiles', async ({ h, root, limit }) => (await this.fsFor(h)).fs.findFiles(root, Math.min(Number(limit) || 20000, 50000)));
    this.on('fs.search', async ({ h, root, query, caseSensitive, regex, limit }): Promise<SearchResult> => {
      const q = String(query ?? '');
      if (!q.trim()) return { matches: [], filesWithMatches: 0, truncated: false };
      if (regex) {
        try {
          new RegExp(q);
        } catch (e) {
          throw new DeckError('badregex', `Expressão regular inválida: ${(e as Error).message}`);
        }
      }
      const host = await this.fsFor(h);
      return host.fs.search(root, q, { caseSensitive: !!caseSensitive, regex: !!regex, limit: Math.min(Number(limit) || 500, 2000) });
    });
    this.on('fs.previewToken', ({ h, root }) => {
      const token = crypto.randomBytes(16).toString('hex');
      this.previews.set(token, { hostId: h, root, expires: Date.now() + 12 * 3600_000 });
      for (const [k, v] of this.previews) if (v.expires < Date.now()) this.previews.delete(k);
      return token;
    });

    // --- conversas
    this.on('sessions.list', () => {
      const all = [...this.sessions.sessions.values()];
      // Aba sem nome (retomada/restaurada): o nome vem do transcript e chega pelo evento de estado.
      for (const s of all) this.sessions.ensureTitle(s);
      return all.map((s) => s.state);
    });
    this.on('sessions.create', async (p, client) => {
      if (!this.registry.exists(p.hostId)) throw new DeckError('nohost', 'Servidor desconhecido.');
      // Uma janela = um servidor + uma pasta. Conversa de outro servidor/pasta vai para a janela dela.
      const win = client.wid ? this.store.windows[client.wid] : undefined;
      // Retomar uma conversa que já está aberta numa aba: nunca cria a segunda (dois processos do Claude
      // no mesmo transcript). Desta janela: devolve a aba que já existe. De outra: a interface vai até ela.
      if (typeof p.resume === 'string' && p.resume) {
        const lookup = () => [...this.sessions.sessions.values()].find(
          (s) => s.state.hostId === p.hostId && s.state.sessionId === p.resume && s.state.phase !== 'ended',
        );
        let same = lookup();
        if (same?.isClosing) {
          await this.sessions.waitForClose(same.state.sid);
          same = lookup();
          if (same?.isClosing) throw new DeckError('closing', 'A conversa ainda está fechando. Tente abri-la novamente em instantes.');
        }
        if (same) {
          const owner = same.state.wid;
          const ctx = win ? getWindowContext(win) : undefined;
          // Aba salva numa janela fechada desta mesma pasta (resto do formato antigo): passa para esta.
          const adopt = owner !== client.wid && !!client.wid && (!owner || !this.liveWids().has(owner)) && !!ctx && sameContext(ctx.hostId, ctx.cwd, same.state.hostId, same.state.cwd);
          if (owner === client.wid || adopt) {
            if (adopt) {
              const old = owner ? this.store.windows[owner] : undefined;
              if (old) {
                old.state.chatTabs = old.state.chatTabs.filter((t) => t.sid !== same.state.sid);
                if (old.state.activeChat === same.state.sid) old.state.activeChat = old.state.chatTabs[0]?.sid;
                this.store.saveWindows();
              }
              same.setOwner(client.wid);
              this.sessions.persistNow();
            }
            this.log(`conversa ${p.resume.slice(0, 8)} já aberta ${adopt ? `numa janela fechada — passou para ${this.winLabel(client.wid!)}` : 'nesta janela'}: sem aba nova`);
            return same.state;
          }
          this.log(`conversa ${p.resume.slice(0, 8)} já aberta em ${owner ? this.winLabel(owner) : '(sem janela atribuída)'}: sem aba nova`);
          throw new DeckError('alreadyopen', 'Esta conversa já está aberta em outra janela.');
        }
      }
      if (win && typeof p.cwd === 'string' && p.cwd) {
        const ctx = getWindowContext(win);
        if (ctx && !sameContext(ctx.hostId, ctx.cwd, p.hostId, p.cwd))
          throw new DeckError('otherwindow', `Esta janela é de ${ctx.hostId === LOCAL_HOST_ID ? 'Este computador' : ctx.hostId} em ${ctx.cwd}; ${p.cwd} abre na janela dessa pasta.`);
        if (!ctx) {
          const owner = this.contextOwner(p.hostId, p.cwd, client.wid);
          if (owner) throw new DeckError('otherwindow', `${p.cwd} já tem a janela dela.`);
          win.hostId = p.hostId;
          win.contextCwd = p.cwd;
          win.shouldRestore = true;
          this.store.saveWindows();
        }
      }
      this.store.addRecentFolder(p.hostId, p.cwd);
      // As outras janelas também veem a pasta nova entre as recentes (aba Servidores).
      this.broadcast('hosts.update', this.registry.list());
      const s = this.sessions.create({ ...p, wid: client.wid });
      return s.state;
    });
    this.on('sessions.snapshot', ({ sid }) => {
      const s = this.sessions.get(sid);
      this.sessions.ensureTitle(s);
      return { state: s.state, messages: s.snapshot(), pending: [...s.pendingPermissions.values()] };
    });
    this.on('sessions.start', async ({ sid }) => {
      await this.sessions.get(sid).start();
      return true;
    });
    this.on('sessions.reattach', ({ sids }) => {
      this.sessions.resumeRemote(sids);
      return true;
    });
    this.on('sessions.send', async ({ sid, content, uuid }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.executionMode === 'terminal' && s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      await s.send(content, uuid);
      return true;
    });
    this.on('sessions.respond', ({ sid, requestId, response }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.executionMode === 'terminal' && s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      s.respond(requestId, response);
      return true;
    });
    // A interface viu o que tinha terminado (abriu a aba, voltou para a janela). Conversa que já
    // não existe não é erro: o aviso some junto com ela.
    this.on('sessions.seen', ({ sid }) => {
      this.sessions.sessions.get(sid)?.clearUnseen();
      return true;
    });
    this.on('sessions.interrupt', async ({ sid }) => {
      await this.sessions.get(sid).interrupt();
      return true;
    });
    this.on('sessions.setMode', async ({ sid, mode }) => {
      await this.sessions.get(sid).setPermissionMode(mode);
      return true;
    });
    this.on('sessions.setModel', async ({ sid, model }) => {
      await this.sessions.get(sid).setModel(model || null);
      return true;
    });
    this.on('sessions.setEffort', async ({ sid, effort }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.wid && s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      await s.setEffort(effort == null ? null : effort);
      return true;
    });
    this.on('sessions.control', async ({ sid, request }) => {
      const allowed = ['get_context_usage', 'mcp_status', 'get_settings'];
      if (!allowed.includes(request?.subtype)) throw new DeckError('bad', 'Pedido não permitido.');
      return this.sessions.get(sid).control(request, 30_000);
    });
    this.on('sessions.stopTask', async ({ sid, taskId }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.wid && s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new DeckError('bad', 'Identificador da tarefa inválido.');
      return s.control({ subtype: 'stop_task', task_id: taskId }, 30_000);
    });
    this.on('sessions.rename', async ({ sid, title }) => {
      const s = this.sessions.get(sid);
      // Nome vazio nunca apaga o da aba (antes deixava a aba como "Conversa").
      if (!String(title ?? '').trim()) return true;
      s.setTitle(String(title), true);
      // Também no transcript: o nome aparece no /resume do terminal e no VS Code.
      await this.sessions.refreshTitle(s).catch((e) => this.log(`não gravei o nome no transcript: ${e.message}`));
      return true;
    });
    this.on('sessions.close', async ({ sid }) => {
      await this.sessions.close(sid);
      // A aba fechada sai também do estado salvo da janela (a interface pode ter gravado antes).
      let changed = false;
      for (const w of Object.values(this.store.windows)) {
        const n = w.state.chatTabs.length;
        w.state.chatTabs = w.state.chatTabs.filter((t) => t.sid !== sid);
        if (w.state.chatTabs.length !== n) changed = true;
      }
      if (changed) this.store.saveWindows();
      return true;
    });
    this.on('sessions.caps', ({ hostId }) => this.sessions.caps.get(hostId) ?? null);

    // --- pendências manuais
    this.on('pending.list', ({ hostId }) => this.store.listManualPending(this.pendingHostId(hostId)));
    this.on('pending.set', (params) => {
      const record = this.pendingRecord(params);
      if (typeof params?.pending !== 'boolean') throw new DeckError('bad', 'Estado de pendência inválido.');
      // Idempotente: repetições não regravam nem inundam as outras janelas com o mesmo evento.
      if (this.store.setManualPending(record, params.pending)) {
        this.broadcast('pending.changed', { ...record, pending: params.pending });
        // Pendência sem aba aberta continua só no Histórico; o resumo já filtra as janelas vivas.
        this.taskbarBadge.touch();
      }
      return true;
    });

    // --- histórico
    this.on('history.list', async ({ h, cwd }) => {
      const host = await this.fsFor(h);
      const home = await this.homeOf(h);
      return cwd ? this.history.listForCwd(host, home, cwd) : [];
    });
    this.on('history.pending', async ({ hostId }) => {
      const id = this.pendingHostId(hostId);
      const host = await this.fsFor(id);
      return this.history.listManualPending(host, await this.homeOf(id), this.store.listManualPending(id));
    });
    this.on('history.projects', async ({ h }) => {
      const host = await this.fsFor(h);
      return this.history.listProjects(host, await this.homeOf(h));
    });
    this.on('history.listDir', async ({ h, dir }) => this.history.listDir(await this.fsFor(h), dir));
    this.on('history.load', async ({ h, sessionId, cwd, before, file }) => {
      const host = await this.fsFor(h);
      const f = file || (await this.history.findFile(host, await this.homeOf(h), sessionId, cwd));
      if (!f) throw new DeckError('notfound', 'Transcript da conversa não encontrado.');
      const page = await this.history.loadPage(host, f, before);
      return { ...page, file: f };
    });
    this.on('history.agent', async ({ sid, agentId, before }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.wid && s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      if (!s.state.sessionId || !/^[0-9a-f-]{36}$/i.test(s.state.sessionId) || typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId))
        throw new DeckError('bad', 'Conversa ou agente inválido.');
      const host = await this.fsFor(s.state.hostId);
      const file = await this.history.findFile(host, await this.homeOf(s.state.hostId), s.state.sessionId, s.state.cwd);
      if (!file) throw new DeckError('notfound', 'Transcript da conversa não encontrado.');
      const sep = host.platform === 'win32' ? '\\' : '/';
      const agentFile = `${file.slice(0, -'.jsonl'.length)}${sep}subagents${sep}agent-${agentId}.jsonl`;
      if (!(await host.fs.exists(agentFile))) throw new DeckError('notfound', 'Transcript deste agente ainda não disponível.');
      return this.history.loadPage(host, agentFile, typeof before === 'number' && Number.isSafeInteger(before) && before >= 0 ? before : undefined, 320_000, true);
    });
    this.on('history.archive', ({ sessionId, archived }) => {
      const set = new Set(this.store.hosts.archivedSessions);
      if (archived) set.add(sessionId);
      else set.delete(sessionId);
      this.store.hosts.archivedSessions = [...set];
      this.store.saveHosts();
      return true;
    });

    // --- terminal
    this.on('term.open', async (p, client) => {
      if (p?.sid) throw new DeckError('bad', 'Vincule o terminal pelo botão Terminal ao Vivo.');
      return this.terminalManager.open({ hostId: p?.hostId, cwd: p?.cwd, cols: p?.cols, rows: p?.rows, wid: client.wid });
    });
    this.on('term.write', (p, client) => {
      const t = this.ownedTerminal(p.id, client);
      if (typeof p.data !== 'string' || p.data.length > 64 * 1024) throw new DeckError('bad', 'Entrada inválida.');
      // Respostas do emulador: o xterm do servidor já respondeu uma vez ao processo real.
      if (isTerminalReport(p.data)) return true;
      // Foco da janela não é digitação: não bloqueia nem invalida o estado do agente.
      if (isFocusReport(p.data)) return this.terminalManager.write(p.id, p.data);
      const s = t.sid ? this.sessions.sessions.get(t.sid) : undefined;
      if (s?.state.executionMode === 'terminal' && ['running', 'starting', 'reconnecting'].includes(s.state.phase)) {
        if (p.data !== '\x03') throw new DeckError('busy', 'O Claude está trabalhando neste terminal. Pare o Claude antes de assumir o teclado. Ctrl+C interrompe.');
        // Ctrl+C é sempre possível e também cancela o turno para não haver um próximo comando automático.
        void s.interrupt().catch((e) => this.log(`interrupção do terminal: ${e.message}`));
      }
      if (p.data === '\x03') this.termAgent?.manualTakeover(p.id);
      else this.termAgent?.notifyManualInput(p.id);
      return this.terminalManager.write(p.id, p.data);
    });
    this.on('term.resize', (p, client) => {
      this.ownedTerminal(p.id, client);
      if (!Number.isInteger(p.cols) || !Number.isInteger(p.rows) || p.cols < 2 || p.rows < 1 || p.cols > 1000 || p.rows > 500) throw new DeckError('bad', 'Dimensões inválidas.');
      return this.terminalManager.resize(p.id, p.cols, p.rows);
    });
    this.on('term.close', (p, client) => { this.ownedTerminal(p.id, client); return this.terminalManager.close(p.id); });
    this.on('term.list', (_p, client) => this.terminalManager.list().filter((t) => t.wid === client.wid));
    this.on('term.replay', ({ id, since }, client) => {
      this.ownedTerminal(id, client);
      const replay = this.terminalManager.replay(id);
      if (!replay) return null;
      const start = replay.upto - replay.data.length;
      const valid = Number.isInteger(since) && since >= start && since <= replay.upto;
      return { ...replay, data: valid ? replay.data.slice(since - start) : replay.data, reset: since !== undefined && !valid };
    });
    this.on('sessions.setExecutionMode', async ({ sid, mode, terminalId }, client) => {
      const s = this.sessions.get(sid);
      if (s.state.wid !== client.wid) throw new DeckError('otherwindow', 'Esta conversa pertence a outra janela.');
      if (mode !== 'silent' && mode !== 'terminal') throw new DeckError('bad', 'Modo inválido.');
      if (['running', 'starting', 'reconnecting'].includes(s.state.phase)) throw new DeckError('busy', 'Aguarde o fim da tarefa ou pare o Claude antes de trocar o modo.');
      const id = mode === 'terminal' ? await this.terminalBinder.bind(s, typeof terminalId === 'string' ? terminalId : undefined, true) : s.state.terminalId;
      s.setExecutionMode(mode);
      return { terminalId: id ?? null };
    });
  }

  private ownedTerminal(id: string, client: Client) {
    const t = this.terminalManager.info(id);
    if (!t || t.wid !== client.wid) throw new DeckError('noterminal', 'Terminal não encontrado nesta janela.');
    return t;
  }

  private emitToWindow(wid: string | undefined, event: string, data: any) {
    const text = JSON.stringify({ event, data });
    for (const c of this.clients) if (c.wid === wid && c.ws.readyState === 1) c.ws.send(text);
  }

  private termAgent: TerminalAgent | null = null;
  private termBindings = new Map<string, Promise<string>>();
  private terminalBinder: TerminalBinder = {
    agent: () => this.termAgent ?? (this.termAgent = new TerminalAgent(this.terminalManager)),
    bind: (s, prefer, create = false) => {
      const pending = this.termBindings.get(s.state.sid);
      if (pending) return pending;
      const task = this.bindTerminal(s, prefer, create);
      this.termBindings.set(s.state.sid, task);
      void task.finally(() => this.termBindings.delete(s.state.sid)).catch(() => {});
      return task;
    },
    reveal: (id, s) => this.emitToWindow(s.state.wid, 'term.reveal', { id, sid: s.state.sid, wid: s.state.wid }),
  };

  private async bindTerminal(s: ClaudeSession, prefer: string | undefined, create: boolean): Promise<string> {
    const tm = this.terminalManager;
    const ok = (id: string | undefined): id is string => {
      const t = id ? tm.info(id) : undefined;
      return !!t && t.hostId === s.state.hostId && t.wid === s.state.wid && (!t.sid || t.sid === s.state.sid);
    };
    if (prefer && !ok(prefer)) throw new DeckError('noterminal', 'Terminal de outra janela, servidor ou conversa.');
    let id = prefer ?? (ok(s.state.terminalId) ? s.state.terminalId : undefined);
    if (!id) {
      if (!create) throw new DeckError('noterminal', 'Terminal perdido. Reative Terminal ao Vivo e confira o destino antes de continuar.');
      // Não adotar silenciosamente uma aba livre: ela pode estar conectada a outro equipamento.
      const info = await tm.open({ hostId: s.state.hostId, cwd: s.state.cwd, wid: s.state.wid, sid: s.state.sid, cols: 120, rows: 32 });
      id = info.id;
      this.emitToWindow(s.state.wid, 'term.opened', info);
    }
    if (s.state.phase === 'ended') throw new DeckError('nosession', 'Conversa encerrada.');
    tm.setSid(id, s.state.sid);
    s.setTerminal(id);
    this.emitToWindow(s.state.wid, 'term.update', tm.info(id));
    return id;
  }
}
