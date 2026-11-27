#!/bin/bash
# macOS counterpart of install-shortcuts.ps1: registers the packaged app in ~/Applications for the current user,
# so it is found in the Finder's "アプリケーション", Launchpad and Spotlight.
#   bash apps/desktop/install-app.sh [--remove]
# Nothing is copied: the entry is a link to release/Orrery-darwin-<arch>/Orrery.app in this folder, so an update
# (which replaces that folder) is what the link opens next time.
root="$(cd "$(dirname "$0")/../.." && pwd)"
arch="$(uname -m)"
[ "$arch" = 'x86_64' ] && arch='x64'
app="$root/release/Orrery-darwin-$arch/Orrery.app"
link="$HOME/Applications/Orrery.app"

if [ "$1" = '--remove' ]; then
  if [ -L "$link" ]; then rm "$link" && echo "removed: $link"; fi
  exit 0
fi
if [ ! -d "$app" ]; then echo "アプリがまだ作られていません。先に npm run package を実行してください: $app" >&2; exit 1; fi

mkdir -p "$HOME/Applications"
# Only ever replace a link of our own: a real app someone put there is left alone.
if [ -e "$link" ] && [ ! -L "$link" ]; then echo "同じ名前のアプリがすでにあります（そのままにしました）: $link" >&2; exit 1; fi
ln -sfn "$app" "$link" && echo "created: $link -> $app"
