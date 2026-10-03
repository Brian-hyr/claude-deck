// Ajudantes dos testes de integração: servidor real do Claude Deck + cliente WebSocket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { DeckServer } from '../../src/server/app';
import { resolvePaths } from '../../src/server/config';

export const TEST_HOST = process.env.DECK_TEST_HOST || '';

export async function startServer(extra: { settings?: Record<string, unknown> } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-'));
  if (extra.settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(extra.settings));
  const webDir = path.resolve('dist/web');
  const server = new DeckServer({ port: 0, paths: resolvePaths(dataDir), webDir, skipVscodeImport: true, quiet: true });
  // Parar o servidor também apaga a pasta de dados temporária.
  const stop = server.stop.bind(server);
  server.stop = async () => {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const cookie = await login(server.port, server.token);
  const client = await connectWs(server.port, cookie);
  return { server, base, cookie, client, dataDir };
}

export function login(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: `/auth?t=${token}` }, (res) => {
        const c = res.headers['set-cookie']?.[0]?.split(';')[0];
        res.resume();
        c ? resolve(c) : reject(new Error('sem cookie'));
      })
      .on('error', reject);
  });
}

export interface WsClient {
  call: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
  events: { event: string; data: any }[];
  waitFor: (pred: (e: { event: string; data: any }) => boolean, timeoutMs?: number, label?: string) => Promise<{ event: string; data: any }>;
  close: () => void;
  ws: WebSocket;
}

export function connectWs(port: number, cookie: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
    let seq = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const events: { event: string; data: any }[] = [];
    const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.result);
        return;
      }
      events.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        events,
        call: (method, params, timeoutMs = 60_000) =>
          new Promise((res, rej) => {
            const id = ++seq;
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`timeout em ${method}`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
              reject: (e) => {
                clearTimeout(t);
                rej(e);
              },
            });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        waitFor: (pred, timeoutMs = 120_000, label = 'evento') =>
          new Promise((res, rej) => {
            const found = events.find(pred);
            if (found) return res(found);
            const t = setTimeout(() => rej(new Error(`timeout esperando ${label}`)), timeoutMs);
            waiters.push({
              pred,
              resolve: (e) => {
                clearTimeout(t);
                res(e);
              },
            });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

export function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

export function uuid() {
  return crypto.randomUUID();
}

export function textOf(msg: any): string {
  const c = msg?.message?.content;
  if (!Array.isArray(c)) return typeof c === 'string' ? c : '';
  return c
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}
