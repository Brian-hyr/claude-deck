import { describe, expect, it } from 'vitest';
import type { execFile } from 'node:child_process';
import { CLIPBOARD_MAX_BYTES, CLIPBOARD_SCRIPT, readClipboardText } from '../../src/server/clipboard';

// Leitura da área de transferência do Windows pelo servidor (reserva da colagem quando o navegador nega a permissão).

type Done = (error: (Error & { code?: string }) | null, stdout: string) => void;
const fake = (reply: (args: string[], done: Done) => void) =>
  ((_exe: string, args: string[], _opts: unknown, done: Done) => {
    reply(args, done);
    return {} as never;
  }) as unknown as typeof execFile;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('readClipboardText', () => {
  it('decodifica UTF-8 e preserva acento, emoji e quebras de linha', async () => {
    const text = 'ação\r\nsegunda linha 🚀\n\ttab';
    const run = fake((_a, done) => done(null, b64(text) + '\r\n'));
    await expect(readClipboardText({ platform: 'win32', execFileFn: run })).resolves.toBe(text);
  });

  it('área de transferência vazia ou sem texto devolve string vazia', async () => {
    const run = fake((_a, done) => done(null, ''));
    await expect(readClipboardText({ platform: 'win32', execFileFn: run })).resolves.toBe('');
  });

  it('roda o script esperado em PowerShell oculto, sem perfil e em STA', async () => {
    let seen: string[] = [];
    const run = fake((a, done) => { seen = a; done(null, ''); });
    await readClipboardText({ platform: 'win32', execFileFn: run });
    expect(seen).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']));
    const encoded = seen[seen.indexOf('-EncodedCommand') + 1];
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(CLIPBOARD_SCRIPT);
  });

  it('falha do PowerShell vira DeckError "clipboard" com a causa', async () => {
    const run = fake((_a, done) => done(Object.assign(new Error('boom'), { code: 'ENOENT' }), ''));
    await expect(readClipboardText({ platform: 'win32', execFileFn: run })).rejects.toMatchObject({ code: 'clipboard', message: expect.stringContaining('boom') });
  });

  it('texto acima do limite é recusado (estouro do buffer ou decodificado grande)', async () => {
    const tooBig = fake((_a, done) => done(Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), ''));
    await expect(readClipboardText({ platform: 'win32', execFileFn: tooBig })).rejects.toMatchObject({ code: 'clipboard', message: expect.stringContaining('1 MB') });
    const big = fake((_a, done) => done(null, b64('a'.repeat(CLIPBOARD_MAX_BYTES + 1))));
    await expect(readClipboardText({ platform: 'win32', execFileFn: big })).rejects.toMatchObject({ code: 'clipboard' });
  });

  it('fora do Windows não chama nada', async () => {
    let called = false;
    const run = fake(() => { called = true; });
    await expect(readClipboardText({ platform: 'linux', execFileFn: run })).rejects.toMatchObject({ code: 'unsupported' });
    expect(called).toBe(false);
  });
});
