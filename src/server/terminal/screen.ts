// Tela "invisível" de um terminal (xterm headless no servidor): recebe a mesma saída que o xterm da
// interface e fica com o mesmo conteúdo que o usuário vê. É dela que o Claude lê o resultado quando
// digita no terminal ao vivo (sem sequências de escape, com as linhas como aparecem na tela).
import headless from '@xterm/headless';
import type { IMarker, Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = headless as unknown as { Terminal: typeof HeadlessTerminal };

export type PromptKind = 'prompt' | 'password' | 'login' | 'confirm' | 'pager';

/**
 * O que a linha do cursor indica quando a saída para: prompt de comando (bash, zsh,
 * [admin@MikroTik] >, <HUAWEI>, [~HUAWEI-...], Router#, Switch>), pedido de senha/usuário,
 * confirmação (yes/no) ou paginação (--More--, [Q quit|D dump|down]). Nulo = nada reconhecido.
 */
export function classifyPromptLine(line: string): PromptKind | null {
  const t = line.replace(/\s+$/, '');
  if (!t || /^(>>|\.\.\.)$/.test(t)) return null;
  if (/-{2,}\s*more\s*-{2,}|---\(more[^)]*\)---|\[q quit\|d dump\|down\]|^\(end\)$|^:$|^--more--/i.test(t)) return 'pager';
  if (/(password|passphrase|senha|passcode|pin)\b[^\n]{0,60}:$/i.test(t) || /^(password|senha)$/i.test(t)) return 'password';
  if (/^(login|username|user ?name|usu[áa]rio|user)\s*:$/i.test(t) || /\b(login|username)\s*:$/i.test(t)) return 'login';
  if (/\((yes\/no|y\/n)[^)]*\)\s*\??:?$|\[(y\/n|yes\/no|y\/n\/q)\]\s*[:?]?$|continue\s*\?\s*(\[[^\]]*\])?\s*:?$|\(y\/n\)\s*$/i.test(t)) return 'confirm';
  if (/[$#%>]$|<[^<>]+>$|\]$/.test(t)) return 'prompt';
  return null;
}

export class Screen {
  private t: HeadlessTerminal;
  private disposed = false;
  private flushWaiters = new Set<() => void>();

  constructor(cols: number, rows: number, reply?: (data: string) => void) {
    this.t = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    // Só este emulador responde às consultas do shell. Reproduzir o histórico no navegador
    // não pode injetar uma segunda resposta de posição/capacidade no processo real.
    if (reply) this.t.onData(reply);
  }

  write(data: string) {
    if (!this.disposed) this.t.write(data);
  }

  /** Espera o emulador processar tudo o que já foi escrito (ele processa em segundo plano). */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { this.flushWaiters.delete(done); resolve(); };
      this.flushWaiters.add(done);
      this.t.write('', done);
    });
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    try {
      this.t.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      /* tamanho inválido: mantém o anterior */
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const done of this.flushWaiters) done();
    this.t.dispose();
  }

  private get buf() {
    return this.t.buffer.active;
  }

  /** Linha absoluta (contando o histórico) onde está o cursor. */
  get cursorRow(): number {
    return this.buf.baseY + this.buf.cursorY;
  }

  get cols() {
    return this.t.cols;
  }

  get rows() {
    return this.t.rows;
  }

  /** Texto da linha do cursor (sem espaços à direita). */
  cursorLine(): string {
    return this.buf.getLine(this.cursorRow)?.translateToString(true) ?? '';
  }

  /** Marca a linha do cursor; a marca acompanha a linha mesmo quando o histórico rola. */
  mark(): IMarker | undefined {
    return this.t.registerMarker(0);
  }

  /** Linhas da tela de `from` até `to` (inclusive), juntando as que quebraram por falta de largura. */
  lines(from: number, to = this.cursorRow): string[] {
    const out: string[] = [];
    const b = this.buf;
    for (let i = Math.max(0, from); i <= Math.min(to, b.length - 1); i++) {
      const line = b.getLine(i);
      if (!line) continue;
      if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true);
      else out.push(line.translateToString(true));
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }

  /** Linhas desde a marca (ou as últimas `fallback` se a marca já saiu do histórico). */
  linesSince(marker: IMarker | undefined, fallback = 200): string[] {
    const from = marker && !marker.isDisposed && marker.line >= 0 ? marker.line : Math.max(0, this.cursorRow - fallback);
    return this.lines(from);
  }

  /** Últimas `n` linhas até o cursor. */
  tail(n: number): string[] {
    return this.lines(this.cursorRow - n + 1);
  }

  /** O que está visível na tela agora (a janela do terminal). */
  viewport(): string[] {
    const top = this.buf.viewportY;
    return this.lines(top, top + this.t.rows - 1);
  }

  /** Tela cheia de programa (vim, htop, less): o conteúdo é a tela, não um histórico de linhas. */
  get fullScreen(): boolean {
    return this.buf.type === 'alternate';
  }
}
