// Duas pastas do mesmo servidor: pendências da janela A não viram alertas na janela B.
import assert from 'node:assert/strict';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX, env: { CLAUDE_DECK_TEST_HOOKS: '1' } });
try {
  const a = env.page;
  const ha = helpers(a);
  await ha.newLocalChat(env.sandbox);
  console.log('A: conversa criada');
  await ha.send('echo pendência da pasta A');
  await ha.waitIdle();
  await ha.waitFor(() => !!document.querySelector('.chat-header button[title="Marcar como pendente de visualização"]'), 5000, 'conversa com id');
  console.log('A: turno concluído');

  const b = await env.browser.newPage();
  await b.goto((await ha.rpc('window.open', { hostId: 'local', folder: env.uploads })).url, { waitUntil: 'networkidle2' });
  const hb = helpers(b);
  await b.waitForSelector('.chat-header');
  await hb.waitIdle();
  assert.notEqual(await a.evaluate(() => sessionStorage.getItem('deck.wid')), await b.evaluate(() => sessionStorage.getItem('deck.wid')));
  console.log('B: janela de outra pasta aberta');

  await a.bringToFront();
  await a.click('.chat-header button[title="Marcar como pendente de visualização"]');
  await ha.waitFor(() => !!document.querySelector('.activitybar .act-badge.pending'), 5000, 'contador da pasta A');
  await a.click('.center .tabs .tab.active .close');
  await ha.waitFor(() => !document.querySelector('.center .tabs .tab'), 5000, 'aba fechada na pasta A');
  assert.ok(await a.$('.activitybar .act-badge.pending'), 'aba fechada ainda deve contar na pasta A');
  console.log('A: pendência mantida após fechar aba');
  await b.bringToFront();

  assert.equal(await b.$('.activitybar .act-badge.pending'), null, 'a pasta B recebeu o alerta da pasta A');
  assert.equal(await b.$('.statusbar .sb-pending'), null, 'o rodapé da pasta B recebeu o alerta');
  assert.ok(!(await b.title()).includes('🔖'), 'o título da pasta B recebeu o alerta');
  console.log('B: barra e título sem alerta');
  await b.click('.activitybar .act-btn[title^="Histórico"]');
  console.log('B: Histórico aberto');
  await b.click('.sidebar .seg button:nth-child(3)');
  console.log('B: aba Pendentes aberta');
  await hb.waitText('.sidebar .tree-empty', 'Nenhuma conversa pendente nesta pasta.');
  assert.equal(await b.$('.sidebar .tree-row.history-pending'), null);
  console.log('B: contador e Histórico isolados');

  await b.evaluate(() => [...document.querySelectorAll('.sidebar .seg')].at(-1)?.querySelectorAll('button')[1]?.click());
  await hb.waitFor(() => !!document.querySelector('.sidebar .tree-row.history-pending'), 10000, 'pendência na visão de todas as pastas');
  await b.screenshot({ path: path.join(ROOT, 'test', 'shots', 'pending-isolation-view.png') });
  await b.evaluate(() => [...document.querySelectorAll('.sidebar .seg button')].find((button) => button.textContent === 'Esta pasta')?.click());
  await hb.waitText('.sidebar .tree-empty', 'Nenhuma conversa pendente nesta pasta.');
  await b.reload({ waitUntil: 'networkidle2' });
  assert.equal(await b.$('.activitybar .act-badge.pending'), null, 'o alerta voltou após F5');
  console.log('Pendências isoladas por pasta, com aba fechada, visão geral e F5: ok');
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
