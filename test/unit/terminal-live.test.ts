// Testes do terminal ao vivo (TerminalAgent + TerminalManager) com PTY local de verdade
// (powershell.exe neste Windows), sempre num diretório temporário isolado por teste — nunca a
// cwd real do usuário nem qualquer sessão/host de cliente. Cada teste fecha seus próprios
// terminais e apaga seu próprio diretório no afterEach.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalAgent } from '../../src/server/terminal/agent';
import { TerminalManager } from '../../src/server/terminal/manager';

const echoCmd = (text: string) => `echo ${text}`;

function fakeRegistry(): any {
  // Só terminais locais nestes testes: nunca abrir SSH de verdade num teste unitário.
  return { get: () => ({ kind: 'local' }) };
}

const managers: TerminalManager[] = [];
const dirs: string[] = [];

/** Diretório novo e isolado (nunca reaproveita cwd real). */
function tempCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deck-term-test-'));
  dirs.push(d);
  return d;
}

function newManager(): TerminalManager {
  const tm = new TerminalManager(fakeRegistry(), () => {});
  managers.push(tm);
  return tm;
}

afterEach(() => {
  for (const tm of managers.splice(0)) tm.closeAll();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* melhor esforço */
    }
  }
});

describe('TerminalAgent - terminal ao vivo', () => {
  it('run() digita o comando de verdade e devolve a saída real (não um placeholder)', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    const r = await agent.run(term.id, echoCmd('deck-live-terminal-ok'), { timeoutMs: 8000 });

    expect(r.output).toContain('deck-live-terminal-ok');
    expect(r.state).toBe('prompt');
    expect(r.truncated).toBe(0);
  }, 15000);

  it('read() mostra a tela sem digitar nada, depois de um run()', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    await agent.run(term.id, echoCmd('deck-read-check'), { timeoutMs: 8000 });
    const r = await agent.read(term.id, 20);

    expect(r.output).toContain('deck-read-check');
    expect(r.fullScreen).toBe(false);
  }, 15000);

  it('a marca não pode ser descartada antes da saída ser lida: comando com muitas linhas não perde o começo', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    // >200 linhas de propósito: a versão com bug descartava a marca antes de ler e caía num
    // fallback de "últimas 200 linhas a partir do cursor", cortando o início silenciosamente
    // (sem contar em `truncated`, que só existe para o corte por maxLines).
    const r = await agent.run(term.id, "Write-Host 'ZZZ-MARK-START'; 1..260 | ForEach-Object { \"MARK-LINE-$_\" }", {
      timeoutMs: 15000,
      quietMs: 800,
    });

    expect(r.truncated).toBe(0);
    expect(r.output).toContain('ZZZ-MARK-START');
    expect(r.output).toContain('MARK-LINE-1\n');
    expect(r.output).toContain('MARK-LINE-260');
    expect(r.state).toBe('prompt');
  }, 20000);

  it('run() novo é recusado (busy) enquanto o comando anterior não confirma o fim; só wait() explícito destrava', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    expect(agent.isBusy(term.id)).toBe(false);

    // Start-Sleep não imprime nada: a tela fica muda bem antes do comando realmente acabar —
    // exatamente o estado ambíguo que a versão antiga liberava o terminal para o próximo run().
    const r1 = await agent.run(term.id, 'Start-Sleep -Milliseconds 2000', { timeoutMs: 1000, quietMs: 300 });
    expect(r1.state === 'quiet' || r1.state === 'timeout').toBe(true);
    expect(agent.isBusy(term.id)).toBe(true);

    await expect(agent.run(term.id, 'echo deveria-ser-recusado')).rejects.toMatchObject({ code: 'busy' });
    const read1 = await agent.read(term.id, 20);
    expect(read1.output).not.toContain('deveria-ser-recusado');

    // send()/wait() explícitos continuam permitidos mesmo ocupado.
    const r2 = await agent.wait(term.id, { timeoutMs: 10_000, quietMs: 4000 });
    expect(r2.state).toBe('prompt');
    expect(agent.isBusy(term.id)).toBe(false);

    const r3 = await agent.run(term.id, echoCmd('deck-live-terminal-unlocked'), { timeoutMs: 8000 });
    expect(r3.output).toContain('deck-live-terminal-unlocked');
    expect(r3.state).toBe('prompt');
  }, 25000);

  it('run() recusa digitar comando quando a tela pede senha/login agora (nunca inventa senha)', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    // Read-Host bloqueia de verdade esperando entrada (diferente de só imprimir texto): a tela
    // fica parada em "Password:" até alguém responder — o mesmo que um ssh/sudo pedindo senha.
    const r1 = await agent.run(term.id, "Read-Host -Prompt 'Password' -AsSecureString | Out-Null", { timeoutMs: 8000, quietMs: 400 });
    expect(r1.state).toBe('password');

    await expect(agent.run(term.id, 'echo nao-deveria-rodar')).rejects.toMatchObject({ code: 'credential_prompt' });

    // send() continua liberado (é a ferramenta certa para responder o prompt) — Enter em branco
    // conclui o Read-Host e o terminal volta ao prompt normal.
    const r2 = await agent.send(term.id, { keys: ['enter'] }, { timeoutMs: 8000 });
    expect(r2.state).toBe('prompt');
  }, 15000);

  it('pedido cancelado ANTES de sua vez na fila não escreve nada no terminal', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    const ac = new AbortController();
    // Ocupa o terminal com algo que segura a exclusividade por um tempinho.
    const p1 = agent.run(term.id, 'Start-Sleep -Milliseconds 800', { timeoutMs: 3000, quietMs: 300 });
    // Já cancelado ANTES mesmo de entrar na fila de execução (a versão antiga só checava o
    // cancelamento DEPOIS de já ter escrito o comando).
    ac.abort();
    const p2 = agent.run(term.id, 'echo NUNCA-DEVERIA-APARECER', { signal: ac.signal });

    const [, r2] = await Promise.all([p1, p2]);
    expect(r2.state).toBe('cancelled');
    expect(r2.output).toBe('');

    await new Promise((r) => setTimeout(r, 400));
    const read = await agent.read(term.id, 100);
    expect(read.output).not.toContain('NUNCA-DEVERIA-APARECER');
  }, 15000);

  it('does not append a new command to manual partial input', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });
    await agent.run(term.id, "Write-Output ('READY-' + (8 * 8))", { timeoutMs: 8000 });
    tm.write(term.id, 'partial-command');
    for (let i = 0; i < 50; i++) {
      if ((await agent.read(term.id)).lastLine.endsWith('partial-command')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await expect(agent.run(term.id, 'echo NEVER-APPEND')).rejects.toMatchObject({ code: 'not_ready' });
    expect((await agent.read(term.id)).output).not.toContain('NEVER-APPEND');
  }, 15000);

  it('interlock manual: notifyManualInput/hasPendingOperation/manualTakeover', async () => {
    const tm = newManager();
    const agent = new TerminalAgent(tm);
    const term = await tm.open({ hostId: 'local', cwd: tempCwd() });

    expect(agent.hasPendingOperation(term.id)).toBe(false);
    expect(agent.isBusy(term.id)).toBe(false);

    await agent.run(term.id, echoCmd('primeiro-ok'), { timeoutMs: 8000 });
    expect(agent.isBusy(term.id)).toBe(false);

    // Alguém digitou direto na aba, por fora do agente: marca ocupado por segurança.
    agent.notifyManualInput(term.id);
    expect(agent.isBusy(term.id)).toBe(true);
    await expect(agent.run(term.id, 'echo deveria-falhar')).rejects.toMatchObject({ code: 'busy' });

    // Só um wait()/send() explícito destrava de novo.
    const r = await agent.wait(term.id, { timeoutMs: 5000, quietMs: 500 });
    expect(r.state).toBe('prompt');
    expect(agent.isBusy(term.id)).toBe(false);

    // manualTakeover cancela o que estiver rodando/na fila e invalida o estado (fica ocupado).
    const p = agent.run(term.id, 'Start-Sleep -Milliseconds 1500', { timeoutMs: 5000, quietMs: 300 });
    expect(agent.hasPendingOperation(term.id)).toBe(true);
    const hadSomethingToCancel = agent.manualTakeover(term.id);
    expect(hadSomethingToCancel).toBe(true);

    const cancelledResult = await p;
    expect(cancelledResult.state).toBe('cancelled');
    expect(agent.isBusy(term.id)).toBe(true);

    // Nada rodando/na fila: não há o que cancelar.
    expect(agent.manualTakeover('id-de-terminal-inexistente')).toBe(false);
  }, 20000);
});
