// Ajuda a achar o arquivo certo quando uma resposta do Claude cita só o nome (ou um caminho
// parcial) e a pasta aparece em outro trecho do texto. Funções puras, sem tela nem rede.

const SKIP_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
// Um ou mais trechos "nome/" seguidos, com prefixo opcional (~, ./, ../, C:\, /): o começo de
// um caminho, mesmo que o resto seja um arquivo. Não começa no meio de uma palavra.
const DIR_RE = /(?<![\w.@/\\-])((?:~|\.{1,2}|[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])+)/g;

/** Barras normais, sem "./" no começo nem barra no fim. */
export function cleanRel(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Pastas citadas no texto (na ordem em que aparecem), como pistas de onde o arquivo pode estar. */
export function extractHintDirs(text: string, max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const clean = text.replace(SKIP_URL, ' ');
  for (const m of clean.matchAll(DIR_RE)) {
    const d = cleanRel(m[1]);
    if (!d || d === '.' || d === '..' || d === '~' || /^\.{1,2}(\/\.{1,2})*$/.test(d)) continue;
    if (/^[\d.,]+(\/[\d.,]+)*$/.test(d)) continue; // datas e frações ("12/05", "3/4"), não pastas
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

/** Arquivos (caminhos relativos com "/") cujo final é o caminho pedido: "x.png" ou "a/x.png". */
export function matchSuffix(files: string[], rel: string, ignoreCase = false): string[] {
  const norm = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const want = norm(cleanRel(rel));
  if (!want || want.includes('..')) return [];
  return files.filter((f) => {
    const n = norm(f);
    return n === want || n.endsWith('/' + want);
  });
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/**
 * Quanto a pasta do arquivo combina com as pastas citadas no texto:
 * 3 = é a pasta citada, 2 = fica dentro dela, 1 = a citada fica dentro da dele, 0 = sem relação.
 */
export function hintScore(file: string, hints: string[]): number {
  const d = cleanRel(dirOf(cleanRel(file)));
  let best = 0;
  for (const raw of hints) {
    const h = cleanRel(raw).replace(/^\/+/, '');
    if (!h) continue;
    const dd = d.replace(/^\/+/, '');
    let s = 0;
    if (dd === h || dd.endsWith('/' + h)) s = 3;
    else if (dd.startsWith(h + '/') || dd.includes('/' + h + '/')) s = 2;
    else if (h.startsWith(dd + '/') || h.includes('/' + dd + '/') || h.endsWith('/' + dd)) s = dd ? 1 : 0;
    if (s > best) best = s;
  }
  return best;
}

/** Ordena do que mais combina com as pastas citadas para o que menos; empates: o mais curto. */
export function rankByHints(files: string[], hints: string[]): { file: string; score: number }[] {
  return files
    .map((file) => ({ file, score: hintScore(file, hints) }))
    .sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
}

/**
 * Escolhe o arquivo quando há vários candidatos: se as pastas citadas apontam para um só, é ele;
 * senão devolve a lista dos que empatam para o usuário escolher.
 */
export function pickCandidate(files: string[], hints: string[]): { chosen?: string; options: string[] } {
  const uniq = [...new Set(files)];
  if (uniq.length <= 1) return { chosen: uniq[0], options: uniq };
  const ranked = rankByHints(uniq, hints);
  const top = ranked.filter((r) => r.score === ranked[0].score);
  if (ranked[0].score > 0 && top.length === 1) return { chosen: top[0].file, options: [top[0].file] };
  return { options: (ranked[0].score > 0 ? top : ranked).map((r) => r.file) };
}

// ---------------------------------------------------------------------------------------------
// Caminhos de pasta citados na resposta. O texto sozinho não prova que é pasta (`/etc/hosts` é
// arquivo, `/api/raw` nem existe): aqui só se decide se VALE a pena mostrar como link; quem diz o
// que é de verdade é o sistema de arquivos, no clique.

/** Um nome de pasta/arquivo sem espaço (letras com acento incluídas). */
const SEG = String.raw`[\p{L}\p{N}_.@+-]+`;
const SEP = String.raw`[\\/]`;
const FOLDER_RULES: RegExp[] = [
  // Termina em barra: "criativos/x/", "agencia-ia\varejo\", "/var/www/", "~/proj/", "./out/".
  new RegExp(String.raw`^(?:~|\.{1,2})?${SEP}?(?:${SEG}${SEP})+$`, 'u'),
  // Começa por ~, ./ ou ../: "~/proj", "./out/img".
  new RegExp(String.raw`^(?:~|\.{1,2})${SEP}${SEG}(?:${SEP}${SEG})*${SEP}?$`, 'u'),
  // Raiz conhecida de servidor: "/opt/site", "/tmp", "/home/user/x". Fora desta lista, "/clear" ou
  // "/api/raw" (comando e rota) pareceriam pasta.
  new RegExp(String.raw`^/(?:home|root|opt|var|etc|usr|srv|mnt|tmp|media|Users|Volumes)(?:/${SEG})*/?$`, 'u'),
  // Com barra invertida: "agencia-ia\varejo". Só caminho do Windows se escreve assim.
  new RegExp(String.raw`^${SEG}(?:\\${SEG})+\\?$`, 'u'),
  // Três níveis ou mais com barra normal: "src/web/components". Com dois seriam "and/or" e "text/html".
  new RegExp(String.raw`^${SEG}(?:/${SEG}){2,}/?$`, 'u'),
];
/** "github.com", "api.exemplo.com.br": o começo de um endereço, não de uma pasta. */
const DOMAIN_LIKE = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

/** Este trecho de código parece um caminho de pasta (e não um comando, rota, endereço, data ou fração)? */
export function looksLikeFolderPath(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > 260) return false;
  if (!/[\p{L}\p{N}]/u.test(s)) return false; // "./", "../", "~/"
  if (/^[\d.,]+(?:[\\/][\d.,]+)*[\\/]?$/.test(s)) return false; // datas e frações ("12/05/", "3/4")
  // Disco do Windows: aí espaço e acento são comuns ("G:\Meu Drive\Processo-Casa-Morrinhos\"). Um ":" depois da
  // letra do disco é "arquivo:linha", que é do clique de arquivo.
  if (/^[A-Za-z]:[\\/]/.test(s)) return !/[:*?"<>|\r\n\t]/.test(s.slice(3));
  if (/[:*?"<>|\s]/.test(s)) return false; // URL ("https://…"), "host:porta", comando com argumentos
  if (!FOLDER_RULES.some((r) => r.test(s))) return false;
  return !DOMAIN_LIKE.test(s.split(/[\\/]/)[0]);
}

/** Pastas (caminhos relativos com "/", sem repetir) que contêm os arquivos da lista, em todos os níveis. */
export function dirsOf(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) out.add(f.slice(0, i));
  }
  return [...out];
}
