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
