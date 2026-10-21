// Atualizar o Claude Code de um servidor: comparação de versões, comando, saída e a regra do registro.
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, isNewerVersion, isPlainVersion } from '../../src/shared/version';
import { buildUpdateCommand, classifyClaudeBin, parseUpdateOutput } from '../../src/server/claude/update';
import { HostRegistry } from '../../src/server/hosts/registry';

describe('versões', () => {
  it('compara numericamente, não como texto', () => {
    expect(compareVersions('2.1.293', '2.1.205')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('2.1.293', '2.1.293')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
  });

  it('só é "mais nova" com duas versões X.Y.Z e a primeira maior', () => {
    expect(isNewerVersion('2.1.293', '2.1.205')).toBe(true);
    expect(isNewerVersion('2.1.205', '2.1.293')).toBe(false);
    expect(isNewerVersion('2.1.293', '2.1.293')).toBe(false);
    for (const bad of [undefined, null, '', '?', 'latest', '2.1', '2.1.293-beta']) {
      expect(isNewerVersion(bad as any, '2.1.205')).toBe(false);
      expect(isNewerVersion('2.1.293', bad as any)).toBe(false);
    }
    expect(isPlainVersion('2.1.293')).toBe(true);
    expect(isPlainVersion('?')).toBe(false);
  });
});

describe('classifyClaudeBin', () => {
  it('binário da extensão do editor não é atualizável pelo Deck', () => {
    expect(classifyClaudeBin('/home/u/.vscode-server/extensions/anthropic.claude-code-2.1.289-linux-x64/resources/native-binary/claude')).toBe('extension');
    expect(classifyClaudeBin('/home/u/.cursor-server/extensions/anthropic.claude-code-2.1.289/resources/native-binary/claude')).toBe('extension');
  });
  it('instalador nativo, npm e nvm são atualizáveis', () => {
    for (const p of ['/home/u/.local/bin/claude', '/usr/local/bin/claude', '/home/u/.nvm/versions/node/v22.1.0/bin/claude', '/home/u/.npm-global/bin/claude', '/home/u/.claude/local/claude']) {
      expect(classifyClaudeBin(p)).toBe('updatable');
    }
  });
});

describe('buildUpdateCommand', () => {
  it('o caminho vai em base64: nenhuma letra dele chega ao shell', () => {
    const p = '/home/u/a b/$(rm -rf ~)/`x`/"q"/\'s\'/claude';
    const cmd = buildUpdateCommand(p);
    expect(cmd).toContain(Buffer.from(p).toString('base64'));
    for (const piece of ['rm -rf', '$(rm', '`x`', '"q"', "'s'", 'a b']) expect(cmd).not.toContain(piece);
    expect(cmd.startsWith('exec "${SHELL:-/bin/sh}" -lc \'')).toBe(true);
    expect(cmd).toContain('DECK_EXIT=$rc');
    // O script inteiro está em um único par de aspas simples (nada de aspas internas que fechem o par).
    expect(cmd.slice(cmd.indexOf("-lc '") + 5, -1)).not.toContain("'");
    expect(cmd.endsWith("'")).toBe(true);
  });

  it('recusa caminho relativo, vazio, com quebra de linha ou NUL', () => {
    for (const bad of ['claude', '', './claude', '/a/b\nrm -rf /', '/a/b\r/claude', '/a/\0/claude']) {
      expect(() => buildUpdateCommand(bad)).toThrow('Caminho do Claude inválido');
    }
  });

  // Roda de verdade num sh (Linux/macOS): um "claude" falso com nome cheio de caracteres perigosos.
  it.skipIf(process.platform === 'win32')('executa o binário certo, preserva o código de saída e não interpreta o nome', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck up $(touch PWNED) `x` '));
    try {
      const bin = path.join(dir, "claude's");
      fs.writeFileSync(bin, '#!/bin/sh\necho "args=$*"\necho "path=$PATH" | cut -c1-40\nexit 7\n', { mode: 0o755 });
      const r = spawnSync('sh', ['-c', buildUpdateCommand(bin)], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' }, cwd: dir });
      const out = parseUpdateOutput(r.stdout);
      expect(out.exit).toBe(7);
      expect(out.tail).toContain('args=update');
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseUpdateOutput', () => {
  it('lê o código de saída e tira cores e o marcador', () => {
    const r = parseUpdateOutput('\u001b[32mAtualizado\u001b[0m para 2.1.293\r\n\nDECK_EXIT=0\n');
    expect(r.exit).toBe(0);
    expect(r.tail).toBe('Atualizado para 2.1.293');
  });
  it('sem o marcador (conexão cortada) o código é desconhecido, não zero', () => {
    expect(parseUpdateOutput('baixando...').exit).toBeNull();
    expect(parseUpdateOutput('').exit).toBeNull();
  });
  it('saída longa fica só com o final', () => {
    const r = parseUpdateOutput('x'.repeat(5000) + '\nfim\nDECK_EXIT=1\n', 100);
    expect(r.exit).toBe(1);
    expect(r.tail.length).toBeLessThanOrEqual(101);
    expect(r.tail.startsWith('…')).toBe(true);
    expect(r.tail.endsWith('fim')).toBe(true);
  });
});

// ---------------------------------------------------------------- regra do registro (SSH simulado)

function setup(opts: { version?: string; binPath?: string; latest?: string; afterVersion?: string; run?: (cmd: string) => Promise<any> } = {}) {
  const logs: string[] = [];
  const reg = new HostRegistry({} as any, { cancelHost: vi.fn() } as any, (m) => logs.push(m));
  const binPath = opts.binPath ?? '/home/u/.local/bin/claude';
  let version = opts.version ?? '2.1.205';
  const runImpl: (cmd: string, runOpts?: unknown) => Promise<any> = opts.run ?? (async () => ({ code: 0, stdout: 'Atualizado\nDECK_EXIT=0\n', stderr: '' }));
  const run = vi.fn(runImpl);
  (reg as any).handles.set('srv', { id: 'srv', kind: 'ssh', platform: 'posix', fs: {}, ssh: { connected: true, busy: false, run, close: vi.fn(), channelCount: 0, connectionCount: 1 } });
  (reg as any).latest = { current: opts.latest ?? '2.1.293', ensure: async () => opts.latest ?? '2.1.293' };
  const publish = () => (reg as any).statuses.set('srv', { id: 'srv', state: 'ready', claude: binPath ? { path: binPath, version } : null });
  publish();
  // connect() de verdade fala SSH; aqui só republica o que o servidor "tem" agora.
  (reg as any).connect = vi.fn(async (_id: string, force?: boolean) => {
    if (force && opts.afterVersion) version = opts.afterVersion;
    publish();
    return reg.status('srv');
  });
  const events: any[] = [];
  reg.on('status', (s) => events.push(s));
  return { reg, run, logs, events, setVersion: (v: string) => ((version = v), publish()) };
}

describe('HostRegistry: aviso de versão mais nova', () => {
  it('oferece quando o servidor está atrás da última versão', () => {
    expect(setup().reg.status('srv').claudeLatest).toBe('2.1.293');
  });
  it('some quando está em dia, à frente ou a versão é desconhecida', () => {
    expect(setup({ version: '2.1.293' }).reg.status('srv').claudeLatest).toBeUndefined();
    expect(setup({ version: '2.1.300' }).reg.status('srv').claudeLatest).toBeUndefined();
    expect(setup({ version: '?' }).reg.status('srv').claudeLatest).toBeUndefined();
  });
  it('sem a consulta ao npm (sem internet) não mostra nada', () => {
    const { reg } = setup();
    (reg as any).latest = { current: undefined, ensure: async () => undefined };
    expect(reg.status('srv').claudeLatest).toBeUndefined();
  });
  it('não oferece para binário de extensão do editor nem para o computador local', () => {
    const ext = '/home/u/.vscode-server/extensions/anthropic.claude-code-2.1.205-linux-x64/resources/native-binary/claude';
    expect(setup({ binPath: ext }).reg.status('srv').claudeLatest).toBeUndefined();
    const { reg } = setup();
    (reg as any).statuses.set('local', { id: 'local', state: 'ready', claude: { path: 'C:\\x\\claude.exe', version: '2.1.205' } });
    expect(reg.status('local').claudeLatest).toBeUndefined();
  });
});

describe('HostRegistry.updateClaude', () => {
  it('atualiza, confere a versão depois e devolve antes/depois', async () => {
    const { reg, run, logs } = setup({ afterVersion: '2.1.293' });
    const r = await reg.updateClaude('srv');
    expect(r).toMatchObject({ before: '2.1.205', after: '2.1.293', changed: true, latest: '2.1.293', output: 'Atualizado' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain(Buffer.from('/home/u/.local/bin/claude').toString('base64'));
    expect(run.mock.calls[0][1]).toMatchObject({ timeoutMs: 300_000 });
    expect(reg.status('srv').claudeLatest).toBeUndefined();
    expect(logs.some((l) => l.includes('2.1.205 → 2.1.293'))).toBe(true);
  });

  it('duas chamadas ao mesmo tempo viram uma execução só', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { reg, run } = setup({ afterVersion: '2.1.293', run: async () => (await gate, { code: 0, stdout: 'DECK_EXIT=0\n', stderr: '' }) });
    const a = reg.updateClaude('srv');
    const b = reg.updateClaude('srv');
    release();
    expect(await a).toEqual(await b);
    expect(run).toHaveBeenCalledTimes(1);
    // Terminou: uma nova chamada volta a executar.
    await reg.updateClaude('srv');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('já na mais nova do canal dele: não mudou, avisa e para de oferecer a mesma atualização', async () => {
    const { reg, events } = setup(); // o servidor continua em 2.1.205 depois do update
    const r = await reg.updateClaude('srv');
    expect(r).toMatchObject({ before: '2.1.205', after: '2.1.205', changed: false });
    expect(reg.status('srv').claudeLatest).toBeUndefined();
    expect(events.at(-1)?.claudeLatest).toBeUndefined(); // a interface foi avisada
  });

  it('o aviso volta se o servidor mudar de versão por fora e ficar de novo atrás', async () => {
    const { reg, setVersion } = setup();
    await reg.updateClaude('srv');
    expect(reg.status('srv').claudeLatest).toBeUndefined();
    setVersion('2.1.250');
    expect(reg.status('srv').claudeLatest).toBe('2.1.293');
  });

  it('erro do claude update com a versão igual: vira erro com o final da saída', async () => {
    const { reg } = setup({ run: async () => ({ code: 0, stdout: 'EACCES: permission denied, rename /usr/lib/node_modules\nDECK_EXIT=1\n', stderr: '' }) });
    await expect(reg.updateClaude('srv')).rejects.toMatchObject({ code: 'update', message: expect.stringContaining('EACCES') });
    expect(reg.status('srv').claudeLatest).toBe('2.1.293'); // continua desatualizado e visível
  });

  it('sem marcador de saída e versão igual: erro (não presume sucesso)', async () => {
    const { reg } = setup({ run: async () => ({ code: null, stdout: 'baixando', stderr: '' }) });
    await expect(reg.updateClaude('srv')).rejects.toMatchObject({ code: 'update' });
  });

  it('a versão subiu mesmo com código de saída ruim: vale o resultado, não o texto', async () => {
    const { reg } = setup({ afterVersion: '2.1.293', run: async () => ({ code: 0, stdout: 'aviso qualquer\nDECK_EXIT=1\n', stderr: '' }) });
    await expect(reg.updateClaude('srv')).resolves.toMatchObject({ changed: true, after: '2.1.293' });
  });

  it('passou de 5 minutos: explica em vez de mostrar "tempo esgotado" seco', async () => {
    const { DeckError } = await import('../../src/shared/protocol');
    const { reg } = setup({ run: async () => { throw new DeckError('timeout', 'Tempo esgotado executando comando em srv'); } });
    await expect(reg.updateClaude('srv')).rejects.toMatchObject({ code: 'update', message: expect.stringContaining('5 minutos') });
  });

  it('binário da extensão do editor: recusa sem tocar no servidor', async () => {
    const { reg, run } = setup({ binPath: '/home/u/.vscode-server/extensions/anthropic.claude-code-2.1.205-linux-x64/resources/native-binary/claude' });
    await expect(reg.updateClaude('srv')).rejects.toMatchObject({ code: 'managed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('servidor sem Claude instalado: ensina a instalar', async () => {
    const { reg, run } = setup({ binPath: '' });
    await expect(reg.updateClaude('srv')).rejects.toMatchObject({ code: 'noclaude', message: expect.stringContaining('install.sh') });
    expect(run).not.toHaveBeenCalled();
  });

  it('o computador local não é atualizado pelo Deck', async () => {
    const { reg } = setup();
    await expect(reg.updateClaude('local')).rejects.toMatchObject({ code: 'local' });
  });
});
