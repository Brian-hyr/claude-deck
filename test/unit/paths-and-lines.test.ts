import { describe, expect, it } from 'vitest';
import { basename, dirname, encodeProjectDir, extname, join, moveBlocked, normalize, relativeTo, tildify } from '../../src/shared/paths';
import { LineSplitter } from '../../src/server/claude/transport';
import { buildArgs } from '../../src/server/claude/session';
import { cleanUserText, summarizeLines, trimLine } from '../../src/server/claude/history';
import { parseFolderUri } from '../../src/server/vscode/import';
import { looksBinary, shq } from '../../src/server/fs/hostfs';
import { contentTypeFor } from '../../src/server/mime';

describe('caminhos', () => {
  it('posix', () => {
    expect(join('posix', '/home/usuario', 'a', '../b')).toBe('/home/usuario/b');
    expect(dirname('posix', '/home/usuario/x.txt')).toBe('/home/usuario');
    expect(dirname('posix', '/x')).toBe('/');
    expect(normalize('posix', '/a//b/./c/')).toBe('/a/b/c');
    expect(relativeTo('posix', '/home/usuario', '/home/usuario/src/a.ts')).toBe('src/a.ts');
    expect(relativeTo('posix', '/home/usuario', '/etc/x')).toBeNull();
  });
  it('windows', () => {
    expect(join('win32', 'C:\\Users\\usuario', 'a', 'b.txt')).toBe('C:\\Users\\usuario\\a\\b.txt');
    expect(dirname('win32', 'C:\\Users\\usuario')).toBe('C:\\Users');
    expect(dirname('win32', 'C:\\Users')).toBe('C:\\');
    expect(normalize('win32', 'C:/Users//usuario/')).toBe('C:\\Users\\usuario');
    expect(relativeTo('win32', 'c:\\users\\Usuario', 'C:\\Users\\usuario\\x\\y.md')).toBe('x\\y.md');
  });
  it('mover: onde um item não pode ser solto', () => {
    // Já está na pasta de destino (arquivo ou pasta).
    expect(moveBlocked('posix', '/p/a.txt', false, '/p')).toBe('here');
    expect(moveBlocked('posix', '/p/sub', true, '/p')).toBe('here');
    expect(moveBlocked('posix', '/p/a.txt', false, '/p/')).toBe('here');
    // Pasta dentro dela mesma ou de uma descendente.
    expect(moveBlocked('posix', '/p/sub', true, '/p/sub')).toBe('inside');
    expect(moveBlocked('posix', '/p/sub', true, '/p/sub/fundo')).toBe('inside');
    // Mesmo prefixo de texto não é "dentro": /p/sub2 é outra pasta.
    expect(moveBlocked('posix', '/p/sub', true, '/p/sub2')).toBeNull();
    // Destinos válidos.
    expect(moveBlocked('posix', '/p/a.txt', false, '/p/sub')).toBeNull();
    expect(moveBlocked('posix', '/p/sub/a.txt', false, '/p')).toBeNull();
    expect(moveBlocked('posix', '/p/sub', true, '/')).toBeNull();
    expect(moveBlocked('posix', '/p/a.txt', false, '/outra/pasta')).toBeNull();
    // Arquivo nunca "está dentro de si mesmo": soltar arquivo sobre pasta irmã é normal.
    expect(moveBlocked('posix', '/p/a.txt', false, '/p/a.txt.d')).toBeNull();
    // Windows ignora maiúsculas e barras.
    expect(moveBlocked('win32', 'C:\\Users\\b\\x.txt', false, 'c:/users/B')).toBe('here');
    expect(moveBlocked('win32', 'C:\\Users\\b\\pasta', true, 'C:\\Users\\b\\pasta\\sub')).toBe('inside');
    expect(moveBlocked('win32', 'C:\\Users\\b\\pasta', true, 'C:\\Users\\b\\pasta2')).toBeNull();
  });
  it('nome da pasta de projeto do Claude', () => {
    expect(encodeProjectDir('/home/usuario/meu-projeto')).toBe('-home-usuario-meu-projeto');
    expect(encodeProjectDir('C:\\Users\\usuario')).toBe('C--Users-usuario');
    expect(encodeProjectDir('/root/servicos')).toBe('-root-servicos');
  });
  it('utilidades', () => {
    expect(basename('/a/b/c.tar.gz')).toBe('c.tar.gz');
    expect(extname('/a/b/Video.MP4')).toBe('mp4');
    expect(tildify('/home/usuario/x', '/home/usuario')).toBe('~/x');
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(contentTypeFor('a.wav')).toBe('audio/wav');
    expect(contentTypeFor('a.MP4')).toBe('video/mp4');
  });
});

describe('divisor de linhas', () => {
  it('junta pedaços e conta bytes UTF-8', () => {
    const got: [string, number][] = [];
    const s = new LineSplitter((l, b) => got.push([l, b]));
    const text = '{"a":"ção"}\n{"b":1}\n{"c":';
    const buf = Buffer.from(text);
    s.push(buf.subarray(0, 5));
    s.push(buf.subarray(5));
    expect(got.map((g) => g[0])).toEqual(['{"a":"ção"}', '{"b":1}']);
    expect(got[0][1]).toBe(Buffer.byteLength('{"a":"ção"}\n'));
    expect(s.pendingBytes).toBe(Buffer.byteLength('{"c":'));
    s.push(Buffer.from('2}\r\n'));
    expect(got[2][0]).toBe('{"c":2}');
  });
});

describe('argumentos do CLI', () => {
  it('monta flags do stream-json e valida entradas', () => {
    const a = buildArgs({ mode: 'acceptEdits', resume: '594bd39f-a733-40b5-b27e-79ea66f2a439', model: 'claude-opus-5-5[1m]' });
    expect(a).toContain('--permission-prompt-tool');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(a[a.indexOf('--resume') + 1]).toBe('594bd39f-a733-40b5-b27e-79ea66f2a439');
    expect(() => buildArgs({ mode: 'default', resume: 'x; rm -rf /' })).toThrow();
    expect(() => buildArgs({ mode: 'default', model: 'a b' })).toThrow();
    expect(buildArgs({ mode: 'hacker' as any })).toContain('default');
    expect(buildArgs({ mode: 'default' })).not.toContain('--effort');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const withEffort = buildArgs({ mode: 'default', effort });
      expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe(effort);
    }
    expect(() => buildArgs({ mode: 'default', effort: 'unsafe; command' as any })).toThrow('Nível de esforço inválido');
  });
});

describe('histórico', () => {
  it('limpa tags de contexto do texto do usuário', () => {
    expect(cleanUserText([{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>corrige o bug' }])).toBe('corrige o bug');
    expect(cleanUserText('<command-name>/clear</command-name>')).toBe('/clear');
  });
  it('resume título e primeiro pedido', () => {
    const head = [
      JSON.stringify({ type: 'queue-operation' }),
      JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/home/b', message: { role: 'user', content: 'faça X' } }),
    ];
    const tail = [JSON.stringify({ type: 'ai-title', aiTitle: 'Título bom' })];
    const s = summarizeLines(head, tail);
    expect(s.title).toBe('Título bom');
    expect(s.firstPrompt).toBe('faça X');
    expect(s.cwd).toBe('/home/b');
  });
  it('sem título usa o primeiro pedido', () => {
    const s = summarizeLines([JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'olá mundo' }] } })], []);
    expect(s.title).toBe('olá mundo');
  });
  it('texto colado no terminal (<pasted_content>) não vira título com a marcação', () => {
    const text = 'faça mineração do publico :\n\n<pasted_content id="5db9">\nRenda Extra Artesanal\nApostilas\n</pasted_content id="5db9">\n';
    const s = summarizeLines([JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })], []);
    expect(s.title).toBe('faça mineração do publico : Renda Extra Artesanal Apostilas');
    const only = summarizeLines([JSON.stringify({ type: 'user', message: { content: '<pasted_content id="2fbf">\nVocê tem acesso ao navegador.\n</pasted_content id="2fbf">' } })], []);
    expect(only.title).toBe('Você tem acesso ao navegador.');
  });
  it('corta saídas gigantes', () => {
    const big = 'x'.repeat(200_000);
    const o = trimLine({ type: 'user', message: { content: [{ type: 'tool_result', content: big }] }, toolUseResult: { stdout: big } });
    expect(o.message.content[0].content.length).toBeLessThan(70_000);
    expect(o.toolUseResult).toBeUndefined();
  });
  it('preserva só os metadados necessários do agente no histórico', () => {
    const o = trimLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'lançado' }] },
      toolUseResult: { status: 'async_launched', agentId: 'a1', agentType: 'Explore', resolvedModel: 'claude-sonnet-5', modelsUsed: ['claude-sonnet-5'], prompt: 'Analise este caso detalhadamente', outputFile: 'C:\\secret\\output', token: 'secreto' },
    });
    expect(o.toolUseResult).toEqual({ status: 'async_launched', agentId: 'a1', agentType: 'Explore', resolvedModel: 'claude-sonnet-5', modelsUsed: ['claude-sonnet-5'], prompt: 'Analise este caso detalhadamente' });
  });
});

describe('importação do VS Code', () => {
  it('decodifica pastas remotas (hex de JSON), por IP e locais', () => {
    const hex = Buffer.from(JSON.stringify({ hostName: 'srv-teste' })).toString('hex');
    expect(parseFolderUri(`vscode-remote://ssh-remote+${hex}/home/usuario/app`)).toEqual({ hostId: 'srv-teste', path: '/home/usuario/app' });
    expect(parseFolderUri('vscode-remote://ssh-remote+198.51.100.3/root')).toEqual({ hostId: '198.51.100.3', path: '/root' });
    expect(parseFolderUri('file:///c%3A/Users/usuario/proj')).toEqual({ hostId: 'local', path: 'C:\\Users\\usuario\\proj' });
    const hex2 = Buffer.from(JSON.stringify({ hostName: 'Oracle Bots' })).toString('hex');
    expect(parseFolderUri(`vscode-remote://ssh-remote%2B${hex2}/root`)?.hostId).toBe('Oracle Bots');
  });
});

describe('binário', () => {
  it('detecta binário por byte nulo', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(true);
    expect(looksBinary(Buffer.from('texto normal\ncom acentuação'))).toBe(false);
  });
});
