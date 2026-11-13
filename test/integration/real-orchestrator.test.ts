// PILOTO com o Claude Code DE VERDADE: um orquestrador real planeja, pergunta, cria workers reais e acompanha até
// concluir, num projeto Node pequeno criado na hora. O teste faz o papel do usuário: responde perguntas de
// planejamento com a primeira opção, aprova o plano pelo "botão" (orq.approve) e libera permissões só dentro da pasta
// do piloto. Gasta créditos: só roda com DECK_REAL_ORQ=1 (separado de DECK_REAL). Teto de custo e de tempo.
//
//   $env:DECK_REAL_ORQ=1; npx vitest run --config vitest.integration.config.ts test/integration/real-orchestrator.test.ts
//
// A pasta fica em C:\Temp (fora do perfil do usuário: um CLAUDE.md da pasta pessoal não entra no contexto).
// DECK_PILOT_KEEP=1 mantém a pasta e os transcripts para inspeção.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer, login, connectWs, textOf, type WsClient } from './helpers';

const RUN = process.env.DECK_REAL_ORQ === '1';
const COST_CAP = Number(process.env.DECK_PILOT_COST_CAP || 5);
const TIME_CAP_MS = Number(process.env.DECK_PILOT_MINUTES || 25) * 60_000;
const ORQ_MODEL = process.env.DECK_PILOT_MODEL || 'sonnet';
const LOG = path.join(os.tmpdir(), 'deck-orq-pilot.log');

const GOAL = `Neste projeto Node (ESM, sem dependências), quero as funções abaixo, cada uma no seu próprio arquivo em src/ e com testes em test/ usando o node --test:
- validador de CPF (com dígitos verificadores)
- conversor de temperatura entre Celsius, Fahrenheit e Kelvin
- formatador de valores em reais (R$ 1.234,56)`;

/** O "usuário" do piloto nega isto: git que muda histórico/remoto, instalar pacotes, rede e apagar com caminho absoluto/home. */
const RISKY =
  /\bgit\s+(push|commit|reset|clean|checkout\s+--|rebase|stash)\b|\b(npm|pnpm|yarn)\s+(i|install|add|publish)\b|\bnpx\b|\b(curl|wget|Invoke-WebRequest|iwr)\b|\b(rm|del|Remove-Item|rmdir|rd)\b[^|;&]*(\s[\/\\~]|\s[A-Za-z]:[\/\\]|\$HOME|\$env:)/i;

const REPLY ='Respostas: prioridade na ordem da lista; "pronto" = os testes de cada função passando com `npm test` (node --test); sem dependências externas; não faça commit. Pode seguir com o plano.';

describe.skipIf(!RUN)('Piloto do orquestrador com o Claude real', () => {
  const dir = path.join('C:\\Temp', `deck-orq-pilot-${crypto.randomBytes(3).toString('hex')}`);
  const projKey = dir.replace(/[^a-zA-Z0-9]/g, '-');
  let stop: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await stop?.();
    if (!process.env.DECK_PILOT_KEEP) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), '.claude', 'projects', projKey), { recursive: true, force: true });
    }
  }, 120_000);

  it('planeja, pergunta só o geral, cria workers com esforço ≥ alto, verifica e conclui', async () => {
    fs.writeFileSync(LOG, '');
    const t0 = Date.now();
    const log = (s: string) => {
      const line = `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`;
      fs.appendFileSync(LOG, line + '\n');
      process.stderr.write(line + '\n');
    };
    // Projeto do piloto.
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pilot-utils', version: '0.0.1', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# pilot-utils\n\nUtilitários pequenos em JavaScript (ESM), sem dependências. Testes: `npm test`.\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=pilot@deck', '-c', 'user.name=pilot', 'add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=pilot@deck', '-c', 'user.name=pilot', 'commit', '-q', '-m', 'base'], { cwd: dir });
    log(`piloto em ${dir}; modelo do orquestrador ${ORQ_MODEL}; teto US$ ${COST_CAP}, ${TIME_CAP_MS / 60000} min`);

    const env = await startServer({ settings: { defaultPermissionMode: 'default', notifications: false } });
    const anchor: WsClient = await connectWs(env.server.port, await login(env.server.port, env.server.token));
    await anchor.call('window.attach', { wid: `anchor-${crypto.randomUUID()}` });
    stop = async () => {
      anchor.close();
      await env.server.stop();
    };
    const client = env.client;
    await client.call('window.attach', { wid: `pilot-${crypto.randomUUID()}` });

    const created = await client.call(
      'orq.create',
      { hostId: 'local', cwd: dir, goal: GOAL, title: 'Piloto utilitários', model: ORQ_MODEL, effort: 'high', workerPermissionMode: 'acceptEdits', maxParallel: 3, requireApproval: true },
      120_000,
    );
    const id: string = created.orchestration.id;
    const osid: string = created.state.sid;
    log(`orquestração ${id} criada (aba ${osid})`);

    const seenReq = new Set<string>();
    const costBySid = new Map<string, number>();
    const questions: string[] = [];
    const orqTexts: string[] = [];
    const permissions: string[] = [];
    let approved = false;
    let replies = 0;
    let lastOrqResultAt = 0;
    let lastReplyAt = 0;
    let idx = 0;
    const view = () => [...client.events].reverse().find((e) => e.event === 'orq.update' && e.data.id === id)?.data ?? created.orchestration;
    const phaseOf = (sid: string) => [...client.events].reverse().find((e) => e.event === 'session.state' && e.data.sid === sid)?.data?.phase;
    const inDir = (p: unknown) => typeof p === 'string' && path.resolve(dir, p).toLowerCase().startsWith(dir.toLowerCase());
    const labelOf = (sid: string) => (sid === osid ? 'ORQ' : (view().workers.find((w: any) => w.sid === sid)?.id ?? sid.slice(0, 6)));

    const respond = async (sid: string, m: any) => {
      const req = m.request;
      const tool = req.tool_name as string;
      const input = req.input ?? {};
      let resp: any;
      if (tool === 'AskUserQuestion') {
        const answers: Record<string, string> = {};
        for (const q of input.questions ?? []) {
          const pick = (q.options ?? []).find((o: any) => /recomend/i.test(o.label)) ?? q.options?.[0];
          answers[q.question] = pick?.label ?? 'Pode decidir você.';
          questions.push(`[${labelOf(sid)}] ${q.question} → ${answers[q.question]}`);
        }
        log(`${labelOf(sid)} perguntou: ${Object.entries(answers).map(([q, a]) => `"${q}" → ${a}`).join(' | ')}`);
        resp = { behavior: 'allow', updatedInput: { ...input, answers } };
      } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && !inDir(input.file_path ?? input.notebook_path)) {
        log(`${labelOf(sid)} NEGADO ${tool} fora da pasta: ${input.file_path}`);
        resp = { behavior: 'deny', message: 'Fora da pasta do projeto do piloto.' };
      } else if ((tool === 'Bash' || tool === 'PowerShell') && RISKY.test(String(input.command ?? ''))) {
        log(`${labelOf(sid)} NEGADO ${tool} arriscado: ${String(input.command).slice(0, 160)}`);
        resp = { behavior: 'deny', message: 'Não permitido neste piloto (sem commit/push/reset, sem instalar pacotes, sem apagar fora da pasta, sem rede).' };
      } else {
        const what = input.command ?? input.file_path ?? input.pattern ?? input.url ?? '';
        permissions.push(`[${labelOf(sid)}] ${tool}: ${String(what).slice(0, 140)}`);
        log(`${labelOf(sid)} permissão ${tool}: ${String(what).slice(0, 140)}`);
        resp = { behavior: 'allow', updatedInput: input };
      }
      await client.call('sessions.respond', { sid, requestId: m.request_id, response: resp });
    };

    let finalStatus = '';
    for (;;) {
      // Eventos novos.
      for (; idx < client.events.length; idx++) {
        const e = client.events[idx];
        if (e.event !== 'session.msg') continue;
        const { sid, msg } = e.data;
        if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool' && !seenReq.has(msg.request_id)) {
          seenReq.add(msg.request_id);
          await respond(sid, msg);
        } else if (msg.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') costBySid.set(sid, msg.total_cost_usd);
          if (sid === osid) lastOrqResultAt = Date.now();
          log(`${labelOf(sid)} fim de turno (${msg.subtype}) · custo acumulado da aba US$ ${(msg.total_cost_usd ?? 0).toFixed(3)}`);
        } else if (msg.type === 'assistant' && sid === osid && !msg.parent_tool_use_id) {
          const t = textOf(msg).trim();
          if (t) orqTexts.push(t);
        } else if (msg.type === 'user' && msg.isReplay && sid === osid) {
          const t = textOf(msg);
          if (t.includes('<orq-update>')) log(`Deck → ORQ: ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
        }
      }
      const v = view();
      const cost = [...costBySid.values()].reduce((a, b) => a + b, 0);
      if (['done', 'cancelled'].includes(v.status)) {
        finalStatus = v.status;
        break;
      }
      if (cost > COST_CAP || Date.now() - t0 > TIME_CAP_MS) {
        log(`TETO atingido (US$ ${cost.toFixed(2)}, ${((Date.now() - t0) / 60000).toFixed(1)} min): cancelando`);
        await client.call('orq.cancel', { id }).catch(() => {});
        finalStatus = `teto (${v.status})`;
        break;
      }
      // O "usuário": aprova o plano; responde quando o orquestrador termina o turno esperando por ele.
      if (v.status === 'awaiting_approval' && !approved) {
        approved = true;
        log(`PLANO para aprovar: ${v.planSummary ?? '(sem resumo)'}\n        tarefas: ${v.tasks.map((t: any) => `${t.id} ${t.title} [deps ${t.deps.join(',') || '-'}] files ${t.files.join(',')}`).join(' ; ')}`);
        await client.call('orq.approve', { id });
        log('usuário APROVOU o plano');
      }
      const orqIdle = phaseOf(osid) === 'idle';
      const quiet = lastOrqResultAt && Date.now() - lastOrqResultAt > 5000 && lastOrqResultAt > lastReplyAt;
      if (orqIdle && quiet && replies < 4 && ['planning', 'waiting_user', 'stalled'].includes(v.status)) {
        replies++;
        lastReplyAt = Date.now();
        const last = orqTexts[orqTexts.length - 1] ?? '';
        log(`ORQ parou em "${v.status}" esperando o usuário. Última fala: ${last.replace(/\s+/g, ' ').slice(0, 400)}`);
        const text = v.status === 'planning' ? REPLY : 'Pode continuar até concluir tudo.';
        await client.call('sessions.send', { sid: osid, uuid: crypto.randomUUID(), content: [{ type: 'text', text }] });
        log(`usuário respondeu: ${text}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const v = view();
    const cost = [...costBySid.values()].reduce((a, b) => a + b, 0);
    log(`FIM: ${finalStatus} em ${((Date.now() - t0) / 60000).toFixed(1)} min · custo total US$ ${cost.toFixed(2)}`);
    log(`tarefas: ${v.tasks.map((t: any) => `${t.id}=${t.status}`).join(', ')}`);
    log(`workers: ${v.workers.map((w: any) => `${w.id} ${w.role} ${w.model ?? '(padrão)'} esforço ${w.effort} relatório ${w.report ?? '-'} US$ ${(w.costUsd ?? 0).toFixed(3)}`).join(' | ')}`);
    log(`perguntas feitas: ${questions.length ? questions.join(' || ') : '(nenhuma pelo AskUserQuestion)'}`);
    log(`resumo final: ${v.summary ?? '-'}`);
    fs.writeFileSync(path.join(os.tmpdir(), 'deck-orq-pilot-result.json'), JSON.stringify({ dir, finalStatus, cost, view: v, questions, permissions, orqTexts }, null, 2));

    expect(finalStatus).toBe('done');
    expect(v.workers.length).toBeGreaterThanOrEqual(2);
    for (const w of v.workers) expect(['medium', 'high', 'xhigh', 'max']).toContain(w.effort);
    for (const t of v.tasks) expect(['done', 'cancelled']).toContain(t.status);
    const out = execFileSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    // O resumo do node --test sai como "# fail 0" (TAP) ou "ℹ fail 0" (padrão do Node 20+ no terminal).
    log(`node --test: ${out.split('\n').filter((l) => /^(#|ℹ) (pass|fail|tests)\b/.test(l)).join(' · ')}`);
    expect(out).toMatch(/^(#|ℹ) fail 0$/m);
    expect(out).toMatch(/^(#|ℹ) pass [1-9]/m);
    for (const f of ['PLANO.md', 'STATE.md', 'tasks.json']) expect(fs.existsSync(path.join(v.stateDir, f))).toBe(true);
  }, 40 * 60_000);
});
