// Conexões SSH embutidas (biblioteca ssh2): UMA conexão por servidor, com vários canais dentro
// (cada conversa, o navegador de arquivos e comandos curtos). Se o servidor recusar mais canais
// (MaxSessions do sshd, padrão 10), abre uma segunda conexão automaticamente.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { Client as SshClient, ClientChannel, SFTPWrapper, ConnectConfig, AuthenticationType } from 'ssh2';
import { loadSshConfig, resolveHost, type ResolvedHost } from './sshconfig';
import {
  addKnownHost,
  fingerprintSha256,
  keyTypeOf,
  lookupKnownKeys,
  preferredHostKeyAlgorithms,
  verifyWithPortFallback,
} from './knownhosts';
import type { PromptBroker } from '../prompts';
import { DeckError } from '../../shared/protocol';

const { Client, utils } = ssh2 as unknown as { Client: typeof SshClient; utils: typeof import('ssh2').utils };

const MAX_CHANNELS_PER_CONN = 8;
const passphraseCache = new Map<string, string>();

export interface SshDeps {
  prompts: PromptBroker;
  sshDir: string;
  log: (msg: string) => void;
}

interface Conn {
  id: number;
  client: SshClient;
  /** Canais abertos + aberturas em andamento (reservadas na hora da escolha, sem corrida). */
  channels: number;
  /** Limite desta conexão: começa em MAX_CHANNELS_PER_CONN e baixa se o servidor recusar antes. */
  limit: number;
  sftp?: Promise<SFTPWrapper>;
  alive: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let connSeq = 0;

export class SshHost extends EventEmitter {
  private conns: Conn[] = [];
  private connecting: Promise<Conn> | null = null;
  private password: string | null = null;
  resolved: ResolvedHost | null = null;
  lastError: string | null = null;
  /** Falso durante verificações automáticas: nunca pede senha nem confirmação. */
  interactive = true;

  constructor(
    public alias: string,
    private deps: SshDeps,
  ) {
    super();
  }

  private ask(p: Parameters<PromptBroker['ask']>[0]) {
    if (!this.interactive) return Promise.resolve({ ok: false } as const);
    return this.deps.prompts.ask(p);
  }

  get connected(): boolean {
    return this.conns.some((c) => c.alive);
  }

  get channelCount(): number {
    return this.conns.reduce((n, c) => n + (c.alive ? c.channels : 0), 0);
  }

  get connectionCount(): number {
    return this.conns.filter((c) => c.alive).length;
  }

  /** Garante uma conexão pronta (reaproveita a existente). */
  async ensure(): Promise<void> {
    // Só precisa de uma conexão viva (mesmo cheia): não abre outra à toa.
    await this.pick(false);
  }

  /** Limite de canais aprendido deste servidor (MaxSessions do sshd), para as próximas conexões. */
  private learnedLimit = MAX_CHANNELS_PER_CONN;

  private async pick(excludeFull = true): Promise<Conn> {
    const alive = this.conns.filter((c) => c.alive);
    const withRoom = alive.filter((c) => !excludeFull || c.channels < c.limit).sort((a, b) => a.channels - b.channels);
    if (withRoom.length) return withRoom[0];
    if (this.connecting) return this.connecting;
    const isFirst = alive.length === 0;
    this.connecting = this.connectOne()
      .then((c) => {
        this.conns.push(c);
        this.lastError = null;
        if (isFirst) this.emit('state', 'ready');
        return c;
      })
      .catch((e) => {
        this.lastError = e?.message ?? String(e);
        if (isFirst) this.emit('state', 'error', this.lastError);
        throw e;
      })
      .finally(() => {
        this.connecting = null;
      });
    if (isFirst) this.emit('state', 'connecting');
    return this.connecting;
  }

  private readKeys(cfg: ResolvedHost): { file: string; data: Buffer }[] {
    const out: { file: string; data: Buffer }[] = [];
    for (const f of cfg.identityFiles) {
      try {
        const st = fs.statSync(f);
        if (st.isFile() && st.size < 64 * 1024) out.push({ file: f, data: fs.readFileSync(f) });
      } catch {
        /* chave inexistente: ignorada, como o OpenSSH faz */
      }
    }
    return out;
  }

  private connectOne(): Promise<Conn> {
    const cfg = resolveHost(loadSshConfig(this.deps.sshDir), this.alias, this.deps.sshDir);
    this.resolved = cfg;
    if (cfg.proxyJump) {
      return Promise.reject(new DeckError('unsupported', `ProxyJump (${cfg.proxyJump}) ainda não é suportado pelo Claude Deck.`));
    }
    const keyHost = cfg.hostKeyAlias ?? cfg.hostName;
    const known = lookupKnownKeys(cfg.userKnownHostsFiles, keyHost, cfg.port);
    // Porta diferente de 22: o OpenSSH também confere a entrada sem porta (ver verifyWithPortFallback).
    const knownBare = cfg.port !== 22 && !cfg.hostKeyAlias ? lookupKnownKeys(cfg.userKnownHostsFiles, keyHost, 22) : [];
    const keys = this.readKeys(cfg);
    const { log } = this.deps;
    const prompts = { ask: (p: Parameters<PromptBroker['ask']>[0]) => this.ask(p) };
    const alias = this.alias;
    let usedPassword: string | null = null;

    // Fila de tentativas de autenticação (chaves primeiro, depois senha/teclado interativo).
    const keyQueue = [...keys];
    let triedKeyboard = false;
    let triedPassword = false;
    /** Sem interação, o servidor aceitaria senha mas ela não foi tentada. */
    let skippedPassword = false;
    /** Motivo da recusa da chave do servidor (mostrado no lugar do erro genérico do ssh2). */
    let hostKeyError: string | null = null;

    const nextKey = async (): Promise<Record<string, unknown> | null> => {
      while (keyQueue.length) {
        const k = keyQueue.shift()!;
        let parsed = utils.parseKey(k.data, passphraseCache.get(k.file));
        if (parsed instanceof Error && /encrypted|passphrase/i.test(parsed.message)) {
          const ans = await prompts.ask({
            hostId: alias,
            kind: 'passphrase',
            title: `Frase da chave ${path.basename(k.file)}`,
            message: `A chave ${k.file} é protegida por senha. Digite a frase para conectar em ${alias}.`,
          });
          if (!ans.ok) continue;
          parsed = utils.parseKey(k.data, ans.values[0]);
          if (!(parsed instanceof Error)) passphraseCache.set(k.file, ans.values[0]);
        }
        if (parsed instanceof Error) {
          log(`[${alias}] chave ${path.basename(k.file)} ignorada: ${parsed.message}`);
          continue;
        }
        const key = Array.isArray(parsed) ? parsed[0] : parsed;
        return { type: 'publickey', username: cfg.user, key };
      }
      return null;
    };

    const askPassword = async (): Promise<string | null> => {
      if (this.password) return this.password;
      const ans = await prompts.ask({
        hostId: alias,
        kind: 'password',
        title: `Senha de ${cfg.user}@${alias}`,
        message: `O servidor ${alias} pediu senha para o usuário ${cfg.user}.`,
      });
      return ans.ok ? ans.values[0] : null;
    };

    return new Promise<Conn>((resolve, reject) => {
      const client = new Client();
      const conn: Conn = { id: ++connSeq, client, channels: 0, limit: this.learnedLimit, alive: false };
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          /* já fechado */
        }
        reject(e);
      };

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        conn.alive = true;
        // Sem isso o TCP segura pacotes pequenos (algoritmo de Nagle + ACK atrasado): cada ida e
        // volta pelo SSH custava ~50 ms a mais. Medido no servidor de teste: stat SFTP 53 ms → 5–9 ms.
        client.setNoDelay(true);
        if (usedPassword) this.password = usedPassword;
        log(`[${alias}] conectado (conexão #${conn.id})`);
        resolve(conn);
      });
      client.on('error', (e: Error & { level?: string }) => {
        const msg = /Host denied|verification failed/i.test(e.message) && hostKeyError
          ? hostKeyError
          : /All configured authentication methods failed/i.test(e.message)
          ? skippedPassword
            ? 'Este servidor pede senha (o teste automático não tenta senhas; ao conectar normalmente o app pergunta).'
            : 'Autenticação recusada pelo servidor (nenhuma chave/senha aceita).'
          : /Timed out while waiting for handshake|ETIMEDOUT/i.test(e.message)
            ? 'Tempo esgotado ao conectar (servidor inacessível desta rede?).'
            : /ENOTFOUND|EAI_AGAIN/i.test(e.message)
              ? 'Nome do servidor não encontrado (DNS).'
              : /ECONNREFUSED/i.test(e.message)
                ? 'Conexão recusada (porta SSH fechada).'
                : /EHOSTUNREACH|ENETUNREACH/i.test(e.message)
                  ? 'Servidor inacessível desta rede.'
                  : e.message;
        if (!settled) fail(new DeckError('ssh', msg));
        else log(`[${alias}] erro na conexão #${conn.id}: ${e.message}`);
      });
      client.on('close', () => {
        const wasAlive = conn.alive;
        conn.alive = false;
        this.conns = this.conns.filter((c) => c !== conn);
        if (!settled) fail(new DeckError('ssh', 'Conexão encerrada durante o login.'));
        if (wasAlive) {
          log(`[${alias}] conexão #${conn.id} caiu`);
          this.emit('conn-closed', conn.id);
          if (!this.connected) this.emit('state', 'idle');
        }
      });

      const config: ConnectConfig = {
        host: cfg.hostName,
        port: cfg.port,
        username: cfg.user,
        readyTimeout: (cfg.connectTimeout ?? 20) * 1000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        algorithms: {
          serverHostKey: [...preferredHostKeyAlgorithms(known.length ? known : knownBare), 'ssh-dss'] as any,
          kex: { append: ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] } as any,
          cipher: { append: ['aes256-cbc', 'aes192-cbc', 'aes128-cbc'] } as any,
        },
        hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
          const verdict = verifyWithPortFallback(known, knownBare, key);
          const fp = fingerprintSha256(key);
          const type = keyTypeOf(key);
          if (verdict.kind === 'ok') return verify(true);
          if (verdict.kind === 'revoked') {
            this.lastError = hostKeyError = 'A chave deste servidor está revogada no known_hosts.';
            return verify(false);
          }
          if (verdict.kind === 'mismatch') {
            if (cfg.strictHostKeyChecking === 'no') {
              log(`[${alias}] ATENÇÃO: chave do servidor mudou (StrictHostKeyChecking=no, conectando mesmo assim)`);
              return verify(true);
            }
            this.lastError = hostKeyError =
              `A CHAVE DO SERVIDOR MUDOU (${type} ${fp}). Pode ser reinstalação do servidor ou um ataque. ` +
              `Confira e, se estiver certo, remova a linha antiga com: ssh-keygen -R "${keyHost}${cfg.port === 22 ? '' : `:${cfg.port}`}"`;
            return verify(false);
          }
          // Chave desconhecida.
          const file = cfg.userKnownHostsFiles.find((f) => !/^(\/dev\/null|nul)$/i.test(f));
          if (cfg.strictHostKeyChecking === 'no' || cfg.strictHostKeyChecking === 'accept-new') {
            if (file && cfg.strictHostKeyChecking === 'accept-new') {
              try {
                addKnownHost(file, keyHost, cfg.port, key);
              } catch (e) {
                log(`[${alias}] não consegui gravar o known_hosts: ${(e as Error).message}`);
              }
            }
            return verify(true);
          }
          if (cfg.strictHostKeyChecking === 'yes') {
            this.lastError = hostKeyError = `Servidor desconhecido e StrictHostKeyChecking=yes (${type} ${fp}).`;
            return verify(false);
          }
          if (!this.interactive) {
            this.lastError = hostKeyError = 'Primeira conexão: a chave deste servidor ainda não está no known_hosts. Conecte uma vez normalmente para conferir e aceitar.';
            return verify(false);
          }
          prompts
            .ask({
              hostId: alias,
              kind: 'hostkey',
              title: `Confiar em ${alias}?`,
              message: `Primeira conexão com ${alias} (${keyHost}:${cfg.port}). Confira a impressão digital da chave do servidor antes de aceitar.`,
              fingerprint: fp,
              keyType: type,
            })
            .then((ans) => {
              if (ans.ok && file) {
                try {
                  addKnownHost(file, keyHost, cfg.port, key);
                } catch (e) {
                  log(`[${alias}] não consegui gravar o known_hosts: ${(e as Error).message}`);
                }
              }
              if (!ans.ok) this.lastError = hostKeyError = 'Chave do servidor não aceita.';
              verify(ans.ok);
            });
        }) as any,
        authHandler: ((methodsLeft: AuthenticationType[] | null, _partial: boolean | null, cb: (r: any) => void) => {
          const allowed = methodsLeft ?? ['publickey', 'keyboard-interactive', 'password'];
          (async () => {
            if (allowed.includes('publickey')) {
              const r = await nextKey();
              if (r) return cb(r);
            }
            // Sem interação (ex.: "Testar todos"), como o BatchMode do OpenSSH: só chaves (ou a senha
            // já digitada nesta execução). Nunca manda resposta vazia — isso conta como senha errada
            // no servidor (fail2ban, alertas de login).
            if (!this.interactive && !this.password && (allowed.includes('keyboard-interactive') || allowed.includes('password'))) skippedPassword = true;
            if (!triedKeyboard && allowed.includes('keyboard-interactive') && (this.interactive || this.password)) {
              triedKeyboard = true;
              return cb({
                type: 'keyboard-interactive',
                username: cfg.user,
                prompt: (_name: string, instructions: string, _lang: string, qs: { prompt: string; echo: boolean }[], finish: (a: string[]) => void) => {
                  if (!qs.length) return finish([]);
                  if (qs.length === 1 && !qs[0].echo && /password|senha/i.test(qs[0].prompt) && this.password) {
                    usedPassword = this.password;
                    return finish([this.password]);
                  }
                  prompts
                    .ask({
                      hostId: alias,
                      kind: 'keyboard',
                      title: `Login em ${alias}`,
                      message: instructions || `O servidor ${alias} pediu:`,
                      prompts: qs.map((q) => ({ prompt: q.prompt, echo: q.echo })),
                    })
                    .then((ans) => {
                      if (!ans.ok) {
                        // Cancelado (ou teste sem interação): encerra em vez de mandar resposta vazia,
                        // que o servidor contaria como senha errada.
                        const m = this.interactive
                          ? 'Login cancelado.'
                          : 'Este servidor pede senha ou código (o teste automático não tenta; ao conectar normalmente o app pergunta).';
                        this.lastError = m;
                        fail(new DeckError('ssh', m));
                        return;
                      }
                      if (qs.length === 1 && !qs[0].echo) usedPassword = ans.values[0];
                      finish(ans.values);
                    });
                },
              });
            }
            if (!triedPassword && allowed.includes('password')) {
              triedPassword = true;
              const pw = await askPassword();
              if (pw) {
                usedPassword = pw;
                return cb({ type: 'password', username: cfg.user, password: pw });
              }
            }
            cb(false);
          })().catch(() => cb(false));
        }) as any,
      };
      try {
        client.connect(config);
      } catch (e) {
        fail(e as Error);
      }
    });
  }

  /**
   * Abre um canal numa conexão cuja vaga JÁ foi reservada (conn.channels++ feito por quem chamou,
   * de forma síncrona na escolha): muitas aberturas ao mesmo tempo não escolhem a mesma conexão.
   * A vaga é devolvida quando o canal fecha, ou na hora se a abertura falhar.
   */
  private openOn(conn: Conn, cmd: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        conn.channels = Math.max(0, conn.channels - 1);
      };
      // Conexão meio morta (sem resposta do servidor): não deixa a abertura pendurada para sempre.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        release();
        reject(new DeckError('timeout', `O servidor ${this.alias} não respondeu ao abrir um canal.`));
      }, 20_000);
      try {
        conn.client.exec(cmd, (err, ch) => {
          if (settled) {
            // Chegou depois do tempo esgotado: fecha para não vazar.
            ch?.close();
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (err) {
            release();
            return reject(err);
          }
          let closed = false;
          ch.on('close', () => {
            if (closed) return;
            closed = true;
            release();
          });
          resolve(ch);
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        release();
        reject(e);
      }
    });
  }

  private openShellOn(conn: Conn, opts: { term?: string; cols?: number; rows?: number }): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        conn.channels = Math.max(0, conn.channels - 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        release();
        reject(new DeckError('timeout', `O servidor ${this.alias} não respondeu ao abrir um shell.`));
      }, 20_000);
      try {
        conn.client.shell(
          {
            term: opts.term ?? 'xterm-256color',
            cols: opts.cols ?? 80,
            rows: opts.rows ?? 24,
          },
          (err, ch) => {
            if (settled) {
              ch?.close();
              return;
            }
            settled = true;
            clearTimeout(timer);
            if (err) {
              release();
              return reject(err);
            }
            let closed = false;
            ch.on('close', () => {
              if (closed) return;
              closed = true;
              release();
            });
            resolve(ch);
          },
        );
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        release();
        reject(e);
      }
    });
  }

  /** Reserva uma vaga de canal (a contagem sobe na hora, antes de qualquer espera). */
  private async reserve(): Promise<Conn> {
    for (;;) {
      const conn = await this.pick();
      // Enquanto esperava, outras aberturas podem ter ocupado a conexão: confere de novo e, se
      // cheia (ou morta), volta — o pick seguinte acha outra com vaga ou abre uma nova.
      if (conn.alive && conn.channels < conn.limit) {
        conn.channels++;
        return conn;
      }
    }
  }

  /** Abre um canal de execução (outra conexão é aberta se o servidor recusar mais canais). */
  async exec(cmd: string): Promise<ClientChannel> {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.reserve();
      try {
        return await this.openOn(conn, cmd);
      } catch (e) {
        if (!/open failed|Channel open failure/i.test((e as Error).message) || attempt >= 3) throw e;
        // O servidor limita canais por conexão (MaxSessions): esta conexão já está no máximo que
        // ele aceita. Guarda o limite real (para esta e as próximas) e tenta noutra conexão.
        const real = Math.max(1, conn.channels);
        conn.limit = Math.min(conn.limit, real);
        this.learnedLimit = Math.min(this.learnedLimit, Math.max(real, 2));
        this.deps.log(`[${this.alias}] servidor limita ${real} canais por conexão; usando outra conexão`);
      }
    }
  }

  /** Abre um shell interativo com PTY no servidor. */
  async shell(opts: { term?: string; cols?: number; rows?: number } = {}): Promise<ClientChannel> {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.reserve();
      try {
        return await this.openShellOn(conn, opts);
      } catch (e) {
        if (!/open failed|Channel open failure/i.test((e as Error).message) || attempt >= 3) throw e;
        const real = Math.max(1, conn.channels);
        conn.limit = Math.min(conn.limit, real);
        this.learnedLimit = Math.min(this.learnedLimit, Math.max(real, 2));
        this.deps.log(`[${this.alias}] servidor limita ${real} canais por conexão; tentando noutra conexão para shell`);
      }
    }
  }

  /** Executa um comando curto e devolve a saída. */
  async run(cmd: string, opts: { input?: string | Buffer; timeoutMs?: number; maxBytes?: number } = {}): Promise<RunResult> {
    const ch = await this.exec(cmd);
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let code: number | null = null;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            ch.close();
            reject(new DeckError('timeout', `Tempo esgotado executando comando em ${this.alias}`));
          }, opts.timeoutMs)
        : null;
      ch.on('data', (d: Buffer) => {
        size += d.length;
        if (size <= max) out.push(d);
      });
      ch.stderr.on('data', (d: Buffer) => {
        if (err.reduce((n, b) => n + b.length, 0) < 1024 * 1024) err.push(d);
      });
      ch.on('exit', (c: number | null) => {
        code = c;
      });
      ch.on('close', () => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
      if (opts.input !== undefined) ch.end(opts.input);
      else ch.end();
    });
  }

  /** SFTP compartilhado da conexão (uma sessão SFTP por conexão). */
  private sftpOpening: Promise<SFTPWrapper> | null = null;

  async sftp(): Promise<SFTPWrapper> {
    // Reaproveita o SFTP que já existir em qualquer conexão viva; aberturas simultâneas viram uma.
    const existing = this.conns.find((c) => c.alive && c.sftp);
    if (existing) return existing.sftp!;
    if (this.sftpOpening) return this.sftpOpening;
    this.sftpOpening = (async () => {
      const conn = await this.reserve();
      const p = new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          conn.channels = Math.max(0, conn.channels - 1);
          if (conn.sftp === p) conn.sftp = undefined;
          reject(err);
        };
        const timer = setTimeout(() => fail(new DeckError('timeout', `O servidor ${this.alias} não respondeu ao abrir o SFTP.`)), 20_000);
        try {
          conn.client.sftp((err, s) => {
            if (settled) {
              // Chegou depois do tempo esgotado: fecha para não vazar.
              s?.end();
              return;
            }
            if (err) return fail(err);
            settled = true;
            clearTimeout(timer);
            s.on('close', () => {
              conn.channels = Math.max(0, conn.channels - 1);
              if (conn.sftp === p) conn.sftp = undefined;
            });
            resolve(s);
          });
        } catch (e) {
          fail(e as Error);
        }
      });
      conn.sftp = p;
      return p;
    })().finally(() => {
      this.sftpOpening = null;
    });
    return this.sftpOpening;
  }

  /** Verifica se as conexões seguem vivas (após o notebook acordar, por exemplo). */
  async probe(timeoutMs = 8000): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const r = await this.run('true', { timeoutMs });
      return r.code === 0;
    } catch {
      for (const c of this.conns) {
        try {
          c.client.end();
          c.client.destroy?.();
        } catch {
          /* ignora */
        }
      }
      return false;
    }
  }

  /** Derruba as conexões (usado nos testes de queda de rede e ao desconectar). */
  close() {
    for (const c of this.conns) {
      try {
        c.client.end();
      } catch {
        /* ignora */
      }
    }
  }

  /** Simula queda abrupta (sem despedida educada), para testes. */
  destroyForTest() {
    for (const c of this.conns) {
      try {
        (c.client as any)._sock?.destroy();
      } catch {
        /* ignora */
      }
    }
  }
}
