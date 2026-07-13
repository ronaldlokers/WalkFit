#!/usr/bin/env bash
# Attaches (or creates) the walkfit dev tmux session: Claude on the left,
# resuming the last conversation in this repo; `npm run dev` on the right,
# with lazygit below it.
set -euo pipefail

# This runs from the global zshrc hook, before the user's mise activation — pull in
# mise shims so the mise-managed tmux resolves. If tmux still isn't there (fresh
# container, post-create not finished), fall back to a plain shell instead of dying:
# the hook exec'd us, so exiting nonzero would kill the terminal.
if ! command -v tmux >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/mise/shims:$PATH"
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux-dev: tmux not available yet (mise install pending?) — plain shell" >&2
  exec "${SHELL:-zsh}"
fi

SESSION="walkfit"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run from the repo so the mise tmux shim resolves the version pinned in
# mise.toml (the hook invokes us from $HOME, where the global config wins).
cd "$REPO_DIR"

# Join an existing session only if a human is attached (a second terminal).
# Any unattached "walkfit" is stale — a leftover from a previous ssh login, or a
# hollow copy tmux-continuum (@continuum-restore on, from the dotfiles) restores
# on server boot: layout and cwds survive the save/restore, the claude / npm /
# lazygit processes don't — and gets rebuilt fresh below.
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  if [ "$(tmux display-message -p -t "$SESSION" '#{session_attached}')" -gt 0 ]; then
    exec tmux attach-session -t "$SESSION"
  fi
fi

# Build under a throwaway unique name, NOT as "walkfit" directly. Two reasons:
# continuum's boot-time restore recreates its saved "walkfit" concurrently with
# us (so creating that name races and loses), and killing "walkfit" while it's
# the only session takes the whole server down — whose next boot runs the
# restore again, forever. A unique name never collides, and keeping our session
# alive keeps the server (and its one-shot restore) settled.
BOOT="$SESSION-boot-$$"

# If setup fails partway, kill the half-built session — otherwise the next login
# attaches to a session of bare shells.
trap 'tmux kill-session -t "$BOOT" 2>/dev/null || true' ERR

# Address panes by id, not index — the dotfiles set pane-base-index 1, so
# hardcoded .0/.1 targets don't exist.
tmux new-session -d -s "$BOOT" -n dev -c "$REPO_DIR"
left=$(tmux display-message -p -t "$BOOT:dev" '#{pane_id}')
tmux send-keys -t "$left" 'claude --dangerously-skip-permissions --continue' C-m

right=$(tmux split-window -h -P -F '#{pane_id}' -t "$BOOT:dev" -c "$REPO_DIR")
tmux send-keys -t "$right" 'npm run dev' C-m

lazygit_pane=$(tmux split-window -v -P -F '#{pane_id}' -t "$right" -c "$REPO_DIR")
tmux send-keys -t "$lazygit_pane" 'lazygit' C-m

tmux select-pane -t "$left"

# Take over the "walkfit" name: kill the stale/restored copy and rename ours in.
# Retry for a few seconds — continuum's restore may still be mid-flight and drop
# its copy back between our kill and rename.
renamed=0
for _ in $(seq 1 10); do
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    if [ "$(tmux display-message -p -t "$SESSION" '#{session_attached}')" -gt 0 ]; then
      # A concurrent login won the name and someone's on it — join theirs.
      tmux kill-session -t "$BOOT"
      exec tmux attach-session -t "$SESSION"
    fi
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
  fi
  if tmux rename-session -t "$BOOT" "$SESSION" 2>/dev/null; then
    renamed=1
    break
  fi
  sleep 0.5
done

if [ "$renamed" -eq 1 ]; then
  exec tmux attach-session -t "$SESSION"
fi
# Couldn't claim the name — attach to our fully-built session under its boot name.
exec tmux attach-session -t "$BOOT"
