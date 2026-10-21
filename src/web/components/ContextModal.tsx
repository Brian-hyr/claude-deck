// Detalhamento do /context da conversa ativa, consultado no CLI (sem estimar categorias).
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatTokens } from '../lib/format';
import { colorForCategory, compactAction, contextPercent, shortenPath, visibleContextCategories, type DetailedContextUsage } from '../lib/contextUsage';
import { chats, closeContextModal, contextModalSid, fetchDetailedContext, sendMessage, toast, type ChatTab } from '../lib/state';
import { Icon } from './icons';

export function ContextModal() {
  const sid = contextModalSid.value;
  const chat = chats.value.find((c) => c.sid === sid);
  return sid && chat ? <ContextModalInner key={sid} chat={chat} /> : null;
}

function ContextModalInner({ chat }: { chat: ChatTab }) {
  const [data, setData] = useState<DetailedContextUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  void chat.version.value;
  const action = compactAction(chat.state.value.phase === 'running' || chat.model.running, chat.model.compactState());

  const load = () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetchDetailedContext(chat.sid).then((usage) => {
      if (id === requestId.current) setData(usage);
    }).catch((e) => {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (id === requestId.current) setLoading(false);
    });
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    load();
    return () => {
      requestId.current++;
      previousFocus?.focus();
    };
  }, [chat.sid]);

  const compact = () => {
    if (action === 'queued' || action === 'compacting') return;
    if (action === 'enqueue') toast('/compact na fila: roda quando o Claude terminar o que está fazendo.', 'info');
    closeContextModal();
    void sendMessage(chat, '/compact', []);
  };

  const categories = data ? visibleContextCategories(data.categories) : [];
  const freeSpace = data?.categories.find((c) => /^(free space|espaço livre)$/i.test(c.name) && !c.isDeferred && c.tokens > 0);
  const memory = [...(data?.memoryFiles ?? [])].filter((f) => f.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  const agents = [...(data?.agents ?? [])].filter((a) => a.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 5);

  return (
    <div class="overlay" onMouseDown={closeContextModal}>
      <div ref={dialog} class="dialog context-modal" role="dialog" aria-modal="true" aria-labelledby="context-modal-title" tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeContextModal(); } }}>
        <div class="dialog-head">
          <Icon name="pie-chart" />
          <span class="grow" id="context-modal-title">Uso do contexto</span>
          <button class="icon-btn" title="Fechar (Esc)" onClick={closeContextModal}><Icon name="close" /></button>
        </div>
        <div class="dialog-body">
          {loading && !data && <div class="ctx-message">Carregando uso do contexto…</div>}
          {error && <div class="ctx-message" role="alert">{error} <button class="btn secondary" onClick={load}>Tentar novamente</button></div>}
          {data && <>
            <div class="ctx-summary">
              <strong>{data.model || chat.state.value.model || 'Modelo não informado'}</strong>
              <span>{formatTokens(data.totalTokens)} / {formatTokens(data.rawMaxTokens)} tokens ({Math.round(data.percentage)}%)</span>
            </div>
            {categories.length > 0 ? <>
              <div class="ctx-track" role="img" aria-label={`Categorias de uso do contexto, ${Math.round(data.percentage)}% utilizado`}>
                {categories.map((category, index) => <div class="ctx-seg" key={category.name}
                  style={{ width: `${category.tokens / data.rawMaxTokens * 100}%`, background: colorForCategory(index) }}
                  title={`${category.name}: ${formatTokens(category.tokens)} tokens (${contextPercent(category.tokens, data.rawMaxTokens)})`} />)}
              </div>
              <div class="ctx-section-title">Categorias <span>Tokens · Uso</span></div>
              <div class="ctx-table">
                {categories.map((category, index) => <div class="ctx-row" key={category.name}>
                  <span class="ctx-swatch" style={{ background: colorForCategory(index) }} />
                  <span class="ctx-name" title={category.name}>{category.name}</span>
                  <span class="ctx-tokens">{formatTokens(category.tokens)}</span>
                  <span class="ctx-usage-pct">{contextPercent(category.tokens, data.rawMaxTokens)}</span>
                </div>)}
                {freeSpace && <div class="ctx-row"><span class="ctx-swatch ctx-free" />
                  <span class="ctx-name">{freeSpace.name}</span>
                  <span class="ctx-tokens">{formatTokens(freeSpace.tokens)}</span>
                  <span class="ctx-usage-pct">{contextPercent(freeSpace.tokens, data.rawMaxTokens)}</span>
                </div>}
              </div>
            </> : <p class="ctx-message">Esta versão do Claude Code não informou a distribuição por categoria.</p>}
            {memory.length > 0 && <section><div class="ctx-section-title">Arquivos de memória <span>/memory</span></div>
              {memory.map((entry) => <div class="ctx-detail-row" key={entry.path}>
                <span class="ctx-detail-name" title={entry.path}>{shortenPath(entry.path)}</span>
                <span class="ctx-detail-tokens">{formatTokens(entry.tokens)}</span>
              </div>)}
            </section>}
            {agents.length > 0 && <section><div class="ctx-section-title">Agentes personalizados <span>/agents</span></div>
              {agents.map((entry) => <div class="ctx-detail-row" key={entry.agentType}>
                <span class="ctx-detail-name">{entry.agentType}</span>
                <span class="ctx-detail-tokens">{formatTokens(entry.tokens)}</span>
              </div>)}
            </section>}
          </>}
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={closeContextModal}>Fechar</button>
          <button class="btn" onClick={compact} disabled={action === 'queued' || action === 'compacting'}>
            {action === 'queued' ? 'Compactação na fila' : action === 'compacting' ? 'Compactando…' : action === 'enqueue' ? 'Deixar /compact na fila' : 'Compactar agora (/compact)'}
          </button>
        </div>
      </div>
    </div>
  );
}
