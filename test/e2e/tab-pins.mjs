// Abas fixadas: fixar pelo menu (vai para o fim das fixadas), ficam no começo mesmo com a organização automática,
// não fecham pelo botão do meio/atalho, reordenar arrastando entre elas, a solta não entra na área das fixadas,
// voltam iguais depois do F5 (gravado no state.json), /clear mantém a fixação e "Fechar as outras" as preserva.
// Brave isolado + Claude falso + dados temporários.
//   node test/e2e/tab-pins.mjs      (compile antes: npm run build:web)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX, sleep } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_UNSEEN_DELAY_MS: '300' }, width: 1400, height: 900 });
const { page } = env;
const h = helpers(page);
fs.mkdirSync(path.join(ROOT, 'test', 'shots'), { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(ROOT, 'test', 'shots', `tab-pins-${name}.png`) });

let step = 0;
const ok = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);

const order = () => page.$$eval('.center .tabs .tab', (els) => els.map((e) => e.getAttribute('data-sid')));
const pinnedSids = () => page.$$eval('.center .tabs .tab.pinned', (els) => els.map((e) => e.getAttribute('data-sid')));
const tabSel = (sid) => `.center .tabs .tab[data-sid="${sid}"]`;
const waitOrder = (want, label) => h.waitFor((w) => JSON.stringify([...document.querySelectorAll('.center .tabs .tab')].map((e) => e.getAttribute('data-sid'))) === w, 8000, label, JSON.stringify(want));
const name = (ids, sids) => sids.map((s) => ids[s] ?? s);
async function tabMenu(sid, text) {
  await page.click(tabSel(sid), { button: 'right' });
  await h.menu(text);
}
/** Arrasto de verdade (eventos HTML5) de uma aba para cima de outra. */
async function dragTab(fromSid, toSid) {
  const box = async (sid) => {
    const b = await (await page.$(tabSel(sid))).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const from = await box(fromSid);
  const to = await box(toSid);
  await page.mouse.move(from.x, from.y);
  await page.setDragInterception(true);
  const data = await page.mouse.drag(from, to);
  await page.mouse.dragEnter(to, data);
  await page.mouse.dragOver(to, data);
  await page.mouse.drop(to, data);
  await page.mouse.up();
  await page.setDragInterception(false);
}

try {
  // Quatro conversas na mesma pasta: A, B, C, D (nesta ordem).
  await h.newLocalChat(env.sandbox);
  await h.send('echo conversa A');
  await h.waitIdle();
  for (const n of ['B', 'C', 'D']) {
    const before = await h.chatTabs();
    await page.click('.chat-header button[title="Nova conversa na mesma pasta"]');
    await h.waitFor((c) => document.querySelectorAll('.center .tabs .tab').length === c, 10000, `conversa ${n}`, before + 1);
    await h.send(`echo conversa ${n}`);
    await h.waitIdle();
  }
  const wid = await page.evaluate(() => sessionStorage.getItem('deck.wid'));
  const [A, B, C, D] = (await h.rpc('sessions.list')).filter((s) => s.wid === wid).map((s) => s.sid);
  const ids = { [A]: 'A', [B]: 'B', [C]: 'C', [D]: 'D' };
  assert.deepEqual(await order(), [A, B, C, D], 'ordem inicial');
  ok('quatro conversas abertas: A, B, C, D');

  // Fixar C e depois B: cada uma vai para o fim das fixadas (C é a 1ª, B a 2ª).
  await tabMenu(C, 'Fixar aba');
  await waitOrder([C, A, B, D], 'C fixada no começo');
  await tabMenu(B, 'Fixar aba');
  await waitOrder([C, B, A, D], 'B fixada em 2º');
  assert.deepEqual(await pinnedSids(), [C, B]);
  assert.ok(await page.$(`${tabSel(B)} .close.pin .codicon-pinned`), 'fixada mostra o alfinete no lugar do X');
  assert.ok(await page.$(`${tabSel(B)}.pinned-last`), 'divisa depois da última fixada');
  await shot('fixadas');
  ok('fixar pelo menu: C vira a 1ª, B a 2ª, com alfinete no lugar do X');

  // D termina sem ser vista: a organização (Ctrl+Alt+O) a sobe, mas nunca acima das fixadas.
  await page.click(tabSel(D));
  await h.send('slow 15'); // 15 linhas, ~1,5 s
  await page.waitForSelector('.send-btn.stop', { timeout: 8000 });
  await page.click(tabSel(A));
  await h.waitFor((sid) => document.querySelector(`.center .tabs .tab[data-sid="${sid}"] .tab-status`)?.getAttribute('title') === 'Terminou (não visto)', 10000, 'D "Terminou (não visto)"', D);
  await h.hotkey('Control', 'Alt', 'o');
  await waitOrder([C, B, D, A], 'organizar mantém as fixadas no começo');
  ok(`organizar as abas: ${name(ids, await order()).join(', ')} (D subiu, mas as fixadas não saem do lugar)`);

  // Fixada não fecha pelo botão do meio nem pelo Ctrl+Shift+W.
  const n = await h.chatTabs();
  await page.click(tabSel(C), { button: 'middle' });
  await sleep(300);
  assert.equal(await h.chatTabs(), n, 'botão do meio fechou uma aba fixada');
  await page.click(tabSel(C));
  await h.hotkey('Control', 'Shift', 'W');
  await h.waitText('.toast', 'está fixada');
  assert.equal(await h.chatTabs(), n, 'Ctrl+Shift+W fechou uma aba fixada');
  ok('fixada não fecha pelo botão do meio nem pelo Ctrl+Shift+W (avisa)');

  // Arrastar B para antes de C troca a ordem das fixadas; arrastar A (solta) para cima delas não a fixa.
  await dragTab(B, C);
  await waitOrder([B, C, D, A], 'B arrastada para 1º');
  await dragTab(A, B);
  await waitOrder([B, C, A, D], 'A para no começo das soltas, sem entrar nas fixadas');
  assert.deepEqual(await pinnedSids(), [B, C]);
  ok('arrastar: B passa a ser a 1ª fixada; A (solta) para logo depois das fixadas');

  // F5: tudo volta igual (gravado no state.json).
  await sleep(1200);
  const saved = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'state.json'), 'utf8')).windows[wid].state.chatTabs;
  assert.deepEqual(saved.map((t) => [ids[t.sid], !!t.pinned]), [['B', true], ['C', true], ['A', false], ['D', false]], 'state.json');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.center .tabs .tab', { timeout: 15000 });
  await h.waitFor(() => document.querySelectorAll('.center .tabs .tab.pinned').length === 2, 10000, 'fixadas depois do F5');
  // Abrir a janela organiza as abas (como sempre): as soltas vão por atividade (D é mais recente que A); as fixadas não mexem.
  await waitOrder([B, C, D, A], 'ordem depois do F5');
  assert.deepEqual(await pinnedSids(), [B, C]);
  ok('depois do F5: as mesmas fixadas, na mesma ordem (B, C); as soltas organizadas por atividade');

  // Desafixar pelo alfinete: C vai para o começo das soltas.
  await page.click(`${tabSel(C)} .close.pin`);
  await h.waitFor((sid) => !document.querySelector(`.center .tabs .tab[data-sid="${sid}"]`)?.classList.contains('pinned'), 3000, 'C desafixada', C);
  assert.deepEqual(await order(), [B, C, D, A]);
  assert.ok(await page.$(`${tabSel(C)} .close .codicon-close`), 'desafixada volta a ter o X');
  ok('desafixar pelo alfinete: C volta a ser solta, logo depois das fixadas, com o X de volta');

  // /clear numa fixada: a conversa nova fica fixada no mesmo lugar.
  await page.click(tabSel(B));
  await h.waitFor((sid) => document.querySelector('.center .tabs .tab.active')?.getAttribute('data-sid') === sid, 3000, 'B ativa', B);
  await h.typeComposer('/cle');
  await h.waitText('.suggest .suggest-item .name', '/clear');
  await page.keyboard.press('Enter'); // aplica a sugestão
  await page.keyboard.press('Enter'); // envia
  await h.waitFor((sid) => !document.querySelector(`.center .tabs .tab[data-sid="${sid}"]`), 10000, 'B substituída', B);
  const afterClear = await order();
  assert.equal(afterClear.length, 4);
  assert.deepEqual(await pinnedSids(), [afterClear[0]], '/clear: a conversa nova deveria continuar fixada em 1º');
  assert.ok(![A, B, C, D].includes(afterClear[0]), 'a 1ª deveria ser a conversa nova');
  ok('/clear numa aba fixada: a conversa nova continua fixada no mesmo lugar');

  // "Fechar as outras" não fecha as fixadas.
  await tabMenu(A, 'Fechar as outras (menos as fixadas)');
  await waitOrder([afterClear[0], A], 'só a fixada e A');
  ok('"Fechar as outras (menos as fixadas)" preserva a fixada');

  const errs = env.app.errors.filter((e) => !/favicon/i.test(e));
  assert.equal(errs.length, 0, `erros no console: ${errs.join(' | ')}`);
  console.log(`\nAbas fixadas: ${step} verificações ok`);
} catch (e) {
  await shot('falha').catch(() => {});
  console.error(env.serverLog().slice(-4000));
  throw e;
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
