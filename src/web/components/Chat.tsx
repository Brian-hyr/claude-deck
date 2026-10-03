// Área da conversa: cabeçalho, mensagens (com rolagem que acompanha o fim) e caixa de mensagem.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { rpc } from '../lib/rpc';
import {
  chats,
  errorText,
  folderBrowser,
  homeOf,
  hostColor,
  hostLabel,
  hosts,
  isPending,
  setConversationPending,
  loadChat,
  loadEarlier,
  newChat,
  newChatPicker,
  renamingSid,
  sidebarView,
  sidebarVisible,
  toast,
  type ChatTab,
} from '../lib/state';
import { costIncreases, formatSentAt, groupChatItems, isAgentTool, textRoles, totalInput, type Item, type RenderBlock, type ResultItem, type TokenUsage, type ToolItem, type UserItem } from '../lib/chatModel';
import { Icon, ClaudeLogo } from './icons';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { Composer } from './Composer';
import { openMenu } from './ContextMenu';
import { formatCost, formatDuration, formatElapsed, formatFullDateTime, formatInt, formatTokens } from '../lib/format';
import { openChatPath } from '../lib/chatPaths';
import { tildify } from '../../shared/paths';

export const lightbox = signal<string | null>(null);
const scrollPos = new Map<string, { top: number; stick: boolean }>();

/** Dica ao passar o mouse na data da mensagem: "terça-feira, 30 de setembro de 2026, 14:32:05". */
function fullSentAt(at: number): string {
  return formatFullDateTime(at);
}

const PASTED = /<pasted_content(?:\s+id="[^"]*")?\s*>\n?([\s\S]*?)\n?<\/pasted_content(?:\s+id="[^"]*")?\s*>/g;

/** Texto da bolha do usuário: blocos colados no terminal (<pasted_content>) viram um bloco recolhido. */
function UserText({ text }: { text: string }) {
  if (!text.includes('<pasted_content')) return <>{text}</>;
  const parts: any[] = [];
  let last = 0;
  for (const m of text.matchAll(PASTED)) {
    const before = text.slice(last, m.index).replace(/\n+$/, '');
    if (before) parts.push(before);
    const body = m[1];
    const lines = body.split('\n').length;
    const first = body.trim().split('\n')[0].slice(0, 70);
    parts.push(
      <details key={m.index} class="pasted">
        <summary>
          <Icon name="chevron-right" style={{ fontSize: 12 }} /> Texto colado · {lines} {lines === 1 ? 'linha' : 'linhas'}
          {first ? ` — ${first}${first.length >= 70 ? '…' : ''}` : ''}
        </summary>
        <div>{body}</div>
      </details>,
    );
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last).replace(/^\n+/, '');
  if (rest) parts.push(rest);
  return <>{parts}</>;
}

/** Botão compacto no canto da resposta para copiar o texto/markdown completo da IA. */
function CopyMsgButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard
      .writeText(text.trim())
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch((e) => toast(errorText(e), 'error'));
  };
  return (
    <button
      class={`msg-copy${copied ? ' copied' : ''}`}
      type="button"
      title={copied ? 'Copiado!' : 'Copiar resposta'}
      aria-label={copied ? 'Copiado!' : 'Copiar resposta'}
      onClick={onCopy}
    >
      <Icon name={copied ? 'check' : 'copy'} style={{ fontSize: 12 }} />
    </button>
  );
}

function InjectedSkillItem({ item, onOpenPath }: { item: UserItem; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="injected-card skill">
      <div class="injected-head" onClick={() => setOpen(!open)}>
        <Icon name="sparkle" style={{ color: 'var(--accent)' }} />
        <span class="injected-title">
          Instruções da skill <strong>{item.skillName ?? 'Skill'}</strong>
        </span>
        <span class="injected-tag">Playbook automático</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)', marginLeft: 4 }} />
      </div>
      {open && (
        <div class="injected-body">
          <div class="injected-hint">Carregado automaticamente pela skill para guiar o Claude — não foi enviado por você.</div>
          <Markdown text={item.text} onOpenPath={onOpenPath} />
        </div>
      )}
    </div>
  );
}

function InjectedHookItem({ item, onOpenPath }: { item: UserItem; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(true);
  const clean = item.text.replace(/^Stop hook feedback:\s*/i, '').replace(/^Hook feedback:\s*/i, '');
  return (
    <div class="injected-card hook">
      <div class="injected-head" onClick={() => setOpen(!open)}>
        <Icon name="tools" style={{ color: '#e2a700' }} />
        <span class="injected-title">Aviso de hook do projeto</span>
        <span class="injected-tag">Hook automático</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)', marginLeft: 4 }} />
      </div>
      {open && (
        <div class="injected-body">
          <Markdown text={clean} onOpenPath={onOpenPath} />
        </div>
      )}
    </div>
  );
}

function InjectedTaskNotificationItem({ item, onOpenPath }: { item: UserItem; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(true);
  const tn = item.taskNotification;
  const status = tn?.status ?? 'concluído';
  const summary = tn?.summary ?? 'Subagente finalizou';
  const result = tn?.result ?? item.text;
  return (
    <div class="injected-card task">
      <div class="injected-head" onClick={() => setOpen(!open)}>
        <Icon name="hubot" style={{ color: 'var(--accent)' }} />
        <span class="injected-title">
          Subagente: <strong>{summary}</strong>
        </span>
        <span class="injected-tag">{status === 'completed' ? 'Concluído' : status}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)', marginLeft: 4 }} />
      </div>
      {open && (
        <div class="injected-body">
          <div class="injected-hint">Notificação automática do agente em segundo plano — não foi enviado por você.</div>
          <Markdown text={result} onOpenPath={onOpenPath} />
        </div>
      )}
    </div>
  );
}

/** Uma linha só do começo do texto, para a prévia do cartão recolhido. */
function previewOf(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** Nome de quem mandou: o nome que o CLI informa ("Explore", "smart-ia-06") ou o começo do id. */
function senderOf(m: { from?: string; name?: string }): string | undefined {
  if (m.name) return m.name;
  if (!m.from) return undefined;
  // Socket de outra sessão (uds:/run/user/1000/cc-socks/845127.sock): o número do processo basta.
  const sock = m.from.match(/(\d+)\.sock$/);
  return sock ? `sessão ${sock[1]}` : m.from.slice(0, 8);
}

function InjectedAgentMessageItem({ item, onOpenPath }: { item: UserItem; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const msgs = item.agentMessages?.length ? item.agentMessages : [{ body: item.text }];
  const who = [...new Set(msgs.map(senderOf).filter(Boolean))];
  const session = msgs.every((m) => m.kind === 'session');
  return (
    <div class="injected-card agent">
      <div class="injected-head" onClick={() => setOpen(!open)} title={open ? 'Recolher' : 'Ler a mensagem'}>
        <Icon name={session ? 'comment-discussion' : 'hubot'} style={{ color: '#a371f7' }} />
        <span class="injected-title agent-title">
          {session ? 'Mensagem de outra sessão' : 'Mensagem de outro agente'}
          {who.length ? <strong> · {who.join(', ')}</strong> : null}
          {!open && <span class="injected-preview"> — {previewOf(msgs[0].body)}</span>}
        </span>
        <span class="injected-tag">Automática</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)', marginLeft: 4 }} />
      </div>
      {open && (
        <div class="injected-body">
          <div class="injected-hint">
            {session ? 'Enviada por outra sessão do Claude' : 'Enviada por outro agente (subagente ou colega de equipe)'} — não foi você quem escreveu.
          </div>
          {msgs.map((m, i) => (
            <div key={i} class={i > 0 ? 'agent-msg-next' : undefined}>
              {msgs.length > 1 && senderOf(m) && <div class="injected-hint">de {senderOf(m)}</div>}
              <Markdown text={m.body} onOpenPath={onOpenPath} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mensagem que o próprio Claude Code gerou (marcada como sintética) e que não tem cartão próprio. */
function InjectedAutoItem({ item, onOpenPath }: { item: UserItem; onOpenPath: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="injected-card auto">
      <div class="injected-head" onClick={() => setOpen(!open)} title={open ? 'Recolher' : 'Ver a mensagem'}>
        <Icon name="gear" style={{ color: 'var(--fg-muted)' }} />
        <span class="injected-title agent-title">
          Mensagem automática do Claude Code
          {!open && <span class="injected-preview"> — {previewOf(item.text)}</span>}
        </span>
        <span class="injected-tag">Automática</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)', marginLeft: 4 }} />
      </div>
      {open && (
        <div class="injected-body">
          <div class="injected-hint">Gerada pelo Claude Code durante o trabalho — não foi você quem escreveu.</div>
          <Markdown text={item.text} onOpenPath={onOpenPath} />
        </div>
      )}
    </div>
  );
}

const nf = formatInt;
function tokenDetail(label: string, t: TokenUsage): string {
  const parts = [`${nf(t.input)} novos`];
  if (t.cacheRead) parts.push(`${nf(t.cacheRead)} lidos do cache`);
  if (t.cacheCreate) parts.push(`${nf(t.cacheCreate)} gravados no cache`);
  return `${label}: entrada ${nf(totalInput(t))} (${parts.join(' + ')}) · saída ${nf(t.output)}`;
}
/**
 * Dica da linha de tokens: detalhe do turno e da sessão inteira. Guardada por resultado: o chat refaz a lista a
 * cada pedaço de resposta e remontar esse texto para todo turno do histórico era trabalho repetido à toa.
 * A chave confere os dois objetos de tokens, então se o resultado for atualizado o texto é refeito.
 */
const tokensTitleCache = new WeakMap<ResultItem, { t: TokenUsage | undefined; s: TokenUsage | undefined; text: string }>();
function tokensTitle(r: ResultItem): string {
  const hit = tokensTitleCache.get(r);
  if (hit && hit.t === r.tokens && hit.s === r.sessionTokens) return hit.text;
  const text = [r.tokens && tokenDetail('Este turno', r.tokens), r.sessionTokens && tokenDetail('Sessão inteira', r.sessionTokens)].filter(Boolean).join('\n');
  tokensTitleCache.set(r, { t: r.tokens, s: r.sessionTokens, text });
  return text;
}

function WorkGroup({ items, c, renderChild }: { items: Item[]; c: ChatTab; renderChild: (it: Item) => any }) {
  // Sempre recolhido até você abrir. Pergunta/permissão/plano pendentes nunca chegam aqui:
  // `groupChatItems` os solta fora do grupo, então recolher a cadeia não esconde nada que espera você.
  const [userOpen, setUserOpen] = useState(false);
  const open = userOpen;

  const tools = items.filter((it) => it.kind === 'tool') as ToolItem[];
  const thoughts = items.filter((it) => it.kind === 'thinking');
  const procStart = c.state.value.processStartedAt ?? (c.state.value.phase !== 'ended' && c.state.value.phase !== 'dormant' ? (c.state.value.createdAt ?? 0) : undefined);
  const runningAgents = c.model.runningAgents(procStart);
  const isToolRunning = (t: ToolItem) =>
    t.status === 'running' ||
    (isAgentTool(t) && runningAgents.some((a) => a.id === t.id || a.taskId === t.id || (t.result?.structured?.agentId && a.agentId === t.result.structured.agentId)));
  const running = items.some((it) => (it.kind === 'tool' && isToolRunning(it as ToolItem)) || (it.kind === 'thinking' && it.streaming));
  const hasError = items.some((it) => it.kind === 'tool' && it.status === 'error');

  let totalExecutions = 0;
  const toolCounts: Record<string, number> = {};
  for (const t of tools) {
    if (isAgentTool(t)) {
      const agentRun = runningAgents.find((a) => a.id === t.id || a.taskId === t.id || (t.result?.structured?.agentId && a.agentId === t.result.structured.agentId));
      const desc = t.input?.description || agentRun?.description;
      const childTools = t.children.filter((ch) => ch.kind === 'tool') as ToolItem[];
      totalExecutions += 1 + childTools.length;
      const baseLabel = desc ? `Agente (${desc})` : 'Agente';
      if (childTools.length > 0) {
        const childCounts: Record<string, number> = {};
        for (const ch of childTools) {
          childCounts[ch.name] = (childCounts[ch.name] ?? 0) + 1;
        }
        const childSummary = Object.entries(childCounts)
          .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
          .join(', ');
        toolCounts[`${baseLabel}: ${childSummary}`] = (toolCounts[`${baseLabel}: ${childSummary}`] ?? 0) + 1;
      } else {
        toolCounts[baseLabel] = (toolCounts[baseLabel] ?? 0) + 1;
      }
    } else {
      totalExecutions++;
      toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
    }
  }
  const toolSummary = Object.entries(toolCounts)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');

  const title =
    [
      thoughts.length > 0 ? (thoughts.length === 1 ? 'Raciocínio' : `${thoughts.length} raciocínios`) : null,
      totalExecutions > 0 ? (totalExecutions === 1 ? '1 execução' : `${totalExecutions} execuções`) : null,
    ].filter(Boolean).join(' e ') || 'Raciocínio e execuções';

  return (
    <div class={`work-group${open ? ' open' : ''}${hasError ? ' has-error' : ''}`}>
      <div class="work-group-head" onClick={() => setUserOpen(!open)}>
        <span class="work-group-icon">
          {running ? (
            <Icon name="sync" class="spin" style={{ color: 'var(--accent)' }} />
          ) : hasError ? (
            <Icon name="error" style={{ color: 'var(--err)' }} />
          ) : (
            <Icon name="check" style={{ color: 'var(--fg-muted)' }} />
          )}
        </span>
        <span class="work-group-title">{running ? `${title} (em andamento)` : title}</span>
        {toolSummary && <span class="work-group-summary">{toolSummary}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} style={{ color: 'var(--fg-faint)', fontSize: 12, marginLeft: 'auto' }} />
      </div>
      {open && <div class="work-group-body">{items.map(renderChild)}</div>}
    </div>
  );
}

/**
 * Quando o turno atual começou. O horário vem do servidor (sobrevive a recarregar a janela e a reconectar);
 * se ele ainda não chegou (a tela soube que está trabalhando um instante antes), usa o momento em que a tela viu.
 */
function useTurnStart(serverStart: number | undefined, running: boolean): number | null {
  const local = useRef<number | null>(null);
  if (!running) local.current = null;
  else if (local.current === null) local.current = Date.now();
  return running ? (serverStart ?? local.current) : null;
}

/** Tempo corrido que se atualiza sozinho a cada segundo (só este pedaço re-renderiza). */
function TurnTimer({ since }: { since: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span class="turn-timer">{formatElapsed(Date.now() - since)}</span>;
}

const PHASE_TEXT: Record<string, string> = {
  starting: 'Iniciando',
  idle: 'Pronto',
  running: 'Trabalhando',
  dormant: 'Pausado',
  reconnecting: 'Reconectando',
  ended: 'Encerrado',
  error: 'Erro',
};

export function Chat({ c }: { c: ChatTab }) {
  void c.version.value; // re-renderiza a cada mudança do modelo
  const st = c.state.value;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    loadChat(c);
  }, [c.sid]);

  // Restaura a rolagem ao trocar de aba.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const saved = scrollPos.get(c.sid);
    stick.current = saved?.stick ?? true;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else el.scrollTop = saved!.top;
    return () => {
      scrollPos.set(c.sid, { top: el.scrollTop, stick: stick.current });
    };
  }, [c.sid]);

  // Acompanha o fim enquanto novas mensagens chegam.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const pendingKeys = [...c.model.pendingPermissions.keys()].join('\n');
  useLayoutEffect(() => {
    if (!pendingKeys) return;
    const el = scroller.current;
    const pending = el?.querySelector<HTMLElement>('.tool.pending-perm');
    if (!el || !pending) return;
    pending.scrollIntoView({ block: 'end' });
    stick.current = false;
  }, [pendingKeys, c.sid]);

  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    if (showJump === atBottom) setShowJump(!atBottom);
  };

  // O Claude às vezes cita só o nome do arquivo e diz a pasta em outra frase: o clique confere onde
  // ele está de verdade (pastas citadas no texto, depois busca pelo nome) em vez de supor a pasta da conversa.
  // Função com identidade ESTÁVEL (lê o estado mais recente por ref): se ela mudasse a cada quadro, o `memo` do
  // Markdown nunca acertaria e todas as mensagens do histórico seriam refeitas a cada pedaço de resposta.
  const stRef = useRef(st);
  stRef.current = st;
  const openPath = useRef((p: string, line?: number, hints?: string[]) => void openChatPath(stRef.current.hostId, stRef.current.cwd, p, { line, hints })).current;

  const items = c.model.items;
  const increases = costIncreases(items);
  // Comentário no meio do trabalho (apagado) x resposta final (com destaque), por turno.
  const roles = textRoles(items);

  // Chave da última mensagem real do usuário (só ela fica fixa no topo para não sobrepor o histórico).
  const lastUserKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'user' && (!it.source || it.source === 'user')) return it.key;
    }
    return null;
  }, [items]);

  const renderItem = (it: Item): any => {
    switch (it.kind) {
      case 'user': {
        const u = it as UserItem;
        if (u.source === 'task') {
          return <InjectedTaskNotificationItem key={u.key} item={u} onOpenPath={openPath} />;
        }
        if (u.source === 'skill') {
          return <InjectedSkillItem key={u.key} item={u} onOpenPath={openPath} />;
        }
        if (u.source === 'hook') {
          return <InjectedHookItem key={u.key} item={u} onOpenPath={openPath} />;
        }
        if (u.source === 'agent') {
          return <InjectedAgentMessageItem key={u.key} item={u} onOpenPath={openPath} />;
        }
        if (u.source === 'auto') {
          return <InjectedAutoItem key={u.key} item={u} onOpenPath={openPath} />;
        }
        const isLatest = it.key === lastUserKey;
        return (
          <div key={it.key} class={`msg user${isLatest ? ' sticky-latest' : ''}`}>
            <div class={`user-bubble${it.pending ? ' pending' : ''}${it.failed ? ' failed' : ''}`}>
              {it.images.length > 0 && (
                <div class="imgs">
                  {it.images.map((img, i) => (
                    <img key={i} src={`data:${img.mediaType};base64,${img.data}`} onClick={() => (lightbox.value = `data:${img.mediaType};base64,${img.data}`)} />
                  ))}
                </div>
              )}
              <UserText text={it.text} />
              {it.failed && <div class="msg-fail">Não enviada: {it.failed}</div>}
            </div>
            {it.at !== undefined && (
              <time class="msg-time" dateTime={new Date(it.at).toISOString()} title={fullSentAt(it.at)}>
                {formatSentAt(it.at)}
              </time>
            )}
          </div>
        );
      }
      case 'text': {
        const role = roles.get(it.key);
        const isResponse = role !== 'step';
        return (
          <div key={it.key} class={`msg${role === 'step' ? ' msg-step' : role === 'final' ? ' msg-final' : ''}${isResponse ? ' msg-response' : ''}${it.streaming ? ' stream-caret-wrap' : ''}`}>
            {isResponse && it.text.trim().length > 0 && <CopyMsgButton text={it.text} />}
            {role === 'final' && <div class="final-label">Resposta</div>}
            <Markdown text={it.text} onOpenPath={openPath} class={it.streaming ? 'streaming' : ''} />
          </div>
        );
      }
      case 'thinking':
        return <Thinking key={it.key} text={it.text} streaming={!!it.streaming} redacted={!!it.redacted} />;
      case 'tool':
        return <ToolCard key={it.key} t={it as ToolItem} c={c} renderChild={renderItem} />;
      case 'result':
        return (
          <div key={it.key} class={`result-line${it.isError && it.subtype !== 'error_during_execution' ? ' error' : ''}`}>
            {it.isError && it.subtype !== 'error_during_execution' && <span>{it.errors?.join(' · ') || `Terminou com erro (${it.subtype})`}</span>}
            {it.durationMs != null && <span title="Duração do turno">{formatDuration(it.durationMs)}</span>}
            {it.tokens && (
              <span class="result-tokens" title={tokensTitle(it)}>
                ↑ {formatTokens(totalInput(it.tokens))} · ↓ {formatTokens(it.tokens.output)} tokens
              </span>
            )}
            {increases.has(it.key) && <span class="result-cost-delta" title="Diferença entre os totais informados pelo Claude Code nesta conversa. Pode incluir agentes; não é cobrança desta pergunta.">Desde a resposta anterior: +{formatCost(increases.get(it.key))}</span>}
            {typeof it.costUsd === 'number' && Number.isFinite(it.costUsd) && it.costUsd > 0 && <span class="result-cost-session" title="Estimativa de preço de tabela informada pelo Claude Code; acumulado da sessão, não valor cobrado por esta pergunta.">Sessão: {formatCost(it.costUsd)}</span>}
          </div>
        );
      case 'notice':
        return (
          <div key={it.key} class={`notice ${it.tone}`}>
            <Icon name={it.tone === 'error' ? 'error' : it.tone === 'warn' ? 'warning' : 'info'} style={{ fontSize: 14, marginTop: 1 }} />
            <span>{it.text}</span>
          </div>
        );
      case 'compact':
        return (
          <div key={it.key}>
            <div class="compact-mark">Conversa compactada</div>
            {it.summary && (
              <details class="thinking" style={{ marginBottom: 12 }}>
                <summary>
                  <Icon name="chevron-right" style={{ fontSize: 12 }} /> Resumo usado como contexto
                </summary>
                <Markdown text={it.summary} />
              </details>
            )}
          </div>
        );
    }
  };

  const blocks = groupChatItems(items, roles);
  const renderBlock = (b: RenderBlock): any => {
    if ('kind' in b && b.kind === 'workgroup') {
      return <WorkGroup key={b.key} items={b.items} c={c} renderChild={renderItem} />;
    }
    return renderItem(b as Item);
  };

  const last = items[items.length - 1];
  const streamingText = last && (last.kind === 'text' || last.kind === 'thinking') && last.streaming;
  const procStart = st.processStartedAt ?? (st.phase !== 'ended' && st.phase !== 'dormant' ? (st.createdAt ?? 0) : undefined);
  const runningAgents = c.model.runningAgents(procStart);
  const hasActiveAgents = runningAgents.length > 0;
  const running = c.model.running || st.phase === 'running';
  const working = (running || hasActiveAgents) && !streamingText && c.model.pendingCount === 0;

  const agentStartTime = useMemo(() => {
    if (!hasActiveAgents) return null;
    let earliest = Infinity;
    for (const a of runningAgents) {
      const tool = c.model.tools.get(a.id);
      if (tool?.at) earliest = Math.min(earliest, tool.at);
    }
    return earliest < Infinity ? earliest : Date.now();
  }, [hasActiveAgents, runningAgents.map((a) => a.id).join(',')]);

  const turnSince = useTurnStart(running ? st.turnStartedAt : (agentStartTime ?? undefined), working);
  const todos = c.model.todos;
  const activeTodo = todos?.find((t: any) => t.status === 'in_progress');

  // Acompanha o transcrito dos agentes em execução para mostrar suas ferramentas ao vivo
  useEffect(() => {
    const running = c.model.runningAgents(procStart);
    if (!running.length) return;
    let cancelled = false;
    const poll = async () => {
      for (const a of running) {
        if (!a.agentId) continue;
        const tool = [...c.model.tools.values()].find((t) => t.id === a.id || t.result?.structured?.agentId === a.agentId);
        if (!tool) continue;
        try {
          const page = await rpc.call<{ lines: any[] }>('history.agent', { sid: c.sid, agentId: a.agentId }, 5000);
          if (!cancelled && page?.lines?.length) {
            c.model.applyAgentTranscript(tool.id, page.lines);
          }
        } catch {
          // Arquivo do agente ainda não criado
        }
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [c.sid, runningAgents.map((a) => `${a.id}:${a.status}`).join(',')]);

  return (
    <div class="chat">
      <ChatHeader c={c} />
      <div class="messages" ref={scroller} onScroll={onScroll}>
        <div class="msg-wrap">
          {c.hasMore.value && (
            <div class="load-earlier">
              <button class="btn secondary" onClick={() => loadEarlier(c).catch((e) => toast(errorText(e), 'error'))}>
                <Icon name="history" /> Carregar mensagens anteriores
              </button>
            </div>
          )}
          {c.loading.value && !items.length && (
            <div class="working">
              <Icon name="loading" class="spin" /> Carregando conversa…
            </div>
          )}
          {c.loadError.value && (
            <div class="notice error">
              <Icon name="error" style={{ fontSize: 14 }} /> {c.loadError.value}
            </div>
          )}
          {!items.length && !c.loading.value && <EmptyConversation c={c} />}
          {blocks.map(renderBlock)}
          {st.phase === 'starting' && (
            <div class="working">
              <Icon name="loading" class="spin" /> Iniciando o Claude {st.hostId === 'local' ? 'neste computador' : `em ${st.hostId}`}
              <span class="dots" />
            </div>
          )}
          {st.phase === 'reconnecting' && (
            <div class="working" style={{ color: 'var(--warn)' }}>
              <Icon name="sync" class="spin" /> Conexão caiu — reconectando. O Claude continua trabalhando no servidor
              <span class="dots" />
            </div>
          )}
          {working && st.phase !== 'starting' && st.phase !== 'reconnecting' && (
            <div class="working">
              <ClaudeLogo size={14} />
              <span>
                {c.model.status === 'compacting' ? 'Compactando a conversa' : activeTodo?.activeForm ?? 'Trabalhando'}
                <span class="dots" />
              </span>
              {turnSince !== null && (
                <span class="working-time" title="Há quanto tempo este turno está trabalhando">
                  <TurnTimer since={turnSince} />
                </span>
              )}
            </div>
          )}
          {st.phase === 'error' && st.error && (
            <div class="notice error">
              <Icon name="error" style={{ fontSize: 14 }} />
              <span style={{ flex: 1 }}>{st.error}</span>
              <button class="btn secondary" style={{ height: 22 }} onClick={() => rpc.call('sessions.start', { sid: c.sid }).catch((e) => toast(errorText(e), 'error'))}>
                Tentar de novo
              </button>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          class="btn secondary jump-bottom"
          onClick={() => {
            const el = scroller.current!;
            el.scrollTop = el.scrollHeight;
            stick.current = true;
            setShowJump(false);
          }}
        >
          <Icon name="arrow-down" /> Ir para o fim
        </button>
      )}
      {todos && todos.length > 0 && (c.model.running || todos.some((t: any) => t.status !== 'completed')) && <TodoStrip todos={todos} />}
      <Composer c={c} />
    </div>
  );
}

function Thinking({ text, streaming, redacted }: { text: string; streaming: boolean; redacted: boolean }) {
  const [open, setOpen] = useState(false);
  if (redacted) return <div class="thinking msg">Raciocínio oculto</div>;
  if (!text.trim() && !streaming) return null;
  return (
    <details class="thinking msg" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: 12 }} />
        {streaming ? (
          <span class="pulse">Pensando…</span>
        ) : (
          <span>Pensou{text.length > 0 ? ` (${Math.max(1, Math.round(text.length / 4 / 100) / 10)}k tokens aprox.)` : ''}</span>
        )}
      </summary>
      {open && <Markdown text={text} />}
    </details>
  );
}

function TodoStrip({ todos }: { todos: any[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  return (
    <div style={{ padding: '0 20px 6px' }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-card)' }}>
        <div class="tool-head" onClick={() => setOpen(!open)}>
          <Icon name="checklist" style={{ color: 'var(--fg-muted)' }} />
          <span class="tool-name">
            Tarefas {done}/{todos.length}
          </span>
          <span class="tool-sum" style={{ fontFamily: 'var(--ui-font)' }}>
            {cur ? cur.activeForm || cur.content : ''}
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-up'} />
        </div>
        {open && (
          <div class="tool-section">
            <ul class="todos">
              {todos.map((t, k) => (
                <li key={k} class={t.status}>
                  <Icon name={t.status === 'completed' ? 'pass-filled' : t.status === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline'} style={{ fontSize: 14, marginTop: 3 }} />
                  <span>{t.content}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ChatHeader({ c }: { c: ChatTab }) {
  // O @preact/signals memoriza componentes pelas props; `c` é sempre o mesmo objeto,
  // então é preciso assinar a versão do modelo para ver "trabalhando"/"pronto" mudar.
  void c.version.value;
  const st = c.state.value;
  const procStart = st.processStartedAt ?? (st.phase !== 'ended' && st.phase !== 'dormant' ? (st.createdAt ?? 0) : undefined);
  const runningAgents = c.model.runningAgents(procStart);
  const isWorking = (c.model.running || st.phase === 'running' || runningAgents.length > 0) && st.phase !== 'dormant' && st.phase !== 'ended';
  const phase = isWorking ? 'running' : st.phase;

  const agentStartTime = useMemo(() => {
    if (!runningAgents.length) return null;
    let earliest = Infinity;
    for (const a of runningAgents) {
      const tool = c.model.tools.get(a.id);
      if (tool?.at) earliest = Math.min(earliest, tool.at);
    }
    return earliest < Infinity ? earliest : Date.now();
  }, [runningAgents.length, runningAgents.map((a) => a.id).join(',')]);

  const turnSince = useTurnStart(st.phase === 'running' ? st.turnStartedAt : (agentStartTime ?? undefined), isWorking);
  // Edita direto na aba (mesmo caminho do duplo clique/F2).
  const rename = () => (renamingSid.value = c.sid);
  return (
    <div class="chat-header">
      <span class="host-chip" style={{ color: hostColor(st.hostId) }}>
        <Icon name={st.hostId === 'local' ? 'device-desktop' : 'remote'} style={{ fontSize: 13 }} />
        {hostLabel(st.hostId)}
      </span>
      <span class="path" title={st.cwd}>
        <span>{tildify(st.cwd, homeOf(st.hostId))}</span>
      </span>
      <span class={`phase-pill ${phase}`} title={st.error ?? ''}>
        {phase === 'running' ? <Icon name="loading" class="spin" style={{ fontSize: 11 }} /> : <Icon name="circle-filled" style={{ fontSize: 8 }} />}
        {PHASE_TEXT[phase] ?? phase}
        {turnSince !== null && (
          <>
            <span class="pill-sep">·</span>
            <TurnTimer since={turnSince} />
          </>
        )}
      </span>
      <button
        class={`icon-btn${isPending(st.hostId, st.sessionId) ? ' pending-toggle' : ''}`}
        title={st.sessionId ? (isPending(st.hostId, st.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização') : 'Envie a primeira mensagem para poder marcar como pendente'}
        disabled={!st.sessionId}
        onClick={() => void setConversationPending(st.hostId, st.sessionId, st.cwd, !isPending(st.hostId, st.sessionId))}
      >
        <Icon name="bookmark" />
      </button>
      <button class="icon-btn" title="Histórico de conversas desta pasta" onClick={() => ((sidebarView.value = 'history'), (sidebarVisible.value = true))}>
        <Icon name="history" />
      </button>
      <button class="icon-btn" title="Nova conversa na mesma pasta" onClick={() => newChat(st.hostId, st.cwd)}>
        <Icon name="add" />
      </button>
      <button
        class="icon-btn"
        title="Mais"
        onClick={(e) =>
          openMenu(e as any, [
            { label: 'Renomear conversa', icon: 'edit', kb: 'F2', action: rename },
            {
              label: isPending(st.hostId, st.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização',
              icon: 'bookmark', disabled: !st.sessionId,
              action: () => void setConversationPending(st.hostId, st.sessionId, st.cwd, !isPending(st.hostId, st.sessionId)),
            },
            { label: 'Nova conversa na mesma pasta', icon: 'add', action: () => newChat(st.hostId, st.cwd) },
            { label: 'Nova conversa em outra pasta…', icon: 'folder-opened', action: () => (folderBrowser.value = { hostId: st.hostId, purpose: 'chat' }) },
            { separator: true },
            {
              label: 'Uso do contexto',
              icon: 'dashboard',
              action: async () => {
                try {
                  const r = await rpc.call('sessions.control', { sid: c.sid, request: { subtype: 'get_context_usage', detail: 'summary' } });
                  const pct = r?.percentage ?? (r?.totalTokens && r?.maxTokens ? Math.round((r.totalTokens / r.maxTokens) * 100) : null);
                  toast(`Contexto: ${r?.totalTokens?.toLocaleString('pt-BR') ?? '?'} de ${r?.maxTokens?.toLocaleString('pt-BR') ?? '?'} tokens${pct != null ? ` (${pct}%)` : ''}`, 'info', 8000);
                } catch (e) {
                  toast(errorText(e), 'error');
                }
              },
            },
            { label: 'Copiar id da sessão', icon: 'copy', disabled: !st.sessionId, action: () => navigator.clipboard.writeText(st.sessionId ?? '') },
            {
              label: 'Copiar comando para retomar no terminal',
              icon: 'terminal',
              disabled: !st.sessionId,
              action: () => navigator.clipboard.writeText(`${st.hostId === 'local' ? '' : `ssh -t ${/\s/.test(st.hostId) ? `"${st.hostId}"` : st.hostId} `}cd ${st.cwd} && claude --resume ${st.sessionId}`),
            },
          ])
        }
      >
        <Icon name="ellipsis" />
      </button>
    </div>
  );
}

function EmptyConversation({ c }: { c: ChatTab }) {
  const st = c.state.value;
  return (
    <div class="empty-chat" style={{ height: 'auto', paddingTop: '12vh' }}>
      <ClaudeLogo size={48} />
      <h2>Nova conversa</h2>
      <div>
        {hostLabel(st.hostId)} · {tildify(st.cwd, homeOf(st.hostId))}
      </div>
      <div style={{ fontSize: 12, maxWidth: 460, lineHeight: 1.5 }}>
        Peça o que precisa. O Claude usa os arquivos, skills, MCPs e CLAUDE.md {st.hostId === 'local' ? 'deste computador' : 'do servidor'}. Arraste imagens para a caixa ou cole com Ctrl+V.
      </div>
    </div>
  );
}

/** Tela inicial quando não há conversas abertas. */
export function Welcome() {
  const recent = hosts.value
    .flatMap((h) => h.recentFolders.slice(0, h.kind === 'local' ? 3 : 2).map((f) => ({ h, f })))
    .filter(({ h }) => h.kind === 'local' || h.favorite)
    .slice(0, 12);
  return (
    <div class="empty-chat">
      <ClaudeLogo size={56} />
      <h2>Claude Deck</h2>
      <div>Claude Code no seu computador e nos seus servidores, lado a lado.</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button class="btn" onClick={() => (newChatPicker.value = {})}>
          <Icon name="comment-discussion" /> Nova conversa
        </button>
        <button class="btn secondary" onClick={() => ((sidebarView.value = 'servers'), (sidebarVisible.value = true))}>
          <Icon name="remote" /> Servidores
        </button>
      </div>
      {recent.length > 0 && (
        <div style={{ marginTop: 18, textAlign: 'left', minWidth: 360 }}>
          <div class="qp-sep">Recentes</div>
          {recent.map(({ h, f }) => (
            <div key={h.id + f} class="tree-row" style={{ paddingLeft: 8 }} onClick={() => newChat(h.id, f)} title={`Nova conversa em ${h.label}: ${f}`}>
              <span class="host-dot" style={{ background: h.color }} />
              <span class="label">{tildify(f, homeOf(h.id))}</span>
              <span class="desc">{h.kind === 'local' ? 'Local' : h.label}</span>
            </div>
          ))}
        </div>
      )}
      <div class="keys">
        <kbd>Ctrl+Shift+N</kbd>
        <span>Nova conversa</span>
        <kbd>Ctrl+P</kbd>
        <span>Abrir arquivo</span>
        <kbd>Ctrl+Shift+P</kbd>
        <span>Comandos</span>
        <kbd>Ctrl+Tab</kbd>
        <span>Próxima conversa</span>
        <kbd>Ctrl+B</kbd>
        <span>Mostrar/ocultar barra lateral</span>
      </div>
    </div>
  );
}

export function Lightbox() {
  const src = lightbox.value;
  if (!src) return null;
  return (
    <div class="overlay" style={{ paddingTop: 0, alignItems: 'center', background: 'rgba(0,0,0,.8)' }} onClick={() => (lightbox.value = null)}>
      <img src={src} style={{ maxWidth: '92vw', maxHeight: '92vh', boxShadow: 'var(--shadow)' }} />
    </div>
  );
}

export { chats };
