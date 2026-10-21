// Soltar a conexão SSH de um servidor quando a última aba dele é fechada: a folga, a conferência no
// fim dela e o que conta como "ocupado" (canais abertos e usos longos do SFTP).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostRegistry } from '../../src/server/hosts/registry';
import { SshHost } from '../../src/server/hosts/ssh';

function fakeSsh(over: Partial<{ connected: boolean; busy: boolean }> = {}) {
  return { connected: true, busy: false, close: vi.fn(), ...over };
}

function registryWith(id: string, ssh: ReturnType<typeof fakeSsh>) {
  const prompts = { cancelHost: vi.fn() };
  const logs: string[] = [];
  const reg = new HostRegistry({} as any, prompts as any, (m) => logs.push(m));
  (reg as any).handles.set(id, { id, kind: 'ssh', platform: 'posix', fs: {}, ssh });
  return { reg, prompts, logs };
}

describe('HostRegistry.releaseWhenIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fecha a conexão depois da folga quando nada mais a usa', () => {
    const ssh = fakeSsh();
    const { reg, prompts, logs } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(999);
    expect(ssh.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ssh.close).toHaveBeenCalledTimes(1);
    expect(prompts.cancelHost).toHaveBeenCalledWith('srv');
    expect(logs.some((l) => l.includes('fechando a conexão SSH'))).toBe(true);
    // Mantém o que já se sabe do servidor (pasta pessoal, Claude) para a interface.
    expect(reg.status('srv').state).toBe('idle');
  });

  it('não fecha se uma aba voltou a usar o servidor durante a folga', () => {
    const ssh = fakeSsh();
    const { reg } = registryWith('srv', ssh);
    let inUse = false;
    reg.releaseWhenIdle('srv', () => inUse, 1000);
    inUse = true; // abriu outra conversa no mesmo servidor
    vi.advanceTimersByTime(5000);
    expect(ssh.close).not.toHaveBeenCalled();
  });

  it('não fecha com canal aberto ou uso longo do SFTP em andamento', () => {
    const ssh = fakeSsh({ busy: true });
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(5000);
    expect(ssh.close).not.toHaveBeenCalled();
  });

  it('não fecha enquanto o servidor está conectando', () => {
    const ssh = fakeSsh();
    const { reg } = registryWith('srv', ssh);
    (reg as any).connecting.set('srv', new Promise(() => {}));
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(5000);
    expect(ssh.close).not.toHaveBeenCalled();
  });

  it('uso passageiro na hora da conferência: tenta de novo e fecha quando passa', () => {
    const ssh = fakeSsh({ busy: true }); // ex.: leitura de transcrito em andamento justo agora
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(2500);
    expect(ssh.close).not.toHaveBeenCalled();
    ssh.busy = false;
    vi.advanceTimersByTime(1000);
    expect(ssh.close).toHaveBeenCalledTimes(1);
  });

  it('uso que nunca passa: para de tentar depois de algumas vezes (sem timer sobrando)', () => {
    const ssh = fakeSsh({ busy: true });
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(60_000);
    expect(ssh.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aba que voltou durante as tentativas: não fecha e não insiste', () => {
    const ssh = fakeSsh({ busy: true });
    const { reg } = registryWith('srv', ssh);
    let inUse = false;
    reg.releaseWhenIdle('srv', () => inUse, 1000);
    vi.advanceTimersByTime(1500);
    inUse = true;
    ssh.busy = false;
    vi.advanceTimersByTime(60_000);
    expect(ssh.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('um novo pedido reinicia a folga (fecha uma vez só)', () => {
    const ssh = fakeSsh();
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(800);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(800);
    expect(ssh.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(ssh.close).toHaveBeenCalledTimes(1);
  });

  it('ignora servidor sem conexão SSH (local ou nunca usado)', () => {
    const { reg } = registryWith('srv', fakeSsh());
    expect(() => reg.releaseWhenIdle('local', () => false, 10)).not.toThrow();
    expect(() => reg.releaseWhenIdle('nunca-usado', () => false, 10)).not.toThrow();
    vi.advanceTimersByTime(100);
  });

  it('já desconectado: não fecha de novo', () => {
    const ssh = fakeSsh({ connected: false });
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    vi.advanceTimersByTime(5000);
    expect(ssh.close).not.toHaveBeenCalled();
  });

  it('desconectar à mão cancela o pedido pendente', () => {
    const ssh = fakeSsh();
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    reg.disconnect('srv');
    expect(ssh.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(ssh.close).toHaveBeenCalledTimes(1);
  });

  it('closeAll cancela os pedidos pendentes', () => {
    const ssh = fakeSsh();
    const { reg } = registryWith('srv', ssh);
    reg.releaseWhenIdle('srv', () => false, 1000);
    reg.closeAll();
    expect(ssh.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(ssh.close).toHaveBeenCalledTimes(1);
  });
});

describe('SshHost.busy', () => {
  function hostWith(conns: object[]) {
    const host = new SshHost('srv', { prompts: {} as any, sshDir: '', log: () => {} });
    (host as any).conns = conns;
    return host;
  }
  const conn = (channels: number, sftp = false, alive = true) => ({ id: 1, alive, channels, limit: 8, sftp: sftp ? Promise.resolve({}) : undefined });

  it('só o canal SFTP aberto não é uso', () => {
    expect(hostWith([conn(1, true)]).busy).toBe(false);
    expect(hostWith([conn(0)]).busy).toBe(false);
  });

  it('conversa, terminal ou comando em andamento (canais além do SFTP) é uso', () => {
    expect(hostWith([conn(2, true)]).busy).toBe(true);
    expect(hostWith([conn(1)]).busy).toBe(true);
  });

  it('conexão morta não conta', () => {
    expect(hostWith([conn(3, true, false)]).busy).toBe(false);
  });

  it('segunda conexão com canais também conta', () => {
    expect(hostWith([conn(1, true), conn(1)]).busy).toBe(true);
  });

  it('uso longo marcado com hold() é uso até ser liberado (e liberar duas vezes não desconta duas)', () => {
    const host = hostWith([conn(1, true)]);
    const a = host.hold();
    const b = host.hold();
    expect(host.busy).toBe(true);
    a();
    a();
    expect(host.busy).toBe(true); // b ainda segura
    b();
    expect(host.busy).toBe(false);
  });

  it('marcas de uso morrem com a conexão: operação que ficou no ar não deixa o servidor ocupado para sempre', () => {
    const host = hostWith([conn(1, true)]);
    host.hold(); // leitura SFTP que nunca vai receber resposta porque a conexão fechou
    expect(host.busy).toBe(true);
    host.close();
    expect(host.busy).toBe(false);
    // e uma marca solta depois do fechamento não desconta de quem veio depois
    const stale = host.hold();
    host.close();
    const fresh = host.hold();
    stale();
    expect(host.busy).toBe(true);
    fresh();
    expect(host.busy).toBe(false);
  });

  it('abrindo o SFTP ou conectando agora é uso', () => {
    const host = hostWith([conn(1, true)]);
    (host as any).sftpOpening = Promise.resolve();
    expect(host.busy).toBe(true);
    (host as any).sftpOpening = null;
    (host as any).connecting = Promise.resolve();
    expect(host.busy).toBe(true);
  });
});
