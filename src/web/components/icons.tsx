// Ícones (codicons do VS Code) e ícones de arquivo por extensão.
import { extname } from '../../shared/paths';

export function Icon({ name, class: cls, title, style }: { name: string; class?: string; title?: string; style?: any }) {
  return <i class={`codicon codicon-${name}${cls ? ' ' + cls : ''}`} title={title} style={style} aria-hidden="true" />;
}

const FILE_ICON: Record<string, [string, string]> = {
  ts: ['file-code', '#3178c6'],
  tsx: ['file-code', '#3178c6'],
  js: ['file-code', '#e8d44d'],
  mjs: ['file-code', '#e8d44d'],
  cjs: ['file-code', '#e8d44d'],
  jsx: ['file-code', '#61dafb'],
  json: ['json', '#e8d44d'],
  jsonc: ['json', '#e8d44d'],
  jsonl: ['json', '#e8d44d'],
  md: ['markdown', '#519aba'],
  mdx: ['markdown', '#519aba'],
  html: ['file-code', '#e44d26'],
  htm: ['file-code', '#e44d26'],
  css: ['file-code', '#42a5f5'],
  scss: ['file-code', '#f06292'],
  py: ['file-code', '#4b8bbe'],
  go: ['file-code', '#00add8'],
  rs: ['file-code', '#dea584'],
  java: ['file-code', '#e76f00'],
  php: ['file-code', '#8892bf'],
  rb: ['ruby', '#cc342d'],
  sh: ['terminal', '#89e051'],
  bash: ['terminal', '#89e051'],
  ps1: ['terminal-powershell', '#5391fe'],
  yml: ['file-code', '#cb171e'],
  yaml: ['file-code', '#cb171e'],
  toml: ['settings', '#9c4221'],
  ini: ['settings', '#9c9c9c'],
  conf: ['settings', '#9c9c9c'],
  env: ['settings', '#e8d44d'],
  sql: ['database', '#e38c00'],
  db: ['database', '#9c9c9c'],
  sqlite: ['database', '#9c9c9c'],
  prisma: ['database', '#5a67d8'],
  png: ['file-media', '#a074c4'],
  jpg: ['file-media', '#a074c4'],
  jpeg: ['file-media', '#a074c4'],
  gif: ['file-media', '#a074c4'],
  webp: ['file-media', '#a074c4'],
  svg: ['file-media', '#ffb13b'],
  ico: ['file-media', '#a074c4'],
  mp4: ['device-camera-video', '#e06c75'],
  webm: ['device-camera-video', '#e06c75'],
  mov: ['device-camera-video', '#e06c75'],
  mkv: ['device-camera-video', '#e06c75'],
  wav: ['unmute', '#56b6c2'],
  mp3: ['unmute', '#56b6c2'],
  ogg: ['unmute', '#56b6c2'],
  m4a: ['unmute', '#56b6c2'],
  flac: ['unmute', '#56b6c2'],
  pdf: ['file-pdf', '#e5534b'],
  zip: ['file-zip', '#afb42b'],
  gz: ['file-zip', '#afb42b'],
  tar: ['file-zip', '#afb42b'],
  tgz: ['file-zip', '#afb42b'],
  csv: ['table', '#89d185'],
  tsv: ['table', '#89d185'],
  xlsx: ['table', '#1d6f42'],
  log: ['output', '#9c9c9c'],
  txt: ['file-text', '#9c9c9c'],
  lock: ['lock', '#9c9c9c'],
  vue: ['file-code', '#41b883'],
  svelte: ['file-code', '#ff3e00'],
  xml: ['file-code', '#e37933'],
  c: ['file-code', '#5c6bc0'],
  h: ['file-code', '#5c6bc0'],
  cpp: ['file-code', '#5c6bc0'],
  cs: ['file-code', '#9b4f96'],
  kt: ['file-code', '#a97bff'],
  lua: ['file-code', '#000080'],
  dart: ['file-code', '#00b4ab'],
};

const NAME_ICON: Record<string, [string, string]> = {
  'package.json': ['package', '#cb3837'],
  'package-lock.json': ['lock', '#cb3837'],
  dockerfile: ['vm', '#2496ed'],
  'docker-compose.yml': ['vm', '#2496ed'],
  'docker-compose.yaml': ['vm', '#2496ed'],
  'claude.md': ['sparkle', '#d97757'],
  '.gitignore': ['git-commit', '#f05032'],
  'readme.md': ['book', '#519aba'],
  makefile: ['tools', '#9c9c9c'],
  '.env': ['settings', '#e8d44d'],
};

export function FileIcon({ name, dir, open }: { name: string; dir?: boolean; open?: boolean }) {
  if (dir) {
    const lower = name.toLowerCase();
    const special = lower === '.git' ? '#f05032' : lower === 'node_modules' ? '#8bc34a' : lower === '.claude' ? '#d97757' : undefined;
    return (
      <span class="file-icon">
        <Icon name={open ? 'folder-opened' : 'folder'} style={{ color: special ?? '#dcb67a' }} />
      </span>
    );
  }
  const lower = name.toLowerCase();
  const [icon, color] = NAME_ICON[lower] ?? (lower.startsWith('.env') ? NAME_ICON['.env'] : undefined) ?? FILE_ICON[extname(name)] ?? ['file', 'var(--fg-muted)'];
  return (
    <span class="file-icon">
      <Icon name={icon} style={{ color }} />
    </span>
  );
}

export function ClaudeLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#d97757"
        d="M4.7 15.9l4.7-2.6.1-.2-.1-.1h-.2l-.8-.1-2.7-.1-2.3-.1-2.3-.1-.6-.1-.5-.7.1-.4.5-.3.7.1 1.5.1 2.3.2 1.7.1 2.5.3h.4l.1-.2-.1-.1-.1-.1-2.4-1.6-2.6-1.7-1.4-1-.7-.5-.4-.5-.2-1 .7-.7.9.1.2.1.9.7 1.9 1.5 2.5 1.8.4.3.1-.1v-.1l-.2-.3-1.4-2.5-1.5-2.6-.7-1.1-.2-.6c-.1-.3-.1-.5-.1-.7l.8-1.1.4-.1 1 .1.4.4.6 1.4 1 2.2 1.5 3 .5.9.2.8.1.3h.2v-.2l.1-1.7.2-2.1.2-2.7.1-.8.4-.9.7-.5.6.3.5.7-.1.4-.3 1.9-.6 3-.4 2.1h.2l.3-.3 1.2-1.6 2-2.5.9-1 1-1.1.7-.5h1.2l.9 1.3-.4 1.4-1.3 1.6-1.1 1.4-1.5 2-1 1.7.1.1h.2l3.4-.7 1.8-.3 2.2-.4 1 .5.1.5-.4 1-2.4.6-2.8.6-4.2 1-.1.1.1.1 1.9.2.8.1h2l3.7.3 1 .6.6.8-.1.6-1.5.8-2-.5-4.7-1.1-1.6-.4h-.2v.1l1.3 1.3 2.5 2.2 3 2.8.2.7-.4.6-.4-.1-2.7-2-1-.9-2.3-2h-.2v.2l.5.8 2.8 4.2.1 1.3-.2.4-.7.3-.8-.1-1.7-2.4-1.7-2.7-1.4-2.4-.2.1-.8 8.8-.4.5-.9.3-.8-.6-.4-1 .4-1.9.5-2.4.4-1.9.4-2.4.2-.8v-.1h-.2l-1.9 2.6-2.9 3.9-2.3 2.5-.6.2-1-.5.1-.9.5-.8 3.1-4 1.9-2.5 1.2-1.4v-.2h-.1l-8.3 5.4-1.5.2-.6-.6.1-1 .3-.3 2.5-1.7z"
      />
    </svg>
  );
}
