// Orquestrador pela interface: criar pelo botão das abas, quadro de tarefas, aprovar o plano pelo botão, worker numa
// aba própria (marca, faixa, ir e voltar), relatório acordando o orquestrador e conclusão. Claude falso nos dois papéis
// (o orquestrador falso chama as ferramentas com "mcp deck_orq <ferramenta> <json>"; o worker falso recebe o comando
// pela linha "fake-cmd:" do briefing). Brave isolado, dados e projeto temporários.
//   node test/e2e/orchestrator.mjs      (compile antes: npm run build)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX, sleep } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { CLAUDE_DECK_ORQ_DELAY_MS: '200' }, width: 1400, height: 900 });
const { page } = env;
const h = helpers(page);
fs.mkdirSync(path.join(ROOT, 'test', 'shots'), { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(ROOT, 'test', 'shots', `orchestrator-${name}.png`) });

let step = 0;
const ok = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);

/** Manda pelo composer da aba ativa e espera o turno acabar. */
async function say(text, timeout = 30000) {
  await h.send(text);
  await sleep(300);
  await h.waitIdle(timeout);
}
const call = (tool, args) => say(`mcp deck_orq ${tool} ${JSON.stringify(args)}`);
const pill = () => page.$eval('.orq-panel .orq-pill', (e) => e.textContent).catch(() => null);
const brief = (task, cmd) => `Tarefa ${task} do teste E2E do orquestrador. Objetivo: fazer a parte ${task}. Pronto quando o relatório chegar.\nfake-cmd: ${cmd}`;
const report = (summary, files) => `mcp deck_orq task_report ${JSON.stringify({ status: 'done', summary, files_changed: files, checks: [{ command: 'echo ok', exit_code: 0 }] })}`;

try {
  // Janela ligada à pasta do projeto (primeira conversa) — o orquestrador nasce nela.
  await h.newLocalChat(env.sandbox);
  assert.ok(await page.$('.tabs-actions .icon-btn[title^="Novo orquestrador"]'), 'botão "Novo orquestrador" nas abas');
  await page.click('.chat-header .icon-btn[title="Mais"]');
  await page.waitForSelector('.ctxmenu', { visible: true, timeout: 5000 });
  await h.findByText('.ctxmenu .mi', 'Novo orquestrador nesta pasta');
  await page.keyboard.press('Escape');
  ok('entradas: botão nas abas e item no menu "Mais"');

  // Diálogo.
  await page.click('.tabs-actions .icon-btn[title^="Novo orquestrador"]');
  await page.waitForSelector('.orq-dialog', { visible: true, timeout: 5000 });
  const where = await page.$eval('.orq-dialog .orq-dialog-where', (e) => e.getAttribute('title'));
  assert.equal(where, env.sandbox, 'o diálogo deveria usar a pasta desta janela');
  const efforts = await page.$eval('.orq-dialog select.orq-effort', (s) => [...s.options].map((o) => o.value));
  assert.deepEqual(efforts, ['high', 'xhigh', 'max'], 'esforço só Alto ou acima');
  assert.ok(await page.$eval('.orq-dialog .dialog-foot .btn:not(.secondary)', (b) => b.disabled), 'Criar desabilitado sem objetivo');
  await page.focus('.orq-dialog .orq-goal');
  await page.keyboard.type('no soft router, quero as funções abaixo:');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- OSPF');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- BGP');
  await page.type('.orq-dialog input.input', 'Soft router E2E');
  // Permissão dos workers: "aceitar edições".
  await page.select('.orq-dialog select.orq-worker-mode', 'acceptEdits');
  await shot('dialogo');
  ok('diálogo: pasta da janela, esforço só Alto/Muito alto/Máximo, Criar só com objetivo');

  const tabsBefore = await h.chatTabs();
  await h.clickText('.orq-dialog .dialog-foot .btn', 'Criar orquestrador');
  await h.waitFor(() => !document.querySelector('.orq-dialog'), 15000, 'diálogo fechar');
  await page.waitForSelector('.orq-panel', { visible: true, timeout: 15000 });
  assert.equal(await h.chatTabs(), tabsBefore + 1, 'uma aba nova para o orquestrador');
  await h.waitFor(() => !!document.querySelector('.tabs .tab.active .tab-orq'), 5000, 'marca de orquestrador na aba ativa');
  assert.equal(await h.activeChatLabel(), 'Orquestrador · Soft router E2E');
  await h.waitIdle(30000);
  assert.equal(await pill(), 'Planejando');
  await h.waitText('.orq-panel .orq-empty', 'montando o plano');
  // A primeira mensagem (o objetivo) foi para o orquestrador.
  await h.waitText('.msg.user', 'OSPF');
  const stateDir = path.join(env.sandbox, '.claude-deck', 'orq');
  assert.ok(fs.existsSync(stateDir) && fs.readdirSync(stateDir).length === 1, 'pasta de estado criada no projeto');
  assert.match(fs.readFileSync(path.join(env.sandbox, '.claude-deck', '.gitignore'), 'utf8'), /^\*$/m, '.claude-deck fora do git');
  ok('criado: aba "Orquestrador · …" com marca, quadro "Planejando", objetivo enviado, estado em .claude-deck/orq (fora do git)');

  // Plano → esperando aprovação.
  await call('tasks_define', {
    tasks: [
      { id: 'T0', title: 'Base de roteamento', files: ['src/core'] },
      { id: 'T1', title: 'OSPF', depends_on: ['T0'], files: ['src/ospf'] },
      { id: 'T2', title: 'BGP', depends_on: ['T0'], files: ['src/bgp'] },
    ],
  });
  await h.waitFor(() => document.querySelectorAll('.orq-panel .orq-task').length === 3, 8000, '3 tarefas no quadro');
  await call('plan_submit', { summary: 'Base primeiro; depois OSPF e BGP em paralelo.' });
  await h.waitFor(() => document.querySelector('.orq-panel .orq-pill')?.textContent === 'Esperando sua aprovação', 8000, 'esperando aprovação');
  await h.waitText('.orq-panel .orq-summary', 'OSPF e BGP em paralelo');
  await h.waitText('.orq-panel .orq-task.pending .orq-task-deps', 'T0');
  await h.waitFor(() => !!document.querySelector('.tabs .tab.active .tab-orq.attention'), 5000, 'aba do orquestrador pedindo atenção');
  await shot('aprovar');
  ok('plano no quadro: 3 tarefas com dependências, resumo, "Esperando sua aprovação" e a aba pedindo atenção');

  // Aprovar pelo botão: o Deck avisa o orquestrador (cartão "Atualização da orquestração").
  await h.clickText('.orq-panel .orq-actions .btn', 'Aprovar plano');
  await h.waitFor(() => document.querySelector('.orq-panel .orq-pill')?.textContent === 'Executando', 8000, 'executando');
  await h.waitText('.injected-card.orq', 'Atualização da orquestração', 15000);
  await h.waitIdle(30000);
  assert.equal(await page.$('.orq-panel .orq-actions .btn'), null, 'o botão Aprovar some depois de aprovar');
  ok('aprovado pelo botão: "Executando" e o aviso chega ao orquestrador como cartão do Deck (não como texto seu)');

  // Worker para T0: manda o relatório no primeiro turno.
  await call('worker_start', { task_id: 'T0', brief: brief('T0', report('Base pronta.', ['src/core/base.c'])), effort: 'xhigh', model: 'fake-opus' });
  await h.waitFor(() => [...document.querySelectorAll('.tabs .tab-orq-worker')].some((e) => e.textContent === 'T0.1'), 15000, 'aba do worker T0.1');
  await h.waitFor(() => [...document.querySelectorAll('.orq-panel .orq-worker')].some((e) => e.textContent.includes('T0.1')), 8000, 'T0.1 no quadro');
  assert.equal(await h.activeChatLabel(), 'Orquestrador · Soft router E2E', 'criar o worker não pode tirar o foco do orquestrador');
  ok('worker criado: aba própria com a marca "T0.1", chip no quadro, e o foco continua no orquestrador');

  // Grupo de abas: orquestrador + workers juntos atrás de uma etiqueta que recolhe/expande.
  await h.waitText('.tabs .tab-group .tab-group-chip .tab-group-label', 'Soft router E2E', 5000);
  const groupTabs = () => page.$$eval('.tabs .tab-group .tab', (els) => els.map((e) => e.querySelector('.tab-label')?.textContent));
  assert.deepEqual(await groupTabs(), ['Orquestrador · Soft router E2E', 'T0.1 · Base de roteamento'], 'grupo: orquestrador primeiro, depois o worker');
  await page.click('.tabs .tab-group-chip');
  await h.waitFor(() => !!document.querySelector('.tabs .tab-group.collapsed'), 3000, 'grupo recolhido');
  assert.deepEqual(await groupTabs(), ['Orquestrador · Soft router E2E'], 'recolhido: só a aba ativa (o orquestrador) continua à vista');
  assert.equal(await page.$eval('.tabs .tab-group-chip .tab-group-count', (e) => e.textContent), '2');
  await shot('grupo-recolhido');
  await page.click('.tabs .tab-group-chip');
  await h.waitFor(() => !document.querySelector('.tabs .tab-group.collapsed') && document.querySelectorAll('.tabs .tab-group .tab').length === 2, 3000, 'grupo expandido');
  ok('grupo de abas: etiqueta com o nome da orquestração, orquestrador + worker juntos, recolhe (fica a ativa) e expande');

  // O relatório acorda o orquestrador parado (sem worker_wait).
  await h.waitFor(() => [...document.querySelectorAll('.injected-card.orq')].some((e) => e.textContent.includes('enviou relatório')), 30000, 'orquestrador acordado com o relatório');
  await h.waitFor(() => !!document.querySelector('.orq-panel .orq-worker .codicon-pass'), 10000, 'chip com relatório');
  await h.waitIdle(30000);
  ok('relatório do worker acorda o orquestrador sozinho e o chip mostra "relatório"');

  // Ir ao worker pelo chip e voltar pela faixa.
  await (await h.findByText('.orq-panel .orq-worker', 'T0.1')).click();
  await h.waitFor(() => document.querySelector('.tabs .tab.active .tab-label')?.textContent === 'T0.1 · Base de roteamento', 5000, 'aba do worker ativa');
  await page.waitForSelector('.orq-strip', { visible: true, timeout: 5000 });
  const strip = await page.$eval('.orq-strip', (e) => e.textContent);
  assert.ok(strip.includes('T0.1') && strip.includes('Base de roteamento') && strip.includes('esforço Muito alto') && strip.includes('fake-opus'), `faixa do worker: ${strip}`);
  await h.waitText('.injected-card.orq', 'Mensagem do orquestrador');
  assert.equal(await page.$('.orq-panel'), null, 'o quadro fica só na aba do orquestrador');
  await shot('worker');
  await h.clickText('.orq-strip .btn', 'Orquestrador');
  await h.waitFor(() => !!document.querySelector('.orq-panel'), 5000, 'de volta ao orquestrador');
  ok('chip abre a aba do worker (faixa com tarefa/esforço, briefing como cartão do orquestrador) e a faixa volta ao orquestrador');

  // Concluir: T0 pronta com evidência.
  await call('task_update', { id: 'T0', status: 'done', evidence: 'relatório conferido; echo ok → 0' });

  // Worker com esforço Médio num modelo que o gateway recusa (429 "No deployments"): o Deck troca sozinho para outro
  // modelo, o quadro avisa qual foi recusado e o chip mostra o modelo novo.
  await call('worker_start', { task_id: 'T1', brief: brief('T1', 'apierr 429 Request rejected (429) · No deployments available for selected model, Try again in 900 seconds.'), effort: 'medium', model: 'fake-opus' });
  await h.waitText('.orq-panel .orq-exhausted', 'fake-opus (esgotado até', 15000);
  await h.waitFor(
    () => [...document.querySelectorAll('.orq-panel .orq-worker')].some((e) => e.textContent.includes('T1.1') && /esforço Médio · fake-sonnet/.test(e.getAttribute('title') ?? '')),
    15000,
    'chip do T1.1 com esforço Médio e o modelo trocado',
  );
  await h.waitIdle(30000);
  await shot('modelo-esgotado');
  ok('modelo esgotado no gateway: o Deck troca o worker (esforço Médio) para outro modelo e o quadro avisa o recusado');

  // T1/T2 canceladas; orq_finish.
  for (const t of ['T1', 'T2']) await call('task_update', { id: t, status: 'cancelled', notes: 'fora do escopo do teste' });
  await call('orq_finish', { summary: 'Base pronta; OSPF e BGP ficam para depois.' });
  await h.waitFor(() => document.querySelector('.orq-panel .orq-pill')?.textContent === 'Concluída', 8000, 'concluída');
  assert.equal(await page.$('.orq-panel .orq-actions .icon-btn'), null, 'sem pausar/parar/cancelar depois de concluir');
  await shot('concluida');
  ok('concluída: pílula "Concluída", sem ações de controle');

  // F5: o quadro volta igual (orq.list), e o worker continua marcado. O grupo recolhido continua recolhido.
  const nGroup = await h.count('.tabs .tab-group .tab');
  await page.click('.tabs .tab-group-chip');
  await h.waitFor(() => !!document.querySelector('.tabs .tab-group.collapsed'), 3000, 'grupo recolhido antes do F5');
  await sleep(1200); // a gravação da janela espera 600 ms
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs .tab', { timeout: 15000 });
  await h.waitFor(() => !!document.querySelector('.tabs .tab-group.collapsed'), 10000, 'grupo continua recolhido depois do F5');
  await page.click('.tabs .tab-group-chip');
  await h.waitFor((n) => !document.querySelector('.tabs .tab-group.collapsed') && document.querySelectorAll('.tabs .tab-group .tab').length === n, 5000, 'grupo expandido depois do F5', nGroup);
  await h.waitFor(() => [...document.querySelectorAll('.tabs .tab-orq-worker')].some((e) => e.textContent === 'T0.1'), 15000, 'marca do worker depois do F5');
  await h.clickText('.tabs .tab .tab-label', 'Orquestrador · Soft router E2E');
  await h.waitFor(() => document.querySelector('.orq-panel .orq-pill')?.textContent === 'Concluída', 15000, 'quadro depois do F5');
  assert.equal(await h.count('.orq-panel .orq-task'), 3);
  ok('depois do F5: quadro e marcas restaurados');

  console.log(`\nOrquestrador: ${step} verificações ok`);
} catch (e) {
  await shot('falha').catch(() => {});
  console.error(env.serverLog().slice(-4000));
  throw e;
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
