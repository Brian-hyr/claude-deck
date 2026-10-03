import { describe, it, expect } from 'vitest';
import { receivesSessionMsg } from '../../src/server/routing';

describe('receivesSessionMsg: o fluxo de mensagens vai só para a janela dona da conversa', () => {
  it('a janela dona recebe', () => {
    expect(receivesSessionMsg('w-a', 'w-a')).toBe(true);
  });
  it('outra janela não recebe', () => {
    expect(receivesSessionMsg('w-a', 'w-b')).toBe(false);
  });
  it('cliente sem janela (ainda não anexou, ferramenta, teste) continua recebendo', () => {
    expect(receivesSessionMsg('w-a', undefined)).toBe(true);
  });
  it('conversa sem dono continua indo para todos', () => {
    expect(receivesSessionMsg(undefined, 'w-b')).toBe(true);
    expect(receivesSessionMsg(undefined, undefined)).toBe(true);
  });
});
