#!/bin/sh
# Limpa o que os testes deixaram no servidor de teste: conversas do runner cujo cwd começa com o
# prefixo dado (usa o "stop" do próprio runner), a pasta do teste e os transcripts dessas pastas.
#   ssh SERVIDOR 'sh -s /tmp/deck-mem-' < test/e2e/cleanup-remote.sh
prefix=$1
case "$prefix" in
  /tmp/deck-*) ;;
  *) echo "prefixo recusado: $prefix"; exit 2 ;;
esac
R="$HOME/.cache/claude-deck"
runner=$(ls "$R"/runner-*.sh 2>/dev/null | head -1)
n=0
for d in "$R"/s/*; do
  [ -f "$d/cwd" ] || continue
  case "$(cat "$d/cwd")" in
    "$prefix"*)
      if [ -n "$runner" ]; then sh "$runner" stop "${d##*/}" >/dev/null 2>&1; fi
      n=$((n + 1))
      ;;
  esac
done
echo "conversas paradas: $n"
for b in "$prefix"*; do
  [ -d "$b" ] || continue
  for p in "$b" "$b"/*; do
    [ -d "$p" ] || continue
    k=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9]/-/g')
    [ -d "$HOME/.claude/projects/$k" ] && rm -r "$HOME/.claude/projects/$k"
  done
  rm -r "$b" && echo "removida: $b"
done
echo "conversas restantes no runner: $(ls "$R/s" 2>/dev/null | wc -l)"
echo "fake-claude rodando: $(pgrep -fc fake-claude.mjs 2>/dev/null || echo 0)"
