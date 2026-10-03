import { describe, expect, it } from 'vitest';
import { TermHighlighter } from '../../src/web/lib/termHighlight';

const RED = '\x1b[91m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const BLUE = '\x1b[94m';
const MAGENTA = '\x1b[95m';
const CYAN = '\x1b[96m';
const OFF = '\x1b[39m';

/** Passa tudo e solta o que ficou retido (como o painel faz depois de 30 ms). */
function run(...chunks: string[]) {
  const h = new TermHighlighter();
  let out = '';
  for (const c of chunks) out += h.push(c);
  return out + h.flush();
}

describe('TermHighlighter (regras My Custom do MobaXterm)', () => {
  it('colore estado de interface: down vermelho, up verde', () => {
    expect(run('ether1 is down\r\n')).toBe(`ether1 is ${RED}down${OFF}\r\n`);
    expect(run('link up\r\n')).toBe(`link ${GREEN}up${OFF}\r\n`);
  });

  it('não colore pedaços de palavras', () => {
    expect(run('update downloaded\r\n')).toBe('update downloaded\r\n');
    // "disconnected" é vermelho inteiro; o "connected" de dentro não vira verde.
    expect(run('peer disconnected\r\n')).toBe(`peer ${RED}disconnected${OFF}\r\n`);
  });

  it('expressões de várias palavras vencem a palavra solta', () => {
    expect(run('status: not ok\r\n')).toBe(`status: ${RED}not ok${OFF}\r\n`);
  });

  it('IP, MAC, VLAN e interface em amarelo', () => {
    expect(run('gw 198.51.100.1/24\r\n')).toBe(`gw ${YELLOW}198.51.100.1${OFF}/24\r\n`);
    expect(run('mac AA:BB:CC:00:11:22 ok\r\n')).toBe(`mac ${YELLOW}AA:BB:CC:00:11:22${OFF} ${GREEN}ok${OFF}\r\n`);
    expect(run('vlan100\r\n')).toBe(`${YELLOW}vlan100${OFF}\r\n`);
    expect(run('GigabitEthernet0/0/1\r\n')).toBe(`${YELLOW}GigabitEthernet0/0/1${OFF}\r\n`);
  });

  it('azul, magenta, ciano e link sublinhado', () => {
    expect(run('root\r\n')).toBe(`${BLUE}root${OFF}\r\n`);
    expect(run('interface\r\n')).toBe(`${MAGENTA}interface${OFF}\r\n`);
    expect(run('show ip address\r\n')).toBe(`${CYAN}show${OFF} ${CYAN}ip address${OFF}\r\n`);
    expect(run('ver https://grafana.exemplo.com/d/abc ok\r\n')).toBe(`ver \x1b[4mhttps://grafana.exemplo.com/d/abc\x1b[24m ${GREEN}ok${OFF}\r\n`);
  });

  it('linha de description fica verde até o fim', () => {
    expect(run('\r\n description Link redundante 198.51.100.1\r\n')).toBe(`\r\n ${GREEN}description Link redundante 198.51.100.1${OFF}\r\n`);
  });

  it('"no ..." no começo da linha em vermelho', () => {
    expect(run('\r\n no shutdown\r\n')).toBe(`\r\n ${RED}no${OFF} ${RED}shutdown${OFF}\r\n`);
  });

  it('palavra partida entre dois pedaços ainda é colorida', () => {
    expect(run('interface is do', 'wn\r\n')).toBe(`${MAGENTA}interface${OFF} is ${RED}down${OFF}\r\n`);
  });

  it('retém só o fim da linha incompleta e solta no flush', () => {
    const h = new TermHighlighter();
    expect(h.push('linha 1 up\r\n[admin@MikroTik] > ')).toBe(`linha 1 ${GREEN}up${OFF}\r\n`);
    expect(h.hasPending).toBe(true);
    expect(h.flush()).toBe('[admin@MikroTik] > ');
    expect(h.hasPending).toBe(false);
  });

  it('eco de tecla digitada sai na hora', () => {
    const h = new TermHighlighter();
    expect(h.push('s')).toBe('s');
    expect(h.hasPending).toBe(false);
  });

  it('não mexe em sequências de escape (título da janela com root)', () => {
    const title = '\x1b]0;root@servidor: ~\x07';
    expect(run(`${title}$ \r\n`)).toBe(`${title}$ \r\n`);
  });

  it('respeita texto que o programa já coloriu', () => {
    expect(run('\x1b[32mdown\x1b[0m down\r\n')).toBe(`\x1b[32mdown\x1b[0m ${RED}down${OFF}\r\n`);
    expect(run('\x1b[38;5;196merror\x1b[39m error\r\n')).toBe(`\x1b[38;5;196merror\x1b[39m ${RED}error${OFF}\r\n`);
  });

  it('não colore em tela cheia (vim, htop, less)', () => {
    expect(run('\x1b[?1049hdown up\r\n\x1b[?1049l')).toBe('\x1b[?1049hdown up\r\n\x1b[?1049l');
    expect(run('\x1b[?1049h', '\x1b[?1049l', 'down\r\n')).toBe(`\x1b[?1049h\x1b[?1049l${RED}down${OFF}\r\n`);
  });

  it('sequência de escape cortada entre pedaços não é quebrada', () => {
    expect(run('\x1b[3', '2mup\x1b[0m up\r\n')).toBe(`\x1b[32mup\x1b[0m ${GREEN}up${OFF}\r\n`);
  });

  it('desligado: passa tudo sem alterar', () => {
    const h = new TermHighlighter(() => false);
    expect(h.push('down up 198.51.100.1\r\n')).toBe('down up 198.51.100.1\r\n');
    expect(h.hasPending).toBe(false);
  });
});
