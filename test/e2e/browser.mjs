// Abre a interface num Brave separado (perfil temporário, sem interface visível) para testes.
// Nunca usa o Brave do dia a dia nem Chromium gerenciado.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRAVE = [
  path.join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.ProgramFiles ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
].find((p) => fs.existsSync(p));

export async function openApp({ port, dataDir, width = 1600, height = 940, headless = true }) {
  if (!BRAVE) throw new Error('Brave não encontrado');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-brave-'));
  const browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless,
    userDataDir: profile,
    defaultViewport: { width, height },
    args: [`--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--disable-features=BraveRewards', '--autoplay-policy=no-user-gesture-required', '--lang=pt-BR'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${port}/auth?t=${token}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.app', { timeout: 20000 });
  return {
    browser,
    page,
    errors,
    async close() {
      await browser.close();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* o Brave ainda segurando algum arquivo */
      }
    },
  };
}
