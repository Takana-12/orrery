#!/bin/bash
# macOS counterpart of update-swap.ps1: restarts Orrery after it has quit, optionally swapping in a freshly built app first.
# Started by the running app ("更新して再起動" / "再起動だけする" in settings), which then quits.
#   update-swap.sh --wait-pid <pid> --exe <program to start> --log <file> [--cwd <dir>]
#                  [--release <repo>/release --name <Orrery-darwin-arm64>] [-- <arguments for the program>]
# With --release, the new build waiting in <release>/.staging/<name> replaces <release>/<name> first; if that fails,
# the previous build is put back and started.
# Nothing has to be killed by hand: Orrery processes still running from the same app after the wait are ended here,
# so the port and the single-instance lock are free when the new one starts.
wait_pid=''; exe=''; log=''; cwd=''; release=''; name=''
while [ $# -gt 0 ]; do
  case "$1" in
    --wait-pid) wait_pid="$2"; shift 2 ;;
    --exe) exe="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    --cwd) cwd="$2"; shift 2 ;;
    --release) release="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$wait_pid" ] || [ -z "$exe" ] || [ -z "$log" ]; then echo 'usage: update-swap.sh --wait-pid <pid> --exe <program> --log <file> ...' >&2; exit 2; fi

# Never stand in the folder that is about to be renamed.
cd "${TMPDIR:-/tmp}" || cd /
say() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$log"; }

# The app the program belongs to (…/Orrery.app), or the program's folder when it is not inside an app.
case "$exe" in
  *.app/Contents/MacOS/*) owner="${exe%/Contents/MacOS/*}" ;;
  *) owner="$(dirname "$exe")" ;;
esac
# Processes whose program lives inside that app: the main process and its helpers (renderer, GPU).
leftovers() { /bin/ps -axo pid=,comm= | /usr/bin/awk -v dir="$owner/" -v self="$$" '{ pid = $1; line = $0; sub(/^ *[0-9]+ +/, "", line); if (pid != self && index(line, dir) == 1) print pid }'; }

say "waiting for pid $wait_pid ($exe)"
for _ in $(seq 1 80); do kill -0 "$wait_pid" 2>/dev/null || break; sleep 0.25; done
# Helper processes normally follow within a moment; whatever is still there after that is stuck.
for _ in $(seq 1 20); do [ -z "$(leftovers)" ] && break; sleep 0.5; done
left="$(leftovers | tr '\n' ' ')"
if [ -n "${left// /}" ]; then
  say "ending leftover process(es): $left"
  # shellcheck disable=SC2086
  kill -9 $left 2>/dev/null
  sleep 1
fi

ok=1
if [ -n "$release" ]; then
  live="$release/$name"
  next="$release/.staging/$name"
  old="$release/.previous"
  ok=0
  if [ -z "$name" ] || [ ! -d "$next" ]; then
    say "no new build at $next"
  else
    rm -rf "$old"
    for i in $(seq 0 19); do
      moved=0
      if [ -e "$live" ]; then
        if mv "$live" "$old" 2>> "$log"; then moved=1; else say "retry $i: could not move $live away"; sleep 1; continue; fi
      fi
      if mv "$next" "$live" 2>> "$log"; then ok=1; break; fi
      say "retry $i: could not move $next into place"
      if [ "$moved" = 1 ] && [ ! -e "$live" ]; then mv "$old" "$live" 2>> "$log"; fi
      sleep 1
    done
  fi
  if [ "$ok" = 1 ]; then
    rm -rf "$old" "$release/.staging"
    # The rest of "npm run install-app": the entry in ~/Applications (it points at the same app, so this only
    # matters when it is missing or was removed).
    say "applications: $(/bin/bash "$(dirname "$0")/install-app.sh" 2>&1 | tr '\n' ';')"
  fi
fi

if [ -x "$exe" ]; then
  case "$exe" in
    *.app/Contents/MacOS/*)
      if [ -z "$cwd" ]; then
        # A packaged app: opened the way the Finder opens it.
        if [ $# -gt 0 ]; then /usr/bin/open -n "$owner" --args "$@"; else /usr/bin/open -n "$owner"; fi
      else
        # Development (npm run app = "electron ." from the repository): the folder it is started in matters.
        (cd "$cwd" && nohup "$exe" "$@" > /dev/null 2>&1 &)
      fi ;;
    *) (cd "${cwd:-$owner}" && nohup "$exe" "$@" > /dev/null 2>&1 &) ;;
  esac
  say "started $exe"
else
  say "not found: $exe"
fi

if [ "$ok" = 1 ]; then
  say 'done'
else
  say 'update failed; previous build started'
  /usr/bin/osascript -e 'display dialog "Orrery を更新できませんでした。以前のバージョンで起動しています。\n詳細: '"$log"'" with title "Orrery" buttons {"OK"} default button 1 with icon caution' > /dev/null 2>&1 &
fi
