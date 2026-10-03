// Claude Code DE VERDADE (turnos baratos no Haiku), pelo servidor do Claude Deck:
// local (este notebook) e remoto (servidor de teste, pelo runner). Só roda com DECK_REAL=1.
//
//   $env:DECK_REAL=1; npx vitest run --config vitest.integration.config.ts test/integration/real-claude.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer, TEST_HOST, textOf } from './helpers';

const REAL = process.env.DECK_REAL === '1';
const MODEL = process.env.DECK_REAL_MODEL || 'haiku';
const log = (s: string) => process.stderr.write(`[real] ${s}\n`);

type Env = Awaited<ReturnType<typeof startServer>>;

/** Envia uma mensagem e espera o "result"; devolve as mensagens do turno. */
async function turn(env: Env, sid: string, text: string, onPermission?: (req: any) => any) {
  const from = env.client.events.length;
  const uuid = crypto.randomUUID();
  await env.client.call('sessions.send', { sid, uuid, content: [{ type: 'text', text }] }, 120_000);
  const seen = new Set<string>();
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 180_000) throw new Error('turno não terminou em 3 min');
    const evs = env.client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid);
    for (const e of evs) {
      const m = e.data.msg;
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && !seen.has(m.request_id)) {
        seen.add(m.request_id);
        const resp = onPermission ? onPermission(m.request) : { behavior: 'allow', updatedInput: m.request.input };
        await env.client.call('sessions.respond', { sid, requestId: m.request_id, response: resp });
      }
    }
    const result = evs.find((e) => e.data.msg.type === 'result');
    if (result) return { msgs: evs.map((e) => e.data.msg), result: result.data.msg, uuid, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!REAL)('Claude real pelo Claude Deck', () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  });

  it('local: turno com ferramenta (Read), permissão, transcript com o nosso uuid, --resume', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-real-'));
    fs.writeFileSync(path.join(dir, 'segredo.txt'), 'palavra-chave: jabuticaba\n');
    const env = await startServer({ settings: { defaultPermissionMode: 'default', defaultModel: MODEL, notifications: false } });
    cleanups.push(() => env.server.stop());
    const st = await env.client.call('sessions.create', { hostId: 'local', cwd: dir });
    const sid = st.sid;
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'idle', 90_000, 'idle');
    const perms: string[] = [];
    const t1 = await turn(env, sid, 'Leia o arquivo segredo.txt com a ferramenta Read e responda só com a palavra-chave, sem mais nada.', (req) => {
      perms.push(req.tool_name);
      return { behavior: 'allow', updatedInput: req.input };
    });
    const answer = t1.msgs.filter((m) => m.type === 'assistant').map(textOf).join(' ');
    log(`local: ${t1.ms} ms, custo US$ ${t1.result.total_cost_usd?.toFixed(4)}, resposta: ${answer.trim().slice(0, 60)}`);
    expect(t1.result.subtype).toBe('success');
    expect(answer.toLowerCase()).toContain('jabuticaba');
    const echo = t1.msgs.find((m) => m.type === 'user' && m.isReplay);
    expect(echo?.uuid).toBe(t1.uuid);
    const sessionId = (await env.client.call('sessions.snapshot', { sid })).state.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const projDir = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
    cleanups.push(() => fs.rmSync(projDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const transcript = fs.readFileSync(path.join(projDir, `${sessionId}.jsonl`), 'utf8');
    expect(transcript).toContain(t1.uuid);
    log(`local: permissões pedidas: ${perms.join(', ') || 'nenhuma (Read em pasta de trabalho é liberado)'}`);

    // Renomear grava custom-title no transcript real.
    await env.client.call('sessions.rename', { sid, title: 'Teste real Deck' });
    expect(fs.readFileSync(path.join(projDir, `${sessionId}.jsonl`), 'utf8')).toContain('"customTitle":"Teste real Deck"');

    // Fecha e retoma a MESMA sessão (--resume): o Claude lembra da palavra.
    await env.client.call('sessions.close', { sid });
    const st2 = await env.client.call('sessions.create', { hostId: 'local', cwd: dir, resume: sessionId });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === st2.sid && e.data.phase === 'idle', 90_000, 'idle 2');
    const t2 = await turn(env, st2.sid, 'Qual era a palavra-chave que você leu antes? Responda só a palavra.');
    const a2 = t2.msgs.filter((m) => m.type === 'assistant').map(textOf).join(' ');
    log(`local --resume: ${t2.ms} ms, resposta: ${a2.trim().slice(0, 60)}`);
    expect(a2.toLowerCase()).toContain('jabuticaba');
    const st2b = (await env.client.call('sessions.snapshot', { sid: st2.sid })).state;
    expect(st2b.sessionId).toBe(sessionId);
    await env.client.call('sessions.close', { sid: st2.sid });
  }, 400_000);

  it(`remoto (${TEST_HOST}): turno real pelo runner + queda de rede no meio`, async () => {
    const remoteDir = `/tmp/deck-real-${crypto.randomBytes(4).toString('hex')}`;
    const sshCmd = (c: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', TEST_HOST, c], { encoding: 'utf8', timeout: 60_000 });
    sshCmd(`mkdir -p ${remoteDir} && printf 'palavra-chave: pitanga\\n' > ${remoteDir}/segredo.txt`);
    const key = remoteDir.replace(/[^a-zA-Z0-9]/g, '-');
    cleanups.push(() => void sshCmd(`rm -rf ${remoteDir} "$HOME/.claude/projects/${key}"`));
    const env = await startServer({ settings: { defaultPermissionMode: 'default', defaultModel: MODEL, notifications: false } });
    cleanups.push(() => env.server.stop());
    const st = await env.client.call('sessions.create', { hostId: TEST_HOST, cwd: remoteDir });
    const sid = st.sid;
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'idle', 120_000, 'idle remoto');
    const t1 = await turn(env, sid, 'Leia o arquivo segredo.txt com a ferramenta Read e responda só com a palavra-chave.');
    const a1 = t1.msgs.filter((m) => m.type === 'assistant').map(textOf).join(' ');
    log(`remoto: ${t1.ms} ms, custo US$ ${t1.result.total_cost_usd?.toFixed(4)}, resposta: ${a1.trim().slice(0, 60)}`);
    expect(a1.toLowerCase()).toContain('pitanga');

    // Queda de rede durante um turno: a resposta chega inteira depois de reanexar.
    const from = env.client.events.length;
    const uuid = crypto.randomUUID();
    await env.client.call('sessions.send', {
      sid,
      uuid,
      content: [{ type: 'text', text: 'Escreva os números de 1 a 60, um por linha, sem mais nada.' }],
    });
    await env.client.waitFor(
      (e) => env.client.events.indexOf(e) >= from && e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'stream_event',
      60_000,
      'streaming começar',
    );
    (env.server as any).registry.get(TEST_HOST).ssh.destroyForTest();
    const res = await env.client.waitFor(
      (e) => env.client.events.indexOf(e) >= from && e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result',
      180_000,
      'result após queda',
    );
    const evs = env.client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid).map((e) => e.data.msg);
    const phases = env.client.events.slice(from).filter((e) => e.event === 'session.state' && e.data.sid === sid).map((e) => e.data.phase);
    const final = evs.filter((m) => m.type === 'assistant').map(textOf).join('\n');
    // Só linhas que são um número (o modelo pode pôr uma frase antes).
    const nums = final
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    log(`remoto com queda: fases ${[...new Set(phases)].join('→')}, ${nums.length} números, result ${res.data.msg.subtype}`);
    expect(phases).toContain('reconnecting');
    expect(nums).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    // Nenhuma mensagem do assistente duplicada (mesmo uuid duas vezes).
    const ids = evs.filter((m) => m.type === 'assistant').map((m) => m.uuid);
    expect(new Set(ids).size).toBe(ids.length);
    await env.client.call('sessions.close', { sid });
  }, 400_000);
});
