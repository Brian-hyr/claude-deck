// O destino de "Sempre permitir" é sempre o usuário do computador/servidor da conversa.
// Mudar o destino no pedido de resposta, não nas sugestões recebidas: "Permitir" uma vez fica intacto.
export function forUserSettings(suggestion: any): any {
  if (!suggestion || typeof suggestion !== 'object' || suggestion.type === 'setMode') return suggestion;
  if (suggestion.type === 'addRules' || suggestion.type === 'addDirectories') return { ...suggestion, destination: 'userSettings' };
  return suggestion;
}

export function permissionChoiceLabel(s: any, hostId: string): string | null {
  if (!s) return null;
  if (s.type === 'setMode') {
    if (s.mode === 'acceptEdits') return 'Permitir e aceitar edições automaticamente nesta conversa';
    if (s.mode === 'bypassPermissions') return 'Permitir tudo nesta conversa';
    return `Permitir e mudar para o modo ${s.mode}`;
  }
  const where = hostId === 'local' ? 'neste computador' : `em ${hostId}`;
  if (s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length) {
    const rules = s.rules.map((r: any) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return `Sempre permitir ${rules} em todos os projetos ${where}`;
  }
  if (s.type === 'addDirectories') return `Permitir acesso a ${s.directories?.join(', ')} em todos os projetos ${where}`;
  return null;
}
