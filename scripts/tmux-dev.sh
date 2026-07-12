#!/usr/bin/env bash
# Attaches (or creates) the walkfit dev tmux session: Claude on the left,
# resuming the last conversation in this repo; `npm run dev` on the right.
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

if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach-session -t "$SESSION"
fi

# Address panes by id, not index — the dotfiles set pane-base-index 1, so
# hardcoded .0/.1 targets don't exist.
tmux new-session -d -s "$SESSION" -n dev -c "$REPO_DIR"
left=$(tmux display-message -p -t "$SESSION:dev" '#{pane_id}')
tmux send-keys -t "$left" 'claude --dangerously-skip-permissions --continue' C-m

right=$(tmux split-window -h -P -F '#{pane_id}' -t "$SESSION:dev" -c "$REPO_DIR")
tmux send-keys -t "$right" 'npm run dev' C-m

tmux select-pane -t "$left"

exec tmux attach-session -t "$SESSION"
