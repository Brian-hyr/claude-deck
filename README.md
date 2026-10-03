# Claude Deck

Uma interface enxuta, no estilo do VS Code, para usar o **Claude Code** no seu computador e nos
seus **servidores SSH**, com várias conversas em abas. O app roda em janela dedicada do seu navegador
preferido (**Brave**, **Edge**, **Chrome** ou **Firefox**). Ele fala direto com o `claude` de linha de
comando, local ou no servidor, e continua usando o mesmo login, as mesmas skills, os MCPs, o `CLAUDE.md`
e o **mesmo histórico** da extensão do VS Code.

## Por que o Claude Deck? (Vantagens sobre o VS Code + Extensão)

O Claude Deck foi criado para quem quer o poder do Claude Code sem o peso e as limitações de manter uma IDE inteira aberta:

| Vantagem | VS Code + Extensão | Claude Deck |
| :--- | :--- | :--- |
| **Gasto de memória (RAM local)** | **800 MB a 2+ GB** (Electron + extensões) | **~60 MB** (daemon Node) + janela leve do navegador |
| **Gasto em repouso / desligado** | Alto enquanto aberto | **0 MB** (servidor desligado quando não em uso) |
| **Impacto no servidor SSH** | **Pesado** (~200–500 MB com VS Code Server) | **Zero** (apenas runner `sh` minúsculo de poucos KB) |
| **Risco de OOM em VPSs** | Frequente em servidores de 1 GB / 2 GB | Inexistente (não roda Node de IDE remota) |
| **Queda de conexão / Suspensão** | Janela congela e perde o terminal | **Resiliente**: Claude continua rodando e reconecta por bytes |
| **Múltiplas janelas** | Abre janelas duplicadas da mesma pasta | **1 janela por servidor + pasta**: foca a janela aberta |
| **Restauração de sessões** | Restaura apenas a última pasta | **Restaura todas as janelas e abas** ao ligar o PC |
| **Terminal ao Vivo** | Desacoplado da IA em outra aba | **Terminal nativo lado a lado com MCP em tempo real** |
| **Agilidade de terminal** | Teclas padrão de IDE | **Auto-cópia ao selecionar** e **colar com botão direito** |
| **Controle de contexto e `/compact`** | Nativo na extensão da IDE | **Mesma paridade visual**, mas sem a sobrecarga da IDE |
| **Histórico e ecossistema** | Padrão Claude Code | **100% compatível**: lê e grava em `~/.claude/projects` |

> 📖 Para a análise técnica aprofundada de cada ponto, consulte o documento [Vantagens e Comparativo Técnico](docs/VANTAGENS.md).

## Abrir

- **Atalho "Claude Deck"** na Área de Trabalho ou no Menu Iniciar. Na primeira vez o servidor
  local sobe escondido (cerca de 1–3 s); nas outras vezes a janela abre na hora.
- **Uma janela por servidor + pasta.** Cada janela é de um servidor (ou deste computador) e de uma
  pasta de trabalho; todas as conversas dela rodam nessa pasta. Duas pastas diferentes no mesmo
  servidor (ex: `app` e `api`) têm janelas separadas, mas nunca há duas janelas da mesma pasta no mesmo servidor: pedir
  de novo uma pasta que já está aberta só traz a janela dela para a frente (inclusive minimizada).
  Arquivos de outras pastas do mesmo servidor podem ser abertos e vistos na janela (explorador,
  pastas extras) sem mudar a pasta das conversas. A janela fica focada no servidor dela: o
  histórico e o explorador não mostram outros servidores (esses ficam na janela de cada um).
- **Desligar e ligar o PC:** o atalho reabre **todas as janelas que estavam abertas**, cada uma com
  as mesmas abas. A janela que você fechou sozinha (com outras ainda abertas) não volta sozinha:
  fica salva e volta ao clicar na pasta dela na aba Servidores. Com o app já aberto, o atalho abre
  uma **janela nova e vazia**, sem servidor escolhido; as janelas abertas ficam como estão.
- A janela usa um perfil do navegador **próprio e isolado** do Claude Deck (`%APPDATA%\claude-deck\browser-profile`
  para Brave ou `browser-profile-<id>` para Edge, Chrome e Firefox): as extensões do seu navegador do dia a
  dia (Dark Reader etc.), logins pessoais e cookies não rodam dentro do app.
- Pelo terminal: `npm run app:open` (abre) · `npm run app:stop` (encerra o servidor).
- Iniciar junto com o Windows: **Configurações → Sistema** (vem desligado; o servidor parado
  gasta 0 MB, e ligado gasta ~60 MB).

O servidor escuta só em `127.0.0.1:47319` e exige autenticação. O atalho troca esse token por um
código de uso único (60 s via `/launch`), então o token mestre não fica no histórico ou na linha de
comando do navegador.

## Instalação e escolha do navegador

O Claude Deck suporta quatro navegadores no Windows: **Brave**, **Microsoft Edge**, **Google Chrome** e **Mozilla Firefox**.

### Como instalar os atalhos

```powershell
# Modo de inspeção (DryRun - validação segura sem alterar arquivos)
powershell -ExecutionPolicy Bypass -File launcher\install.ps1

# Instalação com navegador padrão (escolhe Brave se instalado; senão Edge, Chrome ou Firefox)
powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply

# Instalação escolhendo explicitamente o navegador:
powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply -Browser edge     # Microsoft Edge
powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply -Browser chrome   # Google Chrome
powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply -Browser firefox  # Mozilla Firefox
powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply -Browser brave    # Brave Browser
```

A escolha explícita do instalador grava `%APPDATA%\claude-deck\browser.json` (no formato `{"browser":"<id>"}`) de forma atômica (UTF-8 sem BOM). Quando o arquivo não existe, o Claude Deck adota a ordem automática de detecção: Brave › Edge › Chrome › Firefox.

Para trocar depois, use **Configurações → Sistema → Navegador** e feche as janelas antes de abrir o atalho novamente. No primeiro uso, escolha com `launcher\install.ps1 -Apply -Browser firefox`.

### Isolamento de perfil e dados próprios (sem compartilhamento de token)

- **Perfil exclusivo e dedicado**: cada navegador mantém seus dados em uma pasta isolada dentro de `%APPDATA%\claude-deck`:
  - Brave: `browser-profile`
  - Edge: `browser-profile-edge`
  - Chrome: `browser-profile-chrome`
  - Firefox: `browser-profile-firefox`
- **Isolamento de extensões e credenciais**: nenhuma sessão, cookie, favorito ou extensão pessoal (como bloqueadores de anúncio ou modificadores de tema) interfere com o app.
- **Autenticação segura via código descartável**: o token de autenticação nunca é exposto na barra de endereços ou nos parâmetros visíveis. O launcher obtém um código descartável de 60 segundos do endpoint `/launch` e o troca por um cookie HttpOnly na primeira requisição. Para navegadores diferentes do Brave, qualquer fallback com token na URL é bloqueado por segurança.

### Diferenças de comportamento entre navegadores

| Navegador | Modo de execução | Experiência de uso |
|---|---|---|
| **Brave** | `--app` (Chromium) | Janela própria sem barra de endereços, abas ou botões de navegação. Recompensas e recursos externos desativados para leveza. Suporta selo numérico na barra de tarefas do Windows. |
| **Edge** | `--app` (Chromium) | Janela de aplicativo nativo sem moldura de navegador tradicional, altamente integrado ao Windows. Suporta selo numérico na barra de tarefas. |
| **Chrome** | `--app` (Chromium) | Janela de aplicativo limpa e dedicada, sem controles de navegação ou barra de URL. Suporta selo numérico na barra de tarefas. |
| **Firefox** | `-new-window` com `-profile` | Abre em janela separada com perfil isolado pretendido (verifique na instalação local do Firefox o comportamento caso já existam instâncias abertas), sem o argumento `-no-remote`. O Firefox mantém barras normais de navegação por não possuir o modo `--app` Chromium. **Limitação de selo:** o Deck não aplica seu selo numérico nativo à janela do Firefox, porque ainda não consegue identificar com segurança o processo/janela para esse recurso. |

### Instalação no computador de um colega (ambiente próprio e independente)

Para que um colega instale e utilize o Claude Deck em seu próprio PC de forma limpa e independente:

1. **Requisitos locais**: Windows 10/11 com **Node.js >= 22**, o **Claude Code CLI instalado** e um dos navegadores suportados (Brave, Edge, Chrome ou Firefox).
2. **Login próprio no Claude Code**: o colega deve autenticar o CLI instalado no próprio computador (por exemplo, com `claude` no terminal). O Deck utiliza o CLI já autenticado naquela máquina, com as contas, chaves, MCPs e histórico próprios em `~/.claude`.
3. **Não copiar segredos ou dados privados**: nunca copie pastas ou arquivos de `%APPDATA%\claude-deck` de outro computador (como `token`, cookies, credenciais, perfis de navegador ou `state.json`). Cada instalação gera seu próprio token criptográfico local e seus próprios diretórios de perfil.
4. **Compilação e atalhos**:
   ```powershell
   npm install
   npm run build
   powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply             # usa navegador padrão detectado
   # Ou especificando o navegador:
   powershell -ExecutionPolicy Bypass -File launcher\install.ps1 -Apply -Browser edge
   ```
5. **Execução**: abra pelo atalho "Claude Deck" na Área de Trabalho ou no Menu Iniciar.

## Layout

| Onde | O quê |
|---|---|
| Barra da esquerda | Explorador · Buscar em arquivos · Servidores · Histórico · Nova conversa · Configurações |
| Barra lateral | Arquivos da pasta aberta, busca dentro dos arquivos, servidores do `~/.ssh/config` (favoritos no topo) ou histórico |
| Centro | Conversas em abas do servidor e da pasta desta janela; outros contextos têm janelas próprias |
| Título da janela | Servidor e pasta da janela (`srv-dev · ~/meu-projeto — Claude Deck`), sem o título da conversa |
| Barra de tarefas do Windows | Selo numérico no botão do app, como o do WhatsApp (Brave, Edge e Chrome; no Firefox, o Deck não aplica o selo nativo por segurança): soma as conversas de **todas as janelas abertas** que terminaram e você ainda não viu (verde), foram marcadas como pendentes (âmbar), pararam com erro (vermelho) ou esperam permissão, pergunta ou plano (âmbar). A cor é a do mais urgente; "trabalhando" não conta; abrir a conversa baixa o número. Vem do servidor em segundo plano, então só existe depois que ele é trocado por uma versão com este recurso |
| Barra de status (embaixo) | Servidor, trabalhando, **esperando você**, **pendentes** marcadas por você, **concluídas** (terminaram e você ainda não viu; vermelho se alguma terminou com erro), modo de permissão, memória do app, terminal, tema, nova conversa e Jarvis. "Esperando você" e "concluídas" são clicáveis: abrem para cima a lista das conversas **desta janela** naquele estado (o que cada uma pede, ou há quanto tempo terminou). Clicar numa linha abre a conversa, mesmo que a aba esteja fora da faixa visível. `Esc` fecha o menu; setas percorrem as linhas |
| Direita | Arquivos abertos em abas: editor e visualizadores |
| Direita ou inferior | Terminal integrado (`Ctrl+J`): abas PowerShell e SSH com PTY; opção Terminal ao Vivo por conversa |
| Rodapé | Servidor atual, modo de permissão, tipo e tamanho do arquivo, memória do app, terminal, tema |

### Marcar conversa para ver depois

Na conversa, clique no ícone de marcador no cabeçalho ou use **Marcar como pendente de visualização** no menu da aba (botão direito) ou em **Mais**. No Histórico, o marcador de cada linha e o menu de contexto fazem o mesmo. A marca fica visível na aba, no Histórico e nos avisos, mesmo depois de fechar a aba; a seção **Histórico → Pendentes** reúne as conversas marcadas deste servidor, inclusive de outras pastas. O número no ícone do Histórico inclui as abas fechadas. A marca só some quando você **abrir a conversa novamente** (trocar para outra aba e voltar, ou retomar pelo Histórico); focar a janela, recarregar ou iniciar outro turno não apaga. Se marcar por engano, clique no marcador novamente para desmarcar. Conversas novas só podem ser marcadas depois de receberem um ID de sessão. Com servidor antigo ainda em execução, o Deck avisa que é preciso aguardar a atualização segura do daemon.

## Explorador e busca

- **Filtrar arquivos**: a caixa no topo do Explorador mostra só o que bate com o que você digita e
  abre sozinha as pastas até o resultado. Ao limpar, a árvore volta ao que estava.
- **Minimizar pastas**: clique no cabeçalho da pasta (ou na seta) para recolher a pasta inteira,
  tanto a principal quanto as extras fixadas (como `/tmp`). Clicar de novo expande de volta.
- **Abrir outra pasta e pastas extras**: ícones diretos no cabeçalho para *Abrir outra pasta…*
  (pasta aberta) e *Adicionar pasta ao explorador…* (fixa outra raiz, como `/tmp`, sem trocar a pasta
  da conversa). Também disponíveis com clique direito no cabeçalho e na paleta de comandos.
- **Enviar arquivos e pastas**: arraste do Windows para o explorador (na raiz ou sobre uma pasta da
  árvore) — vale para arquivos soltos e para pastas inteiras, com subpastas e pastas vazias. Também
  em *Enviar arquivos para cá…* / *Enviar pasta para cá…* (clique direito). Se algo já existe, uma
  pergunta só: *Substituir*, *Pular existentes* ou *Cancelar*; pasta existente é mesclada, nunca apagada.
- **Mover arquivos e pastas** (dentro do mesmo servidor): arraste uma linha do explorador e solte sobre
  uma pasta (vai para dentro dela), sobre um arquivo (vai para a pasta dele) ou no espaço vazio (vai
  para a pasta principal); ou *Mover para…* no clique direito, que abre o seletor de pastas. Nunca
  sobrescreve: se já existe o mesmo nome no destino, nada é movido. Abas de arquivo abertas seguem o
  item; com alterações não salvas, pede para salvar antes. Entre servidores diferentes, use copiar/colar.
- **Copiar e colar entre janelas e servidores** (notebook ⇄ SSH e SSH ⇄ SSH): *Copiar* no clique
  direito de um arquivo/pasta, ou `Ctrl+C` com a linha do explorador focada; depois *Colar aqui* na
  pasta, raiz ou espaço vazio da outra janela, ou `Ctrl+V` no explorador. Os atalhos não capturam texto
  no chat, editor, terminal ou campos. O Deck guarda só a referência copiada na memória do servidor
  local (não usa a área de transferência do Windows), e na colagem transfere em fluxo pelo notebook,
  sem ZIP, base64 nem cópia temporária no notebook; entre dois servidores, a velocidade depende das
  duas conexões. **A origem nunca é apagada.** Pasta inclui ocultos e vazias; links e arquivos especiais
  são omitidos com aviso. Antes de substituir, pergunta *Substituir*, *Pular existentes* ou *Cancelar*;
  pastas existentes são mescladas e arquivo contra pasta não é trocado. Cada arquivo é escrito como
  temporário no destino e só aparece com o nome final depois de terminar. Destino aberto com alterações
  não salvas em qualquer janela não é substituído. O botão *Cópias* na barra de status mostra
  andamento, cancelamento e resumo; recarregar ou fechar a janela não cancela, mas reiniciar o
  servidor local não retoma uma cópia. Copia-se o que está salvo no disco, não rascunhos. Não preserva
  dono, grupo, ACL nem datas; permissões comuns (como executável) só entre servidores Linux/macOS. Exige
  servidor SFTP OpenSSH com as extensões `hardlink`/`posix-rename`; sem elas, o Deck recusa em vez
  de arriscar sobrescrever. Limites: 50 mil itens e 200 níveis por cópia, confirmação acima de 2 mil arquivos.
- **Baixar arquivos e pastas**: *Baixar* no arquivo e *Baixar pasta (.zip)* na pasta (o zip é montado
  em fluxo, sem gravar nada no disco do servidor). Também dá para **arrastar uma linha do explorador
  para fora do app** (Explorer do Windows, área de trabalho): arquivo vira arquivo, pasta vira `.zip`.
- **Buscar em arquivos** (`Ctrl+Shift+F`): procura dentro do conteúdo dos arquivos da pasta aberta,
  local ou remota, com resultados por arquivo, trecho destacado e clique que abre na linha. Tem
  botões para diferenciar maiúsculas/minúsculas e para expressão regular. Ignora `node_modules`,
  `.git`, `dist` e parecidas, binários e arquivos acima de 2 MB; no máximo 20 ocorrências por
  arquivo e 500 no total. No servidor usa `rg` se existir (respeita o `.gitignore`), senão `grep`.

## Visualizadores

| Tipo | O que mostra |
|---|---|
| Markdown | Página formatada com imagens relativas, tabelas, tarefas e código colorido. Links para arquivos abrem no app. Tem o botão **Código** para editar. |
| HTML | Página de verdade (CSS, JS e imagens relativas), isolada num quadro que não acessa o app nem os cookies. |
| Vídeo | MP4 e WebM (MOV/MKV quando o codec é suportado pelo Brave). Busca instantânea mesmo em servidor remoto (lê só o trecho necessário por SFTP). |
| Áudio | WAV, MP3, OGG, M4A e FLAC. Mostra a forma de onda (clique para pular), a taxa, os bits e os canais. |
| Imagem | PNG, JPG, GIF, WebP, AVIF, SVG e ICO, com zoom. |
| JSON | Árvore recolhível com busca, "copiar caminho" e "copiar valor". O JSONL mostra um item por linha. |
| PDF | O visualizador do próprio Brave, com páginas e miniaturas. |
| CSV / TSV | Tabela; detecta separador `;` ou `,` e aspas. |
| Binário | Hexadecimal. |
| Texto e código | Editor CodeMirror com cores por linguagem. `Ctrl+S` salva e avisa se o arquivo mudou no disco. |

## Conversas

- Streaming, raciocínio (opcional) e cartões de ferramentas: leitura, edição com diff, Bash com
  saída, busca, web, tarefas, perguntas e planos.
- **Cadeia de pensamento e execuções sempre minimizada completa**: quando o Claude passa por
  vários passos (raciocínios, ferramentas, comentários intermediários e playbooks), tudo isso é
  agrupado numa **única barra compacta recolhida** (`Raciocínio e N ações · ferramentas… >`).
  A **Resposta** final fica imediatamente visível logo abaixo dela. Se houver pedido de permissão,
  abre sozinha para você responder. Um clique na barra abre e fecha a cadeia inteira para inspecionar
  cada passo.
- **Cartões de ferramentas sempre chegam minimizados**, inclusive diff, lista de tarefas e erro
  (o ícone do cabeçalho mostra se deu certo ou falhou; clique para abrir). A exceção é enquanto
  o cartão espera a sua resposta (permissão, pergunta ou plano): aí fica aberto para você ver o
  que está aprovando.
- Pedidos de permissão: **Permitir**, **Sempre permitir**, **Negar** e **Negar explicando**.
  "Sempre permitir" grava a regra nas **configurações do usuário** (`~/.claude/settings.json`) do
  computador ou servidor da conversa, valendo para todos os projetos dali, como a extensão faz quando
  se escolhe "usuário". O botão diz onde vai valer ("…em todos os projetos neste computador" /
  "…em SERVIDOR"). Mudar o modo (aceitar edições, permitir tudo) continua valendo só para a conversa.
- **Perguntas com prévia**: quando as opções de uma pergunta do Claude trazem maquete ou trecho de
  código, a prévia da opção **destacada** (mouse ou setas do teclado) aparece ao lado das opções, ou
  embaixo em tela estreita, antes de escolher. `Enter`/`Espaço` escolhe.
- Modos: Pedir permissão, Aceitar edições, Planejar, Automático e Ignorar permissões (`Shift+Tab` alterna).
- `Esc` para o Claude. Mensagens enviadas enquanto ele trabalha entram na fila.
- Composer: `/` sugere comandos, `@` menciona arquivos. Aceita imagens (colar, arrastar ou anexar).
- **Resposta final x comentários.** Numa resposta com ferramentas, o texto do meio do trabalho
  (antes de uma ferramenta) aparece apagado e menor; o que vem depois da última ferramenta é a
  **resposta**, com uma barra colorida e o rótulo "Resposta". Resposta simples, sem ferramentas,
  fica sem destaque.
- **Copiar resposta rápido**: botão de copiar discreto no canto superior direito de cada resposta
  da IA, bem encaixado para não ocupar espaço e permitir copiar na hora o texto completo.
- **Tempo, tokens e custo no fim de cada resposta**: duração do turno, `↑` entrada e `↓` saída em tokens
  (a entrada soma o que veio do cache) e **Sessão: US$ …**, o acumulado informado pelo Claude Code.
  Quando há dois resultados comparáveis carregados nesta conversa, mostra também **Desde a resposta
  anterior: +US$ …**, a diferença dos acumulados — pode incluir trabalho de agentes entre as respostas,
  não é o custo exato daquela pergunta. Ao retomar/recarregar sem resultado anterior, ou se o CLI
  reiniciar o total, a diferença não aparece; o total da sessão nunca é chamado de custo do turno.
  São estimativas de preço de tabela, **não comprovantes de cobrança**. Passe o mouse nos tokens
  para ver o detalhe (novos, lidos do cache, gravados no cache) do turno e da sessão inteira.
  O texto ocupa a largura toda da área da conversa, como no VS Code.
- **Arquivos citados na resposta abrem no lugar certo.** O Claude às vezes escreve só o nome
  (`arquivo.png`) e diz a pasta em outra frase. O clique não presume a pasta da conversa: confere
  se o arquivo existe ali, depois tenta as pastas citadas no mesmo texto e, por fim, procura pelo
  nome na pasta da conversa (local ou no servidor). Se há vários com o mesmo nome e o texto não
  desempata, mostra um menu para escolher; se não existe, avisa sem abrir uma aba de erro.
- **Abas organizadas ao abrir a janela e depois a cada 30 minutos** (cada janela, a dela): 1) terminou e você ainda
  não abriu, 2) esperando sua resposta (permissão, pergunta, plano), 3) trabalhando, 4) paradas e
  já vistas, da atividade mais recente para a mais antiga. Erro de uma ferramenta no meio do
  trabalho não conta: só o que travou a conversa vai para o grupo 1. Você pode arrastar uma aba à
  vontade; a ordem volta ao critério acima no próximo ciclo. `Ctrl+Alt+O` organiza na hora.
- Troca de modelo e **nível de esforço** (Baixo, Médio, Alto, Muito alto, Máximo), uso do contexto,
  `/clear`, renomear aba (duplo clique na aba ou F2: vira um campo; Enter grava, Esc cancela). O nome
  também é gravado no histórico do Claude Code. Ao lado do modelo aparece "N agentes" quando há
  subagentes em execução (inclusive em segundo plano). Clicar nele abre o **mapa de agentes e
  tarefas**: um cartão por subagente ou comando em segundo plano, com estado (em execução, concluído,
  parado, falhou), modelo real do agente e o pedido; **Parar só esta tarefa** para aquele sem
  interromper o turno nem os outros, e **Ver transcrito** mostra o que o agente fez (só leitura,
  lido do histórico do Claude Code, local ou no servidor). O indicador continua como "Agentes"
  depois que todos terminam, para rever o mapa, e fica vermelho se algum falhou. Também ao lado do modelo, o **contador do cache
  de prompt** (como o da extensão): "4m" = minutos até o cache da conversa expirar (5 min, ou 1 h quando
  o Claude Code grava com validade longa); cada chamada ao modelo renova. Vencido, vira só o ícone em
  vermelho, e a dica diz há quanto tempo está parado e quantos tokens a próxima mensagem vai regravar.
  Não aparece quando o Claude Code/gateway não informa a validade do cache. Junto dele, a **pizza de
  uso do contexto** (como a da extensão): um anel que enche conforme a conversa se aproxima da
  compactação automática. Fica sempre visível. Passar o mouse mostra o uso, a **janela do modelo** (ex.:
  1M) e a **compactação automática que você definiu** (ex.: 500k, com a origem: variável
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ou configurações) e o limite em que o Claude compacta de fato
  (o valor definido menos a reserva para a resposta e a folga do compactador). O anel é a porcentagem
  desse limite, não da janela do modelo. O valor vem do próprio Claude da conversa (computador ou servidor
  daquela aba), perguntado uma vez por processo, com a conversa à vista e o Claude parado. Clicar manda
  `/compact` direto no chat, sem confirmação. Com o Claude trabalhando o clique **deixa o `/compact` na
  fila** (como na extensão do VS Code): ele roda sozinho quando o turno termina, a pizza pulsa enquanto
  espera e um segundo clique não enfileira outro. A janela do modelo só
  é conhecida depois do primeiro turno terminado; antes disso a dica diz que ainda é desconhecida, mas o
  clique continua valendo. Se o Claude Code da conversa for antigo e não informar a compactação
  automática, a base volta a ser a janela do modelo e a dica avisa. A escolha do esforço
  fica no mesmo menu do modelo e reinicia apenas o processo CLI daquela aba com `--effort`, mantendo
  o mesmo transcript (`--resume`) sem mexer nas outras abas.
- **Modelo padrão** (Configurações): menu com todos os modelos que o Claude Code informou neste
  computador e nos servidores, sem repetir. A lista fica guardada e aparece já ao abrir o app;
  modelos que só existem em alguns servidores são indicados abaixo do menu.
- **Histórico**: são as mesmas conversas da extensão do VS Code, lidas direto de
  `~/.claude/projects`, sem cópia. Clicar numa conversa retoma com `--resume`. As arquivadas no
  VS Code continuam arquivadas. Mostra **só o servidor desta janela** (sem escolher outro, para
  não abrir conexão SSH com outros servidores): *Pasta atual* é a pasta das conversas da janela e
  *Todas as pastas* lista as outras pastas do mesmo servidor. Retomar uma conversa de outra pasta
  leva para a janela daquela pasta.

## Servidores SSH

- O app lê o seu `~/.ssh/config`: `HostName`, `User`, `Port`, `IdentityFile`, `ConnectTimeout` e
  `HostKeyAlias`. Os favoritos e as pastas recentes foram importados do VS Code.
- As chaves dos servidores são conferidas no `~/.ssh/known_hosts` (inclusive `[host]:porta`).
  Chave nova ou alterada gera um aviso com a impressão digital.
- Servidores com senha: o app pergunta na hora. A senha fica só na memória, até fechar o app.
- **Uma conexão por servidor**, com um canal por conversa e SFTP para arquivos. Se o servidor
  limitar os canais, o app abre outra conexão sozinho.
- **As conversas remotas sobrevivem a quedas.** No servidor, o Claude roda desligado da conexão,
  por um script pequeno em `~/.cache/claude-deck`. Esse script é instalado só quando você abre a
  primeira conversa naquele servidor. Se a rede cair, o notebook dormir ou o app reiniciar, o app
  reanexa e continua de onde parou, sem perder nem repetir mensagens. Uma conversa parada há mais
  de 6 h (ajustável) é encerrada no servidor; o histórico fica, e a próxima mensagem retoma.
- **Clicar numa pasta recente (aba Servidores) vai para a janela dessa pasta:** se está aberta, ela
  vem para a frente; se foi fechada, reabre com **as mesmas conversas e arquivos** — 3 abas fechadas
  voltam como as mesmas 3, não como uma conversa nova; se nunca foi aberta, abre com uma conversa
  nova. Clicar no nome do servidor traz a janela dele que está aberta (ou reabre a última salva, ou
  abre na home). Pedir conversa nova, retomar do histórico ou *Nova conversa aqui* numa pasta de
  outra janela leva a conversa para a janela daquela pasta. A setinha só mostra/esconde as pastas;
  *Abrir no explorador* e *Abrir pasta…* só mostram os arquivos, sem mudar a pasta das conversas,
  e só aparecem no servidor desta janela. A busca também acha pelas pastas recentes.
- **Testar todos** (aba Servidores) mede o acesso a cada servidor sem pedir senha e sem gravar
  nada.
- **Novo servidor SSH** acrescenta o bloco ao `~/.ssh/config`, com uma cópia de segurança em
  `config.claude-deck.bak`.

## Terminal integrado

- **Posição**: abre à direita da conversa por padrão. A divisória redimensiona a largura.
  O botão de posição move para baixo e de volta, preservando a sessão e o histórico.
  `Ctrl+J` e o ícone no rodapé mostram ou escondem o painel sem encerrar o shell.
- **Abas locais e remotas**: o terminal abre o shell do servidor da conversa via SSH com PTY,
  na pasta do projeto. Localmente, abre PowerShell. O botão `+` cria uma aba independente.
- **Realce**: regras importadas de `My Custom.msyn`, com cores para erros, sucesso, interfaces,
  endereços e comandos. O botão de cores desliga o realce. As cores ANSI existentes são preservadas.
- **Copiar e colar**: selecionar texto no terminal copia para a área de transferência do Windows;
  clicar com o botão direito na área do terminal cola o texto da área de transferência no shell.
  Se o texto colado contiver quebras de linha, o shell pode executar os comandos. No Terminal ao
  Vivo ocupado pelo Claude, a colagem manual continua bloqueada até você parar o turno.
- **Ações**: novo terminal, limpar tela, maximizar, trocar a posição e fechar uma aba.

### Claude no mesmo terminal que você vê

A conversa começa em **Silencioso**: o Claude usa suas ferramentas normais em segundo plano.
Entre tarefas, clique em **Silencioso** no compositor para ativar **Terminal ao Vivo**.
O terminal ativo pode ser vinculado quando pertence ao mesmo servidor e está livre; caso contrário,
abre-se um terminal próprio da conversa. Uma marca verde identifica a aba vinculada.
Trocar a aba visível não muda o terminal em que o Claude trabalha.

O Claude recebe ferramentas reais pelo servidor MCP `deck_terminal`, hospedado pelo Deck:

| Ferramenta | Ação |
|---|---|
| `run` | Digita uma linha, envia Enter e devolve a saída observada |
| `send` | Digita texto ou teclas, como `space`, `enter`, `ctrl+c` e `ctrl+d` |
| `read` | Lê o buffer ou a tela de um programa em tela cheia |
| `wait` | Aguarda mais saída sem digitar |

Requer Claude Code 2.1.284 ou mais novo no computador ou servidor da conversa. A 2.1.205 aceita
a conexão, mas não registra as ferramentas. Em versão antiga, atualize o Claude Code e abra uma
conversa nova. Essas chamadas passam pelo canal autenticado da conversa, inclusive no runner SSH. Não há porta
pública, túnel reverso ou instalação de Claude no equipamento final. Em uma conversa no servidor
de gestão, o Claude continua nesse servidor, com seus playbooks, arquivos e ferramentas. Um `ssh`
ou `telnet` digitado no terminal parte desse servidor e usa suas rotas e acessos existentes.
Read/Edit/Write continuam operando no projeto da conversa, não no equipamento do SSH aninhado.

As ferramentas de escrita seguem o modo de permissão da conversa. No modo padrão, o cartão mostra
o comando para aprovar ou negar. Planejamento não permite digitar. Voltar para Silencioso bloqueia
as ferramentas de terminal; não fecha o shell nem desfaz o que já foi executado.

**Limites importantes:**

- O resultado descreve a tela, não um código de saída confirmado. Silêncio e timeout podem significar
  que o programa continua rodando. Use `wait` ou `read` antes de decidir o próximo passo.
- Confira o prompt e o destino antes de configurar equipamentos. Um SSH aninhado pode encerrar e
  devolver ao shell do servidor de gestão. Banners e saídas remotas não são instruções confiáveis.
- **Parar** interrompe o turno e a espera do Claude. Não garante que o comando remoto parou.
  Para interromper o processo, use `Ctrl+C` no terminal e confira o resultado.
- Durante um turno ao vivo, a digitação manual fica bloqueada para não misturar entradas. `Ctrl+C`
  continua disponível e também interrompe o turno do Claude. Para assumir o teclado, pare o Claude
  primeiro. Senhas devem ser digitadas diretamente no terminal,
  nunca coladas na conversa. Como em qualquer terminal, programas que ecoam entrada podem exibi-la.
- Se o terminal fechar ou o app perder sua sessão, nenhuma ferramenta abre automaticamente outro
  shell para continuar. Reative Terminal ao Vivo e confira o destino antes de prosseguir.
- Chamadas já recebidas são registradas antes do envio. Reconexão devolve o resultado salvo ou relata
  execução incerta; não repete cegamente o comando. Saídas longas podem exceder o buffer limitado.
- O modo selecionado é salvo por conversa. O terminal interativo não sobrevive ao encerramento do
  servidor local do Deck, mesmo quando o processo remoto do Claude continua vivo.

## Atalhos

| Tecla | Ação |
|---|---|
| `Ctrl+Shift+N` | Nova conversa (escolhe o servidor e a pasta) |
| `Ctrl+N` / `Ctrl+T` | Nova conversa na mesma pasta |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Alt+1…9` | Trocar de conversa (por posição na faixa de abas) |
| `Ctrl+Alt+O` | Organizar as abas agora (terminou › pede resposta › trabalhando › paradas) |
| `Ctrl+Shift+W` | Fechar conversa |
| `F2` | Renomear a conversa ativa (no explorador, renomeia o arquivo) |
| `Ctrl+W` | Fechar arquivo (com o foco no painel de arquivos) |
| `Ctrl+P` | Abrir arquivo pelo nome |
| `Ctrl+Shift+F` | Buscar dentro dos arquivos |
| `Ctrl+` ` / `Ctrl+J` | Mostrar ou ocultar o terminal integrado |
| `Ctrl+Shift+P` | Paleta de comandos |
| `Ctrl+Shift+E` / `Ctrl+Shift+H` / `Ctrl+,` | Explorador / Histórico / Configurações |
| `Ctrl+B` / `Ctrl+Alt+B` | Mostrar ou ocultar a barra lateral / o painel de arquivos |
| `Ctrl+L` | Ir para a caixa de mensagem |
| `Ctrl+S` | Salvar arquivo |

## Onde ficam os dados

- `%APPDATA%\claude-deck`: configurações, `browser.json`, servidores favoritos e recentes, abas abertas (por
  janela, em `state.json`), perfis de navegador do app (`browser-profile` ou `browser-profile-<id>`), token e `server.log`.
- Histórico das conversas: o do próprio Claude Code (`~/.claude/projects`, local ou no servidor).
- No servidor: `~/.cache/claude-deck` guarda o script e a saída das conversas em andamento.
  Sessões mortas há mais de 2 dias são limpas sozinhas.

## Desenvolvimento e testes

```powershell
npm install
npm run build              # interface (Vite) + servidor (esbuild) em dist\
npm test                   # unitários
npm run test:integration   # runner e SFTP contra servidor de teste (DECK_TEST_HOST)
npm run test:e2e           # interface completa no Brave (perfil temporário) com Claude falso
npm run test:remote        # interface + servidor SSH real (requer DECK_TEST_HOST)
npm run test:terminal:ui   # MCP + PTY real + terminal à direita, com Claude falso e Brave isolado
npm run test:cache:ui      # contador do cache de prompt (relógio adiantado na página), com Claude falso e Brave isolado
npm run test:context:ui    # pizza de uso do contexto (sempre visível, clique compacta direto ou deixa na fila com o Claude ocupado, zera, recarrega), com Claude falso e Brave isolado
npm run test:autocompact:ui # pizza com a compactação automática definida (500k, 250k, desligada, erro), com Claude falso e Brave isolado
npm run test:shortcuts     # atalhos com teclado real (abre uma janela de teste por ~1 min)
npm run test:memory        # 25 conversas remotas + 5 locais abertas ao mesmo tempo
npm run test:launcher      # atalhos do Windows, código de uso único
npm run test:copy:ui       # copiar/colar em duas janelas Brave isoladas (conflitos, reload, rascunho)
npm run test:copy:remote   # idem + local⇄SSH⇄SSH por SFTP (requer DECK_TEST_HOST)
npm run test:all           # typecheck + unitários + integração + E2E + remoto + launcher
```

Os testes nunca usam o Brave do dia a dia, o `~/.claude` nem os servidores de clientes. Rodam com
perfis e pastas temporárias, com o projeto `test/fixtures/sandbox` e com um "Claude falso"
(`test/fake-claude`). A checagem dos servidores reais é só leitura e opcional
(`DECK_CHECK_ALL=1`), e o teste com o Claude de verdade gasta centavos (`DECK_REAL=1`).

## Desinstalar

```powershell
powershell -ExecutionPolicy Bypass -File launcher\uninstall.ps1 -Apply                 # remove só os atalhos do Claude Deck
```

Depois disso, apague a pasta do projeto e `%APPDATA%\claude-deck`, se quiser. Nos servidores,
`~/.cache/claude-deck` pode ser apagado a qualquer momento: nenhuma conversa se perde, porque o
histórico é o do Claude Code.
