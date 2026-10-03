// Copiar/colar no explorador: o daemon transporta bytes; a interface acompanha referências/jobs.
import { signal } from '@preact/signals';
import type { FileClipboard, FileCopyJob } from '../../shared/types';
import { rpc, RpcError } from './rpc';
import { choiceDialog, confirmDialog, errorText, fileChangedExternally, files, hostLabel, platformOf, toast, windowId } from './state';
import { relativeTo } from '../../shared/paths';

export const fileCopySupported = signal(false);
export const fileClipboard = signal<FileClipboard | null>(null);
export const fileCopyJobs = signal<FileCopyJob[]>([]);
export const fileCopyPanel = signal(false);
export const publicationLocks = signal<Record<string, { hostId: string; path: string }[]>>({});
export const copyTerminal = (j: FileCopyJob) => ['completed', 'partial', 'failed', 'cancelled', 'uncertain'].includes(j.state);
const questions = new Set<string>();
let wired = false;
let generation = 0;

export function isFilePublishing(hostId: string, path: string): boolean {
  return Object.values(publicationLocks.value).some((ps) => ps.some((p) => p.hostId === hostId && relativeTo(platformOf(hostId), p.path, path) === ''));
}
function supported() {
  if (fileCopySupported.peek()) return true;
  toast('Copiar/colar entre servidores exige a versão nova do servidor do Claude Deck. Atualize-o quando as conversas estiverem paradas; recarregar a janela não atualiza o servidor.', 'error', 9000);
  return false;
}
export async function copyExplorerItem(hostId: string, path: string) {
  if (!supported()) return;
  const dirty = files.peek().find((f) => f.hostId === hostId && relativeTo(platformOf(hostId), path, f.path) !== null && f.dirty.peek());
  if (dirty && !(await confirmDialog('Copiar o conteúdo salvo no disco?', `${dirty.name} tem alterações não salvas. A cópia não inclui esse rascunho. Salve antes, ou copie apenas a versão que está no disco.`, 'Copiar versão salva'))) return;
  try {
    fileClipboard.value = await rpc.call('fileClipboard.set', { hostId, path });
    toast(`Copiado: ${fileClipboard.value!.name} (${hostLabel(hostId)}). Cole na pasta de destino.`, 'success', 4000);
  } catch (e) { toast(`Não copiou: ${errorText(e)}`, 'error'); }
}
export async function pasteExplorerItem(hostId: string, dir: string) {
  if (!supported()) return;
  const c = fileClipboard.peek();
  if (!c) { toast('Copie primeiro um arquivo ou pasta no explorador do Deck.', 'info'); return; }
  const requestId = crypto.randomUUID();
  try {
    const job = await rpc.call<FileCopyJob>('fileCopy.start', { requestId, clipboardId: c.id, revision: c.revision, hostId, dir });
    receive(job); fileCopyPanel.value = true;
  } catch (e) {
    // O start pode ter sido recebido antes do timeout: consultar, nunca iniciar outro.
    if (e instanceof RpcError && e.code === 'timeout') {
      try { receive(await rpc.call('fileCopy.get', { requestId })); fileCopyPanel.value = true; return; } catch { /* reconexão consulta lista */ }
    }
    toast(`Colagem não confirmada: ${errorText(e)}. Consulte as cópias antes de tentar novamente.`, 'error', 8000);
  }
}
export async function cancelFileCopy(id: string) {
  try { receive(await rpc.call('fileCopy.cancel', { id })); }
  catch (e) { toast(`Cancelamento não confirmado: ${errorText(e)}`, 'error'); }
}
export function fileCopyLabel(j: FileCopyJob) {
  const names = { scanning: 'Analisando', awaitingDecision: 'Esperando decisão', queued: 'Na fila', copying: 'Copiando', completed: 'Concluída', partial: 'Parcial', failed: 'Falhou', cancelled: 'Cancelada', uncertain: 'Resultado incerto' };
  return names[j.state];
}
function receive(j: FileCopyJob) {
  const old = fileCopyJobs.peek().find((x) => x.id === j.id);
  if (old && old.revision > j.revision) return;
  fileCopyJobs.value = [...fileCopyJobs.peek().filter((x) => x.id !== j.id), j].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  if (copyTerminal(j) && !copyTerminal(old ?? { state: 'scanning' } as FileCopyJob)) {
    toast(`Cópia ${fileCopyLabel(j).toLowerCase()}: ${j.copied} arquivo(s), ${j.skipped} pulado(s), ${j.omitted} omitido(s)${j.error ? `. ${j.error}` : ''}.`, j.state === 'completed' ? 'success' : 'error', 6500);
  }
  if (j.state === 'awaitingDecision' && j.destinationWid === windowId) void decide(j);
}
async function decide(j: FileCopyJob) {
  if (questions.has(j.id)) return;
  questions.add(j.id);
  const gen = generation;
  try {
    const text = `${hostLabel(j.source.hostId)}: ${j.source.path}\n→ ${hostLabel(j.destination.hostId)}: ${j.destination.path}\n${j.files} arquivo(s), ${j.conflicts} conflito(s). Pastas existentes serão mescladas, nunca apagadas. Links e itens especiais são omitidos. Arquivo contra pasta não será substituído.`;
    const choice = j.conflicts ? await choiceDialog('Confirmar cópia', text, 'Substituir arquivos existentes', 'Pular existentes', true) : (await confirmDialog('Confirmar cópia', text, 'Copiar')) ? 'ok' : 'cancel';
    if (gen !== generation) return;
    const current = fileCopyJobs.peek().find((x) => x.id === j.id);
    if (current?.state !== 'awaitingDecision') return;
    receive(await rpc.call('fileCopy.resolve', { id: j.id, revision: current.revision, decision: choice === 'ok' ? 'replace' : choice === 'alt' ? 'skip' : 'cancel' }));
  } catch (e) { toast(`Decisão da cópia não confirmada: ${errorText(e)}`, 'error'); }
  finally { questions.delete(j.id); }
}
export async function syncFileCopies(support: boolean, bootChanged: boolean) {
  fileCopySupported.value = support;
  if (bootChanged || !support) {
    generation++; fileClipboard.value = null; fileCopyJobs.value = []; publicationLocks.value = {}; questions.clear();
  }
  if (!support) return;
  publicationLocks.value = {}; window.dispatchEvent(new CustomEvent('deck:file-locks'));
  try {
    const [clipboard, jobs] = await Promise.all([rpc.call('fileClipboard.get'), rpc.call<FileCopyJob[]>('fileCopy.list')]);
    fileClipboard.value = clipboard;
    for (const j of jobs) receive(j);
    await reportFileEdits();
  } catch (e) { toast(`Não sincronizou as cópias: ${errorText(e)}`, 'error'); }
}
let editRevision = 0;
export async function reportFileEdits() {
  if (!fileCopySupported.peek() || !windowId) return;
  await rpc.call('fileCopy.edits', { revision: ++editRevision, files: files.peek().map((f) => ({ hostId: f.hostId, path: f.path, dirty: f.dirty.peek() })) });
}
export function wireFileCopies() {
  if (wired) return; wired = true;
  rpc.on('fileClipboard.changed', (value) => { fileClipboard.value = value; });
  rpc.on('fileCopy.state', receive);
  rpc.on('fileCopy.reserve', (r) => {
    publicationLocks.value = { ...publicationLocks.peek(), [r.id]: r.paths };
    // Bloqueio aplicado síncrono: o evento de edição/salvar não pode atravessar o ACK.
    window.dispatchEvent(new CustomEvent('deck:file-locks'));
    const clean = !files.peek().some((f) => f.dirty.peek() && r.paths.some((p: any) => p.hostId === f.hostId && relativeTo(platformOf(f.hostId), p.path, f.path) === ''));
    void rpc.call('fileCopy.ack', { id: r.id, clean }).catch(() => {});
  });
  rpc.on('fileCopy.release', ({ id }) => {
    const next = { ...publicationLocks.peek() }; delete next[id]; publicationLocks.value = next;
    window.dispatchEvent(new CustomEvent('deck:file-locks'));
  });
  rpc.on('fs.changed', ({ hostIds, path }) => {
    for (const hostId of hostIds) fileChangedExternally(hostId, path);
    window.dispatchEvent(new CustomEvent('deck:files-changed', { detail: { hostIds, path } }));
  });
}
