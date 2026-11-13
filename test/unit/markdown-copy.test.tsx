// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { copyToClipboard } from '../../src/web/lib/markdown';
import { Markdown } from '../../src/web/components/Markdown';
import { toasts } from '../../src/web/lib/state';

// Endereço de exemplo para os testes de cópia. O valor real fica no .env (ignorado pelo git) em
// VITE_TEST_PANEL_URL, para não ir ao repositório público; sem o .env vale o endereço genérico.
const PANEL_URL: string = (import.meta.env.VITE_TEST_PANEL_URL as string | undefined) || 'http://10.0.0.1:3000';

function mount(node: any): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node, container);
  return container;
}

describe('markdown-copy', () => {
  let writeTextMock: any;

  beforeEach(() => {
    toasts.value = [];
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  describe('copyToClipboard', () => {
    it('copia texto usando navigator.clipboard.writeText', async () => {
      const ok = await copyToClipboard('tok_123456');
      expect(ok).toBe(true);
      expect(writeTextMock).toHaveBeenCalledWith('tok_123456');
    });

    it('retorna false para texto vazio', async () => {
      const ok = await copyToClipboard('');
      expect(ok).toBe(false);
      expect(writeTextMock).not.toHaveBeenCalled();
    });

    it('usa fallback com execCommand se navigator.clipboard falhar', async () => {
      writeTextMock.mockRejectedValueOnce(new Error('Permissão negada'));
      const execCommandMock = vi.fn().mockReturnValue(true);
      (document as any).execCommand = execCommandMock;

      const ok = await copyToClipboard(PANEL_URL);
      expect(ok).toBe(true);
      expect(execCommandMock).toHaveBeenCalledWith('copy');
    });
  });

  describe('Markdown duplo clique', () => {
    it('adiciona title indicativo em tags code inline e links', async () => {
      const el = mount(
        <Markdown text={`Acesse \`${PANEL_URL}\` e use o token \`tok_xxxx\`.`} />
      );
      await new Promise((r) => setTimeout(r, 10));

      const codes = el.querySelectorAll('code');
      expect(codes.length).toBe(2);
      expect(codes[0].getAttribute('title')).toBe('Duplo clique para copiar');
      expect(codes[1].getAttribute('title')).toBe('Duplo clique para copiar');
    });

    it('copia token/URL em destaque ao dar duplo clique no code inline', async () => {
      const el = mount(
        <Markdown text="O token é `tok_xxxxxxxxxxxxxxxxxxxxxxxxxxx`." />
      );

      const code = el.querySelector('code');
      expect(code).toBeTruthy();
      expect(code?.textContent).toBe('tok_xxxxxxxxxxxxxxxxxxxxxxxxxxx');

      code?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

      // Aguarda promises da área de transferência
      await Promise.resolve();
      await Promise.resolve();

      expect(writeTextMock).toHaveBeenCalledWith('tok_xxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(code?.classList.contains('code-copied')).toBe(true);
      expect(toasts.value.length).toBe(1);
      expect(toasts.value[0].text).toContain('tok_xxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(toasts.value[0].tone).toBe('success');
    });

    it('copia link ao dar duplo clique na tag a', async () => {
      const el = mount(
        <Markdown text={`Acesse [Painel](${PANEL_URL}/mcp)`} />
      );

      const a = el.querySelector('a');
      expect(a).toBeTruthy();

      a?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

      await Promise.resolve();
      await Promise.resolve();

      expect(writeTextMock).toHaveBeenCalledWith(`${PANEL_URL}/mcp`);
      expect(a?.classList.contains('code-copied')).toBe(true);
      expect(toasts.value.length).toBe(1);
      expect(toasts.value[0].text).toContain(`${PANEL_URL}/mcp`);
    });

    it('não intercepta duplo clique dentro de blocos pre code (preserva seleção de texto normal)', async () => {
      const mdCode = '```json\n{"name": "Hermes"}\n```';
      const el = mount(<Markdown text={mdCode} />);

      const preCode = el.querySelector('pre code');
      expect(preCode).toBeTruthy();

      preCode?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

      await Promise.resolve();
      await Promise.resolve();

      expect(writeTextMock).not.toHaveBeenCalled();
      expect(toasts.value.length).toBe(0);
    });

    it('copia URLs e objetos JSON inline sem perder caracteres especiais', async () => {
      const el = mount(
        <Markdown text={'Use a API `POST` `/api/integrations/tokens` passando `{"name": "Hermes", "expires_in_days": 90}`.'} />
      );

      const codes = el.querySelectorAll('code');
      expect(codes.length).toBe(3);

      // Duplo clique no JSON
      codes[2].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();

      expect(writeTextMock).toHaveBeenCalledWith('{"name": "Hermes", "expires_in_days": 90}');
      expect(toasts.value[0].text).toContain('Hermes');
    });

    it('limpa a seleção textual ao dar duplo clique', async () => {
      const removeAllRangesMock = vi.fn();
      vi.spyOn(window, 'getSelection').mockReturnValue({
        removeAllRanges: removeAllRangesMock,
      } as any);

      const el = mount(<Markdown text={`URL: \`${PANEL_URL}/mcp\``} />);
      const code = el.querySelector('code');

      code?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await Promise.resolve();

      expect(removeAllRangesMock).toHaveBeenCalled();
    });
  });

  describe('LaTeX math rendering', () => {
    it('renderiza blocos matemáticos $$...$$ e fórmulas inline $...$', () => {
      const el = mount(
        <Markdown text={'Fórmula de Euler: $$e^{i\\pi} + 1 = 0$$\nE inline $E = mc^2$ no texto.'} />
      );

      const block = el.querySelector('.md-math-block');
      expect(block).toBeTruthy();
      expect(block?.getAttribute('data-tex')).toBe('e^{i\\pi} + 1 = 0');
      expect(block?.textContent).toContain('π');

      const inline = el.querySelector('.md-math-inline');
      expect(inline).toBeTruthy();
      expect(inline?.getAttribute('data-tex')).toBe('E = mc^2');
    });

    it('não confunde preços como $50 ou $100 com fórmulas LaTeX', () => {
      const el = mount(
        <Markdown text="O valor é $50 ou $100 dólares." />
      );

      const inline = el.querySelector('.md-math-inline');
      expect(inline).toBeNull();
      expect(el.textContent).toContain('$50');
      expect(el.textContent).toContain('$100');
    });

    it('não quebra blocos de código com $ dentro', () => {
      const code = '```bash\necho $VAR\n```';
      const el = mount(<Markdown text={code} />);

      const inline = el.querySelector('.md-math-inline');
      expect(inline).toBeNull();
      expect(el.querySelector('pre code')?.textContent).toContain('echo $VAR');
    });
  });
});
