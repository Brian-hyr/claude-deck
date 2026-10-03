// Jarvis · Central: janela avulsa e global, sem relação com servidor/pasta/conversa desta janela
// do Deck. O serviço roda permanente num CT — mas o Deck e o Jarvis vivem em perfis SEPARADOS do
// Brave. Abrir http://127.0.0.1:47331 direto neste perfil (o do Deck) não leva o cookie de sessão
// do Jarvis: dá 401 mesmo com o Jarvis já autenticado no perfil dele. Por isso a abertura NUNCA é
// uma navegação HTTP — é um protocolo customizado (jarvis-central://open, registrado em HKCU pelo
// instalador do atalho do Jarvis) que o Windows roteia para open-jarvis.ps1 sem nenhum argumento
// de URL; o script é quem decide perfil, túnel e janela. Este módulo nunca passa por rpc.call,
// window.attach, sessions.* ou windowContext — não é (e não finge ser) uma janela do Deck.
export const JARVIS_PROTOCOL_URL = 'jarvis-central://open';
/** Só para um diagnóstico auxiliar (o túnel local está de pé?). Nunca usado para abrir a janela:
 *  uma resposta aqui roda no perfil do Deck, sem o cookie do Jarvis — não prova login nenhum. */
export const JARVIS_STATUS_URL = 'http://127.0.0.1:47331';
export const PROBE_TIMEOUT_MS = 1500;

export interface JarvisOpenResult {
  /** Só significa que o clique no protocolo foi disparado — dali em diante é o Windows que decide
   *  (prompt de "abrir aplicativo externo?" ou abre direto, se já confiado). O JS não tem como
   *  confirmar que a janela do Jarvis realmente abriu do outro lado. */
  opened: boolean;
  reason?: string;
}

/**
 * O túnel local (127.0.0.1:47331) responde a alguma coisa? Diagnóstico auxiliar só — não é (e não
 * deve virar) pré-condição para abrir o protocolo: quem cuida do túnel é o script por trás dele,
 * e esta sonda roda sem o cookie do Jarvis, então nunca prova que este perfil está autenticado.
 */
export async function probeJarvisTunnel(url: string = JARVIS_STATUS_URL, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    // no-cors: só queremos saber se algo respondeu; não lemos corpo/cabeçalho (nem poderíamos,
    // com ou sem cookie).
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl?.signal });
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Aciona o protocolo customizado clicando num link invisível (`target="_blank"`, removido na
 * hora). Isso entrega o pedido ao manipulador externo do Windows SEM navegar a página do Deck —
 * a aba/janela atual continua exatamente onde estava.
 *
 * Importante: precisa rodar SÍNCRONO, dentro do próprio gesto do clique do usuário. Qualquer
 * `await` antes desta chamada quebra a cadeia de gesto e o navegador ignora o handoff. Por isso
 * `openJarvisCentral` não é assíncrona e não espera a sonda HTTP para decidir se dispara.
 */
function invokeProtocol(url: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * Abre o Jarvis · Central pelo protocolo customizado — nunca por HTTP direto (o perfil do Deck
 * não tem o cookie de sessão do Jarvis; ver o cabeçalho do arquivo). Preserva a página do Deck:
 * não navega, só entrega o clique ao manipulador externo. Chame isto direto do `onClick`, sem
 * `await` antes — veja `invokeProtocol`.
 */
export function openJarvisCentral(): JarvisOpenResult {
  const dispatched = invokeProtocol(JARVIS_PROTOCOL_URL);
  if (!dispatched) {
    return {
      opened: false,
      reason: 'Não consegui acionar jarvis-central://. Instale (ou reinstale) o atalho do Jarvis — ele registra o protocolo — e tente de novo.',
    };
  }
  return { opened: true };
}
