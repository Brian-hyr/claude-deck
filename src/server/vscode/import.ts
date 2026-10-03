// Importa do VS Code: pastas abertas por servidor (favoritos e recentes), conversas arquivadas
// e o modo de permissão padrão da extensão do Claude. Só leitura nos arquivos do VS Code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PermissionMode } from '../../shared/types';

export interface VscodeImport {
  folders: { hostId: string; path: string; when: number }[];
  archivedSessions: string[];
  defaultPermissionMode?: PermissionMode;
}

function decodeAuthority(auth: string): string | null {
  // "ssh-remote+<hex de JSON {hostName}>" ou "ssh-remote+alias"
  const m = auth.match(/^ssh-remote\+(.+)$/i);
  if (!m) return null;
  const v = m[1];
  if (/^[0-9a-f]+$/i.test(v) && v.length % 2 === 0) {
    try {
      const j = JSON.parse(Buffer.from(v, 'hex').toString('utf8'));
      if (j?.hostName) return String(j.hostName);
    } catch {
      /* não era hex de JSON */
    }
  }
  return decodeURIComponent(v);
}

export function parseFolderUri(uri: string): { hostId: string; path: string } | null {
  const dec = uri.startsWith('file:') ? uri : uri;
  const remote = dec.match(/^vscode-remote:\/\/([^/]+)(\/.*)?$/i);
  if (remote) {
    const host = decodeAuthority(decodeURIComponent(remote[1]));
    if (!host) return null;
    return { hostId: host, path: decodeURIComponent(remote[2] ?? '/') || '/' };
  }
  const file = dec.match(/^file:\/\/\/([a-zA-Z])(?::|%3A)(\/.*)?$/i);
  if (file) {
    const p = `${file[1].toUpperCase()}:${decodeURIComponent(file[2] ?? '/')}`.replace(/\//g, '\\');
    return { hostId: 'local', path: p };
  }
  return null;
}

export async function importFromVscode(appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')): Promise<VscodeImport> {
  const result: VscodeImport = { folders: [], archivedSessions: [] };
  const userDir = path.join(appData, 'Code', 'User');
  // 1) workspaceStorage/<hash>/workspace.json — cada pasta já aberta, com data de uso.
  const wsRoot = path.join(userDir, 'workspaceStorage');
  try {
    for (const d of fs.readdirSync(wsRoot)) {
      const wj = path.join(wsRoot, d, 'workspace.json');
      let j: any;
      try {
        j = JSON.parse(fs.readFileSync(wj, 'utf8'));
      } catch {
        continue;
      }
      const uri: string | undefined = j.folder;
      if (!uri) continue;
      const parsed = parseFolderUri(uri);
      if (!parsed) continue;
      let when = 0;
      try {
        when = fs.statSync(path.join(wsRoot, d, 'state.vscdb')).mtimeMs;
      } catch {
        try {
          when = fs.statSync(path.join(wsRoot, d)).mtimeMs;
        } catch {
          /* sem data */
        }
      }
      result.folders.push({ ...parsed, when });
    }
  } catch {
    /* VS Code não instalado */
  }
  // 2) Estado global: conversas ocultas/arquivadas e modo padrão da extensão do Claude.
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(userDir, 'globalStorage', 'state.vscdb'), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'Anthropic.claude-code'").get() as { value?: string } | undefined;
      if (row?.value) {
        const v = JSON.parse(String(row.value));
        if (Array.isArray(v.hiddenSessionIds)) result.archivedSessions = v.hiddenSessionIds.filter((x: unknown) => typeof x === 'string');
        const mode = v.defaultPermissionMode;
        if (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(mode)) result.defaultPermissionMode = mode;
      }
      // Pastas remotas citadas em outras chaves (quando não há workspace.json).
      const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%remote%' OR key LIKE '%history%'").all() as { value: unknown }[];
      for (const r of rows) {
        const text = String(r.value ?? '');
        for (const m of text.matchAll(/vscode-remote:\/\/ssh-remote(?:\+|%2B)[^"\s,\]}]+/gi)) {
          const parsed = parseFolderUri(decodeURIComponent(m[0]));
          if (parsed && !result.folders.some((f) => f.hostId === parsed.hostId && f.path === parsed.path)) result.folders.push({ ...parsed, when: 0 });
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* sem banco de estado */
  }
  result.folders.sort((a, b) => b.when - a.when);
  return result;
}
