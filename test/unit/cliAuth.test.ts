import { describe, expect, it } from 'vitest';
import { authUrl, CliAuthManager } from '../../src/server/claude/cliAuth';
import type { HostRegistry } from '../../src/server/hosts/registry';

describe('login das CLIs', () => {
  it('aceita URL Google dividida entre linhas e preserva os parâmetros', () => {
    const value = authUrl('Open the URL:\nhttps://accounts.google.com/o/oauth2/auth?state=abc&\nredirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback\n────────────────', 'antigravity');
    expect(value).toContain('accounts.google.com');
    expect(new URL(value!).searchParams.get('redirect_uri')).toBe('https://antigravity.google/oauth-callback');
  });
  it('recusa domínios incorretos, credenciais embutidas e URLs incompletas', () => {
    expect(authUrl('https://accounts.google.com.evil.test/o?state=x&redirect_uri=x', 'antigravity')).toBeUndefined();
    expect(authUrl('https://evil@accounts.google.com/o?state=x&redirect_uri=x', 'antigravity')).toBeUndefined();
    expect(authUrl('https://accounts.google.com/o?state=x', 'antigravity')).toBeUndefined();
    expect(authUrl('http://accounts.google.com/o?state=x&redirect_uri=x', 'antigravity')).toBeUndefined();
  });
  it('mantém login separado por conexão e cancela inicialização interrompida', async () => {
    let finish!: (value: any) => void;
    const registry = { exists: () => true, connect: () => new Promise((resolve) => { finish = resolve; }) } as unknown as HostRegistry;
    const manager = new CliAuthManager(registry);
    const pending = manager.start(10, 'local', 'claude');
    await expect(manager.start(11, 'local', 'claude')).rejects.toMatchObject({ code: 'busy' });
    manager.cancelOwner(10);
    finish({ claude: { path: 'should-not-run' } });
    const state = await pending;
    expect(state.phase).toBe('cancelled');
    expect(() => manager.status(11, state.id)).toThrow('Login não encontrado');
    expect(manager.status(10, state.id).phase).toBe('cancelled');
    expect(() => manager.submit(10, state.id, 'code')).toThrow('Código inválido');
    manager.closeAll();
  });
});
