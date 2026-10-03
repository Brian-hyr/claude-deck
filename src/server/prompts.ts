// Pedidos interativos à interface: senha, frase da chave, confirmação de chave do servidor.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { AuthPrompt } from '../shared/protocol';

export type PromptAnswer = { ok: true; values: string[] } | { ok: false };

interface Pending {
  prompt: AuthPrompt;
  resolve: (a: PromptAnswer) => void;
  timer: NodeJS.Timeout;
}

export class PromptBroker extends EventEmitter {
  private pending = new Map<string, Pending>();

  ask(p: Omit<AuthPrompt, 'promptId'>, timeoutMs = 5 * 60_000): Promise<PromptAnswer> {
    const promptId = crypto.randomUUID();
    const prompt: AuthPrompt = { ...p, promptId };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(promptId);
        this.emit('closed', promptId);
        resolve({ ok: false });
      }, timeoutMs);
      this.pending.set(promptId, { prompt, resolve, timer });
      this.emit('prompt', prompt);
    });
  }

  respond(promptId: string, answer: PromptAnswer) {
    const p = this.pending.get(promptId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(promptId);
    this.emit('closed', promptId);
    p.resolve(answer);
    return true;
  }

  cancelHost(hostId: string) {
    for (const [id, p] of this.pending) if (p.prompt.hostId === hostId) this.respond(id, { ok: false });
  }

  list(): AuthPrompt[] {
    return [...this.pending.values()].map((p) => p.prompt);
  }
}
