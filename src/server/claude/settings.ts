// Leitura e gravação segura do settings.json do Claude Code (global e projeto, local e SSH).
import type { HostFs } from '../fs/hostfs';
import { mkdirp } from '../fs/hostfs';
import type {
  Platform,
  ClaudeSettingsScope,
  ClaudeSettingsGetResult,
  ClaudeSettingsSaveParams,
  ClaudeSettingsSaveResult,
} from '../../shared/types';
import { LOCAL_HOST_ID } from '../../shared/types';
import { DeckError } from '../../shared/protocol';
import { dirname, join } from '../../shared/paths';

/** Resolve o caminho absoluto do settings.json conforme o escopo e o servidor. */
export function resolveClaudeSettingsPath(
  platform: Platform,
  home: string,
  hostId: string,
  scope: ClaudeSettingsScope,
  cwd?: string,
): string {
  if (scope === 'project') {
    if (!cwd || !cwd.trim()) throw new DeckError('bad', 'Pasta do projeto não informada.');
    return join(platform, cwd.trim(), '.claude', 'settings.json');
  }
  // Escopo global do usuário
  if (hostId === LOCAL_HOST_ID && process.env.CLAUDE_CONFIG_DIR) {
    return join(platform, process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  }
  return join(platform, home, '.claude', 'settings.json');
}

/** Lê o settings.json do servidor indicado; cria representação padrão vazia se o arquivo não existir. */
export async function readClaudeSettings(
  host: { fs: HostFs; platform: Platform },
  home: string,
  hostId: string,
  scope: ClaudeSettingsScope,
  cwd?: string,
): Promise<ClaudeSettingsGetResult> {
  const filePath = resolveClaudeSettingsPath(host.platform, home, hostId, scope, cwd);
  const exists = await host.fs.exists(filePath);
  if (!exists) {
    return {
      exists: false,
      path: filePath,
      scope,
      hostId,
      settings: {},
      raw: '{\n}\n',
      mtime: 0,
    };
  }

  const { data, mtime } = await host.fs.read(filePath, 4 * 1024 * 1024);
  const raw = data.toString('utf8').replace(/^﻿/, '');
  try {
    const parsed = JSON.parse(raw);
    return {
      exists: true,
      path: filePath,
      scope,
      hostId,
      settings: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
      raw,
      mtime,
    };
  } catch (err: any) {
    return {
      exists: true,
      path: filePath,
      scope,
      hostId,
      settings: {},
      raw,
      mtime,
      error: `JSON malformado: ${err?.message ?? err}`,
    };
  }
}

/** Grava o settings.json com validação de sintaxe, backup automático (.bak-<timestamp>) e criação de pasta. */
export async function saveClaudeSettings(
  host: { fs: HostFs; platform: Platform },
  home: string,
  hostId: string,
  params: ClaudeSettingsSaveParams,
): Promise<ClaudeSettingsSaveResult> {
  const filePath = resolveClaudeSettingsPath(host.platform, home, hostId, params.scope, params.cwd);
  let content = '';

  if (params.raw !== undefined) {
    let parsed: any;
    try {
      parsed = JSON.parse(params.raw);
    } catch (e: any) {
      throw new DeckError('bad', `JSON inválido: ${e?.message ?? e}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DeckError('bad', 'O arquivo settings.json precisa ser um objeto JSON.');
    }
    content = JSON.stringify(parsed, null, 2) + '\n';
  } else if (params.settings !== undefined) {
    content = JSON.stringify(params.settings, null, 2) + '\n';
  } else {
    throw new DeckError('bad', 'Nenhum conteúdo informado para salvar.');
  }

  // Backup automático do arquivo existente antes de sobrescrever
  let backupPath: string | undefined;
  if (await host.fs.exists(filePath)) {
    try {
      const existing = await host.fs.read(filePath, 10 * 1024 * 1024);
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      backupPath = `${filePath}.bak-${stamp}`;
      await host.fs.write(backupPath, existing.data);
    } catch {
      /* backup é melhor esforço; se falhar não impede salvar o arquivo principal */
    }
  }

  // Garante que a pasta destino (.claude) exista
  await mkdirp(host.fs, dirname(host.platform, filePath));

  // Grava o arquivo formatado
  const stat = await host.fs.write(filePath, Buffer.from(content, 'utf8'));
  return {
    ok: true,
    path: filePath,
    mtime: stat.mtime,
    backupPath,
  };
}
