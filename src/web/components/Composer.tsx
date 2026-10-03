// Caixa de mensagem: texto, imagens coladas, comandos (/), menções de arquivo (@), modo e modelo.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { rpc, RpcError } from '../lib/rpc';
import {
  activeFile,
  caps,
  editorContextFor,
  interruptChat,
  isLiveTerminal,
  sendMessage,
  setChatMode,
  setChatModel,
  setChatEffort,
  toggleChatExecutionMode,
  settings,
  toast,
  platformOf,
  type ChatTab,
} from '../lib/state';
import { flattenToolResult, type AgentRun, type ImageData } from '../lib/chatModel';
import type { EffortLevel, PermissionMode } from '../../shared/types';
import { Icon } from './icons';
import { openMenu } from './ContextMenu';
import { fuzzyScore } from '../lib/format';
import { cachePillLabel, cacheTooltip, cacheWindowAt } from '../lib/promptCache';
import { compactAction, contextAriaLabel, contextMeter, contextTooltip, contextUnknownTooltip, pieStroke } from '../lib/contextUsage';
import { basename, relativeTo } from '../../shared/paths';

export const MODE_LABELS: Record<PermissionMode, { label: string; icon: string; desc: string }> = {
  default: { label: 'Pedir permissão', icon: 'shield', desc: 'Pergunta antes de editar arquivos e rodar comandos' },
  acceptEdits: { label: 'Aceitar edições', icon: 'edit', desc: 'Edita arquivos sem perguntar; comandos ainda pedem permissão' },
  plan: { label: 'Planejar', icon: 'checklist', desc: 'Só lê e planeja; não altera nada até você aprovar o plano' },
  auto: { label: 'Automático', icon: 'sparkle', desc: 'Um classificador aprova o que é seguro e pergunta o resto' },
  bypassPermissions: { label: 'Ignorar permissões', icon: 'warning', desc: 'Executa tudo sem perguntar (cuidado em servidores de clientes)' },
  dontAsk: { label: 'Não perguntar', icon: 'circle-slash', desc: 'Nega o que não estiver pré-autorizado' },
};
const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
const EFFORT_LABELS: Record<EffortLevel, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };

const BUILTIN_COMMANDS = [
  { name: 'clear', description: 'Começar uma conversa nova nesta mesma aba (a atual fica no histórico)' },
  { name: 'compact', description: 'Resumir a conversa para liberar contexto' },
  { name: 'context', description: 'Mostrar o uso do contexto' },
  { name: 'cost', description: 'Mostrar custo e uso da sessão' },
  { name: 'init', description: 'Criar um CLAUDE.md para o projeto' },
  { name: 'review', description: 'Revisar as alterações' },
];

const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

async function fileToImage(f: File): Promise<ImageData | null> {
  if (!f.type.startsWith('image/')) return null;
  const okType = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type);
  if (okType && f.size <= MAX_IMAGE_BYTES) {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mediaType: f.type, data: btoa(bin) };
  }
  // Grande demais (ou formato não aceito): reduz para JPEG.
  const bmp = await createImageBitmap(f);
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    const data = url.slice(url.indexOf(',') + 1);
    if (data.length * 0.75 <= MAX_IMAGE_BYTES) return { mediaType: 'image/jpeg', data };
    scale *= 0.7;
  }
  return null;
}

/** Dica do indicador de agentes: um por linha, com o tipo e o que está fazendo. */
function agentsTooltip(agents: AgentRun[]): string {
  const lines = agents.map((a) => `• ${a.type ?? 'Agente'}${a.description ? ` — ${a.description}` : ''}${a.background ? ' (segundo plano)' : ''}`);
  return `${agents.length === 1 ? '1 agente em execução' : `${agents.length} agentes em execução`}\n${lines.join('\n')}`;
}

/**
 * Uso do contexto (a "pizza" da extensão do Claude Code), sempre visível: a dica mostra o uso e a janela do modelo;
 * clicar manda `/compact` direto no chat, sem confirmação. Enquanto a janela não é conhecida
 * (conversa nova ou reaberta, antes do primeiro turno terminar) o anel fica vazio, mas o clique continua valendo.
 * Com o Claude trabalhando o clique não compacta no meio do turno: manda o `/compact` do mesmo jeito, e o Claude Code
 * o deixa na fila dele e o roda quando o turno termina (como a extensão do VS Code: o clique chama o mesmo envio de
 * mensagem). Um segundo clique não enfileira outro `/compact`: só avisa que já está na fila.
 */
function ContextPie({ c, running }: { c: ChatTab; running: boolean }) {
  void c.version.value; // mensagem nova / resultado do turno → uso novo
  const usage = c.model.contextUsage;
  const m = contextMeter(usage);
  const { radius, circumference, filled } = pieStroke(m?.percentUsed ?? 0);
  const action = compactAction(running, c.model.compactState());
  const compact = () => {
    if (action === 'queued') {
      toast('O /compact já está na fila: roda quando o Claude terminar o que está fazendo.', 'info');
      return;
    }
    if (action === 'compacting') {
      toast('O Claude já está compactando.', 'info');
      return;
    }
    if (action === 'enqueue') toast('/compact na fila: roda quando o Claude terminar o que está fazendo.', 'info');
    void sendMessage(c, '/compact', []);
  };
  return (
    <button
      class="ctx-pie"
      type="button"
      title={m ? contextTooltip(m, action) : contextUnknownTooltip(usage, action)}
      aria-label={contextAriaLabel(m, action)}
      data-compact={action === 'queued' || action === 'compacting' ? action : undefined}
      data-context-state={m ? 'known' : 'unknown'}
      data-context-basis={m?.basis}
      data-context-percent={m ? Math.round(m.percentUsed) : undefined}
      onClick={compact}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ display: 'block' }}>
        <circle cx="10" cy="10" r={radius} stroke="currentColor" stroke-opacity="0.15" stroke-width="1.5" />
        {/* Em 0% nada a desenhar: um traço de comprimento zero com ponta redonda aparece como um pontinho. */}
        {filled > 0 && <circle cx="10" cy="10" r={radius} stroke="var(--claude)" stroke-width="1.5" stroke-linecap="round" stroke-dasharray={`${filled} ${circumference}`} transform="rotate(-90 10 10)" />}
      </svg>
    </button>
  );
}

/**
 * Contador do cache de prompt (como o da extensão do Claude Code): minutos até o cache da conversa expirar;
 * vencido, só o ícone em vermelho. Some enquanto não houver dado (CLI/gateway que não informa cache).
 * O relógio é daqui, não do Composer: re-renderizar o compositor inteiro a cada segundo seria desperdício.
 */
function CachePill({ c }: { c: ChatTab }) {
  void c.version.value; // chamada nova ao modelo → registro novo
  const [, tick] = useState(0);
  const w = cacheWindowAt(c.model.promptCache, Date.now());
  const period = w.kind === 'warm' ? 1000 : w.kind === 'cold' ? 15_000 : 0; // vencido: só o "ocioso há" da dica muda
  useEffect(() => {
    if (!period) return;
    const id = setInterval(() => tick((x) => x + 1), period);
    return () => clearInterval(id);
  }, [period]);
  if (w.kind === 'unknown') return null;
  const label = cachePillLabel(w);
  const tip = cacheTooltip(w);
  return (
    <span class={`pill-select cache-pill${w.kind === 'cold' ? ' cold' : ''}`} role="status" aria-live="off" aria-label={tip} title={tip} data-cache-window={w.kind}>
      <Icon name="watch" style={{ fontSize: 13 }} />
      {label !== undefined && <span class="cache-pill-time">{label}</span>}
    </span>
  );
}

function AgentRunsDialog({ c, agents, onClose }: { c: ChatTab; agents: AgentRun[]; onClose: () => void }) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const transcriptRequest = useRef(0);
  useEffect(() => () => { transcriptRequest.current++; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const loadTranscript = async (agent: AgentRun, prev?: number) => {
    if (!agent.agentId) return;
    if (prev === undefined) { setTranscript(''); setBefore(null); }
    setOpenTranscript(agent.id);
    setLoading(true);
    const request = ++transcriptRequest.current;
    try {
      const page = await rpc.call<{ lines: any[]; start: number }>('history.agent', { sid: c.sid, agentId: agent.agentId, before: prev }, 60_000);
      if (request !== transcriptRequest.current) return;
      const text = page.lines.map((line) => {
        const blocks = line.message?.content;
        const parts = Array.isArray(blocks) ? blocks.map((b: any) => b?.type === 'tool_use' ? `[${b.name}]\n${JSON.stringify(b.input ?? {}, null, 2)}` : b?.type === 'tool_result' ? `[resultado de ferramenta]\n${flattenToolResult(b.content).text}` : b?.text ?? b?.thinking ?? '').filter(Boolean) : typeof blocks === 'string' ? [blocks] : [];
        return parts.length ? `${line.type === 'assistant' ? 'Agente' : line.type === 'user' ? 'Pedido/resultado' : line.type}: ${parts.join('\n')}` : '';
      }).filter(Boolean).join('\n\n');
      setTranscript((cur) => prev !== undefined ? `${text}\n\n${cur}` : text || 'O agente ainda não escreveu no transcrito.');
      setBefore(page.start > 0 ? page.start : null);
    } catch (e) {
      if (request !== transcriptRequest.current) return;
      setTranscript(e instanceof RpcError && e.code === 'nomethod'
        ? 'Ler o transcrito exige a versão nova do servidor do Claude Deck. Reinicie-o quando todas as conversas estiverem paradas; recarregar a janela não atualiza o servidor.'
        : `Não consegui ler o transcrito: ${String(e instanceof Error ? e.message : e)}`);
      setBefore(null);
    } finally { if (request === transcriptRequest.current) setLoading(false); }
  };
  const stop = async (agent: AgentRun) => {
    if (!agent.taskId || stopping) return;
    setStopping(agent.taskId);
    try { await rpc.call('sessions.stopTask', { sid: c.sid, taskId: agent.taskId }); }
    catch (e) {
      toast(e instanceof RpcError && e.code === 'nomethod'
        ? 'Parar uma tarefa exige a versão nova do servidor do Claude Deck. Reinicie-o quando todas as conversas estiverem paradas; recarregar a janela não atualiza o servidor.'
        : `Não consegui parar ${agent.description || 'a tarefa'}: ${String(e instanceof Error ? e.message : e)}`, 'error', 8000);
    }
    finally { setStopping(null); }
  };
  return (
    <div class="overlay" onMouseDown={onClose}>
      <div class="dialog wide agents-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <Icon name="hubot" style={{ color: 'var(--claude)' }} />
          <span class="grow">Mapa de agentes e tarefas ({agents.length})</span>
          <button class="icon-btn" title="Fechar (Esc)" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div class="dialog-body">
          {agents.map((agent) => (
            <section class="agent-run" key={agent.id}>
              <div class="agent-run-head">
                <strong>{agent.description || (agent.kind === 'task' ? 'Tarefa em segundo plano' : 'Agente sem nome informado')}</strong>
                <span class={`agent-run-state ${agent.status ?? 'working'}${agent.background ? ' background' : ''}`}>
                  {agent.status === 'failed' ? 'Falhou' : agent.status === 'killed' ? 'Parado' : agent.status === 'completed' ? 'Concluído' : agent.background ? 'Segundo plano' : 'Em execução'}
                </span>
              </div>
              <dl class="agent-run-meta">
                <div><dt>Tipo</dt><dd>{agent.type ?? (agent.kind === 'task' ? 'Tarefa' : 'Agente')}</dd></div>
                {agent.kind !== 'task' && <div><dt>Modelo usado</dt><dd>{agent.model ?? 'Ainda não informado pelo Claude Code'}</dd></div>}
                {agent.models && agent.models.length > 1 && <div class="agent-run-models"><dt>Modelos usados</dt><dd>{agent.models.join(' · ')}</dd></div>}
              </dl>
              {agent.prompt && <><div class="agent-prompt-label">Pedido enviado ao agente</div><pre class="agent-prompt">{agent.prompt}</pre></>}
              <div class="agent-run-actions">
                {agent.kind !== 'task' && agent.agentId && <button class="btn secondary" onClick={() => { if (openTranscript === agent.id) { transcriptRequest.current++; setOpenTranscript(null); setLoading(false); } else void loadTranscript(agent); }}>
                  {openTranscript === agent.id ? 'Fechar transcrito' : 'Ver transcrito'}
                </button>}
                {agent.status === 'working' && agent.taskId && <button class="btn secondary" disabled={stopping === agent.taskId} onClick={() => void stop(agent)}>
                  {stopping === agent.taskId ? 'Parando…' : 'Parar só esta tarefa'}
                </button>}
              </div>
              {openTranscript === agent.id && <div class="agent-transcript">
                {before !== null && <button class="btn secondary" disabled={loading} onClick={() => void loadTranscript(agent, before)}>{loading ? 'Carregando…' : 'Carregar anteriores'}</button>}
                <pre>{loading && !transcript ? 'Carregando transcrito…' : transcript}</pre>
              </div>}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const fileListCache = new Map<string, { at: number; files: string[] }>();

async function listFilesFor(hostId: string, cwd: string): Promise<string[]> {
  const k = `${hostId}::${cwd}`;
  const c = fileListCache.get(k);
  if (c && Date.now() - c.at < 60_000) return c.files;
  const files: string[] = await rpc.call('fs.findFiles', { h: hostId, root: cwd, limit: 20000 }, 60_000);
  fileListCache.set(k, { at: Date.now(), files });
  return files;
}

interface Suggestion {
  kind: 'command' | 'file';
  value: string;
  label: string;
  desc?: string;
}

export function Composer({ c }: { c: ChatTab }) {
  void c.version.value; // re-renderiza quando o modelo muda (rodando, permissões pendentes)
  const st = c.state.value;
  const [text, setText] = useState(c.draft);
  const [images, setImages] = useState<ImageData[]>(c.images);
  const [drag, setDrag] = useState(false);
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [suggIdx, setSuggIdx] = useState(0);
  const [includeFile, setIncludeFile] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string; fromLine: number; toLine: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionSeq = useRef(0);
  const processAlive = st.phase === 'running' || st.phase === 'idle' || st.phase === 'starting' || st.phase === 'reconnecting';
  const procStart = st.processStartedAt ?? (processAlive ? (st.createdAt ?? 0) : undefined);
  const agents = processAlive ? c.model.runningAgents(procStart) : [];
  const running = c.model.running || st.phase === 'running' || agents.length > 0;
  const hostCaps = caps.value[st.hostId];
  const mode = (st.permissionMode ?? 'default') as PermissionMode;
  const f = activeFile.value;
  const fileCtx = f && f.hostId === st.hostId ? f : null;

  const agentMap = c.model.agentMap(procStart).filter((a) => processAlive || a.status !== 'working');
  const taskCount = agentMap.filter((a) => a.status === 'working').length;
  const agentFailed = agentMap.some((a) => a.status === 'failed');

  // Chat é recriado (key=sid) ao trocar de aba: o useState já carrega o rascunho.
  // Um useEffect que reseta o texto pode rodar depois da primeira tecla/Enter e apagar
  // a mensagem digitada depressa numa aba recém-aberta.
  useLayoutEffect(() => {
    autosize();
    ta.current?.focus();
  }, [c.sid]);

  useEffect(() => {
    c.draft = text;
    c.images = images;
  }, [text, images]);
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);

  // Seleção no editor vira contexto (como a extensão faz).
  useEffect(() => {
    const onSel = (e: Event) => setSelection((e as CustomEvent).detail);
    window.addEventListener('deck:selection', onSel);
    const onMention = (e: Event) => insertAtCursor(`@${mentionPath((e as CustomEvent).detail.path)} `);
    window.addEventListener('deck:mention', onMention);
    const onFocus = () => ta.current?.focus();
    window.addEventListener('deck:focus-composer', onFocus);
    return () => {
      window.removeEventListener('deck:selection', onSel);
      window.removeEventListener('deck:mention', onMention);
      window.removeEventListener('deck:focus-composer', onFocus);
    };
  }, [c.sid]);

  const mentionPath = (p: string) => {
    const rel = relativeTo(platformOf(st.hostId), st.cwd, p);
    return (rel ?? p).replace(/\\/g, '/');
  };

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
  };

  const insertAtCursor = (s: string) => {
    const el = ta.current;
    if (!el) return;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + s.length;
      autosize();
    });
  };

  const updateSuggestions = async (value: string, caret: number) => {
    const seq = ++suggestionSeq.current;
    const before = value.slice(0, caret);
    const slash = before.match(/^\/([\w:.-]*)$/);
    if (slash) {
      const q = slash[1];
      const cmds = [...BUILTIN_COMMANDS, ...(hostCaps?.commands ?? []).filter((x) => !BUILTIN_COMMANDS.some((b) => b.name === x.name))];
      const list = cmds
        .map((cmd) => ({ cmd, s: q ? fuzzyScore(q, cmd.name) : 0 }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map(({ cmd }) => ({ kind: 'command' as const, value: `/${cmd.name} `, label: `/${cmd.name}`, desc: cmd.description.replace(/\s*\((user|project|plugin[^)]*)\)$/, '') }));
      setSugg(list);
      setSuggIdx(0);
      return;
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const q = at[1];
      try {
        const files = await listFilesFor(st.hostId, st.cwd);
        const scored = files
          .map((p) => ({ p, s: q ? fuzzyScore(q, p) : 1000 - p.split('/').length }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 40);
        // Busca lenta/teclas rápidas: só a resposta da última tecla pode trocar a lista.
        if (seq !== suggestionSeq.current || ta.current?.value !== value || ta.current.selectionStart !== caret) return;
        setSugg(scored.map(({ p }) => ({ kind: 'file' as const, value: `@${p} `, label: basename(p), desc: p })));
        setSuggIdx(0);
      } catch {
        if (seq === suggestionSeq.current) setSugg([]);
      }
      return;
    }
    if (sugg.length) setSugg([]);
  };

  const applySuggestion = (s: Suggestion) => {
    const el = ta.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const start = s.kind === 'command' ? 0 : before.lastIndexOf('@');
    const next = before.slice(0, start) + s.value + after;
    setText(next);
    setSugg([]);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + s.value.length;
      autosize();
    });
  };

  const send = () => {
    if (!text.trim() && !images.length) return;
    const ctx = editorContextFor(c, selection, includeFile && !!fileCtx);
    sendMessage(c, text, images, ctx);
    setText('');
    setImages([]);
    setSugg([]);
    requestAnimationFrame(autosize);
  };

  const handleStop = async () => {
    if (st.phase === 'running' || c.model.running) {
      interruptChat(c);
    }
    if (agents.length > 0) {
      for (const a of agents) {
        if (a.taskId) {
          try {
            await rpc.call('sessions.stopTask', { sid: c.sid, taskId: a.taskId });
          } catch {}
        }
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (sugg.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggIdx((i) => Math.min(i + 1, sugg.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(sugg[suggIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSugg([]);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const i = MODE_CYCLE.indexOf(mode);
      setChatMode(c, MODE_CYCLE[(i + 1) % MODE_CYCLE.length]);
      return;
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      void handleStop();
      return;
    }
    const ctrlSend = settings.value.sendWithCtrlEnter;
    if (e.key === 'Enter' && !e.isComposing) {
      if ((ctrlSend && (e.ctrlKey || e.metaKey)) || (!ctrlSend && !e.shiftKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        send();
      }
    }
  };

  const addFiles = async (list: FileList | File[]) => {
    const out: ImageData[] = [];
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) {
        toast(`${file.name}: só imagens podem ser anexadas. Para outros arquivos, envie pelo explorador e mencione com @.`, 'info', 6000);
        continue;
      }
      const img = await fileToImage(file);
      if (img) out.push(img);
      else toast(`Imagem grande demais: ${file.name}`, 'error');
    }
    if (out.length) setImages((cur) => [...cur, ...out].slice(0, 20));
  };

  const modeInfo = MODE_LABELS[mode] ?? MODE_LABELS.default;
  const live = isLiveTerminal(c);
  const models = hostCaps?.models ?? [];
  const modelLabel = st.model ? (models.find((m) => m.value === st.model || st.model!.startsWith(m.value))?.displayName ?? st.model) : 'Modelo';
  const pendingCount = c.model.pendingCount;
  // Uma permissão que chega enquanto o painel dos agentes está aberto precisa ficar visível imediatamente.
  useEffect(() => {
    if (pendingCount) setAgentsOpen(false);
  }, [pendingCount]);
  const effortBusy = running || pendingCount > 0 || !['idle', 'dormant'].includes(st.phase);
  const effortLabel = st.effort ? EFFORT_LABELS[st.effort] : 'Padrão';

  return (
    <>
      <div class="composer-wrap">
      {pendingCount > 0 && (
        <div style={{ maxWidth: 920, margin: '0 auto 6px', display: 'flex', justifyContent: 'center' }}>
          <button class="btn" style={{ background: '#9a6700' }} onClick={() => document.querySelector('.chat .messages .tool.pending-perm')?.scrollIntoView({ behavior: 'smooth', block: 'end' })}>
            <Icon name="shield" /> O Claude está esperando sua permissão ({pendingCount}) — ver
          </button>
        </div>
      )}
      <div
        class={`composer${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('application/x-deck-path')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          setDrag(false);
          const deck = e.dataTransfer?.getData('application/x-deck-path');
          if (deck) {
            e.preventDefault();
            const { path } = JSON.parse(deck);
            insertAtCursor(`@${mentionPath(path)} `);
            return;
          }
          if (e.dataTransfer?.files.length) {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }
        }}
      >
        {sugg.length > 0 && (
          <div class="suggest">
            {sugg.map((s, i) => (
              <div key={s.value} class={`suggest-item${i === suggIdx ? ' active' : ''}`} onMouseDown={(e) => (e.preventDefault(), applySuggestion(s))} onMouseMove={() => setSuggIdx(i)}>
                <Icon name={s.kind === 'command' ? 'symbol-event' : 'file'} style={{ fontSize: 14, color: 'var(--fg-muted)' }} />
                <span class="name">{s.label}</span>
                <span class="desc">{s.desc}</span>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div class="attach-row">
            {images.map((img, i) => (
              <div key={i} class="attach">
                <img src={`data:${img.mediaType};base64,${img.data}`} />
                <button title="Remover" onClick={() => setImages(images.filter((_, k) => k !== i))}>
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={running ? 'O Claude está trabalhando… (pode mandar outra mensagem; Esc para parar)' : `Mensagem para o Claude ${st.hostId === 'local' ? 'neste computador' : `em ${st.hostId}`}…  (/ comandos, @ arquivos)`}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            setText(el.value);
            autosize();
            updateSuggestions(el.value, el.selectionStart ?? el.value.length);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.some((x) => x.type.startsWith('image/'))) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            blurTimer.current = null;
          }}
          onBlur={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            blurTimer.current = setTimeout(() => {
              blurTimer.current = null;
              if (document.activeElement !== ta.current) setSugg([]);
            }, 150);
          }}
          spellcheck={false}
        />
        <div class="composer-bar">
          <button
            class={`pill-select mode-${mode}`}
            title={`${modeInfo.desc}\n(Shift+Tab alterna)`}
            onClick={(e) =>
              openMenu(
                e as any,
                (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[]).map((m) => ({
                  label: `${MODE_LABELS[m].label}${m === mode ? '  ✓' : ''}`,
                  icon: MODE_LABELS[m].icon,
                  danger: m === 'bypassPermissions',
                  action: () => setChatMode(c, m),
                })),
              )
            }
          >
            <Icon name={modeInfo.icon} style={{ fontSize: 13 }} /> {modeInfo.label}
          </button>
          <button
            class={`pill-select${live ? ' mode-live-terminal' : ''}`}
            title={
              live
                ? 'Terminal ao Vivo: o Claude digita no terminal ao lado e recebe a saída real. Para assumir o teclado, pare o Claude antes. Troque o modo entre tarefas.'
                : 'Silencioso: o Claude roda os comandos em segundo plano (Bash). Clique para ele digitar no terminal ao lado, à sua vista.'
            }
            disabled={running || st.phase === 'starting' || st.phase === 'reconnecting'}
            onClick={() => toggleChatExecutionMode(c)}
          >
            <Icon name={live ? 'terminal' : 'comment'} style={{ fontSize: 13 }} /> {live ? 'Terminal ao Vivo' : 'Silencioso'}
          </button>
          <button
            class="pill-select"
            title="Modelo desta conversa"
            onClick={(e) =>
              openMenu(e as any, [
                { label: 'Padrão do servidor', icon: 'circle-large-outline', action: () => setChatModel(c, null) },
                ...(models.length ? [{ separator: true }] : []),
                ...models
                  .filter((m) => m.value !== 'default')
                  .map((m) => ({ label: `${m.displayName}${st.model === m.value ? '  ✓' : ''}`, icon: 'hubot', action: () => setChatModel(c, m.value) })),
                ...(!models.length ? [{ label: 'Lista de modelos aparece após o Claude iniciar', icon: 'info', disabled: true }] : []),
                { separator: true },
                { label: effortBusy ? 'Nível de esforço (aguarde o fim da tarefa)' : 'Nível de esforço', icon: 'info', disabled: true },
                { label: `Padrão do Claude Code${!st.effort ? '  ✓' : ''}`, icon: 'circle-large-outline', disabled: effortBusy, action: () => setChatEffort(c, null) },
                ...(Object.entries(EFFORT_LABELS) as [EffortLevel, string][]).map(([value, label]) => ({
                  label: `${label}${st.effort === value ? '  ✓' : ''}`,
                  icon: 'sparkle',
                  disabled: effortBusy,
                  action: () => setChatEffort(c, value),
                })),
              ])
            }
          >
            <Icon name="hubot" style={{ fontSize: 13 }} /> {modelLabel} · {effortLabel}
          </button>
          {agentMap.length > 0 && (
            <button class={`pill-select agents-pill${agentFailed ? ' failed' : ''}`} title={`${agentsTooltip(agents)}\nClique para abrir o mapa.`} onClick={() => setAgentsOpen(true)}>
              <Icon name={taskCount ? 'loading' : 'hubot'} class={taskCount ? 'spin' : ''} style={{ fontSize: 13 }} /> {agents.length ? `${agents.length} ${agents.length === 1 ? 'agente' : 'agentes'}` : 'Agentes'}
            </button>
          )}
          <ContextPie c={c} running={running} />
          <CachePill c={c} />
          {fileCtx && (
            <button
              class={`ctx-chip${includeFile || selection ? '' : ' off'}`}
              title={includeFile ? 'O arquivo aberto no editor vai como contexto (clique para não enviar)' : 'Clique para enviar o arquivo aberto como contexto'}
              onClick={() => setIncludeFile(!includeFile)}
            >
              <Icon name={selection ? 'selection' : 'file'} style={{ fontSize: 12 }} />
              <span>{selection ? `${fileCtx.name}:${selection.fromLine}-${selection.toLine}` : fileCtx.name}</span>
            </button>
          )}
          <span class="grow" />
          <button
            class="icon-btn"
            title="Anexar imagem"
            onClick={() => {
              const inp = document.createElement('input');
              inp.type = 'file';
              inp.accept = 'image/*';
              inp.multiple = true;
              inp.onchange = () => inp.files && addFiles(inp.files);
              inp.click();
            }}
          >
            <Icon name="file-media" />
          </button>
          {running && (
            <button class="send-btn stop" title={live ? 'Parar o Claude e a espera. O comando no terminal pode continuar; use Ctrl+C nele para interromper.' : 'Parar (Esc)'} onClick={handleStop}>
              <Icon name="debug-stop" />
            </button>
          )}
          <button class="send-btn" title="Enviar (Enter)" disabled={!text.trim() && !images.length} onClick={send}>
            <Icon name="send" />
          </button>
        </div>
      </div>
      <div class="composer-hint">
        <span>
          {settings.value.sendWithCtrlEnter ? 'Ctrl+Enter envia · Enter quebra linha' : 'Enter envia · Shift+Enter quebra linha'} · Esc para · Shift+Tab muda o modo
        </span>
        <span>{st.claudeVersion ? `Claude Code ${st.claudeVersion}` : ''}</span>
      </div>
      </div>
      {agentsOpen && agentMap.length > 0 && <AgentRunsDialog c={c} agents={agentMap} onClose={() => setAgentsOpen(false)} />}
    </>
  );
}

export function useMemoized<T>(fn: () => T, deps: any[]) {
  return useMemo(fn, deps);
}
