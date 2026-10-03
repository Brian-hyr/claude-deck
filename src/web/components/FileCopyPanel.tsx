// Histórico/progresso de cópias desta janela; não fecha automaticamente quando termina.
import { useEffect, useState } from 'preact/hooks';
import { cancelFileCopy, copyTerminal, fileCopyJobs, fileCopyLabel, fileCopyPanel } from '../lib/fileCopy';
import { hostLabel, errorText, toast, dialogs } from '../lib/state';
import { rpc } from '../lib/rpc';
import type { FileCopyIssue } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { Icon } from './icons';

export function FileCopyPanel() {
  const open = fileCopyPanel.value;
  const [more, setMore] = useState<Record<string, FileCopyIssue[]>>({});
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dialogs.peek().length) { e.stopPropagation(); e.preventDefault(); fileCopyPanel.value = false; } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);
  if (!open) return null;
  const jobs = fileCopyJobs.value;
  return (
    <div class="overlay file-copy-overlay" onClick={() => (fileCopyPanel.value = false)}>
      <div class="dialog file-copy-dialog" role="dialog" aria-label="Cópias de arquivos" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-title">Cópias de arquivos <button class="icon-btn" title="Fechar" onClick={() => (fileCopyPanel.value = false)}><Icon name="close" /></button></div>
        <div class="file-copy-list">
          {!jobs.length && <p>Nenhuma cópia nesta janela. Copie um item no explorador e cole na pasta de destino.</p>}
          {jobs.map((j) => {
            const issues = more[j.id] ?? j.issues;
            const pct = j.bytes ? Math.min(100, Math.floor(j.transferred * 100 / j.bytes)) : 0;
            return <section class={`file-copy-job ${j.state}`} key={j.id} data-copy-id={j.id}>
              <strong class="file-copy-state">{fileCopyLabel(j)}</strong>
              <div class="file-copy-path">{hostLabel(j.source.hostId)}: {j.source.path}</div>
              <div class="file-copy-path">→ {hostLabel(j.destination.hostId)}: {j.destination.path}</div>
              {j.state === 'copying' && <progress value={pct} max={100} />}
              <p>{j.state === 'scanning' ? 'Analisando os itens antes de escrever…' : `${formatBytes(j.transferred)} / ${formatBytes(j.bytes)} · ${j.copied}/${j.files} arquivo(s) copiado(s) · ${j.skipped} pulado(s) · ${j.omitted} omitido(s)`}</p>
              {j.current && <div class="file-copy-path">{j.current}</div>}
              {j.error && <p class="file-copy-error">{j.error}</p>}
              {issues.length > 0 && <ul>{issues.map((i) => <li>{i.path}: {i.message}</li>)}</ul>}
              {issues.length < j.issueCount && <button class="btn secondary" onClick={async () => {
                try {
                  const next = await rpc.call<FileCopyIssue[]>('fileCopy.get', { id: j.id, offset: issues.length });
                  setMore((m) => ({ ...m, [j.id]: [...issues, ...next] }));
                } catch (e) { toast(errorText(e), 'error'); }
              }}>Mais detalhes</button>}
              {!copyTerminal(j) && <button class="btn secondary" onClick={() => cancelFileCopy(j.id)}>Cancelar cópia</button>}
              {j.state === 'uncertain' && <p>Inspecione o destino antes de repetir. Nenhum arquivo final foi apagado automaticamente.</p>}
            </section>;
          })}
        </div>
        <p class="hint">A origem não é apagada. Fechar este painel não cancela a transferência.</p>
      </div>
    </div>
  );
}
