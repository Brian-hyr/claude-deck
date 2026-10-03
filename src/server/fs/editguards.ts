// Reserva breve para publicar uma cópia sem substituir rascunhos em outra janela.
import crypto from 'node:crypto';
import { DeckError } from '../../shared/protocol';
import { copyPath } from './copyfs';
import type { Platform } from '../../shared/types';

export interface EditPresence { hostId: string; path: string; dirty: boolean }
interface WindowPresence { revision: number; connection: number; files: EditPresence[] }
interface Reservation { id: string; key: string; waiting: Map<string, (clean: boolean) => void> }
export class FileEditGuards {
  private windows = new Map<string, WindowPresence>();
  private locks = new Map<string, Reservation>();
  private writes = new Set<string>();
  private lostAt = new Map<string, number>();
  disconnected(wid: string) { this.lostAt.set(wid, Date.now()); }
  constructor(private opts: {
    identity(h: string): string;
    platform(h: string): Platform;
    /** Arquivos abertos gravados no estado de cada janela conectada (cobre também interfaces antigas). */
    participants(identity: string): { wid: string; hostId: string; path: string }[];
    live(): Set<string>;
    send(wid: string, event: string, data: any): void;
  }) {}
  key(h: string, p: string) { return this.keyFor(this.opts.identity(h), this.opts.platform(h), p); }
  private keyFor(identity: string, platform: Platform, p: string) {
    const path = copyPath(platform, p);
    return JSON.stringify([identity, platform === 'win32' ? path.toLowerCase() : path]);
  }
  sync(wid: string, connection: number, revision: number, files: EditPresence[]) {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(files) || files.length > 1000) throw new DeckError('bad', 'Estado de edição inválido.');
    const clean = files.map((f) => {
      if (typeof f.hostId !== 'string' || typeof f.dirty !== 'boolean') throw new DeckError('bad', 'Arquivo aberto inválido.');
      this.key(f.hostId, f.path);
      return { hostId: f.hostId, path: f.path, dirty: f.dirty };
    });
    const previous = this.windows.get(wid);
    if (previous && (previous.connection > connection || (previous.connection === connection && revision < previous.revision))) return;
    this.lostAt.delete(wid);
    this.windows.set(wid, { connection, revision, files: clean });
  }
  acknowledge(wid: string, id: string, clean: boolean) {
    const lock = [...this.locks.values()].find((l) => l.id === id);
    const done = lock?.waiting.get(wid);
    if (!done) throw new DeckError('notfound', 'Reserva não encontrada nesta janela.');
    lock!.waiting.delete(wid); done(clean === true);
  }
  beginWrite(h: string, p: string) {
    const key = this.key(h, p);
    if (this.locks.has(key) || this.writes.has(key)) throw new DeckError('busy', 'Este arquivo está sendo publicado por uma cópia ou salvo em outra janela.');
    this.writes.add(key);
    return () => this.writes.delete(key);
  }
  async reserve(identity: string, platform: Platform, path: string): Promise<() => void> {
    const key = this.keyFor(identity, platform, path);
    if (this.locks.has(key) || this.writes.has(key)) throw new DeckError('busy', 'Destino já está sendo escrito.');
    const live = this.opts.live();
    for (const [wid, presence] of this.windows) {
      if (!live.has(wid)) {
        if (Date.now() - (this.lostAt.get(wid) ?? Date.now()) < 30_000 && presence.files.some((f) => this.key(f.hostId, f.path) === key)) throw new DeckError('busy', 'A janela que abriu este destino desconectou. Aguarde a reconexão antes de substituir.');
        this.windows.delete(wid); this.lostAt.delete(wid); continue;
      }
      for (const f of presence.files) if (f.dirty && this.key(f.hostId, f.path) === key) throw new DeckError('dirty', 'O destino tem alterações não salvas em outra janela. Salve ou feche o arquivo antes de substituir.');
    }
    const lock: Reservation = { id: crypto.randomUUID(), key, waiting: new Map() };
    this.locks.set(key, lock);
    // Só confirma quem tem ESTE arquivo aberto: janela que não o abriu não tem rascunho a perder.
    const same = (f: { hostId: string; path: string }) => { try { return this.key(f.hostId, f.path) === key; } catch { return false; } };
    const peers = this.opts.participants(identity).filter(same);
    for (const [wid, presence] of this.windows) for (const f of presence.files) if (same(f)) peers.push({ wid, hostId: f.hostId, path: f.path });
    const targets = new Map<string, Set<string>>();
    for (const p of peers) { const hosts = targets.get(p.wid) ?? new Set<string>(); hosts.add(p.hostId); targets.set(p.wid, hosts); }
    const release = () => {
      if (this.locks.get(key) !== lock) return;
      this.locks.delete(key);
      for (const wid of targets.keys()) this.opts.send(wid, 'fileCopy.release', { id: lock.id });
    };
    try {
      await Promise.all([...targets].map(([wid, hosts]) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { lock.waiting.delete(wid); reject(new DeckError('busy', 'Uma janela com acesso ao destino não confirmou que o arquivo está livre.')); }, 5000);
        lock.waiting.set(wid, (clean) => { clearTimeout(timer); clean ? resolve() : reject(new DeckError('dirty', 'Destino aberto com alterações não salvas.')); });
        this.opts.send(wid, 'fileCopy.reserve', { id: lock.id, paths: [...hosts].map((hostId) => ({ hostId, path })) });
      })));
      return release;
    } catch (e) { release(); throw e; }
  }
}
