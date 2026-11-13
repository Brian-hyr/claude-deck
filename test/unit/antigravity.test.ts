import { describe, expect, it } from 'vitest';
import { normalizeAntigravityEvent } from '../../src/server/claude/antigravityAdapter';
import { findLocalAgy } from '../../src/server/claude/find-local';
import { buildArgs } from '../../src/server/claude/session';

describe('Antigravity CLI (agy) integration', () => {
  it('localiza executáveis do agy no sistema', () => {
    const bins = findLocalAgy();
    expect(bins).toBeDefined();
    expect(Array.isArray(bins)).toBe(true);
    if (bins.length > 0) {
      expect(bins[0].path).toBeDefined();
      expect(bins[0].version).toBeDefined();
    }
  });

  it('monta argumentos de linha de comando para o agy', () => {
    const argsAgy = buildArgs({
      engine: 'antigravity',
      mode: 'default',
      model: 'flash38[1m]',
      resume: '12345678-1234-1234-1234-123456789abc',
    });
    expect(argsAgy).toContain('-p');
    expect(argsAgy).toContain('--input-format');
    expect(argsAgy).toContain('stream-json');
    expect(argsAgy).toContain('--output-format');
    expect(argsAgy).toContain('--model');
    expect(argsAgy).toContain('flash38[1m]');
    expect(argsAgy).toContain('--conversation');
    expect(argsAgy).not.toContain('--resume');
  });

  it('deixa a CLI escolher o padrão quando não há modelo explícito', () => {
    const args = buildArgs({ engine: 'antigravity', mode: 'default' });
    expect(args).not.toContain('--model');
    expect(normalizeAntigravityEvent({ type: 'init' })[0].model).toBeUndefined();
  });

  it('normaliza o evento init do agy', () => {
    const ev = normalizeAntigravityEvent({ type: 'init', session_id: 'sess-123', model: 'flash38[1m]' });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
      model: 'flash38[1m]',
      claude_code_version: '1.0.0 (agy)',
    });
  });

  it('normaliza delta de texto do step_update', () => {
    const ev = normalizeAntigravityEvent({
      type: 'step_update',
      step_type: 'agent_response',
      delta: { text: 'Olá mundo' },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Olá mundo' },
      },
    });
  });

  it('normaliza delta de raciocínio (thinking) do step_update', () => {
    const ev = normalizeAntigravityEvent({
      type: 'step_update',
      step_type: 'agent_response',
      delta: { thinking: 'pensando...' },
      is_thinking: true,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'pensando...' },
      },
    });
  });

  it('normaliza chamada de ferramenta (tool_call)', () => {
    const ev = normalizeAntigravityEvent({
      type: 'step_update',
      step_type: 'tool_call',
      tool_name: 'read_file',
      tool_id: 'call_99',
      parameters: { path: 'teste.txt' },
    });
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_99',
          name: 'read_file',
          input: { path: 'teste.txt' },
        },
      },
    });
    expect(ev[1]).toEqual({
      type: 'stream_event',
      event: {
        type: 'content_block_stop',
        index: 1,
      },
    });
  });

  it('normaliza resultado de ferramenta (tool_result)', () => {
    const ev = normalizeAntigravityEvent({
      type: 'step_update',
      step_type: 'tool_result',
      tool_id: 'call_99',
      output: 'conteudo do arquivo',
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_99',
            content: 'conteudo do arquivo',
            is_error: false,
          },
        ],
      },
    });
  });

  it('normaliza o evento final result com métricas', () => {
    const ev = normalizeAntigravityEvent({
      type: 'result',
      status: 'SUCCESS',
      metrics: {
        input_tokens: 150,
        output_tokens: 50,
        duration_ms: 2500,
        cost: 0.002,
      },
    });
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({
      type: 'stream_event',
      event: { type: 'message_stop' },
    });
    expect(ev[1]).toEqual({
      type: 'result',
      status: 'success',
      stats: {
        total_tokens: 200,
        duration_ms: 2500,
      },
      cost: 0.002,
    });
  });

  it('mantém eventos nativos do Claude sem alteração (passthrough)', () => {
    const nativeEv = { type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool' } };
    expect(normalizeAntigravityEvent(nativeEv)).toEqual([nativeEv]);
  });
});
