// Painel do terminal integrado (à direita da conversa ou embaixo) com abas, xterm.js,
// redimensionamento e realce de palavras (regras "My Custom" do MobaXterm).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  activeTerminalId,
  chats,
  closeTerminal,
  onTerminalData,
  onTerminalSync,
  openTerminal,
  toast,
  settings,
  terminalHeight,
  terminalTabs,
  terminalVisible,
  terminalWidth,
  updateSettings,
} from '../lib/state';
import { rpc } from '../lib/rpc';
import { TermHighlighter } from '../lib/termHighlight';
import { isTerminalReport } from '../../shared/terminalProtocol';
import { Icon } from './icons';

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  unsub: () => void;
  el: HTMLElement;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** Tempo máximo que o fim de uma linha incompleta espera o resto antes de aparecer. */
const HOLD_MS = 30;

const instances = new Map<string, TermInstance>();

function getTheme(isLight: boolean) {
  return isLight
    ? {
        background: '#ffffff',
        foreground: '#333333',
        cursor: '#333333',
        selectionBackground: 'rgba(0, 95, 184, 0.3)',
        black: '#000000',
        red: '#cd3131',
        green: '#008000',
        yellow: '#795e26',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#cd3131',
        brightGreen: '#14ce14',
        brightYellow: '#b5ba00',
        brightBlue: '#0451a5',
        brightMagenta: '#bc05bc',
        brightCyan: '#0598bc',
        brightWhite: '#a5a5a5',
      }
    : {
        background: '#181818',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: 'rgba(255, 255, 255, 0.25)',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      };
}

export function TerminalPanel({ dock }: { dock: 'right' | 'bottom' }) {
  const tabs = terminalTabs.value;
  const activeId = activeTerminalId.value;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const prevSize = useRef(0);
  const right = dock === 'right';

  // Garante que há ao menos um terminal se o painel estiver visível
  useEffect(() => {
    if (tabs.length === 0) {
      openTerminal().catch(() => {});
    }
  }, [tabs.length]);

  // Se o tema mudar, atualiza as instâncias abertas
  useEffect(() => {
    const isLight = settings.value.theme === 'light';
    const theme = getTheme(isLight);
    for (const inst of instances.values()) {
      inst.term.options.theme = theme;
    }
  }, [settings.value.theme]);

  // Redimensionamento automático ao mudar de tamanho ou aba
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      if (!activeId) return;
      const inst = instances.get(activeId);
      if (inst && inst.el.offsetParent !== null) {
        try {
          inst.fit.fit();
          rpc.call('term.resize', { id: activeId, cols: inst.term.cols, rows: inst.term.rows }).catch(() => {});
        } catch {}
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId]);

  // Ajusta a aba sem roubar o foco: texto digitado no compositor nunca deve cair no shell.
  useEffect(() => {
    if (!activeId) return;
    const inst = instances.get(activeId);
    if (inst) {
      requestAnimationFrame(() => {
        try {
          inst.fit.fit();
          rpc.call('term.resize', { id: activeId, cols: inst.term.cols, rows: inst.term.rows }).catch(() => {});
        } catch {}
      });
    }
  }, [activeId]);

  // Remove instâncias de abas que foram fechadas
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    for (const [id, inst] of instances.entries()) {
      if (!currentIds.has(id)) {
        inst.unsub();
        if (inst.flushTimer) clearTimeout(inst.flushTimer);
        inst.term.dispose();
        instances.delete(id);
      }
    }
  }, [tabs]);

  const toggleMaximize = () => {
    const size = right ? terminalWidth : terminalHeight;
    if (maximized) {
      size.value = prevSize.current;
      setMaximized(false);
    } else {
      prevSize.current = size.value;
      size.value = right ? Math.round(window.innerWidth * 0.7) : Math.round(window.innerHeight * 0.7);
      setMaximized(true);
    }
  };

  const switchDock = () => {
    setMaximized(false);
    updateSettings({ terminalPosition: right ? 'bottom' : 'right' });
  };

  const clearCurrent = () => {
    if (!activeId) return;
    const inst = instances.get(activeId);
    if (inst) {
      inst.term.clear();
      // Envia Ctrl+L para o shell remoto/local limpar também o buffer da aplicação
      rpc.call('term.write', { id: activeId, data: '\x0c' }).catch(() => {});
    }
  };

  const pasteClipboard = async (id: string) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && terminalTabs.value.some((t) => t.id === id)) instances.get(id)?.term.paste(text);
    } catch {
      toast('Não foi possível ler a área de transferência para colar no terminal.', 'error');
    }
  };

  const mountInstance = (id: string, el: HTMLDivElement | null) => {
    if (!el) return;
    const existing = instances.get(id);
    if (existing) {
      // O painel foi desmontado (fechado ou trocado de lado) e montado de novo: o xterm já
      // existe com todo o histórico, só muda de lugar.
      if (existing.el !== el && existing.term.element) {
        el.appendChild(existing.term.element);
        existing.el = el;
        requestAnimationFrame(() => {
          try {
            existing.fit.fit();
            rpc.call('term.resize', { id, cols: existing.term.cols, rows: existing.term.rows }).catch(() => {});
          } catch {}
        });
      }
      return;
    }

    const isLight = settings.value.theme === 'light';
    const term = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: settings.value.editorFontSize || 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: getTheme(isLight),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text).catch(() => toast('Não foi possível copiar a seleção do terminal.', 'error'));
    });

    let hl = new TermHighlighter(() => settings.value.terminalHighlight !== false);
    const inst: TermInstance = { term, fit, unsub: () => {}, el, flushTimer: null };
    const show = (data: string) => {
      const out = hl.push(data);
      if (out) term.write(out);
      if (hl.hasPending && !inst.flushTimer) {
        inst.flushTimer = setTimeout(() => {
          inst.flushTimer = null;
          const rest = hl.flush();
          if (rest) term.write(rest);
        }, HOLD_MS);
      }
    };
    // Repõe também a saída perdida durante uma reconexão do navegador, sem repetir os bytes.
    let upto = 0;
    let syncing = false;
    let disposed = false;
    const early: { data: string; pos?: number }[] = [];
    const accept = (data: string, pos?: number) => {
      if (pos !== undefined && pos + data.length <= upto) return;
      show(pos !== undefined && pos < upto ? data.slice(upto - pos) : data);
      upto = pos === undefined ? upto + data.length : Math.max(upto, pos + data.length);
    };
    const sync = async () => {
      if (syncing || disposed) return;
      syncing = true;
      try {
        const r = await rpc.call<{ data: string; upto: number; reset?: boolean } | null>('term.replay', { id, since: upto });
        if (disposed) return;
        if (r) {
          if (r.reset) {
            if (inst.flushTimer) clearTimeout(inst.flushTimer);
            inst.flushTimer = null;
            hl = new TermHighlighter(() => settings.value.terminalHighlight !== false);
            term.reset();
            term.write('[Histórico anterior fora do buffer; exibindo a parte disponível.]\r\n');
            upto = r.upto - r.data.length;
          }
          accept(r.data, r.upto - r.data.length);
        }
      } catch { /* nova tentativa na próxima conexão */ }
      finally {
        syncing = false;
        if (!disposed) for (const e of early.splice(0)) accept(e.data, e.pos);
      }
    };
    const offData = onTerminalData(id, (data, pos) => {
      if (syncing) early.push({ data, pos });
      else accept(data, pos);
    });
    const offSync = onTerminalSync(() => {
      if (!terminalTabs.value.some((t) => t.id === id)) {
        inst.unsub();
        if (inst.flushTimer) clearTimeout(inst.flushTimer);
        term.dispose();
        instances.delete(id);
      } else void sync();
    });
    inst.unsub = () => { disposed = true; offData(); offSync(); };
    void sync();

    let lastInputErrorAt = 0;
    term.onData((data) => {
      if (isTerminalReport(data)) return;
      rpc.call('term.write', { id, data }).catch((e) => {
        // Uma tentativa de digitar uma frase bloqueada não deve empilhar um aviso por tecla.
        if (Date.now() - lastInputErrorAt > 1500) {
          lastInputErrorAt = Date.now();
          toast(e.message, 'error');
        }
      });
    });

    instances.set(id, inst);

    requestAnimationFrame(() => {
      try {
        fit.fit();
        rpc.call('term.resize', { id, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch {}
    });
  };

  return (
    <div class={`terminal-panel${right ? ' dock-right' : ''}`}>
      <div class="terminal-header">
        <div class="terminal-tabs">
          {tabs.map((t) => {
            // Terminal de uma conversa no modo Terminal ao Vivo: o Claude digita nele.
            const owner = t.sid ? chats.value.find((c) => c.sid === t.sid) : undefined;
            const claude = owner && owner.state.value.executionMode === 'terminal';
            return (
            <div
              key={t.id}
              class={`terminal-tab${t.id === activeId ? ' active' : ''}${claude ? ' claude' : ''}`}
              title={claude ? `O Claude digita neste terminal (conversa "${owner.state.value.title ?? 'sem título'}", modo Terminal ao Vivo). Para assumir o teclado, pare o Claude antes.` : t.title}
              onClick={() => (activeTerminalId.value = t.id)}
            >
              <Icon name={claude ? 'sparkle' : t.hostId === 'local' ? 'terminal' : 'remote'} />
              <span class="terminal-tab-title">{t.title}</span>
              <button
                class="tab-close"
                title="Fechar terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
            );
          })}
        </div>
        <div class="terminal-actions">
          <button class="icon-btn" title="Novo terminal" onClick={() => openTerminal()}>
            <Icon name="add" />
          </button>
          <button class="icon-btn" title="Limpar terminal" onClick={clearCurrent}>
            <Icon name="clear-all" />
          </button>
          <button
            class={`icon-btn${settings.value.terminalHighlight !== false ? ' on' : ''}`}
            title={settings.value.terminalHighlight !== false ? 'Realce de palavras ligado (clique para desligar)' : 'Realce de palavras desligado (clique para ligar)'}
            onClick={() => updateSettings({ terminalHighlight: settings.value.terminalHighlight === false })}
          >
            <Icon name="symbol-color" />
          </button>
          <button class="icon-btn" title={right ? 'Mover o terminal para baixo' : 'Mover o terminal para a direita'} onClick={switchDock}>
            <Icon name={right ? 'layout-panel' : 'layout-sidebar-right'} />
          </button>
          <button class="icon-btn" title={maximized ? 'Restaurar' : 'Maximizar'} onClick={toggleMaximize}>
            <Icon name={maximized ? 'screen-normal' : 'screen-full'} />
          </button>
          <button
            class="icon-btn"
            title="Fechar painel (Ctrl+`)"
            onClick={() => (terminalVisible.value = false)}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div class="terminal-body" ref={bodyRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            class="terminal-instance-wrapper"
            style={{ display: t.id === activeId ? 'block' : 'none' }}
            ref={(el) => mountInstance(t.id, el as HTMLDivElement)}
            onContextMenu={(e) => {
              e.preventDefault();
              void pasteClipboard(t.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
