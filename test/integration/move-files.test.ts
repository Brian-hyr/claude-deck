// Mover arquivos e pastas para outra pasta do mesmo servidor (`fs.rename` com destino em outra pasta):
// local (dados e pastas temporários) e remoto (via DECK_TEST_HOST, só em pastas temporárias criadas aqui).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, TEST_HOST } from './helpers';

let env: Awaited<ReturnType<typeof startServer>>;
let root: string;
const local = (...p: string[]) => path.join(root, ...p);
const call = (method: string, params: any) => env.client.call(method, params);
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: any) => e);

beforeAll(async () => {
  env = await startServer();
  await env.client.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-move-'));
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* limpeza de temporário */
  }
});

describe('mover arquivos (local)', () => {
  it('move arquivo e pasta inteira para outra pasta, mantendo o conteúdo', async () => {
    fs.mkdirSync(local('origem', 'sub', 'fundo'), { recursive: true });
    fs.mkdirSync(local('destino'));
    fs.writeFileSync(local('origem', 'a.txt'), 'A\n');
    fs.writeFileSync(local('origem', 'sub', 'b.txt'), 'B\n');
    fs.writeFileSync(local('origem', 'sub', 'fundo', 'açúcar e café.txt'), 'acentuado\n');

    await call('fs.rename', { h: 'local', from: local('origem', 'a.txt'), to: local('destino', 'a.txt') });
    expect(fs.existsSync(local('origem', 'a.txt'))).toBe(false);
    expect(fs.readFileSync(local('destino', 'a.txt'), 'utf8')).toBe('A\n');

    await call('fs.rename', { h: 'local', from: local('origem', 'sub'), to: local('destino', 'sub') });
    expect(fs.existsSync(local('origem', 'sub'))).toBe(false);
    expect(fs.readFileSync(local('destino', 'sub', 'b.txt'), 'utf8')).toBe('B\n');
    expect(fs.readFileSync(local('destino', 'sub', 'fundo', 'açúcar e café.txt'), 'utf8')).toBe('acentuado\n');
  });

  it('nunca sobrescreve: já existe com o mesmo nome no destino → erro "exists" e nada muda', async () => {
    fs.mkdirSync(local('c1'));
    fs.mkdirSync(local('c2'));
    fs.writeFileSync(local('c1', 'x.txt'), 'origem\n');
    fs.writeFileSync(local('c2', 'x.txt'), 'destino\n');
    const err = await errOf(call('fs.rename', { h: 'local', from: local('c1', 'x.txt'), to: local('c2', 'x.txt') }));
    expect(err?.code).toBe('exists');
    expect(fs.readFileSync(local('c1', 'x.txt'), 'utf8')).toBe('origem\n');
    expect(fs.readFileSync(local('c2', 'x.txt'), 'utf8')).toBe('destino\n');
  });

  it('pasta para dentro dela mesma (ou de uma descendente) é recusada pelo servidor', async () => {
    fs.mkdirSync(local('p', 'q'), { recursive: true });
    fs.writeFileSync(local('p', 'q', 'k.txt'), 'k\n');
    for (const dest of [local('p', 'p'), local('p', 'q', 'p')]) {
      const err = await errOf(call('fs.rename', { h: 'local', from: local('p'), to: dest }));
      expect(err?.code).toBe('bad');
    }
    expect(fs.readFileSync(local('p', 'q', 'k.txt'), 'utf8')).toBe('k\n');
    // Nome parecido não é "dentro": p → p2 é um renomear normal.
    await call('fs.rename', { h: 'local', from: local('p'), to: local('p2') });
    expect(fs.existsSync(local('p2', 'q', 'k.txt'))).toBe(true);
  });

  it('destino que não existe dá erro e a origem fica onde estava', async () => {
    fs.writeFileSync(local('solto.txt'), 's\n');
    const err = await errOf(call('fs.rename', { h: 'local', from: local('solto.txt'), to: local('nao-existe', 'solto.txt') }));
    expect(err).not.toBeNull();
    expect(fs.readFileSync(local('solto.txt'), 'utf8')).toBe('s\n');
  });
});

describe.skipIf(!TEST_HOST)(`mover arquivos (remoto, ${TEST_HOST})`, () => {
  it('move entre pastas e também entre sistemas de arquivos diferentes (/tmp → pasta pessoal)', async () => {
    const tag = crypto.randomBytes(4).toString('hex');
    const home: string = await call('fs.home', { h: TEST_HOST });
    const a = `/tmp/deck-move-${tag}`; // /tmp é tmpfs no servidor de teste; a pasta pessoal não é
    const b = `${home}/deck-move-${tag}`;
    try {
      await call('fs.mkdir', { h: TEST_HOST, p: a });
      await call('fs.mkdir', { h: TEST_HOST, p: b });
      await call('fs.mkdir', { h: TEST_HOST, p: `${a}/sub` });
      await call('fs.write', { h: TEST_HOST, p: `${a}/f.txt`, content: 'F\n' });
      await call('fs.write', { h: TEST_HOST, p: `${a}/sub/g.txt`, content: 'G\n' });
      await call('fs.write', { h: TEST_HOST, p: `${a}/açúcar e café.txt`, content: 'acento\n' });
      await call('fs.write', { h: TEST_HOST, p: `${b}/f.txt`, content: 'já estava\n' });

      // Mesmo sistema de arquivos: troca de pasta dentro de /tmp.
      await call('fs.mkdir', { h: TEST_HOST, p: `${a}/dentro` });
      await call('fs.rename', { h: TEST_HOST, from: `${a}/sub`, to: `${a}/dentro/sub` });
      expect(await call('fs.exists', { h: TEST_HOST, p: `${a}/sub` })).toBe(false);
      expect((await call('fs.read', { h: TEST_HOST, p: `${a}/dentro/sub/g.txt` })).content).toBe('G\n');

      // Outro sistema de arquivos: o SFTP do servidor recusa o "rename" simples; tem que mover mesmo assim.
      await call('fs.rename', { h: TEST_HOST, from: `${a}/açúcar e café.txt`, to: `${b}/açúcar e café.txt` });
      expect(await call('fs.exists', { h: TEST_HOST, p: `${a}/açúcar e café.txt` })).toBe(false);
      expect((await call('fs.read', { h: TEST_HOST, p: `${b}/açúcar e café.txt` })).content).toBe('acento\n');
      await call('fs.rename', { h: TEST_HOST, from: `${a}/dentro`, to: `${b}/dentro` });
      expect(await call('fs.exists', { h: TEST_HOST, p: `${a}/dentro` })).toBe(false);
      expect((await call('fs.read', { h: TEST_HOST, p: `${b}/dentro/sub/g.txt` })).content).toBe('G\n');

      // Nunca sobrescreve, nem entre sistemas de arquivos.
      const err = await errOf(call('fs.rename', { h: TEST_HOST, from: `${a}/f.txt`, to: `${b}/f.txt` }));
      expect(err?.code).toBe('exists');
      expect((await call('fs.read', { h: TEST_HOST, p: `${a}/f.txt` })).content).toBe('F\n');
      expect((await call('fs.read', { h: TEST_HOST, p: `${b}/f.txt` })).content).toBe('já estava\n');

      // Pasta para dentro dela mesma.
      const inside = await errOf(call('fs.rename', { h: TEST_HOST, from: b, to: `${b}/dentro/${b.split('/').pop()}` }));
      expect(inside?.code).toBe('bad');
    } finally {
      for (const p of [a, b]) await call('fs.remove', { h: TEST_HOST, p }).catch(() => {});
    }
  }, 120_000);
});
