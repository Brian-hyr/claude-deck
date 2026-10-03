// Localiza o executável do Claude Code no Windows (o mais novo entre as instalações encontradas).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeBinary {
  path: string;
  version: string;
  source: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
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
