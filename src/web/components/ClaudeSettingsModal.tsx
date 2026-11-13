// Modal de configuração visual e direta do settings.json do Claude Code.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import {
  claudeSettingsModal,
  closeClaudeSettingsModal,
  openClaudeSettingsFile,
  hosts,
  workspace,
  activeChat,
  toast,
  errorText,
  settings as deckSettings,
} from '../lib/state';
import type {
  ClaudeSettingsScope,
  ClaudeSettingsGetResult,
  ClaudeSettingsJson,
  ClaudeModelPickerOption,
} from '../../shared/types';
import { LOCAL_HOST_ID } from '../../shared/types';
import { Icon } from './icons';
import { CodeEditor } from '../lib/codemirror';

type TabId = 'api' | 'models' | 'permissions' | 'effort' | 'json';

const BEHAVES_AS_OPTIONS = [
  { value: 'claude-opus-5', label: 'Claude Opus (Raciocínio máximo)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet (Equilíbrio código e velocidade)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku (Rápido e econômico)' },
  { value: 'claude-fable-5-1', label: 'Claude Fable (Raciocínio extremo)' },
];

export function ClaudeSettingsModal() {
  const st = claudeSettingsModal.value;
  if (!st) return null;
  return <ClaudeSettingsModalInner key={`${st.hostId}:${st.scope}:${st.cwd ?? ''}`} initial={st} />;
}

function ClaudeSettingsModalInner({
  initial,
}: {
  initial: { hostId: string; cwd?: string; scope?: ClaudeSettingsScope; initialTab?: TabId };
}) {
  const [hostId, setHostId] = useState(initial.hostId || LOCAL_HOST_ID);
  const [scope, setScope] = useState<ClaudeSettingsScope>(initial.scope || 'user');
  const [cwd, setCwd] = useState(initial.cwd || workspace.value?.root || activeChat.value?.state.value.cwd || '');
  const [activeTab, setActiveTab] = useState<TabId>(initial.initialTab || 'api');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileData, setFileData] = useState<ClaudeSettingsGetResult | null>(null);

  // Estado editável
  const [settingsObj, setSettingsObj] = useState<ClaudeSettingsJson>({});
  const [rawText, setRawText] = useState<string>('{\n}\n');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Estados locais da UI
  const [showToken, setShowToken] = useState(false);
  const [permSearch, setPermSearch] = useState('');
  const [permKind, setPermKind] = useState<'allow' | 'deny'>('allow');
  const [newPermText, setNewPermText] = useState('');
  const [newModel, setNewModel] = useState<ClaudeModelPickerOption>({ model: '', label: '', description: '', behavesAs: 'claude-sonnet-5' });
  const [addingModel, setAddingModel] = useState(false);

  const dialog = useRef<HTMLDivElement>(null);
  const jsonContainer = useRef<HTMLDivElement>(null);
  const codeEditorRef = useRef<CodeEditor | null>(null);

  // Carrega arquivo do servidor
  const load = async (h = hostId, sc = scope, c = cwd) => {
    setLoading(true);
    setError(null);
    try {
      const res = await rpc.call<ClaudeSettingsGetResult>('claudeSettings.get', {
        hostId: h,
        scope: sc,
        cwd: sc === 'project' ? c : undefined,
      });
      setFileData(res);
      setSettingsObj(res.settings || {});
      const formatted = JSON.stringify(res.settings || {}, null, 2);
      setRawText(formatted);
      setJsonError(res.error || null);
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(hostId, scope, cwd);
  }, [hostId, scope, cwd]);

  // Foco inicial
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => prev?.focus();
  }, []);

  // Atualiza objeto e texto JSON sincronizados
  const updateSettings = (updater: (prev: ClaudeSettingsJson) => ClaudeSettingsJson) => {
    setSettingsObj((prev) => {
      const next = updater(prev);
      const nextRaw = JSON.stringify(next, null, 2);
      setRawText(nextRaw);
      setJsonError(null);
      setDirty(true);
      return next;
    });
  };

  // Atualização direta do JSON no CodeMirror
  const onRawChange = (text: string) => {
    setRawText(text);
    setDirty(true);
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setSettingsObj(parsed);
        setJsonError(null);
      } else {
        setJsonError('O settings.json precisa ser um objeto { ... }');
      }
    } catch (e: any) {
      setJsonError(e?.message || 'JSON inválido');
    }
  };

  // Montagem do CodeMirror na aba JSON
  useEffect(() => {
    if (activeTab !== 'json' || !jsonContainer.current) {
      if (codeEditorRef.current) {
        codeEditorRef.current.view.destroy();
        codeEditorRef.current = null;
      }
      return;
    }

    const ed = new CodeEditor(jsonContainer.current, {
      doc: rawText,
      filename: 'settings.json',
      dark: deckSettings.value.theme === 'dark',
      wrap: true,
      tabSize: deckSettings.value.editorTabSize || 2,
      onChange: (doc) => onRawChange(doc),
      onSave: () => save(),
    });
    codeEditorRef.current = ed;

    return () => {
      ed.view.destroy();
      codeEditorRef.current = null;
    };
  }, [activeTab]);

  // Salvar
  const save = async () => {
    if (jsonError) {
      toast(`Não é possível salvar com erro no JSON: ${jsonError}`, 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await rpc.call<{ ok: boolean; path: string; backupPath?: string }>('claudeSettings.save', {
        hostId,
        scope,
        cwd: scope === 'project' ? cwd : undefined,
        raw: rawText,
      });
      setDirty(false);
      toast('Configurações salvas com sucesso!', 'info', 4000);
      if (res.backupPath) {
        // Recarrega informações do arquivo
        await load(hostId, scope, cwd);
      }
    } catch (e) {
      toast(`Erro ao salvar: ${errorText(e)}`, 'error', 7000);
    } finally {
      setSaving(false);
    }
  };

  // Helper para variáveis de ambiente
  const env = settingsObj.env || {};
  const setEnvKey = (key: string, val: string) => {
    updateSettings((prev) => {
      const e = { ...(prev.env || {}) };
      if (!val.trim()) delete e[key];
      else e[key] = val.trim();
      return { ...prev, env: e };
    });
  };

  // Modelos customizados do picker
  const pickerOptions = useMemo(() => settingsObj.modelPicker?.options || [], [settingsObj.modelPicker?.options]);
  const replaceBuiltIn = settingsObj.modelPicker?.replaceBuiltInOptions ?? false;

  const addModelOption = () => {
    if (!newModel.model.trim()) return;
    updateSettings((prev) => {
      const opts = [...(prev.modelPicker?.options || [])];
      opts.push({
        model: newModel.model.trim(),
        label: newModel.label?.trim() || newModel.model.trim(),
        description: newModel.description?.trim() || undefined,
        behavesAs: newModel.behavesAs || undefined,
      });
      return {
        ...prev,
        modelPicker: {
          ...(prev.modelPicker || {}),
          options: opts,
        },
      };
    });
    setNewModel({ model: '', label: '', description: '', behavesAs: 'claude-sonnet-5' });
    setAddingModel(false);
  };

  const removeModelOption = (idx: number) => {
    updateSettings((prev) => {
      const opts = [...(prev.modelPicker?.options || [])];
      opts.splice(idx, 1);
      return {
        ...prev,
        modelPicker: {
          ...(prev.modelPicker || {}),
          options: opts,
        },
      };
    });
  };

  const moveModelOption = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= pickerOptions.length) return;
    updateSettings((prev) => {
      const opts = [...(prev.modelPicker?.options || [])];
      const [item] = opts.splice(idx, 1);
      opts.splice(target, 0, item);
      return {
        ...prev,
        modelPicker: {
          ...(prev.modelPicker || {}),
          options: opts,
        },
      };
    });
  };

  // Permissões
  const permissionsList = useMemo(() => {
    const list = permKind === 'allow' ? settingsObj.permissions?.allow : settingsObj.permissions?.deny;
    return Array.isArray(list) ? list : [];
  }, [settingsObj.permissions, permKind]);

  const filteredPerms = useMemo(() => {
    const q = permSearch.trim().toLowerCase();
    if (!q) return permissionsList;
    return permissionsList.filter((p) => p.toLowerCase().includes(q));
  }, [permissionsList, permSearch]);

  const removePermission = (idxOrItem: string) => {
    updateSettings((prev) => {
      const curList = (permKind === 'allow' ? prev.permissions?.allow : prev.permissions?.deny) || [];
      const nextList = curList.filter((x) => x !== idxOrItem);
      return {
        ...prev,
        permissions: {
          ...(prev.permissions || {}),
          [permKind]: nextList,
        },
      };
    });
  };

  const addPermission = () => {
    const val = newPermText.trim();
    if (!val) return;
    updateSettings((prev) => {
      const curList = (permKind === 'allow' ? prev.permissions?.allow : prev.permissions?.deny) || [];
      if (curList.includes(val)) return prev;
      return {
        ...prev,
        permissions: {
          ...(prev.permissions || {}),
          [permKind]: [...curList, val],
        },
      };
    });
    setNewPermText('');
  };

  return (
    <div class="overlay" onMouseDown={closeClaudeSettingsModal}>
      <div
        ref={dialog}
        class="dialog claude-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-settings-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            closeClaudeSettingsModal();
          }
        }}
      >
        {/* Cabeçalho */}
        <div class="dialog-head claude-settings-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="settings-gear" />
            <span id="claude-settings-title" style={{ fontWeight: 600, fontSize: 14 }}>
              Configurações do Claude Code
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {dirty && <span class="claude-settings-dirty-pill">Alterações não salvas</span>}
            <button
              class="btn secondary small-btn"
              title="Abrir arquivo no editor de código"
              onClick={() => {
                closeClaudeSettingsModal();
                void openClaudeSettingsFile(hostId, scope, cwd);
              }}
            >
              <Icon name="code" /> Abrir no editor
            </button>
            <button class="icon-btn" title="Fechar (Esc)" onClick={closeClaudeSettingsModal}>
              <Icon name="close" />
            </button>
          </div>
        </div>

        {/* Barra superior de Servidor e Escopo */}
        <div class="claude-settings-topbar">
          <div class="topbar-row">
            <div class="topbar-item">
              <label>Servidor:</label>
              <select
                class="input"
                value={hostId}
                onChange={(e) => setHostId((e.target as HTMLSelectElement).value)}
              >
                <option value={LOCAL_HOST_ID}>Este computador (Local)</option>
                {hosts.value
                  .filter((h) => h.kind === 'ssh')
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label} ({h.id})
                    </option>
                  ))}
              </select>
            </div>

            <div class="topbar-item">
              <label>Escopo:</label>
              <div class="seg">
                <button class={scope === 'user' ? 'on' : ''} onClick={() => setScope('user')}>
                  Global (~/.claude)
                </button>
                <button class={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>
                  Projeto atual (.claude)
                </button>
              </div>
            </div>

            {scope === 'project' && (
              <div class="topbar-item" style={{ flex: 1 }}>
                <label>Pasta do Projeto:</label>
                <input
                  class="input"
                  type="text"
                  value={cwd}
                  placeholder="Caminho da pasta do projeto"
                  onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
                />
              </div>
            )}
          </div>

          <div class="topbar-path">
            <span class="path-label">Arquivo:</span>
            <span class="path-value" title={fileData?.path || ''}>
              {fileData?.path || 'Carregando…'}
            </span>
            {fileData && !fileData.exists && <span class="path-new-tag">(novo arquivo)</span>}
            {fileData?.path && (
              <button
                class="icon-btn"
                title="Copiar caminho completo"
                onClick={() => {
                  navigator.clipboard.writeText(fileData.path);
                  toast('Caminho copiado!', 'info', 2000);
                }}
              >
                <Icon name="copy" />
              </button>
            )}
          </div>
        </div>

        {/* Abas */}
        <div class="claude-settings-tabs">
          <button class={`tab-btn${activeTab === 'api' ? ' active' : ''}`} onClick={() => setActiveTab('api')}>
            <Icon name="server" /> API & Provedor
          </button>
          <button class={`tab-btn${activeTab === 'models' ? ' active' : ''}`} onClick={() => setActiveTab('models')}>
            <Icon name="sparkle" /> Modelos Customizados
            {pickerOptions.length > 0 && <span class="tab-count">{pickerOptions.length}</span>}
          </button>
          <button class={`tab-btn${activeTab === 'permissions' ? ' active' : ''}`} onClick={() => setActiveTab('permissions')}>
            <Icon name="shield" /> Permissões
            {permissionsList.length > 0 && <span class="tab-count">{permissionsList.length}</span>}
          </button>
          <button class={`tab-btn${activeTab === 'effort' ? ' active' : ''}`} onClick={() => setActiveTab('effort')}>
            <Icon name="zap" /> Raciocínio & Esforço
          </button>
          <button class={`tab-btn${activeTab === 'json' ? ' active' : ''}`} onClick={() => setActiveTab('json')}>
            <Icon name="code" /> JSON Direto
            {jsonError && <span class="tab-error-dot" title={jsonError} />}
          </button>
        </div>

        {/* Conteúdo principal */}
        <div class="claude-settings-content">
          {loading && <div class="claude-settings-loading">Carregando configurações…</div>}
          {error && <div class="banner error">{error}</div>}

          {!loading && !error && (
            <>
              {/* ABA 1: API & Provedor */}
              {activeTab === 'api' && (
                <div class="tab-panel">
                  <div class="claude-settings-section-head">
                    <h4>Conexão com Gateway / LiteLLM</h4>
                    <p class="hint">Configura o endpoint e chaves passadas via variáveis de ambiente para o Claude Code.</p>
                  </div>

                  <div class="claude-settings-grid">
                    <div class="field">
                      <label>URL Base da API (ANTHROPIC_BASE_URL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_BASE_URL || ''}
                        placeholder="ex: http://10.150.160.21:4000 ou https://api.anthropic.com"
                        onInput={(e) => setEnvKey('ANTHROPIC_BASE_URL', (e.target as HTMLInputElement).value)}
                      />
                      <span class="hint">Deixe em branco para usar a API oficial da Anthropic diretamente.</span>
                    </div>

                    <div class="field">
                      <label>Token / Chave de Autenticação (ANTHROPIC_AUTH_TOKEN)</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          class="input"
                          style={{ flex: 1 }}
                          type={showToken ? 'text' : 'password'}
                          value={env.ANTHROPIC_AUTH_TOKEN || ''}
                          placeholder="sk-..."
                          onInput={(e) => setEnvKey('ANTHROPIC_AUTH_TOKEN', (e.target as HTMLInputElement).value)}
                        />
                        <button class="btn secondary" onClick={() => setShowToken(!showToken)} title="Mostrar/ocultar chave">
                          {showToken ? 'Ocultar' : 'Mostrar'}
                        </button>
                      </div>
                      <span class="hint">Token enviado no cabeçalho Authorization para o LiteLLM ou gateway.</span>
                    </div>

                    <div class="field">
                      <label>Modelo Padrão da Conversa (ANTHROPIC_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_MODEL || settingsObj.model || ''}
                        placeholder="ex: sonnet55[1m], kpaopus55, claude-3-7-sonnet"
                        onInput={(e) => {
                          const val = (e.target as HTMLInputElement).value;
                          setEnvKey('ANTHROPIC_MODEL', val);
                          updateSettings((prev) => ({ ...prev, model: val || undefined }));
                        }}
                      />
                      <span class="hint">Modelo primário acionado quando a conversa não define um modelo específico.</span>
                    </div>

                    <div class="field">
                      <label>Modelo de Subagentes (CLAUDE_CODE_SUBAGENT_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.CLAUDE_CODE_SUBAGENT_MODEL || ''}
                        placeholder="ex: kpasonnet5, claude-3-5-sonnet"
                        onInput={(e) => setEnvKey('CLAUDE_CODE_SUBAGENT_MODEL', (e.target as HTMLInputElement).value)}
                      />
                      <span class="hint">Modelo mais leve ou rápido para tarefas de subagentes paralelos.</span>
                    </div>

                    <div class="field">
                      <label>Limite de Auto-Compactação (CLAUDE_CODE_AUTO_COMPACT_WINDOW)</label>
                      <input
                        class="input"
                        type="number"
                        min={100000}
                        max={2000000}
                        step={10000}
                        value={env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || ''}
                        placeholder="ex: 500000"
                        onInput={(e) => setEnvKey('CLAUDE_CODE_AUTO_COMPACT_WINDOW', (e.target as HTMLInputElement).value)}
                      />
                      <span class="hint">Quantidade de tokens em que o /compact dispara sozinho (padrão do Claude Code: ~250k–500k).</span>
                    </div>
                  </div>

                  <div class="claude-settings-section-head" style={{ marginTop: 20 }}>
                    <h4>Modelos de Fallback por Família</h4>
                    <p class="hint">Mapeamento para quando o CLI solicita classes genéricas de modelos.</p>
                  </div>

                  <div class="claude-settings-grid">
                    <div class="field">
                      <label>Classe Opus (ANTHROPIC_DEFAULT_OPUS_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_DEFAULT_OPUS_MODEL || ''}
                        placeholder="ex: opus, kpaopus55"
                        onInput={(e) => setEnvKey('ANTHROPIC_DEFAULT_OPUS_MODEL', (e.target as HTMLInputElement).value)}
                      />
                    </div>
                    <div class="field">
                      <label>Classe Sonnet (ANTHROPIC_DEFAULT_SONNET_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_DEFAULT_SONNET_MODEL || ''}
                        placeholder="ex: sonnet55, kpasonnet5"
                        onInput={(e) => setEnvKey('ANTHROPIC_DEFAULT_SONNET_MODEL', (e.target as HTMLInputElement).value)}
                      />
                    </div>
                    <div class="field">
                      <label>Classe Haiku (ANTHROPIC_DEFAULT_HAIKU_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_DEFAULT_HAIKU_MODEL || ''}
                        placeholder="ex: gpt-6-luna, kpahaiku45"
                        onInput={(e) => setEnvKey('ANTHROPIC_DEFAULT_HAIKU_MODEL', (e.target as HTMLInputElement).value)}
                      />
                    </div>
                    <div class="field">
                      <label>Classe Fable (ANTHROPIC_DEFAULT_FABLE_MODEL)</label>
                      <input
                        class="input"
                        type="text"
                        value={env.ANTHROPIC_DEFAULT_FABLE_MODEL || ''}
                        placeholder="ex: fable51"
                        onInput={(e) => setEnvKey('ANTHROPIC_DEFAULT_FABLE_MODEL', (e.target as HTMLInputElement).value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ABA 2: Modelos Customizados (modelPicker.options) */}
              {activeTab === 'models' && (
                <div class="tab-panel">
                  <div class="claude-settings-section-head">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h4>Opções do Seletor de Modelos (`modelPicker.options`)</h4>
                        <p class="hint">Modelos exibidos no menu suspenso do Claude Deck e do Claude Code.</p>
                      </div>
                      <button class="btn small-btn" onClick={() => setAddingModel(true)} disabled={addingModel}>
                        <Icon name="add" /> Novo Modelo
                      </button>
                    </div>
                  </div>

                  <label class="check" style={{ margin: '10px 0 16px' }}>
                    <input
                      type="checkbox"
                      checked={replaceBuiltIn}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        updateSettings((prev) => ({
                          ...prev,
                          modelPicker: {
                            ...(prev.modelPicker || {}),
                            replaceBuiltInOptions: on,
                          },
                        }));
                      }}
                    />
                    <span>Substituir opções nativas do seletor (oculta os modelos oficiais e mostra só os seus)</span>
                  </label>

                  {/* Formulário de adicionar modelo */}
                  {addingModel && (
                    <div class="claude-settings-card" style={{ marginBottom: 16 }}>
                      <div style={{ fontWeight: 600, marginBottom: 8 }}>Adicionar Modelo Customizado</div>
                      <div class="claude-settings-grid">
                        <div class="field">
                          <label>Identificador do Modelo (ID no LiteLLM)</label>
                          <input
                            class="input"
                            type="text"
                            placeholder="ex: flash38[1m] ou kpaopus55"
                            value={newModel.model}
                            onInput={(e) => setNewModel({ ...newModel, model: (e.target as HTMLInputElement).value })}
                          />
                        </div>
                        <div class="field">
                          <label>Nome de Exibição (Label)</label>
                          <input
                            class="input"
                            type="text"
                            placeholder="ex: Gemini 3.8 Flash (1M)"
                            value={newModel.label || ''}
                            onInput={(e) => setNewModel({ ...newModel, label: (e.target as HTMLInputElement).value })}
                          />
                        </div>
                        <div class="field">
                          <label>Descrição</label>
                          <input
                            class="input"
                            type="text"
                            placeholder="ex: Ultra rápido e alta inteligência"
                            value={newModel.description || ''}
                            onInput={(e) => setNewModel({ ...newModel, description: (e.target as HTMLInputElement).value })}
                          />
                        </div>
                        <div class="field">
                          <label>Comportamento Base (behavesAs)</label>
                          <select
                            class="input"
                            value={newModel.behavesAs || 'claude-sonnet-5'}
                            onChange={(e) => setNewModel({ ...newModel, behavesAs: (e.target as HTMLSelectElement).value })}
                          >
                            {BEHAVES_AS_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button class="btn small-btn" onClick={addModelOption} disabled={!newModel.model.trim()}>
                          Adicionar
                        </button>
                        <button class="btn secondary small-btn" onClick={() => setAddingModel(false)}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Tabela de modelos */}
                  <div class="claude-settings-table-wrapper">
                    <table class="claude-settings-table">
                      <thead>
                        <tr>
                          <th style={{ width: 40 }}>#</th>
                          <th>Nome de Exibição</th>
                          <th>ID do Modelo</th>
                          <th>Comportamento</th>
                          <th>Descrição</th>
                          <th style={{ width: 100, textAlign: 'right' }}>Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pickerOptions.map((opt, idx) => (
                          <tr key={opt.model + idx}>
                            <td style={{ color: 'var(--fg-faint)', fontSize: 11 }}>{idx + 1}</td>
                            <td style={{ fontWeight: 600 }}>{opt.label || opt.model}</td>
                            <td>
                              <code class="code-pill">{opt.model}</code>
                            </td>
                            <td>
                              <span class="behaves-pill">{opt.behavesAs || 'padrão'}</span>
                            </td>
                            <td style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{opt.description || '—'}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button
                                class="icon-btn"
                                title="Mover para cima"
                                disabled={idx === 0}
                                onClick={() => moveModelOption(idx, -1)}
                              >
                                ↑
                              </button>
                              <button
                                class="icon-btn"
                                title="Mover para baixo"
                                disabled={idx === pickerOptions.length - 1}
                                onClick={() => moveModelOption(idx, 1)}
                              >
                                ↓
                              </button>
                              <button
                                class="icon-btn"
                                title="Remover modelo"
                                onClick={() => removeModelOption(idx)}
                                style={{ color: 'var(--del-fg)' }}
                              >
                                <Icon name="close" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {pickerOptions.length === 0 && (
                          <tr>
                            <td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--fg-muted)' }}>
                              Nenhum modelo customizado cadastrado. O Claude Code usará seus modelos padrão.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ABA 3: Permissões */}
              {activeTab === 'permissions' && (
                <div class="tab-panel">
                  <div class="claude-settings-section-head">
                    <h4>Regras de Permissão</h4>
                    <p class="hint">Comandos e ferramentas liberados para execução sem confirmação interativa.</p>
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                    <div class="seg">
                      <button class={permKind === 'allow' ? 'on' : ''} onClick={() => setPermKind('allow')}>
                        Permitidas (`allow`)
                      </button>
                      <button class={permKind === 'deny' ? 'on' : ''} onClick={() => setPermKind('deny')}>
                        Negadas (`deny`)
                      </button>
                    </div>

                    <div style={{ flex: 1 }}>
                      <input
                        class="input"
                        type="text"
                        placeholder="Buscar regras existentes…"
                        value={permSearch}
                        onInput={(e) => setPermSearch((e.target as HTMLInputElement).value)}
                      />
                    </div>
                  </div>

                  {/* Formulário de adicionar regra */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    <input
                      class="input"
                      style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                      type="text"
                      placeholder="ex: PowerShell(npm run *) ou Read(//c/Users/**) ou Bash(git *)"
                      value={newPermText}
                      onInput={(e) => setNewPermText((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addPermission();
                      }}
                    />
                    <button class="btn small-btn" onClick={addPermission} disabled={!newPermText.trim()}>
                      <Icon name="add" /> Adicionar Regra
                    </button>
                  </div>

                  {/* Lista de regras */}
                  <div class="claude-settings-perm-list">
                    {filteredPerms.map((perm) => {
                      const toolMatch = perm.match(/^([A-Za-z0-9_-]+)\(/);
                      const toolName = toolMatch ? toolMatch[1] : 'Regra';
                      return (
                        <div class="claude-settings-perm-item" key={perm}>
                          <span class="tool-tag">{toolName}</span>
                          <span class="perm-text" title={perm}>
                            {perm}
                          </span>
                          <button
                            class="icon-btn"
                            title="Remover esta regra"
                            onClick={() => removePermission(perm)}
                            style={{ color: 'var(--del-fg)' }}
                          >
                            <Icon name="close" />
                          </button>
                        </div>
                      );
                    })}

                    {filteredPerms.length === 0 && (
                      <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
                        {permSearch ? 'Nenhuma permissão encontrada com esse filtro.' : 'Nenhuma regra nesta lista.'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ABA 4: Raciocínio & Esforço */}
              {activeTab === 'effort' && (
                <div class="tab-panel">
                  <div class="claude-settings-section-head">
                    <h4>Nível de Esforço / Raciocínio (`effortLevel`)</h4>
                    <p class="hint">Define o nível de raciocínio profundo padrão para modelos que suportam pensamento estendido.</p>
                  </div>

                  <div class="field" style={{ maxWidth: 460 }}>
                    <label>Esforço Global</label>
                    <div class="seg" style={{ marginTop: 4 }}>
                      {(['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((lvl) => (
                        <button
                          key={lvl}
                          class={(settingsObj.effortLevel || 'default') === lvl ? 'on' : ''}
                          onClick={() => {
                            updateSettings((prev) => ({
                              ...prev,
                              effortLevel: lvl === 'default' ? undefined : lvl,
                            }));
                          }}
                        >
                          {lvl === 'default' ? 'Padrão' : lvl}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div class="claude-settings-section-head" style={{ marginTop: 24 }}>
                    <h4>Configurações Adicionais</h4>
                  </div>

                  <label class="check">
                    <input
                      type="checkbox"
                      checked={!!settingsObj.alwaysApproveResubmissions}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        updateSettings((prev) => ({ ...prev, alwaysApproveResubmissions: checked }));
                      }}
                    />
                    <span>Sempre aprovar reenvio automático (alwaysApproveResubmissions)</span>
                  </label>

                  <label class="check">
                    <input
                      type="checkbox"
                      checked={settingsObj.enableArtifact !== false}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        updateSettings((prev) => ({ ...prev, enableArtifact: checked }));
                      }}
                    />
                    <span>Habilitar artefatos interativos (enableArtifact)</span>
                  </label>

                  <label class="check">
                    <input
                      type="checkbox"
                      checked={settingsObj.agentPushNotifEnabled !== false}
                      onChange={(e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        updateSettings((prev) => ({ ...prev, agentPushNotifEnabled: checked }));
                      }}
                    />
                    <span>Notificações push de agentes (agentPushNotifEnabled)</span>
                  </label>
                </div>
              )}

              {/* ABA 5: JSON Direto */}
              {activeTab === 'json' && (
                <div class="tab-panel json-tab-panel">
                  {jsonError && (
                    <div class="banner error" style={{ marginBottom: 8 }}>
                      <Icon name="error" />
                      <span class="grow">Erro no JSON: {jsonError}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
                    <button
                      class="btn secondary small-btn"
                      onClick={() => {
                        try {
                          const parsed = JSON.parse(rawText);
                          const formatted = JSON.stringify(parsed, null, 2) + '\n';
                          setRawText(formatted);
                          setJsonError(null);
                          if (codeEditorRef.current) {
                            codeEditorRef.current.view.dispatch({
                              changes: { from: 0, to: codeEditorRef.current.view.state.doc.length, insert: formatted },
                            });
                          }
                          toast('JSON formatado!', 'info', 2000);
                        } catch (e: any) {
                          toast(`JSON inválido: ${e?.message ?? e}`, 'error');
                        }
                      }}
                    >
                      Formatar JSON
                    </button>
                  </div>

                  <div ref={jsonContainer} class="claude-settings-json-editor" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Rodapé com botões de ação */}
        <div class="dialog-foot claude-settings-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {dirty && <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Há alterações pendentes.</span>}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button class="btn secondary" onClick={closeClaudeSettingsModal}>
              Cancelar
            </button>
            <button class="btn secondary" onClick={() => load(hostId, scope, cwd)} disabled={!dirty || saving}>
              Descartar alterações
            </button>
            <button class="btn" onClick={save} disabled={saving || !dirty || !!jsonError}>
              {saving ? 'Salvando…' : 'Salvar Configurações'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
