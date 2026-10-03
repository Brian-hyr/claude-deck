// Transporte de linhas NDJSON entre o app e um processo do Claude Code.
// - LocalTransport: processo filho no Windows (morre junto com o app).
// - RemoteTransport: canal "attach" do runner no servidor (sobrevive a quedas de rede).
import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { ClientChannel } from 'ssh2';

export type EndReason = 'exit' | 'disconnect' | 'missing' | 'killed';

export interface Transport extends EventEmitter {
  /** Escreve uma linha JSON (sem quebra de linha no final). */
  write(line: string): boolean;
  /** Local: encerra o processo. Remoto: só desanexa (o runner continua). */
  close(): void;
  readonly alive: boolean;
  on(event: 'line', fn: (line: string, bytes: number) => void): this;
  on(event: 'end', fn: (info: { reason: EndReason; code?: number | null; stderr?: string }) => void): this;
}

/** Divide um fluxo de bytes em linhas UTF-8, contando bytes (para offsets). */
export class LineSplitter {
  private chunks: Buffer[] = [];
  constructor(private onLine: (line: string, bytes: number) => void) {}
  push(data: Buffer) {
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 10) {
        const part = data.subarray(start, i + 1);
        const full = this.chunks.length ? Buffer.concat([...this.chunks, part]) : part;
        this.chunks = [];
        const text = full.toString('utf8').replace(/\r?\n$/, '');
        this.onLine(text, full.length);
        start = i + 1;
      }
    }
    if (start < data.length) this.chunks.push(Buffer.from(data.subarray(start)));
  }
  get pendingBytes() {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }
}

export class LocalTransport extends EventEmitter implements Transport {
  private proc: ChildProcess;
  private _alive = true;
  private stderrTail: string[] = [];
  private killed = false;

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super();
    // Scripts .js/.mjs (usados nos testes) rodam pelo próprio Node.
    const isScript = /\.(mjs|cjs|js)$/i.test(bin);
    this.proc = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...args] : args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const split = new LineSplitter((l, b) => this.emit('line', l, b));
    this.proc.stdout!.on('data', (d: Buffer) => split.push(d));
    this.proc.stderr!.on('data', (d: Buffer) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) this.stderrTail.push(l);
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40);
    });
    this.proc.stdin!.on('error', () => {
      /* processo já saiu */
    });
    this.proc.on('error', (e) => {
      this.stderrTail.push(e.message);
    });
    this.proc.on('close', (code) => {
      this._alive = false;
      this.emit('end', { reason: this.killed ? 'killed' : 'exit', code, stderr: this.stderrTail.join('\n') });
    });
  }

  get pid() {
    return this.proc.pid;
  }

  get alive() {
    return this._alive;
  }

  write(line: string) {
    if (!this._alive) return false;
    this.proc.stdin!.write(line + '\n');
    return true;
  }

  close() {
    if (!this._alive) return;
    this.killed = true;
    const pid = this.proc.pid;
    if (process.platform === 'win32' && pid) {
      // Encerra a árvore inteira (o CLI abre PowerShell, MCPs etc.).
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else this.proc.kill('SIGTERM');
  }
}

export class RemoteTransport extends EventEmitter implements Transport {
  private _alive = true;
  private sawExit = false;
  private sawMissing = false;
  private exitCode: number | null = null;
  private closedByUs = false;

  constructor(private ch: ClientChannel) {
    super();
    const split = new LineSplitter((line, bytes) => {
      if (line.startsWith('{"type":"deck_runner"')) {
        try {
          const m = JSON.parse(line);
          if (m.event === 'exit') {
            this.sawExit = true;
            this.exitCode = typeof m.code === 'number' ? m.code : null;
            return;
          }
          if (m.event === 'missing') {
            this.sawMissing = true;
            return;
          }
          // idle_kill vem do arquivo de saída: conta bytes normalmente.
        } catch {
          /* linha estranha: repassa */
        }
      }
      this.emit('line', line, bytes);
    });
    ch.on('data', (d: Buffer) => split.push(d));
    ch.stderr.on('data', () => {
      /* stderr do runner não interessa */
    });
    ch.on('close', () => {
      this._alive = false;
      const reason: EndReason = this.sawMissing ? 'missing' : this.sawExit ? 'exit' : this.closedByUs ? 'killed' : 'disconnect';
      this.emit('end', { reason, code: this.exitCode });
    });
  }

  get alive() {
    return this._alive;
  }

  write(line: string) {
    if (!this._alive) return false;
    return this.ch.write(line + '\n');
  }

  close() {
    if (!this._alive) return;
    this.closedByUs = true;
    try {
      this.ch.end();
      this.ch.close();
    } catch {
      /* já fechado */
    }
  }
}
