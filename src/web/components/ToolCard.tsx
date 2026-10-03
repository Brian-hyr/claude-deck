// Cartões das ferramentas do Claude (Edit/Write com diff, Bash, Read, Task...) e pedidos de permissão.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { structuredPatch } from 'diff';
import type { ChatTab } from '../lib/state';
import { openFile, relPath, resolveInCwd, respondPermission, interruptChat } from '../lib/state';
import { forUserSettings, permissionChoiceLabel } from '../lib/permissionChoice';
import { awaitsUser, isAgentTool, type Item, type PermissionReq, type ToolItem } from '../lib/chatModel';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { highlightCode } from '../lib/markdown';
import { extname } from '../../shared/paths';
import { rpc } from '../lib/rpc';

// ------------------------------------------------------------------ diff

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

function hunksFor(oldStr: string, newStr: string): Hunk[] {
  try {
    return structuredPatch('a', 'b', oldStr, newStr, '', '', { context: 3 }).hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines }));
  } catch {
    return [];
  }
}

function countLines(hunks: Hunk[]) {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0;
  return { add, del };
}

export function DiffView({ hunks, numbers = true, maxLines = 400 }: { hunks: Hunk[]; numbers?: boolean; maxLines?: number }) {
  const [all, setAll] = useState(false);
  let shown = 0;
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  return (
    <div class="diff">
      {hunks.map((h, hi) => {
        let o = h.oldStart;
        let n = h.newStart;
        if (!all && shown >= maxLines) return null;
        return (
          <div key={hi}>
            {hunks.length > 1 && numbers && <div class="diff-hunk">@@ -{h.oldStart} +{h.newStart} @@</div>}
            {h.lines.map((l, li) => {
              if (!all && shown >= maxLines) return null;
              shown++;
              const sign = l[0];
              const cls = sign === '+' ? 'add' : sign === '-' ? 'del' : '';
              const ln = sign === '-' ? o++ : sign === '+' ? n++ : (o++, n++);
              if (sign === '\\') return null;
              return (
                <div key={li} class={`diff-line ${cls}`}>
                  {numbers && <span class="ln">{ln}</span>}
                  <span class="sign">{sign === ' ' ? '' : sign}</span>
                  <span class="code">{l.slice(1)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {!all && total > maxLines && (
        <button class="more-btn" style={{ margin: '4px 10px' }} onClick={() => setAll(true)}>
          Mostrar mais {total - maxLines} linhas
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ resumo por ferramenta

function toolDisplay(t: ToolItem, c: ChatTab) {
  const i = t.input ?? {};
  const cwd = c.state.value.cwd;
  const hostId = c.state.value.hostId;
  const open = (p: string, line?: number) => openFile(hostId, resolveInCwd(hostId, cwd, p), { line });
  const pathLink = (p?: string, line?: number) =>
    p ? (
      <a
        onClick={(e) => {
          e.stopPropagation();
          open(p, line);
        }}
        title={p}
      >
        {relPath(hostId, p)}
        {line ? `:${line}` : ''}
      </a>
    ) : null;
  const name = t.name;
  if (name === 'Read') return { icon: 'eye', label: 'Leu', sum: <>{pathLink(i.file_path, i.offset)}{i.limit ? ` (${i.limit} linhas)` : ''}</> };
  if (name === 'Write') return { icon: 'new-file', label: 'Escreveu', sum: pathLink(i.file_path) };
  if (name === 'Edit' || name === 'MultiEdit') return { icon: 'edit', label: 'Editou', sum: pathLink(i.file_path) };
  if (name === 'NotebookEdit') return { icon: 'notebook', label: 'Notebook', sum: pathLink(i.notebook_path) };
  if (name === 'Bash' || name === 'PowerShell' || name === 'BashOutput')
    return { icon: name === 'PowerShell' ? 'terminal-powershell' : 'terminal', label: name, sum: <span>{i.description ? `${i.description} — ` : ''}{String(i.command ?? i.bash_id ?? '').split('\n')[0]}</span> };
  if (name === 'Glob') return { icon: 'search', label: 'Procurou arquivos', sum: <span>{i.pattern}{i.path ? ` em ${relPath(hostId, i.path)}` : ''}</span> };
  if (name === 'Grep') return { icon: 'search', label: 'Buscou', sum: <span>"{i.pattern}"{i.path ? ` em ${relPath(hostId, i.path)}` : ''}{i.glob ? ` (${i.glob})` : ''}</span> };
  if (name === 'WebFetch') return { icon: 'globe', label: 'Abriu', sum: <a href={i.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{i.url}</a> };
  if (name === 'WebSearch') return { icon: 'globe', label: 'Pesquisou na web', sum: <span>{i.query}</span> };
  if (name === 'Task' || name === 'Agent') {
    const childTools = t.children.filter((ch) => ch.kind === 'tool').length;
    return {
      icon: 'hubot',
      label: i.subagent_type ? `Agente (${i.subagent_type})` : 'Agente',
      sum: <span>{i.description}{childTools > 0 ? ` · ${childTools} ${childTools === 1 ? 'execução' : 'execuções'}` : ''}</span>,
    };
  }
  if (name === 'TodoWrite') return { icon: 'checklist', label: 'Tarefas', sum: <span>{(i.todos ?? []).filter((x: any) => x.status === 'completed').length}/{(i.todos ?? []).length} concluídas</span> };
  if (name === 'AskUserQuestion') return { icon: 'question', label: 'Pergunta', sum: <span>{i.questions?.[0]?.question}</span> };
  if (name === 'ExitPlanMode') return { icon: 'checklist', label: 'Plano', sum: <span>Plano pronto para revisão</span> };
  if (name === 'Skill') return { icon: 'sparkle', label: 'Skill', sum: <span>{i.skill ?? i.command ?? ''}</span> };
  if (name === 'KillShell' || name === 'KillBash' || name === 'TaskStop') return { icon: 'debug-stop', label: 'Parou tarefa', sum: <span>{i.shell_id ?? i.task_id ?? ''}</span> };
  if (name.startsWith('mcp__deck_terminal__')) {
    const operation = name.slice('mcp__deck_terminal__'.length);
    const detail = operation === 'run' ? i.command : operation === 'send' ? [i.text, ...(i.keys ?? [])].filter(Boolean).join(' ') : operation === 'read' ? 'Ler tela' : 'Aguardar saída';
    return { icon: 'terminal', label: 'Terminal ao Vivo', sum: <span>{String(detail ?? '')}</span> };
  }
  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    return { icon: 'plug', label: `${server}`, sum: <span>{rest.join('__')}</span> };
  }
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return { icon: 'tools', label: name, sum: <span>{first?.slice(0, 200)}</span> };
}

function editHunks(t: ToolItem): { hunks: Hunk[]; numbers: boolean } | null {
  const i = t.input ?? {};
  const sp = t.result?.structured?.structuredPatch;
  if (Array.isArray(sp) && sp.length) return { hunks: sp.map((h: any) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })), numbers: true };
  if (t.name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') return { hunks: hunksFor(i.old_string, i.new_string), numbers: false };
  if (t.name === 'MultiEdit' && Array.isArray(i.edits))
    return { hunks: i.edits.flatMap((e: any) => hunksFor(String(e.old_string ?? ''), String(e.new_string ?? ''))), numbers: false };
  if (t.name === 'Write' && typeof i.content === 'string') {
    const lines = i.content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { hunks: [{ oldStart: 0, newStart: 1, lines: lines.map((l: string) => '+' + l) }], numbers: true };
  }
  return null;
}

function Collapsible({ text, max = 1200, error, lang }: { text: string; max?: number; error?: boolean; lang?: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > max;
  const shown = full || !long ? text : text.slice(0, max);
  if (lang && !error && shown.length < 60_000) {
    return (
      <>
        <pre class="pre" dangerouslySetInnerHTML={{ __html: highlightCode(shown, lang) + (long && !full ? '\n…' : '') }} />
        {long && <button class="more-btn" onClick={() => setFull(!full)}>{full ? 'Mostrar menos' : `Mostrar tudo (${Math.round(text.length / 1024)} KB)`}</button>}
      </>
    );
  }
  return (
    <>
      <pre class={`pre${error ? ' error' : ''}`}>
        {shown}
        {long && !full ? '\n…' : ''}
      </pre>
      {long && <button class="more-btn" onClick={() => setFull(!full)}>{full ? 'Mostrar menos' : `Mostrar tudo (${Math.round(text.length / 1024)} KB)`}</button>}
    </>
  );
}

function stripLineNumbers(s: string): string {
  // Saída do Read vem como "   12→conteúdo".
  if (!/^\s*\d+→/m.test(s)) return s;
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*\d+→/, ''))
    .join('\n');
}

// ------------------------------------------------------------------ cartão

export function ToolCard({ t, c, renderChild }: { t: ToolItem; c: ChatTab; renderChild: (it: Item) => any }) {
  const perm = t.permission;
  const pending = perm?.status === 'pending';
  const isEdit = t.name === 'Edit' || t.name === 'MultiEdit' || t.name === 'Write';
  const isQuestion = t.name === 'AskUserQuestion';
  const isPlan = t.name === 'ExitPlanMode';
  const isAgent = isAgentTool(t);
  const procStart = c.state.value.processStartedAt ?? (c.state.value.phase !== 'ended' && c.state.value.phase !== 'dormant' ? (c.state.value.createdAt ?? 0) : undefined);
  const runningAgents = c.model.runningAgents(procStart);
  const isAgentWorking = isAgent && (t.status === 'running' || runningAgents.some((a) => a.id === t.id || a.taskId === t.id || (t.result?.structured?.agentId && a.agentId === t.result.structured.agentId)));
  const isToolRunning = t.status === 'running' || isAgentWorking;
  const [open, setOpen] = useState<boolean | null>(null);
  const d = toolDisplay(t, c);
  const edit = useMemo(() => (isEdit ? editHunks(t) : null), [t.input, t.result, isEdit]);
  const counts = edit ? countLines(edit.hunks) : null;
  // Sempre minimizado (também diff, lista de tarefas e erro; o ícone do cabeçalho já mostra o
  // estado). Só fica aberto enquanto espera a sua resposta (permissão, pergunta, plano): o botão
  // Permitir só mostra o título, e você precisa ver o comando/diff para decidir.
  const expanded = pending || t.children.some(awaitsUser) || (open ?? false);

  // Carrega execuções do agente ao expandir, se ainda não tiver filhas
  useEffect(() => {
    if (!expanded || !isAgent || t.children.length > 0) return;
    const agentId = t.result?.structured?.agentId || runningAgents.find((a) => a.id === t.id || a.taskId === t.id)?.agentId;
    if (!agentId) return;
    rpc.call<{ lines: any[] }>('history.agent', { sid: c.sid, agentId }, 10_000).then((page) => {
      if (page?.lines?.length) {
        c.model.applyAgentTranscript(t.id, page.lines);
      }
    }).catch(() => {});
  }, [expanded, isAgent, t.id, t.children.length]);

  const statusIcon =
    isToolRunning ? (
      pending ? <Icon name="shield" style={{ color: '#e2a700' }} /> : <Icon name="loading" class="spin" />
    ) : t.status === 'done' ? (
      <Icon name="check" />
    ) : t.status === 'error' ? (
      <Icon name="error" />
    ) : t.status === 'denied' ? (
      <Icon name="circle-slash" />
    ) : (
      <Icon name="debug-pause" />
    );

  return (
    <div class={`tool${pending ? ' pending-perm' : ''}`}>
      <div class="tool-head" onClick={() => setOpen(!expanded)}>
        <span class={`tool-status ${isToolRunning ? 'running' : t.status}`} title={isToolRunning ? 'running' : t.status}>
          {statusIcon}
        </span>
        <Icon name={d.icon} style={{ color: 'var(--fg-muted)' }} />
        <span class="tool-name">{d.label}</span>
        <span class="tool-sum">{d.sum}</span>
        {counts && (counts.add > 0 || counts.del > 0) && (
          <span class="counts">
            <span class="add">+{counts.add}</span> <span class="del">-{counts.del}</span>
          </span>
        )}
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} style={{ color: 'var(--fg-faint)' }} />
      </div>
      {expanded && <ToolBody t={t} c={c} edit={edit} renderChild={renderChild} />}
      {perm && pending && (isQuestion ? <QuestionPrompt t={t} c={c} perm={perm} /> : isPlan ? <PlanPrompt t={t} c={c} perm={perm} /> : <PermissionPrompt t={t} c={c} perm={perm} />)}
      {perm && !pending && perm.status !== 'cancelled' && (
        <div class={`perm-answered ${perm.status}`}>
          <Icon name={perm.status === 'allowed' ? 'pass' : 'circle-slash'} />
          {perm.status === 'allowed' ? (perm.answer ?? 'Permitido') : (perm.answer ?? 'Negado')}
        </div>
      )}
      {perm && perm.status === 'cancelled' && t.status !== 'done' && (
        <div class="perm-answered">
          <Icon name="debug-pause" /> Pedido cancelado
        </div>
      )}
    </div>
  );
}

function ToolBody({ t, c, edit, renderChild }: { t: ToolItem; c: ChatTab; edit: { hunks: Hunk[]; numbers: boolean } | null; renderChild: (it: Item) => any }) {
  const i = t.input ?? {};
  const r = t.result;
  const hostId = c.state.value.hostId;
  const name = t.name;
  const sections: any[] = [];

  if (edit && edit.hunks.length) sections.push(<DiffView key="diff" hunks={edit.hunks} numbers={edit.numbers} />);
  else if (name === 'Bash' || name === 'PowerShell') {
    sections.push(
      <div key="cmd" class="tool-section">
        <div class="tool-label">Comando</div>
        <Collapsible text={String(i.command ?? '')} lang={name === 'PowerShell' ? 'powershell' : 'bash'} />
      </div>,
    );
  } else if (name === 'TodoWrite') {
    sections.push(
      <div key="todos" class="tool-section">
        <ul class="todos">
          {(i.todos ?? []).map((td: any, k: number) => (
            <li key={k} class={td.status}>
              <Icon name={td.status === 'completed' ? 'pass-filled' : td.status === 'in_progress' ? 'circle-large-filled' : 'circle-large-outline'} style={{ fontSize: 14, marginTop: 3 }} />
              <span>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
            </li>
          ))}
        </ul>
      </div>,
    );
  } else if (name === 'Task' || name === 'Agent') {
    if (i.prompt)
      sections.push(
        <div key="prompt" class="tool-section">
          <div class="tool-label">Instrução para o agente</div>
          <Collapsible text={String(i.prompt)} max={600} />
        </div>,
      );
    if (t.children.length) sections.push(<div key="children" class="tool-children">{t.children.map(renderChild)}</div>);
  } else if (name === 'ExitPlanMode' && typeof i.plan === 'string') {
    sections.push(
      <div key="plan" class="tool-section">
        <Markdown text={i.plan} />
      </div>,
    );
  } else if (name === 'AskUserQuestion') {
    // As respostas aparecem no resultado.
  } else if (name !== 'Read' && name !== 'Glob' && name !== 'Grep' && name !== 'WebSearch' && name !== 'WebFetch') {
    const json = JSON.stringify(i, null, 2);
    if (json && json !== '{}')
      sections.push(
        <div key="input" class="tool-section">
          <div class="tool-label">Entrada</div>
          <Collapsible text={json} max={1500} lang="json" />
        </div>,
      );
  }

  if (r && !(edit && !r.isError) && name !== 'TodoWrite') {
    const text = name === 'Read' ? stripLineNumbers(r.text) : r.text;
    const lang = name === 'Read' && !r.isError ? extname(String(i.file_path ?? '')) : undefined;
    if (text.trim() || r.images.length)
      sections.push(
        <div key="result" class="tool-section">
          <div class="tool-label">{r.isError ? 'Erro' : 'Resultado'}</div>
          {r.images.map((img, k) => (
            <img key={k} src={`data:${img.mediaType};base64,${img.data}`} style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 4 }} />
          ))}
          {text.trim() && <Collapsible text={text} error={r.isError} lang={lang} max={name === 'Read' ? 3000 : 1500} />}
        </div>,
      );
  }
  if (!sections.length) return null;
  void hostId;
  return <div class="tool-body">{sections}</div>;
}

// ------------------------------------------------------------------ permissões

function PermissionPrompt({ t, c, perm }: { t: ToolItem; c: ChatTab; perm: PermissionReq }) {
  const [feedback, setFeedback] = useState('');
  const hostId = c.state.value.hostId;
  const suggestions = (perm.suggestions ?? []).filter((s) => permissionChoiceLabel(s, hostId));
  const allow = (updatedPermissions?: any[], label?: string) =>
    respondPermission(
      c,
      perm.requestId,
      { behavior: 'allow', updatedInput: perm.input, ...(updatedPermissions ? { updatedPermissions } : {}), decisionClassification: updatedPermissions ? 'user_permanent' : 'user_temporary' },
      label ?? 'Permitido',
    );
  const deny = () => {
    const msg = feedback.trim();
    respondPermission(
      c,
      perm.requestId,
      msg
        ? { behavior: 'deny', message: `O usuário negou e disse: ${msg}`, decisionClassification: 'user_reject' }
        : { behavior: 'deny', message: 'O usuário negou esta operação.', interrupt: true, decisionClassification: 'user_reject' },
      msg ? `Negado: ${msg}` : 'Negado',
    );
  };
  const title = perm.title || `${perm.displayName ?? perm.toolName}${perm.description ? `: ${perm.description}` : ''}`;
  return (
    <div class="perm-card">
      <div class="perm-title">
        <Icon name="shield" /> Permitir? {title}
      </div>
      {perm.reason && <div class="perm-reason">{perm.reason}</div>}
      {perm.blockedPath && <div class="perm-reason">Caminho fora da pasta do projeto: {perm.blockedPath}</div>}
      <div class="perm-actions">
        <button class="btn" onClick={() => allow()} title="Permitir só desta vez">
          <Icon name="check" /> Permitir
        </button>
        {!perm.suppressAlways &&
          suggestions.map((s, k) => (
            <button key={k} class="btn secondary" onClick={() => allow([forUserSettings(s)], permissionChoiceLabel(s, hostId) ?? undefined)}>
              <Icon name="check-all" /> {permissionChoiceLabel(s, hostId)}
            </button>
          ))}
        <button class="btn secondary" onClick={deny} title="Negar e parar para você dizer o que fazer">
          <Icon name="close" /> Negar
        </button>
      </div>
      <div class="perm-feedback">
        <input
          class="input"
          placeholder="Ou negue explicando ao Claude o que fazer diferente…"
          value={feedback}
          onInput={(e) => setFeedback((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && feedback.trim()) deny();
          }}
        />
        {feedback.trim() && (
          <button class="btn secondary" onClick={deny}>
            Enviar
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionPrompt({ t, c, perm }: { t: ToolItem; c: ChatTab; perm: PermissionReq }) {
  const questions: any[] = Array.isArray(perm.input?.questions) ? perm.input.questions : [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<Record<string, number>>({});
  const pick = (q: any, label: string) => {
    const cur = answers[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setAnswers({ ...answers, [q.question]: next });
  };
  const complete = questions.every((q) => (answers[q.question]?.length ?? 0) > 0 || (other[q.question] ?? '').trim());
  const submit = () => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const parts = [...(answers[q.question] ?? [])];
      const o = (other[q.question] ?? '').trim();
      if (o) parts.push(o);
      out[q.question] = parts.join(', ');
    }
    respondPermission(c, perm.requestId, { behavior: 'allow', updatedInput: { ...perm.input, answers: out } }, `Respondido: ${Object.values(out).join(' | ')}`);
  };
  void t;
  return (
    <div class="perm-card">
      {questions.map((q, qi) => (
        <div key={qi} class="question">
          {q.header && <span class="q-head">{q.header}</span>}
          <div class="q-text">{q.question}</div>
          <div class="question-choices">
            <div class="question-options">
              {(q.options ?? []).map((o: any, oi: number) => {
                const chosen = (answers[q.question] ?? []).includes(o.label);
                return (
                  <div
                    key={oi}
                    class={`q-option${chosen ? ' chosen' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${o.label}${o.description ? `: ${o.description}` : ''}`}
                    onMouseEnter={() => setFocused((prev) => ({ ...prev, [q.question]: oi }))}
                    onFocus={() => setFocused((prev) => ({ ...prev, [q.question]: oi }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(q, o.label); }
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const next = Math.max(0, Math.min((q.options?.length ?? 1) - 1, oi + (e.key === 'ArrowDown' ? 1 : -1)));
                        (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
                      }
                    }}
                    onClick={() => pick(q, o.label)}
                  >
                    {q.multiSelect ? (
                      <span class={`q-box${chosen ? ' checked' : ''}`} aria-hidden="true">
                        {chosen && <Icon name="check" />}
                      </span>
                    ) : (
                      <Icon name={chosen ? 'circle-large-filled' : 'circle-large-outline'} style={{ marginTop: 2 }} />
                    )}
                    <div><div>{o.label}</div>{o.description && <div class="q-desc">{o.description}</div>}</div>
                  </div>
                );
              })}
            </div>
            {typeof q.options?.[focused[q.question] ?? Math.max(0, (q.options ?? []).findIndex((o: any) => (answers[q.question] ?? []).includes(o.label)))]?.preview === 'string' && (
              <pre class="question-preview">{q.options[focused[q.question] ?? Math.max(0, q.options.findIndex((o: any) => (answers[q.question] ?? []).includes(o.label)))].preview}</pre>
            )}
          </div>
          <input
            class="input"
            style={{ width: '100%', marginTop: 2 }}
            placeholder="Outra resposta…"
            value={other[q.question] ?? ''}
            onInput={(e) => setOther({ ...other, [q.question]: (e.target as HTMLInputElement).value })}
          />
        </div>
      ))}
      <div class="perm-actions">
        <button class="btn" disabled={!complete} onClick={submit}>
          <Icon name="send" /> Responder
        </button>
        <button
          class="btn secondary"
          onClick={() => respondPermission(c, perm.requestId, { behavior: 'deny', message: 'O usuário preferiu não responder às perguntas.', interrupt: true }, 'Sem resposta')}
        >
          Pular
        </button>
      </div>
    </div>
  );
}

function PlanPrompt({ t, c, perm }: { t: ToolItem; c: ChatTab; perm: PermissionReq }) {
  const [feedback, setFeedback] = useState('');
  const plan = typeof perm.input?.plan === 'string' ? perm.input.plan : '';
  const approve = (mode: 'acceptEdits' | 'default') =>
    respondPermission(
      c,
      perm.requestId,
      { behavior: 'allow', updatedInput: perm.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] },
      mode === 'acceptEdits' ? 'Plano aprovado (edições automáticas)' : 'Plano aprovado (aprovar cada edição)',
    );
  void t;
  return (
    <div class="perm-card">
      <div class="perm-title">
        <Icon name="checklist" /> O Claude terminou o plano. Pode executar?
      </div>
      {plan && !t.input?.plan && (
        <div class="plan-box">
          <Markdown text={plan} />
        </div>
      )}
      <div class="perm-actions">
        <button class="btn" onClick={() => approve('acceptEdits')}>
          <Icon name="check" /> Sim, e aceitar edições automaticamente
        </button>
        <button class="btn secondary" onClick={() => approve('default')}>
          Sim, aprovando cada edição
        </button>
      </div>
      <div class="perm-feedback">
        <input
          class="input"
          placeholder="Não — diga ao Claude o que mudar no plano…"
          value={feedback}
          onInput={(e) => setFeedback((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              respondPermission(c, perm.requestId, { behavior: 'deny', message: feedback.trim() || 'O usuário quer continuar planejando.' }, 'Continuar planejando');
            }
          }}
        />
        <button
          class="btn secondary"
          onClick={() => respondPermission(c, perm.requestId, { behavior: 'deny', message: feedback.trim() || 'O usuário quer continuar planejando.' }, 'Continuar planejando')}
        >
          Continuar planejando
        </button>
        <button class="btn secondary" title="Parar" onClick={() => interruptChat(c)}>
          <Icon name="debug-stop" />
        </button>
      </div>
    </div>
  );
}
