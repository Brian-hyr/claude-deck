// @vitest-environment jsdom
// A entrada "Jarvis · Central" (botão na barra de status + comando na paleta) precisa existir e,
// ao acionar, chamar openJarvisCentral (protocolo customizado) — nunca abrir a URL HTTP direto
// (isso assumiria cookie de sessão compartilhado entre o perfil do Deck e o do Jarvis, que não
// existe) — sem tocar windowContext/workspace/aba ativa desta janela nem criar conversa/sessão.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';

vi.mock('../../src/web/lib/jarvis', () => ({
  openJarvisCentral: vi.fn(),
  probeJarvisTunnel: vi.fn().mockResolvedValue(true),
  JARVIS_PROTOCOL_URL: 'jarvis-central://open',
  JARVIS_STATUS_URL: 'http://127.0.0.1:47331',
}));

import { openJarvisCentral, probeJarvisTunnel } from '../../src/web/lib/jarvis';
import { StatusBar } from '../../src/web/components/StatusBar';
import { CommandPalette } from '../../src/web/components/Pickers';
import { activeChatId, chats, commandPalette, windowContext, workspace } from '../../src/web/lib/state';

function mount(node: any): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node, container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  commandPalette.value = false;
});

describe('Jarvis · Central — botão na barra de status', () => {
  it('aparece e, ao clicar, chama openJarvisCentral síncrona (contexto da janela intacto, nada de window.open HTTP)', () => {
    expect(windowContext.value).toBeNull();
    expect(workspace.value).toBeNull();
    expect(activeChatId.value).toBeNull();
    expect(chats.value).toEqual([]);
    (openJarvisCentral as any).mockReturnValue({ opened: true });
    const openSpy = vi.spyOn(window, 'open');

    const container = mount(<StatusBar />);
    const btn = [...container.querySelectorAll('.sb-item')].find((el) => el.textContent?.includes('Jarvis · Central'));
    expect(btn).toBeTruthy();

    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Chamada síncrona: já aconteceu antes de qualquer `await` (preserva o gesto do usuário).
    expect(openJarvisCentral).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled(); // nunca abre a URL HTTP direto
    // Nada de host/pasta/aba foi anexado a esta janela por causa do Jarvis: isolamento preservado.
    expect(windowContext.value).toBeNull();
    expect(workspace.value).toBeNull();
    expect(activeChatId.value).toBeNull();
    expect(chats.value).toEqual([]);
  });

  it('túnel fora do ar: mostra aviso informativo, sem fingir sucesso nem reabrir nada', () => {
    (openJarvisCentral as any).mockReturnValue({ opened: false, reason: 'motivo de teste' });
    const container = mount(<StatusBar />);
    const btn = [...container.querySelectorAll('.sb-item')].find((el) => el.textContent?.includes('Jarvis · Central'));
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openJarvisCentral).toHaveBeenCalledTimes(1);
    // Falhou: não faz sentido rodar o diagnóstico auxiliar do túnel depois.
    expect(probeJarvisTunnel).not.toHaveBeenCalled();
  });
});

describe('Jarvis · Central — comando na paleta', () => {
  it('aparece na lista de comandos e roda openJarvisCentral (síncrona) ao ser escolhido', () => {
    (openJarvisCentral as any).mockReturnValue({ opened: true });
    commandPalette.value = true;
    const container = mount(<CommandPalette />);

    const label = [...container.querySelectorAll('.qp-item .label')].find((el) => el.textContent?.includes('Jarvis · Central'));
    expect(label).toBeTruthy();
    const item = label!.closest('.qp-item') as HTMLElement;

    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(openJarvisCentral).toHaveBeenCalledTimes(1);
    expect(windowContext.value).toBeNull();
    expect(chats.value).toEqual([]);
  });
});
