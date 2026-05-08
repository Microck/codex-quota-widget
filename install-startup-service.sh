#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

sudo install -m 0644 codex-quota-widget.service /etc/systemd/system/codex-quota-widget.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-quota-widget.service
sudo systemctl status codex-quota-widget.service --no-pager
