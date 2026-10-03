// Baixar arquivo/pasta de um servidor e arrastar para fora do app (Windows Explorer, área de trabalho...).
import { rpc, RpcError } from './rpc';
import { rawUrl, toast } from './state';

/** URL para baixar uma pasta inteira como .zip (montado em fluxo no servidor). */
export function zipUrl(hostId: string, path: string) {
  return `/api/zip?h=${encodeURIComponent(hostId)}&p=${encodeURIComponent(path)}`;
}

/** Inicia o download pelo navegador sem abrir janela/aba nova. */
export function startDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * O programa em segundo plano só é trocado quando não há conversa trabalhando; até lá ele pode ser de uma
 * versão anterior, que não sabe montar .zip (a rota cairia na página inicial e baixaria um HTML).
 */
let knowsFolderTransfer = false;
async function serverHasFolderTransfer(): Promise<boolean> {
  if (knowsFolderTransfer) return true;
  try {
    knowsFolderTransfer = (await rpc.call<{ folderTransfer?: boolean }>('app.info', {}, 15_000)).folderTransfer === true;
  } catch {
    knowsFolderTransfer = false;
  }
  return knowsFolderTransfer;
}

export async function downloadEntry(hostId: string, path: string, folder: boolean) {
  if (folder && !(await serverHasFolderTransfer())) {
    toast(
      'Baixar pasta (.zip) e arrastar para fora precisam da versão nova do Claude Deck, e o programa em segundo plano ainda é o anterior. Feche todas as janelas e abra pelo atalho quando nenhuma conversa estiver trabalhando.',
      'error',
      12_000,
    );
    return;
  }
  startDownload(folder ? zipUrl(hostId, path) : rawUrl(hostId, path, true));
  toast(folder ? 'Preparando o .zip da pasta… o download começa em seguida.' : 'Download iniciado.', 'info', 2500);
}

// ---------------------------------------------------------------- arrastar para fora

/** Bilhete de download pronto (a URL precisa estar em mãos de forma síncrona no `dragstart`). */
const tickets = new Map<string, { url: string; at: number }>();
const pending = new Map<string, Promise<void>>();
let noTicketUntil = 0;
const TICKET_TTL = 8 * 60_000; // o servidor vale 10 min

const tkey = (hostId: string, path: string, zip: boolean) => `${hostId}::${zip ? 'z' : 'f'}::${path}`;

/** Pede o bilhete antecipadamente (ao passar o mouse), para o arrasto já sair com o link. */
export function prefetchTicket(hostId: string, path: string, zip: boolean): void {
  const k = tkey(hostId, path, zip);
  const cur = tickets.get(k);
  if ((cur && Date.now() - cur.at < TICKET_TTL) || pending.has(k) || Date.now() < noTicketUntil) return;
  const p = rpc
    .call<{ url: string }>('dl.ticket', { h: hostId, p: path, zip }, 30_000)
    .then((r) => {
      tickets.set(k, { url: r.url, at: Date.now() });
    })
    .catch((e) => {
      // Servidor anterior (sem `dl.ticket`): não insiste a cada passada do mouse.
      if (e instanceof RpcError && e.code === 'nomethod') noTicketUntil = Date.now() + 60_000;
      /* sem bilhete: o arrasto fica só interno; o menu "Baixar" continua valendo */
    })
    .finally(() => pending.delete(k));
  pending.set(k, p);
}

/** Dados para o navegador baixar sozinho ao soltar fora do app (formato do Chromium: `tipo:nome:url`). */
export function downloadUrlData(hostId: string, path: string, zip: boolean, name: string): string | null {
  const t = tickets.get(tkey(hostId, path, zip));
  if (!t || Date.now() - t.at > TICKET_TTL) return null;
  const clean = `${name}${zip ? '.zip' : ''}`.replace(/[:\\/]/g, '_');
  return `${zip ? 'application/zip' : 'application/octet-stream'}:${clean}:${location.origin}${t.url}`;
}
