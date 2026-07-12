#!/usr/bin/env bash
set -euo pipefail

# Node (and anything else pinned in mise.toml) comes from mise — same source of
# truth as host-side work. Trust the repo config first so install doesn't prompt.
mise trust --quiet
mise install --yes

mise exec -- npm ci

# Playwright's bundled chromium for e2e — matches what CI's playwright image runs.
# --with-deps also installs the shared libraries Chrome for Testing needs.
mise exec -- npx playwright install --with-deps chromium

# Chrome for Testing (https://developer.chrome.com/blog/chrome-for-testing): pinned,
# auto-update-free Chrome for interactive work — Web Bluetooth debugging against the
# host's BlueZ via the mounted D-Bus socket. Exposed as `chrome` on PATH.
mise exec -- npx --yes @puppeteer/browsers install chrome@stable --path "$HOME/.cache/chrome-for-testing"
chrome_bin=$(find "$HOME/.cache/chrome-for-testing" -type f -name chrome -path '*chrome-linux64*' | sort | tail -1)
mkdir -p "$HOME/.local/bin"
ln -sf "$chrome_bin" "$HOME/.local/bin/chrome"
