// Terminais interativos: local (node-pty) e remoto (shell com PTY pela conexão SSH do servidor).
// Cada terminal guarda:
// - a saída bruta recente, para a interface reabrir a aba com o que já estava na tela;
// - uma tela "invisível" (xterm headless) com o mesmo conteúdo que o usuário vê, que o Claude lê
//   quando digita no terminal ao vivo (ver agent.ts).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import pty from 'node-pty';
import type { ClientChannel } from 'ssh2';
import type { HostRegistry } from '../hosts/registry';
import { shq } from '../fs/hostfs';
import { LOCAL_HOST_ID, type TerminalTabInfo } from '../../shared/types';
import { DeckError } from '../../shared/protocol';
import { Screen } from './screen';

/** Saída bruta guardada por terminal (para reabrir a aba). */
const RAW_MAX = 512 * 1024;

interface TermEntry {
  id: string;
  kind: 'local' | 'remote';
  hostId: string;
  title: string;
  cwd?: string;
  wid?: string;
  /** Conversa que controla este terminal (modo Terminal ao Vivo). */
  sid?: string;
  pty?: pty.IPty;
  ch?: ClientChannel;
  screen: Screen;
  raw: string;
  /** Posição (em caracteres desde a abertura) do primeiro caractere de `raw`. */
  rawStart: number;
  /** Caracteres recebidos desde a abertura. */
  total: number;
  lastDataAt: number;
  /** Quando este terminal foi aberto (para o agente saber se ainda está "recém-aberto"). */
  openedAt: number;
}

export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, TermEntry>();

  constructor(
    private registry: HostRegistry,
    private log: (msg: string) => void,
  ) {
    super();
  }

  async open(opts: { hostId?: string; cwd?: string; cols?: number; rows?: number; wid?: string; sid?: string }): Promise<TerminalTabInfo> {
    const id = crypto.randomUUID();
    const hostId = opts.hostId || LOCAL_HOST_ID;
    const cols = Number.isFinite(opts.cols) ? Math.max(20, Math.min(1000, Math.floor(opts.cols!))) : 80;
    const rows = Number.isFinite(opts.rows) ? Math.max(5, Math.min(500, Math.floor(opts.rows!))) : 24;

    if (hostId === LOCAL_HOST_ID) {
      const isWin = process.platform === 'win32';
      const shell = isWin ? (process.env.COMSPEC ? 'powershell.exe' : 'cmd.exe') : process.env.SHELL || '/bin/bash';
      const cwd = opts.cwd || os.homedir();
      let ptyProc: pty.IPty;
      try {
        ptyProc = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string> });
      } catch (err: any) {
        this.log(`[term:${id}] Falha ao iniciar terminal local: ${err?.message ?? err}`);
        throw new DeckError('spawn_failed', `Não foi possível iniciar o terminal local: ${err?.message ?? err}`);
      }
      const entry = this.add({ id, kind: 'local', hostId, title: isWin ? 'PowerShell' : 'Terminal', cwd, wid: opts.wid, sid: opts.sid, pty: ptyProc }, cols, rows);
      ptyProc.onData((data) => this.onData(entry, data));
      ptyProc.onExit(({ exitCode }) => this.onExit(entry, exitCode ?? 0));
      this.log(`[term:${id}] Terminal local aberto (${entry.title}, cwd: ${cwd})`);
      return this.info(id)!;
    }

    const handle = this.registry.get(hostId);
    if (handle.kind !== 'ssh' || !handle.ssh) throw new DeckError('not_ssh', `O host ${hostId} não é um servidor SSH.`);
    const ssh = handle.ssh;
    await ssh.ensure();
    let ch: ClientChannel;
    try {
      ch = await ssh.shell({ term: 'xterm-256color', cols, rows });
    } catch (err: any) {
      this.log(`[term:${id}] Falha ao abrir shell em ${hostId}: ${err?.message ?? err}`);
      throw new DeckError('ssh_shell_failed', `Falha ao abrir shell no servidor ${hostId}: ${err?.message ?? err}`);
    }
    const entry = this.add({ id, kind: 'remote', hostId, title: `SSH: ${ssh.alias}`, cwd: opts.cwd, wid: opts.wid, sid: opts.sid, ch }, cols, rows);
    // Caracteres acentuados podem chegar partidos entre dois pedaços.
    const dec = new StringDecoder('utf8');
    ch.on('data', (chunk: Buffer) => this.onData(entry, dec.write(chunk)));
    ch.on('close', () => this.onExit(entry, 0));
    ch.on('error', (err: any) => this.log(`[term:${id}] erro no canal SSH: ${err?.message ?? err}`));
    if (opts.cwd) ch.write(`cd ${shq(opts.cwd)}\n`);
    this.log(`[term:${id}] Shell remoto aberto em ${hostId} (cwd: ${opts.cwd ?? '~'})`);
    return this.info(id)!;
  }

  private add(e: Omit<TermEntry, 'screen' | 'raw' | 'rawStart' | 'total' | 'lastDataAt' | 'openedAt'>, cols: number, rows: number): TermEntry {
    const now = Date.now();
    const entry: TermEntry = { ...e, screen: new Screen(cols, rows, (data) => { this.write(e.id, data); }), raw: '', rawStart: 0, total: 0, lastDataAt: now, openedAt: now };
    this.terminals.set(entry.id, entry);
    return entry;
  }

  private onData(t: TermEntry, data: string) {
    if (!data) return;
    const from = t.total;
    t.total += data.length;
    t.lastDataAt = Date.now();
    t.raw += data;
    if (t.raw.length > RAW_MAX) {
      // Corta no começo de uma linha (perto do limite) para não partir uma sequência de escape.
      const cut = t.raw.length - RAW_MAX;
      const nl = t.raw.indexOf('\n', cut);
      const k = nl >= 0 && nl - cut < 8192 ? nl + 1 : cut;
      t.raw = t.raw.slice(k);
      t.rawStart += k;
    }
    t.screen.write(data);
    this.emit('data', t.id, data, from);
  }

  private onExit(t: TermEntry, code: number) {
    if (this.terminals.get(t.id) !== t) return;
    this.terminals.delete(t.id);
    t.screen.dispose();
    this.emit('exit', t.id, code);
  }

  write(id: string, data: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    try {
      if (t.pty) t.pty.write(data);
      else t.ch!.write(data);
      return true;
    } catch (e: any) {
      this.log(`[term:${id}] erro ao escrever: ${e?.message ?? e}`);
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try {
      if (t.pty) t.pty.resize(c, r);
      else t.ch!.setWindow(r, c, 0, 0);
      t.screen.resize(c, r);
      return true;
    } catch {
      return false;
    }
  }

  close(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    try {
      if (t.pty) t.pty.kill();
      else t.ch!.close();
    } catch {
      /* já fechado */
    }
    this.onExit(t, 0);
    return true;
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  info(id: string): TerminalTabInfo | undefined {
    const t = this.terminals.get(id);
    return t && { id: t.id, hostId: t.hostId, title: t.title, cwd: t.cwd, sid: t.sid, wid: t.wid };
  }

  list(wid?: string): TerminalTabInfo[] {
    return [...this.terminals.values()].filter((t) => !wid || t.wid === wid).map((t) => this.info(t.id)!);
  }

  /** Liga (ou desliga, com undefined) o terminal a uma conversa. */
  setSid(id: string, sid: string | undefined) {
    const t = this.terminals.get(id);
    if (t) t.sid = sid;
  }

  /** Saída bruta guardada e a posição até onde ela vai (a interface ignora eventos já incluídos). */
  replay(id: string): { data: string; upto: number } | null {
    const t = this.terminals.get(id);
    return t ? { data: t.raw, upto: t.total } : null;
  }

  screen(id: string): Screen | undefined {
    return this.terminals.get(id)?.screen;
  }

  stats(id: string): { total: number; lastDataAt: number; openedAt: number } | undefined {
    const t = this.terminals.get(id);
    return t && { total: t.total, lastDataAt: t.lastDataAt, openedAt: t.openedAt };
  }

  /** Chegou alguma quebra de linha depois da posição `since`? */
  newlineSince(id: string, since: number): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    return t.raw.slice(Math.max(0, since - t.rawStart)).includes('\n');
  }

  closeForWindow(wid?: string) {
    if (!wid) return;
    for (const [id, t] of [...this.terminals]) if (t.wid === wid) this.close(id);
  }

  closeAll() {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }
}
