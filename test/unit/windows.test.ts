import { describe, it, expect } from 'vitest';
import {
  attachWindow,
  compareContext,
  compareContextKey,
  contextKey,
  getWindowContext,
  getWindowContextKey,
  isEmptyState,
  migrateLegacyWindows,
  normalizeContextPath,
  pruneWindows,
  reconcileWindowSessions,
  sameContext,
  sameFolder,
  saveWindowState,
  windowContextKey,
  type WindowMap,
} from '../../src/server/windows';
import type { SessionState, UiState } from '../../src/shared/types';

const tab = (sid: string, hostId = 'local', cwd = 'C:\\x') => ({ sid, hostId, cwd });
const st = (...sids: string[]): UiState => ({ chatTabs: sids.map((sid) => tab(sid)), fileTabs: [] });
const W = (n: number) => `janela-${String(n).padStart(4, '0')}`; // passa no WID_RE (8+ chars)
const session = (sid: string, wid?: string, hostId = 'local', cwd = 'C:\\x'): SessionState => ({
  sid,
  wid,
  hostId,
  cwd,
  phase: 'dormant',
  createdAt: 100,
});

describe('context key / comparador exportado', () => {
  it('Windows local: ignora caixa, barras invertidas e barra final redundante (preservando raízes)', () => {
    expect(sameFolder('local', 'C:\\Users\\Usuario\\Projeto', 'c:/users/usuario/projeto')).toBe(true);
    expect(sameFolder('local', 'C:\\Users\\Usuario\\Projeto\\', 'c:/users/usuario/projeto')).toBe(true);
    expect(normalizeContextPath('local', 'C:\\Users\\Usuario\\Projeto\\')).toBe('c:\\users\\usuario\\projeto');
    expect(normalizeContextPath('local', 'c:/users/usuario/projeto')).toBe('c:\\users\\usuario\\projeto');
    expect(normalizeContextPath('local', 'C:\\')).toBe('c:\\');
    expect(normalizeContextPath('local', 'c:/')).toBe('c:\\');
    expect(sameFolder('local', 'C:\\', 'c:/')).toBe(true);
  });

  it('Remoto POSIX: normalizado (remove barras duplicadas e barra final) e case-sensitive', () => {
    expect(sameFolder('srv', '/home/usuario/app', '/home/usuario//app/')).toBe(true);
    expect(sameFolder('srv', '/home/usuario/app', '/home/usuario/app/')).toBe(true);
    expect(normalizeContextPath('srv', '/home/usuario//app/')).toBe('/home/usuario/app');
    expect(sameFolder('srv', '/home/Usuario/app', '/home/usuario/app')).toBe(false);
    expect(normalizeContextPath('srv', '/')).toBe('/');
    expect(sameFolder('srv', '/', '//')).toBe(true);
  });

  it('sameContext e compareContext comparam host e pasta de contexto', () => {
    expect(sameContext('local', 'C:\\x', 'local', 'c:/x/')).toBe(true);
    expect(sameContext('srv1', '/a', 'srv2', '/a')).toBe(false);
    expect(compareContext('srv', '/a', 'srv', '/a/')).toBe(true);
    expect(compareContextKey(contextKey('local', 'C:\\x'), windowContextKey('local', 'c:/x/'))).toBe(true);
    expect(compareContextKey(contextKey('srv', '/a'), contextKey('srv', '/b'))).toBe(false);
  });

  it('getWindowContext prioriza chats sobre workspace e ignora arquivos', () => {
    const withChats: UiState = {
      chatTabs: [{ sid: 'c1', hostId: 'srv', cwd: '/home/chat' }],
      fileTabs: [{ id: 'f1', hostId: 'srv', path: '/home/outro/file.txt' }],
      workspace: { hostId: 'srv', root: '/home/workspace' },
    };
    expect(getWindowContext(withChats)).toEqual({ hostId: 'srv', cwd: '/home/chat' });
    expect(getWindowContextKey(withChats)).toBe('srv\0/home/chat');

    const withoutChats: UiState = {
      chatTabs: [],
      fileTabs: [{ id: 'f1', hostId: 'srv', path: '/home/outro/file.txt' }],
      workspace: { hostId: 'srv', root: '/home/workspace' },
    };
    // Pasta só aberta no explorador não vira contexto; só conta ao migrar o formato antigo.
    expect(getWindowContext(withoutChats)).toBeUndefined();
    expect(getWindowContext(withoutChats, true)).toEqual({ hostId: 'srv', cwd: '/home/workspace' });
    // Janela criada para um servidor+pasta guarda o contexto mesmo sem conversas.
    expect(getWindowContext({ state: withoutChats, updatedAt: 1, hostId: 'srv', contextCwd: '/home/ctx' })).toEqual({ hostId: 'srv', cwd: '/home/ctx' });

    const empty: UiState = { chatTabs: [], fileTabs: [] };
    expect(getWindowContext(empty)).toBeUndefined();
    expect(getWindowContextKey(empty)).toBeUndefined();
  });
});

describe('attachWindow', () => {
  it('primeira janela de todas: cria uma vazia com id novo', () => {
    const wins: WindowMap = {};
    const r = attachWindow(wins, undefined, new Set());
    expect(r.cold).toBe(true);
    expect(Object.keys(wins)).toEqual([r.wid]);
    expect(isEmptyState(r.state)).toBe(true);
  });

  it('id conhecido devolve o estado dele (recarregar a página)', () => {
    const wins: WindowMap = { [W(1)]: { state: st('a', 'b'), updatedAt: 1 } };
    const r = attachWindow(wins, W(1), new Set([W(2)]));
    expect(r.wid).toBe(W(1));
    expect(r.state.chatTabs.map((t) => t.sid)).toEqual(['a', 'b']);
    expect(r.cold).toBe(false);
    expect(r.duplicate).toBeUndefined();
  });

  it('janela nova com outra aberta: começa vazia e não mexe nas demais', () => {
    const wins: WindowMap = { [W(1)]: { state: st('a'), updatedAt: 1 } };
    const r = attachWindow(wins, undefined, new Set([W(1)]));
    expect(r.wid).not.toBe(W(1));
    expect(r.cold).toBe(false);
    expect(isEmptyState(r.state)).toBe(true);
    expect(wins[W(1)].state.chatTabs).toHaveLength(1);
    expect(Object.keys(wins)).toHaveLength(2);
  });

  it('início a frio: restaura só a janela mais recente, preservando todas as demais separadas', () => {
    const wins: WindowMap = {
      [W(1)]: { state: st('a', 'b'), updatedAt: 10 },
      [W(2)]: { state: st('c'), updatedAt: 50 },
      [W(3)]: { state: st('d'), updatedAt: 30 },
    };
    const r = attachWindow(wins, undefined, new Set(), 100);
    expect(r.wid).toBe(W(2));
    expect(r.cold).toBe(true);
    expect(r.state.chatTabs.map((t) => t.sid)).toEqual(['c']);
    expect(Object.keys(wins).sort()).toEqual([W(1), W(2), W(3)]);
    expect(wins[W(1)].state.chatTabs.map((t) => t.sid)).toEqual(['a', 'b']);
  });

  it('id desconhecido com outra janela aberta vira janela nova; sem outra, restaura a última salva', () => {
    const wins: WindowMap = { [W(1)]: { state: st('a'), updatedAt: 1 } };
    const nova = attachWindow(wins, W(9), new Set([W(1)]));
    expect(nova.wid).toBe(W(9)); // reaproveita o id que a janela já tinha
    expect(isEmptyState(nova.state)).toBe(true);
    const wins2: WindowMap = { [W(1)]: { state: st('a'), updatedAt: 1 } };
    const r = attachWindow(wins2, W(9), new Set());
    expect(r.wid).toBe(W(1));
  });

  it('id malformado (vindo do navegador) é ignorado', () => {
    const wins: WindowMap = {};
    const r = attachWindow(wins, '../../etc/passwd', new Set());
    expect(r.wid).not.toContain('/');
    expect(Object.keys(wins)).toEqual([r.wid]);
  });

  it('reabre só as 3 conversas do projeto clicado, sem pegar janelas de outros servidores/pastas', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: {
          chatTabs: [
            { sid: 'smart-1', hostId: 'srv-teste-dev', cwd: '/home/usuario/smart-ia' },
            { sid: 'smart-2', hostId: 'srv-teste-dev', cwd: '/home/usuario/smart-ia' },
            { sid: 'smart-3', hostId: 'srv-teste-dev', cwd: '/home/usuario/smart-ia' },
          ],
          fileTabs: [],
          activeChat: 'smart-2',
        },
        updatedAt: 20,
      },
      [W(2)]: {
        state: { chatTabs: [{ sid: 'outro', hostId: 'srv-teste-dev', cwd: '/home/usuario/outro' }], fileTabs: [] },
        updatedAt: 90,
      },
      [W(3)]: {
        state: { chatTabs: [{ sid: 'local', hostId: 'local', cwd: 'C:\\Users\\usuario' }], fileTabs: [] },
        updatedAt: 100,
      },
    };
    const smart = attachWindow(wins, undefined, new Set([W(3)]), 200, {
      h: 'srv-teste-dev',
      f: '/home/usuario/smart-ia',
    });
    expect(smart.wid).toBe(W(1));
    expect(smart.state.chatTabs.map((t) => t.sid)).toEqual(['smart-1', 'smart-2', 'smart-3']);
    expect(smart.state.activeChat).toBe('smart-2');
    expect(
      attachWindow(wins, undefined, new Set([W(1), W(3)]), 201, {
        h: 'srv-teste-dev',
        f: '/home/usuario/outro',
      }).wid
    ).toBe(W(2));
    expect(Object.keys(wins)).toHaveLength(3);
  });

  it('clique no host reabre a última janela desse host; mesmo contexto já live retorna duplicate: true; outra pasta é outra janela', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: {
          chatTabs: [{ sid: 'a', hostId: 'srv-teste', cwd: '/home/usuario/app' }],
          fileTabs: [],
          activeChat: 'a',
        },
        updatedAt: 40,
      },
      [W(2)]: {
        state: {
          chatTabs: [{ sid: 'b', hostId: 'srv-teste', cwd: '/home/usuario/outro-projeto' }],
          fileTabs: [],
        },
        updatedAt: 30,
      },
      [W(3)]: {
        state: { chatTabs: [{ sid: 'd', hostId: 'srv-teste-dev', cwd: '/home/smart' }], fileTabs: [] },
        updatedAt: 90,
      },
    };

    // 1. Clique no host com W(3) live reabre a mais recente fechada de srv-teste (W(1))
    const first = attachWindow(wins, undefined, new Set([W(3)]), 100, { h: 'srv-teste' });
    expect(first.wid).toBe(W(1));
    expect(first.duplicate).toBeUndefined();

    // 2. Agora W(1) está live. Um novo browser pede attach para o MESMO contexto (/home/usuario/app).
    // Prefere a janela exata existente e retorna duplicate: true, NUNCA cria dupe.
    const second = attachWindow(wins, undefined, new Set([W(1), W(3)]), 101, {
      h: 'srv-teste',
      f: '/home/usuario/app',
    });
    expect(second.wid).toBe(W(1));
    expect(second.duplicate).toBe(true);

    // 3. Outra pasta do mesmo host é outra janela: abre W(2)
    const third = attachWindow(wins, undefined, new Set([W(1), W(3)]), 102, {
      h: 'srv-teste',
      f: '/home/usuario/outro-projeto',
    });
    expect(third.wid).toBe(W(2));
    expect(third.duplicate).toBeUndefined();

    // 4. Nova pasta inexistente no mesmo host cria janela nova para ela (não duplica app)
    const fourth = attachWindow(wins, undefined, new Set([W(1), W(2), W(3)]), 103, {
      h: 'srv-teste',
      f: '/home/usuario/nova-pasta',
    });
    expect(fourth.wid).not.toBe(W(1));
    expect(fourth.wid).not.toBe(W(2));
    expect(isEmptyState(fourth.state)).toBe(true);
  });

  it('id conhecido ainda marcado como aberto (F5 antes de a conexão antiga cair) volta para a mesma janela', () => {
    const wins: WindowMap = { [W(1)]: { state: st('a'), updatedAt: 1 } };
    const r = attachWindow(wins, W(1), new Set([W(1)]));
    expect(r.wid).toBe(W(1));
    expect(r.duplicate).toBeUndefined();
    expect(r.state.chatTabs.map((t) => t.sid)).toEqual(['a']);
  });

  it('caminho local ignora diferença de caixa e separador; remoto é exato', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: { chatTabs: [{ sid: 'local', hostId: 'local', cwd: 'C:\\Users\\Usuario\\Projeto' }], fileTabs: [] },
        updatedAt: 1,
      },
      [W(2)]: {
        state: { chatTabs: [{ sid: 'ssh', hostId: 'srv', cwd: '/home/Usuario/Projeto' }], fileTabs: [] },
        updatedAt: 2,
      },
    };
    expect(attachWindow(wins, undefined, new Set(), 3, { h: 'local', f: 'c:/users/usuario/projeto' }).wid).toBe(W(1));
    const ssh = attachWindow(wins, undefined, new Set([W(1)]), 4, { h: 'srv', f: '/home/usuario/projeto' });
    expect(ssh.wid).not.toBe(W(2));
    expect(isEmptyState(ssh.state)).toBe(true);
  });

  it('janela salva com só arquivos (sem conversa) volta na pasta dela', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: {
          chatTabs: [],
          fileTabs: [{ id: 'f', hostId: 'local', path: 'C:\\tmp\\arquivo.txt' }],
          workspace: { hostId: 'local', root: 'C:\\tmp' },
        },
        updatedAt: 1,
        hostId: 'local',
        contextCwd: 'C:\\tmp',
      },
    };
    const r = attachWindow(wins, undefined, new Set(), 10, { h: 'local', f: 'C:\\tmp' });
    expect(r.wid).toBe(W(1));
    expect(r.state.fileTabs).toHaveLength(1);
  });

  it('cold start ignora janelas com shouldRestore: false quando houver outras restauráveis', () => {
    const wins: WindowMap = {
      [W(1)]: { state: st('valida'), updatedAt: 10, shouldRestore: true },
      [W(2)]: { state: { chatTabs: [], fileTabs: [] }, updatedAt: 50, shouldRestore: false },
    };
    const r = attachWindow(wins, undefined, new Set(), 100);
    expect(r.wid).toBe(W(1));
    expect(r.cold).toBe(true);
  });
});

describe('saveWindowState / pruneWindows', () => {
  it('só grava em janela que existe e normaliza listas', () => {
    const wins: WindowMap = { [W(1)]: { state: st(), updatedAt: 1 } };
    expect(saveWindowState(wins, W(2), st('a'))).toBe(false);
    expect(saveWindowState(wins, W(1), { chatTabs: undefined, fileTabs: undefined } as unknown as UiState, 77)).toBe(
      true
    );
    expect(wins[W(1)].state.chatTabs).toEqual([]);
    expect(wins[W(1)].updatedAt).toBe(77);
  });

  it('preserva metadados hostId, contextCwd e shouldRestore ao salvar o estado da tela', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: st('a'),
        updatedAt: 1,
        hostId: 'srv-teste',
        contextCwd: '/home/usuario/app',
        shouldRestore: true,
      },
    };
    saveWindowState(wins, W(1), { chatTabs: [{ sid: 'a', hostId: 'srv-teste', cwd: '/home/usuario/app' }], fileTabs: [] }, 99);
    expect(wins[W(1)].hostId).toBe('srv-teste');
    expect(wins[W(1)].contextCwd).toBe('/home/usuario/app');
    expect(wins[W(1)].shouldRestore).toBe(true);
    expect(wins[W(1)].updatedAt).toBe(99);
  });

  it('arquivos de outra pasta do mesmo host não alteram a identidade/contexto da janela', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: {
          chatTabs: [{ sid: 'chat-1', hostId: 'srv', cwd: '/home/usuario/app' }],
          fileTabs: [],
        },
        updatedAt: 10,
        hostId: 'srv',
        contextCwd: '/home/usuario/app',
      },
    };
    // Abre arquivo de outra pasta do mesmo host
    const newState: UiState = {
      chatTabs: [{ sid: 'chat-1', hostId: 'srv', cwd: '/home/usuario/app' }],
      fileTabs: [{ id: 'f-outro', hostId: 'srv', path: '/home/usuario/outro/arquivo.txt' }],
    };
    saveWindowState(wins, W(1), newState, 20);
    expect(wins[W(1)].hostId).toBe('srv');
    expect(wins[W(1)].contextCwd).toBe('/home/usuario/app');
    expect(getWindowContext(wins[W(1)])).toEqual({ hostId: 'srv', cwd: '/home/usuario/app' });
    expect(wins[W(1)].state.fileTabs).toHaveLength(1);
  });

  it('descarta janelas fechadas e vazias; nunca as abertas, com abas ou com sessão ainda salva', () => {
    const wins: WindowMap = {
      [W(1)]: { state: st(), updatedAt: 1 }, // fechada e vazia: sai
      [W(2)]: { state: st(), updatedAt: 2 }, // aberta e vazia: fica
      [W(3)]: { state: st('x'), updatedAt: 3 }, // fechada com abas: fica
      [W(4)]: { state: st(), updatedAt: 4 }, // sessão criada antes de salvar a UI: fica
    };
    pruneWindows(wins, new Set([W(2)]), new Set([W(4)]));
    expect(Object.keys(wins).sort()).toEqual([W(2), W(3), W(4)]);
  });

  it('não descarta nem a 15ª janela fechada com conversas', () => {
    const wins: WindowMap = {};
    for (let i = 1; i <= 15; i++) wins[W(i)] = { state: st(`s${i}`), updatedAt: i };
    pruneWindows(wins, new Set([W(1)]));
    expect(Object.keys(wins)).toHaveLength(15);
    expect(wins[W(1)]).toBeDefined();
    expect(wins[W(2)]).toBeDefined();
    expect(wins[W(15)]).toBeDefined();
  });
});

describe('reconcileWindowSessions', () => {
  it('reconstitui janela removida pelo limite antigo, sem reatribuir a sessão à janela errada', () => {
    const wins: WindowMap = {
      [W(1)]: { state: st('outro'), updatedAt: 30 },
    };
    const { owners, changed } = reconcileWindowSessions(wins, [
      session('app-1', W(2), 'srv-teste', '/home/usuario/app'),
      session('app-2', W(2), 'srv-teste', '/home/usuario/app'),
    ]);
    expect(changed).toBe(true);
    expect(owners.size).toBe(0);
    expect(wins[W(2)].state.chatTabs.map((t) => t.sid)).toEqual(['app-1', 'app-2']);
    expect(wins[W(2)].state.workspace?.root).toBe('/home/usuario/app');
    expect(wins[W(1)].state.chatTabs.map((t) => t.sid)).toEqual(['outro']);
  });

  it('reconcilia sessão salva antes do estado da UI e recupera janela mesmo após prune', () => {
    const wins: WindowMap = { [W(1)]: { state: st(), updatedAt: 50 } };
    reconcileWindowSessions(wins, [session('novo', W(1))]);
    pruneWindows(wins, new Set());
    expect(wins[W(1)].state.chatTabs.map((t) => t.sid)).toEqual(['novo']);
    expect(reconcileWindowSessions(wins, [session('novo', W(1))]).changed).toBe(false);
  });

  it('dá a sessão sem wid à janela que já guardava seu SID', () => {
    const wins: WindowMap = { [W(1)]: { state: st('restaurar'), updatedAt: 50 } };
    const { owners, changed } = reconcileWindowSessions(wins, [session('restaurar')]);
    expect(changed).toBe(false);
    expect(owners.get('restaurar')).toBe(W(1));
    expect(wins[W(1)].state.chatTabs).toHaveLength(1);
  });

  it('agrupa sessões sem wid pela própria pasta, sem misturar servidores/pastas nem editar janela viva', () => {
    const wins: WindowMap = {};
    const sessions = [
      session('a', undefined, 'srv', '/a'),
      session('b', undefined, 'srv', '/a'),
      session('c', undefined, 'srv', '/b'),
      session('d', undefined, 'local', 'C:\\x'),
    ];
    const { owners, changed } = reconcileWindowSessions(wins, sessions);
    expect(changed).toBe(true);
    expect(owners.get('a')).toBe(owners.get('b'));
    expect(owners.get('a')).not.toBe(owners.get('c'));
    expect(owners.get('a')).not.toBe(owners.get('d'));
    expect(wins[owners.get('a')!].state.chatTabs.map((t) => t.sid)).toEqual(['a', 'b']);
    const original = wins[owners.get('a')!].state.chatTabs;
    const e = session('e', owners.get('a'), 'srv', '/a');
    reconcileWindowSessions(wins, [e], new Set([owners.get('a')!]));
    expect(wins[owners.get('a')!].state.chatTabs).toBe(original);
    expect(original.map((t) => t.sid)).toEqual(['a', 'b']);
  });

  it('não tira conversa da janela dela (juntar janelas repetidas é papel da migração)', () => {
    const wins: WindowMap = {
      [W(1)]: { state: { chatTabs: [{ sid: 'm1', hostId: 'srv', cwd: '/home/app' }], fileTabs: [] }, updatedAt: 50 },
      [W(2)]: { state: { chatTabs: [{ sid: 'm2', hostId: 'srv', cwd: '/home/app' }], fileTabs: [] }, updatedAt: 30 },
    };
    const { owners, changed } = reconcileWindowSessions(wins, [session('m1', W(1), 'srv', '/home/app'), session('m2', W(2), 'srv', '/home/app')]);
    expect(changed).toBe(false);
    expect(owners.size).toBe(0);
  });

  it('conversa sem dono vai para a janela do mesmo servidor+pasta; janela de recuperação não reabre sozinha', () => {
    const wins: WindowMap = {
      [W(1)]: { state: { chatTabs: [{ sid: 'm1', hostId: 'srv', cwd: '/home/app' }], fileTabs: [] }, updatedAt: 50 },
    };
    const { owners } = reconcileWindowSessions(wins, [session('m9', undefined, 'srv', '/home/app/'), session('x', undefined, 'srv', '/home/Outra')]);
    expect(owners.get('m9')).toBe(W(1));
    const rec = wins[owners.get('x')!];
    expect(rec.contextCwd).toBe('/home/Outra');
    expect(rec.shouldRestore).toBe(false);
  });
});

describe('migrateLegacyWindows', () => {
  it('consolida duplicatas do mesmo par (inclusive 2+3 app e 9+2 servico), dedup SID e preserva arquivos de outra pasta', () => {
    const wins: WindowMap = {
      // 2 janelas de app (2 + 3 conversas, com 1 sid duplicado 'mf-2')
      [W(1)]: {
        state: {
          chatTabs: [
            { sid: 'mf-1', hostId: 'srv-teste', cwd: '/home/usuario/app' },
            { sid: 'mf-2', hostId: 'srv-teste', cwd: '/home/usuario/app' },
          ],
          fileTabs: [{ id: 'f-outro', hostId: 'srv-teste', path: '/home/usuario/outro/lib.ts' }],
          activeChat: 'mf-1',
        },
        updatedAt: 40,
      },
      [W(2)]: {
        state: {
          chatTabs: [
            { sid: 'mf-2', hostId: 'srv-teste', cwd: '/home/usuario/app' },
            { sid: 'mf-3', hostId: 'srv-teste', cwd: '/home/usuario/app' },
            { sid: 'mf-4', hostId: 'srv-teste', cwd: '/home/usuario/app' },
          ],
          fileTabs: [{ id: 'f-local', hostId: 'srv-teste', path: '/home/usuario/app/readme.md' }],
        },
        updatedAt: 30,
      },
      // 2 janelas de servico (9 + 2 conversas)
      [W(3)]: {
        state: {
          chatTabs: Array.from({ length: 9 }, (_, i) => ({
            sid: `meta-${i + 1}`,
            hostId: 'srv-teste',
            cwd: '/home/usuario/servico',
          })),
          fileTabs: [],
        },
        updatedAt: 25,
      },
      [W(4)]: {
        state: {
          chatTabs: [
            { sid: 'meta-10', hostId: 'srv-teste', cwd: '/home/usuario/servico' },
            { sid: 'meta-11', hostId: 'srv-teste', cwd: '/home/usuario/servico' },
          ],
          fileTabs: [],
        },
        updatedAt: 20,
      },
      // Janela de outro servidor / projeto não é consolidada com as anteriores
      [W(5)]: {
        state: {
          chatTabs: [{ sid: 'smart-1', hostId: 'srv-teste-dev', cwd: '/home/smart' }],
          fileTabs: [],
        },
        updatedAt: 15,
      },
      // Janela legada desconhecida (sem chats, sem workspace)
      [W(6)]: {
        state: { chatTabs: [], fileTabs: [] },
        updatedAt: 5,
      },
    };

    const sessions: SessionState[] = [
      session('mf-1', W(1), 'srv-teste', '/home/usuario/app'),
      session('mf-2', W(1), 'srv-teste', '/home/usuario/app'),
      session('mf-3', W(2), 'srv-teste', '/home/usuario/app'),
      session('mf-4', W(2), 'srv-teste', '/home/usuario/app'),
      session('meta-10', W(4), 'srv-teste', '/home/usuario/servico'),
      session('meta-11', W(4), 'srv-teste', '/home/usuario/servico'),
      session('smart-1', W(5), 'srv-teste-dev', '/home/smart'),
    ];

    const { windows: migrated, owners, aliases } = migrateLegacyWindows(wins, sessions);

    // Janelas canônicas resultantes: W(1) [app], W(3) [servico], W(5) [smart], W(6) [desconhecido]
    expect(Object.keys(migrated).sort()).toEqual([W(1), W(3), W(5), W(6)].sort());

    // 1. app consolidado em W(1): 2 + 3 conversas com dedup do 'mf-2' -> 4 conversas únicas (mf-1, mf-2, mf-3, mf-4)
    expect(migrated[W(1)].state.chatTabs.map((t) => t.sid)).toEqual(['mf-1', 'mf-2', 'mf-3', 'mf-4']);
    expect(migrated[W(1)].hostId).toBe('srv-teste');
    expect(migrated[W(1)].contextCwd).toBe('/home/usuario/app');
    expect(migrated[W(1)].shouldRestore).toBe(true);
    // Arquivo de outra pasta mesmo host mantido
    expect(migrated[W(1)].state.fileTabs.map((f) => f.id)).toEqual(['f-outro', 'f-local']);

    // 2. servico consolidado em W(3): 9 + 2 = 11 conversas
    expect(migrated[W(3)].state.chatTabs).toHaveLength(11);
    expect(migrated[W(3)].hostId).toBe('srv-teste');
    expect(migrated[W(3)].contextCwd).toBe('/home/usuario/servico');
    expect(migrated[W(3)].shouldRestore).toBe(true);

    // 3. Janela desconhecida marcada com shouldRestore: false
    expect(migrated[W(6)].shouldRestore).toBe(false);

    // 4. Aliases: mapeia oldWid -> canonicalWid
    expect(aliases[W(2)]).toBe(W(1));
    expect(aliases[W(4)]).toBe(W(3));
    expect(aliases[W(1)]).toBeUndefined();

    // 5. Owners de sessões atualizados
    expect(owners.get('mf-3')).toBe(W(1));
    expect(owners.get('mf-4')).toBe(W(1));
    expect(owners.get('meta-10')).toBe(W(3));
    expect(owners.get('meta-11')).toBe(W(3));
    // Sessões que já pertenciam à janela canônica não precisam constar em owners
    expect(owners.has('mf-1')).toBe(false);
    expect(owners.has('smart-1')).toBe(false);

    // 6. Idempotência: reexecutar produz os mesmos IDs, estados e ordem
    const updatedSessions = sessions.map((s) => (owners.has(s.sid) ? { ...s, wid: owners.get(s.sid)! } : s));
    const rerun = migrateLegacyWindows(migrated, updatedSessions);
    expect(Object.keys(rerun.windows)).toEqual(Object.keys(migrated));
    for (const id of Object.keys(migrated)) {
      expect(rerun.windows[id].state).toEqual(migrated[id].state);
      expect(rerun.windows[id].updatedAt).toBe(migrated[id].updatedAt);
      expect(rerun.windows[id].hostId).toBe(migrated[id].hostId);
      expect(rerun.windows[id].contextCwd).toBe(migrated[id].contextCwd);
      expect(rerun.windows[id].shouldRestore).toBe(migrated[id].shouldRestore);
    }
    expect(rerun.owners.size).toBe(0);
    expect(Object.keys(rerun.aliases)).toHaveLength(0);
  });

  it('sem chats usa workspace como fallback; arquivos/workspace nunca definem contexto se há chats', () => {
    const wins: WindowMap = {
      // Janela com chats em /projeto e workspace em /outro: chats definem contexto (/projeto)
      [W(1)]: {
        state: {
          chatTabs: [{ sid: 'c1', hostId: 'srv', cwd: '/projeto' }],
          fileTabs: [{ id: 'f1', hostId: 'srv', path: '/outro/f.txt' }],
          workspace: { hostId: 'srv', root: '/outro' },
        },
        updatedAt: 20,
      },
      // Janela sem chats com workspace em /projeto: usa workspace como fallback (/projeto) -> duplicata de W(1)
      [W(2)]: {
        state: {
          chatTabs: [],
          fileTabs: [],
          workspace: { hostId: 'srv', root: '/projeto' },
        },
        updatedAt: 10,
      },
      // Janela sem chats com workspace em /outro -> contexto é /outro, NÃO duplica W(1)
      [W(3)]: {
        state: {
          chatTabs: [],
          fileTabs: [],
          workspace: { hostId: 'srv', root: '/outro' },
        },
        updatedAt: 15,
      },
    };

    const { windows: migrated, aliases } = migrateLegacyWindows(wins, []);
    // W(2) foi consolidada em W(1) porque ambas têm contexto /projeto
    expect(aliases[W(2)]).toBe(W(1));
    expect(migrated[W(1)].contextCwd).toBe('/projeto');
    // W(3) foi mantida separada com contexto /outro
    expect(migrated[W(3)]).toBeDefined();
    expect(migrated[W(3)].contextCwd).toBe('/outro');
  });

  it('janela antiga com conversas de outro servidor/pasta misturadas: cada aba vai para a janela do seu contexto', () => {
    const wins: WindowMap = {
      [W(1)]: {
        state: {
          chatTabs: [
            { sid: 'mind', hostId: 'srv-teste', cwd: '/home/usuario/app' },
            { sid: 'meta', hostId: 'srv-teste', cwd: '/home/usuario/central' },
            { sid: 'loc', hostId: 'local', cwd: 'C:\\Users\\usuario' },
          ],
          fileTabs: [{ id: 'arq', hostId: 'srv-teste', path: '/etc/hosts' }],
          activeChat: 'meta',
        },
        updatedAt: 50,
      },
      [W(2)]: { state: { chatTabs: [{ sid: 'meta0', hostId: 'srv-teste', cwd: '/home/usuario/central' }], fileTabs: [] }, updatedAt: 40 },
    };
    const sessions = [
      session('mind', W(1), 'srv-teste', '/home/usuario/app'),
      session('meta', W(1), 'srv-teste', '/home/usuario/central'),
      session('loc', W(1), 'local', 'C:\\Users\\usuario'),
      session('meta0', W(2), 'srv-teste', '/home/usuario/central'),
    ];
    const { windows: m, owners, aliases } = migrateLegacyWindows(wins, sessions);
    // W(1) é a janela de central (a aba ativa definia o contexto); W(2) juntou-se a ela.
    expect(m[W(1)].contextCwd).toBe('/home/usuario/central');
    expect(aliases[W(2)]).toBe(W(1));
    expect(m[W(1)].state.chatTabs.map((t) => t.sid)).toEqual(['meta', 'meta0']);
    expect(m[W(1)].state.fileTabs.map((f) => f.id)).toEqual(['arq']); // arquivo visto fica onde estava
    // app e o computador local ganharam janelas próprias, sem se misturar.
    const mindWid = owners.get('mind')!;
    const locWid = owners.get('loc')!;
    expect(new Set([W(1), mindWid, locWid]).size).toBe(3);
    expect(m[mindWid].state.chatTabs.map((t) => t.sid)).toEqual(['mind']);
    expect(m[locWid].hostId).toBe('local');
    expect(owners.get('meta0')).toBe(W(1));
    expect(owners.has('meta')).toBe(false);
    // Todas as abas continuam lá, uma vez cada (nenhuma perdida nem duplicada).
    const all = Object.values(m).flatMap((w) => w.state.chatTabs.map((t) => t.sid));
    expect(all.sort()).toEqual(['loc', 'meta', 'meta0', 'mind']);
    // Idempotente, inclusive o id das janelas novas.
    const again = migrateLegacyWindows(m, sessions.map((s) => ({ ...s, wid: owners.get(s.sid) ?? s.wid })));
    expect(Object.keys(again.windows)).toEqual(Object.keys(m));
    expect(again.owners.size).toBe(0);
  });
});
