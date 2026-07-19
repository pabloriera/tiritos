#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Configuring Paint Arena development environment..."

echo "Rust:"
rustc --version
cargo --version

echo "Node.js:"
node --version
npm --version

rustup component add rustfmt clippy

if ! command -v cargo-watch >/dev/null 2>&1; then
    echo "Installing cargo-watch..."
    cargo install cargo-watch --locked
fi

if [[ -f "server/Cargo.toml" ]]; then
    echo "Fetching Rust dependencies..."
    cargo fetch --manifest-path server/Cargo.toml
fi

if [[ -f "web/package-lock.json" ]]; then
    echo "Installing exact frontend dependencies..."
    npm --prefix web ci
elif [[ -f "web/package.json" ]]; then
    echo "No package-lock.json found; creating one..."
    npm --prefix web install
fi

echo "Checking Docker access..."

if docker info >/dev/null 2>&1; then
    echo "Docker daemon is available."
else
    echo
    echo "WARNING: Docker CLI is installed but cannot access the host daemon."
    echo "Check the host Docker service and socket permissions."
    echo
fi

echo "Paint Arena development environment is ready."
