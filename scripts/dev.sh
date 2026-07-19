#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM

    if [[ -n "${SERVER_PID:-}" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi

    if [[ -n "${WEB_PID:-}" ]]; then
        kill "$WEB_PID" 2>/dev/null || true
    fi

    wait 2>/dev/null || true
    exit "$exit_code"
}

trap cleanup EXIT INT TERM

if [[ ! -f "server/Cargo.toml" ]]; then
    echo "Missing server/Cargo.toml" >&2
    exit 1
fi

if [[ ! -f "web/package.json" ]]; then
    echo "Missing web/package.json" >&2
    exit 1
fi

echo "Starting Rust server on port ${SERVER_PORT:-8080}..."

(
    cd server
    cargo watch -x run
) &

SERVER_PID=$!

echo "Starting Vite client on port 5173..."

npm --prefix web run dev -- --host 0.0.0.0 --port 5173 &

WEB_PID=$!

wait -n "$SERVER_PID" "$WEB_PID"
