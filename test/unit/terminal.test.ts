import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../../src/server/terminal/manager';

describe('TerminalManager local', () => {
  it('abre terminal local, escreve e fecha', async () => {
    const fakeRegistry: any = {
      get: () => ({ kind: 'local' }),
    };
    const logs: string[] = [];
    const tm = new TerminalManager(fakeRegistry, (m) => logs.push(m));

    const term = await tm.open({ hostId: 'local', cwd: process.cwd() });
    expect(term.id).toBeDefined();
    expect(term.hostId).toBe('local');
    expect(typeof term.title).toBe('string');

    // Lista terminais
    const list = tm.list();
    expect(list.some((t) => t.id === term.id)).toBe(true);

    // Escreve comando
    let received = '';
    const gotData = new Promise<void>((resolve) => {
      tm.on('data', (id, data) => {
        if (id === term.id) {
          received += data;
          resolve();
        }
      });
    });

    tm.write(term.id, 'echo teste-terminal-deck\r');
    await Promise.race([gotData, new Promise((r) => setTimeout(r, 4000))]);
    expect(received.length).toBeGreaterThan(0);

    // Redimensionamento
    const resized = tm.resize(term.id, 100, 30);
    expect(resized).toBe(true);

    // Fechar terminal
    const closed = tm.close(term.id);
    expect(closed).toBe(true);
    expect(tm.list().some((t) => t.id === term.id)).toBe(false);
  });

  it('closeForWindow fecha somente terminais da janela informada', async () => {
    const fakeRegistry: any = {
      get: () => ({ kind: 'local' }),
    };
    const tm = new TerminalManager(fakeRegistry, () => {});

    const t1 = await tm.open({ hostId: 'local', wid: 'win-1' });
    const t2 = await tm.open({ hostId: 'local', wid: 'win-2' });
    expect(t1.id).toBeDefined();
    expect(t2.id).toBeDefined();

    expect(tm.list('win-1').length).toBe(1);
    expect(tm.list('win-2').length).toBe(1);

    tm.closeForWindow('win-1');
    expect(tm.list('win-1').length).toBe(0);
    expect(tm.list('win-2').length).toBe(1);

    tm.closeAll();
    expect(tm.list().length).toBe(0);
  });
});
