// @vitest-environment jsdom
// Teste unitário para a função de ir para a primeira mensagem (solicitação inicial).
import { describe, expect, it } from 'vitest';
import { firstMessageJump, jumpToFirstMessage } from '../../src/web/lib/state';
import { ChatModel, type UserItem } from '../../src/web/lib/chatModel';

describe('primeira mensagem da conversa (solicitação inicial)', () => {
  it('jumpToFirstMessage atualiza o sinal com o sid e incrementa a sequência', () => {
    firstMessageJump.value = null;
    jumpToFirstMessage('session-1');
    expect(firstMessageJump.value).toMatchObject({ sid: 'session-1', n: expect.any(Number) });
    const n1 = firstMessageJump.value!.n;

    jumpToFirstMessage('session-1');
    expect(firstMessageJump.value).toMatchObject({ sid: 'session-1', n: n1 + 1 });

    jumpToFirstMessage('session-2');
    expect(firstMessageJump.value).toMatchObject({ sid: 'session-2', n: n1 + 2 });
  });

  it('ChatModel identifica a primeira mensagem de usuário como a solicitação inicial', () => {
    const m = new ChatModel();
    m.apply({
      type: 'user',
      uuid: 'user-req-1',
      message: { role: 'user', content: 'Quero criar uma função de ir para a primeira mensagem no Claude Deck' },
    }, { history: true });

    m.apply({
      type: 'assistant',
      uuid: 'ast-resp-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Entendido, vou implementar!' }] },
    }, { history: true });

    m.apply({
      type: 'user',
      uuid: 'user-req-2',
      message: { role: 'user', content: 'Agora rode os testes' },
    }, { history: true });

    const userMsgs = m.items.filter((it): it is UserItem => it.kind === 'user' && (!it.source || it.source === 'user'));
    expect(userMsgs).toHaveLength(2);
    // A primeira solicitação inicial é a primeira mensagem do usuário na conversa
    expect(userMsgs[0].text).toBe('Quero criar uma função de ir para a primeira mensagem no Claude Deck');
    expect(userMsgs[0].uuid).toBe('user-req-1');
  });
});
