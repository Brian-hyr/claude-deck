import { describe, expect, it } from 'vitest';
import { isAutoModel, matchModelOption, parseAutoDecisionText, parseAutoMarker, toAutoPick } from '../../src/shared/automodel';

// Mesma lista do modelPicker dos servidores de teste (com "Automático" e "Default", que nunca são a escolha).
const OPTIONS = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'auto[1m]', displayName: 'Automático (1M)' },
  { value: 'claude-opus-5-5[1m]', displayName: 'Claude Opus 5.5 (1M)' },
  { value: 'flash38[1m]', displayName: 'Gemini 3.8 Flash (1M)' },
  { value: 'sonnet55[1m]', displayName: 'Sonnet 5.5 (1M)' },
  { value: 'kimik3.1-pro', displayName: 'Kimi K3.1 Pro (256K)' },
  { value: 'haiku55[1m]', displayName: 'Haiku 5.5 (1M)' },
  { value: 'flashlite35[1m]', displayName: 'Gemini 3.5 Flash Lite (1M)' },
  { value: 'flashlite31[1m]', displayName: 'Gemini 3.1 Flash Lite (1M)' },
  { value: 'kpaopus55[1m]', displayName: 'Opus 5.5 (kpalabz)' },
];

describe('modo automático (gateway escolhe o modelo)', () => {
  it('reconhece o modelo automático', () => {
    for (const m of ['auto', 'auto[1m]', 'AUTO[1M]', 'auto-router', 'auto_fast']) expect(isAutoModel(m)).toBe(true);
    for (const m of ['claude-opus-5-5[1m]', 'flash38[1m]', 'autonomous', '', undefined, null]) expect(isAutoModel(m)).toBe(false);
  });

  it('casa o modelo do hook com o seletor de modelo', () => {
    expect(matchModelOption('flash38', OPTIONS)).toBe('flash38[1m]');
    expect(matchModelOption('flash38[1m]', OPTIONS)).toBe('flash38[1m]');
    expect(matchModelOption('claude-opus-5-5', OPTIONS)).toBe('claude-opus-5-5[1m]');
    expect(matchModelOption('flashlite35', OPTIONS)).toBe('flashlite35[1m]');
    expect(matchModelOption('kimik3.1-pro', OPTIONS)).toBe('kimik3.1-pro');
    expect(matchModelOption('haiku55', OPTIONS)).toBe('haiku55[1m]');
    // Nome curto do aviso do hook.
    expect(matchModelOption('Flash 3.8', OPTIONS)).toBe('flash38[1m]');
    expect(matchModelOption('Flash Lite 3.5', OPTIONS)).toBe('flashlite35[1m]');
    expect(matchModelOption('Opus 5.5', OPTIONS)).toBe('claude-opus-5-5[1m]');
    // Nunca devolve o próprio automático nem o padrão; sem correspondência, fica o nome recebido.
    expect(matchModelOption('auto', OPTIONS)).toBe('auto');
    expect(matchModelOption('modelo-desconhecido', OPTIONS)).toBe('modelo-desconhecido');
  });

  it('lê o arquivo do hook (~/.cache/cc-auto/<sessionId>)', () => {
    const d = parseAutoMarker('{"model": "flashlite35", "cli_model": "flashlite35[1m]", "effort": "low", "nivel": 1, "label": "N1 \\u00b7 Flash Lite 3.5 low"}');
    expect(d).toEqual({ model: 'flashlite35', cliModel: 'flashlite35[1m]', effort: 'low', label: 'N1 · Flash Lite 3.5 low' });
    // Formato antigo, sem cli_model.
    expect(parseAutoMarker('{"model": "flash38", "effort": "medium", "nivel": 3, "label": "N3 · Flash 3.8 medium"}')?.model).toBe('flash38');
    expect(parseAutoMarker('')).toBeNull();
    expect(parseAutoMarker('{"effort":"low"}')).toBeNull();
    expect(parseAutoMarker('{"model":"x","effort":"turbo"}')?.effort).toBeUndefined();
  });

  it('lê o aviso que o hook deixa no transcript', () => {
    const real =
      "Sessão no modo Automático: o gateway escolheu Flash 3.8 low (nível 2 – simples, esforço low) para esta conversa inteira. O seletor de modelo mostra 'auto'; se o usuário perguntar, informe o modelo acima.";
    expect(parseAutoDecisionText(real)).toEqual({ model: 'Flash 3.8', effort: 'low', label: 'N2 · Flash 3.8 low' });
    expect(parseAutoDecisionText('o gateway escolheu Opus 5.5 medium (nível 5 – complexa, esforço medium) para esta')).toEqual({
      model: 'Opus 5.5',
      effort: 'medium',
      label: 'N5 · Opus 5.5 medium',
    });
    expect(parseAutoDecisionText('o gateway escolheu Flash Lite 3.5 low (nível 1 – simples) para')).toEqual({ model: 'Flash Lite 3.5', effort: 'low', label: 'N1 · Flash Lite 3.5 low' });
    expect(parseAutoDecisionText('nada a ver')).toBeNull();
  });

  it('prefere o valor exato do seletor informado pelo hook', () => {
    expect(toAutoPick({ model: 'flashlite35', cliModel: 'flashlite35[1m]', effort: 'low' }, OPTIONS)).toEqual({ model: 'flashlite35[1m]', effort: 'low', label: undefined });
    // cli_model que o seletor não tem: cai no casamento pelo nome.
    expect(toAutoPick({ model: 'Opus 5.5', cliModel: 'opus-x[1m]' }, OPTIONS).model).toBe('claude-opus-5-5[1m]');
  });
});
