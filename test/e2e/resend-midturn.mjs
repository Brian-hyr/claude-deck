// Mensagem enviada com o Claude trabalhando que ele ignora: depois da tarefa aparece "Reenviar como nova mensagem".
//   node test/e2e/resend-midturn.mjs      (compile antes: npm run build)
// O Claude falso tem o comando `ignoremid`: entrega ao modelo (eco no fluxo) o que chegar durante a tarefa e termina
// sem responder a isso, como se vê em transcripts reais do CLI.
import assert from 'node:assert/strict';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX });
const { page } = env;
const h = helpers(page);
const shot = (name) => page.screenshot({ path: path.join(ROOT, 'test', 'shots', `resend-midturn-${name}.png`) });
const bubbles = () => page.$$eval('.msg.user .user-bubble', (e) => e.map((x) => x.textContent.trim()));
const resendButtons = () => page.$$eval('.msg.user > .msg-resend', (e) => e.map((x) => ({ text: x.textContent.trim(), shown: getComputedStyle(x).visibility !== 'hidden' })));

let step = 0;
const ok = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);

try {
  await h.newLocalChat(env.sandbox);

  // 1. Com o Claude parado, mandar algo não oferece reenvio.
  await h.send('echo oi parado');
  await h.waitText('.msg-response', 'oi parado');
  await h.waitIdle();
  assert.deepEqual(await resendButtons(), [], 'mensagem enviada com o Claude parado não deve ter botão de reenviar');
  ok('mensagem enviada com o Claude parado: sem botão de reenviar');

  // 2. Tarefa de 4 s; no meio dela, uma segunda mensagem que o "modelo" vai ignorar.
  await h.send('ignoremid 40');
  await h.waitFor(() => !!document.querySelector('.send-btn.stop') || document.querySelector('.phase-pill.running'), 8000, 'tarefa em andamento');
  await h.send('segundo pedido no meio da tarefa');
  assert.deepEqual(await resendButtons(), [], 'enquanto a tarefa roda não deve haver botão (o CLI ainda pode entregar a mensagem)');
  ok('com a tarefa rodando: ainda sem botão');

  // 3. A tarefa acaba sem responder à segunda mensagem: o botão aparece só nela.
  await h.waitText('.msg-response', 'Terminei a tarefa.');
  await h.waitIdle();
  await h.waitFor(() => document.querySelectorAll('.msg.user > .msg-resend').length === 1, 5000, 'botão de reenviar');
  const before = await resendButtons();
  assert.equal(before.length, 1);
  assert.ok(before[0].text.includes('Reenviar como nova mensagem'), before[0].text);
  const owner = await page.$eval('.msg.user:has(> .msg-resend) .user-bubble', (e) => e.textContent.trim());
  assert.ok(owner.includes('segundo pedido no meio da tarefa'), `o botão apareceu na mensagem errada: ${owner}`);
  assert.equal(before[0].shown, true, 'a mensagem foi confirmada pelo CLI: o botão aparece na hora');
  assert.equal(await h.count('.msg-response'), 2, 'o Claude não respondeu à segunda mensagem (só às duas tarefas)');
  await shot('botao');
  ok('tarefa acabou sem resposta à segunda mensagem: o botão aparece só nela');

  // 4. Clicar reenvia como mensagem nova, que o Claude responde; o botão some.
  await page.click('.msg.user > .msg-resend');
  await h.waitText('.msg-response', 'Recebi: segundo pedido no meio da tarefa');
  await h.waitIdle();
  assert.deepEqual(await resendButtons(), [], 'depois de reenviar, o botão tem de sumir');
  const texts = await bubbles();
  assert.equal(texts.filter((t) => t.includes('segundo pedido no meio da tarefa')).length, 2, `deveria haver a original e a reenviada: ${JSON.stringify(texts)}`);
  await shot('reenviada');
  ok('um clique reenvia como mensagem nova, o Claude responde e o botão some (a original continua na conversa)');

  // 5. Nova tarefa com mensagem no meio, e o usuário segue a conversa sozinho: o botão não fica à espreita.
  await h.send('ignoremid 30');
  await h.waitFor(() => !!document.querySelector('.send-btn.stop') || document.querySelector('.phase-pill.running'), 8000, 'tarefa em andamento');
  await h.send('terceiro pedido no meio');
  await h.waitText('.msg-response', 'Terminei a tarefa.', 20000);
  await h.waitIdle();
  await h.waitFor(() => document.querySelectorAll('.msg.user > .msg-resend').length === 1, 5000, 'botão de reenviar na terceira');
  await h.send('echo conversa seguiu');
  await h.waitText('.msg-response', 'conversa seguiu');
  await h.waitIdle();
  assert.deepEqual(await resendButtons(), [], 'depois de você escrever outra coisa, o botão antigo tem de sumir');
  ok('se você segue a conversa, o botão antigo some');

  console.log(`\nReenviar mensagem do meio da tarefa: ${step} verificações ok`);
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
