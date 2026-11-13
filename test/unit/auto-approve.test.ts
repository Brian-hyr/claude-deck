import { describe, expect, it } from 'vitest';
import { autoApprovable } from '../../src/server/claude/session.js';
import { ChatModel } from '../../src/web/lib/chatModel.js';

const req = (tool_name: string, id = 'r1') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input: { command: 'ls' }, tool_use_id: 'tu-' + id } });

describe('Aprovar sozinho', () => {
  it('libera ferramentas, mas não perguntas nem aprovação de plano', () => {
    expect(autoApprovable(req('Bash'))).toBe(true);
    expect(autoApprovable(req('Edit'))).toBe(true);
    expect(autoApprovable(req('mcp__x__y'))).toBe(true);
    expect(autoApprovable(req('AskUserQuestion'))).toBe(false);
    expect(autoApprovable(req('ExitPlanMode'))).toBe(false);
  });

  it('a resposta enviada pelo servidor tira o pedido de pendente na interface', () => {
    const m = new ChatModel();
    m.apply(req('Bash') as any);
    expect(m.pendingCount).toBe(1);
    m.apply({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: {} }, auto: true } } as any);
    expect(m.pendingCount).toBe(0);
  });
});
