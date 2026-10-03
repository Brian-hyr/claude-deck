// Contador do cache de prompt na interface de verdade: servidor real + Brave isolado + Claude falso que
// informa uso de cache (FAKE_CACHE_TTL). O relógio da página é adiantado para ver a contagem cair e vencer
// sem esperar 5 minutos. Nada toca o ~/.claude, o ~/.ssh nem o Brave do dia a dia.
//
//   node test/e2e/prompt-cache.mjs                         (usa dist/web)
//   E2E_WEB_DIR=<pasta> node test/e2e/prompt-cache.mjs     (interface compilada em outra pasta, sem mexer no dist/web em uso)
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { FAKE_CACHE_TTL: '5m' } });
const { page } = env;
const h = helpers(page);
const shots = path.join(ROOT, 'test', 'shots', 'prompt-cache');
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
/** Estado do contador na tela. */
const pill = () =>
  page.evaluate(() => {
    const el = document.querySelector('.composer .cache-pill');
    return el ? { kind: el.getAttribute('data-cache-window'), text: el.textContent.trim(), title: el.getAttribute('title') ?? '', cold: el.classList.contains('cold') } : null;
  });
/** Adianta o relógio da página (o contador lê Date.now() a cada segundo). */
const skew = (ms) =>
  page.evaluate((add) => {
    if (!window.__realNow) {
      window.__realNow = Date.now.bind(Date);
      window.__skew = 0;
      Date.now = () => window.__realNow() + window.__skew;
    }
    window.__skew = add;
  }, ms);
const waitPill = (pred, label, timeout = 8000) => h.waitFor((src) => { const el = document.querySelector('.composer .cache-pill'); const s = el && { kind: el.getAttribute('data-cache-window'), text: el.textContent.trim() }; return !!s && new Function('s', `return (${src})(s)`)(s); }, timeout, label, pred.toString());

try {
  await step('abre uma conversa e, sem dado de cache, o contador não aparece', async () => {
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
    h.assert((await pill()) === null, `contador apareceu antes de qualquer chamada ao modelo: ${JSON.stringify(await pill())}`);
  });

  await step('depois da resposta: cache ativo, 5m, com dica explicando', async () => {
    await h.send('echo oi, tudo bem?');
    await h.waitText('.msg .md', 'oi, tudo bem?');
    await h.waitIdle();
    await waitPill((s) => s.kind === 'warm', 'contador ativo');
    const p = await pill();
    h.assert(p.text === '5m', `esperava 5m, veio "${p.text}"`);
    h.assert(p.title.includes('Cache do prompt ativo') && p.title.includes('validade de 5 min'), `dica inesperada: ${p.title}`);
    await shot('ativo-5m');
  });

  await step('a contagem cai com o tempo (adianta 4 min 10 s → 1m)', async () => {
    await skew(4 * 60_000 + 10_000);
    await waitPill((s) => s.kind === 'warm' && s.text === '1m', 'contador em 1m');
    const p = await pill();
    h.assert(p.title.includes('cerca de 1 min restante'), `dica inesperada: ${p.title}`);
    await shot('quase-vencendo-1m');
  });

  await step('vence: só o ícone em vermelho e a dica diz quanto será regravado', async () => {
    await skew(7 * 60_000);
    await waitPill((s) => s.kind === 'cold', 'contador vencido');
    const p = await pill();
    h.assert(p.cold && p.text === '', `vencido deveria ser só o ícone: ${JSON.stringify(p)}`);
    h.assert(p.title.includes('provavelmente expirou') && /ocioso há 7m/.test(p.title), `dica inesperada: ${p.title}`);
    h.assert(/recriar o cache de cerca de 24,8k tokens/.test(p.title), `dica sem os tokens a regravar: ${p.title}`);
    const color = await page.$eval('.composer .cache-pill', (e) => getComputedStyle(e).color);
    h.assert(color !== (await page.$eval('.composer .pill-select:not(.cache-pill)', (e) => getComputedStyle(e).color)), 'vencido deveria ter cor diferente da dos outros botões');
    await shot('vencido');
  });

  await step('nova mensagem renova a contagem (volta para 5m)', async () => {
    await skew(0);
    await h.send('echo de novo');
    await h.waitText('.msg .md', 'de novo');
    await h.waitIdle();
    await waitPill((s) => s.kind === 'warm' && s.text === '5m', 'contador renovado em 5m');
    await shot('renovado');
  });

  await step('recarregar a janela refaz o contador a partir do histórico', async () => {
    await page.reload();
    await page.waitForSelector('.chat-header', { timeout: 20000 });
    await h.waitFor(() => document.querySelectorAll('.msg').length > 0, 15000, 'histórico carregado');
    await waitPill((s) => s.kind === 'warm' && (s.text === '5m' || s.text === '4m'), 'contador refeito após recarregar', 15000);
    await shot('depois-de-recarregar');
  });
} finally {
  await env.stop();
}
console.log(failed ? 'RESULTADO: FALHOU' : 'RESULTADO: tudo certo');
process.exit(failed ? 1 : 0);
