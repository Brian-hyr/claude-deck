// Sessões efêmeras de login das CLIs. Nunca passam pelo terminal ao vivo nem são gravadas em disco.
import crypto from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import pty from 'node-pty';
import type { HostRegistry } from '../hosts/registry';
import { shq } from '../fs/hostfs';
import { LOCAL_HOST_ID, type AgentEngine } from '../../shared/types';
import { DeckError } from '../../shared/protocol';
import { Screen } from '../terminal/screen';

export type AuthPhase = 'starting' | 'awaiting_browser' | 'verifying' | 'success' | 'error' | 'cancelled';
export interface CliAuthState { id: string; phase: AuthPhase; url?: string; message?: string }
interface Entry {
  id: string; owner: number; hostId: string; engine: AgentEngine; phase: AuthPhase;
  url?: string; message?: string; screen: Screen; write: (s: string) => void; kill: () => void;
  timer: NodeJS.Timeout; scan?: NodeJS.Timeout; selected: boolean; submitted: boolean; closed: boolean;
}

/** URL é dado não confiável fornecido pelo processo remoto. Nunca abre automaticamente. */
export function authUrl(text: string, engine: AgentEngine): string | undefined {
  // Algumas CLIs desenham a URL em várias linhas. Não incorporamos texto de explicação ou outras URLs.
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const start = rows[i].match(/https:\/\/[^\s]+/);
    if (!start) continue;
    let candidate = start[0];
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j].trim();
      if (!next || !/^[A-Za-z0-9%&_=+./?~#:-]+$/.test(next) || /^https?:/i.test(next)) break;
      // A continuação só faz sentido quando não há mensagem em linguagem natural.
      if (!/[=&%?]/.test(candidate) && candidate.endsWith('/')) break;
      candidate += next;
      if (candidate.length > 8192) return;
    }
    try {
      const u = new URL(candidate);
      const hosts = engine === 'antigravity'
        ? ['accounts.google.com']
        : ['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com'];
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname)) continue;
      if (!u.searchParams.has('state') || !u.searchParams.has('redirect_uri')) continue;
      // Uma URL Google legítima ainda poderia autorizar um aplicativo desconhecido.
      // O fluxo observado da CLI usa exclusivamente este retorno oficial.
      if (engine === 'antigravity' && u.searchParams.get('redirect_uri') !== 'https://antigravity.google/oauth-callback') continue;
      return u.toString();
    } catch { /* saída parcial ou inválida */ }
  }
}

export class CliAuthManager {
  private entries = new Map<string, Entry>();
  constructor(private registry: HostRegistry) {}

  private view(e: Entry): CliAuthState {
    return { id: e.id, phase: e.phase, ...(e.phase === 'awaiting_browser' && e.url ? { url: e.url } : {}), ...(e.message ? { message: e.message } : {}) };
  }
  private get(owner: number, id: unknown): Entry {
    const e = typeof id === 'string' ? this.entries.get(id) : undefined;
    if (!e || e.owner !== owner) throw new DeckError('notfound', 'Login não encontrado nesta janela.');
    return e;
  }
  async start(owner: number, hostId: unknown, engine: unknown): Promise<CliAuthState> {
    if (typeof hostId !== 'string' || !this.registry.exists(hostId) || (engine !== 'claude' && engine !== 'antigravity')) throw new DeckError('bad', 'Servidor ou motor inválido.');
    if ([...this.entries.values()].some((e) => e.hostId === hostId && e.engine === engine && !e.closed)) throw new DeckError('busy', 'Já existe um login em andamento para este motor neste servidor.');
    // Reserva antes de qualquer await para impedir duas tentativas concorrentes.
    const id = crypto.randomUUID();
    const e: Entry = { id, owner, hostId, engine, phase: 'starting', screen: new Screen(240, 50), write: () => {}, kill: () => {}, selected: false, submitted: false, closed: false, timer: setTimeout(() => {}, 0) };
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.finish(e, 'error', 'Tempo de login esgotado. Tente novamente.'), 10 * 60_000);
    this.entries.set(id, e);
    try {
      const status = await this.registry.connect(hostId);
      if (e.closed) return this.view(e);
      const bin = engine === 'claude' ? status.claude?.path : status.agy?.path;
      if (!bin) throw new DeckError('missing', `${engine === 'claude' ? 'Claude Code' : 'Antigravity CLI'} não encontrado neste servidor.`);
      const args = engine === 'claude' ? ['auth', 'login'] : [];
      if (hostId === LOCAL_HOST_ID) {
        const env = { ...process.env }; delete env.NODE_OPTIONS;
        let command = bin; let argv = args;
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
          if (/[&|<>^%!\r\n"]/.test(bin)) throw new DeckError('bad', 'Caminho da CLI contém caracteres incompatíveis com o login no Windows.');
          command = process.env.ComSpec || 'cmd.exe';
          // node-pty faz o escape dos argumentos no Windows; aspas adicionais viram texto literal.
          argv = ['/d', '/c', bin, ...args];
        }
        const child = pty.spawn(command, argv, { name: 'xterm-256color', cols: 240, rows: 50, cwd: os.homedir(), env: env as Record<string, string> });
        e.write = (s) => child.write(s); e.kill = () => { try { child.kill(); } catch {} };
        child.onData((data) => this.data(e, data));
        child.onExit(({ exitCode }) => this.exit(e, exitCode));
      } else {
        const ssh = this.registry.get(hostId).ssh!;
        const ch = await ssh.shell({ term: 'xterm-256color', cols: 240, rows: 50 });
        if (e.closed) { ch.close(); return this.view(e); }
        e.write = (s) => { ch.write(s); }; e.kill = () => { try { ch.close(); } catch {} };
        const dec = new StringDecoder('utf8');
        ch.on('data', (chunk: Buffer) => this.data(e, dec.write(chunk)));
        let code: number | null = null;
        ch.on('exit', (c: number | null) => { code = c; });
        ch.on('close', () => this.exit(e, code));
        ch.on('error', () => this.finish(e, 'error', 'A conexão do login foi interrompida.'));
        // Somente executável detectado no próprio host e argumentos fixos. Nunca recebe comando do navegador.
        ch.write(`stty -echo; exec ${shq(bin)}${args.map((x) => ' ' + shq(x)).join('')}\n`);
      }
      return this.view(e);
    } catch (err) {
      this.finish(e, 'error', err instanceof DeckError ? err.message : 'Não foi possível iniciar o login.');
      return this.view(e);
    }
  }
  private data(e: Entry, data: string) {
    if (e.closed) return;
    e.screen.write(data);
    if (e.scan) clearTimeout(e.scan);
    e.scan = setTimeout(() => void this.scan(e), 300);
  }
  private async scan(e: Entry) {
    await e.screen.flush();
    if (e.closed) return;
    const text = e.screen.viewport().join('\n');
    if (e.phase === 'starting' && e.engine === 'antigravity' && !e.selected && /select login method/i.test(text) && /1\.\s*Google OAuth/i.test(text)) {
      e.selected = true;
      // Só escolhe quando é possível identificar qual opção está selecionada.
      if (/\>\s*2\.\s*Use a Google Cloud project/i.test(text)) e.write('\x1b[A\r');
      else if (/\>\s*1\.\s*Google OAuth/i.test(text)) e.write('\r');
      else { this.finish(e, 'error', 'Menu de login do Antigravity não reconhecido.'); return; }
    }
    if (e.phase === 'starting') {
      const url = authUrl(text, e.engine);
      if (url) { e.url = url; e.phase = 'awaiting_browser'; }
    }
    if (e.phase === 'verifying' && /(?:login|authentication|sign.?in)\s+(?:successful|succeeded|complete)/i.test(text)) this.finish(e, 'success', 'Login confirmado pela CLI.');
  }
  private exit(e: Entry, code: number | null) {
    if (e.closed) return;
    if (e.engine === 'claude' && code === 0) this.finish(e, 'success', 'Login concluído pelo Claude Code.');
    else this.finish(e, 'error', code === null ? 'A conexão terminou sem confirmar o login.' : 'A CLI terminou sem confirmar o login.');
  }
  private finish(e: Entry, phase: AuthPhase, message: string) {
    if (e.closed) return;
    e.closed = true; e.phase = phase; e.message = message; e.url = undefined;
    clearTimeout(e.timer); if (e.scan) clearTimeout(e.scan);
    e.kill(); e.screen.dispose();
    // O estado final fica disponível por pouco tempo para a janela receber o resultado.
    setTimeout(() => this.entries.delete(e.id), 60_000).unref();
  }
  status(owner: number, id: unknown) { return this.view(this.get(owner, id)); }
  submit(owner: number, id: unknown, code: unknown) {
    const e = this.get(owner, id);
    if (e.phase !== 'awaiting_browser' || e.submitted || typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) throw new DeckError('bad', 'Código inválido ou login não está aguardando código.');
    e.submitted = true; e.url = undefined; e.phase = 'verifying';
    // Limpa a tela antes de enviar: eco acidental não será exposto em RPC nem salvo em log.
    e.screen.write('\x1b[2J\x1b[3J\x1b[H');
    e.write(code.trim() + '\r');
    return this.view(e);
  }
  cancel(owner: number, id: unknown) { const e = this.get(owner, id); this.finish(e, 'cancelled', 'Login cancelado.'); return this.view(e); }
  cancelOwner(owner: number) { for (const e of this.entries.values()) if (e.owner === owner && !e.closed) this.finish(e, 'cancelled', 'Conexão encerrada.'); }
  closeAll() { for (const e of this.entries.values()) if (!e.closed) this.finish(e, 'cancelled', 'Servidor encerrado.'); }
}
