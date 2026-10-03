import { describe, expect, it } from 'vitest';
import { planFromFileList, safeSegment } from '../../src/web/lib/dropTree';

function file(rel: string, body = 'x') {
  const f = new File([body], rel.split('/').pop()!);
  Object.defineProperty(f, 'webkitRelativePath', { value: rel.includes('/') ? rel : '' });
  return f;
}

describe('plano de envio a partir do seletor de pasta', () => {
  it('monta as pastas (pais antes dos filhos) e mantém o caminho relativo dos arquivos', () => {
    const p = planFromFileList([file('minha/a.txt'), file('minha/sub/b.txt'), file('minha/sub/fundo/c.txt'), file('minha/z/d.txt')]);
    expect(p.files.map((f) => f.rel)).toEqual(['minha/a.txt', 'minha/sub/b.txt', 'minha/sub/fundo/c.txt', 'minha/z/d.txt']);
    expect(p.dirs).toEqual(['minha', 'minha/sub', 'minha/z', 'minha/sub/fundo']);
    expect(p.unreadable).toEqual([]);
  });

  it('arquivo solto (sem caminho relativo) vai direto para o destino', () => {
    const p = planFromFileList([file('solto.txt')]);
    expect(p.files.map((f) => f.rel)).toEqual(['solto.txt']);
    expect(p.dirs).toEqual([]);
  });

  it('nome perigoso não escapa do destino', () => {
    expect(safeSegment('..')).toBeNull();
    expect(safeSegment('.')).toBeNull();
    expect(safeSegment('   ')).toBeNull();
    expect(safeSegment('a/b')).toBe('a_b');
    expect(safeSegment('a\\b')).toBe('a_b');
    expect(safeSegment('açúcar e café.txt')).toBe('açúcar e café.txt');
    const p = planFromFileList([file('pasta/../fora.txt'), file('pasta/ok.txt')]);
    expect(p.files.map((f) => f.rel)).toEqual(['pasta/ok.txt']);
    expect(p.unreadable).toEqual(['pasta/../fora.txt']);
  });
});
