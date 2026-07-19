FROM mcr.microsoft.com/devcontainers/rust:1-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    lldb \
    pkg-config \
    libssl-dev \
    sqlite3 \
    libsqlite3-dev \
    jq \
    curl \
    ca-certificates \
    git \
    unzip \
    shellcheck \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER vscode
