// Destino de uma janela nova do app (servidor + pasta). Viaja na URL como base64url de um JSON
// pequeno (`?open=...`), então usa só coisas que existem no Node e no navegador (TextEncoder/btoa).

export interface OpenTarget {
  /** Id do servidor ("local" ou o alias do ~/.ssh/config). */
  h: string;
  /** Pasta da conversa. Sem ela, vale a pasta pessoal do servidor. */
  f?: string;
  /** Conversa do histórico a retomar nessa janela (sessionId do Claude Code). */
  r?: string;
}

/** Só o alfabeto do base64url e um tamanho razoável: nada que a URL precise escapar. */
export const OPEN_RE = /^[A-Za-z0-9_-]{1,4096}$/;

export const OPEN_MAX_HOST = 200;
export const OPEN_MAX_FOLDER = 1000;
const RESUME_RE = /^[A-Za-z0-9._-]{1,200}$/;

export function isValidTarget(t: any): t is OpenTarget {
  if (!t || typeof t !== 'object') return false;
  if (typeof t.h !== 'string' || !t.h || t.h.length > OPEN_MAX_HOST || /[\r\n\0]/.test(t.h)) return false;
  if (t.f !== undefined && (typeof t.f !== 'string' || !t.f || t.f.length > OPEN_MAX_FOLDER || /[\r\n\0]/.test(t.f))) return false;
  if (t.r !== undefined && (typeof t.r !== 'string' || !RESUME_RE.test(t.r) || t.f === undefined)) return false;
  return true;
}

function clean(t: OpenTarget): OpenTarget {
  const o: OpenTarget = { h: t.h };
  if (t.f !== undefined) o.f = t.f;
  if (t.r !== undefined) o.r = t.r;
  return o;
}

export function encodeOpen(t: OpenTarget): string {
  const bytes = new TextEncoder().encode(JSON.stringify(clean(t)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lê o destino de uma URL. Devolve `null` para qualquer coisa fora do formato (nunca lança). */
export function decodeOpen(s: string | null | undefined): OpenTarget | null {
  if (!s || !OPEN_RE.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return isValidTarget(o) ? clean(o) : null;
  } catch {
    return null;
  }
}
