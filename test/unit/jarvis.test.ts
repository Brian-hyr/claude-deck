// @vitest-environment jsdom
// Jarvis · Central abre por protocolo customizado (jarvis-central://open), nunca por HTTP direto:
// o Deck e o Jarvis usam perfis separados do Brave, então o perfil do Deck não tem o cookie de
// sessão do Jarvis (abrir a URL HTTP direto daria 401 mesmo com o Jarvis já logado no perfil
// dele). A sonda HTTP existente é só diagnóstico auxiliar do túnel, nunca o caminho de abertura.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JARVIS_PROTOCOL_URL, JARVIS_STATUS_URL, openJarvisCentral, probeJarvisTunnel } from '../../src/web/lib/jarvis';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('probeJarvisTunnel (diagnóstico auxiliar, não é o caminho de abertura)', () => {
  it('true quando algo responde na porta (basta a resposta opaca de no-cors)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({} as Response) as any;
    await expect(probeJarvisTunnel(JARVIS_STATUS_URL)).resolves.toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(JARVIS_STATUS_URL, expect.objectContaining({ mode: 'no-cors' }));
  });

  it('false quando a porta não responde (túnel fora do ar)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any;
    await expect(probeJarvisTunnel(JARVIS_STATUS_URL)).resolves.toBe(false);
  });
});

describe('openJarvisCentral (protocolo, não HTTP)', () => {
  it('é síncrona: não devolve Promise (preserva o gesto do usuário para o handoff externo)', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const r = openJarvisCentral();
    expect(r).not.toBeInstanceOf(Promise);
    expect(r).toEqual({ opened: true });
    clickSpy.mockRestore();
  });

  it('dispara um link invisível (target=_blank) para jarvis-central://open e o remove depois', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const before = document.body.querySelectorAll('a').length;
    openJarvisCentral();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe(JARVIS_PROTOCOL_URL);
    expect(anchor.target).toBe('_blank');
    expect(anchor.rel).toBe('noopener');
    // Removido do DOM depois do clique, e nada sobrou (sem "aba fantasma" de link escondido).
    expect(document.body.contains(anchor)).toBe(false);
    expect(document.body.querySelectorAll('a').length).toBe(before);
    clickSpy.mockRestore();
  });

  it('nunca chama window.open nem fetch para abrir (sem suposição de cookie HTTP compartilhado)', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const openSpy = vi.spyOn(window, 'open');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    openJarvisCentral();
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('preserva a página do Deck: não navega (location não muda)', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const before = window.location.href;
    openJarvisCentral();
    expect(window.location.href).toBe(before);
    clickSpy.mockRestore();
  });

  it('sem DOM disponível para criar o link: devolve motivo em vez de lançar exceção', () => {
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('sem DOM');
    });
    const r = openJarvisCentral();
    expect(r.opened).toBe(false);
    expect(r.reason).toMatch(/jarvis-central|atalho/i);
    createSpy.mockRestore();
  });
});
