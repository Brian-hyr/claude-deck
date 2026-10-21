// Explorador: colunas de tamanho e data, escondidas por padrão e ligadas por um botão ao lado do filtro.
//   node test/e2e/explorer-details.mjs      (compile antes: npm run build)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, helpers, ROOT, SANDBOX, sleep } from './harness.mjs';

const env = await startEnv({ sandboxSrc: SANDBOX });
const { page } = env;
const h = helpers(page);
fs.mkdirSync(path.join(ROOT, 'test', 'shots'), { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(ROOT, 'test', 'shots', `explorer-details-${name}.png`) });

const BTN = '.sidebar .search-box .icon-btn[title$="tamanho e data"]';
const metaCount = () => page.$$eval('.sidebar .tree-row .meta', (els) => els.length);
const rowMeta = (name) =>
  page.evaluate((n) => {
    const row = [...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.querySelector('.label')?.textContent === n);
    if (!row) return null;
    const rect = (el) => el.getBoundingClientRect();
    const label = row.querySelector('.label');
    const size = row.querySelector('.meta.size');
    const date = row.querySelector('.meta.date');
    return {
      size: size?.textContent ?? null,
      date: date?.textContent ?? null,
      labelRight: rect(label).right,
      sizeLeft: size ? rect(size).left : null,
      sizeRight: size ? rect(size).right : null,
      dateRight: date ? rect(date).right : null,
    };
  }, name);

let step = 0;
const ok = (msg) => console.log(`${String(++step).padStart(2, '0')}. ${msg}`);

try {
  await h.newLocalChat(env.sandbox);
  await h.findTreeRow('README.md');
  await h.findTreeRow('src');

  // 1. Padrão: escondido.
  assert.equal(await metaCount(), 0, 'por padrão não pode haver colunas de tamanho/data');
  assert.equal(await page.$eval(BTN, (b) => b.getAttribute('title')), 'Mostrar tamanho e data');
  assert.equal(await page.$eval(BTN, (b) => b.getAttribute('aria-pressed')), 'false');
  await shot('off');
  ok('padrão: sem colunas; botão oferece "Mostrar tamanho e data"');

  // 2. Liga.
  await page.click(BTN);
  await h.waitFor(() => document.querySelectorAll('.sidebar .tree-row .meta.size').length > 0, 5000, 'colunas aparecerem');
  assert.equal(await page.$eval(BTN, (b) => b.getAttribute('title')), 'Ocultar tamanho e data');
  assert.equal(await page.$eval(BTN, (b) => b.getAttribute('aria-pressed')), 'true');

  const readme = await rowMeta('README.md');
  const bytes = fs.statSync(path.join(env.sandbox, 'README.md')).size;
  const expected = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  assert.equal(readme.size, expected, `tamanho do README.md: esperava ${expected}`);
  assert.match(readme.date, /^\d\d\/\d\d( \d\d:\d\d|\/\d\d)$/, `data fora do formato: "${readme.date}"`);
  ok(`arquivo mostra tamanho (${readme.size}) e data (${readme.date})`);

  // Pasta: data sim, tamanho não (o do sistema seria o do diretório, não o do conteúdo).
  const src = await rowMeta('src');
  assert.equal(src.size, '', 'pasta não mostra tamanho');
  assert.match(src.date, /^\d\d\/\d\d( \d\d:\d\d|\/\d\d)$/, `data da pasta fora do formato: "${src.date}"`);
  ok(`pasta mostra só a data (${src.date})`);

  // Colunas alinhadas entre linhas e sem invadir o nome.
  const rows = await page.$$eval('.sidebar .tree-row', (rs) =>
    rs
      .filter((r) => r.querySelector('.meta'))
      .map((r) => ({
        labelRight: r.querySelector('.label').getBoundingClientRect().right,
        sizeLeft: r.querySelector('.meta.size').getBoundingClientRect().left,
        sizeRight: r.querySelector('.meta.size').getBoundingClientRect().right,
        dateRight: r.querySelector('.meta.date').getBoundingClientRect().right,
      })),
  );
  assert.ok(rows.length >= 3, 'esperava várias linhas com colunas');
  for (const r of rows) {
    assert.ok(r.labelRight <= r.sizeLeft + 0.5, 'o nome não pode invadir a coluna de tamanho');
    assert.ok(Math.abs(r.sizeRight - rows[0].sizeRight) < 0.5, 'coluna de tamanho desalinhada');
    assert.ok(Math.abs(r.dateRight - rows[0].dateRight) < 0.5, 'coluna de data desalinhada');
  }
  await shot('on');
  ok(`${rows.length} linhas com colunas alinhadas e sem sobrepor o nome`);

  // Subpasta aberta herda a opção.
  await h.clickTree('src');
  await h.waitFor(() => !![...document.querySelectorAll('.sidebar .tree-row .label')].find((e) => e.textContent === 'app.ts'), 5000, 'app.ts na árvore');
  const app = await rowMeta('app.ts');
  assert.ok(app.size && app.date, 'arquivo dentro de pasta aberta também mostra as colunas');
  ok('arquivos de dentro de pastas abertas também mostram');

  // 3. Persiste: o layout é salvo ~600 ms depois; recarregar mantém ligado.
  await sleep(1200);
  await page.reload({ waitUntil: 'networkidle2' });
  await h.findTreeRow('README.md');
  await h.waitFor(() => document.querySelectorAll('.sidebar .tree-row .meta.size').length > 0, 8000, 'colunas continuarem ligadas depois de recarregar');
  ok('continua ligado depois de recarregar a interface');

  // 4. Desliga: some tudo e o estado desligado também persiste.
  await page.click(BTN);
  await h.waitFor(() => document.querySelectorAll('.sidebar .tree-row .meta').length === 0, 5000, 'colunas sumirem');
  await sleep(1200);
  await page.reload({ waitUntil: 'networkidle2' });
  await h.findTreeRow('README.md');
  await sleep(500);
  assert.equal(await metaCount(), 0, 'desligado tem que continuar desligado depois de recarregar');
  ok('desligar esconde e continua escondido depois de recarregar');
} catch (e) {
  await shot(`FALHA-${Date.now()}`).catch(() => {});
  console.error(env.serverLog().slice(-1500));
  throw e;
} finally {
  await env.stop({ keep: !!process.env.E2E_KEEP });
}
