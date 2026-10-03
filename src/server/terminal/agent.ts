// O Claude usando o terminal ao vivo: digita no terminal visível da conversa (como se fosse o
// usuário), espera a saída parar e devolve o que apareceu na tela. Funciona com qualquer coisa
// que esteja rodando no terminal — bash, um ssh aninhado a partir do servidor, o CLI de um
// MikroTik ou de um Huawei — porque só lê a tela; não depende de código de saída nem de shell.
import type { IMarker } from '@xterm/headless';
import { DeckError } from '../../shared/protocol';
import type { TerminalManager } from './manager';
import { classifyPromptLine, type PromptKind } from './screen';

export interface RunOpts {
  /** Tempo máximo esperando o comando (ms). */
  timeoutMs?: number;
  /** Silêncio (ms) para devolver leitura parcial; nunca confirma término de processo. */
  quietMs?: number;
  /** Máximo de linhas devolvidas (o começo é cortado, o fim sempre vem). */
  maxLines?: number;
  /** Sinal de cancelamento (o usuário apertou Parar). */
  signal?: AbortSignal;
}

export interface RunResult {
  /** Linhas que apareceram na tela desde o comando (o eco do comando vem na primeira). */
  output: string;
  /** Linha onde o cursor parou (o prompt, uma pergunta etc.). */
  lastLine: string;
  /** Por que parou de esperar. */
  state: PromptKind | 'quiet' | 'timeout' | 'cancelled';
  truncated: number;
  ms: number;
  fullScreen: boolean;
}

/** Teclas especiais que o Claude pode mandar (nome → sequência). */
export const KEYS: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  delete: '\x1b[3~',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1a',
  'ctrl+l': '\x0c',
  'ctrl+u': '\x15',
  'ctrl+a': '\x01',
  'ctrl+e': '\x05',
  'ctrl+r': '\x12',
  'ctrl+]': '\x1d',
  q: 'q',
  y: 'y',
  n: 'n',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BUSY_MSG =
  'O terminal ainda pode estar rodando o comando anterior (a saída parou sem voltar a um prompt reconhecido, ou o tempo esgotou). Use mcp__deck_terminal__wait para esperar mais ou mcp__deck_terminal__send (ex.: ctrl+c) antes de rodar outro comando.';

/** Terminal com menos que isto de vida ainda conta como "recém-aberto" (shell pode estar subindo). */
const FRESH_WINDOW_MS = 10_000;
/** Silêncio que conta como "o shell assentou" ao esperar o prompt inicial. */
const READY_QUIET_MS = 300;
/** Não trava mais que isto esperando o prompt inicial aparecer. */
const READY_MAX_MS = 4000;

export class TerminalAgent {
  /** Um comando por vez em cada terminal (dois pedidos não se misturam na mesma linha). */
  private locks = new Map<string, Promise<unknown>>();
  /** true = o último run/send/wait terminou sem prompt reconhecido: o comando pode continuar
   * rodando. Enquanto assim, run() novo é recusado — só send()/wait() (explícitos) são aceitos,
   * até um deles ver um prompt reconhecido e destravar. */
  private busy = new Map<string, boolean>();
  /** Cancelamento manual (cancel()/notifyManualInput não usa isto) de UMA chamada em andamento ou
   * na fila para aquele terminal; consumido (removido) assim que essa chamada termina. */
  private manualCancel = new Set<string>();
  /** ids cujo primeiro run() já esperou o shell assentar (não repete a espera nas próximas vezes). */
  private primed = new Set<string>();

  constructor(private tm: TerminalManager) {
    // Some junto com o terminal: nada de estado pendurado para um id que não existe mais.
    this.tm.on('exit', (id: string) => {
      this.locks.delete(id);
      this.busy.delete(id);
      this.manualCancel.delete(id);
      this.primed.delete(id);
    });
  }

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  private isAborted(id: string, opts: RunOpts): boolean {
    return !!opts.signal?.aborted || this.manualCancel.has(id);
  }

  /** 'quiet'/'timeout'/'cancelled' não confirmam que o comando acabou: fica ocupado até um
   * prompt reconhecido aparecer. */
  private settleBusy(id: string, state: RunResult['state']) {
    this.busy.set(id, state === 'quiet' || state === 'timeout' || state === 'cancelled');
  }

  /** O terminal está com um comando cujo fim não foi confirmado (run() novo será recusado). */
  isBusy(id: string): boolean {
    return this.busy.get(id) === true;
  }

  /**
   * Cancela a chamada em andamento (ou esperando na fila) deste terminal, se houver alguma.
   * Diferente do `signal` de cada chamada (por pedido), serve para controle manual/externo — ex.:
   * um botão "Parar" que não guardou o AbortSignal original. Devolve false se não havia nada a
   * cancelar. Cancela só a próxima chamada a rodar; não afeta chamadas futuras não relacionadas.
   */
  cancel(id: string): boolean {
    if (!this.locks.has(id)) return false;
    this.manualCancel.add(id);
    return true;
  }

  /**
   * Avisa que chegou entrada manual no terminal por fora do agente (o usuário digitou direto na
   * aba, sem passar por run/send/wait). Por segurança, marca o terminal como ocupado: o próximo
   * run() exige um wait()/send() explícito antes (o mesmo destravamento de `busy`), porque o
   * agente não sabe mais em que estado o terminal ficou depois da digitação manual.
   */
  notifyManualInput(id: string): void {
    if (this.tm.has(id)) this.busy.set(id, true);
  }

  /**
   * Interlock de entrada manual, para quem escreve bytes crus no terminal por fora do agente (a
   * aba da interface): true = nenhum run/send/wait está rodando OU na fila para este terminal —
   * digitar direto é seguro. false = há uma chamada do agente em andamento; nesse caso, ou manda só
   * ctrl+c (\x03, sempre seguro de passar direto) via TerminalManager.write, ou chama
   * manualTakeover() antes de escrever o resto.
   */
  hasPendingOperation(id: string): boolean {
    return this.locks.has(id);
  }

  /**
   * Tomada de controle manual: cancela a chamada do agente em andamento/na fila para este terminal
   * (se houver) e invalida o estado — o próximo run() do agente vai exigir um wait()/send()
   * explícito antes de continuar, porque o agente não sabe o que o humano fez enquanto digitava.
   * Equivale a cancel(id) + notifyManualInput(id). Devolve true se havia algo para cancelar.
   */
  manualTakeover(id: string): boolean {
    const had = this.cancel(id);
    this.notifyManualInput(id);
    return had;
  }

  /** Digita uma linha de comando (e Enter) e espera o resultado. */
  run(id: string, command: string, opts: RunOpts = {}): Promise<RunResult> {
    if (/[\r\n]/.test(command.replace(/[\r\n]+$/, ''))) {
      throw new DeckError('bad', 'Uma linha por vez: mande cada comando numa chamada (equipamentos de rede não aceitam várias linhas coladas).');
    }
    return this.exclusive(id, () => this.typeAndWait(id, command.replace(/[\r\n]+$/, '') + '\r', opts, true));
  }

  /** Manda teclas (texto e/ou teclas especiais) e espera a tela assentar. */
  send(id: string, input: { text?: string; keys?: string[] }, opts: RunOpts = {}): Promise<RunResult> {
    let data = input.text ?? '';
    for (const k of input.keys ?? []) {
      const seq = KEYS[k.toLowerCase()];
      if (seq === undefined) throw new DeckError('bad', `Tecla desconhecida: ${k}. Use: ${Object.keys(KEYS).join(', ')}.`);
      data += seq;
    }
    if (!data) throw new DeckError('bad', 'Nada para enviar.');
    return this.exclusive(id, () => this.typeAndWait(id, data, { quietMs: 600, timeoutMs: 20_000, ...opts }, false));
  }

  /** Só espera (comando demorado que ainda está rodando) e devolve o que apareceu. */
  wait(id: string, opts: RunOpts = {}): Promise<RunResult> {
    return this.exclusive(id, () => this.typeAndWait(id, '', opts, false));
  }

  /** O que está na tela agora (sem digitar nada). */
  async read(id: string, lines = 60): Promise<{ output: string; lastLine: string; fullScreen: boolean }> {
    const sc = this.tm.screen(id);
    if (!sc) throw new DeckError('noterm', 'O terminal foi fechado.');
    await sc.flush();
    const rows = sc.fullScreen ? sc.viewport() : sc.tail(Math.max(1, Math.min(lines, 2000)));
    return { output: rows.join('\n'), lastLine: sc.cursorLine(), fullScreen: sc.fullScreen };
  }

  private async typeAndWait(id: string, data: string, opts: RunOpts, isCommand: boolean): Promise<RunResult> {
    const sc = this.tm.screen(id);
    if (!sc) throw new DeckError('noterm', 'O terminal foi fechado.');
    const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 60_000, 30 * 60_000));
    const quietMs = Math.max(200, Math.min(opts.quietMs ?? 1500, 60_000));
    const maxLines = Math.max(10, Math.min(opts.maxLines ?? 400, 5000));
    try {
      await sc.flush();
      // Pedido já cancelado (inclusive um que só esperava a vez na fila): não escreve nada — sem
      // isso, um cancelamento enquanto ainda na fila digitaria mesmo assim (bug conhecido).
      if (this.isAborted(id, opts)) {
        return { output: '', lastLine: sc.cursorLine(), state: 'cancelled', truncated: 0, ms: 0, fullScreen: sc.fullScreen };
      }
      // run() novo não é aceito enquanto o comando anterior não confirmou o fim (prompt
      // reconhecido); só send()/wait() explícitos passam — é o jeito de checar/mexer no que
      // pode ainda estar rodando sem lançar outro comando por cima.
      if (isCommand && this.busy.get(id)) {
        throw new DeckError('busy', BUSY_MSG);
      }

      // Terminal recém-aberto: o shell ainda pode estar subindo (banner, MOTD, .bashrc, ssh
      // negociando). Espera assentar antes do PRIMEIRO run() — digitar cedo demais arrisca a
      // tecla se perder ou se misturar com a inicialização.
      if (isCommand && !this.primed.has(id)) {
        const opened = this.tm.stats(id)?.openedAt;
        if (opened !== undefined && Date.now() - opened < FRESH_WINDOW_MS) {
          const readyStart = Date.now();
          for (;;) {
            if (this.isAborted(id, opts)) {
              // Ainda não escreveu nada (só esperava o shell assentar): sem efeito colateral,
              // então não mexe em `busy` — mantém o que já se sabia do terminal antes.
              this.primed.add(id);
              return { output: '', lastLine: sc.cursorLine(), state: 'cancelled', truncated: 0, ms: Date.now() - readyStart, fullScreen: sc.fullScreen };
            }
            await sc.flush();
            const st = this.tm.stats(id);
            if (!st) throw new DeckError('noterm', 'O terminal foi fechado.');
            const quiet = Date.now() - st.lastDataAt;
            if ((quiet >= READY_QUIET_MS && classifyPromptLine(sc.cursorLine())) || Date.now() - readyStart >= READY_MAX_MS) break;
            await sleep(50);
          }
        }
        this.primed.add(id);
      }

      // run() é para linha de comando, não para responder credencial: se a tela AGORA pede
      // senha/usuário, digitar o "comando" ali seria mandar texto arbitrário (talvez até
      // logado) para dentro de um prompt de senha. Recusa e manda usar send() com o que o
      // usuário informou explicitamente (nunca inventar/adivinhar senha).
      if (isCommand) {
        await sc.flush();
        const cur = classifyPromptLine(sc.cursorLine());
        if (cur === 'password' || cur === 'login') {
          throw new DeckError(
            'credential_prompt',
            `O terminal está pedindo ${cur === 'password' ? 'SENHA' : 'usuário/login'} agora — não dá para digitar um comando aí. Não invente nem adivinhe: peça para o usuário digitar direto no terminal, ou use mcp__deck_terminal__send apenas com o que ele informou explicitamente.`,
          );
        }
        if (cur !== 'prompt' || sc.fullScreen) {
          throw new DeckError('not_ready', 'Não há um prompt de comando reconhecido. Pode haver entrada parcial, confirmação, paginação ou programa ativo. Leia a tela e use mcp__deck_terminal__send explicitamente; nenhum comando foi digitado.');
        }
      }

      const marker: IMarker | undefined = sc.mark();
      try {
        const start = this.tm.stats(id)!.total;
        const t0 = Date.now();
        if (this.isAborted(id, opts)) return { output: '', lastLine: sc.cursorLine(), state: 'cancelled', truncated: 0, ms: 0, fullScreen: sc.fullScreen };
        if (data && !this.tm.write(id, data)) throw new DeckError('noterm', 'Não consegui escrever no terminal.');

        let state: RunResult['state'] = 'timeout';
        for (;;) {
          await sleep(100);
          if (this.isAborted(id, opts)) {
            state = 'cancelled';
            break;
          }
          const st = this.tm.stats(id);
          if (!st) throw new DeckError('noterm', 'O terminal foi fechado durante o comando.');
          const now = Date.now();
          if (now - t0 >= timeoutMs) break;
          const quiet = now - st.lastDataAt;
          const got = st.total > start;
          // Espera o eco do comando e o começo da resposta antes de avaliar a última linha
          // (senão o prompt de ANTES do comando pareceria o fim).
          if (isCommand && !this.tm.newlineSince(id, start)) {
            if (quiet >= quietMs && now - t0 >= Math.max(quietMs, 3000)) {
              state = 'quiet';
              break;
            }
            continue;
          }
          if (!got && data) {
            if (now - t0 >= quietMs + 1000) {
              state = 'quiet';
              break;
            }
            continue;
          }
          await sc.flush();
          const kind = classifyPromptLine(sc.cursorLine());
          if (kind && quiet >= 250) {
            state = kind;
            break;
          }
          if (quiet >= quietMs) {
            state = 'quiet';
            break;
          }
        }

        // Captura a saída ENQUANTO a marca ainda existe (dispose só depois de lida — versão
        // anterior descartava a marca antes de usá-la, e linesSince caía no fallback errado).
        await sc.flush();
        let rows = sc.fullScreen ? sc.viewport() : sc.linesSince(marker);
        let truncated = 0;
        if (rows.length > maxLines) {
          truncated = rows.length - maxLines;
          rows = rows.slice(-maxLines);
        }
        this.settleBusy(id, state);
        return { output: rows.join('\n'), lastLine: sc.cursorLine(), state, truncated, ms: Date.now() - t0, fullScreen: sc.fullScreen };
      } finally {
        marker?.dispose?.();
      }
    } finally {
      this.manualCancel.delete(id);
    }
  }
}

/** Texto do resultado para o Claude (o que ele lê de volta da ferramenta). */
export function describeResult(r: RunResult): string {
  const hints: Record<RunResult['state'], string> = {
    prompt: 'A última linha parece um prompt. Confira o contexto; não foi coletado código de saída.',
    password: 'O terminal está PEDINDO SENHA. Não invente nem adivinhe senha: peça ao usuário que digite no terminal (ele pode digitar direto) ou pergunte se ele quer informar.',
    login: 'O terminal está pedindo usuário/login.',
    confirm: 'O terminal está pedindo CONFIRMAÇÃO (sim/não). Responda com mcp__deck_terminal__send só se a ação foi pedida pelo usuário.',
    pager: 'A saída está PAGINADA (--More-- ou similar). Mande a tecla space para ver mais ou q para sair. Em equipamentos de rede, prefira desligar a paginação antes (ex.: MikroTik: acrescente "without-paging"; Huawei: "screen-length 0 temporary"; Cisco: "terminal length 0").',
    quiet: 'A saída parou, mas o cursor não está num prompt reconhecido: o comando pode ainda estar rodando ou esperando algo. Use mcp__deck_terminal__read para conferir ou mcp__deck_terminal__wait para esperar mais.',
    timeout: 'Tempo esgotado e a saída ainda não parou: o comando continua rodando no terminal. Use mcp__deck_terminal__wait para esperar mais ou mcp__deck_terminal__send com ctrl+c para interromper.',
    cancelled: 'Cancelado.',
  };
  const head = r.truncated ? `[... ${r.truncated} linhas anteriores omitidas]\n` : '';
  const screen = r.fullScreen ? '[programa em tela cheia: esta é a tela atual]\n' : '';
  return `${screen}${head}${r.output || '(nada apareceu na tela)'}\n\n--- ${hints[r.state]} (${(r.ms / 1000).toFixed(1)} s; última linha: ${JSON.stringify(r.lastLine)})`;
}
