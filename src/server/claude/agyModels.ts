import child_process from 'node:child_process';
import type { HostRegistry } from '../hosts/registry';
import { shq } from '../fs/hostfs';
import { LOCAL_HOST_ID, type ModelOption } from '../../shared/types';
import { DeckError } from '../../shared/protocol';

/** Interpreta somente linhas de modelos, nunca mensagens de login ou texto arbitrário como IDs. */
export function parseAgyModels(output: string): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*([a-zA-Z0-9][a-zA-Z0-9._:-]*)\s{2,}([^\r\n]+?)\s*$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ value: m[1], displayName: m[2] });
  }
  return out;
}

/** Consulta a CLI do destino, sem pedir modelo nem modificar credenciais. */
export async function listAgyModels(registry: HostRegistry, hostId: string): Promise<ModelOption[]> {
  if (!registry.exists(hostId)) throw new DeckError('nohost', 'Servidor desconhecido.');
  const status = await registry.connect(hostId);
  const bin = status.agy?.path;
  if (!bin) throw new DeckError('noagy', 'Antigravity CLI não encontrado neste servidor.');
  let output: string;
  if (hostId === LOCAL_HOST_ID) {
    const script = /\.(?:mjs|cjs|js)$/i.test(bin);
    let command = script ? process.execPath : bin;
    let args = script ? [bin, 'models'] : ['models'];
    const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
    if (batch) {
      if (/[&|<>^%!\r\n"]/u.test(bin)) throw new DeckError('bad', 'Caminho do Antigravity incompatível com a consulta de modelos.');
      command = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', `""${bin}" models"`];
    }
    output = await new Promise<string>((resolve, reject) => {
      child_process.execFile(command, args, { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true, windowsVerbatimArguments: batch }, (err, stdout) => {
        if (err) reject(new DeckError('agy_models', 'Não foi possível consultar os modelos do Antigravity. Confira a instalação e o login.'));
        else resolve(stdout);
      });
    });
  } else {
    const ssh = registry.get(hostId).ssh!;
    const result = await ssh.run(`${shq(bin)} models`, { timeoutMs: 20_000, maxBytes: 1024 * 1024 });
    if (result.code !== 0) throw new DeckError('agy_models', 'Não foi possível consultar os modelos do Antigravity. Confira a instalação e o login.');
    output = result.stdout;
  }
  const models = parseAgyModels(output);
  if (!models.length) throw new DeckError('agy_models', 'O Antigravity não informou modelos reconhecíveis. Confira o login e a versão da CLI.');
  return models;
}
