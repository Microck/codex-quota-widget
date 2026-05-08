#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

CLIPROXY_MANAGEMENT_KEY=1234 \
CLIPROXY_BASE_URL="http://[::1]:8317" \
CODEX_QUOTA_WIDGET_TOKEN=3074abdc73ce3f65a7df619ec2611efc00d6 \
CODEX_QUOTA_WIDGET_HOST=100.124.44.113 \
CODEX_QUOTA_WIDGET_PORT=8765 \
node server.mjs
