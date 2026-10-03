// Uso do contexto (a "pizza" ao lado do modelo) na interface de verdade: servidor real + Brave isolado + Claude falso
// que informa o contexto em uso (comando `ctx <tokens>`) e a janela do modelo (FAKE_CONTEXT_WINDOW).
// A pizza fica sempre visível; clicar manda `/compact` direto, sem confirmação; com o Claude trabalhando o `/compact`
// fica na fila dele e roda quando o turno termina.
// Janela do teste: 100.000, saída máxima 4.000 → janela útil 83.000 (100.000 − 4.000 − 13.000).
//
//   node test/e2e/context-usage.mjs                         (usa dist/web)
//   E2E_WEB_DIR=<pasta> node test/e2e/context-usage.mjs     (interface compilada em outra pasta, sem mexer no dist/web em uso)
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { FAKE_CONTEXT_WINDOW: '100000' } });
const { page } = env;
const h = helpers(page);
const shots = path.join(ROOT, 'test', 'shots', 'context-usage');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
let failed = false;
let n = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS: ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed = true;
    console.log(`FAIL: ${name}\n    ${String(e?.message ?? e).split('\n')[0]}`);
    await page.screenshot({ path: path.join(shots, `FALHA-${++n}.png`) }).catch(() => {});
  }
}
const shot = (name) => page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
const pie = () =>
  page.evaluate(() => {
    const el = document.querySelector('.composer .ctx-pie');
    if (!el) return null;
    const circles = [...el.querySelectorAll('circle')];
    return {
      state: el.getAttribute('data-context-state'),
      percent: el.getAttribute('data-context-percent'),
      title: el.getAttribute('title') ?? '',
      aria: el.getAttribute('aria-label') ?? '',
      circles: circles.length,
      dash: circles[1]?.getAttribute('stroke-dasharray') ?? '',
    };
  });
const waitPie = (percent) => h.waitFor((p) => document.querySelector('.composer .ctx-pie')?.getAttribute('data-context-percent') === String(p), 8000, `pizza em ${percent}%`, percent);
/** Manda a mensagem, espera a resposta aparecer e o turno acabar (o resultado já chegou com a janela). */
async function turn(text, reply) {
  await h.send(text);
  await h.waitText('.msg .md', reply);
  await h.waitIdle();
}
const userBubbles = () => page.$$eval('.user-bubble', (els) => els.map((e) => e.textContent.trim()));

try {
  await step('conversa nova: a pizza já está lá, vazia, com dica dizendo que ainda não há dados', async () => {
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
    const p = await pie();
    h.assert(p !== null, 'a pizza deveria ficar sempre visível, mesmo antes de qualquer dado de contexto');
    h.assert(p.state === 'unknown' && p.percent === null, `estado inesperado antes do primeiro turno: ${JSON.stringify(p)}`);
    h.assert(p.title.split('\n')[0] === 'Contexto: ainda sem dados desta conversa.' && p.title.includes('Clique para compactar agora (/compact).'), `dica inesperada: ${p.title}`);
    h.assert(p.aria === 'Uso do contexto ainda desconhecido — clique para compactar', `rótulo inesperado: ${p.aria}`);
    h.assert(p.circles === 1, `vazia deveria ter só o trilho, sem o ponto do anel (círculos: ${p.circles})`);
    await shot('sem-dados');
  });

  await step('depois do primeiro turno a janela é conhecida: 0% usado, anel vazio', async () => {
    await turn('echo oi', 'oi');
    await waitPie(0);
    const p = await pie();
    h.assert(p.state === 'known' && p.circles === 1, `esperava só o trilho em 0%, sem o ponto do anel: ${JSON.stringify(p)}`);
  });

  await step('36% usado: mostra 36% (nada de esconder abaixo de 50%)', async () => {
    await turn('ctx 30000', 'contexto simulado: 30000');
    await waitPie(36);
    const p = await pie();
    h.assert(p.title.split('\n')[0] === 'Contexto: 30k de 83k tokens usados (36%).', `dica inesperada: ${p.title}`);
  });

  await step('72% usado: percentual certo, anel proporcional, dica com a janela e posição ao lado do modelo', async () => {
    await turn('ctx 60000', 'contexto simulado: 60000');
    await waitPie(72);
    const p = await pie();
    h.assert(p.circles === 2, `esperava trilho + anel, veio ${p.circles} círculos`);
    const filled = parseFloat(p.dash);
    h.assert(Math.abs(filled - (2 * Math.PI * 7 * 60000) / 83000) < 0.1, `anel fora de proporção: ${p.dash}`);
    h.assert(p.title.split('\n')[0] === 'Contexto: 60k de 83k tokens usados (72%).', `dica inesperada: ${p.title}`);
    // Este Claude falso responde como um Claude Code antigo (sem os campos da compactação automática): a base é a janela do modelo.
    h.assert(
      p.title.split('\n').slice(1).join('\n') ===
        '28% restante da janela útil do modelo.\nJanela do modelo: 100k tokens (menos a reserva para a resposta e para o compactador).\nCompactação automática: o Claude ainda não informou o valor configurado.\nClique para compactar agora (/compact).',
      `dica sem os detalhes: ${p.title}`,
    );
    h.assert(p.aria === '72% do contexto usado — clique para compactar', `rótulo de acessibilidade inesperado: ${p.aria}`);
    // Fica logo depois do seletor de modelo.
    const order = await page.evaluate(() => {
      const bar = document.querySelector('.composer .ctx-pie')?.parentElement;
      const kids = [...(bar?.children ?? [])];
      const model = kids.findIndex((e) => e.classList.contains('pill-select') && /Fake Sonnet/.test(e.textContent));
      const ctx = kids.findIndex((e) => e.classList.contains('ctx-pie'));
      return { model, ctx, gap: ctx - model };
    });
    h.assert(order.model >= 0 && order.ctx > order.model && order.gap <= 3, `pizza fora de lugar em relação ao seletor de modelo: ${JSON.stringify(order)}`);
    await shot('72-por-cento');
  });

  await step('clicar compacta direto: manda /compact na hora, sem diálogo de confirmação', async () => {
    const before = (await userBubbles()).filter((t) => t === '/compact').length;
    await page.click('.composer .ctx-pie');
    await h.waitFor(() => [...document.querySelectorAll('.user-bubble')].some((e) => e.textContent.trim() === '/compact'), 8000, 'mensagem /compact');
    h.assert(!(await page.$('.dialog')), 'abriu um diálogo de confirmação');
    await h.waitIdle();
    const after = (await userBubbles()).filter((t) => t === '/compact').length;
    h.assert(after === before + 1, `esperava exatamente 1 /compact novo, vieram ${after - before}`);
    await shot('depois-do-clique');
  });

  await step('depois de compactar (marca + resumo) o uso despenca de 72% para ~5% e a pizza continua lá', async () => {
    await turn('compactsim', 'Continuando depois da compactação');
    await waitPie(5); // 4.000 de 83.000: sobra só o resumo
    h.assert((await pie()) !== null, 'a pizza sumiu depois de compactar');
  });

  await step('estourou o contexto (108%): trava em 100% e diz 0% restante', async () => {
    await turn('ctx 90000', 'contexto simulado: 90000');
    await waitPie(100);
    const p = await pie();
    h.assert(p.title.includes('0% restante da janela útil do modelo'), `dica inesperada: ${p.title}`);
    h.assert(Math.abs(parseFloat(p.dash) - 2 * Math.PI * 7) < 0.1, `anel deveria estar cheio: ${p.dash}`);
    await shot('100-por-cento');
  });

  await step('recarregar a janela: a pizza volta (uso do histórico + janela do resultado reenviado pelo servidor)', async () => {
    await page.reload();
    await page.waitForSelector('.chat-header', { timeout: 20000 });
    await h.waitFor(() => document.querySelectorAll('.msg').length > 0, 15000, 'histórico carregado');
    await waitPie(100);
    await shot('depois-de-recarregar');
  });

  let repliesBefore = 0;
  await step('com o Claude ocupado, a dica já avisa que o clique deixa o /compact na fila', async () => {
    repliesBefore = await page.$$eval('.msg .md', (els) => els.filter((e) => e.textContent.includes('Recebi: /compact')).length);
    await h.send('slow 40'); // ~4 s
    await h.waitFor(() => !!document.querySelector('.send-btn.stop'), 8000, 'turno começar');
    await h.waitFor(() => (document.querySelector('.composer .ctx-pie')?.getAttribute('title') ?? '').endsWith('O Claude está trabalhando. Clique para deixar o /compact na fila: ele roda quando o Claude terminar.'), 5000, 'dica "deixar na fila"');
    const p = await pie();
    h.assert(p.aria.endsWith('clique para deixar a compactação na fila'), `rótulo inesperado: ${p.aria}`);
    h.assert(!(await page.$('.composer .ctx-pie[data-compact]')), 'a pizza não deveria estar marcada antes do clique');
  });

  await step('clicar com o Claude ocupado enfileira o /compact (como a extensão do VS Code): não abre diálogo e não roda no meio do turno', async () => {
    const before = (await userBubbles()).filter((t) => t === '/compact').length;
    await page.click('.composer .ctx-pie');
    await h.waitText('.toast', '/compact na fila');
    await h.waitFor(() => document.querySelector('.composer .ctx-pie')?.getAttribute('data-compact') === 'queued', 5000, 'pizza marcada "na fila"');
    h.assert(!(await page.$('.dialog')), 'abriu um diálogo com o Claude ocupado');
    const bubbles = await page.$$eval('.user-bubble', (els) => els.filter((e) => e.textContent.trim() === '/compact').map((e) => e.classList.contains('pending')));
    h.assert(bubbles.length === before + 1, `esperava 1 /compact novo na conversa, vieram ${bubbles.length - before}`);
    h.assert(bubbles.at(-1) === true, 'o /compact deveria aparecer pendente (esperando na fila)');
    const p = await pie();
    h.assert(p.title.split('\n').at(-1) === '/compact na fila: roda quando o Claude terminar o que está fazendo.', `dica inesperada: ${p.title}`);
    h.assert(p.aria.endsWith('compactação na fila'), `rótulo inesperado: ${p.aria}`);
    // O turno que estava rodando continua: o /compact não o interrompeu nem passou na frente.
    h.assert(!!(await page.$('.send-btn.stop')), 'o turno em andamento foi interrompido');
    await shot('compact-na-fila');
  });

  await step('segundo clique com o /compact já na fila só avisa: não enfileira outro', async () => {
    const before = (await userBubbles()).filter((t) => t === '/compact').length;
    await page.click('.composer .ctx-pie');
    await h.waitText('.toast', 'já está na fila');
    await new Promise((r) => setTimeout(r, 300));
    h.assert((await userBubbles()).filter((t) => t === '/compact').length === before, 'enfileirou um segundo /compact');
  });

  await step('o turno termina e o /compact roda sozinho, uma vez só; a pizza para de pulsar', async () => {
    // O Claude falso responde a qualquer texto que não é comando com "Recebi: <texto>"; o clique anterior já deixou uma resposta dessas.
    await h.waitFor((n) => [...document.querySelectorAll('.msg .md')].filter((e) => e.textContent.includes('Recebi: /compact')).length > n, 30000, 'resposta do /compact enfileirado', repliesBefore);
    await h.waitIdle(30000);
    const after = await page.$$eval('.user-bubble', (els) => els.filter((e) => e.textContent.trim() === '/compact').map((e) => e.classList.contains('pending')));
    h.assert(after.at(-1) === false, 'o /compact continua pendente depois de rodar');
    const replies = await page.$$eval('.msg .md', (els) => els.filter((e) => e.textContent.includes('Recebi: /compact')).length);
    h.assert(replies === repliesBefore + 1, `o /compact deveria ter rodado 1 vez, rodou ${replies - repliesBefore}`);
    await h.waitFor(() => !document.querySelector('.composer .ctx-pie[data-compact]'), 5000, 'pizza parar de pulsar');
    // Acabou: o clique volta a compactar na hora.
    const p = await pie();
    h.assert(p.title.split('\n').at(-1) === 'Clique para compactar agora (/compact).', `dica inesperada: ${p.title}`);
    await shot('compact-rodou');
  });

  await step('sem erros no console da página', async () => {
    h.assert(env.app.errors.length === 0, `erros no console:\n${env.app.errors.join('\n')}`);
  });
} finally {
  await env.stop();
}
console.log(failed ? 'RESULTADO: FALHOU' : 'RESULTADO: tudo certo');
process.exit(failed ? 1 : 0);
