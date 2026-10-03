# Por que o Claude Deck? (Vantagens em Relação ao VS Code + Extensão)

O **Claude Deck** foi projetado para resolver os problemas reais de quem usa o **Claude Code** intensivamente no dia a dia, tanto no computador local quanto em múltiplos servidores SSH remotos.

Abaixo está o comparativo técnico detalhado das vantagens do Claude Deck em relação ao uso do VS Code com a extensão do Claude Code.

---

## 1. Comparativo Direto

| Critério | VS Code + Extensão Claude | Claude Deck |
| :--- | :--- | :--- |
| **Consumo de Memória (RAM local)** | **800 MB a 2+ GB** (Electron + processos auxiliares) | **~60 MB** (daemon Node) + janela leve do navegador |
| **Gasto em repouso / desligado** | Continua consumindo enquanto aberto | **0 MB** (servidor desligado quando não em uso) |
| **Impacto no Servidor SSH** | **Pesado** (~200–500 MB com VS Code Server em `~/.vscode-server`) | **Praticamente zero** (apenas runner `sh` minúsculo de poucos KB) |
| **Risco de OOM em VPSs remotas** | Alto em servidores de 1 GB ou 2 GB de RAM | Inexistente (não sobe runtime de IDE remota) |
| **Queda de Rede / Suspensão do PC** | Janela congela ("Reconnecting..."), perde estado | **Resiliente**: Claude continua rodando no servidor; reconecta por offset de bytes |
| **Multi-Janelas e Projetos** | Janelas duplicadas da mesma pasta disputam lock | **1 janela por servidor + pasta**: foca janela existente, nunca duplica |
| **Restauração de Sessões** | Foco na última pasta aberta | **Restaura todas as janelas e abas** que estavam abertas ao ligar o PC |
| **Terminal ao Vivo + Interação MCP** | Terminal e IA desacoplados em abas separadas | **Terminal ao Vivo nativo lado a lado**, com MCP interativo em tempo real |
| **Agilidade no Terminal** | Atalhos tradicionais de IDE | **Auto-cópia ao selecionar texto** e **colar com botão direito** |
| **Controle de Contexto e `/compact`** | Nativo na extensão da IDE | **Mesma paridade visual**, mas sem a sobrecarga de memória da IDE |
| **Compatibilidade de Histórico** | Padrão Claude Code | **100% idêntico**: lê e grava em `~/.claude/projects` |

---

## 2. Detalhamento Técnico das Vantagens

### ⚡ 1. Consumo de Memória Drasticamente Menor (Leveza Extrema)
- **O problema no VS Code:** Sendo uma aplicação Electron completa, o VS Code precisa gerenciar renderização Chromium pesada, o processo do Extension Host, Language Server Protocols (LSP), watchers de disco e telemetria. Manter 2 ou 3 janelas do VS Code abertas consome facilmente entre **2 GB e 4 GB de RAM**, aquecendo a máquina e esgotando a bateria de notebooks.
- **A solução no Claude Deck:** O daemon Node em background consome **apenas ~60 MB de memória**. A interface foi construída em **Preact** com **signals reativos** (sem o overhead do React completo ou de um DOM de IDE inteira) e roda em uma janela dedicada (`--app`) do seu próprio navegador instalado (Brave, Edge, Chrome ou Firefox). O app abre em menos de 1 segundo.

### 🌐 2. Zero Sobrecarga em Servidores SSH Remotos
- **O problema no VS Code:** A extensão Remote-SSH do VS Code baixa e instala uma instância do Node.js e do VS Code Server dentro de `~/.vscode-server` em cada máquina remota. Em servidores de produção modestos ou VPSs com 1 GB ou 2 GB de RAM, isso frequentemente dispara o OOM Killer (Out Of Memory), travando processos críticos do servidor.
- **A solução no Claude Deck:** O Deck **não instala nada pesado no servidor remoto**. Ele utiliza apenas o CLI oficial do `claude` já presente na máquina e instala sob demanda um runner minúsculo (`runner.sh`) escrito em **POSIX shell puro (`sh`)** em `~/.cache/claude-deck`. Todo o processamento visual e gerenciamento de estado acontecem na máquina cliente (no seu PC).

### 🛡️ 3. Resiliência Total a Quedas de Rede e Suspensão
- **O problema no VS Code:** Se a sua conexão Wi-Fi/VPN oscilar ou se você fechar a tampa do notebook, o VS Code perde a conexão SSH, interrompe terminais e frequentemente trava com telas de reconexão ou perda de histórico da conversa.
- **A solução no Claude Deck:** O runner remoto desvincula o processo do Claude da conexão SSH ativa. Se você perder a internet ou o computador suspender, **o Claude continua trabalhando no servidor**. Ao reabrir a conexão, o Deck reanexa ao processo usando offsets de bytes exatos no stream NDJSON. Você nunca perde respostas longas, ferramentas em execução ou perguntas pendentes.

### 🗂️ 4. Organização Estruturada ("Uma Janela por Contexto")
- **Regra de ouro:** Cada janela do Claude Deck representa exatamente **um servidor e uma pasta de trabalho**.
- Se você clicar no atalho ou tentar abrir uma pasta que já possui janela aberta, o sistema traz a janela existente para a frente (inclusive se estiver minimizada), evitando confusão mental e múltiplas instâncias concorrendo pelos mesmos arquivos.
- Ao reiniciar o computador, o Claude Deck reabre **todas as janelas e abas ativas** exatamente como foram deixadas.

### 💻 5. Terminal ao Vivo com Ferramentas MCP Integradas
- O Claude Deck possui uma aba de terminal interativo lado a lado com a conversa.
- O modo **Terminal ao Vivo** expõe ferramentas MCP seguras que permitem ao Claude interagir diretamente com o shell da máquina, sessões SSH aninhadas, ou CLIs de equipamentos e serviços de rede, enquanto você assiste à execução na tela em tempo real.
- Suporta **cópia instantânea ao selecionar com o mouse** e **colagem imediata com o clique direito**, acelerando o fluxo de trabalho diário.

### 📊 6. Paridade Completa de Contexto e Compactação
- O Claude Deck reproduz fielmente a "pizza" de uso de contexto e a compactação com 1 clique da extensão oficial, mostrando a porcentagem consumida e o threshold de auto-compactação.
- Oferece a mesma conveniência e tranquilidade visual da extensão, mas em uma interface enxuta que não disputa recursos com seu trabalho.

### 🔄 7. Compatibilidade Total e Sem Lock-in
- O Claude Deck não inventa formatos proprietários: ele lê e grava nos arquivos JSONL padrão do Claude Code em `~/.claude/projects`.
- Seus logins, configurações, permissões, skills, MCPs e instruções do `CLAUDE.md` continuam sendo exatamente os mesmos da sua instalação oficial do CLI e do VS Code.
