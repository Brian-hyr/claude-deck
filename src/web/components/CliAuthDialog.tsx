// Autenticação efêmera das CLIs; códigos e URLs nunca entram no histórico do Deck.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { rpc, RpcError } from '../lib/rpc';
import { errorText } from '../lib/state';
import { Icon } from './icons';

type Engine = 'claude' | 'antigravity';
interface AuthState {
  id: string;
  phase: 'starting' | 'awaiting_browser' | 'verifying' | 'success' | 'error' | 'cancelled';
  url?: string;
  message?: string;
}
export const cliAuthDialog = signal<{ hostId: string; engine: Engine } | null>(null);

export function CliAuthDialog() {
  const target = cliAuthDialog.value;
  return target ? <Login key={`${target.hostId}:${target.engine}`} {...target} /> : null;
}

function Login({ hostId, engine }: { hostId: string; engine: Engine }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let disposed = false;
    let id = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await rpc.call<AuthState>('cliAuth.status', { id }, 15000);
        if (disposed) return;
        setState(next);
        if (!['success', 'error', 'cancelled'].includes(next.phase)) timer = setTimeout(poll, 1000);
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
    };
    rpc.call<AuthState>('cliAuth.start', { hostId, engine }, 60000).then((s) => {
      id = s.id;
      if (disposed) { void rpc.call('cliAuth.cancel', { id }).catch(() => {}); return; }
      setState(s);
      if (!['success', 'error', 'cancelled'].includes(s.phase)) timer = setTimeout(poll, 500);
    }).catch((e) => {
      if (!disposed) setError(e instanceof RpcError && e.code === 'nomethod'
        ? 'Este servidor do Deck ainda não oferece login pela interface. Atualize o daemon quando estiver ocioso.'
        : errorText(e));
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (id) void rpc.call('cliAuth.cancel', { id }).catch(() => {});
    };
  }, [hostId, engine]);

  const submit = async () => {
    if (!state || !code.trim() || sending) return;
    setSending(true);
    const value = code.trim();
    setCode('');
    try {
      const next = await rpc.call<AuthState>('cliAuth.submit', { id: state.id, code: value }, 15000);
      setState(next);
    } catch (e) { setError(errorText(e)); }
    finally { setSending(false); }
  };
  const close = () => { setCode(''); cliAuthDialog.value = null; };
  const terminal = state && ['success', 'error', 'cancelled'].includes(state.phase);
  let authUrl: URL | null = null;
  try {
    const parsed = state?.url ? new URL(state.url) : null;
    if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password) authUrl = parsed;
  } catch { /* Um endereço inválido nunca é aberto. */ }
  return (
    <div class="overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Entrar na conta">
        <div class="dialog-head"><Icon name="account" /><span class="grow">Entrar no {engine === 'claude' ? 'Claude Code' : 'Antigravity'}</span></div>
        <div class="dialog-body">
          <p>Destino: <strong>{hostId === 'local' ? 'Este computador' : hostId}</strong></p>
          <p class="hint">O login é feito no destino selecionado. Isso não altera as configurações de proxy.</p>
          {error ? <p style={{ color: 'var(--err)' }}>{error}</p> : null}
          {!state && !error && <p>Iniciando autenticação…</p>}
          {state?.phase === 'starting' && <p>Aguardando o programa iniciar…</p>}
          {state?.phase === 'awaiting_browser' && <>
            <p>Abra o link para autorizar. Se o navegador mostrar um código, cole-o abaixo.</p>
            {authUrl && <p><a href={authUrl.href} target="_blank" rel="noopener noreferrer">Abrir página de autenticação ({authUrl.hostname})</a></p>}
            {state.url && !authUrl && <p style={{ color: 'var(--err)' }}>O programa forneceu um endereço inválido ou inseguro. Cancele e tente novamente.</p>}
            <div class="field"><label>Código de autorização</label><input class="input" type="password" autoComplete="off" value={code} onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} /></div>
            <button class="btn" disabled={!code.trim() || sending} onClick={() => void submit()}>Enviar código</button>
          </>}
          {state?.phase === 'verifying' && <p>Verificando a autenticação…</p>}
          {state?.phase === 'success' && <p>Autenticação confirmada. Abra uma nova conversa para atualizar os modelos.</p>}
          {state?.phase === 'error' && <p style={{ color: 'var(--err)' }}>{state.message || 'Não foi possível concluir a autenticação.'}</p>}
          {state?.phase === 'cancelled' && <p>Autenticação cancelada.</p>}
        </div>
        <div class="dialog-foot"><button class="btn secondary" onClick={close}>{terminal || error ? 'Fechar' : 'Cancelar'}</button></div>
      </div>
    </div>
  );
}
