FROM mcr.microsoft.com/devcontainers/base:debian

# Rename the stock vscode user (uid 1000) to dev; keep uid so container-written
# files stay owned by the host user. zsh ships with the base image.
RUN usermod -l dev -d /home/dev -m vscode \
  && groupmod -n dev vscode \
  && chsh -s /usr/bin/zsh dev \
  && echo 'dev ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/dev \
  && rm /etc/sudoers.d/vscode

# Neovim from the official release tarball — the neovim-homebrew feature pulls in a
# full Homebrew install (1+ GiB clone) and breaks when the remote user's shell is zsh.
ARG NVIM_VERSION=v0.12.4
RUN curl -fsSL "https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-x86_64.tar.gz" \
  | tar -xz -C /opt \
  && ln -s /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/nvim

# Node system-wide from the official tarball. The devcontainer node feature uses nvm,
# which devpod configures for the image's original user (vscode) — the renamed dev user
# ends up outside the nvm group and every zsh login fails to relink nvm's "current".
ARG NODE_VERSION=22.23.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
