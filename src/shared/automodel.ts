// Modo "Automático" (`auto` / `auto[1m]`): o gateway (proxy) escolhe o modelo e o esforço no 1º pedido da
// conversa e usa essa escolha até o fim. O CLI continua rodando com o modelo automático; o Deck só descobre
// a escolha (arquivo do hook ou aviso dele no transcript) para mostrar no seletor de modelo.
import type { AutoModelPick, EffortLevel } from './types';

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** O que foi lido do hook (arquivo ou aviso no transcript), antes de casar com o seletor de modelo. */
export interface AutoDecision {
  model: string;
  /** Valor exato do seletor, quando o hook informa (`cli_model`). */
  cliModel?: string;
  effort?: EffortLevel;
  label?: string;
}

/** Modelo roteado pelo gateway (a escolha real chega depois do 1º pedido). */
export function isAutoModel(model: string | undefined | null): boolean {
  if (!model) return false;
  const m = model.toLowerCase().trim();
  return m === 'auto' || m.startsWith('auto[') || m.startsWith('auto-') || m.startsWith('auto_');
}

function asEffort(v: unknown): EffortLevel | undefined {
  return typeof v === 'string' && EFFORTS.includes(v.toLowerCase() as EffortLevel) ? (v.toLowerCase() as EffortLevel) : undefined;
}

const stripCtx = (s: string) => s.toLowerCase().trim().replace(/\[[^\]]+\]$/, '');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Valor do seletor de modelo que corresponde ao modelo escolhido pelo gateway: `flash38` → `flash38[1m]`,
 * `Flash Lite 3.5` → `flashlite35[1m]`, `Opus 5.5` → `claude-opus-5-5[1m]`. Sem correspondência, devolve o recebido.
 */
export function matchModelOption(decided: string, options: { value: string; displayName?: string }[]): string {
  const raw = (decided ?? '').trim();
  if (!raw) return raw;
  const cands = options.filter((o) => o.value && o.value !== 'default' && !isAutoModel(o.value));
  const norm = raw.toLowerCase();
  const exact = cands.find((o) => o.value.toLowerCase() === norm);
  if (exact) return exact.value;
  // Mesmo modelo sem o sufixo de contexto ([1m], [256k]) e sem pontuação.
  const base = squash(stripCtx(raw));
  if (!base) return raw;
  const byValue = cands.find((o) => squash(stripCtx(o.value)) === base);
  if (byValue) return byValue.value;
  // Nome de exibição (o aviso do hook traz o nome curto, ex. "Opus 5.5").
  if (base.length >= 3) {
    const byName = cands.find((o) => {
      const d = squash((o.displayName ?? '').replace(/\([^)]*\)/g, ''));
      return !!d && (d.includes(base) || squash(stripCtx(o.value)).endsWith(base));
    });
    if (byName) return byName.value;
  }
  return raw;
}

/** Arquivo que o hook grava em `~/.cache/cc-auto/<sessionId>` ao decidir: `{"model","cli_model","effort","label"}`. */
export function parseAutoMarker(text: string): AutoDecision | null {
  let d: any;
  try {
    d = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!d || typeof d.model !== 'string' || !d.model.trim()) return null;
  return {
    model: d.model.trim(),
    cliModel: typeof d.cli_model === 'string' && d.cli_model.trim() ? d.cli_model.trim() : undefined,
    effort: asEffort(d.effort),
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : undefined,
  };
}

/**
 * Aviso que o hook injeta no 1º pedido (fica no transcript para sempre, mesmo depois de o arquivo do hook expirar):
 * "Sessão no modo Automático: o gateway escolheu Flash Lite 3.5 low (nível 1 – simples, esforço low) para ...".
 */
export function parseAutoDecisionText(text: string): AutoDecision | null {
  const m = /gateway escolheu\s+(.+?)\s+\(n(?:í|i)vel\s+(\d+)([^)]*)\)/i.exec(text ?? '');
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  // O rótulo termina com o esforço ("Flash 3.8 low"): o nome do modelo é o resto.
  const tail = words.length > 1 ? asEffort(words[words.length - 1]) : undefined;
  const model = (tail ? words.slice(0, -1) : words).join(' ');
  if (!model) return null;
  return { model, effort: asEffort(/esfor(?:ç|c)o\s+([a-z]+)/i.exec(m[3])?.[1]) ?? tail, label: `N${m[2]} · ${m[1].trim()}` };
}

/** Escolha do gateway casada com o seletor de modelo do servidor. */
export function toAutoPick(found: AutoDecision, options: { value: string; displayName?: string }[]): AutoModelPick {
  const cli = found.cliModel ? options.find((o) => o.value === found.cliModel)?.value : undefined;
  return { model: cli ?? matchModelOption(found.model, options), effort: found.effort, label: found.label };
}
