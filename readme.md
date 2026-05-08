# Codex Quota Widget

Small read-only bridge plus a Scriptable iOS widget for merged Codex quota status from CLIProxyAPI.

## Run the Bridge

```bash
cd /home/ubuntu/workspace/codex-quota-widget
CLIPROXY_MANAGEMENT_KEY=1234 \
CODEX_QUOTA_WIDGET_TOKEN=3074abdc73ce3f65a7df619ec2611efc00d6 \
CODEX_QUOTA_WIDGET_HOST=100.124.44.113 \
CODEX_QUOTA_WIDGET_PORT=8765 \
node server.mjs
```

## Start the Bridge at Boot

Install and enable the systemd service:

```bash
cd /home/ubuntu/workspace/codex-quota-widget
./install-startup-service.sh
```

The service is installed as `codex-quota-widget.service`, starts on `multi-user.target`, pulls in `cliproxyapi.service`, waits for network/Tailscale ordering, and restarts every 10 seconds if the bridge exits before the Tailscale bind address is ready.

Default bridge endpoint:

```text
http://100.124.44.113:8765/quota?token=3074abdc73ce3f65a7df619ec2611efc00d6
```

Use the Tailscale IP or DNS name your iPhone can reach.

## Install the Widget

1. Install Scriptable on iOS.
2. Create a new Scriptable script.
3. Paste `scriptable-widget.js`.
4. Replace `QUOTA_URL` with the bridge endpoint.
5. Add a Scriptable widget to the Home Screen and select the script.

## Data Model

The bridge reads `/v0/management/auth-files`, calls `/v0/management/api-call` for every enabled Codex auth, then fetches `https://chatgpt.com/backend-api/wham/usage`.

The response intentionally exposes only sanitized quota fields:

- account counts
- ready/blocked counts
- merged 5-hour and weekly remaining percentages
- refill/reset timestamps
- per-account email, plan, window percentages, and blocked reason

It does not expose access tokens, refresh tokens, auth file paths, or the CLIProxyAPI management key.
