import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePaths, Store } from '../../src/server/config';
import { attachWindow } from '../../src/server/windows';

const dirs: string[] = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('Store: estado por janela', () => {
  it('migra o state.json antigo (uma janela só) e o primeiro início restaura as abas dele', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ chatTabs: [{ sid: 'a', hostId: 'local', cwd: 'C:\\x' }], fileTabs: [], workspace: { hostId: 'local', root: 'C:\\x' }, sidebarView: 'explorer', extraRoots: { local: ['C:\\y'] } }),
    );
    const store = new Store(resolvePaths(dir));
    expect(Object.keys(store.windows)).toHaveLength(1);
    const r = attachWindow(store.windows, undefined, new Set());
    expect(r.cold).toBe(true);
    expect(r.state.chatTabs.map((t) => t.sid)).toEqual(['a']);
    expect(r.state.workspace?.root).toBe('C:\\x');
    expect(r.state.extraRoots?.local).toEqual(['C:\\y']);
  });

  it('grava e relê o formato novo; sem arquivo (ou lixo) começa sem janelas', () => {
    const dir = tmp();
    expect(Object.keys(new Store(resolvePaths(dir)).windows)).toHaveLength(0);
    fs.writeFileSync(path.join(dir, 'state.json'), 'não é json');
    expect(Object.keys(new Store(resolvePaths(dir)).windows)).toHaveLength(0);

    const s1 = new Store(resolvePaths(dir));
    const r = attachWindow(s1.windows, undefined, new Set());
    s1.windows[r.wid].state.chatTabs.push({ sid: 'z', hostId: 'h', cwd: '/x' });
    s1.flush();
    const s2 = new Store(resolvePaths(dir));
    expect(s2.windows[r.wid].state.chatTabs.map((t) => t.sid)).toEqual(['z']);
  });

  it('guarda a versão do formato, os apelidos de janelas juntadas e o contexto de cada janela', () => {
    const dir = tmp();
    const s1 = new Store(resolvePaths(dir));
    expect(s1.stateVersion).toBe(1); // sem arquivo = formato antigo (a migração roda uma vez)
    s1.stateVersion = 2;
    s1.aliases = { 'janela-velha-01': 'janela-nova-01' };
    s1.windows['janela-nova-01'] = { state: { chatTabs: [], fileTabs: [] }, updatedAt: 5, hostId: 'srv', contextCwd: '/home/x', shouldRestore: true };
    s1.flush();
    const s2 = new Store(resolvePaths(dir));
    expect(s2.stateVersion).toBe(2);
    expect(s2.aliases).toEqual({ 'janela-velha-01': 'janela-nova-01' });
    expect(s2.windows['janela-nova-01']).toMatchObject({ hostId: 'srv', contextCwd: '/home/x', shouldRestore: true });
  });
});
