FROM debian:trixie

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Neovim from the official release tarball — the neovim-homebrew feature pulls in a
# full Homebrew install (1+ GiB clone) and breaks when the remote user's shell is zsh.
ARG NVIM_VERSION=v0.12.4
RUN curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-x86_64.tar.gz" \
  | tar -xz -C /opt \
  && ln -s /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/nvim

# Node system-wide from the official tarball — the devcontainer node feature wraps nvm,
# whose login-shell hook and group setup are more trouble than they're worth here.
ARG NODE_VERSION=22.23.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
