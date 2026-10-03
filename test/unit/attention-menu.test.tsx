// @vitest-environment jsdom
// Barra de status: "N esperando você" e "N concluídas" abrem, para cima, a lista das conversas desta
// janela que pedem atenção; clicar numa linha leva direto à conversa, sem procurar entre as abas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { signal } from '@preact/signals';
import { ChatModel, type ToolItem } from '../../src/web/lib/chatModel';
import { rpc } from '../../src/web/lib/rpc';
import { activateChat, activeChatId, chats, pendingConversations, pendingSupported, setConversationPending, type ChatTab } from '../../src/web/lib/state';
import { AttentionMenu, attentionLists, attentionMenu } from '../../src/web/components/AttentionMenu';
import { StatusBar } from '../../src/web/components/StatusBar';
import type { SessionState } from '../../src/shared/types';

function fakeChat(sid: string, patch: Partial<SessionState> = {}): ChatTab {
  return {
    sid,
    state: signal<SessionState>({ sid, hostId: 'local', cwd: 'C:\\proj', phase: 'idle', createdAt: 1, title: `Conversa ${sid}`, ...patch }),
    model: new ChatModel(),
    version: signal(0),
    loaded: true, // activateChat não precisa buscar nada no servidor
    loading: signal(false),
    loadError: signal(null),
    hasMore: signal(false),
    lastSeq: 0,
    queued: [],
    attention: signal(null),
    draft: '',
    images: [],
  };
}

/** Conversa com um pedido de permissão (ou pergunta/plano) esperando resposta. */
function waitingChat(sid: string, toolName = 'Bash', extra: Partial<SessionState> = {}): ChatTab {
  const c = fakeChat(sid, { phase: 'running', ...extra });
  const t: ToolItem = {
    kind: 'tool',
    key: `k-${sid}`,
    id: `t-${sid}`,
    name: toolName,
    input: {},
    status: 'running',
    children: [],
    permission: { requestId: `r-${sid}`, toolName, input: {}, status: 'pending' },
  };
  c.model.pendingPermissions.set(`r-${sid}`, t);
  return c;
}

const doneChat = (sid: string, patch: Partial<SessionState> = {}) => fakeChat(sid, { unseen: 'done', lastActivityAt: Date.now() - 5 * 60_000, ...patch });
const errorChat = (sid: string, patch: Partial<SessionState> = {}) => fakeChat(sid, { unseen: 'error', error: 'Falhou\ndetalhe', ...patch });

let container: HTMLDivElement | undefined;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  render(
    <>
      <StatusBar />
      <AttentionMenu />
    </>,
    container,
  );
}

const item = (needle: string) => [...container!.querySelectorAll<HTMLElement>('.statusbar .sb-attn')].find((el) => el.textContent?.includes(needle));
const menu = () => container!.querySelector<HTMLElement>('.attn-menu');
const rows = () => [...container!.querySelectorAll<HTMLElement>('.attn-row')];

beforeEach(() => {
  vi.spyOn(rpc, 'call').mockResolvedValue(undefined); // markSeen avisa o servidor
});

afterEach(() => {
  if (container) render(null, container); // desmonta: solta os ouvintes da janela
  container = undefined;
  document.body.innerHTML = '';
  chats.value = [];
  activeChatId.value = null;
  attentionMenu.value = null;
  pendingConversations.value = {};
  pendingSupported.value = false;
  vi.restoreAllMocks();
});

describe('attentionLists', () => {
  it('separa esperando você de concluídas, uma lista por conversa, na ordem das abas', () => {
    chats.value = [
      fakeChat('ociosa'),
      doneChat('d1'),
      waitingChat('w1'),
      fakeChat('trabalhando', { phase: 'running' }),
      errorChat('e1'),
      waitingChat('w2', 'AskUserQuestion'),
      doneChat('d2'),
    ];
    const l = attentionLists();
    expect(l.waiting.map((c) => c.sid)).toEqual(['w1', 'w2']);
    expect(l.finished.map((c) => c.sid)).toEqual(['d1', 'e1', 'd2']);
  });

  it('marca manual entra em pendentes, não em concluídas; fica após marcar a aba ativa até abrir outra vez', async () => {
    pendingSupported.value = true;
    const c = fakeChat('manual', { sessionId: '00000000-0000-4000-8000-000000000001' });
    chats.value = [c];
    activeChatId.value = c.sid;
    expect(await setConversationPending('local', c.state.value.sessionId, c.state.value.cwd, true)).toBe(true);
    expect(attentionLists().pending.map((x) => x.sid)).toEqual(['manual']);
    expect(attentionLists().finished).toEqual([]);
    // O marcador continua lá mesmo que a conversa já esteja ativa.
    expect(c.state.value.unseen).toBeUndefined();
    expect(pendingConversations.value[JSON.stringify(['local', c.state.value.sessionId])]).toBeTruthy();
    activateChat(c.sid); // clicar na própria aba ativa não desmarca
    expect(attentionLists().pending).toEqual([c]);
    const other = fakeChat('other');
    chats.value = [c, other];
    activateChat(other.sid);
    activateChat(c.sid);
    await vi.waitFor(() => expect(attentionLists().pending).toEqual([]));
    expect(vi.mocked(rpc.call).mock.calls.some(([method, params]) => method === 'pending.set' && params.pending === false)).toBe(true);
  });

  it('esperando resposta vale mais que "terminou"; trabalhando de novo tira da lista de concluídas', () => {
    chats.value = [waitingChat('w', 'Bash', { unseen: 'done' }), fakeChat('r', { phase: 'running', unseen: 'done' })];
    const l = attentionLists();
    expect(l.waiting.map((c) => c.sid)).toEqual(['w']);
    expect(l.finished).toEqual([]);
  });

  it('o aviso de permissão que a interface já sabe (attention) também conta', () => {
    const c = fakeChat('a');
    c.attention.value = 'permission';
    chats.value = [c];
    expect(attentionLists().waiting).toEqual([c]);
  });
});

describe('barra de status', () => {
  it('sem nada pendente, não mostra os dois itens', () => {
    chats.value = [fakeChat('a'), fakeChat('b', { phase: 'running' })];
    mount();
    expect(item('esperando você')).toBeUndefined();
    expect(item('conclu')).toBeUndefined();
  });

  it('mostra quantas esperam você e quantas concluíram (com ou sem erro), no singular e no plural', () => {
    chats.value = [waitingChat('w1'), waitingChat('w2'), doneChat('d1')];
    mount();
    expect(item('esperando você')?.textContent).toContain('2 esperando você');
    expect(item('conclu')?.textContent).toContain('1 concluída');
    expect(item('conclu')?.classList.contains('has-error')).toBe(false);

    chats.value = [waitingChat('w1'), doneChat('d1'), errorChat('e1')];
    return vi.waitFor(() => {
      expect(item('esperando você')?.textContent).toContain('1 esperando você');
      expect(item('conclu')?.textContent).toContain('2 concluídas');
      expect(item('conclu')?.classList.contains('has-error')).toBe(true);
    });
  });
});

describe('menu', () => {
  it('abre para cima ao clicar em "esperando você" e diz o que cada conversa pede', async () => {
    chats.value = [waitingChat('w1', 'Bash'), waitingChat('w2', 'AskUserQuestion'), waitingChat('w3', 'ExitPlanMode'), doneChat('d1')];
    mount();
    expect(menu()).toBeNull();

    item('esperando você')!.click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());

    expect(menu()!.textContent).toContain('Esperando você (3)');
    expect(rows().map((r) => r.querySelector('.attn-title')?.textContent)).toEqual(['Conversa w1', 'Conversa w2', 'Conversa w3']);
    const subs = rows().map((r) => r.querySelector('.attn-sub')?.textContent);
    expect(subs[0]).toContain('Pede permissão: Bash');
    expect(subs[1]).toBe('Pergunta para você');
    expect(subs[2]).toBe('Plano para você aprovar');
    expect(item('esperando você')?.classList.contains('open')).toBe(true);
  });

  it('"concluídas" lista só as terminadas, com o motivo do erro e há quanto tempo terminou', async () => {
    chats.value = [waitingChat('w1'), doneChat('d1'), errorChat('e1')];
    mount();
    item('conclu')!.click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());

    expect(menu()!.textContent).toContain('Concluídas, ainda não vistas (2)');
    expect(rows().map((r) => r.querySelector('.attn-title')?.textContent)).toEqual(['Conversa d1', 'Conversa e1']);
    expect(rows()[0].querySelector('.attn-sub')?.textContent).toBe('Terminou há 5 min');
    expect(rows()[1].querySelector('.attn-sub')?.textContent).toBe('Terminou com erro: Falhou'); // só a 1ª linha do erro
  });

  it('clicar numa linha abre aquela conversa, fecha o menu e some o "não visto" dela', async () => {
    chats.value = [fakeChat('atual'), doneChat('d1'), doneChat('d2')];
    activeChatId.value = 'atual';
    mount();
    item('conclu')!.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    rows()[1].click();

    expect(activeChatId.value).toBe('d2');
    expect(attentionMenu.value).toBeNull(); // fecha na hora; o DOM acompanha na próxima renderização
    await vi.waitFor(() => expect(menu()).toBeNull());
    expect(chats.value.find((c) => c.sid === 'd2')!.state.value.unseen).toBeUndefined();
    expect(chats.value.find((c) => c.sid === 'd1')!.state.value.unseen).toBe('done'); // as outras continuam esperando
    expect(rpc.call).toHaveBeenCalledWith('sessions.seen', { sid: 'd2' });
    // A lista e o contador se atualizam sozinhos.
    await vi.waitFor(() => expect(item('conclu')?.textContent).toContain('1 concluída'));
  });

  it('clicar de novo no mesmo item fecha; clicar no outro item troca de lista', async () => {
    chats.value = [waitingChat('w1'), doneChat('d1')];
    mount();
    item('esperando você')!.click();
    await vi.waitFor(() => expect(menu()?.textContent).toContain('Esperando você'));

    item('conclu')!.click();
    await vi.waitFor(() => expect(menu()?.textContent).toContain('Concluídas'));
    expect(container!.querySelectorAll('.attn-menu')).toHaveLength(1);

    item('conclu')!.click();
    await vi.waitFor(() => expect(menu()).toBeNull());
  });

  it('clicar fora fecha, mas clicar dentro do menu não', async () => {
    chats.value = [doneChat('d1')];
    mount();
    item('conclu')!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(menu())); // os ouvintes já estão ligados

    menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await vi.waitFor(() => expect(menu()).toBeNull());
  });

  it('Esc fecha só o menu e devolve o cursor à caixa de mensagem (sem interromper o Claude)', async () => {
    chats.value = [doneChat('d1')];
    mount();
    const onFocusComposer = vi.fn();
    window.addEventListener('deck:focus-composer', onFocusComposer);
    item('conclu')!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(menu())); // o foco está no menu

    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(menu()).toBeNull());
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    window.removeEventListener('deck:focus-composer', onFocusComposer);
  });

  it('setas movem entre as linhas', async () => {
    chats.value = [doneChat('d1'), doneChat('d2'), doneChat('d3')];
    mount();
    item('conclu')!.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(menu()));
    const key = (k: string) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    key('ArrowDown');
    expect(document.activeElement).toBe(rows()[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    key('ArrowUp');
    key('ArrowUp'); // dá a volta
    expect(document.activeElement).toBe(rows()[2]);
  });

  it('fecha sozinho quando a última conversa da lista deixa de pedir você', async () => {
    const c = doneChat('d1');
    chats.value = [c];
    mount();
    item('conclu')!.click();
    await vi.waitFor(() => expect(menu()).not.toBeNull());

    c.state.value = { ...c.state.value, unseen: undefined }; // vista em outra parte (ex.: pela aba)

    await vi.waitFor(() => expect(attentionMenu.value).toBeNull()); // não fica "aberto" invisível
    expect(menu()).toBeNull();
    await vi.waitFor(() => expect(item('conclu')).toBeUndefined());
  });
});
