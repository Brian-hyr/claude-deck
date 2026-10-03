// Pizza do contexto com a compactação automática definida pelo usuário (ex: 250k, 400k, 500k, bem abaixo da
// janela de 1M do modelo): a interface pergunta ao Claude da conversa em que valor ela dispara e a dica mostra os
// dois números, a janela do modelo e a compactação definida; a porcentagem passa a ser sobre o limite da compactação.
// Servidor real + Brave isolado + Claude falso (FAKE_AUTOCOMPACT, FAKE_CONTEXT_WINDOW, FAKE_CONTEXT_CALLS_FILE).
//
//   node test/e2e/context-autocompact.mjs                         (usa dist/web)
//   E2E_WEB_DIR=<pasta> node test/e2e/context-autocompact.mjs     (interface compilada em outra pasta)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const shots = path.join(ROOT, 'test', 'shots', 'context-autocompact');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
let failed = false;
let n = 0;

/** Sobe um ambiente com o Claude falso configurado como pedido e roda os passos dele. */
async function scenario(title, fakeEnv, fn) {
  console.log(`\n# ${title}`);
  const calls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ctx-calls-')), 'calls.txt');
  const env = await startEnv({ sandboxSrc: SANDBOX, env: { FAKE_CONTEXT_WINDOW: '1000000', FAKE_CONTEXT_CALLS_FILE: calls, ...fakeEnv } });
  const { page } = env;
  const h = helpers(page);
  const pie = () =>
    page.evaluate(() => {
      const el = document.querySelector('.composer .ctx-pie');
      return el ? { state: el.getAttribute('data-context-state'), basis: el.getAttribute('data-context-basis'), percent: el.getAttribute('data-context-percent'), title: el.getAttribute('title') ?? '', aria: el.getAttribute('aria-label') ?? '' } : null;
    });
  /** Pedidos `get_context_usage` que chegaram ao Claude falso (um `detail` por linha). */
  const readCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
  const callCount = () => readCalls().length;
  const turn = async (text, reply) => {
    await h.send(text);
    await h.waitText('.msg .md', reply);
    await h.waitIdle();
  };
  const step = async (name, f) => {
    const t0 = Date.now();
    try {
      await f();
      console.log(`PASS: ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed = true;
      console.log(`FAIL: ${name}\n    ${String(e?.message ?? e).split('\n')[0]}`);
      await page.screenshot({ path: path.join(shots, `FALHA-${++n}.png`) }).catch(() => {});
    }
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
  const open = async () => {
    await page.waitForSelector('.empty-chat');
    await h.hotkey('Control', 'Shift', 'N');
    await h.waitText('.quickpick .qp-title', 'escolha o servidor');
    await h.clickText('.quickpick .qp-item', 'Este computador');
    await h.waitText('.quickpick .qp-title', 'escolha a pasta');
    await page.focus('.quickpick input');
    await page.keyboard.type(env.sandbox);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.chat-header', { timeout: 15000 });
    await h.waitIdle();
  };
  try {
    await fn({ env, page, h, pie, callCount, readCalls, turn, step, shot, open });
    await step('sem erros no console da página', async () => h.assert(env.app.errors.length === 0, `erros no console:\n${env.app.errors.join('\n')}`));
  } finally {
    await env.stop();
    fs.rmSync(path.dirname(calls), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- compactação em 500k (variável de ambiente)
await scenario('modelo de 1M, compactação automática definida em 500k pela variável de ambiente', { FAKE_AUTOCOMPACT: '500000' }, async ({ h, page, pie, callCount, readCalls, turn, step, shot, open }) => {
  await step('conversa nova: já pergunta ao Claude e a dica mostra o valor definido, mesmo antes do primeiro turno', async () => {
    await open();
    await h.waitFor(() => /Compactação automática: definida em 500k/.test(document.querySelector('.composer .ctx-pie')?.getAttribute('title') ?? ''), 8000, 'dica com a compactação automática');
    const p = await pie();
    h.assert(p.basis === 'autocompact', `a base da porcentagem deveria ser a compactação automática: ${JSON.stringify(p)}`);
    h.assert(p.title.includes('Janela do modelo: ainda desconhecida'), `antes do primeiro turno a janela do modelo ainda não é conhecida: ${p.title}`);
    h.assert(callCount() === 1, `esperava 1 pedido ao Claude, vieram ${callCount()}`);
  });

  await step('depois do primeiro turno a dica mostra as duas coisas: janela do modelo (1M) e compactação definida (500k)', async () => {
    await turn('echo oi', 'oi');
    await h.waitFor(() => /Janela do modelo: 1M tokens\./.test(document.querySelector('.composer .ctx-pie')?.getAttribute('title') ?? ''), 8000, 'janela do modelo na dica');
    const p = await pie();
    // Fake: limite = 500.000 − 4.000 (saída máxima) − 13.000 = 483.000.
    h.assert(
      p.title.split('\n').slice(1).join('\n') ===
        '100% restante até a compactação automática.\nJanela do modelo: 1M tokens.\nCompactação automática: definida em 500k (variável de ambiente). Compacta em 483k, já descontada a reserva para a resposta e para o compactador.\nClique para compactar agora (/compact).',
      `dica inesperada:\n${p.title}`,
    );
    h.assert(p.title.split('\n')[0] === 'Contexto: 0 de 483k tokens usados (0%).', `primeira linha inesperada: ${p.title.split('\n')[0]}`);
    h.assert(p.aria === '0% do limite de compactação automática usado — clique para compactar', `rótulo inesperado: ${p.aria}`);
  });

  await step('a porcentagem é sobre o limite da compactação (300k de 483k = 62%), não sobre a janela de 1M (que daria 31%)', async () => {
    await turn('ctx 300000', 'contexto simulado: 300000');
    await h.waitFor(() => document.querySelector('.composer .ctx-pie')?.getAttribute('data-context-percent') === '62', 8000, 'pizza em 62%');
    const p = await pie();
    h.assert(p.title.split('\n')[0] === 'Contexto: 300k de 483k tokens usados (62%).', `dica inesperada: ${p.title.split('\n')[0]}`);
    h.assert(p.aria === '62% do limite de compactação automática usado — clique para compactar', `rótulo inesperado: ${p.aria}`);
    await shot('500k-62-por-cento');
  });

  await step('turnos seguintes não repetem o pedido: 1 por processo do Claude, não 1 por turno', async () => {
    await turn('echo mais um', 'mais um');
    await turn('echo e outro', 'e outro');
    await new Promise((r) => setTimeout(r, 500));
    h.assert(callCount() === 1, `esperava 1 pedido ao Claude no total, vieram ${callCount()}`);
    h.assert(readCalls()[0] === 'summary', `o pedido deveria ser o resumido (sem contar tokens pela API): ${readCalls()[0]}`);
  });

  await step('recarregar a janela: a dica da compactação volta (a página pergunta de novo ao Claude vivo)', async () => {
    await page.reload();
    await page.waitForSelector('.chat-header', { timeout: 20000 });
    await h.waitFor(() => /Compactação automática: definida em 500k/.test(document.querySelector('.composer .ctx-pie')?.getAttribute('title') ?? ''), 15000, 'dica depois de recarregar');
    await shot('depois-de-recarregar');
  });
});

// ---------------------------------------------------------------- compactação em 250k pelas configurações
await scenario('compactação definida em 250k nas configurações do Claude Code (não na variável)', { FAKE_AUTOCOMPACT: '250000', FAKE_AUTOCOMPACT_SOURCE: 'settings' }, async ({ h, pie, turn, step, shot, open }) => {
  await step('a dica diz de onde veio o valor e o limite é 233k (250k − 4k − 13k)', async () => {
    await open();
    await turn('ctx 116500', 'contexto simulado: 116500');
    await h.waitFor(() => document.querySelector('.composer .ctx-pie')?.getAttribute('data-context-percent') === '50', 8000, 'pizza em 50%');
    const p = await pie();
    h.assert(p.title.includes('Compactação automática: definida em 250k (configurações do Claude Code). Compacta em 233k'), `dica inesperada:\n${p.title}`);
    h.assert(p.title.split('\n')[0] === 'Contexto: 117k de 233k tokens usados (50%).', `primeira linha inesperada: ${p.title.split('\n')[0]}`);
    await shot('250k-50-por-cento');
  });
});

// ---------------------------------------------------------------- compactação automática desligada
await scenario('compactação automática desligada', { FAKE_AUTOCOMPACT: 'off' }, async ({ h, pie, turn, step, open }) => {
  await step('a dica diz que está desligada e a porcentagem volta a ser sobre a janela útil do modelo', async () => {
    await open();
    await turn('ctx 300000', 'contexto simulado: 300000');
    await h.waitFor(() => /Compactação automática: desligada\./.test(document.querySelector('.composer .ctx-pie')?.getAttribute('title') ?? ''), 8000, 'dica "desligada"');
    const p = await pie();
    h.assert(p.basis === 'model', `base deveria ser o modelo: ${JSON.stringify(p)}`);
    h.assert(p.title.includes('restante da janela útil do modelo.') && !p.title.includes('até a compactação automática.'), `dica inesperada:\n${p.title}`);
  });
});

// ---------------------------------------------------------------- Claude que falha na pergunta
await scenario('o Claude responde erro ao pedido: a pizza continua funcionando sem o valor', { FAKE_AUTOCOMPACT: 'error' }, async ({ h, pie, callCount, turn, step, open }) => {
  await step('sem o valor definido a pizza usa a janela do modelo e a dica avisa; não repete o pedido em laço', async () => {
    await open();
    await turn('ctx 300000', 'contexto simulado: 300000');
    await turn('echo outro turno', 'outro turno');
    await new Promise((r) => setTimeout(r, 800));
    const p = await pie();
    // Janela útil do fake: 1.000.000 − 4.000 (saída máxima) − 13.000 = 983.000; 300.000 / 983.000 = 30,5% → 31%.
    h.assert(p.basis === 'model' && p.percent === '31', `esperava 31% sobre a janela útil do modelo: ${JSON.stringify(p)}`);
    h.assert(p.title.includes('Compactação automática: o Claude ainda não informou o valor configurado.'), `dica inesperada:\n${p.title}`);
    // Falhou uma vez; as novas tentativas esperam 30 s, então 2 turnos não geram mais que 1 pedido.
    h.assert(callCount() === 1, `esperava 1 tentativa dentro dos 30 s de espera, vieram ${callCount()}`);
  });
});

console.log(failed ? '\nRESULTADO: FALHOU' : '\nRESULTADO: tudo certo');
process.exit(failed ? 1 : 0);
