// Cliente WebSocket do servidor local, com reconexão automática.
import { signal } from '@preact/signals';

type Listener = (data: any) => void;

export const wsConnected = signal(false);
export const wsEverConnected = signal(false);

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: number;
}

export class RpcError extends Error {
  code: string;
  data: any;
  constructor(message: string, code: string, data?: any) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class Rpc {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private queue = new Map<number, string>();
  private backoff = 300;
  private reconnectHandlers = new Set<() => void>();

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      const first = !wsEverConnected.value;
      wsConnected.value = true;
      wsEverConnected.value = true;
      this.backoff = 300;
      const q = this.queue;
      this.queue = new Map();
      for (const [id, m] of q) if (this.pending.has(id)) ws.send(m);
      if (!first) for (const h of this.reconnectHandlers) h();
    };
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new RpcError(m.error.message, m.error.code ?? 'error', m.error));
        else p.resolve(m.result);
        return;
      }
      if (m.event) {
        const set = this.listeners.get(m.event);
        if (set) for (const fn of set) fn(m.data);
      }
    };
    ws.onclose = () => {
      wsConnected.value = false;
      this.ws = null;
      this.queue.clear();
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError('Conexão com o Claude Deck perdida.', 'disconnected'));
        this.pending.delete(id);
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  call<T = any>(method: string, params?: any, timeoutMs = 120_000): Promise<T> {
    const onlineOnly = method.startsWith('fileClipboard.') || method.startsWith('fileCopy.');
    if (onlineOnly && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) return Promise.reject(new RpcError('Sem conexão: a cópia não foi iniciada.', 'disconnected'));
    const id = ++this.seq;
    const text = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.queue.delete(id);
        reject(new RpcError(`Tempo esgotado (${method})`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
      else this.queue.set(id, text);
    });
  }

  on(event: string, fn: Listener) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  onReconnect(fn: () => void) {
    this.reconnectHandlers.add(fn);
  }
}

export const rpc = new Rpc();
