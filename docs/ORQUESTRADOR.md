# Orquestrador — desenho

Uma tarefa grande vai para um orquestrador, que a divide em várias conversas do Claude Code e acompanha cada
uma até o fim. Cada tarefa roda numa conversa própria, para **isolar o contexto**: nenhuma tarefa perde o fio
porque a conversa encheu com o trabalho das outras.

O uso no README está em [Orquestrador](../README.md#orquestrador). Este arquivo registra as decisões e os limites.

## Por que dentro do Deck

O que existia no GitHub e no próprio Claude Code em 11/2026 não serve para este caso:

| Opção | Por que não serve aqui |
|---|---|
| Agent Teams (nativo) | Interativo apenas. Em `-p`/stream-json, o modo do Deck, não cria teammates. |
| Subagentes (`Agent`) | Rodam dentro da conversa do pai: não há aba própria nem conversa com você, e o resultado volta para o contexto do pai. |
| Orquestradores com tmux/worktree (claude-squad, etc.) | Só rodam localmente, dependem de tmux ou têm licença AGPL. Não falam SSH nem com as abas do Deck. |
| Mensagens entre sessões do CLI | Só funcionam entre sessões da mesma máquina. Não há ciclo de vida, regras nem acompanhamento. |

Do que foi estudado, aproveitamos estes padrões:

- briefing por tarefa, nunca o plano inteiro;
- retorno em duas camadas: um status curto (`done | done_with_concerns | needs_context | blocked`) e o relatório
  completo num arquivo;
- estado em arquivos: `PLANO.md`, `STATE.md`, `tasks.json`, `briefs/`, `reports/`;
- o orquestrador é acordado pelos eventos, sem ficar consultando;
- verificação independente: o orquestrador roda os comandos e pode criar um worker revisor;
- limite de tentativas: até 2 correções no mesmo worker; depois disso, um worker novo; após 3 revisões, pergunta
  ao usuário.

## Arquitetura

- **Ferramentas pelo canal da conversa.** O Deck registra um servidor MCP "sdk" chamado `deck_orq` no `initialize`
  da conversa, como já fazia com o `deck_terminal`. As chamadas chegam como `control_request` do tipo
  `mcp_message` pelo mesmo stdin/stdout do CLI, então funcionam igual no computador e por SSH (runner): não há
  porta, túnel nem processo extra. Só conversas com `state.orq` recebem esse servidor.
- **Dois papéis**, com ferramentas diferentes:
  - O **orquestrador** tem: `tasks_define`, `task_update`, `tasks_list`, `plan_submit`, `worker_start`,
    `worker_send`, `worker_wait`, `worker_status`, `worker_result`, `worker_read`, `worker_stop`, `orq_wait_user`
    e `orq_finish`.
  - O **worker** tem só `task_report`. Ele não cria workers, então não há aninhamento.
- **O worker é uma conversa normal do Deck**, na mesma janela, servidor e pasta. Ele recebe:
  - o modo de permissão escolhido no diálogo;
  - o modelo e o esforço escolhidos pelo orquestrador;
  - o nome `T1.1 · Título`.

  O briefing chega numa `<orchestrator-message>` e também fica gravado em `briefs/`. Assim, o worker pode relê-lo
  depois de uma compactação.
- **`OrqManager`** (`src/server/orq/manager.ts`) guarda o registro em `orchestrations.json`, calcula o estado de
  cada worker a partir da conversa dele e entrega os eventos ao orquestrador. Quando a conversa do orquestrador
  está parada, o evento chega como uma mensagem `<orq-update>` do Deck. Quando o orquestrador está em
  `worker_wait`, o evento é a resposta da chamada.
- **Interface**: `src/web/components/Orchestrator.tsx` contém o diálogo, o quadro e a faixa do worker. O estado vem
  pelo evento `orq.update` e pelo RPC `orq.list`. O botão só aparece quando `app.info.orchestrator` é verdadeiro,
  ou seja, com um servidor antigo ele some.

## Regras impostas em código

| Regra | Onde |
|---|---|
| Nenhum worker antes de aprovar o plano (quando a aprovação é exigida) | `worker_start` |
| Esforço do orquestrador `high`, `xhigh` ou `max`; dos workers `medium`, `high`, `xhigh` ou `max` (nunca `low`) | `checkCreate` e esquema MCP de `worker_start` |
| Modelo recusado pelo gateway não é usado de novo enquanto estiver bloqueado | `worker_start` e lista de modelos das ferramentas |
| Dependências concluídas antes de começar; sem ciclos | `tasks_define` e `worker_start` |
| Duas tarefas em andamento não podem declarar os mesmos arquivos ou pastas | `filesOverlap` em `worker_start` |
| Limite de workers simultâneos (1 a 8) e um worker de implementação por tarefa | `worker_start` |
| Tarefa "concluída" exige evidência e nenhum worker de implementação ativo | `task_update` |
| Concluir a orquestração exige todas as tarefas concluídas ou canceladas | `orq_finish` |
| O orquestrador não aprova permissões dos workers | os pedidos ficam na aba do worker |
| Ferramentas `deck_orq` são liberadas sem pedido só em conversas de orquestração | `can_use_tool` |
| Uma chamada que muda estado (ex.: `worker_start`) não é executada duas vezes ao reconectar | registro durável por `request_id` |

As ferramentas que só leem ou esperam (`tasks_list`, `worker_status`, `worker_wait`, `worker_result`,
`worker_read`) ficam fora do registro durável, porque podem ser repetidas sem efeito.

## Acompanhar até o fim

O orquestrador é acordado quando um worker:

- manda o relatório;
- termina o turno sem relatório;
- falha;
- tem a aba fechada.

Os eventos são juntados por alguns segundos antes da entrega (`CLAUDE_DECK_ORQ_DELAY_MS`, padrão de 2,5 s).

Se a orquestração está em execução, há tarefas abertas, nenhum worker trabalha e o orquestrador parou, o Deck manda
um lembrete. São no máximo 3. Depois disso, o estado vira **Parada — precisa de você** e a interface avisa. Uma
mensagem sua zera a contagem.

Pausar suspende as entregas e os lembretes, mas os workers continuam o que estavam fazendo. "Parar workers"
interrompe todos e pausa.

## Modelo esgotado no gateway

O CLI termina o turno com `is_error: true`, `terminal_reason: "api_error"` e o texto `API Error: …` quando o gateway
recusa o pedido. `modelFailureOf` separa o que é culpa do modelo do que não é:

| Erro | Tratamento |
|---|---|
| 429/529, "No deployments available", rate limit, cota, orçamento, `overloaded_error`, "at capacity" | **esgotado**: bloqueado pelo "Try again in N s" do gateway, limitado a 1 min–6 h (30 min se não vier prazo) |
| "Invalid model name", "issue with the selected model", modelo inexistente | **indisponível**: bloqueado por 24 h |
| Rede (`ENOTFOUND`, conexão recusada/perdida), 401/403 de credencial, erro comum do turno | não troca: outro modelo não resolveria |

Quando é erro de modelo, em qualquer conversa da orquestração (worker ou o próprio orquestrador):

1. O modelo em uso é marcado como recusado. No modo automático do gateway, o marcado é o modelo que ele escolheu
   (`autoPick`), nunca o "auto".
2. `pickFallbackModel` escolhe outro modelo da lista do servidor: mesma janela de contexto (`[1m]`) primeiro, depois
   a mesma família, depois a ordem da lista. "Padrão", "automático", o atual e os recusados ficam de fora.
3. O Deck faz `set_model` na conversa e manda um `<orq-update>` pedindo para continuar de onde parou. O transcript é
   o mesmo, e o turno recusado não chegou a rodar.
4. Num worker, o orquestrador recebe um evento informativo (`model`). Os modelos recusados aparecem em
   `worker_status`/`tasks_list` e somem da lista de modelos de `worker_start`. Se `worker_start` pedir um modelo
   recusado, é recusado; se o recusado for o modelo padrão dos workers, o Deck usa outro e avisa no resultado.

Sem reserva disponível, ou depois de 4 trocas seguidas sem um turno bem-sucedido, o Deck desiste: o worker vira erro
para o orquestrador decidir, e o orquestrador vai para **Parada — precisa de você**, com aviso na interface. Um turno
bem-sucedido zera a contagem. O registro dos bloqueios fica em `orchestrations.json` e sobrevive a reinícios.

## Retomada

- **Reiniciar o daemon**: as conversas voltam com o mesmo `sid`, e o registro em `orchestrations.json` continua
  válido.
- **Fechar a aba do orquestrador**: a orquestração fica pausada. Ao retomar pelo Histórico, o Deck reconhece a
  conversa pelo `sessionId` (`roleForResume`), devolve o papel a ela e religa o registro (`relink`).
- **Fechar a aba de um worker** sem relatório: vira o evento "fechada sem relatório" para o orquestrador.

## Limites conhecidos

- **Partição por arquivos é declarativa.** O Deck impede duas tarefas ativas com arquivos sobrepostos *declarados*,
  mas não bloqueia a escrita de um worker fora dos arquivos da tarefa. O briefing proíbe isso, e a verificação (o
  diff e o worker revisor) deve detectar. Todos os workers usam a mesma árvore de trabalho; não há uma worktree por
  worker.
- **O comportamento do modelo vem do prompt.** Perguntar só o geral, escolher modelo e esforço adequados e
  verificar de verdade dependem das instruções. Os testes usam um Claude falso; as regras da tabela acima são
  garantidas, mas a qualidade do planejamento depende do modelo.
- **Custo.** Cada worker é uma sessão completa do Claude. O quadro soma o custo informado pelos workers. O custo do
  orquestrador aparece na própria conversa dele.
- **Permissão de worker** só vira evento para um orquestrador que esteja em `worker_wait` naquele momento. Fora
  disso, ela aparece em `worker_status` e no chip amarelo do quadro.

## Testes

- `test/unit/orq.test.ts`: normalização e sobreposição de arquivos, ciclos, validação do esquema, roteamento do
  MCP na sessão, liberação de permissão e repetição segura.
- `test/integration/orchestrator.test.ts`: fluxo completo com o Claude falso nos dois papéis. Cobre aprovação,
  regras, workers em paralelo, relatórios, lembretes, pausa e cancelamento, e isolamento entre janelas.
- `test/e2e/orchestrator.mjs` (`npm run test:orq:ui`): a interface no Brave isolado. Cobre o diálogo, o quadro,
  a aprovação pelo botão, a aba do worker, o relatório acordando o orquestrador, a conclusão e o F5.
- `test/e2e/compat-old-server.mjs`: com um servidor anterior, as entradas do orquestrador somem.
- `test/integration/real-orchestrator.test.ts`: **piloto com o Claude real**. Gasta créditos, então só roda com
  `DECK_REAL_ORQ=1`. Ele cria um projeto Node pequeno em `C:\Temp` e pede três funções. O teste faz o papel do
  usuário: aprova o plano e responde as perguntas. Também nega commit/push, instalar pacotes, rede e apagar fora da
  pasta. O piloto é cancelado sozinho ao passar do teto (`DECK_PILOT_COST_CAP`, padrão US$ 5, e
  `DECK_PILOT_MINUTES`, padrão 25 min). `DECK_PILOT_KEEP=1` guarda a pasta para inspeção.

## Piloto com o Claude real (03/11/2026)

Orquestrador no Sonnet com esforço Alto, Claude Code 2.1.306, pedido de três funções (CPF, temperatura, reais).

| | 1ª execução | 2ª execução (com os ajustes abaixo) |
|---|---|---|
| Resultado | 3/3 tarefas concluídas, 33 testes passando | 3/3 tarefas concluídas, 64 testes passando |
| Tempo e custo | 2,2 min · US$ 0,63 | 2,0 min · US$ 0,54 |
| Plano | 3 tarefas paralelas, arquivos separados, esperou o botão | igual |
| Workers | 3 em paralelo, Sonnet com esforço Alto, cada um com relatório | igual |
| Verificação | o orquestrador rodou os testes de cada tarefa e o `npm test` | igual |
| Perguntas | 4: commit por tarefa e assinaturas (gerais); entrada do CPF e casos de borda dos reais (específicas, fora da regra) | nenhuma (o pedido já respondia o essencial) |
| Lembrete fora de hora | 1: chegou logo depois da aprovação e falava em "nenhum worker" | nenhum |

O que a 1ª execução levou a mudar:

- **Lembrete fora de hora.** Entre o fim de um turno e o começo do próximo, o CLI passa por "parado" mesmo com
  uma mensagem esperando na fila, como o aviso de aprovação. O Deck mandava o lembrete nesse intervalo, e ele chegava
  depois dos `worker_start`, já desatualizado. Agora a sessão sabe quais mensagens enviadas ainda não começaram
  (`hasQueuedInput`, com prazo de 15 s caso o CLI descarte alguma) e a entrega espera. As instruções também mandam
  conferir o estado antes de agir com base num `<orq-update>`.
- **Perguntas específicas.** As instruções agora dão exemplos do que **não** perguntar (formato de entrada, casos de
  borda, nomes, algoritmo): isso fica com o worker daquela tarefa.

Isto não prova o caso grande. Três funções independentes não exercitam dependências, uma tarefa de fundação, a
correção por `worker_send` nem um worker revisor. Também não testam o orquestrador escolhendo modelos diferentes:
nas duas execuções todos os workers foram Sonnet com esforço Alto, o que é razoável para tarefas parecidas. Antes de
usar no softrouter, vale uma rodada com dependências reais.
