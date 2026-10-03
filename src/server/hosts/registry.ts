// Registro de servidores: o computador local + os aliases do ~/.ssh/config.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import type { HostInfo, HostStatus, Platform } from '../../shared/types';
import { LOCAL_HOST_ID } from '../../shared/types';
import { DeckError } from '../../shared/protocol';
import { listEntries, loadSshConfig, resolveHost } from './sshconfig';
import { SshHost } from './ssh';
import type { PromptBroker } from '../prompts';
import type { Store } from '../config';
import type { HostFs } from '../fs/hostfs';
import { LocalFs } from '../fs/localfs';
import { SftpFs } from '../fs/sftpfs';
import { findLocalClaude } from '../claude/find-local';
import runnerScript from '../claude/runner.sh';

export const RUNNER_HASH = crypto.createHash('sha1').update(runnerScript).digest('hex').slice(0, 10);
export const RUNNER_NAME = `runner-${RUNNER_HASH}.sh`;
/** Caminho do runner no servidor, relativo a $HOME. */
export const RUNNER_REL = `.cache/claude-deck/${RUNNER_NAME}`;

export interface HostHandle {
  id: string;
  kind: 'local' | 'ssh';
  platform: Platform;
  fs: HostFs;
  ssh?: SshHost;
}

const COLORS = ['#4fc1ff', '#c586c0', '#4ec9b0', '#dcdcaa', '#ce9178', '#b5cea8', '#d7ba7d', '#9cdcfe', '#f48771', '#89d185', '#e2c08d', '#75beff'];

export function hostColor(id: string): string {
  if (id === LOCAL_HOST_ID) return '#89d185';
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export class HostRegistry extends EventEmitter {
  private handles = new Map<string, HostHandle>();
  private statuses = new Map<string, HostStatus>();
  private connecting = new Map<string, Promise<HostStatus>>();
  /** Servidores onde o runner desta versão já está instalado. */
  private runnerReady = new Set<string>();
  private installing = new Map<string, Promise<void>>();
  readonly localFs = new LocalFs();

  constructor(
    private store: Store,
    private prompts: PromptBroker,
    private log: (m: string) => void,
  ) {
    super();
    this.statuses.set(LOCAL_HOST_ID, { id: LOCAL_HOST_ID, state: 'ready', platform: this.localFs.platform, home: os.homedir() });
  }

  list(): HostInfo[] {
    const blocks = loadSshConfig(this.store.paths.sshDir);
    const prefs = this.store.hosts;
    const local: HostInfo = {
      id: LOCAL_HOST_ID,
      label: `Este computador (${os.hostname()})`,
      kind: 'local',
      favorite: true,
      recentFolders: prefs.recentFolders[LOCAL_HOST_ID] ?? [os.homedir()],
      color: hostColor(LOCAL_HOST_ID),
    };
    const hosts = listEntries(blocks).map((e) => {
      const r = resolveHost(blocks, e.alias, this.store.paths.sshDir);
      const info: HostInfo = {
        id: e.alias,
        label: e.alias,
        kind: 'ssh',
        address: `${r.user}@${r.hostName}${r.port === 22 ? '' : ':' + r.port}`,
        favorite: prefs.favorites.includes(e.alias),
        recentFolders: prefs.recentFolders[e.alias] ?? [],
        color: hostColor(e.alias),
      };
      return info;
    });
    // Favoritos na ordem de uso (a importação do VS Code grava do mais recente para o mais antigo).
    const rank = new Map(prefs.favorites.map((id, i) => [id, i]));
    const favs = hosts.filter((h) => h.favorite).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return [local, ...favs, ...hosts.filter((h) => !h.favorite)];
  }

  exists(id: string): boolean {
    if (id === LOCAL_HOST_ID) return true;
    return listEntries(loadSshConfig(this.store.paths.sshDir)).some((e) => e.alias === id);
  }

  get(id: string): HostHandle {
    let h = this.handles.get(id);
    if (h) return h;
    if (id === LOCAL_HOST_ID) {
      h = { id, kind: 'local', platform: this.localFs.platform, fs: this.localFs };
    } else {
      if (!this.exists(id)) throw new DeckError('nohost', `Servidor "${id}" não existe no ~/.ssh/config.`);
      const ssh = new SshHost(id, { prompts: this.prompts, sshDir: this.store.paths.sshDir, log: this.log });
      ssh.on('state', (state: string, error?: string) => {
        const cur = this.statuses.get(id) ?? { id, state: 'idle' };
        if (state === 'ready') this.updateStatus(id, { ...cur, state: 'ready', error: undefined });
        else if (state === 'error') this.updateStatus(id, { ...cur, state: 'error', error });
        else if (state === 'connecting') this.updateStatus(id, { ...cur, state: cur.state === 'error' || cur.state === 'idle' ? 'connecting' : 'reconnecting' });
        else if (state === 'idle') this.updateStatus(id, { ...cur, state: 'idle' });
      });
      ssh.on('conn-closed', () => this.emit('conn-closed', id));
      h = { id, kind: 'ssh', platform: 'posix', fs: new SftpFs(ssh), ssh };
    }
    this.handles.set(id, h);
    return h;
  }

  /** Alias não é identidade física: aliases do mesmo endpoint compartilham guardas de cópia. */
  copyIdentity(id: string): string {
    if (id === LOCAL_HOST_ID) return 'local';
    if (!this.exists(id)) throw new DeckError('nohost', 'Servidor desconhecido.');
    const r = resolveHost(loadSshConfig(this.store.paths.sshDir), id, this.store.paths.sshDir);
    return JSON.stringify([r.hostName.toLowerCase(), r.user, r.port]);
  }

  status(id: string): HostStatus {
    const st = this.statuses.get(id) ?? { id, state: 'idle' };
    const h = this.handles.get(id);
    if (h?.ssh) return { ...st, channels: h.ssh.channelCount, connections: h.ssh.connectionCount };
    return st;
  }

  allStatuses(): HostStatus[] {
    return [...this.statuses.keys()].map((id) => this.status(id));
  }

  private updateStatus(id: string, st: HostStatus) {
    this.statuses.set(id, st);
    this.emit('status', this.status(id));
  }

  /**
   * Conecta, descobre a pasta pessoal e acha o Claude. Só LÊ o servidor: nada é gravado
   * (o runner só é copiado quando uma conversa é iniciada nele — ver ensureRunner).
   */
  connect(id: string, force = false): Promise<HostStatus> {
    if (id === LOCAL_HOST_ID) return Promise.resolve(this.connectLocal());
    const cur = this.statuses.get(id);
    const h = this.get(id);
    if (!force && cur?.state === 'ready' && cur.home && h.ssh?.connected) return Promise.resolve(this.status(id));
    const pending = this.connecting.get(id);
    if (pending) return pending;
    const p = (async () => {
      const ssh = h.ssh!;
      await ssh.ensure();
      const probe = await ssh.run(
        `printf 'HOME=%s\\n' "$HOME"; uname -s | sed 's/^/OS=/'; [ -f "$HOME/${RUNNER_REL}" ] && echo RUNNER=ok || echo RUNNER=missing`,
        { timeoutMs: 20_000 },
      );
      const home = probe.stdout.match(/^HOME=(.*)$/m)?.[1]?.trim();
      if (!home) throw new DeckError('ssh', `Não consegui ler a pasta pessoal em ${id}: ${probe.stderr.trim() || 'sem resposta'}`);
      const osName = probe.stdout.match(/^OS=(.*)$/m)?.[1]?.trim() ?? '';
      if (/MINGW|MSYS|CYGWIN|Windows/i.test(osName)) throw new DeckError('unsupported', `${id} é Windows; só servidores Linux/macOS são suportados.`);
      if (/RUNNER=ok/.test(probe.stdout)) this.runnerReady.add(id);
      else this.runnerReady.delete(id);
      const bins = await this.remoteBins(id);
      const override = this.store.settings.hostClaudePath[id];
      const chosen = override ? { path: override, version: bins.find((b) => b.path === override)?.version ?? '?' } : bins[0] ?? null;
      const st: HostStatus = {
        ...this.status(id),
        id,
        state: 'ready',
        error: undefined,
        platform: 'posix',
        home,
        claude: chosen,
        claudeCandidates: bins,
      };
      this.updateStatus(id, st);
      return this.status(id);
    })()
      .catch((e) => {
        const st: HostStatus = { ...(this.statuses.get(id) ?? { id }), id, state: 'error', error: h.ssh?.lastError ?? e.message };
        this.updateStatus(id, st);
        throw new DeckError('ssh', st.error!);
      })
      .finally(() => this.connecting.delete(id));
    this.connecting.set(id, p);
    return p;
  }

  private connectLocal(): HostStatus {
    const bins = findLocalClaude(this.store.settings.localClaudePath || undefined);
    const st: HostStatus = {
      id: LOCAL_HOST_ID,
      state: 'ready',
      platform: this.localFs.platform,
      home: os.homedir(),
      claude: bins[0] ? { path: bins[0].path, version: bins[0].version } : null,
      claudeCandidates: bins.map((b) => ({ path: b.path, version: b.version })),
    };
    this.updateStatus(LOCAL_HOST_ID, st);
    return st;
  }

  /**
   * Copia o runner para ~/.cache/claude-deck (só quando uma conversa vai rodar no servidor)
   * e remove versões antigas dele e sessões mortas há mais de 2 dias.
   */
  ensureRunner(id: string): Promise<void> {
    if (id === LOCAL_HOST_ID || this.runnerReady.has(id)) return Promise.resolve();
    const pending = this.installing.get(id);
    if (pending) return pending;
    const p = (async () => {
      const ssh = this.get(id).ssh!;
      const up = await ssh.run(
        `mkdir -p "$HOME/.cache/claude-deck" && chmod 700 "$HOME/.cache/claude-deck" && ` +
          `cat > "$HOME/${RUNNER_REL}.tmp" && chmod 700 "$HOME/${RUNNER_REL}.tmp" && mv "$HOME/${RUNNER_REL}.tmp" "$HOME/${RUNNER_REL}" && echo OK`,
        { input: runnerScript, timeoutMs: 20_000 },
      );
      if (!/OK/.test(up.stdout)) throw new DeckError('ssh', `Falha ao instalar o executor em ${id}: ${up.stderr.trim() || 'sem resposta'}`);
      this.runnerReady.add(id);
      this.log(`[${id}] runner ${RUNNER_NAME} instalado em ~/.cache/claude-deck`);
      ssh
        .run(`cd "$HOME/.cache/claude-deck" && for f in runner-*.sh; do [ "$f" = "${RUNNER_NAME}" ] || rm -f "$f"; done; sh "$HOME/${RUNNER_REL}" gc >/dev/null 2>&1`)
        .catch(() => {});
    })().finally(() => this.installing.delete(id));
    this.installing.set(id, p);
    return p;
  }

  /**
   * Teste de conexão sem interação (não pede senha nem confirma chave nova) e só de leitura.
   * Se o servidor não estava conectado antes, desconecta no fim.
   */
  async check(id: string): Promise<{ ok: boolean; ms: number; error?: string; claude?: { path: string; version: string } | null }> {
    const h = this.get(id);
    if (!h.ssh) return { ok: true, ms: 0 };
    const ssh = h.ssh;
    const wasConnected = ssh.connected;
    ssh.interactive = false;
    const t0 = Date.now();
    try {
      const st = await this.connect(id, true);
      return { ok: true, ms: Date.now() - t0, claude: st.claude ?? null };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: (e as Error).message };
    } finally {
      ssh.interactive = true;
      // Conectou só para o teste: fecha, mas guarda o que descobriu. Se falhou, o erro fica visível.
      if (!wasConnected && ssh.connected) this.disconnect(id, true);
    }
  }

  /** Lista os binários do Claude no servidor (maior versão primeiro), sem gravar nada lá. */
  async remoteBins(id: string): Promise<{ path: string; version: string }[]> {
    const ssh = this.get(id).ssh!;
    // O script do runner vai pela entrada padrão ("sh -s bins"): funciona antes de instalar.
    const r = await ssh.run(`exec "\${SHELL:-/bin/sh}" -lc 'sh -s bins'`, { input: runnerScript, timeoutMs: 30_000 });
    const bins = r.stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p) => p.length >= 2 && p[1].startsWith('/'))
      .map(([version, p]) => ({ path: p.trim(), version: version.trim() || '?' }));
    const cmp = (a: string, b: string) => {
      const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
      const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      return 0;
    };
    return bins.sort((a, b) => cmp(a.version, b.version));
  }

  disconnect(id: string, keepInfo = false) {
    const h = this.handles.get(id);
    if (h?.ssh) {
      h.ssh.close();
      this.prompts.cancelHost(id);
      const cur = this.statuses.get(id);
      // keepInfo: mantém o que já se sabe (pasta pessoal, Claude) para a interface.
      this.updateStatus(id, keepInfo && cur ? { ...cur, state: 'idle', error: undefined } : { id, state: 'idle' });
    }
  }

  /** Após o notebook acordar: testa as conexões e derruba as mortas rapidamente. */
  async probeAll() {
    await Promise.all(
      [...this.handles.values()].filter((h) => h.ssh?.connected).map((h) => h.ssh!.probe().catch(() => false)),
    );
  }

  closeAll() {
    for (const h of this.handles.values()) h.ssh?.close();
  }
}
