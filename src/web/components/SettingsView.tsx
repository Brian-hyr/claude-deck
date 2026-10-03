// Configurações do app.
import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import { caps, hosts, hostStatus, settings, stats, toast, updateSettings, errorText } from '../lib/state';
import type { ModelOption, PermissionMode, SessionCapabilities } from '../../shared/types';
import { MODE_LABELS } from './Composer';
import { formatBytes } from '../lib/format';
import { Icon } from './icons';

const hostName = (id: string) => (id === 'local' ? 'este computador' : id);

/** Todos os modelos que os CLIs informaram (este computador primeiro), sem repetir. `default` = padrão do servidor. */
function knownModels(all: Record<string, SessionCapabilities>) {
  const hostIds = Object.keys(all)
    .filter((id) => (all[id]?.models?.length ?? 0) > 0)
    .sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : a.localeCompare(b)));
  const models: (ModelOption & { hosts: string[] })[] = [];
  for (const id of hostIds)
    for (const m of all[id].models) {
      if (!m?.value || m.value === 'default') continue;
      const cur = models.find((x) => x.value === m.value);
      if (cur) cur.hosts.push(id);
      else models.push({ ...m, hosts: [id] });
    }
  const label = (m: ModelOption) => (models.filter((x) => x.displayName === m.displayName).length > 1 ? `${m.displayName} (${m.value})` : m.displayName);
  return { hostIds, models: models.map((m) => ({ ...m, label: label(m) })) };
}

export function SettingsView() {
  const s = settings.value;
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [localBins, setLocalBins] = useState<{ path: string; version: string }[]>([]);
  const [browserInfo, setBrowserInfo] = useState<{ selected: string | null; available: { id: string; installed: boolean }[]; restartWindows: boolean } | null>(null);
  useEffect(() => {
    rpc.call('app.autostart', {}).then(setAutostart).catch(() => setAutostart(null));
    rpc.call('hosts.connect', { id: 'local' }).then((st) => setLocalBins(st.claudeCandidates ?? []));
    rpc.call('browser.list').then(setBrowserInfo).catch(() => setBrowserInfo(null));
  }, []);
  // Aplica enquanto digita (como o VS Code); valores fora da faixa são ignorados até completar.
  const num = (k: keyof typeof s, min: number, max: number) => (e: Event) => {
    const raw = (e.target as HTMLInputElement).value;
    const v = Number(raw);
    if (raw !== '' && Number.isFinite(v) && v >= min && v <= max && v !== s[k]) updateSettings({ [k]: v } as any);
  };
  const st = stats.value;
  const known = knownModels(caps.value);
  const selModel = known.models.find((m) => m.value === s.defaultModel);
  const modelHint = !known.models.length
    ? 'A lista de modelos aparece depois que uma conversa iniciar em algum servidor.'
    : selModel
      ? [selModel.description, known.hostIds.length > 1 && selModel.hosts.length < known.hostIds.length ? `Disponível só em: ${selModel.hosts.map(hostName).join(', ')}.` : '']
          .filter(Boolean)
          .join(' ')
      : s.defaultModel
        ? 'Modelo personalizado, que não está na lista informada pelos servidores.'
        : 'Cada conversa usa o modelo configurado no Claude Code daquele servidor.';
  return (
    <div class="side-body settings">
      <h3>Aparência</h3>
      <div class="field">
        <label>Tema</label>
        <select class="input" value={s.theme} onChange={(e) => updateSettings({ theme: (e.target as HTMLSelectElement).value as any })}>
          <option value="dark">Escuro (Dark Modern)</option>
          <option value="light">Claro (Light Modern)</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div class="field" style={{ flex: 1 }}>
          <label>Fonte da interface</label>
          <input class="input" type="number" value={s.uiFontSize} min={10} max={20} onInput={num('uiFontSize', 10, 20)} />
        </div>
        <div class="field" style={{ flex: 1 }}>
          <label>Fonte do chat</label>
          <input class="input" type="number" value={s.chatFontSize} min={10} max={24} onInput={num('chatFontSize', 10, 24)} />
        </div>
        <div class="field" style={{ flex: 1 }}>
          <label>Fonte do editor</label>
          <input class="input" type="number" value={s.editorFontSize} min={10} max={28} onInput={num('editorFontSize', 10, 28)} />
        </div>
      </div>

      <h3>Conversas</h3>
      <div class="field">
        <label>Modo de permissão para conversas novas</label>
        <select class="input" value={s.defaultPermissionMode} onChange={(e) => updateSettings({ defaultPermissionMode: (e.target as HTMLSelectElement).value as PermissionMode })}>
          {(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as PermissionMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m].label}
            </option>
          ))}
        </select>
        <span class="hint">{MODE_LABELS[s.defaultPermissionMode]?.desc}</span>
      </div>
      <div class="field">
        <label>Modelo padrão</label>
        <select class="input model-select" value={s.defaultModel} onChange={(e) => updateSettings({ defaultModel: (e.target as HTMLSelectElement).value })}>
          <option value="">Padrão de cada servidor</option>
          {known.models.map((m) => (
            <option key={m.value} value={m.value} title={m.description || m.value}>
              {m.label}
            </option>
          ))}
          {s.defaultModel && !selModel && <option value={s.defaultModel}>{s.defaultModel} (personalizado)</option>}
        </select>
        <span class="hint">{modelHint}</span>
      </div>
      <label class="check">
        <input type="checkbox" checked={s.sendWithCtrlEnter} onChange={(e) => updateSettings({ sendWithCtrlEnter: (e.target as HTMLInputElement).checked })} />
        <span>Enviar com Ctrl+Enter (Enter quebra linha)</span>
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={s.notifications}
          onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            updateSettings({ notifications: on });
            if (on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
          }}
        />
        <span>Notificar quando o Claude terminar ou pedir permissão (com a janela em segundo plano)</span>
      </label>
      <div class="field">
        <label>Pausar conversas remotas paradas após (horas)</label>
        <input class="input" type="number" value={s.remoteIdleHours} min={1} max={168} onInput={num('remoteIdleHours', 1, 168)} />
        <span class="hint">No servidor, a conversa continua rodando mesmo com o notebook desligado. Depois desse tempo sem uso, o processo é encerrado (o histórico fica; a próxima mensagem retoma).</span>
      </div>

      <h3>Editor</h3>
      <label class="check">
        <input type="checkbox" checked={s.editorWordWrap} onChange={(e) => updateSettings({ editorWordWrap: (e.target as HTMLInputElement).checked })} />
        <span>Quebrar linhas longas</span>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div class="field" style={{ flex: 1 }}>
          <label>Tamanho do tab</label>
          <input class="input" type="number" value={s.editorTabSize} min={1} max={8} onInput={num('editorTabSize', 1, 8)} />
        </div>
        <div class="field" style={{ flex: 1 }}>
          <label>Abrir arquivos até (MB)</label>
          <input class="input" type="number" value={s.maxOpenFileMB} min={1} max={200} onInput={num('maxOpenFileMB', 1, 200)} />
        </div>
      </div>

      <h3>Terminal</h3>
      <div class="field">
        <label>Posição do terminal</label>
        <select class="input" value={s.terminalPosition ?? 'right'} onChange={(e) => updateSettings({ terminalPosition: (e.target as HTMLSelectElement).value as any })}>
          <option value="right">À direita da conversa</option>
          <option value="bottom">Embaixo</option>
        </select>
      </div>
      <label class="check">
        <input type="checkbox" checked={s.terminalHighlight !== false} onChange={(e) => updateSettings({ terminalHighlight: (e.target as HTMLInputElement).checked })} />
        <span>Realçar palavras na saída (regras "My Custom" do MobaXterm)</span>
      </label>
      <span class="hint">
        Erros e "down" em vermelho, sucesso e "up" em verde, IPs, MACs, VLANs e interfaces em amarelo, comandos de rede em ciano, links sublinhados. Texto
        que o próprio programa já colore e telas cheias (vim, htop, less) ficam como estão.
      </span>

      <h3>Claude Code</h3>
      <div class="field">
        <label>Executável local</label>
        <select class="input" value={s.localClaudePath} onChange={(e) => updateSettings({ localClaudePath: (e.target as HTMLSelectElement).value })}>
          <option value="">Automático (versão mais nova)</option>
          {localBins.map((b) => (
            <option key={b.path} value={b.path}>
              {b.version} — {b.path}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Servidores com Claude detectado</label>
        <div class="hint">
          {hosts.value
            .filter((h) => h.kind === 'ssh' && hostStatus.value[h.id]?.claude)
            .map((h) => `${h.id}: ${hostStatus.value[h.id]!.claude!.version}`)
            .join(' · ') || 'Conecte a um servidor para ver.'}
        </div>
      </div>

      <h3>Sistema</h3>
      {browserInfo && (
        <div class="field">
          <label>Navegador do Deck neste computador</label>
          <select class="input" value={browserInfo.selected ?? ''} onChange={async (e) => {
            const browser = (e.target as HTMLSelectElement).value;
            try {
              await rpc.call('browser.select', { browser });
              setBrowserInfo({ ...browserInfo, selected: browser, restartWindows: true });
              toast('Navegador alterado. Feche as janelas do Deck e abra novamente pelo atalho; as conversas continuam salvas.', 'info', 9000);
            } catch (err) {
              setBrowserInfo((current) => current ? { ...current } : current);
              toast(errorText(err), 'error');
            }
          }}>
            {!browserInfo.selected && <option value="" disabled>Escolha um navegador</option>}
            {browserInfo.available.map(({ id, installed }) => (
              <option key={id} value={id} disabled={!installed}>{({ brave: 'Brave', edge: 'Microsoft Edge', chrome: 'Google Chrome', firefox: 'Firefox' } as Record<string, string>)[id] ?? id}{installed ? '' : ' (não instalado)'}</option>
            ))}
          </select>
          <small>Brave, Edge e Chrome abrem sem barras; Firefox abre numa janela separada com barras. A mudança vale ao reabrir as janelas, sem interromper conversas em andamento.</small>
        </div>
      )}
      {autostart !== null && (
        <label class="check">
          <input
            type="checkbox"
            checked={autostart}
            onChange={async (e) => {
              try {
                setAutostart(await rpc.call('app.autostart', { enable: (e.target as HTMLInputElement).checked }));
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          />
          <span>Iniciar o servidor do Claude Deck junto com o Windows (em segundo plano, ~50 MB)</span>
        </label>
      )}
      {st && (
        <div class="stat-grid" style={{ marginBottom: 10 }}>
          <span>Memória do servidor</span>
          <span>{formatBytes(st.rss)}</span>
          <span>Conversas abertas</span>
          <span>
            {st.sessions} ({st.running} trabalhando)
          </span>
          <span>Servidores conectados</span>
          <span>{st.hostsConnected}</span>
          <span>Canais SSH abertos</span>
          <span>{st.channels}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button class="btn secondary" onClick={async () => setLog(await rpc.call('app.log'))}>
          <Icon name="output" /> Ver log
        </button>
        <button
          class="btn secondary"
          onClick={async () => {
            if (confirm('Encerrar o servidor do Claude Deck? Conversas remotas continuam rodando nos servidores.')) {
              await rpc.call('app.quit').catch(() => {});
              window.close();
            }
          }}
        >
          <Icon name="debug-stop" /> Encerrar o app
        </button>
      </div>
      {log !== null && <pre class="pre" style={{ marginTop: 8, maxHeight: 300, fontSize: 11, userSelect: 'text' }}>{log || '(vazio)'}</pre>}
    </div>
  );
}
