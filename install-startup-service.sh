#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

repo_dir="$(pwd -P)"
env_file="${repo_dir}/.env"
unit_name="${CODEX_QUOTA_WIDGET_SERVICE_NAME:-codex-quota-widget.service}"
node_path="${CODEX_QUOTA_WIDGET_NODE:-$(command -v node)}"
service_user="${CODEX_QUOTA_WIDGET_SERVICE_USER:-$(id -un)}"
service_group="${CODEX_QUOTA_WIDGET_SERVICE_GROUP:-$(id -gn)}"
unit_file="/etc/systemd/system/${unit_name}"

if [[ ! -f "${env_file}" ]]; then
  echo "Missing ${env_file}. Copy .env.example to .env and fill in real values first." >&2
  exit 1
fi

if [[ -z "${node_path}" || ! -x "${node_path}" ]]; then
  echo "Could not find an executable node binary. Set CODEX_QUOTA_WIDGET_NODE=/path/to/node." >&2
  exit 1
fi

for required_key in CLIPROXY_MANAGEMENT_KEY CODEX_QUOTA_WIDGET_TOKEN CODEX_QUOTA_WIDGET_HOST; do
  if ! grep -Eq "^${required_key}=.+" "${env_file}"; then
    echo "Missing ${required_key} in ${env_file}." >&2
    exit 1
  fi
done

if grep -Eq "^(CLIPROXY_MANAGEMENT_KEY=your-management-password|CODEX_QUOTA_WIDGET_TOKEN=replace-with-output-of-openssl-rand-hex-18)$" "${env_file}"; then
  echo "Replace the placeholder CLIPROXY_MANAGEMENT_KEY and CODEX_QUOTA_WIDGET_TOKEN values in ${env_file}." >&2
  exit 1
fi

chmod 600 "${env_file}"

tmp_unit="$(mktemp)"
trap 'rm -f "${tmp_unit}"' EXIT

cat > "${tmp_unit}" <<EOF
[Unit]
Description=Codex Quota Widget Bridge
Wants=network-online.target tailscaled.service
Requires=cliproxyapi.service
After=network-online.target tailscaled.service cliproxyapi.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${service_user}
Group=${service_group}
WorkingDirectory=${repo_dir}
EnvironmentFile=${env_file}
ExecStart=${node_path} ${repo_dir}/server.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 0644 "${tmp_unit}" "${unit_file}"
sudo systemctl daemon-reload
sudo systemctl enable --now "${unit_name}"
sudo systemctl status "${unit_name}" --no-pager
