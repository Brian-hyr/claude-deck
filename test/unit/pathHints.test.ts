import { describe, expect, it } from 'vitest';
import { cleanRel, dirsOf, extractHintDirs, hintScore, looksLikeFolderPath, matchSuffix, pickCandidate } from '../../src/web/lib/pathHints';

const TEXTO = [
  'Terminei de gerar todos os materiais pedidos:',
  '1. Os 5 criativos em `criativos/mesinha-atividades/lancamento-rascunhos/` (`AD01.png` a `AD05.png`).',
  '2. A imagem da mensagem 3 (`WHATSAPP-mensagem-03-rascunho.png`), com o resumo das pastas de 2 a 8 anos.',
  '3. Os 2 áudios em `criativos/mesinha-atividades/lancamento-rascunhos/audios/`.',
].join('\n');

describe('pistas de pasta no texto da resposta', () => {
  it('extrai as pastas citadas, na ordem, sem repetir', () => {
    expect(extractHintDirs(TEXTO)).toEqual([
      'criativos/mesinha-atividades/lancamento-rascunhos',
      'criativos/mesinha-atividades/lancamento-rascunhos/audios',
    ]);
  });

  it('ignora URLs, datas e frações', () => {
    expect(extractHintDirs('veja https://exemplo.com/a/b/c.png e 12/05 ou 3/4')).toEqual([]);
  });

  it('entende ./, ~/ e caminho absoluto', () => {
    expect(extractHintDirs('use ./out/img/ e ~/proj/x/ e /var/www/site/')).toEqual(['out/img', '~/proj/x', '/var/www/site']);
  });
});

describe('achar o arquivo pelo final do caminho', () => {
  const lista = [
    'README.md',
    'criativos/mesinha-atividades/lancamento-rascunhos/WHATSAPP-mensagem-03-rascunho.png',
    'criativos/outra/WHATSAPP-mensagem-03-rascunho.png',
    'src/app.ts',
  ];
  it('casa pelo nome e por caminho parcial, sem pegar nome parecido', () => {
    expect(matchSuffix(lista, 'WHATSAPP-mensagem-03-rascunho.png')).toHaveLength(2);
    expect(matchSuffix(lista, 'outra/WHATSAPP-mensagem-03-rascunho.png')).toEqual(['criativos/outra/WHATSAPP-mensagem-03-rascunho.png']);
    expect(matchSuffix(lista, 'app.ts')).toEqual(['src/app.ts']);
    expect(matchSuffix(lista, 'pp.ts')).toEqual([]);
    expect(matchSuffix(lista, '../segredo.txt')).toEqual([]);
  });
  it('local ignora maiúsculas', () => {
    expect(matchSuffix(['Docs/Leia.MD'], 'leia.md', true)).toEqual(['Docs/Leia.MD']);
    expect(matchSuffix(['Docs/Leia.MD'], 'leia.md', false)).toEqual([]);
  });
  it('limpa ./ e barras invertidas', () => {
    expect(cleanRel('.\\a\\b\\')).toBe('a/b');
  });
});

describe('escolher entre arquivos de mesmo nome', () => {
  const dois = [
    'criativos/mesinha-atividades/lancamento-rascunhos/WHATSAPP-mensagem-03-rascunho.png',
    'criativos/outra/WHATSAPP-mensagem-03-rascunho.png',
  ];
  it('a pasta citada no texto desempata', () => {
    const hints = extractHintDirs(TEXTO);
    expect(pickCandidate(dois, hints).chosen).toBe(dois[0]);
  });
  it('sem pista, devolve as opções para o usuário escolher', () => {
    const r = pickCandidate(dois, []);
    expect(r.chosen).toBeUndefined();
    expect(r.options).toHaveLength(2);
  });
  it('pista que combina com os dois também não escolhe sozinha', () => {
    const r = pickCandidate(['a/x/f.png', 'b/x/f.png'], ['x']);
    expect(r.chosen).toBeUndefined();
    expect(r.options).toHaveLength(2);
  });
  it('um só candidato é aberto direto', () => {
    expect(pickCandidate(['a/f.png'], []).chosen).toBe('a/f.png');
    expect(pickCandidate([], []).chosen).toBeUndefined();
  });
  it('pontuação da pasta', () => {
    expect(hintScore('a/b/c/f.png', ['b/c'])).toBe(3);
    expect(hintScore('a/b/c/f.png', ['a'])).toBe(2);
    expect(hintScore('a/f.png', ['a/b/c'])).toBe(1);
    expect(hintScore('z/f.png', ['a/b'])).toBe(0);
  });
});

describe('caminho de pasta no texto da resposta', () => {
  it('reconhece pastas escritas de jeitos diferentes', () => {
    for (const p of [
      'criativos/mesinha-atividades/', // barra no fim, relativa
      'agencia-ia\\varejo\\', // Windows relativa, com barra invertida no fim
      'agencia-ia\\varejo', // Windows sem barra no fim
      'C:\\Users\\usuario\\claude-deck', // disco do Windows
      'G:\\Meu Drive\\Documentos\\', // espaço é comum no Windows
      'C:/Users/usuario/claude-deck/docs',
      '~/proj/x',
      './out/img',
      '../irmao/pasta',
      '/opt/meu-site',
      '/var/www/site/',
      '/tmp',
      '/home/usuario/.claude/projects',
      'src/web/components', // três níveis
      'criativos/lote-ç/ação/', // acento
    ]) {
      expect(looksLikeFolderPath(p), p).toBe(true);
    }
  });

  it('não confunde com comando, rota, endereço, data ou fração', () => {
    for (const p of [
      '/clear', // comando do Claude
      '/api/raw', // rota
      '/login',
      'and/or',
      'text/html',
      '12/05',
      '3/4',
      '12/05/2026',
      'https://exemplo.com/a/b/c',
      'github.com/foo/bar',
      'exemplo.com.br/a/b',
      'localhost:3000/x/y',
      'git commit -m x/y/z', // comando com espaço
      'npm run build',
      'src', // um nome só: pode ser qualquer coisa
      'node_modules',
      '~',
      './',
      '../',
      '',
      'C:\\x:12', // arquivo:linha
    ]) {
      expect(looksLikeFolderPath(p), p).toBe(false);
    }
  });

  it('lista as pastas que contêm os arquivos, em todos os níveis, sem repetir', () => {
    expect(dirsOf(['a/b/c.txt', 'a/b/d.txt', 'a/e.txt', 'raiz.txt', 'x/y/z/w.png']).sort()).toEqual(['a', 'a/b', 'x', 'x/y', 'x/y/z']);
    expect(dirsOf(['so-arquivo.txt'])).toEqual([]);
    expect(dirsOf([])).toEqual([]);
  });

  it('a pasta achada pelo nome casa pelo final do caminho', () => {
    const dirs = dirsOf(['criativos/lote-a/x.png', 'criativos/lote-b/audios/y.mp3', 'outra/lote-a/z.png']);
    expect(matchSuffix(dirs, 'lote-b')).toEqual(['criativos/lote-b']);
    expect(matchSuffix(dirs, 'lote-a').sort()).toEqual(['criativos/lote-a', 'outra/lote-a']);
    expect(matchSuffix(dirs, 'criativos/lote-b/audios')).toEqual(['criativos/lote-b/audios']);
    expect(matchSuffix(dirs, 'lote')).toEqual([]);
  });
});
