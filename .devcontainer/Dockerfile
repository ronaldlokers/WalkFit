FROM mcr.microsoft.com/devcontainers/base:debian

# Rename the stock vscode user (uid 1000) to dev; keep uid so container-written
# files stay owned by the host user. zsh ships with the base image.
RUN usermod -l dev -d /home/dev -m vscode \
  && groupmod -n dev vscode \
  && chsh -s /usr/bin/zsh dev
