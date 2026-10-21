// Âncora das mensagens fixáveis: o uuid da linha do transcript, igual no histórico e ao vivo.
import { describe, expect, it } from 'vitest';
import { ChatModel, type TextItem, type UserItem } from '../../src/web/lib/chatModel';

const texts = (m: ChatModel) => m.items.filter((i): i is TextItem => i.kind === 'text');
const line = (uuid: string | undefined, id: string, content: any[]) => ({ type: 'assistant', ...(uuid ? { uuid } : {}), message: { id, role: 'assistant', content } });
const say = (text: string) => ({ type: 'text', text });

describe('âncora de mensagem fixável', () => {
  it('texto do Claude vindo do transcript usa o uuid da linha', () => {
    const m = new ChatModel();
    m.apply(line('aaaaaaaa-0000-4000-8000-000000000001', 'msg-1', [say('primeira')]), { history: true });
    m.apply(line('aaaaaaaa-0000-4000-8000-000000000002', 'msg-1', [say('segunda')]), { history: true });
    expect(texts(m).map((t) => t.anchor)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']);
  });

  it('vários blocos de texto na mesma linha ganham sufixo #n; raciocínio e ferramenta não deslocam a contagem', () => {
    const m = new ChatModel();
    m.apply(
      line('bbbbbbbb-0000-4000-8000-000000000001', 'msg-2', [
        say('um'),
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 'call-1', name: 'Read', input: {} },
        say('dois'),
        say('   '), // vazio: não vira item, mas ocupa o índice para o próximo não variar com ele
        say('quatro'),
      ]),
      { history: true },
    );
    expect(texts(m).map((t) => [t.text, t.anchor])).toEqual([
      ['um', 'bbbbbbbb-0000-4000-8000-000000000001'],
      ['dois', 'bbbbbbbb-0000-4000-8000-000000000001#1'],
      ['quatro', 'bbbbbbbb-0000-4000-8000-000000000001#3'],
    ]);
  });

  it('texto transmitido ao vivo recebe a âncora quando a linha completa chega, igual à do histórico', () => {
    const uuid = 'cccccccc-0000-4000-8000-000000000001';
    const live = new ChatModel();
    live.apply({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-3' } } });
    live.apply({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    live.apply({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'olá aos poucos' } } });
    // Ainda transmitindo: sem âncora (e a interface não oferece o alfinete).
    expect(texts(live)[0].streaming).toBe(true);
    expect(texts(live)[0].anchor).toBeUndefined();
    live.apply({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    live.apply(line(uuid, 'msg-3', [say('olá aos poucos')]));
    expect(texts(live)).toHaveLength(1);
    expect(texts(live)[0]).toMatchObject({ streaming: false, anchor: uuid });

    const history = new ChatModel();
    history.apply(line(uuid, 'msg-3', [say('olá aos poucos')]), { history: true });
    expect(texts(history)[0].anchor).toBe(texts(live)[0].anchor);
  });

  it('a mesma linha chegando de novo (transcript + buffer ao vivo) não duplica nem muda a âncora', () => {
    const uuid = 'dddddddd-0000-4000-8000-000000000001';
    const m = new ChatModel();
    m.apply(line(uuid, 'msg-4', [say('uma só vez')]), { history: true });
    m.apply(line(uuid, 'msg-4', [say('uma só vez')]), { replay: true });
    m.apply(line(uuid, 'msg-4', [say('uma só vez')]));
    expect(texts(m)).toHaveLength(1);
    expect(texts(m)[0].anchor).toBe(uuid);
  });

  it('linha sem uuid fica sem âncora (não dá para fixar o que não tem identidade estável)', () => {
    const m = new ChatModel();
    m.apply(line(undefined, 'msg-5', [say('sem identidade')]), { history: true });
    expect(texts(m)[0].anchor).toBeUndefined();
  });

  it('páginas mais antigas carregadas depois mantêm as âncoras e não mexem nas atuais', () => {
    const current = new ChatModel();
    current.apply(line('eeeeeeee-0000-4000-8000-000000000002', 'msg-7', [say('recente')]), { history: true });
    const older = new ChatModel();
    older.apply(line('eeeeeeee-0000-4000-8000-000000000001', 'msg-6', [say('antiga')]), { history: true });
    current.prepend(older);
    expect(texts(current).map((t) => [t.text, t.anchor])).toEqual([
      ['antiga', 'eeeeeeee-0000-4000-8000-000000000001'],
      ['recente', 'eeeeeeee-0000-4000-8000-000000000002'],
    ]);
  });

  it('mensagem do usuário: o uuid só vale como âncora depois de confirmada pelo eco do CLI', () => {
    const uuid = 'ffffffff-0000-4000-8000-000000000001';
    const m = new ChatModel();
    m.addPendingUser(uuid, 'minha pergunta', []);
    const pending = m.items.find((i) => i.kind === 'user') as UserItem;
    expect(pending).toMatchObject({ uuid, pending: true });
    m.apply({ type: 'user', uuid, message: { id: 'msg-u', role: 'user', content: [{ type: 'text', text: 'minha pergunta' }] } });
    const users = m.items.filter((i) => i.kind === 'user') as UserItem[];
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ uuid, pending: false });
  });
});
