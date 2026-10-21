// Pastas do app, configurações e estado persistido (JSON em %APPDATA%\claude-deck).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, MAX_PINS_PER_CONVERSATION, PIN_SNIPPET_MAX, type ManualPendingConversation, type PinnedMessage, type SessionCapabilities, type Settings, type UiState } from '../shared/types';
import type { WindowMap } from './windows';

export interface AppPaths {
  dataDir: string;
  settingsFile: string;
  stateFile: string;
  tokenFile: string;
  browserFile: string;
  hostsFile: string;
  sessionsFile: string;
  historyCacheFile: string;
  logFile: string;
  sshDir: string;
  claudeDir: string;
}

export function resolvePaths(dataDirOverride?: string): AppPaths {
  const base = dataDirOverride || process.env.CLAUDE_DECK_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'claude-deck');
  fs.mkdirSync(base, { recursive: true });
  return {
    dataDir: base,
    settingsFile: path.join(base, 'settings.json'),
    stateFile: path.join(base, 'state.json'),
    tokenFile: path.join(base, 'token'),
    browserFile: path.join(base, 'browser.json'),
    hostsFile: path.join(base, 'hosts.json'),
    sessionsFile: path.join(base, 'sessions.json'),
    historyCacheFile: path.join(base, 'history-cache.json'),
    logFile: path.join(base, 'server.log'),
    sshDir: process.env.CLAUDE_DECK_SSH_DIR || path.join(os.homedir(), '.ssh'),
    claudeDir: process.env.CLAUDE_DECK_CLAUDE_DIR || path.join(os.homedir(), '.claude'),
  };
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Grava JSON de forma atômica (arquivo temporário + rename). */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Token de acesso da interface (criado na primeira execução). */
export function loadOrCreateToken(paths: AppPaths): string {
  try {
    const t = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(t)) return t;
  } catch {
    /* cria abaixo */
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(paths.tokenFile, t, { encoding: 'utf8', mode: 0o600 });
  return t;
}

/** Dados que o app guarda por servidor (favoritos e pastas recentes). */
export interface HostPrefs {
  favorites: string[];
  recentFolders: Record<string, string[]>;
  archivedSessions: string[];
  /** Conversas que o usuário decidiu revisitar; chave composta de servidor e sessão, com a pasta como metadado. */
  manualPending: Record<string, ManualPendingConversation>;
  /** Mensagens fixadas, por conversa (chave composta de servidor e sessão). Só marcadores de leitura. */
  pins: Record<string, PinnedMessage[]>;
  importedFromVscode?: boolean;
  /** Últimos modelos e comandos informados pelo CLI de cada servidor (a lista existe já ao abrir o app). */
  caps?: Record<string, Pick<SessionCapabilities, 'models' | 'commands'>>;
}

/** A identidade da conversa é servidor + sessão; `cwd` é metadado para localizar o transcript. */
export function manualPendingKey({ hostId, sessionId }: ManualPendingConversation): string {
  return JSON.stringify([hostId, sessionId]);
}

function isManualPendingConversation(value: unknown): value is ManualPendingConversation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ManualPendingConversation>;
  return (
    typeof record.hostId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.cwd === 'string' &&
    record.hostId.length > 0 &&
    record.sessionId.length > 0 &&
    record.cwd.length > 0
  );
}

/** Aceita hosts.json antigo (sem a chave) e descarta entradas corrompidas antes de expô-las. */
function readManualPending(value: unknown): Record<string, ManualPendingConversation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: Record<string, ManualPendingConversation> = {};
  for (const item of Object.values(value)) {
    if (!isManualPendingConversation(item)) continue;
    records[manualPendingKey(item)] = { hostId: item.hostId, sessionId: item.sessionId, cwd: item.cwd };
  }
  return records;
}

/** A âncora é o uuid da linha do transcript, com `#n` opcional para o n-ésimo bloco de texto da mesma linha. */
export const PIN_ANCHOR = /^[\w.:#-]{1,100}$/;

export function pinsKey({ hostId, sessionId }: { hostId: string; sessionId: string }): string {
  return JSON.stringify([hostId, sessionId]);
}

function isPinnedMessage(value: unknown): value is PinnedMessage {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PinnedMessage>;
  return (
    typeof p.hostId === 'string' &&
    p.hostId.length > 0 &&
    typeof p.sessionId === 'string' &&
    p.sessionId.length > 0 &&
    typeof p.anchor === 'string' &&
    PIN_ANCHOR.test(p.anchor) &&
    (p.role === 'user' || p.role === 'assistant') &&
    typeof p.snippet === 'string' &&
    typeof p.pinnedAt === 'number' &&
    Number.isFinite(p.pinnedAt)
  );
}

/** Aceita hosts.json antigo (sem a chave) e descarta entradas corrompidas ou repetidas antes de expô-las. */
function readPins(value: unknown): Record<string, PinnedMessage[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, PinnedMessage[]> = {};
  for (const list of Object.values(value)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isPinnedMessage(item)) continue;
      const key = pinsKey(item);
      const bucket = (out[key] ??= []);
      if (bucket.length >= MAX_PINS_PER_CONVERSATION || bucket.some((x) => x.anchor === item.anchor)) continue;
      bucket.push({
        hostId: item.hostId,
        sessionId: item.sessionId,
        anchor: item.anchor,
        role: item.role,
        snippet: item.snippet.slice(0, PIN_SNIPPET_MAX),
        ...(typeof item.at === 'number' && Number.isFinite(item.at) ? { at: item.at } : {}),
        pinnedAt: item.pinnedAt,
      });
    }
  }
  return out;
}

/** Formato do state.json: o estado de tela de cada janela do app, por id de janela. */
interface StateFile {
  version?: number;
  windows?: WindowMap;
  aliases?: Record<string, string>;
  // Formato antigo (uma janela só): abas e layout soltos na raiz.
  chatTabs?: unknown;
  fileTabs?: unknown;
}

export class Store {
  settings: Settings;
  /** Estado de tela por janela (abas, pasta aberta, arquivos). */
  windows: WindowMap;
  /** Ids de janelas antigas que foram juntadas a outra (id antigo → id atual). */
  aliases: Record<string, string> = {};
  /** 1 = janelas por pasta podendo repetir (antigo); 2 = uma janela por servidor+pasta. */
  stateVersion = 1;
  hosts: HostPrefs;
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(public paths: AppPaths) {
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(paths.settingsFile, {}) };
    const raw = readJson<StateFile>(paths.stateFile, {});
    if (raw.aliases && typeof raw.aliases === 'object') this.aliases = raw.aliases;
    if (typeof raw.version === 'number') this.stateVersion = raw.version;
    if (raw.windows && typeof raw.windows === 'object') {
      this.windows = raw.windows;
      for (const w of Object.values(this.windows)) {
        if (!Array.isArray(w.state?.chatTabs)) w.state = { ...(w.state ?? {}), chatTabs: [], fileTabs: [] };
        if (!Array.isArray(w.state.fileTabs)) w.state.fileTabs = [];
      }
    } else {
      // Migra o formato antigo: vira uma janela salva, que o próximo início restaura.
      this.windows = {};
      if (Array.isArray(raw.chatTabs) || Array.isArray(raw.fileTabs)) {
        const old = raw as unknown as UiState;
        this.windows[crypto.randomUUID()] = {
          state: { ...old, chatTabs: Array.isArray(old.chatTabs) ? old.chatTabs : [], fileTabs: Array.isArray(old.fileTabs) ? old.fileTabs : [] },
          updatedAt: Date.now(),
        };
      }
    }
    const rawHosts = readJson<Partial<HostPrefs>>(paths.hostsFile, {});
    this.hosts = {
      favorites: [],
      recentFolders: {},
      archivedSessions: [],
      ...rawHosts,
      // Não deixa um hosts.json de versão anterior (ou parcialmente gravado) virar erro no RPC.
      manualPending: readManualPending(rawHosts.manualPending),
      pins: readPins(rawHosts.pins),
    };
  }

  private scheduleSave(key: string, file: string, get: () => unknown) {
    const t = this.saveTimers.get(key);
    if (t) clearTimeout(t);
    this.saveTimers.set(
      key,
      setTimeout(() => {
        this.saveTimers.delete(key);
        try {
          writeJsonAtomic(file, get());
        } catch (e) {
          console.error(`falha ao gravar ${file}:`, e);
        }
      }, 300),
    );
  }

  setSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.scheduleSave('settings', this.paths.settingsFile, () => this.settings);
    return this.settings;
  }

  /** Chame depois de mexer em `windows`. */
  saveWindows() {
    this.scheduleSave('state', this.paths.stateFile, () => ({ version: this.stateVersion, windows: this.windows, aliases: this.aliases }));
  }

  saveHosts() {
    this.scheduleSave('hosts', this.paths.hostsFile, () => this.hosts);
  }

  addRecentFolder(hostId: string, folder: string) {
    const list = (this.hosts.recentFolders[hostId] ?? []).filter((f) => f !== folder);
    list.unshift(folder);
    this.hosts.recentFolders[hostId] = list.slice(0, 15);
    this.saveHosts();
  }

  listManualPending(hostId: string): ManualPendingConversation[] {
    return Object.values(this.hosts.manualPending).filter((record) => record.hostId === hostId);
  }

  isManualPending(record: ManualPendingConversation): boolean {
    return !!this.hosts.manualPending[manualPendingKey(record)];
  }

  /** Persistência idempotente: a segunda mesma marca não muda nem regrava o estado. */
  setManualPending(record: ManualPendingConversation, pending: boolean): boolean {
    const key = manualPendingKey(record);
    const current = this.hosts.manualPending[key];
    if (pending) {
      if (current && current.hostId === record.hostId && current.sessionId === record.sessionId && current.cwd === record.cwd) return false;
      this.hosts.manualPending[key] = { ...record };
    } else {
      if (!current) return false;
      delete this.hosts.manualPending[key];
    }
    this.saveHosts();
    return true;
  }

  /** Todas as fixadas do servidor, de todas as conversas. */
  listPins(hostId: string): PinnedMessage[] {
    return Object.values(this.hosts.pins)
      .flat()
      .filter((p) => p.hostId === hostId);
  }

  /**
   * Fixa/desafixa uma mensagem. Idempotente: repetir o mesmo pedido não muda nem regrava nada (devolve `false`).
   * Fixar de novo uma âncora já fixada mantém a original (data e trecho). Passou do limite da conversa: `full`.
   */
  setPin(pin: Omit<PinnedMessage, 'pinnedAt'> & { pinnedAt?: number }, pinned: boolean): { changed: boolean; record?: PinnedMessage; full?: boolean } {
    const key = pinsKey(pin);
    const list = this.hosts.pins[key] ?? [];
    const existing = list.find((p) => p.anchor === pin.anchor);
    if (!pinned) {
      if (!existing) return { changed: false };
      const rest = list.filter((p) => p !== existing);
      if (rest.length) this.hosts.pins[key] = rest;
      else delete this.hosts.pins[key];
      this.saveHosts();
      return { changed: true, record: existing };
    }
    if (existing) return { changed: false, record: existing };
    if (list.length >= MAX_PINS_PER_CONVERSATION) return { changed: false, full: true };
    const record: PinnedMessage = {
      hostId: pin.hostId,
      sessionId: pin.sessionId,
      anchor: pin.anchor,
      role: pin.role,
      snippet: pin.snippet.slice(0, PIN_SNIPPET_MAX),
      ...(typeof pin.at === 'number' && Number.isFinite(pin.at) ? { at: pin.at } : {}),
      pinnedAt: pin.pinnedAt ?? Date.now(),
    };
    this.hosts.pins[key] = [...list, record];
    this.saveHosts();
    return { changed: true, record };
  }

  flush() {
    for (const [key, t] of this.saveTimers) {
      clearTimeout(t);
      this.saveTimers.delete(key);
    }
    writeJsonAtomic(this.paths.settingsFile, this.settings);
    writeJsonAtomic(this.paths.stateFile, { version: this.stateVersion, windows: this.windows, aliases: this.aliases });
    writeJsonAtomic(this.paths.hostsFile, this.hosts);
  }
}
