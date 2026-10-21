// Leitura do texto da área de transferência do Windows, feita pelo servidor.
//
// Por que existe: colar com o botão direito no terminal usa `navigator.clipboard.readText()`, que depende da
// permissão "área de transferência" do navegador. A janela do Deck é um `--app` com perfil próprio, e ali a
// permissão fica gravada: se foi bloqueada uma vez (ou dispensada), TODA leitura falha em silêncio e o
// navegador nunca mais pergunta. O daemon roda na mesma máquina do navegador (127.0.0.1), então ele lê a mesma
// área de transferência sem passar pela permissão. É só reserva: a interface tenta o navegador primeiro.
import { execFile } from 'node:child_process';
import { DeckError } from '../shared/protocol';
import { resolvePowerShellExe } from './browser';

/** Passa de 1 MiB não é colagem de terminal, é engano (ou ataque): recusa em vez de encher a memória. */
export const CLIPBOARD_MAX_BYTES = 1024 * 1024;

export interface ClipboardReadOptions {
  platform?: string;
  timeoutMs?: number;
  execFileFn?: typeof execFile;
  powerShellPath?: string;
}

// O texto sai em Base64 de UTF-8: não depende de página de código do console oculto, não perde acento nem
// emoji e preserva as quebras de linha exatamente como estão. `-STA` porque a área de transferência do
// Windows exige esse modelo de thread.
export const CLIPBOARD_SCRIPT =
  "$t = Get-Clipboard -Raw -Format Text; " +
  "if ($null -ne $t) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t))) }";

/** Texto da área de transferência ('' quando está vazia ou guarda outra coisa, como imagem ou arquivos). */
export function readClipboardText(opts: ClipboardReadOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return Promise.reject(new DeckError('unsupported', 'A leitura da área de transferência pelo servidor só existe no Windows.'));
  const run = opts.execFileFn ?? execFile;
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(CLIPBOARD_SCRIPT, 'utf16le').toString('base64')];
  return new Promise<string>((resolve, reject) => {
    try {
      run(
        resolvePowerShellExe(opts.powerShellPath),
        args,
        { timeout: opts.timeoutMs ?? 8_000, windowsHide: true, maxBuffer: Math.ceil((CLIPBOARD_MAX_BYTES * 4) / 3) + 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error) {
            const tooBig = (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            reject(new DeckError('clipboard', tooBig ? 'O texto copiado é grande demais para colar no terminal (limite de 1 MB).' : `Não consegui ler a área de transferência do Windows: ${error.message}`));
            return;
          }
          const text = Buffer.from(String(stdout).trim(), 'base64').toString('utf8');
          if (Buffer.byteLength(text) > CLIPBOARD_MAX_BYTES) reject(new DeckError('clipboard', 'O texto copiado é grande demais para colar no terminal (limite de 1 MB).'));
          else resolve(text);
        },
      );
    } catch (e) {
      reject(new DeckError('clipboard', `Não consegui chamar o PowerShell: ${(e as Error).message}`));
    }
  });
}
