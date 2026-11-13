// Adaptador para normalizar eventos do Antigravity CLI (`agy`) para o formato do Claude Deck.
export function normalizeAntigravityEvent(raw: any, sessionId?: string): any[] {
  if (!raw || typeof raw !== 'object') return [];

  // Se já for evento no padrão Anthropic/Claude Code, devolve direto
  if (['stream_event', 'assistant', 'user', 'control_request', 'control_response', 'system', 'rate_limit_event'].includes(raw.type)) {
    return [raw];
  }

  // 1. Inicialização do Antigravity CLI
  if (raw.type === 'init') {
    return [{
      type: 'system',
      subtype: 'init',
      session_id: raw.session_id || raw.conversation_id || sessionId,
      model: raw.model || undefined,
      claude_code_version: raw.version || '1.0.0 (agy)',
    }];
  }

  // 2. Atualizações de passo (step_update)
  if (raw.type === 'step_update' || raw.step_type) {
    const stepType = raw.step_type || raw.type;

    // Resposta de texto ou raciocínio (streaming delta)
    if (stepType === 'agent_response' || raw.delta || raw.content) {
      const isThinking = !!raw.is_thinking || !!raw.delta?.thinking;
      const text = raw.delta?.text ?? raw.text ?? raw.content ?? '';
      const thinking = raw.delta?.thinking ?? raw.thinking ?? '';
      const out: any[] = [];
      if (text || thinking) {
        out.push({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: raw.index ?? 0,
            delta: isThinking ? { type: 'thinking_delta', thinking } : { type: 'text_delta', text },
          },
        });
      }
      return out;
    }

    // Chamada de ferramenta (tool_call)
    if (stepType === 'tool_call') {
      const id = raw.tool_id || raw.id || `call_${Date.now()}`;
      const name = raw.tool_name || raw.name || 'tool';
      const input = raw.parameters || raw.input || {};
      return [
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: raw.index ?? 1,
            content_block: {
              type: 'tool_use',
              id,
              name,
              input,
            },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_stop',
            index: raw.index ?? 1,
          },
        },
      ];
    }

    // Resultado de ferramenta (tool_result)
    if (stepType === 'tool_result') {
      const toolUseId = raw.tool_id || raw.id || '';
      const content = typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output ?? '');
      return [{
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content,
              is_error: !!raw.is_error,
            },
          ],
        },
      }];
    }
  }

  // 3. Resultado final da execução
  if (raw.type === 'result') {
    const metrics = raw.metrics ?? {};
    const inTok = Number(metrics.input_tokens) || 0;
    const outTok = Number(metrics.output_tokens) || 0;
    return [
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'result',
        status: raw.status === 'ERROR' ? 'error' : 'success',
        stats: {
          total_tokens: inTok + outTok,
          duration_ms: Number(metrics.duration_ms) || 0,
        },
        cost: Number(metrics.cost) || 0,
      },
    ];
  }

  return [raw];
}
