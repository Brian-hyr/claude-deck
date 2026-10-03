import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalFs } from '../../src/server/fs/localfs';
import { FileTransfers, COPY_TERMINAL } from '../../src/server/fs/transfers';
import { copyName, copyPath, type CopyFs } from '../../src/server/fs/copyfs';
import type { FileCopyJob } from '../../src/shared/types';

let root: string, manager: FileTransfers, adapter: CopyFs;
const outputs: FileCopyJob[] = [];
const p = (...parts: string[]) => path.join(root, ...parts);
async function wait(id: string, decision = false) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const j = manager.get('dest', id);
    if (COPY_TERMINAL.has(j.state) || (decision && j.state === 'awaitingDecision')) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Cópia não terminou: ${JSON.stringify(manager.get('dest', id))}`);
}
function start(from = p('src', 'a.txt'), dir = p('dst'), requestId = crypto.randomUUID()) {
  const c = manager.setClipboard('source', 'local', from);
  return manager.start('dest', { requestId, clipboardId: c.id, revision: c.revision, hostId: 'local', dir });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-copy-unit-'));
  await fs.mkdir(p('src')); await fs.mkdir(p('dst'));
  await fs.writeFile(p('src', 'a.txt'), 'original\n');
  adapter = await new LocalFs().copyFs();
  outputs.length = 0;
  manager = new FileTransfers({ platform: () => adapter.platform, resolve: async () => ({ fs: adapter, identity: 'local' }), update: (j) => outputs.push(j), clipboard: () => {}, changed: () => {}, reserve: async () => () => {} });
});
afterEach(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('cópia gerenciada', () => {
  it('copia em fluxo, publica e não apaga a origem', async () => {
    const j = await wait(start().id);
    expect(j.state).toBe('completed'); expect(j.copied).toBe(1);
    expect(await fs.readFile(p('dst', 'a.txt'), 'utf8')).toBe('original\n');
    expect(await fs.readFile(p('src', 'a.txt'), 'utf8')).toBe('original\n');
    expect(await fs.readdir(p('dst'))).toEqual(['a.txt']);
  });
  it('pasta inclui ocultos, vazios, binários e arquivo vazio, sem filtros de busca', async () => {
    await fs.mkdir(p('src', 'tree', '.git'), { recursive: true });
    await fs.mkdir(p('src', 'tree', 'vazia'));
    await fs.writeFile(p('src', 'tree', '.git', 'oculto'), 'g');
    await fs.writeFile(p('src', 'tree', 'zero'), '');
    const data = crypto.randomBytes(1024 * 1024);
    await fs.writeFile(p('src', 'tree', 'açúcar café.bin'), data);
    const j = await wait(start(p('src', 'tree')).id);
    expect(j.state).toBe('completed'); expect(j.copied).toBe(3);
    expect(await fs.readFile(p('dst', 'tree', 'açúcar café.bin'))).toEqual(data);
    expect(await fs.readdir(p('dst', 'tree', 'vazia'))).toEqual([]);
    expect(await fs.readFile(p('dst', 'tree', '.git', 'oculto'), 'utf8')).toBe('g');
  });
  it('pular, cancelar e substituir são decisões explícitas, com revisão', async () => {
    await fs.writeFile(p('dst', 'a.txt'), 'antigo');
    let j = await wait(start().id, true);
    expect(manager.busy).toBe(1); expect(j.conflicts).toBe(1);
    expect(() => manager.decide('source', j.id, j.revision, 'replace')).toThrow();
    expect(() => manager.decide('dest', j.id, j.revision - 1, 'replace')).toThrow();
    manager.decide('dest', j.id, j.revision, 'skip');
    expect((await wait(j.id)).skipped).toBe(1);
    expect(await fs.readFile(p('dst', 'a.txt'), 'utf8')).toBe('antigo');
    j = await wait(start().id, true); manager.cancel('dest', j.id);
    expect((await wait(j.id)).state).toBe('cancelled');
    j = await wait(start().id, true); manager.decide('dest', j.id, j.revision, 'replace');
    expect((await wait(j.id)).state).toBe('completed');
    expect(await fs.readFile(p('dst', 'a.txt'), 'utf8')).toBe('original\n');
  });
  it('origem sobre si mesma e subárvore são recusadas antes de escrever', async () => {
    expect((await wait(start(p('src', 'a.txt'), p('src')).id)).state).toBe('failed');
    await fs.mkdir(p('src', 'tree'));
    expect((await wait(start(p('src'), p('src', 'tree')).id)).state).toBe('failed');
    expect(await fs.readdir(p('src', 'tree'))).toEqual([]);
  });
  it('mesmo requestId não inicia outra cópia e clipboard novo não muda o job', async () => {
    const c = manager.setClipboard('source', 'local', p('src', 'a.txt'));
    const args = { requestId: 'req1', clipboardId: c.id, revision: c.revision, hostId: 'local', dir: p('dst') };
    const one = manager.start('dest', args);
    expect(manager.start('dest', args).id).toBe(one.id);
    manager.setClipboard('source', 'local', p('src'));
    expect((await wait(one.id)).state).toBe('completed');
    expect(() => manager.start('dest', { ...args, requestId: 'req2' })).toThrow();
    expect(() => manager.get('other', one.id)).toThrow();
  });
  it('destino surgido depois da análise não é sobrescrito', async () => {
    const originalStage = adapter.stage;
    adapter.stage = async (dest) => { await fs.writeFile(dest, 'chegou outro'); return originalStage(dest); };
    const j = await wait(start().id);
    expect(j.state).toBe('partial'); expect(j.copied).toBe(0);
    expect(await fs.readFile(p('dst', 'a.txt'), 'utf8')).toBe('chegou outro');
    expect(await fs.readdir(p('dst'))).toEqual(['a.txt']);
  });
  it('falha de leitura preserva destino confirmado e limpa só seu temporário', async () => {
    await fs.writeFile(p('dst', 'a.txt'), 'velho');
    const original = adapter.source;
    adapter.source = async (src) => { const source = await original(src); source.stream.once('resume', () => source.stream.destroy(new Error('leitura falhou'))); return source; };
    const j = await wait(start().id, true); manager.decide('dest', j.id, j.revision, 'replace');
    expect((await wait(j.id)).copied).toBe(0);
    expect(await fs.readFile(p('dst', 'a.txt'), 'utf8')).toBe('velho');
    expect(await fs.readdir(p('dst'))).toEqual(['a.txt']);
  });
  it('erro de permissão no lstat não é interpretado como destino ausente', async () => {
    const original = adapter.lstat;
    adapter.lstat = async (dest) => { if (dest === p('dst', 'a.txt')) throw Object.assign(new Error('negado'), { code: 'EACCES' }); return original(dest); };
    expect((await wait(start().id)).state).toBe('failed');
    expect(await fs.readdir(p('dst'))).toEqual([]);
  });
});

describe('componentes e caminhos da cópia', () => {
  it('rejeita nomes Windows inseguros e mantém POSIX literal', () => {
    for (const name of ['CON.txt', 'nul', 'a:b', 'fim.', 'fim ', 'a\\b', '../x', 'a/b']) expect(() => copyName('win32', name)).toThrow();
    expect(copyName('posix', 'a:b')).toBe('a:b');
    expect(copyName('win32', 'açúcar e café.txt')).toBe('açúcar e café.txt');
  });
  it('exige absoluto, sem NUL/controles', () => {
    expect(() => copyPath('posix', 'relativo')).toThrow(); expect(() => copyPath('win32', 'C:relativo')).toThrow();
    expect(() => copyPath('posix', '/tmp/\0')).toThrow();
    expect(copyPath('win32', 'C:/pasta/arquivo')).toBe('C:\\pasta\\arquivo');
  });
});
