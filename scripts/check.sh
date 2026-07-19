#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Checking Rust formatting..."
cargo fmt \
    --manifest-path server/Cargo.toml \
    --all \
    -- \
    --check

echo "Running Rust Clippy..."
cargo clippy \
    --manifest-path server/Cargo.toml \
    --all-targets \
    --all-features \
    -- \
    -D warnings

echo "Running Rust tests..."
cargo test \
    --manifest-path server/Cargo.toml \
    --all-features

echo "Checking frontend..."
npm --prefix web run lint

if npm --prefix web run | grep -qE '^  typecheck'; then
    npm --prefix web run typecheck
fi

if npm --prefix web run | grep -qE '^  test'; then
    npm --prefix web run test
fi

if npm --prefix web run | grep -qE '^  build'; then
    npm --prefix web run build
fi

echo "All checks passed."
