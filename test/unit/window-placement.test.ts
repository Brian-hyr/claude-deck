// Posição das janelas no Windows: validação, leitura da saída do script e o executor com um execFile falso.
// O teste com janela real fica fora da suíte (mexe em janelas da área de trabalho de quem roda).
import { describe, expect, it } from 'vitest';
import {
  buildPlacementScript,
  parsePlacementOutput,
  placementHelperSource,
  runPlacement,
  validPlacement,
  type BrowserSelection,
} from '../../src/server/browser';

const profile = 'C:\\Users\\u\\AppData\\Roaming\\claude-deck\\browser-profile';
const brave: BrowserSelection = { id: 'brave', executable: 'C:\\Brave\\brave.exe', processName: 'brave', profileDir: profile };

describe('validPlacement', () => {
  it('aceita posição plausível, inclusive em monitor à esquerda (x negativo), e arredonda', () => {
    expect(validPlacement({ x: -1927.4, y: 0, width: 1934, height: 1039.6 })).toEqual({ x: -1927, y: 0, width: 1934, height: 1040 });
    expect(validPlacement({ x: 10, y: 20, width: 800, height: 600, maximized: true })).toEqual({ x: 10, y: 20, width: 800, height: 600, maximized: true });
  });

  it('recusa lixo, tamanho minúsculo e coordenadas absurdas', () => {
    for (const v of [
      null,
      undefined,
      'x',
      {},
      { x: 0, y: 0, width: 100, height: 600 },
      { x: 0, y: 0, width: 800, height: 50 },
      { x: NaN, y: 0, width: 800, height: 600 },
      { x: '0', y: 0, width: 800, height: 600 },
      { x: -32000, y: -32000, width: 160, height: 28 }, // posição de janela minimizada
      { x: 1e9, y: 0, width: 800, height: 600 },
    ]) expect(validPlacement(v)).toBeUndefined();
  });

  it('só `maximized: true` conta como maximizada', () => {
    expect(validPlacement({ x: 0, y: 0, width: 800, height: 600, maximized: 'sim' })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe('parsePlacementOutput', () => {
  it('uma linha por operação, na ordem pedida; MISS e linhas estranhas viram null', () => {
    const out = [
      'WARNING: algo do PowerShell',
      'R 1 MISS',
      'R 0 132456 -1927 0 1934 1039 0 OK',
      'R 2 99 10 20 800 600 1 -',
      'R 3 99 10 20 50 50 0 OK', // tamanho inválido
      'R 9 99 10 20 800 600 0 OK', // fora do intervalo
    ].join('\r\n');
    const r = parsePlacementOutput(out, 4);
    expect(r).toHaveLength(4);
    expect(r[0]).toEqual({ hwnd: 132456, placement: { x: -1927, y: 0, width: 1934, height: 1039 }, result: 'OK' });
    expect(r[1]).toBeNull();
    expect(r[2]).toEqual({ hwnd: 99, placement: { x: 10, y: 20, width: 800, height: 600, maximized: true }, result: '-' });
    expect(r[3]).toBeNull();
  });

  it('saída vazia: nada achado', () => {
    expect(parsePlacementOutput('', 2)).toEqual([null, null]);
  });
});

describe('script de posição', () => {
  it('nunca usa ShowWindow síncrono (escondia a janela do Deck; ver focusHelperSource)', () => {
    const src = placementHelperSource();
    expect(src).not.toMatch(/\bShowWindow\s*\(/);
    expect(src).toContain('ShowWindowAsync');
    expect(src).toContain('SetThreadDpiAwarenessContext'); // pixels físicos com escalas diferentes por monitor
  });

  it('leva as operações e o perfil em base64 e confere o perfil do Deck', () => {
    const script = buildPlacementScript(profile, [{ marker: 'deck-abc', apply: { x: 1, y: 2, width: 800, height: 600, maximized: true } }, { hwnd: 77 }], brave);
    const b64 = /FromBase64String\('([^']+)'\)\)\r?\n\$targetProfile/.exec(script)?.[1];
    expect(b64).toBeTruthy();
    expect(JSON.parse(Buffer.from(b64!, 'base64').toString('utf8'))).toEqual([
      { m: 'deck-abc', a: { x: 1, y: 2, width: 800, height: 600, maximized: true } },
      { h: 77 },
    ]);
    expect(script).toContain(Buffer.from(profile, 'utf8').toString('base64'));
    expect(script).toContain('--user-data-dir=');
    expect(script).toContain("$expectedName = 'brave'");
  });

  it('descarta posição inválida em vez de mandá-la ao Windows', () => {
    const script = buildPlacementScript(profile, [{ marker: 'deck-x', apply: { x: 0, y: 0, width: 10, height: 10 } }], brave);
    const b64 = /FromBase64String\('([^']+)'\)\)\r?\n\$targetProfile/.exec(script)?.[1];
    expect(JSON.parse(Buffer.from(b64!, 'base64').toString('utf8'))).toEqual([{ m: 'deck-x' }]);
  });
});

describe('runPlacement', () => {
  const fake = (stdout: string, error: Error | null = null) => {
    const calls: { file: string; args: string[]; opts: any }[] = [];
    const fn = ((file: string, args: string[], opts: any, cb: (e: Error | null, out: string) => void) => {
      calls.push({ file, args, opts });
      cb(error, stdout);
    }) as any;
    return { fn, calls };
  };

  it('fora do Windows, sem operações ou com Firefox não roda nada', async () => {
    const f = fake('R 0 1 0 0 800 600 0 -');
    expect(await runPlacement(profile, [{ marker: 'm' }], { platform: 'linux', execFileFn: f.fn })).toEqual([null]);
    expect(await runPlacement(profile, [], { platform: 'win32', execFileFn: f.fn })).toEqual([]);
    expect(await runPlacement(profile, [{ marker: 'm' }], { platform: 'win32', execFileFn: f.fn, browser: { ...brave, id: 'firefox' } })).toEqual([null]);
    expect(await runPlacement('  ', [{ marker: 'm' }], { platform: 'win32', execFileFn: f.fn })).toEqual([null]);
    expect(f.calls).toHaveLength(0);
  });

  it('roda o PowerShell oculto, com timeout, e devolve o resultado lido', async () => {
    const f = fake('R 0 4242 100 50 1200 900 0 OK\r\n');
    const r = await runPlacement(profile, [{ marker: 'deck-1', apply: { x: 100, y: 50, width: 1200, height: 900 } }], {
      platform: 'win32',
      execFileFn: f.fn,
      powerShellPath: 'C:\\ps.exe',
      browser: brave,
    });
    expect(r).toEqual([{ hwnd: 4242, placement: { x: 100, y: 50, width: 1200, height: 900 }, result: 'OK' }]);
    expect(f.calls[0].file).toBe('C:\\ps.exe');
    expect(f.calls[0].args).toContain('-EncodedCommand');
    expect(f.calls[0].opts).toMatchObject({ windowsHide: true, timeout: 15_000 });
  });

  it('erro do PowerShell: nada achado (não inventa posição)', async () => {
    const f = fake('R 0 4242 100 50 1200 900 0 OK', new Error('timeout'));
    expect(await runPlacement(profile, [{ marker: 'm' }], { platform: 'win32', execFileFn: f.fn })).toEqual([null]);
  });
});
