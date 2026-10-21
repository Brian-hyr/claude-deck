// Atualização do Claude Code num servidor SSH: o Deck não reimplementa a instalação, só roda o
// `claude update` do próprio binário (que escolhe sozinho entre instalador nativo e npm).
// Este módulo é puro (sem SSH) para ser testado: classificar o binário, montar o comando, ler a saída.
import { DeckError } from '../../shared/protocol';

export type ClaudeBinKind = 'extension' | 'updatable';

/**
 * Binário que vem da extensão do VS Code/Cursor/Windsurf instalada no servidor: quem o atualiza é o editor
 * (a pasta leva a versão no nome). Rodar `update` nele não adianta, e o Deck não mexe na pasta do editor.
 */
export function classifyClaudeBin(binPath: string): ClaudeBinKind {
  // Mesmo padrão que o runner.sh usa em version_of().
  return /\/anthropic\.claude-code-[^/]+\/resources\/native-binary\/claude$/.test(binPath) ? 'extension' : 'updatable';
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/**
 * Comando de shell que roda `<claude> update` com o shell de login do servidor (acha nvm/npm como o usuário
 * acharia) e termina com `DECK_EXIT=<código>`. O caminho vai em base64: nenhuma letra dele chega ao shell.
 */
export function buildUpdateCommand(binPath: string): string {
  if (!binPath.startsWith('/') || /[\0\r\n]/.test(binPath)) throw new DeckError('bad', 'Caminho do Claude inválido.');
  // Base64 só tem [A-Za-z0-9+/=]: vai sem aspas, então o script inteiro cabe em um único par de aspas simples.
  const b64 = Buffer.from(binPath).toString('base64');
  const script =
    `B=$(printf %s ${b64} | base64 -d 2>/dev/null) || exit 3; ` +
    `PATH="$(dirname "$B"):$PATH"; export PATH; ` +
    // O código de saída é guardado na hora: depois do "echo", $? já seria o do próprio echo (sempre 0).
    `"$B" update </dev/null 2>&1; rc=$?; echo; echo "DECK_EXIT=$rc"`;
  return `exec "\${SHELL:-/bin/sh}" -lc '${script}'`;
}

export interface UpdateOutput {
  /** Código de saída do `claude update`; null se a marca não apareceu (conexão cortada, tempo esgotado). */
  exit: number | null;
  /** Final da saída, sem cores ANSI, para mostrar ao usuário. */
  tail: string;
}

export function parseUpdateOutput(stdout: string, maxChars = 2000): UpdateOutput {
  const clean = stdout.replace(ANSI, '').replace(/\r/g, '');
  const m = clean.match(/^DECK_EXIT=(\d+)\s*$/m);
  const body = clean.replace(/^DECK_EXIT=\d+\s*$/m, '').trim();
  return { exit: m ? Number(m[1]) : null, tail: body.length > maxChars ? '…' + body.slice(-maxChars) : body };
}
