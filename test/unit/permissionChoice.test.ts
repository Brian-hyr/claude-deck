import { describe, expect, it } from 'vitest';
import { forUserSettings, permissionChoiceLabel } from '../../src/web/lib/permissionChoice';

describe('Sempre permitir no usuário do host da conversa', () => {
  it('troca addRules sem alterar a sugestão original (nem regras, comportamento e opções)', () => {
    for (const destination of ['session', 'localSettings', 'projectSettings', 'userSettings']) {
      const suggestion = { type: 'addRules', destination, behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] };
      const result = forUserSettings(suggestion);
      expect(result).toEqual({ ...suggestion, destination: 'userSettings' });
      expect(suggestion.destination).toBe(destination);
      expect(result.rules).toBe(suggestion.rules);
    }
  });
  it('acesso a diretórios vira configuração do usuário, mas setMode não muda', () => {
    const access = { type: 'addDirectories', destination: 'projectSettings', directories: ['/tmp'] };
    expect(forUserSettings(access)).toEqual({ ...access, destination: 'userSettings' });
    const mode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
    expect(forUserSettings(mode)).toBe(mode);
  });
  it('não muda sugestões que não conhece nem valores ausentes', () => {
    const other = { type: 'futureSuggestion', destination: 'localSettings' };
    expect(forUserSettings(other)).toBe(other);
    expect(forUserSettings(null)).toBeNull();
  });
  it('o rótulo diz o host, não promete que a regra vale em todos os servidores', () => {
    const s = { type: 'addRules', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] };
    expect(permissionChoiceLabel(s, 'local')).toContain('todos os projetos neste computador');
    expect(permissionChoiceLabel(s, 'srv-teste')).toContain('todos os projetos em srv-teste');
    expect(permissionChoiceLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, 'local')).toContain('nesta conversa');
  });
});
