// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { signal } from '@preact/signals';
import { ChatModel, type Item, type ToolItem } from '../../src/web/lib/chatModel';
import type { ChatTab } from '../../src/web/lib/state';
import type { SessionState } from '../../src/shared/types';
import { WorkGroup } from '../../src/web/components/Chat';

function fakeChat(sid: string, patch: Partial<SessionState> = {}): ChatTab {
  return {
    sid,
    state: signal<SessionState>({
      sid,
      hostId: 'local',
      cwd: 'C:\\proj',
      phase: 'idle',
      createdAt: 1,
      title: `Conversa ${sid}`,
      ...patch,
    }),
    model: new ChatModel(),
    version: signal(0),
    loaded: true,
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

function makeTool(id: string, name = 'Read', status: 'done' | 'running' | 'error' = 'done'): ToolItem {
  return {
    kind: 'tool',
    key: `k-${id}`,
    id,
    name,
    input: { path: `file-${id}.ts` },
    status,
    children: [],
  };
}

describe('WorkGroup - expansão com limite de 10 operações e minimizar por baixo', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it('inicia recolhido e expande todas as operações quando são <= 10', async () => {
    const c = fakeChat('s1');
    const items: Item[] = [makeTool('1'), makeTool('2'), makeTool('3')];

    render(
      <WorkGroup
        items={items}
        c={c}
        renderChild={(it) => (
          <div key={it.key} class="test-item" data-id={(it as ToolItem).id}>
            {(it as ToolItem).id}
          </div>
        )}
      />,
      container,
    );

    const head = container.querySelector<HTMLElement>('.work-group-head');
    expect(head).toBeTruthy();
    expect(container.querySelector('.work-group.open')).toBeNull();
    expect(container.querySelector('.work-group-action-hint')?.textContent).toBe('Expandir');

    // Clica no cabeçalho para expandir
    head!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).not.toBeNull());
    expect(container.querySelector('.work-group-action-hint')?.textContent).toBe('Recolher');

    // Como são 3 (<= 10), todas são renderizadas e não há cabeçalho de operações anteriores
    const renderedItems = container.querySelectorAll('.test-item');
    expect(renderedItems.length).toBe(3);
    expect(container.querySelector('.work-group-more')).toBeNull();

    // Rodapé de minimizar está presente na parte de baixo
    const foot = container.querySelector<HTMLElement>('.work-group-foot');
    expect(foot).toBeTruthy();
    expect(foot?.textContent).toContain('Recolher operações');

    // Minimiza clicando pelo rodapé
    foot!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).toBeNull());
    expect(container.querySelector('.test-item')).toBeNull();
  });

  it('quando tem mais de 10 operações, expande mostrando apenas as últimas 10 em tempo real', async () => {
    const c = fakeChat('s2', { phase: 'running' });
    const items: Item[] = Array.from({ length: 15 }, (_, i) => makeTool(`t${i + 1}`, 'Read', i === 14 ? 'running' : 'done'));

    render(
      <WorkGroup
        items={items}
        c={c}
        renderChild={(it) => (
          <div key={it.key} class="test-item" data-id={(it as ToolItem).id}>
            {(it as ToolItem).id}
          </div>
        )}
      />,
      container,
    );

    const head = container.querySelector<HTMLElement>('.work-group-head');
    expect(container.querySelector('.work-group-action-hint')?.textContent).toBe('Ver últimas 10');

    // Expande
    head!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).not.toBeNull());

    // Apenas as últimas 10 estão visíveis no DOM
    const renderedItems = container.querySelectorAll('.test-item');
    expect(renderedItems.length).toBe(10);
    expect(renderedItems[0].getAttribute('data-id')).toBe('t6');
    expect(renderedItems[9].getAttribute('data-id')).toBe('t15');

    // Cabeçalho informando que há 5 anteriores ocultas
    const moreBtn = container.querySelector<HTMLElement>('.work-group-more-btn');
    expect(moreBtn?.textContent).toContain('Mostrar 5 operações anteriores');
    expect(moreBtn?.textContent).toContain('total: 15');

    // Tag ao vivo indicando últimas 10
    const liveTag = container.querySelector('.work-group-live-tag');
    expect(liveTag?.textContent).toContain('ao vivo · últimas 10');

    // Rodapé para minimizar pela parte de baixo
    const foot = container.querySelector<HTMLElement>('.work-group-foot');
    expect(foot).toBeTruthy();
    expect(foot?.textContent).toContain('Recolher operações');
    expect(foot?.textContent).toContain('(últimas 10)');

    // Clica para mostrar todas as 15
    moreBtn!.click();
    await vi.waitFor(() => expect(container.querySelectorAll('.test-item').length).toBe(15));
    const allRendered = container.querySelectorAll('.test-item');
    expect(allRendered[0].getAttribute('data-id')).toBe('t1');
    expect(container.querySelector('.work-group-more-btn')?.textContent).toContain('Mostrar apenas as últimas 10');

    // No rodapé também surge o botão de voltar para 10
    const backTo10Btn = container.querySelector<HTMLElement>('.work-group-foot-action');
    expect(backTo10Btn?.textContent).toContain('Mostrar apenas 10');

    // Clica no botão de voltar para 10
    backTo10Btn!.click();
    await vi.waitFor(() => expect(container.querySelectorAll('.test-item').length).toBe(10));

    // Clica no rodapé para recolher / minimizar pela parte de baixo
    container.querySelector<HTMLElement>('.work-group-foot')!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).toBeNull());
  });

  it('acompanha a chegada de novas operações em tempo real deslizando a janela das 10 últimas', async () => {
    const c = fakeChat('s-live', { phase: 'running' });
    let items: Item[] = Array.from({ length: 11 }, (_, i) => makeTool(`t${i + 1}`));

    const renderWG = () =>
      render(
        <WorkGroup
          items={items}
          c={c}
          renderChild={(it) => (
            <div key={it.key} class="test-item" data-id={(it as ToolItem).id}>
              {(it as ToolItem).id}
            </div>
          )}
        />,
        container,
      );

    renderWG();

    // Expande
    container.querySelector<HTMLElement>('.work-group-head')!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).not.toBeNull());

    let rendered = container.querySelectorAll('.test-item');
    expect(rendered.length).toBe(10);
    expect(rendered[0].getAttribute('data-id')).toBe('t2');
    expect(rendered[9].getAttribute('data-id')).toBe('t11');
    expect(container.querySelector('.work-group-more-btn')?.textContent).toContain('Mostrar 1 operação anterior');

    // Uma nova operação chega ao vivo (item 12)
    items = [...items, makeTool('t12', 'Bash', 'running')];
    renderWG();
    await vi.waitFor(() => expect(container.querySelectorAll('.test-item')[9].getAttribute('data-id')).toBe('t12'));

    rendered = container.querySelectorAll('.test-item');
    expect(rendered.length).toBe(10);
    expect(rendered[0].getAttribute('data-id')).toBe('t3');
    expect(rendered[9].getAttribute('data-id')).toBe('t12');
    expect(container.querySelector('.work-group-more-btn')?.textContent).toContain('Mostrar 2 operações anteriores');
  });

  it('indica erros ocorridos nas operações anteriores ocultas', async () => {
    const c = fakeChat('s3');
    const items: Item[] = [
      makeTool('t1', 'Bash', 'error'),
      makeTool('t2', 'Bash', 'error'),
      ...Array.from({ length: 11 }, (_, i) => makeTool(`t${i + 3}`)),
    ]; // 13 itens no total, os primeiros 2 têm erro e estarão ocultos nas últimas 10

    render(
      <WorkGroup
        items={items}
        c={c}
        renderChild={(it) => (
          <div key={it.key} class="test-item" data-id={(it as ToolItem).id}>
            {(it as ToolItem).id}
          </div>
        )}
      />,
      container,
    );

    // Expande
    container.querySelector<HTMLElement>('.work-group-head')!.click();
    await vi.waitFor(() => expect(container.querySelector('.work-group.open')).not.toBeNull());

    const moreBtn = container.querySelector<HTMLElement>('.work-group-more-btn');
    expect(moreBtn?.textContent).toContain('3 operações anteriores');
    expect(moreBtn?.textContent).toContain('(2 com erro)');
  });
});
