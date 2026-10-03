import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, resolvePaths } from '../../src/server/config';
import { ClaudeSession, SessionManager, type SessionRecord } from '../../src/server/claude/session';
import { TerminalMcpServer } from '../../src/server/terminal/mcp';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

function fixture(rec?: SessionRecord) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-terminal-protocol-'));
  const store = new Store(resolvePaths(dir));
  const mgr = new SessionManager(new EventEmitter() as any, store, () => {});
  const session = new ClaudeSession(rec ?? {
    sid: 'unit-session', hostId: 'local', cwd: dir, createdAt: Date.now(), executionMode: 'terminal', permissionMode: 'default',
  }, mgr);
  mgr.sessions.set(session.state.sid, session);
  session.state.terminalId = 'terminal-unit';
  const run = vi.fn(async () => ({ output: 'result-42', lastLine: 'PS>', state: 'prompt', ms: 1, truncated: 0, fullScreen: false }));
  const bind = vi.fn(async () => 'terminal-unit');
  mgr.terminals = { bind, reveal: vi.fn(), agent: () => ({ run, read: vi.fn(async () => ({ output: 'screen', lastLine: 'PS>', fullScreen: false })) }) as any };
  const writes: any[] = [];
  (session as any).transport = { alive: true, write: (line: string) => writes.push(JSON.parse(line)), close() {} };
  const receive = (msg: any) => (session as any).onLine(JSON.stringify(msg), JSON.stringify(msg).length + 1);
  cleanups.push(() => {
    if ((mgr as any).persistTimer) clearTimeout((mgr as any).persistTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { session, mgr, run, bind, writes, receive, dir };
}

function call(id = 'req-one', command = 'echo harmless') {
  return { type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'deck_terminal', message: {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run', arguments: { command } },
  } } };
}
const mcpResponse = (writes: any[], n = 0) => writes[n]?.response?.response?.mcp_response;

describe('MCP control channel and durable replay', () => {
  it('replies to initialize while reconnecting, without queuing behind initialize', async () => {
    const f = fixture();
    f.session.state.phase = 'reconnecting';
    (f.session as any).awaitingInit = true;
    const msg = call();
    msg.request.message = { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} } as any;
    f.receive(msg);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(mcpResponse(f.writes).result.serverInfo.name).toBe('claude-deck-terminal');
    expect((f.session as any).outbox).toEqual([]);
  });

  it('persists reservation before executing, and coalesces duplicate requests', async () => {
    const f = fixture();
    let done!: (value: any) => void;
    f.run.mockImplementation(async () => {
      const records = JSON.parse(fs.readFileSync(f.mgr.store.paths.sessionsFile, 'utf8'));
      expect(records[0].terminalCalls['req-one'].fingerprint).toBeTruthy();
      expect(records[0].terminalCalls['req-one'].response).toBeUndefined();
      return new Promise((resolve) => { done = resolve; });
    });
    f.receive(call());
    f.receive(call());
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    done({ output: 'result-42', lastLine: 'PS>', state: 'prompt', ms: 1, truncated: 0, fullScreen: false });
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(mcpResponse(f.writes)).toEqual(mcpResponse(f.writes, 1));
    expect(JSON.stringify(mcpResponse(f.writes))).toContain('result-42');
    f.receive(call());
    await vi.waitFor(() => expect(f.writes).toHaveLength(3));
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('returns stored result after app reconstruction, without a second execution', async () => {
    const f = fixture();
    f.receive(call());
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    const records = JSON.parse(fs.readFileSync(f.mgr.store.paths.sessionsFile, 'utf8'));
    const restored = fixture(records[0]);
    restored.receive(call());
    await vi.waitFor(() => expect(restored.writes).toHaveLength(1));
    expect(restored.run).not.toHaveBeenCalled();
    expect(mcpResponse(restored.writes)).toEqual(mcpResponse(f.writes));
  });

  it('reports uncertain execution after crash instead of repeating a pending command', async () => {
    const f = fixture();
    f.run.mockImplementation(() => new Promise(() => {}));
    f.receive(call());
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const records = JSON.parse(fs.readFileSync(f.mgr.store.paths.sessionsFile, 'utf8'));
    const restored = fixture(records[0]);
    restored.receive(call());
    await vi.waitFor(() => expect(restored.writes).toHaveLength(1));
    expect(restored.run).not.toHaveBeenCalled();
    expect(mcpResponse(restored.writes).result.isError).toBe(true);
    expect(JSON.stringify(mcpResponse(restored.writes))).toContain('NÃO será repetida');
  });

  it('never executes when durable reservation fails', async () => {
    const f = fixture();
    vi.spyOn(f.mgr, 'persistNow').mockImplementation(() => { throw new Error('disk full'); });
    f.receive(call());
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.run).not.toHaveBeenCalled();
    expect(JSON.stringify(mcpResponse(f.writes))).toContain('Nenhum comando foi enviado');
  });

  it('rejects changed payload under an already-used request ID', async () => {
    const f = fixture();
    f.receive(call());
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.receive(call('req-one', 'different command'));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(mcpResponse(f.writes, 1).result.isError).toBe(true);
  });

  it.each(['silent', 'plan', 'lost'] as const)('rejects writes in %s state before binding', async (kind) => {
    const f = fixture();
    if (kind === 'silent') f.session.state.executionMode = 'silent';
    if (kind === 'plan') f.session.state.permissionMode = 'plan';
    if (kind === 'lost') f.session.state.terminalId = undefined;
    f.receive(call());
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.run).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(mcpResponse(f.writes).result.isError).toBe(true);
  });

  it('cancels the running MCP request from its outer control request ID', async () => {
    const f = fixture();
    let signal!: AbortSignal;
    f.run.mockImplementation(async (...args: any[]) => {
      signal = args[2].signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ output: '', state: 'cancelled', lastLine: '', ms: 1, truncated: 0, fullScreen: false })));
    });
    f.receive(call());
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    f.receive({ type: 'control_cancel_request', request_id: 'req-one' });
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(signal.aborted).toBe(true);
  });

  it('keeps write permissions interactive and denies invisible Bash while live', () => {
    const f = fixture();
    f.receive({ type: 'control_request', request_id: 'allow-write', request: { subtype: 'can_use_tool', tool_name: 'mcp__deck_terminal__run', input: { command: 'echo harmless' } } });
    expect(f.session.pendingPermissions.has('allow-write')).toBe(true);
    expect(f.writes).toHaveLength(0);
    f.receive({ type: 'control_request', request_id: 'invisible', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hidden' } } });
    expect(f.writes[0].response.response.behavior).toBe('deny');
    f.session.state.executionMode = 'silent';
    f.receive({ type: 'control_request', request_id: 'ordinary', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo ordinary' } } });
    expect(f.session.pendingPermissions.has('ordinary')).toBe(true);
  });

  it('announces current silent mode on restored conversations with old live instructions', () => {
    const f = fixture();
    f.session.state.executionMode = 'silent';
    expect((f.session as any).modeNotice()).toContain('Silencioso');
    expect((f.session as any).modeNotice()).toBe('');
    f.session.setExecutionMode('terminal');
    expect((f.session as any).modeNotice()).toContain('mcp__deck_terminal__run');
  });
});

describe('terminal MCP validation', () => {
  it.each([
    { name: 'unknown', arguments: {} },
    { name: 'run', arguments: { command: 42 } },
    { name: 'run', arguments: { command: 'echo safe', other: true } },
    { name: 'run', arguments: { command: 'echo safe', timeout_seconds: -1 } },
    { name: 'send', arguments: { keys: [null] } },
    { name: 'read', arguments: [] },
  ])('rejects malformed call %j without touching the terminal', async (params) => {
    const call = vi.fn();
    const server = new TerminalMcpServer({ call });
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    expect(response.result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('lists tools and rejects unknown methods', async () => {
    const server = new TerminalMcpServer({ call: vi.fn() });
    expect((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: any) => t.name)).toEqual(['run', 'send', 'read', 'wait']);
    expect((await server.handle({ jsonrpc: '2.0', id: 2, method: 'bad' })).error.code).toBe(-32601);
  });
});
