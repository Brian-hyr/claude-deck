// Localiza o executável do Claude Code no Windows (o mais novo entre as instalações encontradas).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions } from '../../shared/version';

export { compareVersions };

export interface ClaudeBinary {
  path: string;
  version: string;
  source: string;
}

function readJsonVersion(file: string): string {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? '0';
  } catch {
    return '0';
  }
}

export function findLocalClaude(override?: string): ClaudeBinary[] {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found: ClaudeBinary[] = [];
  const add = (p: string, version: string, source: string) => {
    try {
      if (fs.statSync(p).isFile() && !found.some((f) => f.path.toLowerCase() === p.toLowerCase())) found.push({ path: p, version, source });
    } catch {
      /* não existe */
    }
  };
  if (override) add(override, '999.0.0', 'configurado');
  add(path.join(home, '.local', 'bin', exe), '0', 'instalador nativo');
  const npmRoot = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
  add(path.join(npmRoot, 'bin', exe), readJsonVersion(path.join(npmRoot, 'package.json')), 'npm');
  for (const extRoot of [path.join(home, '.vscode', 'extensions'), path.join(home, '.cursor', 'extensions'), path.join(home, '.windsurf', 'extensions')]) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(extRoot).filter((d) => d.startsWith('anthropic.claude-code-'));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const m = d.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)/);
      add(path.join(extRoot, d, 'resources', 'native-binary', exe), m?.[1] ?? '0', `extensão (${path.basename(path.dirname(extRoot))})`);
    }
  }
  // O instalador nativo guarda versões em ~/.local/share/claude/versions/<versão>.
  const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');
  try {
    const nativeBin = found.find((f) => f.source === 'instalador nativo');
    if (nativeBin) {
      const vs = fs.readdirSync(versionsDir).filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort(compareVersions);
      if (vs.length) nativeBin.version = vs[vs.length - 1];
    }
  } catch {
    /* sem pasta de versões */
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

export function findLocalAgy(override?: string): ClaudeBinary[] {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const cmd = process.platform === 'win32' ? 'agy.cmd' : 'agy';
  const found: ClaudeBinary[] = [];
  const add = (p: string, version: string, source: string) => {
    try {
      if (fs.statSync(p).isFile() && !found.some((f) => f.path.toLowerCase() === p.toLowerCase())) {
        found.push({ path: p, version, source });
      }
    } catch {
      /* não existe */
    }
  };
  if (override) add(override, '999.0.0', 'configurado');
  if (process.env.LOCALAPPDATA) {
    add(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', cmd), '1.0.0', 'Antigravity Programs');
    add(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', exe), '1.0.0', 'Antigravity Programs');
  }
  if (process.env.APPDATA) {
    add(path.join(process.env.APPDATA, 'Antigravity', 'bin', 'agy-node.cmd'), '1.0.0', 'Antigravity Roaming');
    add(path.join(process.env.APPDATA, 'npm', 'agy.cmd'), '1.0.0', 'npm');
    add(path.join(process.env.APPDATA, 'npm', 'agy'), '1.0.0', 'npm');
  }
  add(path.join(home, '.local', 'bin', exe), '1.0.0', 'instalador nativo');
  add(path.join(home, '.local', 'bin', cmd), '1.0.0', 'instalador nativo');
  add(path.join(home, '.gemini', 'antigravity', 'bin', exe), '1.0.0', 'gemini antigravity');
  add(path.join(home, '.gemini', 'antigravity', 'bin', cmd), '1.0.0', 'gemini antigravity');

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of pathDirs) {
    add(path.join(d, cmd), '1.0.0', 'PATH');
    add(path.join(d, exe), '1.0.0', 'PATH');
    add(path.join(d, 'agy-node.cmd'), '1.0.0', 'PATH');
  }

  return found.sort((a, b) => compareVersions(b.version, a.version));
}
