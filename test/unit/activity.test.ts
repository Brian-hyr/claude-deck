import { describe, expect, it } from 'vitest';
import { activityPrefix, chatActivity, type ChatActivityInput } from '../../src/web/lib/activity';

const idle: ChatActivityInput = { attention: null, pendingCount: 0, phase: 'idle', modelRunning: false };

describe('chatActivity', () => {
  it('conversa parada e já vista não tem atividade', () => {
    expect(chatActivity(idle)).toBeNull();
    expect(chatActivity({ ...idle, phase: 'dormant' })).toBeNull();
  });

  it('trabalhando: pela fase do servidor ou pelo turno do modelo', () => {
    expect(chatActivity({ ...idle, phase: 'running' })).toBe('running');
    expect(chatActivity({ ...idle, modelRunning: true })).toBe('running');
  });

  it('terminou e ainda não foi vista (com ou sem erro)', () => {
    expect(chatActivity({ ...idle, unseen: 'done' })).toBe('done');
    expect(chatActivity({ ...idle, unseen: 'error' })).toBe('error');
  });

  it('esperando você vale mais que trabalhando (o turno segue "rodando" enquanto espera a resposta)', () => {
    expect(chatActivity({ ...idle, attention: 'permission', phase: 'running', modelRunning: true })).toBe('waiting');
    expect(chatActivity({ ...idle, pendingCount: 1, modelRunning: true })).toBe('waiting');
  });

  it('trabalhando vale mais que "terminou" (um novo turno já começou)', () => {
    expect(chatActivity({ ...idle, unseen: 'done', phase: 'running' })).toBe('running');
  });

  it('pendência manual não depende do resultado do turno e nunca recebe rótulo de concluída', () => {
    expect(chatActivity({ ...idle, manualPending: true })).toBe('pending');
    expect(chatActivity({ ...idle, manualPending: true, unseen: 'done' })).toBe('pending');
    expect(chatActivity({ ...idle, manualPending: true, phase: 'running' })).toBe('running');
    expect(chatActivity({ ...idle, manualPending: true, pendingCount: 1 })).toBe('waiting');
  });
});

describe('activityPrefix', () => {
  it('sem atividade: vazio, o título fica como era', () => {
    expect(activityPrefix([])).toBe('');
    expect(activityPrefix([null, null])).toBe('');
  });

  it('um estado, um ícone', () => {
    expect(activityPrefix(['running'])).toBe('⏳ ');
    expect(activityPrefix([null, 'done'])).toBe('✅ ');
    expect(activityPrefix(['error'])).toBe('❌ ');
    expect(activityPrefix(['pending'])).toBe('🔖 ');
  });

  it('várias conversas no mesmo estado mostram o ícone uma vez', () => {
    expect(activityPrefix(['running', 'running', 'running'])).toBe('⏳ ');
  });

  it('estados diferentes: todos aparecem, o mais urgente primeiro', () => {
    expect(activityPrefix(['running', 'done'])).toBe('✅⏳ ');
    expect(activityPrefix(['running', 'error', 'done'])).toBe('❌✅⏳ ');
    expect(activityPrefix(['running', 'error', 'pending', 'done'])).toBe('❌🔖✅⏳ ');
  });

  it('conta quantas conversas esperam você', () => {
    expect(activityPrefix(['waiting'])).toBe('🔔 (1) ');
    expect(activityPrefix(['waiting', null, 'waiting', 'running'])).toBe('🔔⏳ (2) ');
  });
});
