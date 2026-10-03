import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG_FILE = path.join(ROOT, 'src', 'web', 'public', 'favicon.svg');
const ICONS_DIR = path.join(ROOT, 'src', 'web', 'public', 'icons');
const LAUNCHER_DIR = path.join(ROOT, 'launcher');

const BRAVE_PATHS = [
  path.join(process.env.LOCALAPPDATA ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.ProgramFiles ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
];

const BRAVE = BRAVE_PATHS.find((p) => fs.existsSync(p));
if (!BRAVE) {
  console.error('Brave executável não encontrado.');
  process.exit(1);
}

function buildIco(images) {
  // images: array of { width, height, buffer }
  // Header: 6 bytes
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(count, 4); // count

  let offset = 6 + count * 16;
  const entries = [];
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(img.buffer.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    entries.push(entry);
    offset += img.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((img) => img.buffer)]);
}

async function main() {
  if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });
  const svgContent = fs.readFileSync(SVG_FILE, 'utf8');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  svg { width: 100%; height: 100%; display: block; }
</style>
</head>
<body>${svgContent}</body>
</html>`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-icon-'));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: BRAVE,
      headless: true,
      userDataDir: profile,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=BraveRewards'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    const sizes = [16, 32, 48, 64, 128, 192, 256, 512];
    const rendered = {};

    for (const size of sizes) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      const buf = await page.screenshot({ omitBackground: true, type: 'png' });
      rendered[size] = buf;
      console.log(`Rendered icon ${size}x${size} (${buf.length} bytes)`);
    }

    // Save PNG icons
    fs.writeFileSync(path.join(ICONS_DIR, 'icon-192.png'), rendered[192]);
    fs.writeFileSync(path.join(ICONS_DIR, 'icon-512.png'), rendered[512]);

    // Build multi-res ICO file (16, 32, 48, 64, 256)
    const icoSizes = [16, 32, 48, 64, 256];
    const icoBuffer = buildIco(icoSizes.map((s) => ({ width: s, height: s, buffer: rendered[s] })));

    fs.writeFileSync(path.join(ICONS_DIR, 'icon.ico'), icoBuffer);
    fs.writeFileSync(path.join(ROOT, 'src', 'web', 'public', 'favicon.ico'), icoBuffer);
    fs.writeFileSync(path.join(LAUNCHER_DIR, 'icon.ico'), icoBuffer);

    console.log('Icons generated successfully:');
    console.log(' - ' + path.join(ICONS_DIR, 'icon-192.png'));
    console.log(' - ' + path.join(ICONS_DIR, 'icon-512.png'));
    console.log(' - ' + path.join(ICONS_DIR, 'icon.ico'));
    console.log(' - ' + path.join(ROOT, 'src', 'web', 'public', 'favicon.ico'));
    console.log(' - ' + path.join(LAUNCHER_DIR, 'icon.ico'));
  } finally {
    if (browser) await browser.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
