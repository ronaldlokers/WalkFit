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

tmux new-session -d -s "$SESSION" -n dev -c "$REPO_DIR"
tmux send-keys -t "$SESSION:dev.0" 'claude --dangerously-skip-permissions --continue' C-m

tmux split-window -h -t "$SESSION:dev" -c "$REPO_DIR"
tmux send-keys -t "$SESSION:dev.1" 'npm run dev' C-m

tmux select-pane -t "$SESSION:dev.0"

exec tmux attach-session -t "$SESSION"
