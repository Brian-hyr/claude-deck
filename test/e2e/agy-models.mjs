// Interface isolada: CLI falsa com modelos diferentes dos aliases do gateway.
import assert from 'node:assert/strict';
import path from 'node:path';
import { startEnv, helpers, ROOT } from './harness.mjs';
const fake = path.join(ROOT, 'test', 'fixtures', 'fake-login.cjs');
const env = await startEnv({ settings: { localAgyPath: fake, defaultEngine: 'antigravity', defaultModel: 'flash38[1m]' } });
const { page } = env;
const h = helpers(page);
try {
  await h.newLocalChat(env.sandbox);
  await page.waitForSelector('.composer-bar .pill-select[title="Modelo desta conversa"]');
  await page.click('.composer-bar .pill-select[title="Modelo desta conversa"]');
  await page.waitForFunction(() => document.querySelector('.ctxmenu')?.textContent.includes('Gemini 4 Argon (Medium)'), { timeout: 15000 });
  const text = await page.$eval('.ctxmenu', (e) => e.textContent);
  assert.ok(text.includes('Claude Opus 5.5 (Low)'));
  assert.ok(!text.includes('flash38[1m]'));
  assert.ok(text.includes('ainda não é suportada'));
  await page.screenshot({ path: path.join(ROOT, 'test', 'shots', 'agy-models-menu.png') });
  console.log('Seletor exibe somente modelos da CLI sintética e avisa sobre a troca indisponível.');
} finally { await env.stop(); }
