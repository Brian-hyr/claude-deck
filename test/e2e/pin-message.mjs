// Mensagens fixadas: fixar uma mensagem (sua ou do Claude), voltar a ela com 1 clique, só para ler.
//   node test/e2e/pin-message.mjs      (compile antes: npm run build)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX, sleep } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX });
const { page } = env;
const h = helpers(page);
const shot = (name) => page.screenshot({ path: path.join(ROOT, 'test', 'shots', `pin-message-${name}.png`) });
const projDir = path.join(env.claudeDir, 'projects', env.sandbox.replace(/[^a-zA-Z0-9]/g, '-'));
const pinCount = () => page.$eval('.chat-header .pins-toggle .pins-count', (e) => e.textContent).catch(() => '0');
const openPins = async () => {
  await page.click('.chat-header .pins-toggle');
  await page.waitForSelector('.pins-menu', { visible: true, timeout: 5000 });
};

let step = 0;
const ok = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);

try {
  await h.newLocalChat(env.sandbox);
  await h.send('pergunta um');
  await h.waitIdle();
  await h.waitFor(() => !!document.querySelector('.chat-header .pins-toggle:not([disabled])'), 8000, 'conversa com id (botão de fixadas habilitado)');
  await h.waitFor(() => !!document.querySelector('.msg-response .msg-pin') && !!document.querySelector('.msg.user .msg-pin'), 8000, 'alfinetes nas duas mensagens');
  ok('alfinete na sua mensagem e na resposta do Claude');

  // Foto do transcript antes de fixar: fixar não pode escrever nele.
  const file = path.join(projDir, fs.readdirSync(projDir).find((f) => f.endsWith('.jsonl')));
  const transcriptBefore = fs.readFileSync(file, 'utf8');

  await page.hover('.msg-response');
  await page.click('.msg-response .msg-pin');
  await h.waitFor(() => !!document.querySelector('.msg-response .msg-pin.pinned'), 5000, 'resposta fixada');
  await page.hover('.msg.user');
  await page.click('.msg.user .msg-pin');
  await h.waitFor(() => !!document.querySelector('.msg.user .msg-pin.pinned'), 5000, 'sua mensagem fixada');
  await h.waitFor(() => document.querySelector('.chat-header .pins-toggle .pins-count')?.textContent === '2', 5000, 'contador 2 no cabeçalho');
  ok('as duas fixadas; contador do cabeçalho em 2');

  assert.equal(await h.composerValue(), '', 'fixar não pode escrever na caixa de mensagem');
  assert.equal(await h.count('.msg.user'), 1, 'fixar não pode criar mensagem na conversa');
  assert.equal(fs.readFileSync(file, 'utf8'), transcriptBefore, 'fixar não pode escrever no transcript');
  ok('só leitura: caixa vazia, nenhuma mensagem nova, transcript intacto');

  // Conversa longa: a primeira pergunta sai da tela.
  await h.send('long');
  await h.waitIdle(40000);
  await h.waitFor(() => { const m = document.querySelector('.messages'); return m && m.scrollTop > 400; }, 8000, 'conversa rolada até o fim');
  const bottomBefore = await page.$eval('.messages', (m) => m.scrollTop);

  await openPins();
  assert.equal(await h.count('.pins-menu .pin-row'), 2, 'a lista deveria ter 2 fixadas');
  const rows = await page.$$eval('.pins-menu .pin-row .pin-main', (r) => r.map((x) => x.textContent));
  assert.ok(rows.some((t) => t.includes('pergunta um') && t.includes('Você')), `linha da sua mensagem: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((t) => t.includes('Recebi: pergunta um') && t.includes('Claude')), `linha da resposta: ${JSON.stringify(rows)}`);
  await shot('lista');
  ok('lista mostra as duas, com quem escreveu e o trecho');

  await h.clickText('.pins-menu .pin-main', 'Você');
  await h.waitFor(() => !!document.querySelector('.msg.user.msg-flash'), 5000, 'destaque na mensagem');
  assert.equal(await page.$('.pins-menu'), null, 'a lista deveria fechar ao clicar');
  const view = await page.evaluate(() => {
    const s = document.querySelector('.messages').getBoundingClientRect();
    const b = document.querySelector('.msg.user.msg-flash .user-bubble').getBoundingClientRect();
    return { inView: b.top >= s.top - 1 && b.bottom <= s.bottom + 1, text: document.querySelector('.msg.user.msg-flash .user-bubble').textContent, top: document.querySelector('.messages').scrollTop };
  });
  assert.ok(view.inView, 'a mensagem destacada deveria estar visível na área da conversa');
  assert.ok(view.text.includes('pergunta um'), `destacou a mensagem errada: ${view.text}`);
  assert.ok(view.top < bottomBefore - 200, `a conversa deveria ter rolado para cima (de ${bottomBefore} para ${view.top})`);
  await shot('pulo');
  assert.equal(await h.composerValue(), '', 'ir até a mensagem não pode escrever na caixa');
  assert.equal(await h.count('.msg.user'), 2, 'ir até a mensagem não pode criar mensagem');
  ok('1 clique: rola até a mensagem e destaca, sem tocar na caixa nem na conversa');

  // Volta ao fim, depois vai à resposta do Claude.
  await page.click('.jump-bottom');
  await openPins();
  await h.clickText('.pins-menu .pin-main', 'Claude');
  await h.waitFor(() => !!document.querySelector('.msg-response.msg-flash'), 5000, 'destaque na resposta');
  assert.ok((await page.$eval('.msg-response.msg-flash', (e) => e.textContent)).includes('Recebi: pergunta um'), 'destacou a resposta errada');
  ok('mesmo caminho para a resposta do Claude');

  // F5: continuam fixadas, e a âncora do histórico é a mesma do ao vivo (o alfinete aparece marcado na mensagem certa).
  await sleep(500); // o servidor grava com um pequeno atraso
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.chat-header .pins-toggle', { timeout: 15000 });
  await h.waitFor(() => document.querySelector('.chat-header .pins-toggle .pins-count')?.textContent === '2', 10000, 'fixadas depois do F5');
  await h.waitFor(() => [...document.querySelectorAll('.msg-response')].some((m) => m.textContent.includes('Recebi: pergunta um') && m.querySelector('.msg-pin.pinned')), 10000, 'resposta marcada depois do F5');
  await h.waitFor(() => [...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes('pergunta um') && m.querySelector('.msg-pin.pinned')), 10000, 'sua mensagem marcada depois do F5');
  ok('depois do F5: continuam fixadas, nas mesmas mensagens (âncora ao vivo = âncora do histórico)');

  // Desafixar: pelo ✕ da lista e pelo próprio alfinete.
  await openPins();
  await page.click('.pins-menu .pin-row .pin-remove');
  await h.waitFor(() => document.querySelector('.chat-header .pins-toggle .pins-count')?.textContent === '1', 5000, 'uma só fixada');
  await page.keyboard.press('Escape');
  await h.waitFor(() => !document.querySelector('.pins-menu'), 3000, 'lista fechada com Esc');
  await page.hover('.msg-pin.pinned');
  await page.click('.msg-pin.pinned');
  await h.waitFor(() => !document.querySelector('.msg-pin.pinned') && !document.querySelector('.chat-header .pins-toggle.has-pins'), 5000, 'nenhuma fixada');
  await openPins();
  await h.waitText('.pins-menu .pins-empty', 'Nenhuma mensagem fixada');
  await page.keyboard.press('Escape');
  ok('desafixa pelo ✕ da lista e pelo alfinete; lista vazia explica como fixar');

  // Mensagem antiga, fora da primeira página do transcript (1,5 MB): o pulo carrega as páginas anteriores sozinho.
  const sid = crypto.randomUUID();
  const base = { sessionId: sid, cwd: env.sandbox, timestamp: new Date().toISOString() };
  const origin = crypto.randomUUID();
  const filler = (i) => ({ ...base, type: 'assistant', uuid: crypto.randomUUID(), message: { id: `fill-${i}`, role: 'assistant', content: [{ type: 'text', text: `bloco ${i}: ${'palavra '.repeat(6200)}` }] } });
  const lines = [
    { ...base, type: 'user', uuid: origin, message: { role: 'user', content: [{ type: 'text', text: 'ORIGEM-ANTIGA pergunta do começo' }] } },
    { ...base, type: 'assistant', uuid: crypto.randomUUID(), message: { id: 'old-a', role: 'assistant', content: [{ type: 'text', text: 'resposta do começo' }] } },
    ...Array.from({ length: 44 }, (_, i) => filler(i)),
    { ...base, type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'FIM-RECENTE pergunta do fim' }] } },
    { ...base, type: 'assistant', uuid: crypto.randomUUID(), message: { id: 'new-a', role: 'assistant', content: [{ type: 'text', text: 'tudo certo no fim' }] } },
  ];
  const big = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  assert.ok(big.length > 1_800_000, `o transcript de teste precisa passar da página de 1,5 MB (${big.length})`);
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), big);

  await h.hotkey('Control', 'Shift', 'H');
  await h.waitText('.sidebar .side-title', 'Histórico');
  await page.click('.sidebar .icon-btn[title="Atualizar"]');
  await h.waitText('.sidebar .tree-row .label', 'ORIGEM-ANTIGA');
  await h.clickText('.sidebar .tree-row', 'ORIGEM-ANTIGA');
  await h.waitText('.msg .md', 'tudo certo no fim', 30000);
  assert.equal(await page.$(`[data-anchor="${origin}"]`), null, 'a mensagem antiga não deveria estar carregada ainda');
  assert.ok(await page.$('.load-earlier'), 'deveria haver "Carregar mensagens anteriores"');
  ok('conversa grande aberta pelo Histórico; o começo ainda não foi carregado');

  const sessions = await h.rpc('sessions.list');
  assert.ok(sessions.some((s) => s.sessionId === sid), 'a conversa do Histórico não abriu com o id esperado');
  await h.rpc('pins.set', { hostId: 'local', sessionId: sid, anchor: origin, role: 'user', snippet: 'ORIGEM-ANTIGA pergunta do começo', pinned: true });
  await h.waitFor(() => document.querySelector('.chat-header .pins-toggle .pins-count')?.textContent === '1', 8000, 'fixada chegou a esta janela pelo evento');
  await openPins();
  await h.clickText('.pins-menu .pin-main', 'ORIGEM-ANTIGA');
  await h.waitFor((a) => !!document.querySelector(`.msg.user.msg-flash[data-anchor="${a}"]`), 30000, 'pulo até a mensagem antiga (carregando páginas anteriores)', origin);
  const old = await page.evaluate((a) => {
    const s = document.querySelector('.messages').getBoundingClientRect();
    const b = document.querySelector(`[data-anchor="${a}"] .user-bubble`).getBoundingClientRect();
    return { inView: b.top >= s.top - 1 && b.bottom <= s.bottom + 1 };
  }, origin);
  assert.ok(old.inView, 'a mensagem antiga deveria estar visível depois do pulo');
  assert.equal(await h.composerValue(), '', 'a caixa de mensagem deveria continuar vazia');
  await shot('antiga');
  ok('mensagem antiga: carregou as páginas anteriores, rolou até ela e destacou');

  console.log(`\nMensagens fixadas: ${step} verificações ok`);
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
