import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arrangeTabs,
  GROUP_COLORS,
  groupColor,
  lastActivityOf,
  scheduleTabSort,
  sortTabs,
  sortTabsGrouped,
  tabGroup,
  tabSegments,
  TAB_SORT_INTERVAL_MS,
  visibleTabs,
  type TabLayout,
  type TabSortInput,
} from '../../src/web/lib/tabOrder';

const idle: TabSortInput = { attention: null, pendingCount: 0, phase: 'idle', modelRunning: false, lastActivityAt: 0 };
const tab = (name: string, patch: Partial<TabSortInput>) => ({ name, ...idle, ...patch });
const order = (tabs: ReturnType<typeof tab>[]) => sortTabs(tabs, (t) => t).map((t) => t.name);

describe('tabGroup', () => {
  it('1: terminou e ainda não foi vista (com sucesso ou com o turno acabando em erro)', () => {
    expect(tabGroup({ ...idle, unseen: 'done' })).toBe(1);
    expect(tabGroup({ ...idle, unseen: 'error' })).toBe(1);
  });

  it('1: erro que derrubou a conversa conta como terminou, mesmo com o modelo marcado como rodando', () => {
    expect(tabGroup({ ...idle, phase: 'error' })).toBe(1);
    expect(tabGroup({ ...idle, phase: 'error', modelRunning: true })).toBe(1);
  });

  it('2: esperando permissão, pergunta ou plano', () => {
    expect(tabGroup({ ...idle, attention: 'permission' })).toBe(2);
    expect(tabGroup({ ...idle, pendingCount: 1, phase: 'running', modelRunning: true })).toBe(2);
  });

  it('3: trabalhando, iniciando ou reconectando', () => {
    expect(tabGroup({ ...idle, phase: 'running' })).toBe(3);
    expect(tabGroup({ ...idle, modelRunning: true })).toBe(3);
    expect(tabGroup({ ...idle, phase: 'starting' })).toBe(3);
    expect(tabGroup({ ...idle, phase: 'reconnecting' })).toBe(3);
  });

  it('3: ferramenta que falhou no meio do turno não tira a conversa de "trabalhando"', () => {
    // O erro de uma ferramenta não muda fase, nem `unseen`: a conversa segue rodando.
    expect(tabGroup({ ...idle, phase: 'running', modelRunning: true, unseen: undefined })).toBe(3);
  });

  it('um turno novo vale mais que o "terminou" antigo', () => {
    expect(tabGroup({ ...idle, unseen: 'done', phase: 'running' })).toBe(3);
  });

  it('4: parada e já vista (inclusive pausada/sem processo)', () => {
    expect(tabGroup(idle)).toBe(4);
    expect(tabGroup({ ...idle, phase: 'dormant' })).toBe(4);
  });
});

describe('sortTabs', () => {
  it('ordem dos grupos: terminou, pede resposta, trabalhando, paradas', () => {
    const tabs = [
      tab('parada', { lastActivityAt: 900 }),
      tab('trabalhando', { phase: 'running', lastActivityAt: 800 }),
      tab('pede', { attention: 'permission', phase: 'running', lastActivityAt: 700 }),
      tab('terminou', { unseen: 'done', lastActivityAt: 100 }),
    ];
    expect(order(tabs)).toEqual(['terminou', 'pede', 'trabalhando', 'parada']);
  });

  it('dentro de cada grupo, a mais recente primeiro', () => {
    const tabs = [
      tab('velha', { lastActivityAt: 10 }),
      tab('nova', { lastActivityAt: 30 }),
      tab('meio', { lastActivityAt: 20 }),
      tab('t-velha', { unseen: 'done', lastActivityAt: 1 }),
      tab('t-nova', { unseen: 'error', lastActivityAt: 2 }),
      tab('p1', { pendingCount: 1, lastActivityAt: 5 }),
      tab('p2', { pendingCount: 2, lastActivityAt: 6 }),
      tab('r1', { phase: 'running', lastActivityAt: 7 }),
      tab('r2', { phase: 'running', lastActivityAt: 8 }),
    ];
    expect(order(tabs)).toEqual(['t-nova', 't-velha', 'p2', 'p1', 'r2', 'r1', 'nova', 'meio', 'velha']);
  });

  it('empate mantém a ordem que as abas já tinham', () => {
    const tabs = [tab('a', { lastActivityAt: 5 }), tab('b', { lastActivityAt: 5 }), tab('c', { lastActivityAt: 5 })];
    expect(order(tabs)).toEqual(['a', 'b', 'c']);
    expect(order([tabs[2], tabs[0], tabs[1]])).toEqual(['c', 'a', 'b']);
  });

  it('sem horário (NaN) vai para o fim do grupo, sem quebrar a ordenação', () => {
    const tabs = [tab('sem', { lastActivityAt: NaN }), tab('com', { lastActivityAt: 1 })];
    expect(order(tabs)).toEqual(['com', 'sem']);
  });

  it('não altera a lista recebida e lida com lista vazia ou de uma aba', () => {
    const tabs = [tab('x', { lastActivityAt: 1 }), tab('y', { unseen: 'done', lastActivityAt: 0 })];
    const copy = [...tabs];
    sortTabs(tabs, (t) => t);
    expect(tabs).toEqual(copy);
    expect(sortTabs([], (t: any) => t)).toEqual([]);
    expect(order([tabs[0]])).toEqual(['x']);
  });
});

// Abas com posição: P = fixada, g/G = membro/âncora (orquestrador) do grupo.
type L = { name: string } & TabLayout & Partial<TabSortInput>;
const t = (name: string, l: Partial<TabLayout> = {}, s: Partial<TabSortInput> = {}): L => ({ name, pinned: false, ...l, ...s });
const names = (list: readonly L[]) => list.map((x) => x.name);
const lay = (x: L): TabLayout => x;

describe('arrangeTabs', () => {
  it('fixadas vão para o começo, na ordem relativa que tinham', () => {
    const list = [t('a'), t('p1', { pinned: true }), t('b'), t('p2', { pinned: true })];
    expect(names(arrangeTabs(list, lay))).toEqual(['p1', 'p2', 'a', 'b']);
  });

  it('sem nada a mudar devolve a mesma lista (o efeito da faixa não entra em laço)', () => {
    const list = [t('p', { pinned: true }), t('o', { group: 'g', anchor: true }), t('w', { group: 'g' }), t('x')];
    expect(arrangeTabs(list, lay)).toBe(list);
    expect(arrangeTabs([], lay)).toEqual([]);
  });

  it('worker novo (entra no fim) é puxado para junto do grupo, depois do orquestrador', () => {
    const list = [t('o', { group: 'g', anchor: true }), t('w1', { group: 'g' }), t('x'), t('y'), t('w2', { group: 'g' })];
    expect(names(arrangeTabs(list, lay))).toEqual(['o', 'w1', 'w2', 'x', 'y']);
  });

  it('o grupo fica onde está o orquestrador: arrastá-lo leva o grupo; o worker arrastado volta para o grupo', () => {
    const moved = [t('w1', { group: 'g' }), t('w2', { group: 'g' }), t('x'), t('o', { group: 'g', anchor: true }), t('y')];
    expect(names(arrangeTabs(moved, lay))).toEqual(['x', 'o', 'w1', 'w2', 'y']);
    const workerOut = [t('o', { group: 'g', anchor: true }), t('x'), t('w1', { group: 'g' })];
    expect(names(arrangeTabs(workerOut, lay))).toEqual(['o', 'w1', 'x']);
  });

  it('sem orquestrador aberto, o grupo fica no lugar do primeiro membro; grupos diferentes não se misturam', () => {
    const list = [t('x'), t('a1', { group: 'A' }), t('b1', { group: 'B' }), t('a2', { group: 'A' }), t('B0', { group: 'B', anchor: true })];
    expect(names(arrangeTabs(list, lay))).toEqual(['x', 'a1', 'a2', 'B0', 'b1']);
  });

  it('fixar um membro tira ele do grupo; arrastar para fora da área das fixadas não desafixa', () => {
    const list = [t('o', { group: 'g', anchor: true, pinned: true }), t('w', { group: 'g' }), t('x')];
    expect(names(arrangeTabs(list, lay))).toEqual(['o', 'w', 'x']);
    const dragged = [t('p2', { pinned: true }), t('x'), t('p1', { pinned: true })];
    expect(names(arrangeTabs(dragged, lay))).toEqual(['p2', 'p1', 'x']);
    const intoPins = [t('p1', { pinned: true }), t('x'), t('p2', { pinned: true })];
    expect(names(arrangeTabs(intoPins, lay))).toEqual(['p1', 'p2', 'x']);
  });
});

describe('sortTabsGrouped', () => {
  const input = (x: L): TabSortInput => ({ ...idle, ...x });

  it('as fixadas não saem do lugar, mesmo paradas e com outras pedindo atenção', () => {
    const list = [t('p1', { pinned: true }, { lastActivityAt: 1 }), t('p2', { pinned: true }), t('fim', {}, { unseen: 'done', lastActivityAt: 9 })];
    expect(names(sortTabsGrouped(list, input, lay))).toEqual(['p1', 'p2', 'fim']);
  });

  it('o grupo se move junto, pela conversa mais urgente dele, e a ordem dentro dele não muda', () => {
    const list = [
      t('parada', {}, { lastActivityAt: 50 }),
      t('o', { group: 'g', anchor: true }, { lastActivityAt: 10 }),
      t('w1', { group: 'g' }, { lastActivityAt: 11 }),
      t('w2', { group: 'g' }, { attention: 'permission', phase: 'running', lastActivityAt: 12 }),
      t('rodando', {}, { phase: 'running', lastActivityAt: 99 }),
    ];
    expect(names(sortTabsGrouped(list, input, lay))).toEqual(['o', 'w1', 'w2', 'rodando', 'parada']);
  });

  it('empate de urgência: vale a atividade mais recente do membro mais urgente', () => {
    const list = [
      t('x', {}, { phase: 'running', lastActivityAt: 20 }),
      t('o', { group: 'g', anchor: true }, { lastActivityAt: 100 }), // parada: não conta para o grupo 3
      t('w', { group: 'g' }, { phase: 'running', lastActivityAt: 10 }),
    ];
    expect(names(sortTabsGrouped(list, input, lay))).toEqual(['x', 'o', 'w']);
  });

  it('sem fixadas nem grupos, é igual ao sortTabs', () => {
    const list = [t('a', {}, { lastActivityAt: 1 }), t('b', {}, { unseen: 'done' }), t('c', {}, { phase: 'running', lastActivityAt: 3 })];
    expect(names(sortTabsGrouped(list, input, lay))).toEqual(names(sortTabs(list, input)));
  });
});

describe('tabSegments / visibleTabs', () => {
  const list = [t('p', { pinned: true, group: 'g' }), t('o', { group: 'g', anchor: true }), t('w1', { group: 'g' }), t('w2', { group: 'g' }), t('x'), t('solo', { group: 'h', anchor: true })];

  it('grupo só com duas ou mais abas não fixadas; fixada e grupo de uma aba ficam soltas', () => {
    const segs = tabSegments(list, lay);
    expect(segs.map((s) => (s.kind === 'tab' ? s.tab.name : `[${s.id}:${names(s.tabs).join(',')}]`))).toEqual(['p', '[g:o,w1,w2]', 'x', 'solo']);
    expect(names(visibleTabs(segs))).toEqual(['p', 'o', 'w1', 'w2', 'x', 'solo']);
  });

  it('recolhido: some da faixa (e do Alt+número), menos o que não pode ficar escondido', () => {
    const segs = tabSegments(list, lay, { collapsed: new Set(['g', 'h']), keepVisible: (x) => x.name === 'w2' });
    const g = segs.find((s) => s.kind === 'group');
    expect(g?.kind === 'group' && g.collapsed && names(g.shown)).toEqual(['w2']);
    expect(names(visibleTabs(segs))).toEqual(['p', 'w2', 'x', 'solo']); // 'solo' não tem grupo à vista: não some
  });
});

describe('groupColor', () => {
  it('mesma orquestração, mesma cor; sempre uma da paleta', () => {
    expect(groupColor('orq-1')).toBe(groupColor('orq-1'));
    for (const id of ['a', 'b', 'orq-123', '']) expect(GROUP_COLORS).toContain(groupColor(id));
  });
});

describe('lastActivityOf', () => {
  it('usa o horário do servidor, o que a interface viu ou a criação, o que for mais recente', () => {
    expect(lastActivityOf({ createdAt: 10 })).toBe(10);
    expect(lastActivityOf({ createdAt: 10, lastActivityAt: 50 })).toBe(50);
    expect(lastActivityOf({ createdAt: 10 }, 70)).toBe(70); // servidor antigo: só a interface viu
    expect(lastActivityOf({ createdAt: 10, lastActivityAt: 50 }, 40)).toBe(50);
    expect(lastActivityOf({})).toBe(0);
  });
});

describe('scheduleTabSort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('o ciclo padrão é de 30 minutos', () => {
    expect(TAB_SORT_INTERVAL_MS).toBe(30 * 60_000);
    const run = vi.fn();
    const stop = scheduleTabSort({ canRun: () => true, run });
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(90 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('arrastando ou renomeando: espera e tenta de novo logo depois, sem esperar mais 30 minutos', () => {
    const run = vi.fn();
    let busy = true;
    const stop = scheduleTabSort({ intervalMs: 1000, retryMs: 100, canRun: () => !busy, run });
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500); // várias tentativas, ainda ocupado
    expect(run).not.toHaveBeenCalled();
    busy = false; // soltou a aba
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300); // não fica repetindo depois de rodar
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('parar cancela também uma nova tentativa que estava pendente', () => {
    const run = vi.fn();
    let busy = true;
    const stop = scheduleTabSort({ intervalMs: 1000, retryMs: 100, canRun: () => !busy, run });
    vi.advanceTimersByTime(1000);
    stop();
    busy = false;
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});
