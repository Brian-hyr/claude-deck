import { describe, expect, it } from 'vitest';
import { formatHostBlock, listEntries, parseSshConfig, patternListMatches, resolveHost, splitArgs } from '../../src/server/hosts/sshconfig';

const CONFIG = `
# comentário
Host srv-teste-dev
    HostName 192.0.2.5
    User dev
    IdentityFile ~/.ssh/id_ed25519

Host 198.51.100.27
    User root
    Port 2222

 Host srv-app-cloud
  HostName ia.example.com
  User dev
  Port 2200

Host Servidor com Espaco
    HostName 192.0.2.10
    User appuser
    Port 2200

Host *.replit.dev
    User runner
    IdentityFile ~/.ssh/replit
    StrictHostKeyChecking accept-new

Host "Nome Entre Aspas"
    HostName quoted.example.com

Host dup
    HostName first.example.com
Host dup
    HostName second.example.com

Host *
    ServerAliveInterval 30
    User fallback
`;

describe('parser do ~/.ssh/config', () => {
  const blocks = parseSshConfig(CONFIG);

  it('lista servidores sem curingas, na ordem, sem duplicatas', () => {
    const names = listEntries(blocks).map((e) => e.alias);
    expect(names).toEqual(['srv-teste-dev', '198.51.100.27', 'srv-app-cloud', 'Servidor com Espaco', 'Nome Entre Aspas', 'dup']);
  });

  it('resolve HostName/User/Port e aplica o primeiro valor encontrado', () => {
    const r = resolveHost(blocks, 'srv-app-cloud', 'C:\\ssh');
    expect(r.hostName).toBe('ia.example.com');
    expect(r.user).toBe('dev');
    expect(r.port).toBe(2200);
    expect(r.serverAliveInterval).toBe(30); // vem do Host *
  });

  it('usa o alias como HostName quando não há HostName', () => {
    const r = resolveHost(blocks, '198.51.100.27', 'C:\\ssh');
    expect(r.hostName).toBe('198.51.100.27');
    expect(r.port).toBe(2222);
    expect(r.user).toBe('root');
  });

  it('trata "Host Nome Com Espaços" como um servidor só (igual ao VS Code)', () => {
    const r = resolveHost(blocks, 'Servidor com Espaco', 'C:\\ssh');
    expect(r.hostName).toBe('192.0.2.10');
    expect(r.user).toBe('appuser');
    expect(r.port).toBe(2200);
  });

  it('aceita nomes entre aspas', () => {
    expect(resolveHost(blocks, 'Nome Entre Aspas', 'C:\\ssh').hostName).toBe('quoted.example.com');
  });

  it('duplicata: vale o primeiro bloco', () => {
    expect(resolveHost(blocks, 'dup', 'C:\\ssh').hostName).toBe('first.example.com');
  });

  it('aplica curingas e StrictHostKeyChecking', () => {
    const r = resolveHost(blocks, 'abc.replit.dev', 'C:\\ssh');
    expect(r.user).toBe('runner');
    expect(r.strictHostKeyChecking).toBe('accept-new');
    expect(r.identityFiles[0]).toMatch(/replit$/);
  });

  it('chaves padrão quando não há IdentityFile', () => {
    const r = resolveHost(blocks, '198.51.100.27', 'C:\\ssh');
    expect(r.identityFilesExplicit).toBe(false);
    expect(r.identityFiles.some((f) => f.endsWith('id_ed25519'))).toBe(true);
  });

  it('expande ~ no IdentityFile', () => {
    const r = resolveHost(blocks, 'srv-teste-dev', 'C:\\ssh');
    expect(r.identityFiles[0]).not.toContain('~');
    expect(r.identityFiles[0]).toMatch(/id_ed25519$/);
  });

  it('negação em padrões', () => {
    expect(patternListMatches(['*', '!secret'], 'secret')).toBe(false);
    expect(patternListMatches(['*', '!secret'], 'other')).toBe(true);
  });

  it('splitArgs respeita aspas', () => {
    expect(splitArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });

  it('gera bloco novo com aspas quando o nome tem espaço', () => {
    const b = formatHostBlock({ alias: 'Meu Servidor', hostName: 'h.example.com', user: 'u', port: 2200 });
    expect(b).toContain('Host "Meu Servidor"');
    expect(b).toContain('Port 2200');
    const reparsed = parseSshConfig(b);
    expect(listEntries(reparsed).map((e) => e.alias)).toEqual(['Meu Servidor']);
  });

  it('ignora opções dentro de Match', () => {
    const b = parseSshConfig('Host a\n  HostName x\nMatch host a\n  User evil\n');
    expect(resolveHost(b, 'a', 'C:\\ssh').user).not.toBe('evil');
  });
});
