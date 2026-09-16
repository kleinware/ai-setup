#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"

gitdir="$(git rev-parse --git-common-dir)"
hooksdir="$gitdir/hooks"
mkdir -p "$hooksdir"

for src in .githooks/*; do
  name="$(basename "$src")"
  dst="$hooksdir/$name"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "warning: $dst exists as a regular file; replacing with a symlink to $src" >&2
    rm "$dst"
  fi
  rm -f "$dst"
  ln -s "../../.githooks/$name" "$dst"
  chmod +x "$src"
done

echo "installed hooks: $(ls .githooks | tr '\n' ' ')"
