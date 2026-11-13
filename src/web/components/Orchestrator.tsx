// Orquestrador: diálogo para criar, painel no topo da conversa do orquestrador (quadro de tarefas, workers, aprovar o
// plano, pausar, parar) e faixa nas conversas dos workers (de qual tarefa são, ir para o orquestrador).
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  activateChat,
  caps,
  chats,
  createOrchestration,
  errorText,
  hostLabel,
  homeOf,
  newOrqDialog,
  orqAction,
  orqOf,
  settings,
  toast,
  type ChatTab,
} from '../lib/state';
import { tildify } from '../../shared/paths';
import type { OrchestrationView, OrqEffort, OrqStatus, OrqTaskStatus, OrqWorkerState, PermissionMode } from '../../shared/types';
import { formatCost } from '../lib/format';
import { MODE_LABELS } from './Composer';
import { Icon } from './icons';

export const ORQ_STATUS_TEXT: Record<OrqStatus, string> = {
  planning: 'Planejando',
  awaiting_approval: 'Esperando sua aprovação',
  running: 'Executando',
  waiting_user: 'Esperando você',
  paused: 'Pausada',
  stalled: 'Parada — precisa de você',
  done: 'Concluída',
  cancelled: 'Cancelada',
};

const TASK_TEXT: Record<OrqTaskStatus, string> = {
  pending: 'pendente',
  in_progress: 'em andamento',
  review: 'em revisão',
  done: 'concluída',
  blocked: 'bloqueada',
  cancelled: 'cancelada',
};

const TASK_ICON: Record<OrqTaskStatus, string> = {
  pending: 'circle-large-outline',
  in_progress: 'loading',
  review: 'eye',
  done: 'pass-filled',
  blocked: 'error',
  cancelled: 'circle-slash',
};

export const WORKER_TEXT: Record<OrqWorkerState, string> = {
  starting: 'iniciando',
  working: 'trabalhando',
  waiting_permission: 'espera sua permissão',
  waiting_answer: 'espera sua resposta',
  idle: 'parado',
  error: 'erro',
  stopped: 'interrompido',
  closed: 'fechado',
};

const EFFORTS: { value: OrqEffort; label: string }[] = [
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muito alto' },
  { value: 'max', label: 'Máximo' },
];

const ROLE_TEXT: Record<string, string> = { implement: 'implementa', review: 'revisa', research: 'pesquisa' };

const EFFORT_TEXT: Record<string, string> = { medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const effortLabel = (e: string) => EFFORT_TEXT[e] ?? e;

const WORKER_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

// ------------------------------------------------------------------ diálogo "Novo orquestrador"

export function NewOrchestratorDialog() {
  const target = newOrqDialog.value;
  if (!target) return null;
  return <NewOrchestratorInner key={`${target.hostId}:${target.cwd}`} hostId={target.hostId} cwd={target.cwd} />;
}

function NewOrchestratorInner({ hostId, cwd }: { hostId: string; cwd: string }) {
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [workerMode, setWorkerMode] = useState<PermissionMode>('default');
  const [maxParallel, setMaxParallel] = useState(3);
  const [requireApproval, setRequireApproval] = useState(true);
  const [model, setModel] = useState(settings.value.defaultModel || '');
  const [effort, setEffort] = useState<OrqEffort>('high');
  const [workerModel, setWorkerModel] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  const models = (caps.value[hostId]?.models ?? []).filter((m) => m.value && m.value !== 'default');
  const close = () => (newOrqDialog.value = null);
  const create = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await createOrchestration({
        hostId,
        cwd,
        goal: goal.trim(),
        title: title.trim() || undefined,
        workerPermissionMode: workerMode,
        maxParallel,
        requireApproval,
        model: model || undefined,
        effort,
        workerModel: workerModel || undefined,
      });
      close();
    } catch (e) {
      toast(`Não consegui criar o orquestrador: ${errorText(e)}`, 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="overlay" onMouseDown={() => !busy && close()}>
      <div
        class="dialog wide orq-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create();
        }}
      >
        <div class="dialog-head">
          <Icon name="organization" />
          <span class="grow">Novo orquestrador</span>
          <span class="orq-dialog-where" title={cwd}>
            {hostLabel(hostId)} · {tildify(cwd, homeOf(hostId))}
          </span>
        </div>
        <div class="dialog-body">
          <div class="field">
            <label>O que você quer construir</label>
            <textarea
              ref={ref}
              class="input orq-goal"
              rows={7}
              value={goal}
              placeholder={'Ex.: no soft router, quero as funções abaixo:\n- OSPF\n- BGP\n- RIP\n- OpenVPN\n- ZeroTier\n- algo tipo netwatch'}
              onInput={(e) => setGoal((e.target as HTMLTextAreaElement).value)}
            />
            <span class="hint">
              O orquestrador estuda o projeto, faz perguntas gerais de planejamento (prioridade, o que é "pronto", como testar), monta o plano e cria uma conversa (worker)
              para cada tarefa, acompanhando até concluir. Perguntas específicas de cada tarefa aparecem na aba do worker.
            </span>
          </div>
          <div class="field">
            <label>Nome (opcional)</label>
            <input class="input" value={title} maxLength={60} placeholder="Ex.: Soft router — protocolos" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </div>
          <div class="orq-row">
            <div class="field" style={{ flex: 1 }}>
              <label>Permissão dos workers</label>
              <select class="input orq-worker-mode" value={workerMode} onChange={(e) => setWorkerMode((e.target as HTMLSelectElement).value as PermissionMode)}>
                {WORKER_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m].label}
                  </option>
                ))}
              </select>
              <span class="hint">{MODE_LABELS[workerMode].desc}. Pedidos de permissão aparecem na aba de cada worker para você.</span>
            </div>
            <div class="field" style={{ width: 150 }}>
              <label>Workers simultâneos</label>
              <select class="input orq-max-parallel" value={String(maxParallel)} onChange={(e) => setMaxParallel(Number((e.target as HTMLSelectElement).value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="orq-row">
            <div class="field" style={{ flex: 1 }}>
              <label>Modelo do orquestrador</label>
              <select class="input orq-model" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
                <option value="">Padrão do servidor</option>
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.displayName}
                  </option>
                ))}
                {model && !models.some((m) => m.value === model) && <option value={model}>{model}</option>}
              </select>
            </div>
            <div class="field" style={{ width: 150 }}>
              <label>Esforço</label>
              <select class="input orq-effort" value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value as OrqEffort)}>
                {EFFORTS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Modelo padrão dos workers</label>
            <select class="input orq-worker-model" value={workerModel} onChange={(e) => setWorkerModel((e.target as HTMLSelectElement).value)}>
              <option value="">O orquestrador escolhe por tarefa</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <span class="hint">
              O orquestrador decide modelo e esforço de cada worker pela dificuldade da tarefa: Médio para o simples, Alto ou acima para o resto (nunca Baixo). Se um
              modelo esgotar no gateway, o Claude Deck troca sozinho para outro disponível e a conversa continua.
            </span>
          </div>
          <label class="check">
            <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval((e.target as HTMLInputElement).checked)} />
            <span>Aprovar o plano antes de criar os workers (recomendado)</span>
          </label>
          <div class="hint orq-files-hint">
            Plano, tarefas, briefings e relatórios ficam em <code>.claude-deck/orq/</code> dentro da pasta do projeto (fora do git).
          </div>
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={close} disabled={busy}>
            Cancelar
          </button>
          <button class="btn" onClick={() => void create()} disabled={!goal.trim() || busy} title="Ctrl+Enter">
            {busy ? <Icon name="loading" class="spin" /> : <Icon name="organization" />} Criar orquestrador
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ painel na conversa do orquestrador

function goToSid(sid: string) {
  if (chats.value.some((c) => c.sid === sid)) activateChat(sid);
  else toast('A aba deste worker não está aberta (pode ter sido fechada). Abra pelo Histórico.', 'info');
}

export function OrqBanner({ c }: { c: ChatTab }) {
  const st = c.state.value;
  if (!st.orq) return null;
  const o = orqOf(st);
  if (!o) return null;
  return st.orq.role === 'orchestrator' ? <OrqPanel o={o} /> : <WorkerStrip o={o} c={c} />;
}

function OrqPanel({ o }: { o: OrchestrationView }) {
  const [open, setOpen] = useState(true);
  const done = o.tasks.filter((t) => t.status === 'done').length;
  const cancelled = o.tasks.filter((t) => t.status === 'cancelled').length;
  const active = o.workers.filter((w) => ['starting', 'working', 'waiting_permission', 'waiting_answer'].includes(w.state));
  const needsYou = o.workers.filter((w) => w.state === 'waiting_permission' || w.state === 'waiting_answer');
  const finished = o.status === 'done' || o.status === 'cancelled';
  const cost = o.workers.reduce((s, w) => s + (w.costUsd ?? 0), 0);
  return (
    <div class={`orq-panel status-${o.status}`}>
      <div class="orq-head" onClick={() => setOpen(!open)} title={open ? 'Recolher o quadro' : 'Mostrar o quadro'}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: 12 }} />
        <Icon name="organization" />
        <span class="orq-title">{o.title}</span>
        <span class={`orq-pill ${o.status}`}>{ORQ_STATUS_TEXT[o.status]}</span>
        <span class="orq-count" title={cost > 0 ? 'Custo somado dos workers (o do orquestrador aparece na própria conversa)' : undefined}>
          {done}/{o.tasks.length - cancelled} tarefas{cancelled ? ` (+${cancelled} cancelada${cancelled > 1 ? 's' : ''})` : ''} · {active.length}/{o.settings.maxParallel} workers ativos
          {cost > 0 ? ` · workers ${formatCost(cost)}` : ''}
        </span>
        {needsYou.length > 0 && (
          <span class="orq-needs" title="Workers esperando você">
            <Icon name="bell-dot" class="pulse" /> {needsYou.length}
          </span>
        )}
        <span class="grow" />
        <span class="orq-actions" onClick={(e) => e.stopPropagation()}>
          {o.status === 'awaiting_approval' && (
            <button class="btn" title="Libera o orquestrador para criar os workers" onClick={() => void orqAction(o.id, 'approve')}>
              <Icon name="check" /> Aprovar plano
            </button>
          )}
          {!finished && o.status !== 'paused' && (
            <button class="icon-btn" title="Pausar: nada mais é entregue sozinho ao orquestrador (os workers seguem no que estão fazendo)" onClick={() => void orqAction(o.id, 'pause')}>
              <Icon name="debug-pause" />
            </button>
          )}
          {o.status === 'paused' && (
            <button class="icon-btn" title="Retomar o acompanhamento automático" onClick={() => void orqAction(o.id, 'resume')}>
              <Icon name="debug-start" />
            </button>
          )}
          {!finished && active.length > 0 && (
            <button class="icon-btn" title="Parar todos os workers (interrompe e pausa a orquestração)" onClick={() => void orqAction(o.id, 'stopWorkers')}>
              <Icon name="debug-stop" />
            </button>
          )}
          {!finished && (
            <button class="icon-btn" title="Cancelar a orquestração" onClick={() => void orqAction(o.id, 'cancel')}>
              <Icon name="close" />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div class="orq-body">
          {o.summary ? (
            <div class="orq-summary done">
              <strong>Resultado:</strong> {o.summary}
            </div>
          ) : (
            o.planSummary && (
              <div class="orq-summary">
                <strong>Plano:</strong> {o.planSummary}
              </div>
            )
          )}
          {!o.tasks.length ? (
            <div class="orq-empty">O orquestrador ainda está entendendo o projeto e montando o plano. As tarefas aparecem aqui.</div>
          ) : (
            <div class="orq-tasks">
              {o.tasks.map((t) => {
                const ws = o.workers.filter((w) => w.taskId === t.id);
                return (
                  <div key={t.id} class={`orq-task ${t.status}`}>
                    <Icon name={TASK_ICON[t.status]} class={t.status === 'in_progress' ? 'spin' : undefined} />
                    <span class="orq-task-id">{t.id}</span>
                    <span class="orq-task-title" title={[t.title, t.deps.length ? `Depende de: ${t.deps.join(', ')}` : '', t.files.length ? `Arquivos: ${t.files.join(', ')}` : ''].filter(Boolean).join('\n')}>
                      {t.title}
                    </span>
                    <span class="orq-task-status">{TASK_TEXT[t.status]}</span>
                    {t.deps.length > 0 && t.status === 'pending' && <span class="orq-task-deps">← {t.deps.join(', ')}</span>}
                    <span class="orq-workers">
                      {ws.map((w) => (
                        <button
                          key={w.id}
                          class={`orq-worker ${w.state}`}
                          title={`${w.id} · ${ROLE_TEXT[w.role] ?? w.role} · ${WORKER_TEXT[w.state]} · esforço ${effortLabel(w.effort)}${w.model ? ` · ${w.model}` : ''}${w.report ? ` · relatório ${w.report}` : ''}\nClique para abrir a conversa`}
                          onClick={() => goToSid(w.sid)}
                        >
                          {w.state === 'waiting_permission' || w.state === 'waiting_answer' ? (
                            <Icon name="bell-dot" class="pulse" />
                          ) : w.state === 'working' || w.state === 'starting' ? (
                            <Icon name="loading" class="spin" />
                          ) : w.state === 'error' ? (
                            <Icon name="error" />
                          ) : w.report ? (
                            <Icon name="pass" />
                          ) : (
                            <Icon name="circle-outline" />
                          )}
                          {w.id}
                        </button>
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {!!o.exhaustedModels?.length && (
            <div class="orq-exhausted" title={o.exhaustedModels.map((x) => `${x.model}: ${x.reason}`).join('\n')}>
              <Icon name="warning" /> Modelos recusados pelo gateway (o Claude Deck troca sozinho):{' '}
              {o.exhaustedModels
                .map((x) => `${x.model} ${x.kind === 'unavailable' ? '(indisponível)' : `(esgotado até ${new Date(x.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})`}`)
                .join(', ')}
            </div>
          )}
          <div class="orq-foot">
            Estado em <code title={o.stateDir}>{o.stateDir}</code> · workers: {MODE_LABELS[o.settings.workerPermissionMode]?.label ?? o.settings.workerPermissionMode}
            {o.settings.requireApproval ? ' · o plano precisa da sua aprovação' : ' · sem aprovação do plano'}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkerStrip({ o, c }: { o: OrchestrationView; c: ChatTab }) {
  const r = c.state.value.orq!;
  const w = o.workers.find((x) => x.id === r.workerId);
  const t = o.tasks.find((x) => x.id === r.taskId);
  return (
    <div class="orq-strip">
      <Icon name="organization" />
      <span>
        Worker <strong>{r.workerId}</strong> · tarefa {t ? `${t.id} — ${t.title}` : r.taskId}
        {w && ` · ${ROLE_TEXT[w.role] ?? w.role} · ${WORKER_TEXT[w.state]} · esforço ${effortLabel(w.effort)}${w.model ? ` · ${w.model}` : ''}`}
      </span>
      <span class="grow" />
      <button class="btn secondary" onClick={() => goToSid(o.orchestratorSid)} title={`Orquestração: ${o.title} (${ORQ_STATUS_TEXT[o.status]})`}>
        <Icon name="arrow-up" /> Orquestrador
      </button>
    </div>
  );
}
