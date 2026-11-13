// Busca do aviso do modo automático no transcript (HistoryService.findFirstLine): lida em blocos de 1 MB,
// só linhas completas, ignora citações do mesmo texto e continua de onde parou.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryCache, HistoryService } from '../../src/server/claude/history';
import { LocalFs } from '../../src/server/fs/localfs';
import type { HostHandle } from '../../src/server/hosts/registry';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-findline-'));
  dirs.push(dir);
  const host = { id: 'local', kind: 'local', platform: process.platform === 'win32' ? 'win32' : 'linux', fs: new LocalFs() } as unknown as HostHandle;
  const history = new HistoryService(new HistoryCache(path.join(dir, 'cache.json')), () => new Set());
  return { dir, host, history, file: path.join(dir, 't.jsonl') };
}

const hookLine = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Sessão no modo Automático: o gateway escolheu Flash 3.8 low (nível 2 – simples, esforço low) para esta conversa'] } });
const isHook = (l: string) => JSON.parse(l).type === 'attachment';

describe('HistoryService.findFirstLine', () => {
  it('ignora uma mensagem que só cita o texto e acha o aviso depois de um bloco de 1 MB', async () => {
    const { host, history, file } = setup();
    const decoy = JSON.stringify({ type: 'user', message: { content: 'o gateway escolheu algo, por quê?' } });
    // Linha enorme para o aviso cair depois do 1º bloco e atravessar a divisa.
    const big = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1024 * 1024 + 123) } });
    fs.writeFileSync(file, [decoy, big, hookLine, ''].join('\n'));
    const r = await history.findFirstLine(host, file, 'gateway escolheu', isHook);
    expect(r.line).toBe(hookLine);
  });

  it('não lê linha incompleta e continua dela na próxima busca', async () => {
    const { host, history, file } = setup();
    const first = JSON.stringify({ type: 'user', message: { content: 'oi' } }) + '\n';
    fs.writeFileSync(file, first + hookLine.slice(0, 40)); // o CLI ainda está gravando a linha
    const a = await history.findFirstLine(host, file, 'gateway escolheu', isHook);
    expect(a.line).toBeUndefined();
    expect(a.scannedTo).toBe(Buffer.byteLength(first));
    fs.appendFileSync(file, hookLine.slice(40) + '\n');
    const b = await history.findFirstLine(host, file, 'gateway escolheu', isHook, a.scannedTo);
    expect(b.line).toBe(hookLine);
  });

  it('volta ao começo se o arquivo encolheu (foi trocado)', async () => {
    const { host, history, file } = setup();
    fs.writeFileSync(file, hookLine + '\n');
    const r = await history.findFirstLine(host, file, 'gateway escolheu', isHook, 10 * 1024 * 1024);
    expect(r.line).toBe(hookLine);
  });
});
