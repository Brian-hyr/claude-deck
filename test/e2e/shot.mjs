// Tira uma captura da interface (para revisão visual). Uso: node test/e2e/shot.mjs <porta> <dataDir> <saida.png> [passos]
import { openApp } from './browser.mjs';

const [port, dataDir, out, steps] = process.argv.slice(2);
const app = await openApp({ port: Number(port), dataDir });
const { page } = app;
await new Promise((r) => setTimeout(r, 1200));
if (steps) {
  for (const step of steps.split(';')) {
    const [kind, ...rest] = step.split(':');
    const arg = rest.join(':');
    if (kind === 'click') await page.click(arg);
    else if (kind === 'text') await page.evaluate((t) => [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim() === t)?.click(), arg);
    else if (kind === 'wait') await new Promise((r) => setTimeout(r, Number(arg)));
    else if (kind === 'key') await page.keyboard.press(arg);
    else if (kind === 'type') await page.keyboard.type(arg);
    else if (kind === 'sel') await page.waitForSelector(arg, { timeout: 15000 });
  }
}
await page.screenshot({ path: out });
console.log(app.errors.length ? app.errors.join('\n') : 'sem erros no console');
await app.close();
