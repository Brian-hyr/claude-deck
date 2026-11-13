import { describe, expect, it } from 'vitest';
import { parseAgyModels } from '../../src/server/claude/agyModels';

describe('modelos informados pelo Antigravity', () => {
  it('interpreta o formato da CLI sem alterar os IDs', () => {
    expect(parseAgyModels([
      'gemini-4-argon-medium     Gemini 4 Argon (Medium)',
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'claude-opus-5-5-low       Claude Opus 5.5 (Low)',
      'gpt-oss-120b-medium       GPT-OSS 120B (Medium)',
    ].join('\n'))).toEqual([
      { value: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon (Medium)' },
      { value: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
      { value: 'claude-opus-5-5-low', displayName: 'Claude Opus 5.5 (Low)' },
      { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
    ]);
  });
  it('descarta mensagens e IDs repetidos', () => {
    expect(parseAgyModels('Not signed in\nmodel-id   Nome\nmodel-id   Nome repetido\n')).toEqual([{ value: 'model-id', displayName: 'Nome' }]);
  });
});
