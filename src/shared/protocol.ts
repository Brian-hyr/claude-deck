// Protocolo WebSocket entre a interface e o servidor local.
// Pedido:   { id, method, params }
// Resposta: { id, result } | { id, error: { message, code? } }
// Evento:   { event, data }

export interface RpcRequest {
  id: number;
  method: string;
  params?: any;
}

export interface RpcResponse {
  id: number;
  result?: any;
  error?: { message: string; code?: string };
}

export interface ServerEvent {
  event: string;
  data: any;
}

export type AuthPromptKind = 'password' | 'passphrase' | 'hostkey' | 'keyboard';

export interface AuthPrompt {
  promptId: string;
  hostId: string;
  kind: AuthPromptKind;
  title: string;
  message: string;
  /** Para keyboard-interactive: perguntas (echo = mostrar o texto digitado). */
  prompts?: { prompt: string; echo: boolean }[];
  fingerprint?: string;
  keyType?: string;
}

/** Erro com código, usado nas respostas RPC. */
export class DeckError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Detecta se uma mensagem `user` é um eco/breadcrumb sintético gerado pelo CLI
 * (ex.: ao trocar o modelo via set_model: "<local-command-stdout>Set model to `...`</local-command-stdout>").
 * Essas mensagens não são pedidos reais do usuário e nunca geram um turno ou resposta de assistente.
 */
export function isSyntheticBreadcrumb(msg: any): boolean {
  if (!msg || msg.type !== 'user') return false;
  if (msg.isMeta) return true;
  const content = msg.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    }
  }
  if (!text) return false;
  if (/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/.test(text)) {
    const stripped = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
    if (!stripped) return true;
  }
  return false;
}

