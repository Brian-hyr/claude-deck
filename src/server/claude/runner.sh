#!/bin/sh
# Claude Deck — executor remoto (runner).
# Mantém o Claude Code rodando destacado da conexão SSH: se a rede cair ou o notebook
# dormir, a conversa continua no servidor e o app reanexa depois pelo deslocamento (offset).
# Só é copiado para o servidor quando uma conversa é iniciada nele (~/.cache/claude-deck).
#
# Arquivos por sessão em ~/.cache/claude-deck/s/<id>/:
#   in   FIFO de entrada (o wrapper guarda uma ponta de escrita aberta: nunca recebe EOF)
#   out  saída NDJSON do Claude (só cresce; o app lê a partir de um offset)
#   err  stderr do Claude
#   pid  PID do Claude   st  instante de início do processo (contra reuso de PID)
#   exit código de saída   hb  batimento do app (mtime)   cwd  pasta   bin  binário
#
# Uso:
#   runner.sh start  <id> <cwd_b64> <auto|bin_b64> <args_b64> <idle_s>
#       -> "OK <pid> <offset>" (novo) | "ALIVE <pid> <tamanho>" (já estava rodando) | "ERR <motivo>"
#   runner.sh attach <id> <offset>
#   runner.sh stop   <id>
#   runner.sh status <id>
#   runner.sh list | bins | gc

R="$HOME/.cache/claude-deck"
umask 077

valid_id() {
  case "$1" in
    ''|*[!A-Za-z0-9-]*) echo "ERR badid"; exit 2 ;;
  esac
}

fsize() { wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0; }
fmtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# Instante de início do processo (Linux); vazio em sistemas sem /proc.
pstart() { [ -r "/proc/$1/stat" ] && sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }

# O processo da sessão está vivo? (confere o instante de início contra PID reutilizado)
alive() {
  P=$(cat "$1/pid" 2>/dev/null)
  [ -n "$P" ] || return 1
  kill -0 "$P" 2>/dev/null || return 1
  if [ -s "$1/st" ] && [ -r "/proc/$P/stat" ]; then
    [ "$(pstart "$P")" = "$(cat "$1/st")" ] || return 1
  fi
  return 0
}

# Sinal para um grupo de processos inteiro. Cada sh aceita uma grafia (o dash não aceita
# "kill -TERM -- -G", o busybox antigo não aceita "-s ... --"): tenta as duas.
killgrp() { kill -s "$1" -- "-$2" 2>/dev/null || kill "-$1" "-$2" 2>/dev/null; }

# Roda desligado do terminal/conexão (nova sessão de processos), SUBSTITUINDO o processo atual.
# Chamar só dentro de um subshell em segundo plano que já trocou a entrada/saída por /dev/null.
detach() {
  if command -v setsid >/dev/null 2>&1; then
    exec setsid "$@"
  elif command -v perl >/dev/null 2>&1; then
    exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' "$@"
  else
    exec nohup "$@"
  fi
}

version_of() {
  case "$1" in
    */anthropic.claude-code-*/resources/native-binary/claude)
      v=${1#*/anthropic.claude-code-}; v=${v%%/*}; v=${v%%-linux*}; v=${v%%-darwin*}; echo "$v" ;;
    *) "$1" --version </dev/null 2>/dev/null | head -1 | sed 's/[^0-9.].*$//' ;;
  esac
}

bins() {
  {
    command -v claude 2>/dev/null
    for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" \
             "$HOME/bin/claude" /usr/local/bin/claude /usr/bin/claude /opt/homebrew/bin/claude; do
      echo "$c"
    done
    ls -d "$HOME"/.nvm/versions/node/*/bin/claude 2>/dev/null
    ls -d "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null
    ls -d "$HOME"/.cursor-server/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null
  } | while IFS= read -r c; do
    [ -n "$c" ] && [ -x "$c" ] && [ ! -d "$c" ] || continue
    real=$(readlink -f "$c" 2>/dev/null || echo "$c")
    printf '%s\t%s\t%s\n' "$real" "$(version_of "$c")" "$c"
  done | awk -F '\t' '!seen[$1]++ { print $2 "\t" $3 }'
}

find_claude() {
  bins | sort -t "$(printf '\t')" -k1,1V | tail -1 | cut -f2
}

forward() {
  # Repassa só linhas COMPLETAS: uma linha JSON cortada por queda de rede
  # derrubaria o Claude (ele encerra ao receber JSON inválido).
  if command -v perl >/dev/null 2>&1; then
    perl -e '$|=1; while (defined(my $l = <STDIN>)) { print $l if substr($l, -1) eq "\n" }'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -u -c 'import sys
r = sys.stdin.buffer
w = sys.stdout.buffer
while True:
    l = r.readline()
    if not l:
        break
    if l.endswith(b"\n"):
        w.write(l)
        w.flush()'
  else
    while IFS= read -r l; do printf '%s\n' "$l"; done
  fi
}

cmd=$1
[ -n "$cmd" ] && shift

case "$cmd" in
  start)
    id=$1; valid_id "$id"; D="$R/s/$id"
    cwd=$(printf '%s' "$2" | base64 -d 2>/dev/null) || { echo "ERR badcwd"; exit 2; }
    if [ "$3" = auto ]; then
      bin=$(find_claude)
    else
      bin=$(printf '%s' "$3" | base64 -d 2>/dev/null) || { echo "ERR badbin"; exit 2; }
    fi
    args=$(printf '%s' "$4" | base64 -d 2>/dev/null) || { echo "ERR badargs"; exit 2; }
    idle=${5:-21600}
    case "$idle" in ''|*[!0-9]*) idle=21600 ;; esac
    # Nunca dois processos na mesma conversa: se o anterior segue vivo, o app só reanexa.
    if [ -d "$D" ] && alive "$D"; then echo "ALIVE $(cat "$D/pid") $(fsize "$D/out")"; exit 0; fi
    if [ -z "$bin" ] || [ ! -x "$bin" ]; then echo "ERR noclaude"; exit 4; fi
    cd "$cwd" 2>/dev/null || { echo "ERR nocwd"; exit 3; }
    mkdir -p "$D" || { echo "ERR mkdir"; exit 5; }
    rm -f "$D/in" "$D/pid" "$D/st" "$D/exit"
    mkfifo "$D/in" || { echo "ERR mkfifo"; exit 5; }
    : >> "$D/out"; : >> "$D/err"
    size=$(fsize "$D/out")
    printf '%s\n' "$cwd" > "$D/cwd"
    printf '%s\n' "$bin" > "$D/bin"
    touch "$D/hb"
    set -f  # argumentos como "modelo[1m]" não podem virar nomes de arquivo
    # O "exec" sem comando troca a entrada/saída de vez. Redirecionar na chamada da função
    # (detach ... >/dev/null &) faria o sh guardar cópias do stdout/stderr originais: o canal
    # SSH ficaria aberto até o Claude terminar e o "start" nunca voltaria.
    # shellcheck disable=SC2086
    ( exec </dev/null >/dev/null 2>&1; detach sh "$0" _wrap "$D" "$idle" "$bin" $args ) &
    set +f
    i=0
    while [ ! -s "$D/pid" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
    if [ -s "$D/pid" ]; then echo "OK $(cat "$D/pid") $size"; else echo "ERR nostart"; exit 6; fi
    ;;

  _wrap)
    # Interno: roda em sessão própria, segura o FIFO aberto e espera o Claude terminar.
    D=$1; idle=$2; shift 2
    exec 3<>"$D/in"
    CLAUDE_CODE_ENTRYPOINT=cli "$@" <"$D/in" >>"$D/out" 2>>"$D/err" 3>&- &
    P=$!
    S=$(pstart "$P")
    printf '%s\n' "$S" > "$D/st"
    echo "$P" > "$D/pid"
    # Vigia de inatividade. Antes de agir confere que a conversa ainda existe e que o processo é
    # o MESMO (PID não reutilizado por outro programa); sai sozinho quando o Claude termina.
    (
      while :; do
        sleep 60
        [ -d "$D" ] || exit 0
        kill -0 "$P" 2>/dev/null || exit 0
        if [ -n "$S" ] && [ "$(pstart "$P")" != "$S" ]; then exit 0; fi
        now=$(date +%s)
        o=$(fmtime "$D/out")
        h=$(fmtime "$D/hb")
        [ "$o" -gt "$h" ] && h=$o
        if [ $((now - h)) -gt "$idle" ]; then
          echo '{"type":"deck_runner","event":"idle_kill"}' >> "$D/out"
          kill -TERM "$P" 2>/dev/null
          exit 0
        fi
      done
    ) </dev/null >/dev/null 2>&1 3>&- &
    V=$!
    wait "$P"
    code=$?
    kill "$V" 2>/dev/null
    echo "$code" > "$D/exit"
    ;;

  attach)
    id=$1; valid_id "$id"; D="$R/s/$id"
    off=${2:-0}
    case "$off" in ''|*[!0-9]*) off=0 ;; esac
    if [ ! -d "$D" ]; then echo '{"type":"deck_runner","event":"missing"}'; exit 0; fi
    touch "$D/hb"
    exec 4<>"$D/in"
    ( while :; do sleep 30; touch "$D/hb"; done ) </dev/null >/dev/null 2>&1 &
    (
      if alive "$D"; then
        P=$(cat "$D/pid")
        if tail --version 2>/dev/null | grep -q GNU; then
          tail -c +$((off + 1)) --pid="$P" -f "$D/out"
        else
          tail -c +$((off + 1)) -f "$D/out" &
          T=$!
          while kill -0 "$P" 2>/dev/null; do sleep 1; done
          sleep 2
          kill "$T" 2>/dev/null
        fi
      else
        tail -c +$((off + 1)) "$D/out"
      fi
      i=0
      while [ ! -s "$D/exit" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
      code=$(cat "$D/exit" 2>/dev/null)
      case "$code" in ''|*[!0-9]*) code=-1 ;; esac
      printf '{"type":"deck_runner","event":"exit","code":%s}\n' "$code"
      kill 0
    ) </dev/null &
    forward >&4
    kill 0
    ;;

  stop)
    id=$1; valid_id "$id"; D="$R/s/$id"
    if [ -d "$D" ] && alive "$D"; then
      P=$(cat "$D/pid")
      # O wrapper roda em sessão própria (setsid) e é o líder do grupo: o grupo inteiro (Claude,
      # ferramentas que ele abriu, vigia de inatividade) sai junto. Só vale se o grupo do Claude
      # for mesmo o do wrapper (pai dele) e nunca o nosso; senão (fallback sem setsid), só o PID.
      G=$(sed 's/^.*) //' "/proc/$P/stat" 2>/dev/null | cut -d' ' -f3)
      W=$(sed 's/^.*) //' "/proc/$P/stat" 2>/dev/null | cut -d' ' -f2)
      ME=$(sed 's/^.*) //' "/proc/$$/stat" 2>/dev/null | cut -d' ' -f3)
      grp=
      if [ -n "$G" ] && [ "$G" = "$W" ] && [ "$G" != "$ME" ] && [ "$G" -gt 1 ] 2>/dev/null; then grp=$G; fi
      if [ -n "$grp" ]; then
        killgrp TERM "$grp" || kill -TERM "$P" 2>/dev/null
      else
        kill -TERM "$P" 2>/dev/null
      fi
      i=0
      while kill -0 "$P" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
      kill -KILL "$P" 2>/dev/null
      # Quem ignorou o TERM (ferramenta presa) sai à força.
      if [ -n "$grp" ] && killgrp 0 "$grp"; then killgrp KILL "$grp"; fi
    fi
    rm -rf "$D"
    echo OK
    ;;

  status)
    id=$1; valid_id "$id"; D="$R/s/$id"
    if [ ! -d "$D" ]; then echo '{"exists":false}'; exit 0; fi
    a=false
    alive "$D" && a=true
    code=$(cat "$D/exit" 2>/dev/null); case "$code" in ''|*[!0-9]*) code=null ;; esac
    printf '{"exists":true,"alive":%s,"pid":%s,"exit":%s,"size":%s}\n' "$a" "$(cat "$D/pid" 2>/dev/null || echo 0)" "$code" "$(fsize "$D/out")"
    ;;

  list)
    [ -d "$R/s" ] || exit 0
    for D in "$R"/s/*; do
      [ -d "$D" ] || continue
      a=0
      alive "$D" && a=1
      printf '%s\t%s\t%s\t%s\n' "${D##*/}" "$a" "$(fmtime "$D/out")" "$(cat "$D/cwd" 2>/dev/null)"
    done
    ;;

  bins)
    bins
    ;;

  gc)
    # Remove sessões mortas há mais de 2 dias.
    [ -d "$R/s" ] || { echo OK; exit 0; }
    now=$(date +%s)
    for D in "$R"/s/*; do
      [ -d "$D" ] || continue
      alive "$D" && continue
      m=$(fmtime "$D/out")
      [ $((now - m)) -gt 172800 ] && rm -rf "$D"
    done
    echo OK
    ;;

  *)
    echo "ERR usage"; exit 2 ;;
esac
