// Realce de palavras na saída do terminal, com as regras da sintaxe "My Custom" do MobaXterm
// (D:\Documentos\My Custom.msyn): erros em vermelho, sucesso em verde, IPs/MACs/interfaces em
// amarelo etc. Só colore texto "cru": não mexe em sequências de escape nem em texto que o
// próprio programa já coloriu, e fica desligado em telas cheias (vim, htop, less).
// Puro (sem DOM), testado à parte.

/** Início de palavra/fim de palavra como no .msyn (`[^A-Za-z0-9]` dos dois lados). */
const B = '(?<![A-Za-z0-9])';
const E = '(?![A-Za-z0-9])';
/** No .msyn o `¨` marca a quebra de linha: `¨( *)?` = começo de linha (com espaços), `[^¨]+` = resto da linha. */
const LS = '(?<=[\\r\\n] *)';

const words = (list: string) => `${B}(?:${list})${E}`;

/** Regras na ordem do arquivo; na mesma posição, a primeira que casar vence. */
export const HIGHLIGHT_RULES: { name: string; sgr: [string, string]; source: string }[] = [
  {
    name: 'underline',
    sgr: ['\x1b[4m', '\x1b[24m'],
    source: '(?<![A-Za-z_&-])https?://[A-Za-z0-9_.&?=%~#{}()@+-]+:?[A-Za-z0-9_./&?=%~#{}()@+-]+(?![A-Za-z0-9_-])',
  },
  {
    name: 'red',
    sgr: ['\x1b[91m', '\x1b[39m'],
    source: [
      `${LS}no(?= )`,
      words(
        'not permitted|not allowed|not supported|not implemented|not ok|session closed|session disconnected|does not match|does not exist|' +
          'disabled|disable|deny|down|idle|unknown|fault|falha|shutdown|disconnected|disconectado|errors?|erros?|failed|denied|negado|' +
          'disallowed|refused|problem|failure|notconnect|rejected|invalid|unsupported|corruption|corrupted|corrupt|overflow|underrun|' +
          'unimplemented|unsuccessfull|crashed|crash',
      ),
    ].join('|'),
  },
  {
    name: 'green',
    sgr: ['\x1b[92m', '\x1b[39m'],
    source: [
      words(
        'accepted|allowed|reply|enabled|connected|sucesso|permit|up|yes|ok|received|successo|sucedido|established|successfully|' +
          'successful|succeeded|true|success|active',
      ),
      `${LS}(?:description|(?:host)?name(?:if)?|version) [^\\r\\n]+`,
    ].join('|'),
  },
  {
    name: 'yellow',
    sgr: ['\x1b[93m', '\x1b[39m'],
    source: [
      words(
        '[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}|localhost|(?:25[0-4]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[1-9])\\.[0-9]+\\.[0-9]+\\.[0-9]+|' +
          'vlan[0-9]+|(?:[a-z]+thernet|gi)[0-9]+(?:/[0-9]+)*',
      ),
      words(
        'switch|eq|ne|gt|lt|ge|le|cmp|chdir|delete|find|rmdir|rename|mkdir|open|print|my|local|our|chomp|chop|chr|crypt|index|' +
          'lcfirst|lc|length|ord|pack|reverse|rindex|sprintf|substr|ucfirst|uc|split|splice|unshift|shift|push|pop|join|grep|map|' +
          'sort|cp|cd|message',
      ),
    ].join('|'),
  },
  {
    name: 'blue',
    sgr: ['\x1b[94m', '\x1b[39m'],
    source: words('root|login|token|date|vars|warnings|utf8|byte|base|fields|import|alarm|etc|usr'),
  },
  {
    name: 'magenta',
    sgr: ['\x1b[95m', '\x1b[39m'],
    source: words(
      'policy-map|class|global|logging|log|var(?: event)?|(?:allocate-)?interface|failover|static|security-level|service(?:-policy)?|' +
        'spanning-tree|switchport',
    ),
  },
  {
    name: 'cyan',
    sgr: ['\x1b[96m', '\x1b[39m'],
    source: words(
      '%link-[0-9]+-updown|(?:allowed )?(?:private-)?vlan(?:-range)?|route|access-(?:list|group)|port-forward|mtu|show|encapsulation|' +
        'rate-limit|speed|duplex|autoneg|snmp-server|media-type|ip(?: address)?|monitor(?: session)?',
    ),
  },
];

const RULES_RE = new RegExp(HIGHLIGHT_RULES.map((r, i) => `(?<r${i}>${r.source})`).join('|'), 'gi');

/** Sequência de escape completa começando em `lastIndex` (CSI, OSC, strings DCS/PM/APC, charset, 1 caractere). */
const ESC_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()*+].|[^\[\]PX^_()*+])/y;

/** Linha parcial retida no máximo até este tamanho (acima disso sai sem esperar). */
const MAX_HOLD = 1024;
/** Pedaços pequenos (eco de tecla digitada) saem na hora, sem retenção. */
const ECHO_MAX = 4;

export class TermHighlighter {
  private pending = '';
  /** Último caractere de texto emitido (contexto para começo de palavra/linha entre pedaços). */
  private ctx = '\n';
  private fg = false;
  private bg = false;
  private inverse = false;
  private alt = false;

  constructor(private enabled: () => boolean = () => true) {}

  get hasPending() {
    return this.pending.length > 0;
  }

  /**
   * Recebe um pedaço da saída e devolve o que já pode ir para o xterm. O fim de uma linha
   * incompleta fica retido para que uma palavra partida entre dois pedaços ainda seja colorida;
   * quem chama deve chamar `flush()` logo depois (uns 30 ms) se `hasPending`.
   */
  push(data: string): string {
    if (!this.enabled()) {
      const out = this.pending + data;
      this.pending = '';
      this.track(out);
      return out;
    }
    const buf = this.pending + data;
    this.pending = '';
    if (!buf) return '';
    if (buf === data && data.length <= ECHO_MAX) return this.process(buf);
    let cut = buf.length;
    // Sequência de escape cortada no fim: espera o resto.
    const esc = buf.lastIndexOf('\x1b');
    if (esc >= 0 && !this.completeEscapeAt(buf, esc)) cut = esc;
    // Resto de linha sem quebra: espera o próximo pedaço (palavra pode estar partida).
    if (cut > 0) {
      const nl = Math.max(buf.lastIndexOf('\n', cut - 1), buf.lastIndexOf('\r', cut - 1));
      if (cut - (nl + 1) <= MAX_HOLD) cut = nl + 1;
    }
    this.pending = buf.slice(cut);
    return this.process(buf.slice(0, cut));
  }

  /** Solta o que estava retido (colorindo o que der). */
  flush(): string {
    const buf = this.pending;
    this.pending = '';
    return buf ? (this.enabled() ? this.process(buf) : (this.track(buf), buf)) : '';
  }

  private completeEscapeAt(s: string, i: number): boolean {
    ESC_RE.lastIndex = i;
    return ESC_RE.test(s);
  }

  /** Separa escapes de texto, atualiza o estado de cor e colore só o texto sem estilo. */
  private process(s: string): string {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const esc = s.indexOf('\x1b', i);
      const end = esc < 0 ? s.length : esc;
      if (end > i) out += this.colorText(s.slice(i, end));
      if (esc < 0) break;
      ESC_RE.lastIndex = esc;
      const m = ESC_RE.exec(s);
      const seq = m ? m[0] : s.slice(esc); // incompleta no fim (só no flush): sai como veio
      this.onEscape(seq);
      out += seq;
      i = esc + seq.length;
    }
    return out;
  }

  /** Só acompanha o estado (realce desligado). */
  private track(s: string) {
    let i = 0;
    while ((i = s.indexOf('\x1b', i)) >= 0) {
      ESC_RE.lastIndex = i;
      const m = ESC_RE.exec(s);
      const seq = m ? m[0] : s.slice(i);
      this.onEscape(seq);
      i += seq.length;
    }
    const last = s.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g, '');
    if (last) this.ctx = last[last.length - 1];
  }

  private colorText(text: string): string {
    const prev = this.ctx;
    this.ctx = text[text.length - 1];
    if (this.fg || this.bg || this.inverse || this.alt) return text;
    // O contexto (caractere anterior) entra só para as verificações de começo de palavra/linha.
    const s = prev + text;
    let out = '';
    let last = 1;
    RULES_RE.lastIndex = 1;
    let m: RegExpExecArray | null;
    while ((m = RULES_RE.exec(s))) {
      if (!m[0]) {
        RULES_RE.lastIndex++;
        continue;
      }
      const idx = HIGHLIGHT_RULES.findIndex((_, k) => m!.groups?.[`r${k}`] !== undefined);
      const [on, off] = HIGHLIGHT_RULES[idx].sgr;
      out += s.slice(last, m.index) + on + m[0] + off;
      last = m.index + m[0].length;
    }
    return out + s.slice(last);
  }

  private onEscape(seq: string) {
    if (seq === '\x1bc') {
      this.fg = this.bg = this.inverse = this.alt = false;
      return;
    }
    if (!seq.startsWith('\x1b[')) return;
    const final = seq[seq.length - 1];
    const body = seq.slice(2, -1);
    if ((final === 'h' || final === 'l') && /^\?(?:1049|1047|47)$/.test(body)) {
      this.alt = final === 'h';
      return;
    }
    if (final !== 'm' || /[^0-9;:]/.test(body)) return;
    const p = body === '' ? [0] : body.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
    for (let k = 0; k < p.length; k++) {
      const n = p[k];
      if (n === 0) this.fg = this.bg = this.inverse = false;
      else if (n === 7) this.inverse = true;
      else if (n === 27) this.inverse = false;
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.fg = true;
      else if (n === 39) this.fg = false;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) this.bg = true;
      else if (n === 49) this.bg = false;
      else if (n === 38 || n === 48) {
        if (n === 38) this.fg = true;
        else this.bg = true;
        k += p[k + 1] === 5 ? 2 : p[k + 1] === 2 ? 4 : 0;
      }
    }
  }
}
