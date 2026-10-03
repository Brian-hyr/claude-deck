import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { TaskbarBadge, badgePayload, buildBadgeScript, summarizeBadge, type BadgeConversation, type BadgeSummary } from '../../src/server/taskbar';

// Selo da barra de tarefas: quantas conversas pedem você (terminaram e não foram vistas, erro, esperando resposta).

const conv = (o: Partial<BadgeConversation> = {}): BadgeConversation => ({ wid: 'w1', phase: 'idle', waiting: false, ...o });
const live = (...w: string[]) => new Set(w);

describe('summarizeBadge', () => {
  it('sem nada a ver: zero e sem cor', () => {
    const s = summarizeBadge([conv(), conv({ phase: 'dormant' })], live('w1'));
    expect(s).toMatchObject({ count: 0, kind: null, description: '' });
    expect(summarizeBadge([], live('w1')).count).toBe(0);
  });

  it('trabalhando não conta', () => {
    expect(summarizeBadge([conv({ phase: 'running' })], live('w1')).count).toBe(0);
  });

  it('conta terminadas, com erro e esperando resposta', () => {
    const s = summarizeBadge(
      [conv({ unseen: 'done' }), conv({ unseen: 'done' }), conv({ unseen: 'error' }), conv({ waiting: true, phase: 'running' })],
      live('w1'),
    );
    expect(s).toMatchObject({ count: 4, done: 2, error: 1, waiting: 1 });
    expect(s.description).toBe('2 concluídas, 1 com erro, 1 esperando você');
  });

  it('a cor segue o mais urgente: esperando > erro > marcada > concluída', () => {
    expect(summarizeBadge([conv({ unseen: 'done' })], live('w1')).kind).toBe('done');
    expect(summarizeBadge([conv({ unseen: 'done' }), conv({ manualPending: true })], live('w1')).kind).toBe('pending');
    expect(summarizeBadge([conv({ unseen: 'done' }), conv({ manualPending: true }), conv({ unseen: 'error' })], live('w1')).kind).toBe('error');
    expect(summarizeBadge([conv({ unseen: 'done' }), conv({ manualPending: true }), conv({ unseen: 'error' }), conv({ waiting: true })], live('w1')).kind).toBe('waiting');
  });

  it('cada conversa conta uma vez, pelo estado mais urgente', () => {
    // esperando resposta E com "terminou" guardado de antes: é 1, não 2
    expect(summarizeBadge([conv({ waiting: true, unseen: 'done' })], live('w1'))).toMatchObject({ count: 1, waiting: 1, pending: 0, done: 0 });
    expect(summarizeBadge([conv({ unseen: 'error', phase: 'error' })], live('w1'))).toMatchObject({ count: 1, error: 1 });
    // A marca explícita é distinta do `unseen` automático, mas não cria uma segunda bolinha.
    expect(summarizeBadge([conv({ manualPending: true, unseen: 'done' })], live('w1'))).toMatchObject({ count: 1, pending: 1, done: 0, description: '1 marcada para depois' });
  });

  it('o Claude que não subiu ou caiu (fase error) conta como erro, mesmo sem "não visto"', () => {
    expect(summarizeBadge([conv({ phase: 'error' })], live('w1'))).toMatchObject({ count: 1, kind: 'error', error: 1 });
  });

  it('singular e plural na descrição', () => {
    expect(summarizeBadge([conv({ unseen: 'done' })], live('w1')).description).toBe('1 concluída');
    expect(summarizeBadge([conv({ unseen: 'done' }), conv({ unseen: 'done' })], live('w1')).description).toBe('2 concluídas');
    expect(summarizeBadge([conv({ waiting: true }), conv({ waiting: true })], live('w1')).description).toBe('2 esperando você');
  });

  it('só conta conversa de janela aberta agora', () => {
    const list = [conv({ wid: 'w1', unseen: 'done' }), conv({ wid: 'w2', unseen: 'done' }), conv({ wid: 'w3', unseen: 'error' })];
    expect(summarizeBadge(list, live('w1')).count).toBe(1);
    expect(summarizeBadge(list, live('w1', 'w2')).count).toBe(2);
    expect(summarizeBadge(list, live()).count).toBe(0);
  });

  it('conversa sem janela dona ou já encerrada não conta', () => {
    expect(summarizeBadge([conv({ wid: undefined, unseen: 'done' })], live('w1')).count).toBe(0);
    expect(summarizeBadge([conv({ phase: 'ended', unseen: 'done', waiting: true })], live('w1')).count).toBe(0);
  });

  it('junta as conversas de todas as janelas num número só', () => {
    const list = [conv({ wid: 'w1', unseen: 'done' }), conv({ wid: 'w2', waiting: true }), conv({ wid: 'w3', unseen: 'error' }), conv({ wid: 'w3', unseen: 'done' })];
    expect(summarizeBadge(list, live('w1', 'w2', 'w3'))).toMatchObject({ count: 4, kind: 'waiting' });
  });
});

describe('badgePayload', () => {
  const s = (count: number, kind: BadgeSummary['kind']): BadgeSummary => ({ count, kind, waiting: 0, error: 0, pending: 0, done: count, description: `${count} concluídas` });

  it('zero apaga o selo', () => {
    expect(badgePayload(s(0, null))).toMatchObject({ count: 0, label: '' });
    expect(badgePayload(s(0, 'done'))).toMatchObject({ count: 0 });
  });

  it('número como está, e 99+ acima de 99', () => {
    expect(badgePayload(s(1, 'done')).label).toBe('1');
    expect(badgePayload(s(99, 'done')).label).toBe('99');
    expect(badgePayload(s(100, 'done')).label).toBe('99+');
    expect(badgePayload(s(250, 'done')).count).toBe(250);
  });

  it('uma cor por estado, com tinta que se lê no fundo', () => {
    const waiting = badgePayload(s(1, 'waiting'));
    const error = badgePayload(s(1, 'error'));
    const pending = badgePayload(s(1, 'pending'));
    const done = badgePayload(s(1, 'done'));
    expect(new Set([waiting.fill, error.fill, pending.fill, done.fill]).size).toBe(4);
    expect(waiting.text).toBe('#1f1f1f'); // âmbar claro: número escuro
    expect(error.text).toBe('#ffffff');
    expect(pending.text).toBe('#ffffff');
    expect(done.text).toBe('#ffffff');
  });
});

describe('buildBadgeScript', () => {
  const payload = badgePayload({ count: 3, kind: 'done', waiting: 0, error: 0, pending: 0, done: 3, description: '3 concluídas' });

  it('perfil e dados vão só em Base64 (nada solto no texto do PowerShell)', () => {
    const evil = 'C:\\Users\\José ` $weird "x"\\AppData\\claude-deck\\browser-profile\'; Remove-Item -Recurse C:\\; \'';
    const evilPayload = { ...payload, description: '"; Remove-Item -Recurse C:\\; Write-Output "$((Get-Process).Name)" `' };
    const script = buildBadgeScript(evil, evilPayload);
    expect(script).not.toContain(evil);
    expect(script).not.toContain(evilPayload.description);
    expect(script).not.toContain('Remove-Item');
    const lits = [...script.matchAll(/FromB64 '([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
    expect(lits).toHaveLength(2);
    expect(Buffer.from(lits[0], 'base64').toString('utf8')).toBe(evil);
    expect(JSON.parse(Buffer.from(lits[1], 'base64').toString('utf8'))).toEqual(evilPayload);
  });

  it('só mexe nas janelas do Brave com o perfil do Deck, e usa o selo do Windows', () => {
    const script = buildBadgeScript('C:\\x\\browser-profile', payload);
    expect(script).toContain("Name='brave.exe'");
    expect(script).toContain('--user-data-dir');
    expect(script).toContain('SetOverlayIcon');
    expect(script).toContain('ITaskbarList3');
    expect(script).toContain('DestroyIcon'); // não vaza o ícone
    expect(script).toContain("'Claude Deck'"); // só janelas com o título do app
  });

  it('Edge só recebe selo no processo e perfil próprios do Deck', () => {
    const executable = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    const script = buildBadgeScript('C:\\deck\\browser-profile-edge', payload, {
      id: 'edge', executable, processName: 'msedge', profileDir: 'C:\\deck\\browser-profile-edge',
    });
    expect(script).toContain("Name='msedge.exe'");
    expect(script).toContain('$proc.ExecutablePath');
    expect(script).toContain('--user-data-dir');
    expect(script).not.toContain(executable);
  });

  it('o bloco C# fica literal: nada do PowerShell é expandido dentro dele', () => {
    const script = buildBadgeScript('C:\\x', payload);
    const start = script.indexOf("@'");
    const end = script.indexOf("\n'@");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it.runIf(process.platform === 'win32')('compila e roda de verdade: perfil inexistente não acha janela e não toca em nenhuma', async () => {
    // Sem nenhum Brave com este perfil, o script não atinge janela alguma (nem a do app em uso): é seguro.
    const ghost = `C:\\deck-badge-test-inexistente-${Date.now()}\\browser-profile`;
    const encoded = Buffer.from(buildBadgeScript(ghost, badgePayload({ count: 0, kind: null, waiting: 0, error: 0, pending: 0, done: 0, description: '' })), 'utf16le').toString('base64');
    const out = await new Promise<string>((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: 30_000, windowsHide: true }, (e, stdout) =>
        e ? reject(e) : resolve(String(stdout)),
      ),
    );
    expect(out.trim()).toBe('OK 0');
  }, 40_000);
});

describe('TaskbarBadge', () => {
  let summary: BadgeSummary;
  let calls: { script: string; resolve: (stdout: string, err?: Error) => void }[];
  const sum = (count: number, kind: BadgeSummary['kind'] = 'done'): BadgeSummary => ({ count, kind, waiting: 0, error: 0, pending: 0, done: count, description: `${count} concluídas` });
  /** execFile falso: não responde sozinho; o teste responde quando quiser (para simular o PowerShell demorando). */
  const fakeExec = ((_cmd: string, args: readonly string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
    calls.push({ script: Buffer.from(String(args[5]), 'base64').toString('utf16le'), resolve: (stdout, err) => cb(err ?? null, stdout) });
    return {} as ChildProcess;
  }) as any;
  const make = (extra: Record<string, unknown> = {}) => new TaskbarBadge({ profileDir: 'C:\\p', compute: () => summary, enabled: true, delayMs: 400, execFileFn: fakeExec, exists: () => true, ...extra });
  /** Deixa as promessas pendentes andarem. */
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const countOf = (script: string) => {
    const b64 = /FromB64 '([A-Za-z0-9+/=]+)'/g;
    const lits = [...script.matchAll(b64)].map((m) => m[1]);
    return JSON.parse(Buffer.from(lits[1], 'base64').toString('utf8')).count as number;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    summary = sum(1);
    calls = [];
  });
  afterEach(() => vi.useRealTimers());

  it('uma rajada de avisos vira uma aplicação só', async () => {
    const b = make();
    for (let i = 0; i < 20; i++) b.touch();
    await vi.advanceTimersByTimeAsync(399);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(countOf(calls[0].script)).toBe(1);
  });

  it('a primeira aplicação sempre grava (o selo sobrevive ao daemon), até para zero', async () => {
    summary = sum(0, null);
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    expect(countOf(calls[0].script)).toBe(0); // limpa um selo que ficou de antes
  });

  it('valor igual ao que já está na barra não chama o PowerShell de novo', async () => {
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    calls[0].resolve('OK 2');
    await flush();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    summary = sum(2);
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2);
    expect(countOf(calls[1].script)).toBe(2);
  });

  it('mudar só a cor (mesmo número) também reaplica', async () => {
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    calls[0].resolve('OK 1');
    await flush();
    summary = sum(1, 'error');
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2);
  });

  it('nunca dois PowerShell ao mesmo tempo: mudança durante a execução roda só a última, depois', async () => {
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    // mudou várias vezes enquanto o primeiro ainda roda
    summary = sum(2);
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    summary = sum(3);
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1); // nada em paralelo
    calls[0].resolve('OK 1');
    await flush();
    expect(calls).toHaveLength(2);
    expect(countOf(calls[1].script)).toBe(3); // o do meio (2) foi pulado
    calls[1].resolve('OK 1');
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('falhou ou não achou a janela: a próxima mudança tenta de novo, mesmo com o mesmo valor', async () => {
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    calls[0].resolve('OK 0'); // nenhuma janela atingida
    await flush();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(2);
    calls[1].resolve('', new Error('timed out'));
    await flush();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(3);
    calls[2].resolve('FAIL boom');
    await flush();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(4);
  });

  it('apagar com nenhuma janela achada está certo: não fica tentando', async () => {
    summary = sum(0, null);
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    calls[0].resolve('OK 0');
    await flush();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
  });

  it('refresh reaplica mesmo sem mudança (janela nova), e várias chamadas seguidas viram uma', async () => {
    const b = make();
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    calls[0].resolve('OK 1');
    await flush();
    b.refresh();
    b.refresh();
    b.refresh();
    await vi.advanceTimersByTimeAsync(1499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
  });

  it('desligado (outro sistema, ou nos testes automáticos): não chama nada', async () => {
    const b = make({ enabled: false });
    b.touch();
    b.refresh(10);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
  });

  it('nos testes automáticos (CLAUDE_DECK_TEST_HOOKS=1) fica desligado por padrão', async () => {
    const old = process.env.CLAUDE_DECK_TEST_HOOKS;
    process.env.CLAUDE_DECK_TEST_HOOKS = '1';
    try {
      const b = new TaskbarBadge({ profileDir: 'C:\\p', compute: () => summary, execFileFn: fakeExec });
      b.touch();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(0);
      expect(b.current().count).toBe(1); // mas o resumo continua disponível para o teste conferir
    } finally {
      if (old === undefined) delete process.env.CLAUDE_DECK_TEST_HOOKS;
      else process.env.CLAUDE_DECK_TEST_HOOKS = old;
    }
  });

  it('sem a pasta do perfil do Brave (dados que nunca abriram janela, como os de teste): não gasta PowerShell', async () => {
    const b = make({ exists: () => false });
    b.touch();
    b.refresh(10);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    // e quando a pasta aparece (primeira janela aberta), a próxima mudança já aplica
    const exists = { v: false };
    const c = make({ exists: () => exists.v });
    c.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(0);
    exists.v = true;
    c.refresh(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
  });

  it('dispose cancela o que estava agendado e não deixa aplicar depois', async () => {
    const b = make();
    b.touch();
    b.refresh();
    b.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    b.touch();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
  });

  it('exceção ao chamar o PowerShell não derruba nada', async () => {
    const logs: string[] = [];
    const boom = (() => {
      throw new Error('spawn falhou');
    }) as any;
    const b = make({ execFileFn: boom, log: (m: string) => logs.push(m) });
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(logs.join('\n')).toContain('spawn falhou');
  });

  it('manda o selo pelo PowerShell do sistema, sem janela, com limite de tempo', async () => {
    let opts: any;
    const spy = ((_c: string, _a: readonly string[], o: unknown, cb: (e: Error | null, out: string) => void) => {
      opts = o;
      cb(null, 'OK 1');
      return {} as ChildProcess;
    }) as any;
    const b = make({ execFileFn: spy, timeoutMs: 9000 });
    b.touch();
    await vi.advanceTimersByTimeAsync(400);
    expect(opts.windowsHide).toBe(true);
    expect(opts.timeout).toBe(9000);
  });
});
