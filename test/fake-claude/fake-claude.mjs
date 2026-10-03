#!/usr/bin/env node
// "Claude falso" para testes: fala o protocolo stream-json do Claude Code (initialize, mensagens
// parciais, ferramentas, pedidos de permissão, interrupção) e grava um transcript como o real.
// Comandos (texto da mensagem): echo <x> | write <arquivo> | edit <arquivo> | bash | ask | deep | plan |
// todo | slow | image | agentmsg [texto] | bgagent [n] | agentdone | compactsim | ctx <tokens> | crash | long | markdown | term <comando> | termkeys <tecla,...> | termread | termtools
// ("deep" = raciocínio + leitura de arquivo e só então a pergunta, como uma cadeia de trabalho real)
// ("term" = usa a ferramenta do terminal ao vivo do app — servidor MCP "sdk" pelo canal de controle,
//  como o CLI de verdade: handshake initialize/tools/list e tools/call via "mcp_message")
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const resume = argVal('--resume');
let mode = argVal('--permission-mode') || 'default';
let model = argVal('--model') || 'fake-sonnet';
const effort = argVal('--effort') || 'default';
const sessionId = resume || crypto.randomUUID();
const cwd = process.cwd();
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projDir = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });
const transcript = path.join(projDir, `${sessionId}.jsonl`);
let lastUuid = null;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
/**
 * `usage` de cada chamada ao modelo. Por padrão vazio (como sempre foi); com FAKE_CACHE_TTL=5m|1h simula um
 * CLI que grava e lê cache de prompt, para o contador de cache da interface.
 */
// Contexto simulado (pizza de uso do contexto): FAKE_CONTEXT_USED fixa o início; o comando `ctx <tokens>` muda no meio da
// conversa. FAKE_CONTEXT_WINDOW faz o resultado informar a janela do modelo (maxOutputTokens fixo em 4000).
let ctxUsed = Number(process.env.FAKE_CONTEXT_USED) || 0;
const ctxWindow = Number(process.env.FAKE_CONTEXT_WINDOW) || 0;
const callUsage = () => {
  const ttl = process.env.FAKE_CACHE_TTL;
  if (ttl === '5m' || ttl === '1h') return { input_tokens: 12, cache_read_input_tokens: 24000, cache_creation_input_tokens: 800, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? 800 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 800 : 0 } };
  if (ctxUsed > 0) return { input_tokens: Math.max(ctxUsed - 5, 0), cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 };
  return {};
};
const record = (o) => {
  fs.appendFileSync(transcript, JSON.stringify({ ...o, sessionId, cwd, parentUuid: lastUuid, timestamp: new Date().toISOString(), isSidechain: false }) + '\n');
  if (o.uuid) lastUuid = o.uuid;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Subagentes "em segundo plano" lançados por `bgagent` e ainda sem `agentdone`. */
const bgAgents = [];
let lastPermissions = [];
let pendingControl = new Map(); // request_id -> resolve
let interrupted = false;
let busy = false;
const queue = [];
let reqSeq = 0;
/** Servidores MCP "sdk" anunciados no initialize (hospedados pelo app). */
let sdkServers = [];
let mcpReady = null;
let mcpTools = [];
let mcpInstructions = '';
let rpcSeq = 0;

/** Manda uma mensagem JSON-RPC para um servidor MCP do app e espera a resposta (mcp_response). */
function mcpCall(server, method, params) {
  const id = `fake-mcp-${++reqSeq}`;
  const message = { jsonrpc: '2.0', id: ++rpcSeq, method, params };
  return new Promise((resolve, reject) => {
    pendingControl.set(id, (resp) => (resp?.mcp_response ? resolve(resp.mcp_response) : reject(new Error('sem mcp_response'))));
    out({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: server, message } });
  });
}

/** Handshake como o CLI: initialize + notifications/initialized + tools/list. */
async function mcpHandshake() {
  const server = sdkServers[0];
  if (!server) return;
  const init = await mcpCall(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '9.9.9' } });
  mcpInstructions = init.result?.instructions ?? '';
  // Notificação (sem id): o app responde com um vazio.
  const nid = `fake-mcp-${++reqSeq}`;
  out({ type: 'control_request', request_id: nid, request: { subtype: 'mcp_message', server_name: server, message: { jsonrpc: '2.0', method: 'notifications/initialized' } } });
  const list = await mcpCall(server, 'tools/list', {});
  mcpTools = (list.result?.tools ?? []).map((t) => `mcp__${server}__${t.name}`);
}

function init() {
  out({ type: 'system', subtype: 'init', cwd, session_id: sessionId, tools: ['Read', 'Write', 'Edit', 'Bash', 'AskUserQuestion', 'ExitPlanMode', 'TodoWrite', ...mcpTools], mcp_servers: sdkServers.map((name) => ({ name, status: mcpTools.length ? 'connected' : 'failed' })), model, permissionMode: mode, slash_commands: ['compact', 'fake-cmd'], output_style: 'default', skills: [], plugins: [], apiKeySource: 'none', claude_code_version: '9.9.9-fake', uuid: crypto.randomUUID() });
}

function askPermission(toolName, input, toolUseId, extra = {}) {
  const id = `fake-${++reqSeq}`;
  return new Promise((resolve) => {
    pendingControl.set(id, resolve);
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: toolUseId, display_name: toolName, description: input.file_path ?? input.command ?? '', permission_suggestions: toolName === 'Bash' ? [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }], behavior: 'allow', destination: 'localSettings' }] : [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], ...extra } });
  });
}

async function streamText(msgId, index, text, delay = 15) {
  // O CLI de verdade sempre abre a mensagem antes dos blocos; sem isto o app juntava o texto à
  // mensagem anterior e depois criava o bloco de novo (texto duplicado na tela).
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], usage: callUsage() } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  const parts = text.match(/.{1,12}/gs) ?? [];
  for (const p of parts) {
    if (interrupted) break;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
    await sleep(delay);
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
}

function assistant(msgId, content) {
  const m = { type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model, content, stop_reason: null, usage: callUsage() }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() };
  out(m);
  record(m);
}

function toolResult(toolUseId, content, isError = false, structured) {
  const m = { type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID(), ...(structured ? { tool_use_result: structured } : {}) };
  out(m);
  record({ ...m, toolUseResult: structured });
}

let totalCostUsd = 0;
function result(subtype = 'success', start = Date.now()) {
  totalCostUsd += 0.0012;
  out({ type: 'result', subtype, is_error: subtype !== 'success', duration_ms: Date.now() - start, duration_api_ms: 10, num_turns: 1, session_id: sessionId, total_cost_usd: totalCostUsd, usage: { input_tokens: 271, cache_creation_input_tokens: 0, cache_read_input_tokens: 25088, output_tokens: 6 }, modelUsage: { [model]: { inputTokens: 25613, outputTokens: 27, cacheReadInputTokens: 25088, cacheCreationInputTokens: 0, costUSD: totalCostUsd, ...(ctxWindow ? { contextWindow: ctxWindow, maxOutputTokens: 4000 } : {}) } }, permission_denials: [], uuid: crypto.randomUUID() });
}

async function runTool(msgId, name, input, run) {
  const id = `toolu_${crypto.randomBytes(8).toString('hex')}`;
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });  const json = JSON.stringify(input);
  for (let i = 0; i < json.length; i += 20) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 20) } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  assistant(msgId, [{ type: 'tool_use', id, name, input }]);
  // Ferramentas MCP pedem permissão como o CLI real (salvo no bypass).
  const needs = !(mode === 'bypassPermissions' || (mode === 'acceptEdits' && (name === 'Write' || name === 'Edit')) || name === 'Read' || name === 'TodoWrite' || name === 'Agent');
  if (needs) {
    const decision = await askPermission(name, input, id);
    if (interrupted) return;
    if (decision.behavior !== 'allow') {
      toolResult(id, decision.message || "The user doesn't want to proceed with this tool use.", true);
      if (decision.updatedPermissions) applyPerms(decision.updatedPermissions);
      return { denied: true, interrupt: decision.interrupt };
    }
    if (decision.updatedPermissions) applyPerms(decision.updatedPermissions);
    input = decision.updatedInput ?? input;
  }
  const r = await run(input);
  toolResult(id, r.text, !!r.error, r.structured);
  return { input, toolUseId: id };
}

function applyPerms(list) {
  lastPermissions = list;
  for (const p of list) if (p.type === 'setMode') {
    mode = p.mode;
    out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: crypto.randomUUID() });
  }
}

async function handleUser(msg) {
  busy = true;
  interrupted = false;
  const start = Date.now();
  const fullText = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  // Guarda os avisos do app (system-reminder) para os testes conferirem o que o Claude recebeu.
  for (const m of fullText.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) reminders.push(m[1].trim());
  const text = fullText.replace(/<[^>]+>[\s\S]*?<\/[^>]+>\n?/g, '').trim();
  const images = msg.message.content.filter((b) => b.type === 'image').length;
  const uuid = msg.uuid || crypto.randomUUID();
  const replay = { type: 'user', message: msg.message, session_id: sessionId, parent_tool_use_id: null, uuid, isReplay: true };
  out(replay);
  record({ type: 'user', message: msg.message, uuid });
  out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: crypto.randomUUID() });
  const msgId = `msg_${crypto.randomBytes(6).toString('hex')}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  try {
    if (cmd === 'crash') process.exit(3);
    if (cmd === 'ctx') {
      // "ctx 60000": as próximas chamadas ao modelo passam a informar esse tanto de contexto em uso.
      ctxUsed = Number(arg) || 0;
      assistant(msgId, [{ type: 'text', text: `contexto simulado: ${ctxUsed}` }]);
    } else if (['term', 'termkeys', 'termread', 'termtools', 'reminders'].includes(cmd)) {
      await mcpReady;
      const server = sdkServers[0];
      if (cmd === 'termtools' || cmd === 'reminders') {
        const reply = cmd === 'termtools' ? `ferramentas: ${mcpTools.join(', ') || '(nenhuma)'} | instruções: ${mcpInstructions ? 'sim' : 'não'}` : `avisos: ${JSON.stringify(reminders)}`;
        assistant(msgId, [{ type: 'text', text: reply }]);
      } else if (!server || !mcpTools.length) {
        assistant(msgId, [{ type: 'text', text: 'sem ferramentas do terminal ao vivo' }]);
      } else {
        const tool = cmd === 'term' ? 'run' : cmd === 'termkeys' ? 'send' : 'read';
        const input = cmd === 'term' ? { command: arg } : cmd === 'termkeys' ? { keys: arg.split(',').map((s) => s.trim()).filter(Boolean) } : { lines: 20 };
        const r = await runTool(msgId, `mcp__${server}__${tool}`, input, async (inp) => {
          const resp = await mcpCall(server, 'tools/call', { name: tool, arguments: inp });
          const res = resp.result ?? {};
          return { text: (res.content ?? []).map((c) => c.text).join('\n') || JSON.stringify(resp.error ?? {}), error: !!res.isError || !!resp.error };
        });
        if (!interrupted && !r?.interrupt) assistant(msgId + 'b', [{ type: 'text', text: r?.denied ? 'Terminal negado.' : 'Terminal usado.' }]);
      }
    } else if (cmd === 'echo' || cmd === 'markdown' || cmd === 'long' || !['write', 'edit', 'bash', 'bashfail', 'ask', 'askmulti', 'deep', 'plan', 'todo', 'slow', 'image', 'agentmsg', 'agentperm', 'bgagent', 'agentdone', 'compactsim'].includes(cmd)) {
      let reply = cmd === 'effort' ? `esforço=${effort} sessão=${sessionId}` : cmd === 'echo' ? arg : cmd === 'markdown' ? '# Título\n\nTexto com **negrito**, `src/app.ts:12` e lista:\n\n- um\n- dois\n\n```ts\nconst x: number = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |' : cmd === 'long' ? Array.from({ length: 200 }, (_, i) => `Linha ${i + 1} do texto longo.`).join('\n\n') : `Recebi: ${text}${images ? ` (+${images} imagem)` : ''} [modo=${mode}]`;
      await streamText(msgId, 0, reply, cmd === 'long' ? 1 : 15);
      assistant(msgId, [{ type: 'text', text: reply }]);
    } else if (cmd === 'write') {
      const file = path.resolve(cwd, arg || 'fake-output.txt');
      const r = await runTool(msgId, 'Write', { file_path: file, content: 'linha 1\nlinha 2\nconteúdo gerado pelo fake\n' }, (inp) => {
        fs.writeFileSync(inp.file_path, inp.content);
        return { text: `File created successfully at: ${inp.file_path}` };
      });
      if (!interrupted && !r?.interrupt) {
        const reply = r?.denied ? 'Ok, não vou criar o arquivo.' : 'Arquivo criado.';
        await streamText(msgId + 'b', 0, reply);
        assistant(msgId + 'b', [{ type: 'text', text: reply }]);
      }
    } else if (cmd === 'edit') {
      const file = path.resolve(cwd, arg || 'fake-output.txt');
      const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'linha 1\nlinha 2\n';
      if (!fs.existsSync(file)) fs.writeFileSync(file, old);
      const r = await runTool(msgId, 'Edit', { file_path: file, old_string: 'linha 2', new_string: 'linha 2 EDITADA\nlinha nova' }, (inp) => {
        const cur = fs.readFileSync(inp.file_path, 'utf8');
        fs.writeFileSync(inp.file_path, cur.replace(inp.old_string, inp.new_string));
        return { text: `The file ${inp.file_path} has been updated.`, structured: { filePath: inp.file_path, structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' linha 1', '-linha 2', '+linha 2 EDITADA', '+linha nova'] }] } };
      });
      if (!interrupted && !r?.interrupt) assistant(msgId + 'b', [{ type: 'text', text: r?.denied ? 'Edição negada.' : 'Editado.' }]);
    } else if (cmd === 'bash') {
      const r = await runTool(msgId, 'Bash', { command: 'echo fake-bash-ok && ls', description: 'Testa o terminal' }, () => ({ text: 'fake-bash-ok\narquivo1\narquivo2' }));
      if (!interrupted && !r?.interrupt) assistant(msgId + 'b', [{ type: 'text', text: r?.denied ? 'Comando negado.' : 'Comando executado.' }]);
    } else if (cmd === 'bashfail') {
      const r = await runTool(msgId, 'Bash', { command: 'sudo -n systemctl restart zabbix-server', description: 'Comando que falha' }, () => ({ text: 'sudo: a password is required', error: true }));
      if (!interrupted && !r?.interrupt) assistant(msgId + 'b', [{ type: 'text', text: r?.denied ? 'Comando negado.' : 'O comando falhou.' }]);
    } else if (cmd === 'ask' || cmd === 'askmulti' || cmd === 'deep') {
      if (cmd === 'deep') {
        assistant(msgId, [{ type: 'thinking', thinking: 'Preciso ver o arquivo antes de perguntar.', signature: 'fake' }]);
        await runTool(msgId, 'Read', { file_path: path.join(cwd, 'img.png') }, () => ({ text: 'conteúdo lido' }));
      }
      const id = `toolu_${crypto.randomBytes(8).toString('hex')}`;
      const input = { questions: [{ question: 'Qual cor você prefere?', header: 'Cor', multiSelect: cmd === 'askmulti', options: [{ label: 'Azul', description: 'Cor do céu', preview: 'Prévia azul: fundo #0078d4\nBotão: continuar' }, { label: 'Verde', description: 'Cor da mata', preview: 'Prévia verde: fundo #238636\nBotão: confirmar' }] }] };
      assistant(msgId, [{ type: 'tool_use', id, name: 'AskUserQuestion', input }]);
      const d = await askPermission('AskUserQuestion', input, id);
      if (d.behavior === 'allow') {
        const ans = d.updatedInput?.answers ?? {};
        toolResult(id, `User has answered your questions: ${JSON.stringify(ans)}`);
        assistant(msgId + 'b', [{ type: 'text', text: `Você escolheu: ${Object.values(ans).join(', ')}` }]);
      } else toolResult(id, d.message ?? 'negado', true);
    } else if (cmd === 'plan') {
      const id = `toolu_${crypto.randomBytes(8).toString('hex')}`;
      const input = { plan: '## Plano\n\n1. Ler o código\n2. Corrigir o bug\n3. Rodar os testes' };
      assistant(msgId, [{ type: 'tool_use', id, name: 'ExitPlanMode', input }]);
      const d = await askPermission('ExitPlanMode', input, id);
      if (d.behavior === 'allow') {
        if (d.updatedPermissions) applyPerms(d.updatedPermissions);
        toolResult(id, 'User has approved your plan.');
        assistant(msgId + 'b', [{ type: 'text', text: `Plano aprovado. Modo agora: ${mode}` }]);
      } else {
        toolResult(id, d.message ?? 'rejeitado', true);
        assistant(msgId + 'b', [{ type: 'text', text: `Plano recusado: ${d.message}` }]);
      }
    } else if (cmd === 'todo') {
      await runTool(msgId, 'TodoWrite', { todos: [{ content: 'Primeira', status: 'completed', activeForm: 'Fazendo a primeira' }, { content: 'Segunda', status: 'in_progress', activeForm: 'Fazendo a segunda' }, { content: 'Terceira', status: 'pending', activeForm: 'Fazendo a terceira' }] }, () => ({ text: 'Todos have been modified successfully.' }));
      assistant(msgId + 'b', [{ type: 'text', text: 'Lista criada.' }]);
    } else if (cmd === 'slow') {
      // "slow" = 600 linhas (1 minuto); "slow 80" = 80 linhas (8 s).
      const n = Math.min(Math.max(parseInt(arg, 10) || 600, 1), 5000);
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
      let acc = '';
      for (let i = 1; i <= n && !interrupted; i++) {
        acc += `${i}\n`;
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i}\n` } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
        await sleep(100);
      }
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
      assistant(msgId, [{ type: 'text', text: acc }]);
    } else if (cmd === 'agentmsg') {
      // Outro agente escreve para esta conversa: chega como mensagem de "usuário" com <agent-message> em texto puro.
      const body = arg || 'Read-only checkout search: Worker source NOT present.\nMP webhook HMAC em `src/index.ts:12`.';
      const m = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `<agent-message from="aa99c95b6358f7bdc">\n${body}\n</agent-message>` }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() };
      out(m);
      record(m);
      assistant(msgId, [{ type: 'text', text: 'Recebi a mensagem do outro agente.' }]);
    } else if (cmd === 'agentperm') {
      const agentId = `toolu_agent_${crypto.randomBytes(4).toString('hex')}`;
      const childId = `toolu_child_${crypto.randomBytes(4).toString('hex')}`;
      assistant(msgId, [{ type: 'tool_use', id: agentId, name: 'Agent', input: { description: 'Revisar em subagente', subagent_type: 'Explore', prompt: 'Revisar permissões' } }]);
      const child = { type: 'assistant', message: { id: `${msgId}-child`, model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: childId, name: 'Bash', input: { command: 'echo teste aninhado' } }] }, parent_tool_use_id: agentId, session_id: sessionId, uuid: crypto.randomUUID() };
      out(child);
      const answer = await askPermission('Bash', { command: 'echo teste aninhado' }, childId);
      toolResult(childId, answer.behavior === 'allow' ? 'teste aninhado' : 'negado', answer.behavior !== 'allow');
      toolResult(agentId, answer.behavior === 'allow' ? 'Subagente concluiu' : 'Subagente não executou');
      assistant(`${msgId}-done`, [{ type: 'text', text: 'Pedido do subagente processado.' }]);
    } else if (cmd === 'bgagent') {
      // "bgagent 2": lança N subagentes em segundo plano (a chamada volta na hora com `async_launched`) e o turno acaba;
      // eles seguem "rodando" até "agentdone".
      const n = Math.min(Math.max(parseInt(arg, 10) || 1, 1), 10);
      for (let i = 1; i <= n; i++) {
        const agentId = `agent${bgAgents.length + 1}`;
        // Uma mensagem por chamada: o streaming deste falso usa sempre o índice de bloco 1, e o CLI real dá um índice a cada.
        out({ type: 'stream_event', event: { type: 'message_start', message: { id: `${msgId}-${i}`, type: 'message', role: 'assistant', content: [], model } }, session_id: sessionId, parent_tool_use_id: null, uuid: crypto.randomUUID() });
        const name = `Tarefa ${bgAgents.length + 1}`;
        const prompt = `Leia os arquivos da pasta e responda à pergunta com evidências.\nEtapa ${i}: não altere nada.`;
        const r = await runTool(`${msgId}-${i}`, 'Agent', { description: name, subagent_type: 'Explore', prompt, run_in_background: true }, () => ({
          text: `Async agent launched successfully.\nagentId: ${agentId}`,
          structured: { status: 'async_launched', agentId, description: name, prompt, resolvedModel: 'claude-haiku-4-5', modelsUsed: ['claude-haiku-4-5'] },
        }));
        bgAgents.push({ agentId, toolUseId: r?.toolUseId });
        const dir = path.join(projDir, sessionId, 'subagents');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `agent-${agentId}.jsonl`), JSON.stringify({
          type: 'assistant', isSidechain: true, sessionId, agentId, timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `Transcrito do agente ${agentId}: lendo arquivos.` }] },
        }) + '\n');
      }
      assistant(msgId + 'z', [{ type: 'text', text: `${n} em segundo plano.` }]);
    } else if (cmd === 'agentdone') {
      // Os subagentes em segundo plano terminam: o CLI avisa com <task-notification> como mensagem de "usuário".
      for (const a of bgAgents.splice(0)) {
        const m = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>${a.agentId}</task-id>\n<tool-use-id>${a.toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agente ${a.agentId} terminou</summary>\n</task-notification>` }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() };
        out(m);
        record(m);
      }
      assistant(msgId, [{ type: 'text', text: 'Agentes terminaram.' }]);
    } else if (cmd === 'compactsim') {
      // Compactação como o CLI de verdade faz: marca `compact_boundary` e o resumo como mensagem de "usuário".
      // Ao vivo o resumo vem só com `isSynthetic`; no transcript, com `isCompactSummary` + `isVisibleInTranscriptOnly`.
      const b = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 123456 }, session_id: sessionId, uuid: crypto.randomUUID() };
      out(b);
      record(b);
      const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Pedido principal: RESUMO-DE-TESTE-DO-COMPACT.';
      const s = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: summary }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() };
      out({ ...s, isSynthetic: true });
      record({ ...s, isCompactSummary: true, isVisibleInTranscriptOnly: true });
      ctxUsed = Math.min(ctxUsed, 4000); // depois de compactar sobra o resumo
      assistant(msgId, [{ type: 'text', text: 'Continuando depois da compactação.' }]);
    } else if (cmd === 'image') {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
      await runTool(msgId, 'Read', { file_path: path.join(cwd, 'img.png') }, () => ({ text: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }));
      assistant(msgId + 'b', [{ type: 'text', text: 'Vi a imagem.' }]);
    }
  } catch (e) {
    process.stderr.write(String(e?.stack ?? e));
  }
  if (interrupted) {
    const m = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId, uuid: crypto.randomUUID() };
    out(m);
    record(m);
    result('error_during_execution', start);
  } else result('success', start);
  if (!fs.readFileSync(transcript, 'utf8').includes('"ai-title"')) fs.appendFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: `Teste: ${text.slice(0, 40)}`, sessionId }) + '\n');
  busy = false;
  if (queue.length) handleUser(queue.shift());
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    process.stderr.write(`Error parsing streaming input line: ${line.slice(0, 40)}\n`);
    process.exit(1);
  }
  if (m.type === 'control_request') {
    const r = m.request;
    if (r.subtype === 'initialize') {
      if (Array.isArray(r.sdkMcpServers) && r.sdkMcpServers.length && !mcpReady) {
        sdkServers = r.sdkMcpServers;
        mcpReady = mcpHandshake().catch((e) => process.stderr.write(`handshake MCP falhou: ${e}\n`));
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [{ name: 'fake-cmd', description: 'Comando falso de teste', argumentHint: '' }, { name: 'compact', description: 'Compactar' }], agents: [], models: [{ value: 'default', displayName: 'Padrão', description: '' }, { value: 'fake-opus', displayName: 'Fake Opus', description: '' }, { value: 'fake-sonnet', displayName: 'Fake Sonnet', description: '' }], account: { apiProvider: 'firstParty' }, current_permission_mode: mode, pending_permission_requests: [] } } });
      if (!initialized) {
        initialized = true;
        // Como o CLI: o init sai depois de os servidores MCP conectarem.
        Promise.resolve(mcpReady).then(() => init());
      }
    } else if (r.subtype === 'interrupt') {
      interrupted = true;
      for (const [, res] of pendingControl) res({ behavior: 'deny', message: 'interrupted' });
      pendingControl.clear();
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
    } else if (r.subtype === 'stop_task') {
      const at = bgAgents.findIndex((a) => a.agentId === r.task_id);
      if (at < 0) out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Tarefa não encontrada.' } });
      else {
        const [agent] = bgAgents.splice(at, 1);
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        out({ type: 'system', subtype: 'task_updated', task_id: agent.agentId, patch: { status: 'killed' }, session_id: sessionId, uuid: crypto.randomUUID() });
      }
    } else if (r.subtype === 'set_permission_mode') {
      mode = r.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { mode } } });
      out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: crypto.randomUUID() });
    } else if (r.subtype === 'set_model') {
      model = r.model || 'fake-sonnet';
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else if (r.subtype === 'get_settings') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { lastPermissions } } });
    } else if (r.subtype === 'get_context_usage') {
      // Registra cada pedido (o teste confere que a interface pergunta uma vez por processo, não a cada turno).
      if (process.env.FAKE_CONTEXT_CALLS_FILE) fs.appendFileSync(process.env.FAKE_CONTEXT_CALLS_FILE, `${r.detail ?? '-'}\n`);
      // FAKE_AUTOCOMPACT=<tokens>: janela de compactação definida pelo usuário (como CLAUDE_CODE_AUTO_COMPACT_WINDOW),
      // =off: compactação automática desligada, =error: o Claude responde erro. Sem a variável responde como um Claude
      // Code antigo, sem os campos da compactação automática.
      const ac = process.env.FAKE_AUTOCOMPACT;
      if (ac === 'error') {
        out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'fake: get_context_usage falhou' } });
      } else {
        const base = { totalTokens: 12345, maxTokens: 200000, percentage: 6 };
        let extra = {};
        if (ac === 'off') extra = { isAutoCompactEnabled: false };
        else if (Number(ac) > 0) {
          const window = Math.min(ctxWindow || Infinity, Number(ac));
          // Como o CLI: limite = janela − min(saída máxima, 20k) − 13k (a saída máxima do fake é 4.000).
          extra = { maxTokens: window, rawMaxTokens: window, autocompactSource: process.env.FAKE_AUTOCOMPACT_SOURCE || 'env', autoCompactThreshold: window - Math.min(4000, 20000) - 13000, isAutoCompactEnabled: true };
        }
        out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { ...base, ...extra } } });
      }
    } else out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `fake: ${r.subtype} não suportado` } });
    return;
  }
  if (m.type === 'control_response') {
    const res = pendingControl.get(m.response.request_id);
    if (res) {
      pendingControl.delete(m.response.request_id);
      res(m.response.response ?? {});
    }
    return;
  }
  if (m.type === 'user') {
    if (busy) queue.push(m);
    else handleUser(m);
  }
});
let initialized = false;
const reminders = [];
rl.on('close', () => process.exit(0));
