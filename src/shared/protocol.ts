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
