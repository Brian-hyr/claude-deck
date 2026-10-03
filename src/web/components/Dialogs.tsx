// Diálogos: pedidos de login SSH (senha, frase da chave, chave do servidor), confirmar, perguntar.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import { authPrompts, closeDialog, dialogs, toasts } from '../lib/state';
import type { AuthPrompt } from '../../shared/protocol';
import { Icon } from './icons';

export function AuthPromptDialog() {
  const p = authPrompts.value[0];
  if (!p) return null;
  return <AuthPromptInner key={p.promptId} p={p} />;
}

function AuthPromptInner({ p }: { p: AuthPrompt }) {
  const fields = p.kind === 'keyboard' ? (p.prompts ?? []) : p.kind === 'hostkey' ? [] : [{ prompt: p.kind === 'passphrase' ? 'Frase da chave' : 'Senha', echo: false }];
  const [values, setValues] = useState<string[]>(fields.map(() => ''));
  const first = useRef<HTMLInputElement>(null);
  // Foco antes da pintura: o que for digitado logo que o diálogo abre não se perde.
  useLayoutEffect(() => first.current?.focus(), []);
  const answer = (ok: boolean) => rpc.call('auth.respond', { promptId: p.promptId, ok, values });
  return (
    <div class="overlay">
      <div class="dialog" onKeyDown={(e) => e.key === 'Escape' && answer(false)}>
        <div class="dialog-head">
          <Icon name={p.kind === 'hostkey' ? 'shield' : 'key'} />
          <span class="grow">{p.title}</span>
        </div>
        <div class="dialog-body">
          <div style={{ whiteSpace: 'pre-wrap' }}>{p.message}</div>
          {p.kind === 'hostkey' && (
            <>
              <div class="fingerprint">
                {p.keyType} {p.fingerprint}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Ao aceitar, a chave é gravada no seu ~/.ssh/known_hosts (o mesmo que o ssh do Windows e o VS Code usam).</div>
            </>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              answer(true);
            }}
          >
            {fields.map((f, i) => (
              <div class="field" key={i} style={{ marginTop: 10 }}>
                <label>{f.prompt}</label>
                <input
                  ref={i === 0 ? first : undefined}
                  class="input"
                  type={f.echo ? 'text' : 'password'}
                  value={values[i]}
                  onInput={(e) => {
                    const v = [...values];
                    v[i] = (e.target as HTMLInputElement).value;
                    setValues(v);
                  }}
                  autocomplete="off"
                />
              </div>
            ))}
            {p.kind !== 'hostkey' && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>A senha fica só na memória do app enquanto ele estiver aberto; nada é gravado em disco.</div>}
            <button type="submit" style={{ display: 'none' }} />
          </form>
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={() => answer(false)}>
            Cancelar
          </button>
          <button class="btn" onClick={() => answer(true)}>
            {p.kind === 'hostkey' ? 'Confiar e conectar' : 'Entrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GenericDialogs() {
  const d = dialogs.value[0];
  if (!d) return null;
  return <GenericDialog key={d.id} d={d} />;
}

function GenericDialog({ d }: { d: (typeof dialogs.value)[number] }) {
  const [v, setV] = useState(d.value ?? '');
  const ref = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (d.kind === 'prompt') {
      ref.current?.focus();
      ref.current?.select();
    } else okRef.current?.focus();
  }, []);
  const ok = () => closeDialog(d.id, d.kind === 'prompt' ? v : true);
  const cancel = () => closeDialog(d.id, d.kind === 'prompt' ? null : false);
  return (
    <div class="overlay" onMouseDown={cancel}>
      <div
        class="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && d.kind === 'prompt') ok();
        }}
      >
        <div class="dialog-head">
          <Icon name={d.danger ? 'warning' : d.kind === 'prompt' ? 'edit' : 'question'} style={d.danger ? { color: 'var(--warn)' } : undefined} />
          <span class="grow">{d.title}</span>
        </div>
        <div class="dialog-body">
          {d.message && <div style={{ whiteSpace: 'pre-wrap', marginBottom: d.kind === 'prompt' ? 8 : 0 }}>{d.message}</div>}
          {d.kind === 'prompt' && <input ref={ref} class="input" style={{ width: '100%' }} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />}
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={cancel}>
            Cancelar
          </button>
          {d.altLabel && (
            <button class="btn secondary" data-alt onClick={() => closeDialog(d.id, 'alt')}>
              {d.altLabel}
            </button>
          )}
          <button ref={okRef} class={`btn${d.danger ? ' danger' : ''}`} onClick={ok}>
            {d.okLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.tone}`}>
          <Icon name={t.tone === 'error' ? 'error' : t.tone === 'success' ? 'pass' : 'info'} style={{ marginTop: 1 }} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
