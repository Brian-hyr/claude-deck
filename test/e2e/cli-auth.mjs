// Login com CLIs falsas, Brave isolado e dados temporários. Nenhuma conta real é utilizada.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startEnv, helpers, ROOT } from './harness.mjs';

const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck fake login '));
for (const name of ['fake-login.cmd', 'fake-login.cjs']) fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', name), path.join(fakeDir, name));
const fake = path.join(fakeDir, 'fake-login.cmd');
const env = await startEnv({ settings: { localAgyPath: fake, localClaudePath: fake } });
const { page } = env;
const h = helpers(page);
try {
  const models = await h.rpc('sessions.agyModels', { hostId: 'local' });
  assert.deepEqual(models.map((m) => m.value), ['gemini-4-argon-medium', 'claude-opus-5-5-low']);
  await page.click('.act-btn[title="Servidores"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .tree-row .label')].some((e) => e.textContent.includes('Este computador')));
  for (const [label, title] of [['Entrar no Antigravity', 'Antigravity'], ['Entrar no Claude Code', 'Claude Code']]) {
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('.sidebar .tree-row')].find((e) => e.querySelector('.label')?.textContent.includes('Este computador')));
    await row.asElement().click({ button: 'right' });
    await h.menu(label);
    await page.waitForSelector('[role="dialog"] a', { timeout: 20000 });
    assert.ok((await page.$eval('[role="dialog"]', (e) => e.textContent)).includes(title));
    await page.screenshot({ path: path.join(ROOT, 'test', 'shots', `cli-auth-${title.replace(/ /g, '-')}.png`) });
    await page.type('[role="dialog"] input[type="password"]', 'fake-code');
    await h.clickText('[role="dialog"] button', 'Enviar código');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Autenticação confirmada'), { timeout: 20000 });
    assert.equal(await page.$eval('[role="dialog"]', (e) => e.textContent.includes('fake-code')), false);
    await h.clickText('[role="dialog"] button', 'Fechar');
  }
  console.log('Login de ambos os motores passou com CLIs falsas.');
} catch (e) {
  console.error('Diálogo:', await page.$eval('[role="dialog"]', (el) => el.textContent).catch(() => '(não aberto)'));
  throw e;
} finally { await env.stop(); fs.rmSync(fakeDir, { recursive: true, force: true }); }
