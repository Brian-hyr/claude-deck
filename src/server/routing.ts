// Para quem vai cada evento de uma conversa.

/**
 * O fluxo de mensagens de uma conversa (dezenas de eventos por segundo durante a resposta) só interessa à janela
 * dona dela: as outras descartam tudo ao ver que não têm aquela aba. Mandar para todas custava JSON.parse e
 * alocação em cada janela aberta, para cada mensagem de cada conversa em andamento.
 *
 * Continuam recebendo:
 * - qualquer cliente sem janela (ainda não anexou, ou é uma ferramenta/teste): ele pode estar carregando a aba
 *   e precisa da fila de eventos, então na dúvida recebe;
 * - qualquer cliente se a conversa não tem dono (sessão antiga, sem janela registrada).
 */
export function receivesSessionMsg(ownerWid: string | undefined, clientWid: string | undefined): boolean {
  if (!ownerWid || !clientWid) return true;
  return ownerWid === clientWid;
}
